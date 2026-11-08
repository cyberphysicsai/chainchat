import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadGatewayClient, resolveGatewayClientEntry} from '../openclaw/gateway-client-loader.mjs';

async function fixture(t, source = 'import { t as GatewayClient } from "../client-fixture.mjs";\nthrow new Error("The unrelated barrel must not execute");\nexport { GatewayClient };') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-client-loader-'));
  await fs.mkdir(path.join(root, 'dist', 'plugin-sdk'), {recursive: true});
  await fs.writeFile(path.join(root, 'dist', 'plugin-sdk', 'gateway-runtime.js'), source);
  await fs.writeFile(path.join(root, 'dist', 'client-fixture.mjs'),
    'export class t { start(){} stop(){} stopAndWait(){} request(){} }');
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, {recursive: true, force: true}); });
  return root;
}

test('loads the same official client export without executing unrelated SDK barrel code', async t => {
  const root = await fixture(t), Client = await loadGatewayClient(root);
  const original = await import(pathToFileURL(path.join(root, 'dist', 'client-fixture.mjs')).href);
  assert.equal(Client, original.t);
  assert.deepEqual(await resolveGatewayClientEntry(root), {file: await fs.realpath(path.join(root, 'dist', 'client-fixture.mjs')), exportName: 't'});
});

test('unsupported, ambiguous, oversized or non-client imports fail instead of loading the broad SDK as a fallback', async t => {
  for (const source of [
    'export class GatewayClient {}',
    'import { t as GatewayClient } from "https://example.invalid/client.mjs"; export { GatewayClient };',
    'import { t as GatewayClient } from "../../client-escape.mjs"; export { GatewayClient };',
    'import { t as GatewayClient } from "../server.mjs"; export { GatewayClient };',
    'import { t as GatewayClient } from "../client-fixture.mjs"; import { n as GatewayClient } from "../client-other.mjs"; export { GatewayClient };',
    'import { t as GatewayClient } from "../client-fixture.mjs"; // no public re-export',
    ' '.repeat(65537),
  ]) {
    const root = await fixture(t, source);
    await assert.rejects(loadGatewayClient(root), {code: 'OPENCLAW_CLIENT_ENTRY_UNSUPPORTED'});
  }
});

test('a changed client export fails closed without substituting a protocol implementation', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'dist', 'client-fixture.mjs'), 'export const t = class { start() {} };');
  await assert.rejects(loadGatewayClient(root), {code: 'OPENCLAW_CLIENT_ENTRY_UNSUPPORTED'});
});

test('an SDK entry that resolves outside its dist root is refused', async t => {
  const root = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-client-outside-'));
  t.after(async () => { assert.ok(path.resolve(outside).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(outside, {recursive: true, force: true}); });
  await fs.writeFile(path.join(outside, 'outside.mjs'), 'throw new Error("Must never import an outside target");');
  await fs.unlink(path.join(root, 'dist', 'client-fixture.mjs'));
  try { await fs.symlink(path.join(outside, 'outside.mjs'), path.join(root, 'dist', 'client-fixture.mjs')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS does not permit unprivileged file symlinks'); throw error; }
  await assert.rejects(loadGatewayClient(root), {code: 'OPENCLAW_CLIENT_ENTRY_UNSUPPORTED'});
});
