/** Custody only for new files bound to an admitted native tool and its private completion proof. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const NATIVE_OUTPUT_TOOLS = Object.freeze(['tts', 'image_generate', 'video_generate', 'music_generate']);
const SUBDIRS = Object.freeze({ tts: 'tool-speech-synthesis', image_generate: 'tool-image-generation', video_generate: 'tool-video-generation', music_generate: 'tool-music-generation' });
const KINDS = Object.freeze({ tts: 'audio', image_generate: 'image', video_generate: 'video', music_generate: 'audio' });
const MAX_BYTES = 20 * 1024 * 1024, MAX_FILES = 32, TTL = 300000, DEFERRED_TTL = 30 * 60 * 1000;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bounded = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\0\r\n\u2028\u2029]/u.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const held = () => Object.assign(new Error('Generated media could not be bound to a current reviewed native tool result. No file was released.'), { code: 'NATIVE_OUTPUT_MEDIA_HELD', status: 422 });
const binding = value => plain(value) && bounded(value.sessionKey, 1080) && bounded(value.runId, 256) && bounded(value.callId, 256) && Object.hasOwn(SUBDIRS, value.toolName);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.nlink === b.nlink;

async function directory(file, { tighten = false } = {}) {
  let info = await fs.lstat(file);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(file) !== file ||
      process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) throw held();
  if (process.platform !== 'win32' && info.mode & 0o077) {
    if (!tighten) throw held();
    await fs.chmod(file, 0o700); info = await fs.lstat(file);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || await fs.realpath(file) !== file) throw held();
  }
}
async function readNewFile(file, home, before, issuedAt) {
  if (!bounded(file, 32768) || !path.isAbsolute(file) || path.dirname(file) !== home || path.resolve(file) !== file || before.has(path.basename(file))) throw held();
  await directory(home);
  const initial = await fs.lstat(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size < 1 || initial.size > MAX_BYTES ||
      initial.mtimeMs < issuedAt - 2000 || await fs.realpath(file) !== file) throw held();
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!same(initial, opened) || !opened.isFile()) throw held();
    const bytes = await handle.readFile(), after = await handle.stat(), current = await fs.lstat(file);
    if (!same(initial, after) || !same(initial, current) || current.isSymbolicLink() || bytes.length !== initial.size) throw held();
    return { bytes, info: initial };
  } finally { await handle.close(); }
}
function type(bytes, tool) {
  const head = bytes.subarray(0, 16).toString('latin1');
  if (tool === 'image_generate') {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'];
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'jpg'];
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return ['image/webp', 'webp'];
    if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return ['image/gif', 'gif'];
  } else if (tool === 'video_generate') {
    if (head.slice(4, 8) === 'ftyp') return ['video/mp4', 'mp4'];
    if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return ['video/webm', 'webm'];
  } else {
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return ['audio/wav', 'wav'];
    if (head.startsWith('ID3') || bytes[0] === 255 && (bytes[1] & 224) === 224) return ['audio/mpeg', 'mp3'];
    if (head.startsWith('OggS')) return ['audio/ogg', 'ogg'];
    if (head.startsWith('fLaC')) return ['audio/flac', 'flac'];
    if (head.slice(4, 8) === 'ftyp') return ['audio/mp4', 'm4a'];
  }
  throw held();
}
function outputPaths(result, toolName) {
  if (!plain(result) || result.isError === true || !plain(result.details)) return [];
  const detail = result.details;
  if (detail.ok === false || detail.success === false || detail.error) return [];
  if (toolName === 'tts') {
    if (!detail.audioPath) return [];
    if (!bounded(detail.audioPath, 32768) || detail.media?.mediaUrl && detail.media.mediaUrl !== detail.audioPath) throw held();
    return [{ file: detail.audioPath }];
  }
  const attachments = detail.attachments ?? detail.media?.attachments;
  if (attachments === undefined) return []; // Background task is not a synchronous result.
  if (!Array.isArray(attachments) || !attachments.length || attachments.length > MAX_FILES || attachments.some(item => !plain(item))) throw held();
  return attachments.map(item => {
    if (item.type !== KINDS[toolName] || !bounded(item.path, 32768) || ['url', 'mediaUrl', 'filePath'].some(key => item[key] !== undefined) ||
        item.mimeType !== undefined && !bounded(item.mimeType, 100) || item.sizeBytes !== undefined && (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > MAX_BYTES)) throw held();
    return { file: item.path, mimeType: item.mimeType, sizeBytes: item.sizeBytes };
  });
}

export function createNativeOutputMedia({ nativeStateDirectory, mediaStore, now = Date.now, verifyCompletion } = {}) {
  if (!bounded(nativeStateDirectory, 32768) || !path.isAbsolute(nativeStateDirectory) || path.resolve(nativeStateDirectory) !== nativeStateDirectory ||
      typeof mediaStore?.put !== 'function' || typeof mediaStore?.read !== 'function' || typeof now !== 'function' ||
      verifyCompletion !== undefined && typeof verifyCompletion !== 'function') throw new TypeError('A private native state directory and owned media store are required.');
  const tickets = new WeakMap(), captures = new WeakMap();
  async function live(assertCurrent) { if (typeof assertCurrent !== 'function') throw held(); await assertCurrent(); }
  async function begin(input, { assertCurrent = () => {} } = {}) {
    if (!plain(input) || !Object.hasOwn(SUBDIRS, input.toolName)) return null;
    if (!binding(input) || Object.keys(input).some(key => !['sessionKey', 'runId', 'callId', 'toolName'].includes(key))) throw held();
    await live(assertCurrent); await directory(nativeStateDirectory);
    const media = path.join(nativeStateDirectory, 'media'), home = path.join(media, SUBDIRS[input.toolName]);
    for (const dir of [media, home]) { await fs.mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); await directory(dir, { tighten: true }); }
    const entries = await fs.readdir(home, { withFileTypes: true });
    if (entries.length > 4096 || entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) throw held();
    await live(assertCurrent);
    const ticket = Object.freeze({ id: randomUUID() });
    const issuedAt = now();
    tickets.set(ticket, { ...input, home, before: new Set(entries.map(entry => entry.name)), issuedAt, expiresAt: issuedAt + TTL, consumed: false });
    return ticket;
  }
  async function capture(input, { assertCurrent = () => {} } = {}) {
    const record = plain(input) && tickets.get(input.ticket);
    if (!record || record.consumed || record.deferred || !binding(input) || ['sessionKey', 'runId', 'callId', 'toolName'].some(key => input[key] !== record[key]) ||
        Object.keys(input).some(key => !['ticket', 'sessionKey', 'runId', 'callId', 'toolName', 'result', 'success'].includes(key))) throw held();
    return captureRecord(record, input.result, input.success, { assertCurrent });
  }
  async function captureRecord(record, result, success, { assertCurrent }) {
    record.consumed = true;
    try {
      await live(assertCurrent);
      if (now() < record.issuedAt || now() > record.expiresAt || success !== true) throw held();
      const paths = outputPaths(result, record.toolName);
      if (new Set(paths.map(row => row.file)).size !== paths.length) throw held();
      const prepared = []; let total = 0;
      for (const row of paths) {
        await live(assertCurrent); const source = await readNewFile(row.file, record.home, record.before, record.issuedAt), [mimeType, ext] = type(source.bytes, record.toolName);
        total += source.bytes.length;
        if (total > MAX_BYTES || row.mimeType !== undefined && row.mimeType !== mimeType || row.sizeBytes !== undefined && row.sizeBytes !== source.bytes.length) throw held();
        prepared.push({ ...source, file: row.file, mimeType, ext, hash: sha(source.bytes) });
      }
      const manifest = [], deliveries = [];
      for (const row of prepared) {
        await live(assertCurrent);
        const current = await readNewFile(row.file, record.home, record.before, record.issuedAt);
        if (!same(row.info, current.info) || sha(current.bytes) !== row.hash) throw held();
        const asset = await mediaStore.put({ mimeType: row.mimeType, fileName: 'generated-' + row.hash.slice(0, 16) + '.' + row.ext, content: row.bytes.toString('base64') });
        await live(assertCurrent);
        const owned = await mediaStore.read(asset.id);
        const after = await readNewFile(row.file, record.home, record.before, record.issuedAt);
        if (!same(row.info, after.info) || sha(after.bytes) !== row.hash || sha(owned.bytes) !== row.hash || asset.id !== row.hash || asset.sha256 !== row.hash || asset.bytes !== row.bytes.length || asset.mimeType !== row.mimeType ||
            owned.metadata.id !== row.hash || !bounded(owned.file, 32768) || !path.isAbsolute(owned.file)) throw held();
        manifest.push({ assetId: asset.id, sha256: asset.sha256, bytes: asset.bytes, mimeType: asset.mimeType, fileName: asset.fileName, kind: asset.kind,
          source: 'native-generated', toolName: record.toolName, callId: record.callId });
        deliveries.push({ original: row.file, assetId: asset.id, sha256: asset.sha256, ownedFile: owned.file });
      }
      await live(assertCurrent);
      const captured = Object.freeze({ assets: Object.freeze(manifest.map(Object.freeze)), deliveries: Object.freeze(deliveries.map(Object.freeze)) });
      captures.set(captured, { issuedAt: record.issuedAt, expiresAt: record.expiresAt, assets: manifest, deliveries });
      return captured;
    } catch { throw held(); }
  }
  async function defer(ticket, input, { assertCurrent = () => {} } = {}) {
    const record = tickets.get(ticket);
    if (!record || record.consumed || record.deferred || record.toolName === 'tts' || !plain(input) ||
        Object.keys(input).sort().join(',') !== 'parentSessionKey,runId,taskId,toolName' || input.toolName !== record.toolName || input.parentSessionKey !== record.sessionKey ||
        !bounded(input.taskId, 256) || input.taskId !== input.runId || !input.taskId.startsWith('tool:' + record.toolName + ':') ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(input.taskId.slice(('tool:' + record.toolName + ':').length))) throw held();
    await live(assertCurrent);
    if (now() < record.issuedAt || now() > record.expiresAt) throw held();
    record.deferred = Object.freeze({ ...input }); record.expiresAt = record.issuedAt + DEFERRED_TTL;
    return record.deferred;
  }
  async function captureDeferred(ticket, input, { assertCurrent = () => {} } = {}) {
    const record = tickets.get(ticket);
    if (!record || record.consumed || !record.deferred || !plain(input) || Object.keys(input).sort().join(',') !== 'completionProof,references' || typeof verifyCompletion !== 'function') throw held();
    try {
      await live(assertCurrent);
      if (now() < record.issuedAt || now() > record.expiresAt) throw held();
      const result = { details: { attachments: input.references } }, paths = outputPaths(result, record.toolName);
      if (!paths.length) throw held();
      const references = Object.freeze(paths.map(row => Object.freeze({ type: KINDS[record.toolName], path: row.file,
        ...(row.mimeType === undefined ? {} : { mimeType: row.mimeType }), ...(row.sizeBytes === undefined ? {} : { sizeBytes: row.sizeBytes }) })));
      const expected = Object.freeze({ ...record.deferred, originalRunId: record.runId, callId: record.callId, references });
      if (await verifyCompletion(input.completionProof, expected) !== true) throw held();
      await live(assertCurrent);
      // Use the already bounded copy, not a caller-owned array that can change
      // while the private completion registry performs its asynchronous check.
      return await captureRecord(record, { details: { attachments: references } }, true, { assertCurrent });
    } catch { record.consumed = true; throw held(); }
  }
  async function verifyDeliveries(captured, { assertCurrent = () => {} } = {}) {
    const record = captures.get(captured);
    if (!record) throw held();
    try {
      await live(assertCurrent);
      if (now() < record.issuedAt || now() > record.expiresAt) throw held();
      for (const delivery of record.deliveries) {
        const asset = record.assets.find(row => row.assetId === delivery.assetId), owned = await mediaStore.read(delivery.assetId);
        if (!asset || owned.file !== delivery.ownedFile || owned.metadata.sha256 !== delivery.sha256 || owned.metadata.mimeType !== asset.mimeType ||
            owned.bytes.length !== asset.bytes || sha(owned.bytes) !== delivery.sha256) throw held();
        await live(assertCurrent);
      }
      return captured;
    } catch { throw held(); }
  }
  return { begin, capture, defer, captureDeferred, verifyDeliveries, discard(ticket) { const record = tickets.get(ticket); if (record) record.consumed = true; } };
}
