import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';
import { engine } from '../lib/engine.mjs';

async function tree(root) {
  const files = {};
  async function walk(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else files[path.relative(root, file)] = (await fs.readFile(file)).toString('hex');
    }
  }
  await walk(root); return files;
}
test('every visible answer wears canonical skill and passes PoI, including paused memory and model changes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-always-poi-'));
  let lowFruit = false, memoryPaused = false;
  const generation = [], reviews = [], native = [];
  const app = await createApp({ dataDir: directory, canonicalUpdates: false, pairingCode: 'ALWAYS-POI',
    engine: request => { native.push(structuredClone(request)); return engine(request); },
    generate: async (config, args) => { generation.push({ model: config.model, args }); return { text: memoryPaused ?
      'My host applies my equipped faculties and independently reviews my answers before release. Memory is paused, so I will not claim to have stored this exchange.' :
      'Hello! I can help you reason carefully and acknowledge uncertainty.' }; },
    review: async (_config, args) => {
      reviews.push(args);
      if (memoryPaused) {
        assert.ok(args.hostProcessContext, 'Actual paused faculty processing and review must reach the independent reviewer.');
        assert.deepEqual(args.hostProcessContext.toolScope, { external: [], ownSession: [] });
        assert.deepEqual(args.hostProcessContext.releaseReview, { semantic: true, native: true });
        assert.ok(args.hostProcessContext.faculties.some(faculty => faculty.status === 'completed'));
      }
      return { decision: 'approve', approved: true, usedRings: [], scores: Object.fromEntries(DIMENSIONS.map(key => [key, 235])),
        fruits: Object.fromEntries(FRUITS.map(key => [key, lowFruit && key === 'kindness' ? 149 : 240])), rationale: 'A patient and honest introduction.' };
    } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => {
    await app.closeRuntime(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`; let token;
  const call = async (endpoint, payload) => {
    const response = await fetch(base + endpoint, { method: payload === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, body: await response.json() };
  };
  token = (await call('/api/pair', { code: 'ALWAYS-POI' })).body.token;
  assert.equal((await call('/api/agents', { name: 'Cypher Tempre' })).status, 201);
  assert.equal((await call('/api/provider', { provider: 'openai', model: 'first-model', apiKey: 'fixture-private-key' })).status, 200);
  assert.equal((await call('/api/cognition', { revisionLimit: 0 })).status, 200);
  const active = await call('/api/chat', { message: 'Please introduce yourself.', plain: true });
  assert.equal(active.status, 200, JSON.stringify(active.body));
  assert.equal(active.body.message.gate.approved, true); assert.equal(active.body.message.ring.index, 1);
  const activeGeneration = generation.find(item => item.args.system.includes('CHAINCHAT MANDATORY HOST POLICY'));
  assert.ok(activeGeneration);
  assert.match(activeGeneration.args.system, /^---\r?\nname: proof-of-interaction/u);
  assert.equal([...activeGeneration.args.system.matchAll(/^name: proof-of-interaction\r?$/gmu)].length, 1);
  assert.equal(activeGeneration.args.system.includes('fixture-private-key'), false);
  assert.equal((await call('/api/cognition', { mode: 'dormant', confirm: true })).status, 200);
  memoryPaused = true;
  const root = app.store.agents[0].root, before = await tree(root);
  for (const model of ['first-model', 'second-model']) {
    assert.equal((await call('/api/provider', { provider: 'openai', model, apiKey: 'fixture-private-key' })).status, 200);
    const start = native.length, reviewed = reviews.length;
    const paused = await call('/api/chat', { message: 'Please introduce yourself.', plain: true });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.message.memoryPaused, true); assert.equal(paused.body.message.raw, false);
    assert.equal(paused.body.message.gate.approved, true); assert.equal(paused.body.state.gate.required, true);
    assert.equal(paused.body.message.ring, null); assert.equal(paused.body.message.pending, false);
    assert.equal(paused.body.state.memoryPaused, true); assert.equal(paused.body.state.canonicalSkill.channel, 'main');
    assert.ok(reviews.length > reviewed);
    assert.ok(native.slice(start).some(request => request.op === 'chat_prepare'));
    assert.ok(native.slice(start).some(request => request.op === 'chat_evaluate'));
    assert.equal(native.slice(start).some(request => ['commit', 'teach', 'teach_response', 'feedback', 'route', 'memory', 'search'].includes(request.op)), false);
    assert.ok(generation.at(-1).args.system.includes('name: proof-of-interaction'));
    assert.deepEqual(await tree(root), before);
  }
  lowFruit = true;
  const held = await call('/api/chat', { message: 'Please introduce yourself.' });
  assert.equal(held.status, 422); assert.equal(held.body.code, 'COVENANT_REJECTED');
  assert.equal(held.body.message, undefined); assert.deepEqual(await tree(root), before);
  lowFruit = false;
  const beforeResume = (await engine({ op: 'verify', root })).head.index;
  assert.equal((await call('/api/cognition', { mode: 'active', confirm: true })).status, 200);
  memoryPaused = false;
  const resumed = await call('/api/chat', { message: 'Please introduce yourself again.' });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.message.ring.index, beforeResume + 1); assert.equal(resumed.body.state.gate.required, true);
});
