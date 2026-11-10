import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

// The magic identifies the immutable format and its fixed cryptographic parameters.
// Header: magic | salt (16) | IV (12) | tag (16). AAD is the header before the tag.
// Ciphertext: manifest byte count (u32 BE) | UTF-8 manifest | raw files in manifest order.
const MAGIC = Buffer.from('CHAINCHAT-BACKUP\x01');
const AAD_BYTES = MAGIC.length + 28;
const TAG_BYTES = 16;
const HEADER_BYTES = AAD_BYTES + TAG_BYTES;
const MIB = 1024 * 1024;
const MAX_DATA = 512 * MIB;
const MAX_MANIFEST = 8 * MIB;
export const MAX_TIMECHAIN_BACKUP = HEADER_BYTES + 4 + MAX_MANIFEST + MAX_DATA;
const MAX_FILES = 50_000;
const MAX_LINE = 32 * MIB;
const MAX_PASSPHRASE = 1024;
const STAGE_PREFIX = '.timechain-backup-';
const STAGE_NAME = /^\.timechain-backup-[a-zA-Z0-9]{6}$/u;
const STAGE_RECEIPT = 'chainchat-stage.json';
const derive = promisify(scrypt);
const hash = /^[0-9a-f]{64}$/u;
const lensFile = /^[a-zA-Z0-9_-]{1,96}\.json$/u;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const requiredFiles = ['chain/rings.jsonl', 'registry/modalities.json', 'registry/senses.json'];
const fixedFiles = [
  ...requiredFiles,
  'chain/checkpoints.jsonl', 'chain/web_chat_releases.jsonl', 'chain/PAUSED',
  'chain/LOCKED', 'chain/immune.json', 'chain/replay.json',
  'chain/blockspace/index.json', 'chain/consensus/config.json', 'chain/consensus/attestations.jsonl',
  'registry/grown.json', 'registry/grown_ops.json', 'registry/emergent.json', 'registry/policy.json',
  'registry/scorer.json', 'registry/labeler.json', 'registry/calibrators.json',
  'registry/interaction_portability.json', 'registry/lens/ACTIVE', 'active_ops.py',
];
const variableFiles = new Map([
  ['chain/blockspace/blobs', hash],
  ['registry/lens', lensFile],
]);
const fixedFileSet = new Set(fixedFiles);
const allowedFile = name => fixedFileSet.has(name) || Array.from(variableFiles)
  .some(([directory, pattern]) => name.startsWith(directory + '/') && pattern.test(name.slice(directory.length + 1)));
const changed = () => fault('The Timechain changed during backup. Wait for active work to finish and try again.', 'BACKUP_CHANGED', 409);
const invalid = () => fault('The backup file has an invalid or unsupported format.', 'BACKUP_INVALID', 422);
const failedAuthentication = () => fault('The passphrase is incorrect or the backup file is damaged.', 'BACKUP_AUTH_FAILED', 422);
const oversized = () => fault('This backup exceeds the supported size or file-count limit.', 'BACKUP_TOO_LARGE', 413);
function fault(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function backupPassphrase(value, creating = false) {
  const passphrase = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.alloc(0);
  if (!passphrase.length || passphrase.length > MAX_PASSPHRASE ||
      (creating && Array.from(value).length < 12))
    throw fault('Use a passphrase of at least 12 characters and at most 1024 UTF-8 bytes.', 'BACKUP_PASSPHRASE');
  return passphrase;
}

async function backupKey(passphrase, aad) {
  try {
    return await derive(passphrase, aad.subarray(MAGIC.length, MAGIC.length + 16), 32,
      { N: 65_536, r: 8, p: 2, maxmem: 96 * MIB });
  } finally {
    passphrase.fill(0);
  }
}

function checkFileBudget(files) {
  if (files.length > MAX_FILES || files.reduce((total, file) => total + file.size, 0) > MAX_DATA)
    throw oversized();
}

function checkFiles(files) {
  if (!Array.isArray(files)) throw invalid();
  if (files.length > MAX_FILES) throw oversized();
  const names = new Set();
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !allowedFile(file.name) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || names.has(file.name.toLowerCase())) throw invalid();
    // Native verification loads each individual blockspace blob into memory.
    if (file.size > (file.name === 'chain/rings.jsonl' ? MAX_DATA : file.name === 'registry/lens/ACTIVE' ? 256 : 64 * MIB))
      throw oversized();
    names.add(file.name.toLowerCase());
  }
  if (!requiredFiles.every(file => names.has(file))) throw invalid();
  checkFileBudget(files);
}

function checkManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !hash.test(manifest.genesisHash || '') ||
      !hash.test(manifest.head?.hash || '') || !Number.isSafeInteger(manifest.head?.index) || manifest.head.index < 0)
    throw invalid();
  checkFiles(manifest.files);
  return manifest;
}

function sameStat(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => left[key] === right[key]);
}

async function localStat(root, relative, directory = false) {
  const file = path.join(root, relative);
  try {
    const stat = await fs.lstat(file, { bigint: true });
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
      throw fault('The selected Timechain contains a linked or unsupported backup path.', 'BACKUP_UNSAFE_PATH', 422);
    const real = await fs.realpath(file);
    if (path.relative(file, real))
      throw fault('The selected Timechain contains a linked or unsupported backup path.', 'BACKUP_UNSAFE_PATH', 422);
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function sourceFiles(root) {
  for (const directory of ['chain', 'chain/blockspace', 'chain/consensus', 'registry'])
    await localStat(root, directory, true);
  for (const marker of ['chain/MAINTENANCE_PENDING.json', 'chain/PORTABILITY_PENDING.json']) {
    if (await localStat(root, marker)) throw fault('Resolve the unfinished maintenance or faculty import before backing up.', 'BACKUP_MAINTENANCE', 409);
  }
  const names = [...fixedFiles];
  for (const [directory, pattern] of variableFiles) {
    if (!await localStat(root, directory, true)) continue;
    const listing = await fs.opendir(path.join(root, directory));
    for await (const entry of listing) {
      if (!pattern.test(entry.name)) continue;
      names.push(directory + '/' + entry.name);
      if (names.length > MAX_FILES) throw oversized();
    }
  }
  const files = [];
  for (const name of names.sort()) {
    const stat = await localStat(root, name);
    if (stat) files.push({ name, stat, size: Number(stat.size) });
  }
  checkFileBudget(files);
  return files;
}

async function copySnapshot(root, snapshot, files, signal) {
  for (const { name, stat, size } of files) {
    signal.throwIfAborted();
    const source = await fs.open(path.join(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (!sameStat(stat, await source.stat({ bigint: true }))) throw changed();
      const target = path.join(snapshot, name);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (size === 0) await fs.writeFile(target, '', { mode: 0o600, flag: 'wx' });
      else await pipeline(source.createReadStream({ end: size - 1, autoClose: false }),
        createWriteStream(target, { mode: 0o600, flags: 'wx' }), { signal });
      if (!sameStat(stat, await source.stat({ bigint: true }))) throw changed();
    } finally {
      await source.close();
    }
  }
  const after = await sourceFiles(root);
  if (files.length !== after.length || files.some((file, i) =>
    file.name !== after[i].name || !sameStat(file.stat, after[i].stat))) throw changed();
}

// Authenticated archives can still come from another person. Reject external
// blob paths and unbounded JSONL records before calling the native verifier.
async function checkSnapshot(root, files, signal) {
  const names = new Set(files.map(file => file.name));
  for (const file of requiredFiles) if (!names.has(file)) throw invalid();
  let pieces = [], bytes = 0;
  const scanRing = () => {
    if (!bytes) return;
    const text = utf8.decode(Buffer.concat(pieces, bytes)).trim();
    pieces = [];
    bytes = 0;
    if (!text) return;
    const refs = JSON.parse(text)?.blockspace_refs || [];
    if (!Array.isArray(refs) || refs.some(ref => typeof ref?.hash !== 'string' || !hash.test(ref.hash) ||
      !names.has('chain/blockspace/blobs/' + ref.hash))) throw invalid();
  };
  try {
    for await (const chunk of createReadStream(path.join(root, 'chain/rings.jsonl'), { signal })) {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        bytes += end - offset;
        if (bytes > MAX_LINE) throw oversized();
        pieces.push(chunk.subarray(offset, end));
        if (newline < 0) break;
        scanRing();
        offset = end + 1;
      }
    }
    scanRing();
    if (names.has('registry/lens/ACTIVE')) {
      const active = await fs.readFile(path.join(root, 'registry/lens/ACTIVE'), 'utf8');
      const selected = active.trim() + '.json';
      if (!lensFile.test(selected) || !names.has('registry/lens/' + selected)) throw invalid();
    }
  } catch (error) {
    if (signal.aborted || error.code) throw error;
    throw invalid();
  }
}

function cleanReceipt(inspected) {
  if (inspected?.verified !== true || !hash.test(inspected.genesis?.hash || '') ||
      !hash.test(inspected.head?.hash || '') || !Number.isSafeInteger(inspected.head?.index) || inspected.head.index < 0)
    throw fault('Native verification did not confirm a complete Timechain.', 'BACKUP_CHAIN_INVALID', 422);
  return { genesisHash: inspected.genesis.hash, head: { index: inspected.head.index, hash: inspected.head.hash } };
}

async function writeBackup(output, snapshot, manifest, passphrase, signal) {
  const aad = Buffer.concat([MAGIC, randomBytes(16), randomBytes(12)]);
  const key = await backupKey(passphrase, aad);
  const cipher = createCipheriv('aes-256-gcm', key, aad.subarray(-12), { authTagLength: TAG_BYTES });
  key.fill(0);
  cipher.setAAD(aad);
  const encoded = Buffer.from(JSON.stringify(manifest));
  if (encoded.length > MAX_MANIFEST) throw oversized();
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  async function* plaintext() {
    yield length;
    yield encoded;
    for (const { name } of manifest.files) yield* createReadStream(path.join(snapshot, name), { signal });
  }
  await fs.writeFile(output, Buffer.concat([aad, Buffer.alloc(TAG_BYTES)]), { flag: 'wx', mode: 0o600 });
  await pipeline(Readable.from(plaintext()), cipher,
    createWriteStream(output, { flags: 'r+', start: HEADER_BYTES }), { signal });
  const handle = await fs.open(output, 'r+');
  try {
    await handle.write(cipher.getAuthTag(), 0, TAG_BYTES, AAD_BYTES);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Consume file bodies as streams, keeping at most the manifest or the current
// network chunk in memory. The outer count bounds malformed uploads as well.
class BackupReader {
  constructor(input, limit = MAX_TIMECHAIN_BACKUP) {
    this.iterator = input[Symbol.asyncIterator]();
    this.chunk = Buffer.alloc(0);
    this.total = 0;
    this.limit = limit;
  }
  async advance() {
    while (!this.chunk.length) {
      const { value, done } = await this.iterator.next();
      if (done) return false;
      this.chunk = value;
      this.total += value.length;
      if (this.total > this.limit) throw oversized();
    }
    return true;
  }
  async *take(length) {
    while (length > 0) {
      if (!await this.advance()) throw invalid();
      const size = Math.min(length, this.chunk.length);
      const part = this.chunk.subarray(0, size);
      this.chunk = this.chunk.subarray(size);
      length -= size;
      yield part;
    }
  }
  async read(length) {
    const parts = [];
    for await (const chunk of this.take(length)) parts.push(chunk);
    return Buffer.concat(parts, length);
  }
  async *rest() {
    while (await this.advance()) {
      const chunk = this.chunk;
      this.chunk = Buffer.alloc(0);
      yield chunk;
    }
  }
}

async function extractBackup(input, snapshot, ciphertext, signal) {
  const reader = new BackupReader(input, MAX_TIMECHAIN_BACKUP + MAX_PASSPHRASE + 2);
  const passphraseSize = (await reader.read(2)).readUInt16BE();
  if (!passphraseSize || passphraseSize > MAX_PASSPHRASE) throw invalid();
  const passphrase = await reader.read(passphraseSize);
  let decipher;
  try {
    const header = await reader.read(HEADER_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw invalid();
    const aad = header.subarray(0, AAD_BYTES), key = await backupKey(passphrase, aad);
    try {
      const createDecipher = () => {
        const instance = createDecipheriv('aes-256-gcm', key, aad.subarray(-12), { authTagLength: TAG_BYTES });
        instance.setAAD(aad);
        instance.setAuthTag(header.subarray(AAD_BYTES));
        return instance;
      };
      await pipeline(Readable.from(reader.rest()), createWriteStream(ciphertext, { flags: 'wx', mode: 0o600 }), { signal });
      // Authenticate the complete upload before interpreting a single byte of
      // its manifest or writing any decrypted files to the staging area.
      try {
        await pipeline(createReadStream(ciphertext), createDecipher(), new Writable({
          write(_chunk, _encoding, done) { done(); },
        }), { signal });
      } catch (error) {
        if (signal.aborted || error.code !== 'ERR_OSSL_EVP_BAD_DECRYPT' && error.code) throw error;
        throw failedAuthentication();
      }
      decipher = createDecipher();
    } finally {
      key.fill(0);
    }
  } finally {
    passphrase.fill(0);
  }
  async function* plaintext() {
    for await (const chunk of createReadStream(ciphertext, { signal })) {
      signal.throwIfAborted();
      yield decipher.update(chunk);
    }
    try { yield decipher.final(); } catch { throw failedAuthentication(); }
  }
  const data = new BackupReader(plaintext(), MAX_DATA + MAX_MANIFEST + 4);
  let manifest;
  try {
    const length = (await data.read(4)).readUInt32BE();
    if (!length || length > MAX_MANIFEST) throw invalid();
    manifest = checkManifest(JSON.parse(utf8.decode(await data.read(length))));
  } catch (error) {
    if (signal.aborted || error.code) throw error;
    throw invalid();
  }
  for (const { name, size } of manifest.files) {
    signal.throwIfAborted();
    const file = path.join(snapshot, name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await pipeline(Readable.from(data.take(size)), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
  }
  // Reaching EOF verifies the GCM tag before any staged files reach the engine
  // or the agent index. Trailing bytes are never accepted.
  if (await data.advance()) throw invalid();
  return manifest;
}

function stageSignature(ownerId, name, pid) {
  return createHmac('sha256', ownerId).update(`timechain-backup-v1:${name}:${pid}`).digest('hex');
}

function activeProcess(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function clearStaleStages(root, ownerId) {
  const listing = await fs.opendir(root);
  for await (const entry of listing) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !STAGE_NAME.test(entry.name)) continue;
    const location = path.join(root, entry.name);
    const receiptName = path.join(entry.name, STAGE_RECEIPT);
    try {
      const directory = await localStat(root, entry.name, true);
      const file = await localStat(root, receiptName);
      if (!directory || !file || file.size > 512n ||
          (process.getuid && (directory.uid !== BigInt(process.getuid()) || file.uid !== directory.uid))) continue;
      const { pid, proof } = JSON.parse(await fs.readFile(path.join(root, receiptName), 'utf8'));
      if (!Number.isInteger(pid) || pid < 1 || pid > 2_147_483_647 ||
          proof !== stageSignature(ownerId, entry.name, pid) || activeProcess(pid)) continue;
      // The candidate is a direct, authenticated app workspace. fs.rm does
      // not dereference symbolic links inside the directory it removes.
      if (await localStat(root, entry.name, true))
        await fs.rm(location, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    } catch {
      // Unexpected, inaccessible and externally owned paths are left alone.
    }
  }
}

export async function createTimechainBackups({ dataDir, ownerId, inspect }) {
  const root = await fs.realpath(dataDir);
  await clearStaleStages(root, ownerId);
  let running = false;
  const reserved = new Set();
  async function operation(callback) {
    if (running) throw fault('Wait for the current backup or restore to finish.', 'BACKUP_BUSY', 409);
    running = true;
    let stage;
    try {
      const directory = path.join(root, 'agents');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await localStat(root, 'agents', true);
      stage = await fs.mkdtemp(path.join(root, STAGE_PREFIX));
      await fs.writeFile(path.join(stage, STAGE_RECEIPT), JSON.stringify({
        pid: process.pid, proof: stageSignature(ownerId, path.basename(stage), process.pid),
      }), { mode: 0o600, flag: 'wx' });
      const snapshot = path.join(stage, 'chain-copy');
      await fs.mkdir(snapshot, { mode: 0o700 });
      return await callback({ stage, snapshot, directory });
    } finally {
      try { if (stage) await fs.rm(stage, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
      finally { running = false; }
    }
  }
  return {
    staging: candidate => reserved.has(path.resolve(candidate)) ||
      path.relative(root, candidate).split(path.sep)[0].startsWith(STAGE_PREFIX),
    export: ({ root, passphrase, signal, authorize, send }) => operation(async ({ stage, snapshot }) => {
      const keyInput = backupPassphrase(passphrase, true);
      try {
        const source = await fs.realpath(root);
        const files = await sourceFiles(source);
        const listedFiles = files.map(({ name, size }) => ({ name, size }));
        checkFiles(listedFiles);
        await copySnapshot(source, snapshot, files, signal);
        await checkSnapshot(snapshot, files, signal);
        const receipt = cleanReceipt(await inspect(snapshot));
        await authorize();
        const manifest = { version: 1, ...receipt, files: listedFiles };
        const output = path.join(stage, 'encrypted.ctbackup');
        await writeBackup(output, snapshot, manifest, keyInput, signal);
        await authorize();
        return await send(output, (await fs.stat(output)).size);
      } finally {
        keyInput.fill(0);
      }
    }),
    restore: ({ input, signal, authorize, register, destinationId }) => operation(async ({ stage, snapshot, directory }) => {
      const manifest = await extractBackup(input, snapshot, path.join(stage, 'upload'), signal);
      await checkSnapshot(snapshot, manifest.files, signal);
      const inspected = await inspect(snapshot);
      const receipt = cleanReceipt(inspected);
      if (receipt.genesisHash !== manifest.genesisHash || receipt.head.hash !== manifest.head.hash ||
          receipt.head.index !== manifest.head.index) throw invalid();
      await authorize();
      const container = path.join(directory, destinationId);
      const target = path.join(container, 'timechain');
      reserved.add(target);
      try {
        // Reserve a fresh directory with exclusive creation. The native files
        // enter the agent tree as a single rename inside that new directory.
        await fs.mkdir(container, { mode: 0o700 });
        try {
          await fs.rename(snapshot, target);
          await authorize();
          return await register(target, inspected);
        } catch (error) {
          await fs.rm(container, { recursive: true, force: true });
          throw error;
        }
      } finally {
        reserved.delete(target);
      }
    }),
  };
}
