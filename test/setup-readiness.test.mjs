import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {setupReadiness} from '../lib/setup-readiness.mjs';
import {createApp} from '../server.mjs';

const HASH = '1'.repeat(64), COMMIT = 'a'.repeat(40), secret = 'synthetic-readiness-private-key';
const canonicalSkill = {commit: COMMIT, origin: 'packaged-canonical', immutableTurnSnapshot: true};
const agent = {verified: true, genesis: {name: 'Cypher Tempre', hash: HASH}, head: {index: 0, hash: HASH},
  runtime: {mode: 'active'}, root: '/private/chain', history: ['private history']};
const native = {backend: 'openclaw', version: '2026.10.10', running: true, healthy: true, enforcementHealthy: true};
const provider = {configured: true, provider: 'compatible', tier: 'byok', model: 'fixture-model',
  baseUrl: 'https://private-model.example/v1', apiKey: secret};
const ready = extra => setupReadiness({runtime: native, provider, selected: true, agentId: 'fixture-agent', agent, canonicalSkill, ...extra});

test('setup readiness reports configuration without claiming an inference or exposing private data', () => {
  const report = ready();
  assert.equal(report.setupReady, true); assert.equal(report.nextStep, 'complete');
  assert.equal(report.modelConnectionTested, false); assert.equal(report.inferencePerformed, false);
  assert.equal(report.checks.model.connectionTested, false);
  assert.equal(report.checks.timechain.agentId, 'fixture-agent'); assert.equal(report.checks.timechain.headHash, HASH);
  for (const value of [secret, 'private-model.example', '/private/chain', 'private history'])
    assert.equal(JSON.stringify(report).includes(value), false);
});

test('missing or stopped native runtime is not certified as ready and the check does not start it', () => {
  for (const runtime of [{backend: 'direct'}, {...native, running: false}, {...native, running: undefined}]) {
    const report = ready({runtime});
    assert.equal(report.setupReady, false); assert.equal(report.nextStep, 'runtime');
    assert.equal(report.checks.runtime.running, false); assert.equal(report.checks.runtime.startOnFirstChat, false);
  }
  assert.equal(ready({runtime: {...native, healthy: false}}).checks.runtime.ready, false);
  assert.equal(ready({runtime: {...native, enforcementHealthy: false}}).checks.runtime.ready, false);
  for (const missing of ['healthy', 'enforcementHealthy']) {
    const runtime = {...native}; delete runtime[missing];
    const check = ready({runtime}).checks.runtime;
    assert.equal(check.ready, false); assert.equal(check.reason, 'RUNTIME_UNHEALTHY');
  }
});

test('a configured BYOK or native model is distinct from tested credentials', () => {
  const own = ready({provider: {...provider, provider: 'native', tier: undefined}});
  assert.equal(own.setupReady, true); assert.equal(own.checks.model.tier, 'native');
  assert.equal(own.checks.model.connectionTested, false);
  const missing = ready({provider: {configured: false}});
  assert.equal(missing.nextStep, 'model'); assert.equal(missing.setupReady, false);
});

test('readiness preserves complete valid provider model identities through 200 characters', () => {
  const model = 'provider/' + 'm'.repeat(191);
  assert.equal(model.length, 200);
  for (const protocol of ['compatible', 'native']) {
    const report = ready({provider: {...provider, provider: protocol, model}});
    assert.equal(report.setupReady, true); assert.equal(report.checks.model.model, model);
  }
  assert.equal(ready({provider: {...provider, model: model + 'x'}}).checks.model.ready, false);
});

test('missing, failed or incomplete chain verification cannot finish setup', () => {
  for (const extra of [{selected: false}, {agent: null}, {timechainError: true},
    {agent: {...agent, verified: false}}, {agent: {...agent, head: {index: -1, hash: HASH}}},
    {agent: {...agent, genesis: {hash: 'invalid'}}}]) {
    const report = ready(extra);
    assert.equal(report.setupReady, false); assert.equal(report.nextStep, 'timechain');
    assert.equal(report.checks.timechain.blockHeight, null);
  }
});

test('canonical bundle identity and enforced snapshots are required; paused memory remains explicit', () => {
  for (const value of [null, {...canonicalSkill, immutableTurnSnapshot: false},
    {...canonicalSkill, origin: 'untrusted'}, {...canonicalSkill, commit: 'bad'}]) {
    assert.equal(ready({canonicalSkill: value}).nextStep, 'proof');
  }
  const report = ready({agent: {...agent, runtime: {mode: 'dormant'}}});
  assert.equal(report.memoryPaused, true); assert.equal(report.checks.proof.required, true);
  assert.equal(report.setupReady, true, 'Dormancy keeps baseline PoI review and regular chat.');
});

test('verified but locked chains and non-dormant paused ledgers cannot be marked chat-ready', () => {
  for (const extra of [{locked: true}, {paused: true}]) {
    const report = ready({agent: {...agent, ...extra}});
    assert.equal(report.setupReady, false); assert.equal(report.checks.timechain.verified, true);
    assert.equal(report.nextStep, 'timechain');
  }
  assert.equal(ready({agent: {...agent, paused: true, runtime: {mode: 'dormant'}}}).setupReady, true);
});

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-setup-readiness-'));
  const calls = [], modelCalls = [], catalogueCalls = [];
  let running = true, starts = 0, inspectFailure = false, holdInspect;
  const app = await createApp({dataDir, pairingCode: 'READINESS-FIXTURE', canonicalUpdates: false,
    engine: async request => {
      calls.push(structuredClone(request));
      if (request.op === 'init') return structuredClone(agent);
      if (request.op === 'inspect') {
        if (holdInspect) await holdInspect;
        if (inspectFailure) throw new Error('Private path and chain content must not reach readiness.');
        return structuredClone(agent);
      }
      throw new Error('A readiness check must not change the chain.');
    },
    generate: async () => {modelCalls.push('generate'); throw new Error('No model call allowed.');},
    review: async () => {modelCalls.push('review'); throw new Error('No review call allowed.');},
    catalogueFetch: async (url, options) => {
      catalogueCalls.push({url, options});
      throw new Error('A readiness check must not query a model catalogue.');
    },
    openclaw: {}, openclawFactory: () => ({nodePath: process.execPath,
      start: async () => {starts++;}, close: async () => {},
      status: () => ({...native, running})}),
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.closeRuntime(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    const resolved = await fs.realpath(dataDir);
    assert.ok(resolved.startsWith((await fs.realpath(os.tmpdir())) + path.sep));
    assert.ok(path.basename(resolved).startsWith('ct-setup-readiness-'));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  let token;
  const call = async (route, input) => {
    const response = await fetch(base + route, {method: input === undefined ? 'GET' : 'POST',
      headers: {origin: base, ...(token ? {authorization: `Bearer ${token}`} : {}),
        ...(input === undefined ? {} : {'content-type': 'application/json'})},
      ...(input === undefined ? {} : {body: JSON.stringify(input)})});
    return {status: response.status, body: await response.json(), headers: response.headers};
  };
  const pair = async () => {token = (await call('/api/pair', {code: 'READINESS-FIXTURE'})).body.token;};
  const configure = async () => {
    await pair();
    assert.equal((await call('/api/agents', {name: 'Cypher Tempre'})).status, 201);
    assert.equal((await call('/api/provider', {provider: 'compatible', model: 'fixture-model',
      baseUrl: 'https://private-model.example/v1', apiKey: secret})).status, 200);
  };
  return {call, pair, configure, calls, modelCalls, catalogueCalls, starts: () => starts,
    stop: () => {running = false;},
    inspectFailure: () => {inspectFailure = true;}, hold: promise => {holdInspect = promise;}};
}

test('readiness endpoint requires pairing, performs only read-only inspection and never tests a provider', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/setup/readiness')).status, 401);
  await f.configure(); f.calls.length = 0;
  const beforeStarts = f.starts(), response = await f.call('/api/setup/readiness');
  assert.equal(response.status, 200); assert.equal(response.body.setupReady, true);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.calls.map(({op, learning}) => ({op, learning})), [{op: 'inspect', learning: false}]);
  assert.deepEqual(f.modelCalls, []); assert.deepEqual(f.catalogueCalls, []);
  assert.equal(f.starts(), beforeStarts);
  assert.equal(JSON.stringify(response.body).includes(secret), false);
  f.stop();
  assert.equal((await f.call('/api/setup/readiness')).body.nextStep, 'runtime');
  assert.equal(f.starts(), beforeStarts);
});

test('a failed chain check is bounded to a setup error without exposing private diagnostics', async t => {
  const f = await fixture(t); await f.configure(); f.inspectFailure();
  const response = await f.call('/api/setup/readiness');
  assert.equal(response.status, 200); assert.equal(response.body.setupReady, false);
  assert.equal(response.body.checks.timechain.error, 'CHAIN_CHECK_FAILED');
  assert.equal(JSON.stringify(response.body).includes('Private path'), false);
  assert.deepEqual(f.modelCalls, []);
});

test('a model changed while readiness is inspecting cannot receive a stale success', async t => {
  const f = await fixture(t); await f.configure();
  let release; const held = new Promise(resolve => {release = resolve;}); f.hold(held);
  f.calls.length = 0;
  const pending = f.call('/api/setup/readiness');
  for (let n = 0; !f.calls.some(call => call.op === 'inspect') && n < 100; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.calls.some(call => call.op === 'inspect'));
  assert.equal((await f.call('/api/provider', {disconnect: true})).status, 200);
  release();
  const response = await pending;
  assert.equal(response.status, 409); assert.equal(response.body.code, 'SESSION_CHANGED');
  assert.deepEqual(f.modelCalls, []);
});
