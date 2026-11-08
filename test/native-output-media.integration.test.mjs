/** Actual native TTS, local synthetic speech provider and reviewed output custody. */
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
import { NativeMediaStore } from '../lib/native-media-store.mjs';
import { createNativeOutputMedia } from '../lib/native-output-media.mjs';
import { engine } from '../lib/engine.mjs';
import { DIMENSIONS, FRUITS } from '../lib/providers.mjs';
import { currentCanonicalSkill } from '../lib/canonical-skill.mjs';
const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
function wav() {
  const bytes = Buffer.alloc(844); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}
test('actual admitted native TTS output is copied into owned assets and reviewed before release', {
  skip: !packageRoot || !nodePath ? 'Set the pinned native runtime for generated media acceptance.' : false, timeout: 360000,
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-output-sdk-')));
  const root = path.join(directory, 'agent'), gatewayRoot = path.join(directory, 'gateway'), diagnostics = [], requests = [], reviews = [];
  const mediaStore = new NativeMediaStore(path.join(directory, 'owned'));
  const canonicalSkill = (await currentCanonicalSkill()).skill;
  const custody = createNativeOutputMedia({ nativeStateDirectory: path.join(gatewayRoot, 'native-state'), mediaStore });
  const audio = wav(), answer = 'I can help with care, patience and honesty.';
  let manager, broker, requestedTool = false, speechCalls = 0, finalCandidate, phase = 'configure', recapCalls = 0;
  const provider = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push({ url: request.url, body, phase, authorization: request.headers.authorization });
    if (request.url === '/v1/audio/speech') {
      speechCalls++; assert.equal(body.input, answer); assert.equal(body.response_format, 'wav');
      response.writeHead(200, { 'content-type': 'audio/wav' }); response.end(audio); return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    if (phase !== 'generate') {
      assert.equal(body.tools?.length || 0, 0, 'Native onboarding probes cannot acquire agent tools.');
      t.diagnostic(JSON.stringify({ nativeOnboardingProbe: phase, messageRoles: body.messages?.map(message => message.role), textLength: JSON.stringify(body.messages || []).length }));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'native-setup-probe',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })); return;
    }
    const context = body.messages.map(message =>
      typeof message.content === 'string' ? message.content : (message.content || []).map(part => part.text || '').join('\n')).join('\n');
    // Pinned server-runtime-subscriptions emits this bounded utility independently
    // of the autonomous agent loop. It must not consume the fixture's tool plan.
    if (context.startsWith('Write an Activity recap for someone scanning their tasks: what was done here, and where it stands now.')) {
      assert.equal(body.tools?.length || 0, 0); recapCalls++;
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'native-activity-recap',
        choices: [{ index: 0, message: { role: 'assistant', content: 'A local speech task is being prepared.' }, finish_reason: 'stop' }] })); return;
    }
    const policyCount = context.split(canonicalSkill).length - 1;
    if (policyCount !== 1) t.diagnostic(JSON.stringify({ nativePolicyDiagnostic: true, roles: body.messages.map(message => message.role),
      contextLength: context.length, hasHostContract: context.includes('CHAINCHAT HOST CONTRACT'), canonicalOccurrences: policyCount,
      firstText: context.slice(0, 250), lastText: context.slice(-300) }));
    assert.equal(policyCount, 1, 'Each actual native model iteration wears the exact canonical skill once.');
    const issueTool = !requestedTool; requestedTool = true;
    const names = new Set((body.tools || []).map(tool => tool.function?.name || tool.name));
    const deferred = !names.has('tts') && names.has('tool_call');
    if (!issueTool) {
      const home = path.join(gatewayRoot, 'native-state', 'media', 'tool-speech-synthesis');
      const files = (await fs.readdir(home)).filter(file => file.endsWith('.wav'));
      if (files.length !== 1) t.diagnostic(JSON.stringify({ nativeTtsToolOutcome: body.messages.filter(message => message.role === 'tool')
        .map(message => String(message.content || '').slice(0, 1800).replaceAll('sk-synthetic-native-output-key', '[SYNTHETIC KEY]')), matchingFiles: files.length }));
      finalCandidate = files.length === 1 ? answer + '\nMEDIA:' + path.join(home, files[0]) : answer;
    }
    const delta = issueTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'native_speech_fixture', type: 'function', function: {
      name: deferred ? 'tool_call' : 'tts', arguments: JSON.stringify(deferred ? { id: 'tts', args: { text: answer } } : { text: answer }),
    } }] } : { role: 'assistant', content: finalCandidate };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'native-output-fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'native-output-fixture', choices: [{ index: 0, delta: {}, finish_reason: issueTool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => {
    await manager?.close(); await broker?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  await engine({ op: 'init', root, registryRoot: root, name: 'Native output fixture' });
  const initial = await engine({ op: 'inspect', root, learning: false }), identity = { agentId: 'native-output-fixture', genesisHash: initial.genesis.hash };
  const scores = Object.fromEntries(DIMENSIONS.map(key => [key, 240])), fruitages = Object.fromEntries(FRUITS.map(key => [key, 240]));
  broker = createPoIBroker({ engine, nativeOutputMedia: custody,
    outputAssetMetadata: async (captured, { assertCurrent }) => Promise.all(captured.assets.map(async asset => { await assertCurrent(); return (await mediaStore.read(asset.assetId)).metadata; })),
    review: async (_config, args) => { reviews.push(args); return { approved: true, scores, fruitages, usedRings: [], rationale: 'The synthetic fixture requests harmless speech and an honest, caring response.' }; } });
  await broker.start();
  const nativeCapabilities = { enabled: true, acknowledged: true, tools: ['tts'], settings: ['tts'], delegatedRuns: false, backgroundRuns: false };
  manager = createOpenClawGateway({ stateDir: gatewayRoot, packageRoot, nodePath, broker, mediaDirectory: mediaStore.root,
    nativeCapabilities: () => nativeCapabilities, pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), onDiagnostic: line => diagnostics.push(line) });
  try {
    const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
    await manager.configureNativeProvider({ identity, provider: 'openai', configuration: { baseUrl, api: 'openai-completions', authHeader: true,
      models: [{ id: 'fixture', name: 'Disposable speech fixture model', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } });
    phase = 'auth'; await manager.nativeAuth({ identity, action: 'key', provider: 'openai', apiKey: 'sk-synthetic-native-output-key' });
    phase = 'models';
    await manager.setNativeModel(identity, 'openai/fixture');
    const controls = await manager.describeControls(identity);
    phase = 'settings'; await manager.updateControls({ revision: controls.config.revision, patch: { tts: { auto: 'off', provider: 'openai', persona: 'fixture',
      personas: { fixture: { provider: 'openai', fallbackPolicy: 'fail', providers: { openai: { baseUrl, model: 'tts-1', speakerVoice: 'alloy', responseFormat: 'wav' } } } } } } });
    await manager.nativeSecrets({ identity, action: 'set', name: 'speech', target: 'tts.providers.openai.apiKey', value: 'sk-synthetic-native-output-key' });
    assert.equal(JSON.stringify(await manager.nativeSecrets({ identity, action: 'list' })).includes('sk-synthetic-native-output-key'), false);
    const input = 'Use the explicitly admitted native speech tool to speak a caring greeting, then provide the same greeting.';
    phase = 'generate';
    const generated = await manager.generateNative({ provider: 'native', tier: 'native', model: 'openai/fixture', contextWindow: 131072, maxOutputTokens: 4096 }, {
      messages: [{ role: 'user', content: input }], maxTokens: 512,
    }, { root, input, purpose: 'candidate', learning: false, loadout: [], nativeIdentity: identity, nativeTools: ['tts'], authorize: async () => {},
      toolAuthority: { enabled: true, acknowledged: true, tools: [], roots: [], networkHosts: [], allowExecution: false, nativeCapabilities },
      modelCapabilities: { reasoning: false, contextWindow: 131072, maxOutputTokens: 4096 } });
    assert.equal(generated.text, answer); assert.equal(generated.enforcement.reviewed, true); assert.equal(speechCalls, 1);
    const assets = generated.enforcement.outputAssets; assert.equal(assets?.length, 1);
    assert.equal(assets[0].mimeType, 'audio/wav'); assert.deepEqual((await mediaStore.read(assets[0].id)).bytes, audio);
    assert.equal(generated.enforcement.generatedMedia[0].toolName, 'tts');
    assert.ok(reviews.some(review => review.candidate.includes('proposed-host-tool-action')));
    assert.ok(reviews.some(review => review.toolObservations?.some(observation => JSON.stringify(observation).includes('native-generated'))));
    assert.equal(JSON.stringify(generated.enforcement).includes(gatewayRoot), false); assert.equal(JSON.stringify(generated).includes('sk-synthetic-native-output-key'), false);
    assert.ok(requests.every(request => request.authorization === 'Bearer sk-synthetic-native-output-key'));
    const committed = await engine({ op: 'commit', root, expectedHead: generated.enforcement.expectedHead, loadout: [], learning: false, growth: false,
      exchanges: [{ input, output: generated.text, scores, assessment: { approved: true, fruitages, rationale: 'Harmless speech and an honest caring greeting.' }, usedRings: [], loadout: [], outputAssets: assets,
        toolObservations: generated.enforcement.toolObservations }] }, { mediaDirectory: mediaStore.root });
    assert.equal(committed.sealed, true);
    const recovered = await engine({ op: 'read_source_asset', root, assetId: assets[0].id }); assert.equal(recovered.direction, 'output');
    assert.deepEqual(Buffer.from(recovered.content, 'base64'), audio);
  } catch (error) {
    t.diagnostic(JSON.stringify({ code: error?.code || 'ASSERTION', speechCalls, recapCalls, requests: requests.map(request => request.url), reviewCount: reviews.length }));
    t.diagnostic(diagnostics.join('').slice(-5000)); throw error;
  }
});
