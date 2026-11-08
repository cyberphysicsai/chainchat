import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NativeMediaStore } from '../lib/native-media-store.mjs';
import { createNativeMedia, validateNativeMediaRequest, registerNativeMedia, NATIVE_MEDIA_METHOD } from '../openclaw/plugin/native-media.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-media-'))), root = path.join(directory, 'owned');
  t.after(async () => { assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const store = new NativeMediaStore(root), metadata = await store.put({ mimeType: 'image/png', fileName: '画像.png', content: png.toString('base64') });
  const requests = [];
  const media = createNativeMedia({ mediaRoot: root, getConfig: () => ({ tools: { media: { image: { enabled: true } } } }),
    sdk: { describeImageFile: async params => { requests.push(params); await options.effect?.({ params, root, metadata }); return options.result || { text: 'The image appears to contain a light pixel.', provider: 'configured-native', model: 'vision-default', hiddenReasoning: 'not returned' }; } } });
  const request = { sessionKey: 'agent:main:chainchat-control:' + 'a'.repeat(64), assetId: metadata.id, operation: 'describe-image' };
  return { root, store, metadata, requests, media, request };
}
test('verified immutable asset snapshot is analysed through fixed native SDK defaults and qualified provenance', async t => {
  const f = await fixture(t, { effect: async ({ params, root, metadata }) => {
    assert.ok(params.filePath.startsWith(root + path.sep + '.analysis-'));
    assert.notEqual(params.filePath, path.join(root, metadata.id, metadata.contentFile));
    assert.equal(sha(await fs.readFile(params.filePath)), metadata.id);
    assert.equal(params.agentId, 'main'); assert.equal(params.mime, 'image/png');
    assert.equal('model' in params, false); assert.equal('provider' in params, false); assert.equal('mediaUrl' in params, false);
    assert.equal(JSON.stringify(params).includes('画像.png'), false);
  } });
  const original = await f.store.read(f.metadata.id), result = await f.media(f.request);
  assert.equal(result.modelDerived, true); assert.equal(result.sha256, f.metadata.id);
  assert.match(result.text, /^MODEL-DERIVED MEDIA OBSERVATION/u); assert.match(result.text, /not independently verified facts/u);
  assert.equal(result.textSha256, sha(Buffer.from(result.text))); assert.equal('hiddenReasoning' in result, false);
  assert.equal(f.requests.length, 1); assert.deepEqual((await f.store.read(f.metadata.id)).bytes, original.bytes);
  assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.analysis-')), false);
});
test('request paths, URLs, model/auth overrides, unsupported PDF operations and wrong kinds are refused', async t => {
  const f = await fixture(t);
  for (const changed of [{ filePath: '/private' }, { mediaUrl: 'https://untrusted.example' }, { model: 'other' }, { agentId: 'other' }, { apiKey: 'secret' },
    { assetId: '../private' }, { assetId: f.metadata.id + '\n' }, { operation: 'extract-pdf' }, { sessionKey: 'https://untrusted.example' }])
    await assert.rejects(f.media({ ...f.request, ...changed }), { code: 'NATIVE_MEDIA_INVALID' });
  await assert.rejects(f.media({ ...f.request, operation: 'transcribe-audio' }), { code: 'NATIVE_MEDIA_UNAVAILABLE' });
  assert.equal(f.requests.length, 0);
  assert.deepEqual(validateNativeMediaRequest(f.request), f.request);
});
test('content hash, metadata schema, symlinks and hardlinks are checked before SDK file access', async t => {
  for (const variant of ['content', 'metadata', 'hardlink']) await t.test(variant, async t => {
    const f = await fixture(t), file = path.join(f.root, f.metadata.id, f.metadata.contentFile);
    if (variant === 'content') await fs.appendFile(file, 'tampered');
    if (variant === 'metadata') await fs.writeFile(path.join(f.root, f.metadata.id, 'metadata.json'), JSON.stringify({ ...f.metadata, contentFile: '../private.png' }), { mode: 0o600 });
    if (variant === 'hardlink') await fs.link(file, path.join(f.root, 'unadmitted-link'));
    await assert.rejects(f.media(f.request), error => ['NATIVE_MEDIA_INVALID', 'NATIVE_MEDIA_CHANGED'].includes(error.code));
    assert.equal(f.requests.length, 0);
  });
});
test('an asset or analysis snapshot changed during SDK processing cannot produce an observation', async t => {
  for (const target of ['original', 'snapshot']) await t.test(target, async t => {
    const f = await fixture(t, { effect: async ({ params, root, metadata }) => fs.appendFile(target === 'snapshot' ? params.filePath : path.join(root, metadata.id, metadata.contentFile), 'tampered') });
    await assert.rejects(f.media(f.request), error => ['NATIVE_MEDIA_INVALID', 'NATIVE_MEDIA_CHANGED'].includes(error.code));
    assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.analysis-')), false);
  });
});
test('cancellation, absent provider output and raw SDK errors remain held and do not expose source paths', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.media(f.request, { signal: controller.signal }), { code: 'CANCELLED' }); assert.equal(f.requests.length, 0);
  const failed = await fixture(t, { effect: async () => { throw new Error('secret provider credential and private source path'); } });
  await assert.rejects(failed.media(failed.request), error => error.code === 'NATIVE_MEDIA_FAILED' && !error.message.includes('secret'));
  const absent = await fixture(t, { result: { decision: { outcome: 'disabled' } } });
  await assert.rejects(absent.media(absent.request), { code: 'NATIVE_MEDIA_UNAVAILABLE' });
});
test('native media RPC requires existing-session profile participation and current private owner', async () => {
  let registered;
  registerNativeMedia({ pluginConfig: {}, runtime: {}, registerGatewayMethod: (name, handler, policy) => { registered = { name, handler, policy }; } });
  assert.equal(registered.name, NATIVE_MEDIA_METHOD);
  assert.deepEqual(registered.policy, { scope: 'operator.write', profileAccess: 'required', sessionAccess: { mode: 'write' } });
  const responses = [];
  await registered.handler({ params: { sessionKey: 'agent:main:test', assetId: 'a'.repeat(64), operation: 'describe-image' }, respond: (...args) => responses.push(args), hasCurrentClientAuthority: () => false });
  assert.equal(responses[0][0], false); assert.equal(JSON.stringify(responses).includes('filePath'), false);
});
