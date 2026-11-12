import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertManagedRuntime, assertNpmSecurityProfile} from '../openclaw/runtime-security.mjs';

const pins = JSON.parse(await fs.readFile(new URL('../openclaw/upstream-lock.json', import.meta.url), 'utf8'));

test('security profile binds the reviewed installer archive and dependency patches', () => {
  assert.equal(assertNpmSecurityProfile(pins), pins.npmSecurityProfile);
  for (const key of ['bootstrapNpm', 'bundledDependencyOverlays', 'npmSecurityOverlays', 'runtimeSecurityOverlays', 'npmSecurityProfile']) {
    const changed = structuredClone(pins);
    delete changed[key];
    assert.throws(() => assertNpmSecurityProfile(changed), /security.*commitment|profile commitment/);
  }
  const changed = structuredClone(pins);
  changed.npmSecurityOverlays[0].files[0].sha256 = '0'.repeat(64);
  assert.throws(() => assertNpmSecurityProfile(changed), /profile commitment/);
});

test('managed startup holds missing security bytes before any native SDK is loaded', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ct-managed-security-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await assert.rejects(assertManagedRuntime(root));
});

test('actual managed attestation requires compatibility, npm and embedded security fixes together', {
  skip: !process.env.CT_OPENCLAW_PACKAGE && 'requires the complete patched runtime in isolated CI',
}, async t => {
  const source = process.env.CT_OPENCLAW_PACKAGE;
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ct-managed-security-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const upstream = path.join(root, 'node_modules/openclaw'), npm = path.join(root, 'node_modules/npm');
  async function copy(base, target, relative) {
    const filename = path.join(target, relative);
    await fs.mkdir(path.dirname(filename), {recursive: true});
    await fs.copyFile(path.join(base, relative), filename);
  }
  for (const relative of new Set(['package.json',
    ...pins.runtimeCompatibilityOverlays.flatMap(group => group.files.map(row => row.path)),
    ...pins.runtimeSecurityOverlays.flatMap(group => group.files.map(row => row.path))]))
    await copy(source, upstream, relative);
  for (const relative of ['package.json', 'node_modules/ip-address/package.json', 'node_modules/undici/package.json',
    ...pins.npmSecurityOverlays.flatMap(group => group.files.map(row => row.path))])
    await copy(path.resolve(source, '../npm'), npm, relative);
  const report = await assertManagedRuntime(upstream);
  assert.deepEqual(report.runtimeCompatibilityOverlays, pins.runtimeCompatibilityOverlays);
  assert.deepEqual(report.npmSecurityOverlays, pins.npmSecurityOverlays);
  assert.deepEqual(report.runtimeSecurityOverlays, pins.runtimeSecurityOverlays);
  for (const [target, row] of [[npm, pins.npmSecurityOverlays[0].files[0]], [upstream, pins.runtimeSecurityOverlays[0].files[0]]]) {
    const filename = path.join(target, row.path), original = await fs.readFile(filename);
    await fs.appendFile(filename, '\n');
    await assert.rejects(assertManagedRuntime(upstream), /security.*(verification|missing|changed)/);
    await fs.writeFile(filename, original);
  }
});
