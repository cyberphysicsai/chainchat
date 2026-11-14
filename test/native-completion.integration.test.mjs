/** Actual OpenClaw SDK/auth/preparation against a disposable HTTP provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createOpenClawGateway } from '../openclaw/gateway.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { reviewWithCompletion, FRUITS, DIMENSIONS } from '../lib/providers.mjs';
import { strictReview } from '../server.mjs';
const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;

test('actual native SDK uses configured main model and native auth, with zero tools and no agent/context recursion', {
  skip: !packageRoot || !nodePath ? 'Set the pinned latest native runtime for SDK acceptance.' : false, timeout: 300000,
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-sdk-')));
  const root = path.join(directory, 'agent'), calls = [], diagnostics = [];
  let manager, broker, reviews = 0;
  const answer = 'Hello! I can help you think carefully, patiently and honestly, while acknowledging uncertainty.';
  const assessment = { decision: 'approve', fixture: 'actual-native-sdk', usedRings: [],
    scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])), fruits: Object.fromEntries(FRUITS.map(key => [key, 240])),
    rationale: 'An honest and patient introduction, with no unsupported outside fact.' };
  const provider = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); calls.push({ body, authorization: request.headers.authorization });
    const candidate = JSON.stringify(body).includes('CHAINCHAT HOST CONTRACT');
    const content = candidate ? answer : JSON.stringify(assessment);
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'native-sdk-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'native-sdk-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 23, completion_tokens: 15, total_tokens: 38 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'native-sdk-fixture', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 23, completion_tokens: 15, total_tokens: 38 } }));
    }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => {
    await manager?.close(); await broker?.close();
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  await engine({ op: 'init', root, registryRoot: root, name: 'Native SDK fixture' });
  const initial = await engine({ op: 'inspect', root, learning: false });
  const identity = { agentId: 'native-sdk-fixture', genesisHash: initial.genesis.hash };
  broker = createPoIBroker({ engine, review: async (config, args) => {
    reviews++;
    return strictReview(await reviewWithCompletion(config, args, (_config, request) => manager.completeNative({ identity,
      system: request.system, messages: request.messages, maxTokens: request.maxTokens, purpose: 'review', signal: request.signal })), args.availableEvidence || [], args.reviewPurpose || 'action');
  } });
  await broker.start();
  manager = createOpenClawGateway({ stateDir: path.join(directory, 'gateway'), packageRoot, nodePath, broker,
    nativeCapabilities:()=>({enabled:true,acknowledged:true,tools:[],settings:['agents.defaults.utilityModel'],delegatedRuns:false,backgroundRuns:false}),
    pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), onDiagnostic: line => diagnostics.push(line) });
  try {
    await manager.configureNativeProvider({ identity, provider: 'fixture-native', configuration: {
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', authHeader: true,
      models: [{ id: 'fixture', name: 'Disposable native SDK model', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } });
    const authorization = await manager.nativeAuth({ identity, action: 'key', provider: 'fixture-native', apiKey: 'synthetic-native-sdk-key' });
    assert.equal(JSON.stringify(authorization).includes('synthetic-native-sdk-key'), false);
    t.diagnostic(JSON.stringify({ nativeFixtureModel: (await manager.nativeModels(identity)).models.filter(model => model.id.startsWith('fixture-native/')) }));
    const selected = await manager.setNativeModel(identity, 'fixture-native/fixture');
    const actualConfiguration=JSON.parse(await fs.readFile(path.join(directory,'gateway','gateway.json'),'utf8'));
    assert.equal(actualConfiguration.agents.defaults.utilityModel,'','A saved native model must not enable automatic paid utility selection.');
    assert.equal(actualConfiguration.memory.search.enabled,false,'Remote native embeddings require a separate explicit owner opt-in.');
    const nativeConfig = { provider: 'native', tier: 'native', model: 'fixture-native/fixture',
      reasoningCapable: selected.reasoningCapable === true, contextWindow: selected.contextWindow || 131072, maxOutputTokens: 4096 };
    const args = { identity, system: 'Return exactly one JSON object for this internal review.',
      messages: [{ role: 'user', content: 'Return {"decision":"approve","fixture":"actual-native-sdk"}.' }], maxTokens: 512, purpose: 'review' };
    const result = await manager.completeNative(args);
    assert.equal(result.provider, 'fixture-native'); assert.equal(result.model, 'fixture'); assert.equal(result.agentId, 'main');
    assert.equal(result.reviewerSelection, 'owner-configured-main-default');
    assert.equal(JSON.parse(result.text).fixture, 'actual-native-sdk');
    assert.equal(calls.length, 1); assert.equal(reviews, 0);
    assert.equal(calls[0].authorization, 'Bearer synthetic-native-sdk-key');
    assert.equal(calls[0].body.model, 'fixture'); assert.equal(calls[0].body.tools?.length || 0, 0);
    assert.ok(JSON.stringify(calls[0].body).includes(args.system));
    assert.equal(JSON.stringify(calls[0].body).includes('CHAINCHAT HOST CONTRACT'), false, 'Purpose-bound review does not recursively run a full agent.');
    assert.equal(JSON.stringify(result).includes('synthetic-native-sdk-key'), false);
    for (const changed of [{ purpose: 'chat' }, { maxTokens: 32769 }, { messages: [{ role: 'tool', content: 'execute an action' }] },
      { identity: { ...identity, genesisHash: 'f'.repeat(64) } }]) await assert.rejects(manager.completeNative({ ...args, ...changed }));
    assert.equal(calls.length, 1, 'Invalid or foreign native requests fail before inference.');
    const generated = await manager.generateNative(nativeConfig, { messages: [{ role: 'user', content: 'Please introduce yourself.' }], maxTokens: 512 }, {
      purpose: 'candidate', root, input: 'Please introduce yourself.', loadout: [], settings: { recall: false }, nativeIdentity: identity,
      modelCapabilities: { reasoning: false, contextWindow: 131072, maxOutputTokens: 4096 }, authorize: async () => {} });
    assert.equal(generated.text, answer); assert.equal(generated.enforcement.reviewed, true);
    assert.equal(reviews, 1, 'One native candidate is independently reviewed through the real SDK and strict parser.');
    assert.equal(calls.length, 3, 'A native candidate and its direct SDK review are distinct real provider calls.');
    assert.ok(calls.some(call => JSON.stringify(call.body).includes('CHAINCHAT HOST CONTRACT')));
    assert.ok(calls.some(call => JSON.stringify(call.body).includes('independent pre-release covenant reviewer')));
    assert.ok(calls.every(call => call.authorization === 'Bearer synthetic-native-sdk-key'));
    assert.deepEqual((await engine({ op: 'inspect', root, learning: false })).head, initial.head);
    const controls=await manager.describeControls(identity);
    await manager.updateControls({revision:controls.config.revision,baseHash:controls.config.baseHash,patch:{agents:{defaults:{utilityModel:'fixture-native/fixture'}}}});
    const optedIn=JSON.parse(await fs.readFile(path.join(directory,'gateway','gateway.json'),'utf8'));
    assert.equal(optedIn.agents.defaults.utilityModel,'fixture-native/fixture','Only an explicit owner settings change enables native utility inference.');
    assert.equal(JSON.stringify(optedIn).includes('synthetic-native-sdk-key'),false);
  } catch (error) {
    t.diagnostic(`Native SDK acceptance failed with code ${/^[A-Z_]+$/u.test(error?.code || '') ? error.code : 'UNKNOWN'}.`);
    // These are fixture-owned logs; private transport tokens are scrubbed by
    // the Gateway. Never print request headers or the native auth store.
    t.diagnostic(diagnostics.join('').slice(-5000)); throw error;
  }
});
