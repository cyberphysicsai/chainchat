import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { NativeMediaStore } from '../lib/native-media-store.mjs';
import { engine } from '../lib/engine.mjs';
import { DIMENSIONS, FRUITS } from '../lib/providers.mjs';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-source-assets-'))), root = path.join(directory, 'agent');
  t.after(async () => { assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const media = new NativeMediaStore(path.join(directory, 'media')), asset = await media.put({ mimeType: 'image/png', fileName: '私の画像.png', content: image.toString('base64') });
  const created = await engine({ op: 'init', root, registryRoot: root, name: 'Source asset fixture' });
  const exchange = { input: 'Please consider this image patiently.', output: 'I can help you consider the information carefully and acknowledge uncertainty.', usedRings: [], loadout: [],
    scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])), assessment: { approved: true, fruitages: Object.fromEntries(FRUITS.map(key => [key, 240])), rationale: 'A careful and patient response with no unsupported visual claim.' },
    sourceAssets: [asset] };
  const commit = extra => engine({ op: 'commit', root, expectedHead: created.head.hash, loadout: [], growth: false, learning: false, ...exchange, ...extra }, { mediaDirectory: media.root });
  return { directory, root, media, asset, created, exchange, commit };
}
test('approved attachment bytes use canonical Blockspace refs and remain readable after whole-chain portability', async t => {
  const f = await fixture(t), result = await f.commit();
  assert.equal(result.sealed, true);
  const rings = (await fs.readFile(path.join(f.root, 'chain/rings.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse), ring = rings.at(-1);
  assert.deepEqual(ring.blockspace_refs, [{ hash: f.asset.id, role: f.asset.id + '.png' }]);
  assert.deepEqual(ring.payload.exchanges[0].sourceAssets, [{ hash: f.asset.id, size: image.length, mime: 'image/png', name: '私の画像.png', kind: 'image', role: f.asset.id + '.png' }]);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'chain/blockspace/blobs', f.asset.id)), image);
  const restored = await engine({ op: 'read_source_asset', root: f.root, assetId: f.asset.id });
  assert.deepEqual(restored.metadata, f.asset); assert.equal(restored.direction, 'input');
  assert.deepEqual(Buffer.from(restored.content, 'base64'), image);
  assert.equal((await engine({ op: 'inspect', root: f.root })).history.at(-1).sourceAssets[0].direction, 'input');
  assert.equal(JSON.stringify(ring).includes(f.media.root), false); assert.equal(JSON.stringify(ring).includes('CT_CHAT_MEDIA_ROOT'), false);
  const copied = path.join(f.directory, 'copied-chain'); await fs.cp(f.root, copied, { recursive: true });
  await fs.rm(f.media.root, { recursive: true, force: true });
  assert.equal((await engine({ op: 'verify', root: copied })).verified, true);
  const ported = await engine({ op: 'read_source_asset', root: copied, assetId: f.asset.id });
  assert.deepEqual(Buffer.from(ported.content, 'base64'), image);
  for (const extra of [{ path: '/private' }, { content: 'not-accepted' }])
    await assert.rejects(engine({ op: 'read_source_asset', root: copied, assetId: f.asset.id, ...extra }), { code: 'SOURCE_ASSET_INVALID' });
  await assert.rejects(engine({ op: 'read_source_asset', root: copied, assetId: '0'.repeat(64) }), { code: 'SOURCE_ASSET_NOT_FOUND' });
  const canonical = fileURLToPath(new URL('../engine/proof-of-interaction', import.meta.url));
  const script = 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from timechain import Timechain; ok,report=Timechain(Path(sys.argv[2])).verify(); assert ok,report; print("canonical-original-reader-ok")';
  const checked = await promisify(execFile)(process.env.CT_CHAT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-c', script, canonical, copied], {
    windowsHide: true, timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' } });
  assert.match(checked.stdout, /canonical-original-reader-ok/u);
});
test('low covenant, paused chain, stale head and invalid source descriptors never write raw blobs', async t => {
  const f = await fixture(t), file = path.join(f.root, 'chain/blockspace/blobs', f.asset.id);
  await assert.rejects(f.commit({ assessment: { ...f.exchange.assessment, fruitages: { ...f.exchange.assessment.fruitages, kindness: 149 } } }), { code: 'COVENANT_REJECTED' });
  await assert.rejects(f.commit({ expectedHead: '0'.repeat(64) }), { code: 'STALE_HEAD' });
  for (const sourceAssets of [[{ ...f.asset, path: '/private/file' }], [{ ...f.asset, contentFile: '../private' }], [{ ...f.asset, bytes: f.asset.bytes + 1 }]])
    await assert.rejects(f.commit({ sourceAssets }), { code: 'SOURCE_ASSET_INVALID' });
  await engine({ op: 'dormancy', root: f.root, action: 'pause', confirmed: true, expectedHead: f.created.head.hash });
  await assert.rejects(f.commit(), { code: 'CHAIN_PAUSED' });
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  assert.equal((await engine({ op: 'verify', root: f.root })).head.hash, f.created.head.hash);
});
test('tampered/hardlinked uploads and missing private root hold source-backed commits before ring or blob mutation', async t => {
  for (const variant of ['tampered', 'hardlink', 'missing-root']) await t.test(variant, async t => {
    const f = await fixture(t), file = path.join(f.media.root, f.asset.id, f.asset.contentFile);
    if (variant === 'tampered') await fs.appendFile(file, 'tampered');
    if (variant === 'hardlink') await fs.link(file, path.join(f.directory, 'unadmitted-link'));
    const call = variant === 'missing-root' ? () => engine({ op: 'commit', root: f.root, expectedHead: f.created.head.hash, growth: false, learning: false, ...f.exchange }) : () => f.commit();
    await assert.rejects(call(), { code: 'SOURCE_ASSET_INVALID' });
    assert.equal((await engine({ op: 'verify', root: f.root })).head.hash, f.created.head.hash);
    await assert.rejects(fs.access(path.join(f.root, 'chain/blockspace/blobs', f.asset.id)), { code: 'ENOENT' });
  });
});
test('deduplicated multi-exchange source blobs and commit-id retry remain native and idempotent', async t => {
  const f = await fixture(t), commitId = randomUUID();
  const first = await f.commit({ commitId, exchanges: [f.exchange, { ...f.exchange, input: 'Consider the same image once more.' }] });
  const retry = await f.commit({ commitId, exchanges: [f.exchange, { ...f.exchange, input: 'Consider the same image once more.' }] });
  assert.equal(retry.replayedCommit, true); assert.deepEqual(first.ring, retry.ring);
  const rings = (await fs.readFile(path.join(f.root, 'chain/rings.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rings.at(-1).blockspace_refs.length, 1);
  assert.equal(rings.at(-1).payload.exchanges.length, 2);
});
test('a maximum-size portable asset is bounded by decoded bytes rather than the smaller ordinary JSON transport', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(20 * 1024 * 1024, 'x');
  const asset = await f.media.put({ mimeType: 'text/plain', fileName: 'maximum-source.txt', content: bytes.toString('base64') });
  await f.commit({ sourceAssets: [asset] });
  const recovered = await engine({ op: 'read_source_asset', root: f.root, assetId: asset.id });
  assert.ok(recovered.content.length > 24 * 1024 * 1024);
  assert.deepEqual(Buffer.from(recovered.content, 'base64'), bytes);
});

test('generated output assets preserve separate direction and portable native blob references', async t => {
  const f = await fixture(t);
  const audio = Buffer.from('ID3synthetic generated audio'), outputAsset = await f.media.put({ mimeType: 'audio/mpeg', fileName: 'generated-speech.mp3', content: audio.toString('base64') });
  await f.commit({ outputAssets: [outputAsset] });
  const ring = JSON.parse((await fs.readFile(path.join(f.root, 'chain/rings.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.equal(ring.payload.exchanges[0].sourceAssets[0].hash, f.asset.id);
  assert.equal(ring.payload.exchanges[0].outputAssets[0].hash, outputAsset.id);
  assert.equal(ring.blockspace_refs.length, 2); assert.equal(JSON.stringify(ring).includes(f.media.root), false);
  const history = (await engine({ op: 'inspect', root: f.root })).history.at(-1);
  assert.equal(history.sourceAssets[0].direction, 'input'); assert.equal(history.outputAssets[0].direction, 'output');
  const copied = path.join(f.directory, 'copied-output-chain'); await fs.cp(f.root, copied, { recursive: true });
  await fs.rm(f.media.root, { recursive: true, force: true });
  const recovered = await engine({ op: 'read_source_asset', root: copied, assetId: outputAsset.id });
  assert.equal(recovered.direction, 'output'); assert.deepEqual(Buffer.from(recovered.content, 'base64'), audio);
  assert.equal((await engine({ op: 'verify', root: copied })).verified, true);
});

test('output attachment metadata receives the same strict schema and paused-write denials as input attachments', async t => {
  const f = await fixture(t);
  await assert.rejects(f.commit({ outputAssets: [{ ...f.asset, sourcePath: '/private' }] }), { code: 'SOURCE_ASSET_INVALID' });
  await engine({ op: 'dormancy', root: f.root, action: 'pause', confirmed: true, expectedHead: f.created.head.hash });
  await assert.rejects(f.commit({ sourceAssets: [], outputAssets: [f.asset] }), { code: 'CHAIN_PAUSED' });
  await assert.rejects(fs.access(path.join(f.root, 'chain/blockspace/blobs', f.asset.id)), { code: 'ENOENT' });
});
