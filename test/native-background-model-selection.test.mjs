import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { DIMENSIONS, FRUITS } from '../lib/providers.mjs';

const model = 'fixture/owner-native';
const privateKey = 'synthetic-background-model-private-key';
const nativeGrant = { enabled: true, acknowledged: true, tools: [], settings: [], delegatedRuns: true, backgroundRuns: true };

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-background-model-')));
  const nativeAuth = Buffer.from('An owner-configured native authentication fixture stays intact.');
  const authFile = path.join(directory, 'owner-native-auth-fixture.json');
  await fs.writeFile(authFile, nativeAuth);
  let app, adapter, base, token, nativeCurrent = model, nativeReadBarrier, allowSyntheticGeneration = false;
  const generated = [];
  const generate = async config => {
    assert.equal(allowSyntheticGeneration, true, 'A read-only ownership lookup must not generate a model answer.');
    generated.push(structuredClone(config));
    return { text: 'Hello! I can help carefully and acknowledge uncertainty.', usage: {} };
  };
  const factory = options => {
    adapter = options;
    return {
      start: async () => {}, close: async () => {}, resumeNativeSources: async () => {},
      status: () => ({ backend: 'openclaw', running: true }),
      nativeModels: async () => {
        const pending = nativeReadBarrier; nativeReadBarrier = null;
        if (pending) { pending.started(); await pending.wait; }
        return { configured: true, current: nativeCurrent,
          models: [{ id: model, available: true }, { id: 'fixture/changed-native-profile', available: true }] };
      },
      setNativeModel: async (_identity, selected) => { nativeCurrent = selected; }, toolCatalogue: async () => ({ tools: [] }),
      sessionControls: async identity => ({ sessionKey: 'agent:main:owned-fixture:' + identity.agentId }),
      describeControls: async () => ({}), executeCommand: async () => ({}),
      generate, generateNative: generate,
      completeNative: async () => { throw new Error('This ownership test must not call a model reviewer.'); },
    };
  };
  const close = async () => {
    if (!app) return;
    await app.closeRuntime(); app.server.closeAllConnections();
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    app = null;
  };
  const call = async (endpoint, payload) => {
    const response = await fetch(base + endpoint, { method: payload === undefined ? 'GET' : 'POST', headers: {
      origin: base, ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, body: await response.json() };
  };
  const open = async () => {
    app = await createApp({ dataDir: directory, pairingCode: 'BACKGROUND-MODEL-ONLY', canonicalUpdates: false,
      openclaw: {}, openclawFactory: factory,
      review: async () => ({ approved: true, decision: 'approve', usedRings: [],
        scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
        fruits: Object.fromEntries(FRUITS.map(key => [key, 240])), rationale: 'A careful and grounded fixture greeting.' }),
      catalogueFetch: async (url, options) => {
        assert.equal(url, 'https://provider.example/v1/models');
        assert.equal(options.headers.authorization, 'Bearer ' + privateKey);
        return new Response(JSON.stringify({ data: [{ id: 'fixture/byok' }] }), { status: 200 });
      },
    });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`; token = null;
    const paired = await call('/api/pair', { code: 'BACKGROUND-MODEL-ONLY' });
    assert.equal(paired.status, 200); token = paired.body.token;
  };
  t.after(async () => {
    await close();
    const absolute = path.resolve(directory), temporary = await fs.realpath(os.tmpdir());
    assert.ok(absolute.startsWith(temporary + path.sep) && path.basename(absolute).startsWith('ct-background-model-'));
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  await open();
  const createNativeOwner = async name => {
    const created = await call('/api/agents', { name }); assert.equal(created.status, 201);
    const owner = { id: created.body.agent.id, genesisHash: created.body.agent.genesis.hash };
    assert.equal((await call('/api/openclaw/provider', { model })).status, 200);
    assert.equal((await call('/api/openclaw/native-capabilities', nativeGrant)).status, 200);
    owner.root = app.store.agents.find(record => record.id === owner.id).root;
    owner.key = owner.id + ':' + owner.genesisHash;
    return owner;
  };
  const other = await createNativeOwner('Unchanged native owner');
  const selected = await createNativeOwner('Current model owner');
  const histories = await Promise.all([selected, other].map(owner => fs.readFile(path.join(owner.root, 'chain', 'rings.jsonl'))));
  const owners = async () => JSON.parse(await fs.readFile(path.join(directory, 'native-provider-owners.json'), 'utf8')).owners;
  const binding = (owner, suffix) => ({ ownerKey: owner.key, kind: 'background',
    nativeSessionKey: `agent:main:background:${suffix}`, input: 'Inspect ownership only; no model inference.' });
  const resolve = (owner, suffix) => adapter.resolveNativeOwner(binding(owner, suffix));
  const resolveModel = owner => adapter.resolveNativeModelRoute({ ownerKey: owner.key });
  const assertOtherOwner = async suffix => {
    assert.ok((await owners()).some(row => row.key === other.key), 'Changing one agent must preserve another agent\'s explicit native choice.');
    const scope = await resolve(other, suffix); assert.ok(scope); assert.equal(scope.config.provider, 'native');
    await scope.context.authorize(); scope.release();
  };
  const assertNoFallback = async suffix => {
    assert.equal((await owners()).some(row => row.key === selected.key), false);
    assert.equal(await resolve(selected, suffix), null, 'A native profile must not become an implicit fallback for the selected BYOK route.');
    assert.equal(await resolveModel(selected), null, 'Transport selection cannot revive the retired native fallback.');
    await assertOtherOwner(suffix + '-other');
  };
  const finish = async () => {
    await close(); await open();
    await assertNoFallback('after-restart');
    assert.deepEqual(await fs.readFile(authFile), nativeAuth, 'Changing model routing must preserve local native authentication.');
    for (const [index, owner] of [selected, other].entries())
      assert.deepEqual(await fs.readFile(path.join(owner.root, 'chain', 'rings.jsonl')), histories[index]);
    const persisted = await fs.readFile(path.join(directory, 'native-provider-owners.json'), 'utf8');
    assert.equal(persisted.includes(privateKey), false); assert.equal(persisted.includes(token), false);
  };
  const snapshot = async () => {
    const files = {};
    const walk = async (directory, prefix) => {
      for (const row of await fs.readdir(directory, { withFileTypes: true })) {
        assert.equal(row.isSymbolicLink(), false);
        const relative = prefix + '/' + row.name, file = path.join(directory, row.name);
        if (row.isDirectory()) await walk(file, relative);
        else files[relative] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      }
    };
    for (const owner of [selected, other]) await walk(owner.root, owner.id);
    files['agents.json'] = (await fs.readFile(path.join(directory, 'agents.json'))).toString('base64');
    return { agentIds: app.store.agents.map(row => row.id), files };
  };
  return { call, selected, other, resolve, resolveModel, owners, snapshot, assertNoFallback, finish, generated,
    resolveModelKey: ownerKey => adapter.resolveNativeModelRoute({ ownerKey }),
    holdNativeRead() {
      let release, started;
      const wait = new Promise(resolve => { release = resolve; });
      const observed = new Promise(resolve => { started = resolve; });
      nativeReadBarrier = { wait, started }; return { started: observed, release };
    },
    async enableSyntheticGeneration() {
      assert.equal((await call('/api/cognition', { learning: false, autoRoute: false, autoSprout: false,
        semanticRecall: false, revisionLimit: 0 })).status, 200);
      assert.equal((await call('/api/settings', { recall: false })).status, 200);
      allowSyntheticGeneration = true;
    },
    changeNativeDefault: value => { nativeCurrent = value; },
    selectNative: () => call('/api/openclaw/provider', { model }),
    connectByok: () => call('/api/provider', { provider: 'compatible', model: 'fixture/byok', baseUrl: 'https://provider.example/v1', apiKey: privateKey }),
    unpair: () => call('/api/unpair', {}),
  };
}

test('a changed native default cannot replace a persisted owner-selected model after the browser session closes', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.unpair()).status, 200);
  const initial = await f.resolve(f.selected, 'persisted-profile-before-change');
  assert.ok(initial); assert.equal(initial.config.model, model); initial.release();
  f.changeNativeDefault('fixture/changed-native-profile');
  assert.equal(await f.resolveModel(f.selected), null);
  assert.equal(await f.resolve(f.selected, 'persisted-profile-after-change'), null,
    'A changed configured native default must require a fresh explicit selection instead of silently substituting another profile.');
  assert.ok((await f.owners()).some(row => row.key === f.selected.key && row.config.model === model),
    'Holding an implicit profile change must not destroy the earlier owner-selected reference.');
});

test('private native model-route lookup validates an existing owner without writing chains, faculties or agents', { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await f.snapshot();
  const route = await f.resolveModel(f.selected);
  assert.ok(route); assert.equal(route.config.provider, 'native'); assert.equal(route.config.model, model);
  assert.equal(typeof route.authorize, 'function'); await route.authorize();
  assert.equal(route.context, undefined, 'A transport lookup supplies no admitted cognitive context.');
  assert.equal(await f.resolveModelKey('invented-owner'), null);
  assert.equal(await f.resolveModelKey(f.selected.id + ':' + 'a'.repeat(64)), null);
  assert.equal(await f.resolveModelKey('unknown-agent:' + f.selected.genesisHash), null);
  assert.deepEqual(await f.snapshot(), before, 'Read-only route selection must preserve all agent and faculty bytes.');
  assert.equal(f.generated.length, 0);
});

test('private model-route authorization is revoked by disabled native capabilities or a paused parent', { timeout: 120000 }, async t => {
  const f = await fixture(t), route = await f.resolveModel(f.selected); assert.ok(route);
  assert.equal((await f.call('/api/openclaw/native-capabilities', { ...nativeGrant, enabled: false })).status, 200);
  assert.equal(await f.resolveModel(f.selected), null);
  await assert.rejects(route.authorize(), { code: 'SESSION_CHANGED' });
  assert.equal((await f.call('/api/openclaw/native-capabilities', nativeGrant)).status, 200);
  const resumed = await f.resolveModel(f.selected); assert.ok(resumed);
  assert.equal((await f.call('/api/cognition', { mode: 'dormant', confirm: true })).status, 200);
  assert.equal(await f.resolveModel(f.selected), null);
  await assert.rejects(resumed.authorize(), error => ['SESSION_CHANGED', 'CHAIN_DORMANT'].includes(error.code));
  assert.equal(f.generated.length, 0);
});

test('an awaited native model discovery cannot revive revoked transport selection', { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await f.snapshot(), previouslyAuthorized = await f.resolveModel(f.selected);
  assert.ok(previouslyAuthorized);
  const lookupBarrier = f.holdNativeRead(), pending = f.resolveModel(f.selected);
  await lookupBarrier.started;
  assert.equal((await f.connectByok()).status, 200);
  lookupBarrier.release();
  assert.equal(await pending, null);
  await assert.rejects(previouslyAuthorized.authorize(), { code: 'SESSION_CHANGED' });
  assert.equal(await f.resolveModel(f.selected), null);
  assert.deepEqual(await f.snapshot(), before, 'Revoked transport discovery must not create a child chain or grow a faculty.');
  assert.equal(f.generated.length, 0);
});

test('native ownership revoked during an awaited authorization is rechecked after discovery', { timeout: 120000 }, async t => {
  const f = await fixture(t), route = await f.resolveModel(f.selected); assert.ok(route);
  const barrier = f.holdNativeRead();
  const checking = route.authorize().then(() => ({ approved: true }), error => ({ error }));
  await barrier.started;
  assert.equal((await f.connectByok()).status, 200);
  barrier.release();
  const outcome = await checking;
  assert.equal(outcome.approved, undefined); assert.equal(outcome.error?.code, 'SESSION_CHANGED');
  assert.equal(await f.resolveModel(f.selected), null); assert.equal(f.generated.length, 0);
});

test('native grant revocation during the final pause-marker await invalidates route authorization', { timeout: 120000 }, async t => {
  const f = await fixture(t), route = await f.resolveModel(f.selected); assert.ok(route);
  const original = fs.lstat, marker = path.join(f.selected.root, 'chain', 'PAUSED');
  let markers = 0, revoked = false;
  t.after(() => { fs.lstat = original; });
  fs.lstat = async function (file, ...args) {
    if (file === marker && ++markers === 2) {
      fs.lstat = original;
      const changed = await f.call('/api/openclaw/native-capabilities', { ...nativeGrant, enabled: false });
      assert.equal(changed.status, 200); revoked = true;
    }
    return original.call(fs, file, ...args);
  };
  let outcome;
  try { outcome = await route.authorize().then(() => ({ authorized: true }), error => ({ authorized: false, code: error.code })); }
  finally { fs.lstat = original; }
  assert.equal(revoked, true); assert.equal(f.generated.length, 0);
  assert.equal(outcome.authorized, false, 'The final awaited pause check cannot return a stale grant authorization.');
  assert.equal(outcome.code, 'SESSION_CHANGED');
});

test('a BYOK transport route requires a live owner model call and disappears after session end', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const selected = await f.connectByok();
  assert.equal(selected.status, 200); assert.equal(await f.resolveModel(f.selected), null);
  await f.enableSyntheticGeneration();
  const response = await f.call('/api/chat', { message: 'Please introduce yourself.' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(f.generated.length > 0);
  const route = await f.resolveModel(f.selected); assert.ok(route); await route.authorize();
  assert.equal(route.config.tier, 'byok'); assert.equal(route.config.model, 'fixture/byok');
  assert.equal(route.config.apiKey, privateKey);
  assert.equal((await f.unpair()).status, 200);
  assert.equal(await f.resolveModel(f.selected), null);
  await assert.rejects(route.authorize(), error => ['SESSION_CHANGED', 'PAIR_REQUIRED', 'CANCELLED'].includes(error.code));
});

for (const route of ['byok-connect', 'byok-restore', 'disconnect']) {
  test(`explicit ${route} selection retires persistent native fallback and cancels admitted work for only that agent`, { timeout: 120000 }, async t => {
    const f = await fixture(t);
    if (route === 'byok-restore') {
      assert.equal((await f.connectByok()).status, 200);
      assert.equal((await f.selectNative()).status, 200);
    }
    const active = await f.resolve(f.selected, 'before-' + route);
    assert.ok(active, 'The explicit native choice admits the owned background fixture before switching.');
    await active.context.authorize(); assert.equal(active.context.signal.aborted, false);
    const switched = route === 'byok-connect' ? await f.connectByok() :
      route === 'byok-restore' ? await f.call('/api/model', { tier: 'byok' }) :
      await f.call('/api/provider', { disconnect: true });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.provider.tier, 'byok');
    assert.equal(active.context.signal.aborted, true, 'A new foreground route must immediately cancel prior native descendants.');
    await assert.rejects(active.context.authorize()); active.release();
    await f.assertNoFallback('after-' + route);
    assert.equal((await f.unpair()).status, 200);
    await f.assertNoFallback('after-session-close-' + route);
    await f.finish();
  });
}
