import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ToolPermissions, disabledToolAuthority } from '../lib/tool-permissions.mjs';

test('tool grants default off, serialize concurrent updates, persist privately and revoke all identities of an agent', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-tool-permissions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new ToolPermissions(root).load();
  assert.deepEqual(store.get('a:genesis').grant, disabledToolAuthority());
  assert.deepEqual(store.get('a:genesis').operations, ['save', 'revoke-all']);
  const grant = { enabled: true, tools: ['read'], roots: [root], networkHosts: [], allowExecution: false, acknowledged: true };
  const [a, b] = await Promise.all([store.set('a:genesis', grant), store.set('b:genesis', grant)]);
  assert.notEqual(a.revision, b.revision);
  await store.set('a:other-genesis', grant);
  a.grant.tools.push('write');
  assert.deepEqual(store.get('a:genesis').grant.tools, ['read']);
  const restored = await new ToolPermissions(root).load();
  assert.equal(restored.get('b:genesis').revision, b.revision);
  const revoked = await restored.disableRecord('a');
  assert.notEqual(revoked.revision, store.get('a:genesis').revision);
  assert.equal(restored.get('a:genesis').grant.enabled, false);
  assert.equal(restored.get('a:other-genesis').grant.enabled, false);
  assert.equal(restored.get('b:genesis').grant.enabled, true);
  assert.equal((await new ToolPermissions(root).load()).get('a:genesis').grant.enabled, false);
  assert.equal((await fs.readFile(restored.file, 'utf8')).includes('operations'), false);
  assert.deepEqual(revoked.operations, ['save', 'revoke-all']);
  if (process.platform !== 'win32') assert.equal((await fs.stat(restored.file)).mode & 0o077, 0);
});

test('corrupt persisted authority fails closed instead of enabling or silently replacing it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-tool-permissions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'tool-permissions.json'), '{"version":99,"agents":{}}');
  await assert.rejects(new ToolPermissions(root).load(), /inspection/);
});

test('failed queued validation preserves the old revision and cannot poison later atomic merges', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-tool-permissions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new ToolPermissions(root).load();
  const initial = await store.set('agent:genesis', { ...disabledToolAuthority(), nativeCapabilities: { enabled: true, tools: ['sessions_list'] } });
  const before = await fs.readFile(store.file, 'utf8');
  await assert.rejects(store.update('agent:genesis', async current => {
    current.grant.enabled = true; current.operations.push('fabricated');
    await Promise.resolve(); throw new Error('Synthetic validation rejection.');
  }), /Synthetic validation rejection/);
  assert.equal(await fs.readFile(store.file, 'utf8'), before);
  assert.deepEqual(store.get('agent:genesis'), initial);
  const saved = await store.update('agent:genesis', current => ({ ...current.grant, enabled: true, tools: ['read'] }));
  assert.notEqual(saved.revision, initial.revision);
  assert.deepEqual(saved.grant.nativeCapabilities, initial.grant.nativeCapabilities);
  assert.deepEqual(saved.operations, ['save', 'revoke-all']);
});
