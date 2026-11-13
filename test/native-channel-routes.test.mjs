import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {createApp} from '../server.mjs';
import {DIMENSIONS, FRUITS} from '../lib/providers.mjs';

// This suite uses a fake native adapter and synthetic reviews. The real engine
// only receives explicit newly created fixture roots; it never finds user chains.
const byok = 'synthetic-private-channel-route-byok-key';
const channelSecret = 'synthetic-channel-route-private-bot-token';
const good = () => ({approved: true, decision: 'approve', usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 150])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 150])),
  rationale: 'The owner requested this concrete scoped native channel operation.'});
const latch = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-channel-routes-')));
  const state = {calls: [], executed: [], reviews: [], echoSecret: false, throwSecret: false, barrier: null};
  let app, base, token;
  const factory = () => ({
    start: async () => {}, close: async () => {}, suspend: async () => {}, resumeNativeSources: async () => {},
    status: () => ({backend: 'openclaw', running: true, healthy: true, enforcementHealthy: true}),
    describeControls: async () => ({runtime: {backend: 'openclaw', running: true}}), executeCommand: async () => ({}),
    toolCatalogue: async () => ({tools: []}),
    nativeChannels: async request => {
      const {authorize, authority, identity, ...payload} = request;
      state.calls.push({payload: structuredClone(payload), identity: structuredClone(identity),
        authorizeType: typeof authorize, authority: structuredClone(authority)});
      if (request.mode === 'catalogue') return {items: [{id: 'telegram', label: 'Telegram', installed: true, enabled: true,
        accounts: [{accountId: 'default', configured: false}], capabilities: {start: true, stop: true, pairing: true}}], baseHash: 'native-fixture-hash'};
      assert.equal(typeof authorize, 'function', 'Only the server can provide owner/PoI admission.');
      const intent = {operation: request.mode === 'setup' ? 'channels.configure' : 'channels.' + request.action,
        channelId: request.channelId, accountId: request.accountId,
        details: request.mode === 'setup' ? {values: request.values, credentials: (request.secretValues || []).map(({name, target}) => ({name, target}))} : {requestId: request.requestId || null}};
      const permit = await authorize(intent); assert.equal(permit.approved, true); await permit.assertCurrent();
      if (state.throwSecret) throw Object.assign(new Error('Synthetic native failure with ' + channelSecret), {code: 'NATIVE_CHANNEL_FIXTURE_FAILURE', status: 502});
      state.executed.push(structuredClone(payload));
      if (state.echoSecret) return {echo: channelSecret};
      return request.mode === 'setup' ? {items: [], baseHash: 'native-fixture-next-hash'} : {ok: true, channelId: request.channelId, accountId: request.accountId};
    },
  });
  app = await createApp({dataDir: directory, pairingCode: 'NATIVE-CHANNEL-ROUTES', canonicalUpdates: false,
    openclaw: {}, openclawFactory: factory, review: async (_config, args) => {
      state.reviews.push(structuredClone({...args, signal: undefined}));
      const barrier = state.barrier; if (barrier) {state.barrier = null; barrier.started.resolve(); await barrier.release.promise;}
      return good();
    }});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.closeRuntime(); app.server.closeAllConnections();
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    const absolute = path.resolve(directory), temporary = await fs.realpath(os.tmpdir());
    assert.ok(absolute.startsWith(temporary + path.sep) && path.basename(absolute).startsWith('ct-native-channel-routes-'));
    await fs.rm(absolute, {recursive: true, force: true, maxRetries: 8, retryDelay: 100});
  });
  const call = async (endpoint, payload, headers = {}) => {
    const response = await fetch(base + endpoint, {method: payload === undefined ? 'GET' : 'POST', headers: {
      origin: base, ...(token ? {authorization: 'Bearer ' + token} : {}),
      ...(payload === undefined ? {} : {'content-type': 'application/json'}), ...headers,
    }, ...(payload === undefined ? {} : {body: JSON.stringify(payload)})});
    return {status: response.status, body: await response.json()};
  };
  const ready = async () => {
    const pair = await call('/api/pair', {code: 'NATIVE-CHANNEL-ROUTES'}); assert.equal(pair.status, 200); token = pair.body.token;
    const created = await call('/api/agents', {name: 'Native channel route fixture'}); assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await call('/api/provider', {provider: 'openai', model: 'synthetic-route-model', apiKey: byok})).status, 200);
    return created.body.agent;
  };
  const holdReview = () => {const barrier = {started: latch(), release: latch()}; state.barrier = barrier; return barrier;};
  return {app, state, call, ready, holdReview, directory, get token() {return token;}, get base() {return base;}};
}

const setup = () => ({channelId: 'telegram', accountId: 'default', values: {enabled: false, dmPolicy: 'pairing'},
  secretValues: [{name: 'channel-route', target: '/channels/telegram/botToken', value: channelSecret, remember: false}], baseHash: 'native-fixture-hash'});
const stop = () => ({action: 'stop', channelId: 'telegram', accountId: 'default'});

// These tests intentionally stop at the injected native adapter boundary. Native
// plugin lifecycle/schema/credential staging is independently tested in its own suites.
test('paired native channel routes forward catalogue and exact scoped setup/action fields with server-owned admission', {timeout: 90000}, async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/openclaw/channels')).status, 401);
  const agent = await f.ready();
  const catalogue = await f.call('/api/openclaw/channels'); assert.equal(catalogue.status, 200); assert.equal(catalogue.body.items[0].id, 'telegram');
  assert.deepEqual(f.state.calls[0].payload, {mode: 'catalogue'}); assert.equal(f.state.calls[0].identity.agentId, agent.id);
  const configured = await f.call('/api/openclaw/channels/setup', setup()); assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.deepEqual(f.state.calls[1].payload, {...setup(), mode: 'setup'}); assert.equal(f.state.calls[1].authorizeType, 'function');
  assert.equal(f.state.calls[1].identity.agentId, agent.id); assert.equal(f.state.calls[1].identity.genesisHash, agent.genesis.hash);
  assert.equal(f.state.calls[1].authority.enabled, false, 'Channel owner admission does not forge a general host-tool grant.');
  const stopped = await f.call('/api/openclaw/channels/action', stop()); assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.deepEqual(f.state.calls[2].payload, {...stop(), mode: 'action'});
  const nativeActions = [
    {action: 'pairing-approve', channelId: 'telegram', accountId: 'default', requestId: 'request-one', notify: false, bootstrapCommandOwner: true},
    {action: 'web-login-start', channelId: 'telegram', accountId: 'default', force: false, timeoutMs: 1000},
    {action: 'web-login-wait', channelId: 'telegram', accountId: 'default', challengeId: 'opaque-local-challenge', timeoutMs: 1000},
  ];
  for (const payload of nativeActions) {
    const result = await f.call('/api/openclaw/channels/action', payload); assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(f.state.calls.at(-1).payload, {...payload, mode: 'action'});
  }
  assert.equal(f.state.executed.length, 5); assert.equal(f.state.reviews.length, 5); assert.equal(JSON.stringify(f.state.reviews).includes(channelSecret), false);
  assert.equal(JSON.stringify(configured.body).includes(channelSecret), false); assert.equal(JSON.stringify((await f.call('/api/state')).body).includes(byok), false);
  assert.equal((await f.call('/api/openclaw/channels/action', stop(), {origin: 'https://untrusted.example'})).status, 403);
});

test('native channel routes reject caller mode, authority, authorization, admitted paths and arbitrary RPC fields before adapter calls', {timeout: 90000}, async t => {
  const f = await fixture(t); await f.ready();
  for (const [route, payload] of [['setup', setup()], ['action', stop()]]) for (const extra of [
    {mode: 'catalogue'}, {authorize: true}, {authority: {enabled: true}}, {admittedSettings: ['*']}, {identity: {agentId: 'other'}}, {method: 'config.set'}, {params: {channel: 'other'}},
  ]) {
    const result = await f.call('/api/openclaw/channels/' + route, {...payload, ...extra}); assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(JSON.stringify(result.body).includes(channelSecret), false);
  }
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.executed.length, 0); assert.equal(f.state.reviews.length, 0);
});

test('switching the selected agent during native channel review rejects the pending action before native execution', {timeout: 90000}, async t => {
  const f = await fixture(t), first = await f.ready();
  const other = await f.call('/api/agents', {name: 'Other native channel route fixture'}); assert.equal(other.status, 201);
  assert.equal((await f.call('/api/agents/select', {id: first.id})).status, 200);
  const barrier = f.holdReview(), pending = f.call('/api/openclaw/channels/action', stop()); await barrier.started.promise;
  assert.equal((await f.call('/api/agents/select', {id: other.body.agent.id})).status, 200);
  barrier.release.resolve(); const result = await pending;
  assert.equal(result.status, 409, JSON.stringify(result.body)); assert.equal(result.body.code, 'SKILL_AGENT_CHANGED');
  assert.equal(f.state.executed.length, 0); assert.equal(f.state.calls[0].identity.agentId, first.id);
});

test('revoking the paired owner during native channel review prevents native execution', {timeout: 90000}, async t => {
  const f = await fixture(t); await f.ready();
  const barrier = f.holdReview(), pending = f.call('/api/openclaw/channels/action', stop()); await barrier.started.promise;
  assert.equal((await f.call('/api/unpair', {})).status, 200); barrier.release.resolve();
  const result = await pending; assert.ok([401, 409].includes(result.status), JSON.stringify(result.body));
  assert.ok(['PAIR_REQUIRED', 'SESSION_CHANGED'].includes(result.body.code)); assert.equal(f.state.executed.length, 0);
  assert.equal((await f.call('/api/openclaw/channels')).status, 401);
});

test('Finch halt fences an admitted channel request and prevents new channel settings or catalogue delivery', {timeout: 90000}, async t => {
  const f = await fixture(t); await f.ready();
  const barrier = f.holdReview(), pending = f.call('/api/openclaw/channels/action', stop()); await barrier.started.promise;
  const halted = await f.call('/api/emergency-halt/stop', {confirm: true}); assert.equal(halted.status, 200, JSON.stringify(halted.body)); barrier.release.resolve();
  const result = await pending; assert.equal(result.status, 423); assert.equal(result.body.code, 'EMERGENCY_HALTED'); assert.equal(f.state.executed.length, 0);
  assert.equal((await f.call('/api/openclaw/channels')).status, 423);
  assert.equal((await f.call('/api/openclaw/channels/setup', setup())).status, 423);
});

test('native setup rejects reflected credentials and redacts known credential values in native error messages', {timeout: 90000}, async t => {
  const f = await fixture(t); await f.ready(); f.state.echoSecret = true;
  const echoed = await f.call('/api/openclaw/channels/setup', setup()); assert.equal(echoed.status, 422, JSON.stringify(echoed.body));
  assert.equal(echoed.body.code, 'CHANNEL_CREDENTIAL_ISOLATION'); assert.equal(JSON.stringify(echoed.body).includes(channelSecret), false);
  f.state.echoSecret = false; f.state.throwSecret = true;
  const error = await f.call('/api/openclaw/channels/setup', setup()); assert.equal(error.status, 502, JSON.stringify(error.body));
  assert.equal(error.body.code, 'NATIVE_CHANNEL_FIXTURE_FAILURE'); assert.match(error.body.error, /REDACTED/); assert.equal(JSON.stringify(error.body).includes(channelSecret), false);
  assert.equal(JSON.stringify(f.state.reviews).includes(channelSecret), false);
  const localFiles = async folder => (await Promise.all((await fs.readdir(folder, {withFileTypes: true})).map(async entry => entry.isDirectory() ? localFiles(path.join(folder, entry.name)) : /\.(?:json|jsonl|log)$/u.test(entry.name) ? [await fs.readFile(path.join(folder, entry.name), 'utf8')] : []))).flat();
  for (const body of await localFiles(f.directory)) {assert.equal(body.includes(channelSecret), false); assert.equal(body.includes(byok), false);}
});
