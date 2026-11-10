import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { StateStore } from '../lib/state.mjs';
import { createTimechainBackups } from '../lib/timechain-backup.mjs';

const passphrase = 'A separate backup passphrase 🌱';
const hosted = 'https://cyphertempre.ai';
const python = process.env.CT_CHAT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const exec = promisify(execFile);
const never = () => { throw new Error('Backup and restore must never call a model'); };

function upload(file, secret = passphrase) {
  const bytes = Buffer.from(secret, 'utf8');
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(bytes.length);
  return Buffer.concat([prefix, bytes, file]);
}

test('local backup authenticates a native Timechain, then restores a separate verified copy', { timeout: 120_000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-backup-test-'));
  const data = path.join(temp, 'data');
  const app = await createApp({ dataDir: data, pairingCode: 'TIMECHAINBACKUP', publicOrigins: [hosted], generate: never, review: never });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function request(route, body, { token, page = origin } = {}) {
    const binary = Buffer.isBuffer(body);
    return fetch(origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: page, ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
    });
  }
  async function json(route, body, expected, options = {}) {
    const response = await request(route, body, options);
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  const { token } = await json('/api/launch', { nonce: app.issueLaunchNonce() }, 200);
  const owner = { token };
  const initial = await json('/api/agents', { name: 'Backup fixture' }, 201, owner);
  const chain = initial.agent.root;
  const attachment = path.join(temp, 'source.txt');
  const secretAttachment = 'This fixture attachment belongs inside encrypted blockspace only.';
  await fs.writeFile(attachment, secretAttachment);
  const seed = [
    'import sys', 'sys.path.insert(0, sys.argv[1])', 'from timechain import Timechain',
    'from consensus import Quorum', 't = Timechain(sys.argv[2])', 'q = Quorum(sys.argv[2])',
    'q.init()', 't.seal("note", {"summary": "Native backup fixture ring."}, files=[sys.argv[3]])',
    'q.attest()',
  ].join('\n');
  await exec(python, ['-c', seed, path.resolve('engine/proof-of-interaction'), chain, attachment], {
    windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CT_AUTOINDEX: '0' },
  });
  const rings = path.join('chain', 'rings.jsonl');
  const original = await fs.readFile(path.join(chain, rings));
  const state = await json('/api/state', undefined, 200, owner);
  assert.equal(state.agent.head.index, 1);
  const backupRequest = { agentId: initial.agent.id, passphrase };
  assert.equal((await json('/api/timechain/backup', backupRequest, 401)).code, 'PAIR_REQUIRED');
  const foreign = await json('/api/pair', { code: 'TIMECHAINBACKUP' }, 200, { page: hosted });
  assert.equal((await json('/api/timechain/backup', backupRequest, 403, { ...foreign, page: hosted })).code, 'BACKUP_LOCAL_REQUIRED');
  assert.equal((await json('/api/timechain/restore', Buffer.from('held'), 403, { ...foreign, page: hosted })).code, 'BACKUP_LOCAL_REQUIRED');
  assert.equal((await json('/api/timechain/backup', { ...backupRequest, agentId: 'other' }, 409, owner)).code, 'BACKUP_AGENT_CHANGED');

  const excluded = 'Native credentials are separate from Timechain data.';
  await fs.writeFile(path.join(chain, 'credentials.json'), excluded);
  const linked = path.join(chain, 'registry', 'calibrators.json');
  await fs.link(path.join(chain, 'credentials.json'), linked);
  assert.equal((await json('/api/timechain/backup', backupRequest, 422, owner)).code, 'BACKUP_UNSAFE_PATH');
  await fs.unlink(linked);

  const pending = app.store.agents[0];
  await app.store.savePending(pending, { exchanges: [{ input: 'Unsealed conversation' }] });
  assert.equal((await json('/api/timechain/backup', backupRequest, 409, owner)).code, 'BACKUP_PENDING_BLOCK');
  await app.store.savePending(pending, { exchanges: [], bytes: 0, expectedHead: null });

  const exported = await request('/api/timechain/backup', backupRequest, owner);
  assert.equal(exported.status, 200, exported.ok ? '' : await exported.text());
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.match(exported.headers.get('content-disposition'), /attachment.*\.ctbackup/);
  const archive = Buffer.from(await exported.arrayBuffer());
  assert.equal(archive.includes(Buffer.from(secretAttachment)), false);
  assert.equal(archive.includes(Buffer.from(passphrase)), false);
  assert.equal(archive.includes(Buffer.from(state.agent.head.hash)), false);

  const wrong = await json('/api/timechain/restore', upload(archive, 'Wrong fixture passphrase'), 422, owner);
  assert.equal(wrong.code, 'BACKUP_AUTH_FAILED');
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 1] ^= 1;
  assert.equal((await json('/api/timechain/restore', upload(tampered), 422, owner)).code, 'BACKUP_AUTH_FAILED');
  assert.equal(app.store.agents.length, 1);
  assert.equal((await fs.readdir(data)).some(name => name.startsWith('.timechain-backup-')), false);

  const { restored } = await json('/api/timechain/restore', upload(archive), 201, owner);
  assert.notEqual(restored.id, initial.agent.id);
  assert.deepEqual(restored.head, state.agent.head);
  const updated = await json('/api/state', undefined, 200, owner);
  assert.equal(updated.agent.id, initial.agent.id);
  assert.equal(updated.agents.length, 2);
  const onDisk = await new StateStore(data).load();
  const copy = onDisk.agents.find(agent => agent.id === restored.id);
  assert.notEqual(copy.root, chain);
  for (const file of [rings, 'registry/modalities.json', 'registry/senses.json', 'chain/consensus/config.json', 'chain/consensus/attestations.jsonl']) {
    assert.deepEqual(await fs.readFile(path.join(copy.root, file)), await fs.readFile(path.join(chain, file)));
  }
  await assert.rejects(fs.stat(path.join(copy.root, 'credentials.json')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(chain, rings)), original);
  const selected = await json('/api/agents/select', { id: restored.id }, 200, owner);
  assert.equal(selected.agent.consensus, true);
  assert.equal(selected.agent.verified, true);
});

test('restart clears its abandoned staging directory without following links or touching unrelated data', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-backup-restart-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const data = path.join(temp, 'data');
  const fixture = path.join(temp, 'fixture');
  const ownerId = 'a'.repeat(48);
  await fs.mkdir(data);
  await fs.mkdir(path.join(fixture, 'chain'), { recursive: true });
  await fs.mkdir(path.join(fixture, 'registry'));
  await fs.writeFile(path.join(fixture, 'chain', 'rings.jsonl'), '{"blockspace_refs":[]}\n');
  for (const registry of ['modalities.json', 'senses.json'])
    await fs.writeFile(path.join(fixture, 'registry', registry), '[]');
  const other = path.join(data, '.timechain-backup-Other1');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'chainchat-stage.json'), '{"pid":1,"proof":"invalid"}');
  const unrelated = path.join(temp, 'other');
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(unrelated, 'must-survive.txt'), 'Outside backup staging');

  const child = [
    `import { createTimechainBackups } from ${JSON.stringify(new URL('../lib/timechain-backup.mjs', import.meta.url).href)};`,
    'const [dataDir, ownerId, root] = process.argv.slice(1);',
    'const backups = await createTimechainBackups({ dataDir, ownerId, inspect: () => process.exit(23) });',
    'await backups.export({ root, passphrase: "sufficient fixture password", signal: new AbortController().signal });',
  ].join('\n');
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', child, data, ownerId, fixture]), { code: 23 });
  const stages = (await fs.readdir(data)).filter(name => name.startsWith('.timechain-backup-') && name !== path.basename(other));
  assert.equal(stages.length, 1);
  const abandoned = path.join(data, stages[0]);
  await fs.symlink(unrelated, path.join(abandoned, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await createTimechainBackups({ dataDir: data, ownerId });
  await assert.rejects(fs.lstat(abandoned), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(unrelated, 'must-survive.txt'), 'utf8'), 'Outside backup staging');
  assert.equal((await fs.stat(other)).isDirectory(), true);
});
