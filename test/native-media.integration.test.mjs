/** Real upstream media SDK/auth against a disposable local vision provider. */
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
import { engine } from '../lib/engine.mjs';
const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');

test('actual native image SDK uses the configured local vision profile and immutable owned bytes', {
  skip: !packageRoot || !nodePath ? 'Set the pinned native runtime for media SDK acceptance.' : false, timeout: 300000,
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-media-sdk-')));
  const root = path.join(directory, 'agent'), calls = [], diagnostics = [];
  const mediaStore = new NativeMediaStore(path.join(directory, 'media'));
  const metadata = await mediaStore.put({ mimeType: 'image/png', fileName: '画像.png', content: png.toString('base64') });
  let manager, broker;
  const provider = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); calls.push({ body, authorization: request.headers.authorization });
    const content = 'The image appears to contain a single light pixel; that is a model interpretation.';
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'native-media-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'native-media-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'native-media-fixture', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => {
    await manager?.close(); await broker?.close();
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });
  await engine({ op: 'init', root, registryRoot: root, name: 'Native media SDK fixture' });
  const initial = await engine({ op: 'inspect', root, learning: false });
  const identity = { agentId: 'native-media-fixture', genesisHash: initial.genesis.hash };
  broker = createPoIBroker({ engine, review: async () => { throw new Error('Direct media SDK must not invoke an autonomous review agent.'); } });
  await broker.start();
  manager = createOpenClawGateway({ stateDir: path.join(directory, 'gateway'), packageRoot, nodePath, broker,
    mediaDirectory: mediaStore.root, pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)),
    nativeCapabilities: () => ({ enabled: true, acknowledged: true, tools: [], settings: ['tools.media'], delegatedRuns: false, backgroundRuns: false }),
    onDiagnostic: line => diagnostics.push(line) });
  try {
    await manager.configureNativeProvider({ identity, provider: 'fixture-vision', configuration: {
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', authHeader: true,
      models: [{ id: 'vision', name: 'Disposable native image model', reasoning: false, input: ['text', 'image'], contextWindow: 131072,
        maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } });
    await manager.nativeAuth({ identity, action: 'key', provider: 'fixture-vision', apiKey: 'synthetic-native-image-key' });
    await manager.setNativeModel(identity, 'fixture-vision/vision');
    const controls = await manager.describeControls(identity);
    await manager.updateControls({ revision: controls.config.revision, baseHash: controls.config.baseHash, patch: { tools: { media: {
      models: [{ provider: 'fixture-vision', model: 'vision', capabilities: ['image'] }], image: { enabled: true },
    } } } });
    const result = await manager.analyzeNativeMedia({ identity, assetId: metadata.id, operation: 'describe-image' });
    assert.equal(result.assetId, metadata.id); assert.equal(result.sha256, metadata.id);
    assert.equal(result.source, 'native-media-sdk'); assert.equal(result.modelDerived, true);
    assert.match(result.text, /^MODEL-DERIVED MEDIA OBSERVATION/u); assert.match(result.text, /not independently verified facts/u);
    assert.match(result.text, /single light pixel/u); assert.equal(result.provider, 'fixture-vision'); assert.equal(result.model, 'vision');
    assert.equal(calls.length, 1, 'One upstream native media SDK call, no agent recursion or retries.');
    assert.equal(calls[0].authorization, 'Bearer synthetic-native-image-key'); assert.equal(calls[0].body.model, 'vision');
    assert.equal(calls[0].body.tools?.length || 0, 0);
    const images = calls[0].body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url');
    assert.equal(images.length, 1); assert.match(images[0].image_url.url, /^data:image\/(?:png|jpeg);base64,/u);
    assert.equal(JSON.stringify(result).includes('synthetic-native-image-key'), false);
    assert.equal(JSON.stringify(result).includes(directory), false);
    assert.deepEqual((await mediaStore.read(metadata.id)).bytes, png);
    assert.equal((await fs.readdir(mediaStore.root)).some(name => name.startsWith('.analysis-')), false);
    for (const changed of [{ assetId: 'f'.repeat(64) }, { operation: 'extract-pdf' },
      { identity: { ...identity, genesisHash: 'f'.repeat(64) } }]) await assert.rejects(manager.analyzeNativeMedia({ identity,
      assetId: metadata.id, operation: 'describe-image', ...changed }));
    assert.equal(calls.length, 1, 'Unknown assets, unsupported operations and foreign identities cannot cause inference.');
    assert.deepEqual((await engine({ op: 'inspect', root, learning: false })).head, initial.head);
  } catch (error) {
    t.diagnostic(`Native media SDK acceptance held with ${/^[A-Z_]+$/u.test(error?.code || '') ? error.code : 'UNKNOWN'}.`);
    t.diagnostic(diagnostics.join('').slice(-5000)); throw error;
  }
});
