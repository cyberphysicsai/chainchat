import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CANONICAL_SKILL_SOURCE, createCanonicalSkillManager, currentCanonicalSkill, packagedSkillBundle,
  withCanonicalSkill, checkCanonicalCompatibility, captureCanonicalSkillRunner } from '../lib/canonical-skill.mjs';
import { engine } from '../lib/engine.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const gitHash = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const metadata = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function fixture(t, changes = {}, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-bundle-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = new Map();
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'openclaw/engine-integrity.json'), 'utf8'));
  for (const name of Object.keys(manifest)) files.set(name, await fs.readFile(path.join(root, 'engine/proof-of-interaction', name)));
  for (const [name, text] of Object.entries(changes)) { if (text === null) files.delete(name); else files.set(name, Buffer.from(text)); }
  const commit = options.commit || 'a'.repeat(40), trees = new Map(), directories = new Map();
  for (const [name, bytes] of files) {
    const components = `${CANONICAL_SKILL_SOURCE.directory}/${name}`.split('/');
    let cursor = directories;
    for (const part of components.slice(0, -1)) { if (!cursor.has(part)) cursor.set(part, new Map()); cursor = cursor.get(part); }
    cursor.set(components.at(-1), bytes);
  }
  function tree(directory) {
    const entries = [...directory].map(([name, value]) => value instanceof Map ? { path: name, type: 'tree', mode: '040000', sha: tree(value) }
      : { path: name, type: 'blob', mode: '100644', sha: gitHash('blob', value), size: value.length });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.path + (a.type === 'tree' ? '/' : '')), Buffer.from(b.path + (b.type === 'tree' ? '/' : ''))));
    const bytes = Buffer.concat(entries.map(item => Buffer.concat([Buffer.from(`${item.type === 'tree' ? '40000' : item.mode} ${item.path}\0`), Buffer.from(item.sha, 'hex')])));
    const sha = gitHash('tree', bytes); trees.set(sha, { sha, truncated: false, tree: entries }); return sha;
  }
  const rootTree = tree(directories), calls = [];
  const fetchImpl = async (url, settings) => {
    calls.push({ url, settings });
    assert.equal(settings.redirect, 'error'); assert.ok(settings.signal);
    if (options.fail) throw new Error('synthetic network outage with secret-like text');
    if (url === 'https://api.github.com/repos/cyberphysicsai/proof-of-interaction/commits/main') return metadata({ sha: commit, commit: { tree: { sha: rootTree } } });
    const treeMatch = /^https:\/\/api\.github\.com\/repos\/cyberphysicsai\/proof-of-interaction\/git\/trees\/([a-f0-9]{40})$/u.exec(url);
    if (treeMatch) {
      const data = structuredClone(trees.get(treeMatch[1]));
      if (options.badTree) data.tree[0].sha = '0'.repeat(40);
      return metadata(data);
    }
    const prefix = `https://raw.githubusercontent.com/cyberphysicsai/proof-of-interaction/${commit}/${CANONICAL_SKILL_SOURCE.directory}/`;
    assert.ok(url.startsWith(prefix));
    const name = url.slice(prefix.length), bytes = options.corrupt === name ? Buffer.from('corrupted') : files.get(name);
    if (options.redirect) return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/engine.py' } });
    assert.ok(bytes); return new Response(bytes);
  };
  const manager = createCanonicalSkillManager({ dataDir: directory, fetchImpl,
    compatibility: options.compatibility || checkCanonicalCompatibility, refreshInterval: 60_000 });
  return { manager, directory, calls, fetchImpl, commit, files };
}
test('packaged engine is the immutable official canonical commit, not a divergent copy', async () => {
  const snapshot = await packagedSkillBundle();
  assert.equal(snapshot.commit, '3834ab95f5af7ce48dcc22ede120133393fcbc6f');
  assert.equal(Object.keys(snapshot.files).length, 69);
  assert.ok(snapshot.skill.includes('name: proof-of-interaction'));
  await assert.rejects(withCanonicalSkill({ ...snapshot }, () => {}), { code: 'SKILL_INTEGRITY' });
});
test('publisher update verifies Git trees/blob bytes, smoke tests and atomically selects canonical skill', async t => {
  const f = await fixture(t, { 'SKILL.md': '---\nname: proof-of-interaction\n---\nCanonical updated skill instructions.' });
  await f.manager.initialize();
  const result = await f.manager.refreshIfIdle({ force: true });
  assert.equal(result.updated, true);
  const snapshot = await f.manager.snapshot();
  assert.equal(snapshot.commit, f.commit); assert.equal(snapshot.origin, 'publisher-cache');
  assert.equal(snapshot.skill, f.files.get('SKILL.md').toString());
  assert.equal(f.manager.describe().trust, 'fixed-publisher-git-hash-verified-not-signed');
  const pointer = JSON.parse(await fs.readFile(path.join(f.directory, 'canonical-skills/active.json'), 'utf8'));
  assert.equal(pointer.manifestSha256, snapshot.manifestSha256);
  const before = f.calls.length;
  assert.deepEqual(await f.manager.refreshIfIdle({ force: true }), { updated: false, reason: 'current' });
  assert.equal(f.calls.length - before, 1, 'unchanged immutable commit does not redownload the bundle');
});
test('a turn uses the same immutable skill and real Python engine revision across async work', async t => {
  const native = await fs.readFile(path.join(root, 'engine/proof-of-interaction/timechain.py'), 'utf8');
  const changed = native.replace('"name": name,', '"name": "Updated canonical: " + name,');
  assert.notEqual(changed, native);
  const f = await fixture(t, { 'SKILL.md': 'Pinned canonical skill for this model.', 'timechain.py': changed });
  assert.equal((await f.manager.refreshIfIdle({ force: true })).updated, true);
  const agent = path.join(f.directory, 'agent');
  await f.manager.run(async snapshot => {
    assert.equal((await currentCanonicalSkill()).skill, 'Pinned canonical skill for this model.');
    assert.deepEqual(await f.manager.refreshIfIdle({ force: true }), { updated: false, reason: 'busy' });
    const created = await engine({ op: 'init', root: agent, registryRoot: agent, name: 'Pinned test agent' });
    assert.equal(created.verified, true);
    assert.equal(created.genesis.name, 'Updated canonical: Pinned test agent', 'Python executed the exact snapshot whose SKILL was injected');
    assert.equal((await currentCanonicalSkill()).manifestSha256, snapshot.manifestSha256);
  }, { refresh: false });
  assert.equal((await currentCanonicalSkill()).origin, 'packaged-canonical', 'snapshot does not leak to unrelated operations');
});
for (const [label, options, changes] of [
  ['corrupt Git blob', { corrupt: 'PoI.py' }, {}],
  ['corrupt tree metadata', { badTree: true }, {}],
  ['redirect to another publisher', { redirect: true }, {}],
  ['unexpected active code', {}, { 'active_ops.py': 'raise RuntimeError("must never run")' }],
  ['state injected into source bundle', {}, { 'chain/rings.jsonl': '{}' }],
  ['case-colliding import paths', {}, { 'poi.py': '# ambiguous module on Windows' }],
  ['invalid UTF-8 skill instructions', {}, { 'SKILL.md': Buffer.from([0xff, 0xfe]) }],
  ['incompatible canonical ABI', { compatibility: async () => { throw new Error('incompatible'); } }, {}],
  ['network outage', { fail: true }, {}],
]) test(`${label} retains the verified prior source and never publishes a partial bundle`, async t => {
  const f = await fixture(t, changes, options);
  const prior = await f.manager.initialize();
  assert.deepEqual(await f.manager.refreshIfIdle({ force: true }), { updated: false, reason: 'verification-or-network' });
  assert.equal(await f.manager.snapshot(), prior);
  await assert.rejects(fs.access(path.join(f.directory, 'canonical-skills/active.json')), { code: 'ENOENT' });
});
test('cached source tampering is refused before a new engine process or answer', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.refreshIfIdle({ force: true })).updated, true);
  const snapshot = await f.manager.snapshot();
  await fs.appendFile(path.join(snapshot.root, 'PoI.py'), '\n# tampering');
  await assert.rejects(f.manager.run(() => assert.fail('unverified action ran'), { refresh: false }), { code: 'SKILL_INTEGRITY' });
  const restarted = createCanonicalSkillManager({ dataDir: f.directory, fetchImpl: f.fetchImpl });
  assert.equal((await restarted.initialize()).origin, 'packaged-canonical');
  assert.equal(restarted.describe().updateState, 'invalid-cache');
});
test('a newer incompatible update retains cached current history and previous valid selection', async t => {
  const first = await fixture(t, {}, { commit: 'b'.repeat(40) });
  assert.equal((await first.manager.refreshIfIdle({ force: true })).updated, true);
  const snapshot = await first.manager.snapshot();
  const marker = path.join(first.directory, 'existing-user-state.json'); await fs.writeFile(marker, 'preserve exact user state');
  const second = await fixture(t, {}, { commit: 'c'.repeat(40), compatibility: async () => { throw new Error('ABI changed'); } });
  const update = createCanonicalSkillManager({ dataDir: first.directory, fetchImpl: second.fetchImpl, compatibility: async () => { throw new Error('ABI changed'); } });
  await update.initialize();
  assert.equal((await update.refreshIfIdle({ force: true })).updated, false);
  assert.equal((await update.snapshot()).commit, snapshot.commit);
  assert.equal(await fs.readFile(marker, 'utf8'), 'preserve exact user state');
});
test('an interrupted/bad active cache rolls back to the independently verified previous bundle', async t => {
  const first = await fixture(t, {}, { commit: 'd'.repeat(40) });
  await first.manager.refreshIfIdle({ force: true });
  const second = await fixture(t, { 'SKILL.md': 'A second canonical skill.' }, { commit: 'e'.repeat(40) });
  const update = createCanonicalSkillManager({ dataDir: first.directory, fetchImpl: second.fetchImpl });
  await update.initialize(); assert.equal((await update.refreshIfIdle({ force: true })).updated, true);
  const current = await update.snapshot(); await fs.appendFile(path.join(current.root, 'PoI.py'), '\n# corrupt current');
  const restarted = createCanonicalSkillManager({ dataDir: first.directory, fetchImpl: second.fetchImpl });
  assert.equal((await restarted.initialize()).commit, first.commit);
  assert.equal(restarted.describe().updateState, 'rolled-back');
});
test('separate native callbacks retain one lease; release is idempotent and ends the authority', async t => {
  const f = await fixture(t);
  const lease = await f.manager.acquire({ refresh: false });
  assert.equal((await lease.run(() => currentCanonicalSkill())).commit, lease.snapshot.commit);
  await Promise.resolve();
  assert.equal((await lease.run(() => currentCanonicalSkill())).manifestSha256, lease.snapshot.manifestSha256);
  assert.deepEqual(await f.manager.refreshIfIdle({ force: true }), { updated: false, reason: 'busy' });
  lease.release(); lease.release();
  await assert.rejects(lease.run(() => assert.fail('released callback ran')), { code: 'SKILL_LEASE_EXPIRED' });
  assert.equal((await f.manager.refreshIfIdle({ force: true })).updated, true);
});
test('expired native lease cannot pin updates forever or continue an awaited engine callback', async t => {
  const f = await fixture(t); let clock = 1000;
  const manager = createCanonicalSkillManager({ dataDir: f.directory, fetchImpl: f.fetchImpl, now: () => clock });
  const lease = await manager.acquire({ refresh: false, ttlMs: 1000 });
  await assert.rejects(lease.run(async () => { clock = 2000; return currentCanonicalSkill(); }), { code: 'SKILL_LEASE_EXPIRED' });
  await assert.rejects(lease.run(() => 'must not execute'), { code: 'SKILL_LEASE_EXPIRED' });
  assert.equal((await manager.refreshIfIdle({ force: true })).updated, true);
  lease.release(); lease.release();
});
test('captured callback restores the lease snapshot on a separate hook and retains expiry authority', async t => {
  const f = await fixture(t, { 'SKILL.md': 'Captured callback canonical skill.' });
  await f.manager.refreshIfIdle({ force: true });
  const lease = await f.manager.acquire({ refresh: false });
  const runner = await lease.run(() => captureCanonicalSkillRunner());
  assert.equal((await currentCanonicalSkill()).origin, 'packaged-canonical');
  assert.equal((await runner(() => currentCanonicalSkill())).skill, 'Captured callback canonical skill.');
  lease.release();
  await assert.rejects(runner(() => currentCanonicalSkill()), { code: 'SKILL_LEASE_EXPIRED' });
});
