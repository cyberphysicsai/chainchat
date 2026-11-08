import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const packagedRoot = path.join(appRoot, 'engine/proof-of-interaction');
const integrityPath = path.join(appRoot, 'openclaw/engine-integrity.json');
const source = Object.freeze({ owner: 'cyberphysicsai', repository: 'proof-of-interaction', ref: 'main',
  directory: 'skills/openclaw/proof-of-interaction', packagedCommit: '3834ab95f5af7ce48dcc22ede120133393fcbc6f' });
export const CANONICAL_SKILL_SOURCE = source;
const scope = new AsyncLocalStorage(), snapshots = new WeakSet();
const unscopedBinding = randomBytes(16).toString('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value) && value.length === length;
const fail = () => Object.assign(new Error('The canonical Proof of Interaction skill could not be verified. The last verified bundle remains selected.'), { code: 'SKILL_INTEGRITY', status: 503 });
const maxFile = 2 * 1024 * 1024, maxTotal = 16 * 1024 * 1024, maxFiles = 256;
function allowed(relative) {
  if (typeof relative !== 'string' || relative.length > 180 || /[\\\x00-\x1f\x7f]/u.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (relative.split('/').some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) return false;
  if (/^[A-Za-z][A-Za-z0-9_]{0,63}\.py$/u.test(relative)) return relative !== 'active_ops.py';
  if (/^(?:AGENTS|CHANGELOG|CPHY|LAYERS|README|SKILL)\.md$|^(?:LICENSE|VERSION|\.clawhubignore)$|^(?:loop|session_start|stop|subagent_stop)_hook\.sh$/u.test(relative)) return true;
  return /^(?:registry\/(?:modalities|senses)\.json|contracts\/ProofOfInteractionEscrow\.sol|agents\/proof-of-interaction-agent\.md|openclaw\/(?:enforcement-watchdog\.sh|proof-of-interaction-agent\.md)|openclaw-plugin\/(?:README\.md|index\.(?:js|ts)|openclaw\.plugin\.json|package\.json))$/u.test(relative) ||
    ['agents/openai.yaml', 'codex_hooks.example.json', 'codex_notify_hook.sh', 'install_codex_hooks.py'].includes(relative);
}
function validManifest(files) {
  if (!plain(files) || Object.keys(files).length < 20 || Object.keys(files).length > maxFiles ||
      !['SKILL.md', 'VERSION', 'PoI.py', 'timechain.py', 'registry/modalities.json', 'registry/senses.json'].every(name => name in files) ||
      Object.entries(files).some(([name, hash]) => !allowed(name) || !hex(hash, 64))) throw fail();
  if (new Set(Object.keys(files).map(name => name.toLowerCase())).size !== Object.keys(files).length) throw fail();
  return files;
}
const manifestDigest = files => sha256(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))));
async function noLinks(filename, root) {
  const relative = path.relative(root, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail();
  const absolute = path.resolve(root), parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const component of path.relative(parsed.root, absolute).split(path.sep).filter(Boolean).concat(relative.split(path.sep).filter(Boolean))) {
    cursor = path.join(cursor, component);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw fail();
  }
}
async function verifyFiles(root, files) {
  validManifest(files);
  let total = 0;
  for (const [name, hash] of Object.entries(files)) {
    const filename = path.join(root, ...name.split('/'));
    await noLinks(filename, root);
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > maxFile || (total += stat.size) > maxTotal) throw fail();
    if (sha256(await fs.readFile(filename)) !== hash) throw fail();
  }
  // An injected import alongside reviewed files must not become executable.
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw fail();
      if (entry.isDirectory()) {
        // Historical local tests may have left bytecode beside the seed;
        // canonical_bundle.py never loads it. Updates themselves stay clean.
        if (entry.name === '__pycache__' && root === packagedRoot) continue;
        await walk(path.join(directory, entry.name), name + '/');
      }
      else if (!entry.isFile() || !(name in files)) throw fail();
    }
  }
  await walk(root);
}
async function makeSnapshot({ root, files, commit, origin }) {
  await verifyFiles(root, files);
  const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const skill = decode(await fs.readFile(path.join(root, 'SKILL.md')));
  const version = decode(await fs.readFile(path.join(root, 'VERSION'))).trim();
  if (!skill.trim() || Buffer.byteLength(skill) > 256 * 1024 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version) || version.length > 80 || !hex(commit, 40)) throw fail();
  const snapshot = Object.freeze({ root, files: Object.freeze({ ...files }), commit, origin, version, skill, manifestSha256: manifestDigest(files) });
  snapshots.add(snapshot); return snapshot;
}
let packaged;
export async function packagedSkillBundle() {
  if (!packaged) packaged = makeSnapshot({ root: packagedRoot, files: JSON.parse(await fs.readFile(integrityPath, 'utf8')), commit: source.packagedCommit, origin: 'packaged-canonical' });
  const value = await packaged; await verifyFiles(value.root, value.files); return value;
}
export async function currentCanonicalSkill() {
  const current = scope.getStore(); current?.assertLive?.();
  const value = current?.snapshot || await packagedSkillBundle();
  await verifyCanonicalSkill(value); current?.assertLive?.(); return value;
}
export async function verifyCanonicalSkill(value) {
  try { if (!snapshots.has(value)) throw fail(); await verifyFiles(value.root, value.files); return value; }
  catch { throw fail(); }
}
export async function withCanonicalSkill(snapshot, action, assertLive, binding = randomBytes(16).toString('hex')) { assertLive?.(); await verifyCanonicalSkill(snapshot); assertLive?.(); return scope.run({ snapshot, assertLive, binding }, action); }
export async function captureCanonicalSkillRunner() {
  const current = scope.getStore(), snapshot = await currentCanonicalSkill();
  return action => withCanonicalSkill(snapshot, action, current?.assertLive, current?.binding || unscopedBinding);
}
export function canonicalSkillEnvironment(snapshot) {
  if (!snapshots.has(snapshot)) throw fail();
  return { CT_CHAT_CANONICAL_BUNDLE: JSON.stringify({ root: snapshot.root, files: snapshot.files, commit: snapshot.commit, manifestSha256: snapshot.manifestSha256 }),
    CT_CHAT_PREPARATION_SCOPE: scope.getStore()?.binding || unscopedBinding };
}
async function bodyBytes(response, limit) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > limit)) throw fail();
  let bytes = 0; const parts = [];
  if (!response.body) throw fail();
  for await (const part of response.body) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > limit) { await response.body.cancel?.().catch?.(() => {}); throw fail(); } parts.push(chunk); }
  return Buffer.concat(parts);
}
function treeHash(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path + (a.type === 'tree' ? '/' : '')), Buffer.from(b.path + (b.type === 'tree' ? '/' : ''))));
  return gitHash('tree', Buffer.concat(sorted.map(item => Buffer.concat([Buffer.from(`${item.mode === '040000' ? '40000' : item.mode} ${item.path}\0`), Buffer.from(item.sha, 'hex')]))));
}
async function downloadPublisher(fetchImpl, signal, onResolved) {
  const api = 'https://api.github.com/repos/cyberphysicsai/proof-of-interaction';
  async function json(url, limit = 2 * 1024 * 1024) {
    const response = await fetchImpl(url, { redirect: 'error', headers: { accept: 'application/vnd.github+json', 'user-agent': 'CypherTempre-ChainChat' }, signal });
    if (!response.ok || response.url && response.url !== url) throw fail();
    try { return JSON.parse((await bodyBytes(response, limit)).toString('utf8')); } catch { throw fail(); }
  }
  const resolved = await json(`${api}/commits/main`);
  const commit = resolved.sha, rootTree = resolved.commit?.tree?.sha;
  if (!hex(commit, 40) || !hex(rootTree, 40)) throw fail();
  if (onResolved?.(commit) === false) return { commit, current: true };
  async function tree(hash) {
    const data = await json(`${api}/git/trees/${hash}`);
    if (data.sha !== hash || data.truncated !== false || !Array.isArray(data.tree) || data.tree.length > 1000 ||
        data.tree.some(item => !plain(item) || !['blob', 'tree'].includes(item.type) || !hex(item.sha, 40) ||
          typeof item.path !== 'string' || /[\/\\\x00-\x1f]/u.test(item.path) || !item.path || ['.', '..'].includes(item.path) ||
          !(item.type === 'tree' ? item.mode === '040000' : ['100644', '100755'].includes(item.mode))) ||
        new Set(data.tree.map(item => item.path)).size !== data.tree.length || treeHash(data.tree) !== hash) throw fail();
    return data.tree;
  }
  let directory = rootTree;
  for (const component of source.directory.split('/')) {
    const next = (await tree(directory)).find(item => item.path === component && item.type === 'tree');
    if (!next) throw fail(); directory = next.sha;
  }
  const blobs = [];
  async function collect(hash, prefix = '', depth = 0) {
    if (depth > 5) throw fail();
    for (const item of await tree(hash)) {
      const relative = prefix + item.path;
      if (item.type === 'tree') await collect(item.sha, relative + '/', depth + 1);
      else { if (!allowed(relative) || blobs.length >= maxFiles) throw fail(); blobs.push({ name: relative, sha: item.sha }); }
    }
  }
  await collect(directory);
  let total = 0; const files = {}, content = new Map();
  for (const item of blobs) {
    const url = `https://raw.githubusercontent.com/cyberphysicsai/proof-of-interaction/${commit}/${source.directory}/${item.name}`;
    const response = await fetchImpl(url, { redirect: 'error', signal, headers: { 'user-agent': 'CypherTempre-ChainChat' } });
    if (!response.ok || response.url && response.url !== url) throw fail();
    const bytes = await bodyBytes(response, maxFile);
    if ((total += bytes.length) > maxTotal || gitHash('blob', bytes) !== item.sha) throw fail();
    files[item.name] = sha256(bytes); content.set(item.name, bytes);
  }
  validManifest(files); return { commit, files, content };
}
async function bridgeCall(snapshot, request, timeout = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CT_CHAT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [path.join(appRoot, 'engine_bridge.py')], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ...canonicalSkillEnvironment(snapshot), PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', CT_TELEMETRY: 'off', CT_AUTOINDEX: '0', CT_AUTO_SPROUT: '0', CT_AUTOMAINT: '0' } });
    let output = '', done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(fail()); }, timeout);
    child.on('error', () => finish(fail())); child.stdin.on('error', () => {}); child.stderr.resume();
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 1024 * 1024) { child.kill(); finish(fail()); } });
    child.on('close', () => { try { const result = JSON.parse(output); if (!result.ok) throw fail(); finish(null, result); } catch { finish(fail()); } });
    child.stdin.end(JSON.stringify(request));
  });
}
export async function checkCanonicalCompatibility(snapshot) {
  await verifyCanonicalSkill(snapshot);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'chainchat-skill-compat-'));
  // Both roots are deliberately explicit. No canonical/default/user chain is touched.
  const agent = path.join(temporary, 'agent');
  const deadline = Date.now() + 120_000;
  const remaining = () => { const value = deadline - Date.now(); if (value <= 0) throw fail(); return Math.min(value, 45_000); };
  const call = request => bridgeCall(snapshot, { root: agent, registryRoot: agent, ...request }, remaining());
  const scores = Object.fromEntries(['coherence', 'relevance', 'novelty', 'consistency', 'depth', 'covenant'].map(key => [key, 230]));
  const assessment = { approved: true, fruitages: Object.fromEntries(['love', 'peace', 'joy', 'kindness', 'mildness', 'self-control', 'goodness', 'patience', 'faith'].map(key => [key, 235])), rationale: 'Disposable compatibility check: this response is honest, patient and kind.' };
  const exchange = { input: 'Please help me reason patiently.', output: 'We can consider the question patiently and clearly, and acknowledge uncertainty where information is missing.', scores, assessment, usedRings: [], loadout: [] };
  try {
    // Build with the known chain schema, then read/append with the update and
    // read again with the packaged engine. A self-consistent new format alone
    // is insufficient evidence of existing-chain interoperability.
    const initial = await bridgeCall(await packagedSkillBundle(), { op: 'init', root: agent, registryRoot: agent, name: 'Disposable compatibility agent' }, remaining());
    const prepared = await call({ op: 'prepare', input: exchange.input, loadout: [], learning: false });
    if (!initial.verified || prepared.head?.hash !== initial.head?.hash || !prepared.trustedAgentContext || !prepared.facultyExecution) throw fail();
    const evaluated = await call({ op: 'evaluate', ...exchange, expectedHead: initial.head.hash, learning: false });
    if (evaluated.accepted !== true || evaluated.sealed !== false || evaluated.verdict?.decision !== 'SEAL') throw fail();
    for (const rejected of [
      { ...exchange, scores: { ...scores, covenant: 0 } },
      { ...exchange, scores: { ...scores, consistency: 0 } },
      { ...exchange, usedRings: [99999] },
      { ...exchange, assessment: { ...assessment, fruitages: { ...assessment.fruitages, faith: 0 } } },
    ]) {
      let refused = false;
      try { await call({ op: 'evaluate', ...rejected, expectedHead: initial.head.hash, learning: false }); } catch { refused = true; }
      if (!refused) throw fail();
    }
    const committed = await call({ op: 'commit', ...exchange, expectedHead: initial.head.hash, growth: false, learning: false });
    const verified = await call({ op: 'verify', learning: false });
    if (!committed.sealed || verified.verified !== true || verified.head?.index !== 1) throw fail();
    const backwards = await bridgeCall(await packagedSkillBundle(), { op: 'verify', root: agent, registryRoot: agent, learning: false }, remaining());
    if (backwards.verified !== true || backwards.head?.hash !== verified.head.hash) throw fail();
    return Object.freeze({ adapter: 1, read: true, review: true, append: true, sourceHistoryUntouched: true });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
export function createCanonicalSkillManager({ dataDir, fetchImpl = globalThis.fetch, now = Date.now, refreshInterval = 60 * 60 * 1000, compatibility = checkCanonicalCompatibility } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof fetchImpl !== 'function' || typeof compatibility !== 'function' ||
      typeof now !== 'function' || !Number.isInteger(refreshInterval) || refreshInterval < 60_000 || refreshInterval > 24 * 60 * 60_000) throw fail();
  const cache = path.join(dataDir, 'canonical-skills'), pointer = path.join(cache, 'active.json'), previousPointer = path.join(cache, 'previous.json');
  let selected, updating, lastAttempt = -Infinity;
  const leases = new Map();
  const expireLeases = () => { for (const [identity, value] of leases) if (value.expiresAt <= now()) { value.expired = true; leases.delete(identity); } };
  let updateState = 'not-checked', discoveredCommit = null;
  const describe = () => ({ repository: 'https://github.com/cyberphysicsai/proof-of-interaction', channel: 'main', trust: 'fixed-publisher-git-hash-verified-not-signed',
    commit: selected?.commit ?? source.packagedCommit, version: selected?.version ?? null, origin: selected?.origin ?? 'packaged-canonical', updateState, discoveredCommit,
    immutableTurnSnapshot: true, preservedUserState: true });
  async function audit(event, snapshot) {
    const filename = path.join(cache, 'updates.jsonl');
    try { await noLinks(filename, cache); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const record = { at: new Date(now()).toISOString(), event, commit: snapshot.commit, version: snapshot.version, manifestSha256: snapshot.manifestSha256,
      repository: 'cyberphysicsai/proof-of-interaction', channel: 'main', publisherTrusted: true, signed: false };
    await fs.appendFile(filename, JSON.stringify(record) + '\n', { mode: 0o600 });
  }
  async function readCache(saved) {
    if (!plain(saved) || Object.keys(saved).sort().join(',') !== 'commit,directory,manifestSha256' || !hex(saved.commit, 40) || !hex(saved.manifestSha256, 64) || saved.directory !== `${saved.commit}-${saved.manifestSha256.slice(0, 16)}`) throw fail();
    const directory = path.join(cache, saved.directory);
    await noLinks(path.join(directory, 'receipt.json'), cache);
    const receiptBytes = await fs.readFile(path.join(directory, 'receipt.json'));
    if (receiptBytes.length > 64 * 1024) throw fail();
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    if (!plain(receipt) || Object.keys(receipt).sort().join(',') !== 'commit,files,origin' || receipt.commit !== saved.commit || receipt.origin !== 'fixed-publisher' || manifestDigest(validManifest(receipt.files)) !== saved.manifestSha256) throw fail();
    return makeSnapshot({ root: path.join(directory, 'files'), files: receipt.files, commit: receipt.commit, origin: 'publisher-cache' });
  }
  async function initialize({ refresh = false } = {}) {
    if (!selected) {
      selected = await packagedSkillBundle();
      try {
        await noLinks(pointer, cache); const bytes = await fs.readFile(pointer);
        if (bytes.length > 2048) throw fail(); selected = await readCache(JSON.parse(bytes.toString('utf8'))); updateState = 'cached';
      } catch (error) {
        if (error.code !== 'ENOENT') {
          updateState = 'invalid-cache';
          try {
            await noLinks(previousPointer, cache); const bytes = await fs.readFile(previousPointer);
            if (bytes.length > 2048) throw fail(); selected = await readCache(JSON.parse(bytes.toString('utf8'))); updateState = 'rolled-back';
          } catch { /* The independently verified packaged source is the final fallback. */ }
        }
      }
    }
    if (refresh) await refreshIfIdle(); return selected;
  }
  async function activate(snapshot) {
    const saved = { commit: snapshot.commit, directory: `${snapshot.commit}-${snapshot.manifestSha256.slice(0, 16)}`, manifestSha256: snapshot.manifestSha256 };
    if (selected?.origin === 'publisher-cache') {
      const prior = { commit: selected.commit, directory: `${selected.commit}-${selected.manifestSha256.slice(0, 16)}`, manifestSha256: selected.manifestSha256 };
      const previous = path.join(cache, `.previous-${randomBytes(12).toString('hex')}.json`);
      await fs.writeFile(previous, JSON.stringify(prior) + '\n', { flag: 'wx', mode: 0o600 });
      try { await fs.rename(previous, previousPointer); } finally { await fs.rm(previous, { force: true }); }
    }
    const pending = path.join(cache, `.active-${randomBytes(12).toString('hex')}.json`);
    await fs.writeFile(pending, JSON.stringify(saved) + '\n', { flag: 'wx', mode: 0o600 });
    try { await fs.rename(pending, pointer); } finally { await fs.rm(pending, { force: true }); }
    selected = snapshot;
    // The immutable receipt and pointer are authoritative. This audit is a
    // separate non-secret chronology, never authority to load executable code.
    await audit('activated', snapshot).catch(() => {});
  }
  async function refreshIfIdle({ force = false } = {}) {
    await initialize();
    expireLeases(); if (leases.size) return { updated: false, reason: 'busy' };
    if (updating) return updating;
    if (!force && now() - lastAttempt < refreshInterval) return { updated: false, reason: 'interval' };
    lastAttempt = now();
    updating = (async () => {
      let stage;
      try {
        const downloaded = await downloadPublisher(fetchImpl, AbortSignal.timeout(90_000), commit => { discoveredCommit = commit; return !(commit === selected.commit && selected.origin === 'publisher-cache'); });
        if (downloaded.current) { await verifyCanonicalSkill(selected); updateState = 'current'; return { updated: false, reason: 'current' }; }
        await fs.mkdir(cache, { recursive: true, mode: 0o700 }); await noLinks(cache, cache);
        stage = await fs.mkdtemp(path.join(cache, '.stage-'));
        const filesRoot = path.join(stage, 'files'); await fs.mkdir(filesRoot, { mode: 0o700 });
        for (const [name, bytes] of downloaded.content) { const filename = path.join(filesRoot, ...name.split('/')); await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
        await fs.writeFile(path.join(stage, 'receipt.json'), JSON.stringify({ commit: downloaded.commit, origin: 'fixed-publisher', files: downloaded.files }) + '\n', { flag: 'wx', mode: 0o600 });
        let candidate = await makeSnapshot({ root: filesRoot, files: downloaded.files, commit: downloaded.commit, origin: 'publisher-cache' });
        await compatibility(candidate); await verifyCanonicalSkill(candidate);
        const directory = `${candidate.commit}-${candidate.manifestSha256.slice(0, 16)}`, final = path.join(cache, directory);
        try { await fs.rename(stage, final); stage = null; }
        catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error; await readCache({ commit: candidate.commit, directory, manifestSha256: candidate.manifestSha256 }); }
        candidate = await readCache({ commit: candidate.commit, directory, manifestSha256: candidate.manifestSha256 });
        expireLeases(); if (leases.size) { updateState = 'deferred'; lastAttempt = -Infinity; return { updated: false, reason: 'busy' }; }
        await activate(candidate); updateState = 'updated'; return { updated: true, commit: candidate.commit };
      } catch { updateState = 'retained-verified'; return { updated: false, reason: 'verification-or-network' }; }
      finally { if (stage) await fs.rm(stage, { recursive: true, force: true }); updating = null; }
    })();
    return updating;
  }
  async function acquire({ refresh = true, ttlMs = 15 * 60_000 } = {}) {
    if (typeof refresh !== 'boolean' || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60 * 60_000) throw fail();
    await initialize(); if (refresh) await refreshIfIdle();
    const pinned = selected; await verifyCanonicalSkill(pinned);
    const identity = randomBytes(16).toString('hex'), lease = { expiresAt: now() + ttlMs, released: false, expired: false };
    leases.set(identity, lease);
    const release = () => { lease.released = true; leases.delete(identity); };
    const assertLive = () => {
      if (lease.released || lease.expired || lease.expiresAt <= now()) {
        lease.expired ||= lease.expiresAt <= now(); leases.delete(identity);
        throw Object.assign(new Error('The canonical skill invocation ended or expired. Start a fresh reviewed invocation.'), { code: 'SKILL_LEASE_EXPIRED', status: 409 });
      }
    };
    return Object.freeze({ snapshot: pinned, release, run: async action => {
      assertLive(); const result = await withCanonicalSkill(pinned, () => action(pinned), assertLive, identity); assertLive(); return result;
    } });
  }
  async function run(action, settings) { const lease = await acquire(settings); try { return await lease.run(action); } finally { lease.release(); } }
  return Object.freeze({ initialize, refreshIfIdle, snapshot: async () => { await initialize(); return verifyCanonicalSkill(selected); }, acquire, run, describe });
}
