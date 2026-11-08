import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeMediaStore } from '../lib/native-media-store.mjs';
import { createNativeOutputMedia } from '../lib/native-output-media.mjs';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
const binding = { sessionKey: 'agent:main:chainchat-test', runId: 'native-run', callId: 'native-call', toolName: 'image_generate' };
async function fixture(t, { toolName = 'image_generate', clock = Date.now, storeEffect, verifyCompletion } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-output-')));
  t.after(async () => { assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const native = path.join(root, 'native-state'); await fs.mkdir(native, { mode: 0o700 });
  const store = new NativeMediaStore(path.join(root, 'owned')), mediaStore = storeEffect ? { put: async input => { await storeEffect(); return store.put(input); }, read: store.read.bind(store) } : store;
  const custody = createNativeOutputMedia({ nativeStateDirectory: native, mediaStore, now: clock, verifyCompletion }), bound = { ...binding, toolName };
  const home = path.join(native, 'media', { tts: 'tool-speech-synthesis', image_generate: 'tool-image-generation', video_generate: 'tool-video-generation', music_generate: 'tool-music-generation' }[toolName]);
  const ticket = await custody.begin(bound), file = path.join(home, toolName === 'tts' ? 'voice---fixture.mp3' : 'image---fixture.png');
  const bytes = toolName === 'tts' ? Buffer.from('ID3synthetic-native-speech') : image;
  const result = () => toolName === 'tts' ? { details: { audioPath: file, media: { mediaUrl: file, trustedLocalMedia: true } } } :
    { details: { attachments: [{ type: 'image', path: file, mimeType: 'image/png', sizeBytes: image.length }], provider: 'fixture' } };
  const capture = (extra = {}, options) => custody.capture({ ticket, ...bound, result: result(), success: true, ...extra }, options);
  return { root, native, home, file, bytes, store, custody, ticket, bound, result, capture };
}

test('only a new synchronous native file becomes an immutable asset and private exact delivery mapping', async t => {
  for (const toolName of ['image_generate', 'tts']) await t.test(toolName, async t => {
    const f = await fixture(t, { toolName }); await fs.writeFile(f.file, f.bytes);
    const captured = await f.capture(); assert.equal(captured.assets.length, 1); assert.equal(captured.deliveries.length, 1);
    const asset = captured.assets[0]; assert.equal(asset.source, 'native-generated'); assert.equal(asset.toolName, toolName); assert.equal(asset.callId, binding.callId);
    assert.equal(asset.sha256, asset.assetId); assert.equal(asset.bytes, f.bytes.length); assert.equal(JSON.stringify(captured.assets).includes(f.root), false);
    assert.equal(captured.deliveries[0].original, f.file); assert.equal(captured.deliveries[0].assetId, asset.assetId);
    const owned = await f.store.read(asset.assetId); assert.equal(captured.deliveries[0].ownedFile, owned.file); assert.deepEqual(owned.bytes, f.bytes);
    assert.equal(await f.custody.verifyDeliveries(captured), captured);
    await assert.rejects(f.custody.verifyDeliveries(structuredClone(captured)), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
    await fs.appendFile(owned.file, 'tampered');
    await assert.rejects(f.custody.verifyDeliveries(captured), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
    await assert.rejects(f.capture(), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  });
});
test('preexisting, recreated, arbitrary, nested and remote paths cannot become generated output', async t => {
  for (const variant of ['preexisting', 'recreated', 'outside', 'nested', 'url']) await t.test(variant, async t => {
    const f = await fixture(t); let file = f.file, ticket = f.ticket;
    if (['preexisting', 'recreated'].includes(variant)) {
      await fs.writeFile(file, image); ticket = await f.custody.begin(f.bound);
      if (variant === 'recreated') { await fs.unlink(file); await fs.writeFile(file, image); }
    } else if (variant === 'outside') { file = path.join(f.root, 'private.png'); await fs.writeFile(file, image); }
    else if (variant === 'nested') { await fs.mkdir(path.join(f.home, 'nested')); file = path.join(f.home, 'nested', 'image.png'); await fs.writeFile(file, image); }
    else file = 'https://untrusted.example/image.png';
    await assert.rejects(f.capture({ ticket, result: { details: { attachments: [{ type: 'image', path: file }] } } }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  });
});
test('hardlinks, changed bytes, invalid MIME and duplicate paths remain held', async t => {
  for (const variant of ['hardlink', 'mime', 'duplicate', 'invalid-bytes']) await t.test(variant, async t => {
    const f = await fixture(t); await fs.writeFile(f.file, variant === 'invalid-bytes' ? Buffer.from('not an image') : image);
    if (variant === 'hardlink') await fs.link(f.file, path.join(f.root, 'second-link'));
    const result = f.result();
    if (variant === 'mime') result.details.attachments[0].mimeType = 'image/jpeg';
    if (variant === 'duplicate') result.details.attachments.push(result.details.attachments[0]);
    await assert.rejects(f.capture({ result }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  });
});
test('capture verifies current private binding, freshness and authority and consumes async/failed tickets', async t => {
  let now = Date.now(); const f = await fixture(t, { clock: () => now }); await fs.writeFile(f.file, image);
  await assert.rejects(f.capture({ runId: 'another-run' }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  await assert.rejects(f.capture({ ticket: { id: f.ticket.id } }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  now += 300001; await assert.rejects(f.capture(), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  const pending = await fixture(t);
  assert.deepEqual(await pending.capture({ result: { details: { status: 'running', taskId: 'unbound-async' } } }), { assets: [], deliveries: [] });
  await fs.writeFile(pending.file, image); await assert.rejects(pending.capture(), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  const denied = await fixture(t); await fs.writeFile(denied.file, image);
  await assert.rejects(denied.capture({}, { assertCurrent: () => { throw new Error('revoked'); } }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  const failed = await fixture(t); await fs.writeFile(failed.file, image);
  await assert.rejects(failed.capture({ success: false }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  assert.equal(await f.custody.begin({ ...binding, toolName: 'unknown_media_generate' }), null);
});
test('files altered while entering owned storage never produce a delivery manifest', async t => {
  let file;
  const f = await fixture(t, { storeEffect: async () => fs.appendFile(file, 'tampered') }); file = f.file; await fs.writeFile(file, image);
  await assert.rejects(f.capture(), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
});

test('asynchronous session authorization is awaited before dispatch, custody and fresh delivery checks', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, image);
  await assert.rejects(f.custody.begin(f.bound, { assertCurrent: async () => { await Promise.resolve(); throw new Error('revoked before execution'); } }));
  await assert.rejects(f.capture({}, { assertCurrent: async () => { await Promise.resolve(); throw new Error('revoked before capture'); } }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  const valid = await fixture(t); await fs.writeFile(valid.file, image);
  const captured = await valid.capture();
  await assert.rejects(valid.custody.verifyDeliveries(captured, { assertCurrent: async () => { await Promise.resolve(); throw new Error('revoked before delivery'); } }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
});

test('only owner-verified stock media child directories can be tightened to private POSIX modes', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await fs.chmod(path.join(f.native, 'media'), 0o755); await fs.chmod(f.home, 0o755);
  await f.custody.begin({ ...f.bound, callId: 'next-call' });
  assert.equal((await fs.stat(path.join(f.native, 'media'))).mode & 0o077, 0);
  assert.equal((await fs.stat(f.home)).mode & 0o077, 0);
  await fs.chmod(f.native, 0o755);
  await assert.rejects(f.custody.begin(f.bound), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
});

const job = toolName => ({ taskId: 'tool:' + toolName + ':11111111-1111-4111-8111-111111111111', runId: 'tool:' + toolName + ':11111111-1111-4111-8111-111111111111', toolName, parentSessionKey: binding.sessionKey });
test('deferred image/video/music require opaque exact-reference completion proofs and retain original file inventory', async t => {
  for (const toolName of ['image_generate', 'video_generate', 'music_generate']) await t.test(toolName, async t => {
    let expectedReferences, verified = 0; const proof = Object.freeze({ token: 'private-only' });
    const f = await fixture(t, { toolName, verifyCompletion: async (actual, expected) => {
      verified++; assert.equal(actual, proof); assert.deepEqual(expected.references, expectedReferences);
      assert.equal(expected.originalRunId, binding.runId); assert.equal(expected.callId, binding.callId); assert.deepEqual({ taskId: expected.taskId, runId: expected.runId, toolName: expected.toolName, parentSessionKey: expected.parentSessionKey }, job(toolName)); return true;
    } });
    const deferred = await f.custody.defer(f.ticket, job(toolName)); assert.equal(Object.isFrozen(deferred), true);
    await assert.rejects(f.capture(), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
    const kind = { image_generate: 'image', video_generate: 'video', music_generate: 'audio' }[toolName];
    const mimeType = { image_generate: 'image/png', video_generate: 'video/mp4', music_generate: 'audio/mpeg' }[toolName];
    const bytes = toolName === 'image_generate' ? image : toolName === 'music_generate' ? Buffer.from('ID3synthetic music') : Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom synthetic video')]);
    await fs.writeFile(f.file, bytes); expectedReferences = [{ type: kind, path: f.file, mimeType }];
    const captured = await f.custody.captureDeferred(f.ticket, { completionProof: proof, references: expectedReferences });
    assert.equal(verified, 1); assert.equal(captured.assets[0].toolName, toolName); assert.equal(captured.assets[0].mimeType, mimeType);
    assert.deepEqual((await f.store.read(captured.assets[0].assetId)).bytes, bytes);
    await assert.rejects(f.custody.captureDeferred(f.ticket, { completionProof: proof, references: expectedReferences }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  });
});
test('forged/unavailable async proof, mismatched task/session, old files and expired deferred jobs never gain custody', async t => {
  for (const variant of ['forged-proof', 'no-verifier', 'old-file', 'expired']) await t.test(variant, async t => {
    let now = Date.now(); const proof = {}, f = await fixture(t, { clock: () => now,
      ...(variant === 'no-verifier' ? {} : { verifyCompletion: async actual => actual === proof }) });
    let ticket = f.ticket;
    if (variant === 'old-file') { await fs.writeFile(f.file, image); ticket = await f.custody.begin(f.bound); }
    await assert.rejects(f.custody.defer(ticket, { ...job('image_generate'), parentSessionKey: 'another-session' }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
    await assert.rejects(f.custody.defer(ticket, { ...job('image_generate'), taskId: 'tool:image_generate:caller-claimed-task' }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
    await f.custody.defer(ticket, job('image_generate'));
    if (variant !== 'old-file') await fs.writeFile(f.file, image);
    if (variant === 'expired') now += 30 * 60 * 1000 + 1;
    await assert.rejects(f.custody.captureDeferred(ticket, { completionProof: variant === 'forged-proof' ? structuredClone(proof) : proof,
      references: [{ type: 'image', path: f.file, mimeType: 'image/png' }] }), { code: 'NATIVE_OUTPUT_MEDIA_HELD' });
  });
});
