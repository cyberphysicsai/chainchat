import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createEmergencyHalt } from '../lib/emergency-halt.mjs';
import { engine } from '../lib/engine.mjs';
import { DIMENSIONS, FRUITS } from '../lib/providers.mjs';

const hosted = 'https://halt-test.example.com';
const code = 'EMERGENCY-FIXTURE';
const provider = { provider: 'openai', model: 'emergency-fixture', apiKey: 'synthetic-key-emergency' };
const answer = 'I can assist with patient and honest reasoning.';
const review = async () => ({
  approved: true, decision: 'approve', usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])),
  rationale: 'The fixture is compatible with the verified Timechain covenant.',
});

async function localFixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-emergency-halt-'));
  let app, base;
  async function close() {
    if (!app) return;
    if (app.server.listening) {
      app.server.closeAllConnections();
      await new Promise(resolve => app.server.close(resolve));
    }
    await app.closeRuntime();
    app = null;
  }
  t.after(async () => {
    await close();
    assert.ok(path.basename(directory).startsWith('ct-emergency-halt-'));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  });
  async function start() {
    app = await createApp({ dataDir: directory, pairingCode: code, publicOrigins: [hosted], ...options });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
    return app;
  }
  async function request(endpoint, body, token, origin = base) {
    const headers = { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  async function pair(origin) {
    const response = await request('/api/pair', { code }, undefined, origin);
    assert.equal(response.status, 200);
    return response.body.token;
  }
  return { directory, start, close, request, pair };
}

test('owner halt suppresses an in-flight answer and survives restart until a verified local re-arm', { timeout: 90000 }, async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let delay = true, healthyChain = true;
  const f = await localFixture(t, {
    engine: (request, options) => request.op === 'verify' && !healthyChain ? { verified: false } : engine(request, options),
    generate: async (_config, args) => {
      if (delay) { started.resolve(args.signal); await release.promise; }
      return { text: answer };
    }, review,
  });
  const app = await f.start();
  let owner = await f.pair();
  const guest = await f.pair(hosted);
  const call = (route, body) => f.request(route, body, owner);
  assert.equal((await f.request('/api/emergency-halt', undefined, guest, hosted)).status, 403);
  assert.equal((await f.request('/api/emergency-halt/stop', { confirm: true }, guest, hosted)).status, 403);
  assert.equal((await call('/api/agents', { name: 'Halt Fixture' })).status, 201);
  assert.equal((await call('/api/provider', provider)).status, 200);
  assert.equal((await call('/api/cognition', { semanticRecall: false, autoRoute: false })).status, 200);
  const root = app.store.agents[0].root;
  const head = (await engine({ op: 'verify', root })).head.hash;
  const turn = call('/api/chat', { message: 'Please introduce yourself.' });
  const signal = await started.promise;
  const stopped = await call('/api/emergency-halt/stop', { confirm: true });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.halted, true);
  assert.equal(signal.aborted, true);
  assert.equal((await call('/api/chat', { message: 'This should be held.' })).status, 423);
  assert.equal((await call('/api/emergency-halt/rearm', { confirm: true })).body.code, 'EMERGENCY_BUSY');
  release.resolve();
  const held = await turn;
  assert.equal(held.status, 423);
  assert.equal(JSON.stringify(held.body).includes(answer), false);
  assert.equal((await engine({ op: 'verify', root })).head.hash, head);
  await f.close();
  await f.start();
  owner = await f.pair();
  const status = await f.request('/api/status');
  assert.equal(status.body.emergencyHalt.halted, true);
  assert.equal(status.body.emergencyHalt.source, undefined);
  assert.equal(status.body.emergencyHalt.profile, undefined);
  assert.equal((await call('/api/emergency-halt')).body.source, 'local');
  assert.equal((await call('/api/state')).body.emergencyHalt.halted, true);
  assert.equal((await call('/api/provider', provider)).status, 423);
  healthyChain = false;
  assert.equal((await call('/api/emergency-halt/rearm', { confirm: true })).body.code, 'CHAIN_INVALID');
  assert.equal((await call('/api/emergency-halt')).body.halted, true);
  healthyChain = true;
  assert.equal((await call('/api/emergency-halt/rearm', { confirm: true })).body.halted, false);
  assert.equal((await call('/api/provider', provider)).status, 200);
  delay = false;
  const resumed = await call('/api/chat', { message: 'Please introduce yourself after re-arm.' });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.message.gate.approved, true);
});

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
test('a new local stop preempts re-arm and the persisted nonce rejects the previous wallet signal', async t => {
  const { directory } = await localFixture(t);
  const verifying = Promise.withResolvers(), verify = Promise.withResolvers();
  let stops = 0, verifyDelayed = true;
  const opts = { directory, onTrip: () => { stops++; },
    onRearm: async current => { if (verifyDelayed) { verifying.resolve(); await verify.promise; } current(); } };
  const latch = await createEmergencyHalt(opts);
  const { profile } = await latch.configure({ wallet: '0x' + '12'.repeat(20), feedUrl: 'https://example.com/halt.json' });
  const signal = { installationId: profile.installationId, nonce: profile.nonce };
  assert.equal(await latch.trip('wallet', { ...signal, nonce: '0x' + 'ff'.repeat(32) }), false);
  assert.equal((await latch.trip('wallet', signal)).source, 'wallet');
  const restarted = await createEmergencyHalt(opts);
  assert.equal(restarted.publicStatus().halted, true);
  const rearm = restarted.rearm();
  await verifying.promise;
  const stop = restarted.trip('local');
  assert.equal(stops, 2, 'A second stop interrupts verification immediately.');
  verify.resolve();
  await assert.rejects(rearm, { code: 'EMERGENCY_HALTED' });
  assert.equal((await stop).source, 'local');
  verifyDelayed = false;
  assert.equal((await restarted.rearm()).halted, false);
  assert.equal(await restarted.trip('wallet', signal), false);
  const file = path.join(directory, 'emergency-halt.json');
  await fs.writeFile(file, '{broken');
  const corrupt = await createEmergencyHalt(opts);
  assert.equal(corrupt.publicStatus().storageError, true);
  assert.throws(() => corrupt.assertAvailable(), { code: 'EMERGENCY_HALTED' });
});

test('the real owned OpenClaw gateway is down across restart and starts with mandatory PoI on re-arm', {
  skip: !packageRoot || !nodePath, timeout: 420000,
}, async t => {
  const diagnostics = [];
  const options = { packageRoot, nodePath, pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)),
    onDiagnostic: line => diagnostics.push(line) };
  const f = await localFixture(t, { openclaw: options });
  options.stateDir = path.join(f.directory, 'gateway');
  try {
    let app = await f.start();
    let owner = await f.pair();
    const call = (route, body) => f.request(route, body, owner);
    assert.equal(app.openclaw.status().enforcementHealthy, true);
    assert.equal((await call('/api/agents', { name: 'Native Halt Fixture' })).status, 201);
    const stopped = await call('/api/emergency-halt/stop', { confirm: true });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(app.openclaw.status().running, false);
    await assert.rejects(app.openclaw.start(), { code: 'EMERGENCY_HALTED' });
    await f.close();
    app = await f.start();
    owner = await f.pair();
    assert.equal(app.openclaw.status().running, false);
    assert.equal((await call('/api/emergency-halt')).body.halted, true);
    const rearmed = await call('/api/emergency-halt/rearm', { confirm: true });
    assert.equal(rearmed.status, 200, JSON.stringify(rearmed.body));
    assert.equal(rearmed.body.halted, false);
    assert.equal(app.openclaw.status().running, true);
    assert.equal(app.openclaw.status().enforcementHealthy, true);
  } catch (error) { throw new Error(`${error.message}\n${diagnostics.join('').slice(-4500)}`, { cause: error }); }
});
