import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {NativeMediaStore} from '../lib/native-media-store.mjs';
import {NativeOwnerStore} from '../lib/native-owner-store.mjs';
import {NativeCompletions} from '../lib/native-completions.mjs';
import {validateNativeProvider, reviewWithCompletion, FRUITS, DIMENSIONS} from '../lib/providers.mjs';
async function directory(t) {const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-stores-'))); t.after(async()=>{assert.ok(path.basename(root).startsWith('ct-native-stores-')); await fs.rm(root,{recursive:true,force:true});}); return root;}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=';
test('completion notifications persist only deduplicated chain references and remain scoped to agent and genesis', async t => {
  const root=await directory(t), store=await new NativeCompletions(root).load();
  const row={agentId:'agent-one',genesisHash:'a'.repeat(64),ringIndex:3,ringHash:'b'.repeat(64),createdAt:new Date().toISOString()};
  const before=store.list(row.agentId,row.genesisHash).revision;
  await Promise.all([store.record(row),store.record(row)]);
  const reopened=await new NativeCompletions(root).load(), selected=reopened.list(row.agentId,row.genesisHash);
  assert.equal(selected.rows.length,1);assert.notEqual(selected.revision,before);assert.deepEqual(selected.rows[0],row);
  assert.equal(reopened.list('other-agent',row.genesisHash).rows.length,0);assert.equal(reopened.list(row.agentId,'c'.repeat(64)).rows.length,0);
  assert.throws(()=>store.record({...row,content:'Never duplicate user text in this derived ledger.'}));
  assert.throws(()=>store.record({...row,ringHash:row.ringHash+'\n'}));
  assert.throws(()=>store.record({...row,createdAt:' '+row.createdAt}));
  await fs.writeFile(store.file,'broken');await assert.rejects(new NativeCompletions(root).load());
});
test('near-limit derived completion references remain reloadable after another completion', async t => {
  const root=await directory(t), file=path.join(root,'native-completion-references.json');
  const rows=Array.from({length:2048},(_,index)=>({agentId:'a'.repeat(100),genesisHash:'a'.repeat(64),ringIndex:index+1,
    ringHash:(index+1).toString(16).padStart(64,'0'),createdAt:'2026-11-04T00:00:00.000Z'}));
  await fs.writeFile(file,JSON.stringify({version:1,rows},null,2),{mode:0o600});
  const before=await fs.stat(file);assert.ok(before.size>700000&&before.size<1024*1024);
  const store=await new NativeCompletions(root).load();
  const added={...rows.at(-1),ringIndex:4096,ringHash:'f'.repeat(64)};await store.record(added);
  assert.ok((await fs.stat(file)).size<1024*1024);
  const recovered=await new NativeCompletions(root).load();assert.deepEqual(recovered.list(added.agentId,added.genesisHash).rows.at(-1),added);
});
test('owned media is content-addressed, deduplicated, bounded and rechecked before reading', async t => {
  const root = await directory(t), store = new NativeMediaStore(path.join(root,'media'));
  const asset = await store.put({mimeType:'image/png',fileName:'example.png',content:png});
  assert.equal(asset.kind,'image'); assert.match(asset.id,/^[a-f0-9]{64}$/);
  assert.deepEqual((await store.read(asset.id)).bytes,Buffer.from(png,'base64'));
  assert.equal((await store.put({mimeType:'image/png',fileName:'renamed.png',content:png})).id,asset.id);
  await assert.rejects(store.put({mimeType:'image/png',fileName:'../private.png',content:png}));
  await assert.rejects(store.put({mimeType:'image/png',fileName:'fake.png',content:Buffer.from('<script>bad</script>').toString('base64')}));
  await assert.rejects(store.read(asset.id+'\n'));
  await fs.writeFile(path.join(store.root,asset.id,asset.contentFile),'changed');
  await assert.rejects(store.read(asset.id),/changed/);
});
test('media quota refusal does not destroy existing assets or accept unsupported active content', async t => {
  const root = await directory(t), store = new NativeMediaStore(path.join(root,'media'),{quotaBytes:Buffer.from(png,'base64').length});
  const asset = await store.put({mimeType:'image/png',fileName:'image.png',content:png});
  await assert.rejects(store.put({mimeType:'text/plain',fileName:'more.txt',content:Buffer.from('more').toString('base64')}),/limit/);
  await assert.rejects(store.put({mimeType:'image/svg+xml',fileName:'active.svg',content:Buffer.from('<svg/>').toString('base64')}));
  assert.equal((await store.read(asset.id)).metadata.id,asset.id);
});
test('native ownership persists model identity without storing any caller credentials or accepting link substitution', async t => {
  const root = await directory(t), key='owner-1:'+ 'a'.repeat(64), config={provider:'native',model:'fixture/model',tier:'native'};
  const store=await new NativeOwnerStore(root).load(); await store.set(key,config);
  assert.deepEqual((await new NativeOwnerStore(root).load()).get(key),config);
  assert.equal((await fs.readFile(store.file,'utf8')).includes('apiKey'),false);
  assert.throws(()=>store.set(key,{...config,apiKey:'never-persist-this'}));
  const before=await fs.readFile(store.file); await assert.rejects(store.set(key+'\n',config)); assert.deepEqual(await fs.readFile(store.file),before);
  const linked=path.join(root,'owner-hard-link.json'); await fs.link(store.file,linked);
  await assert.rejects(new NativeOwnerStore(root).load()); await fs.unlink(linked);
  await store.set(key,null); assert.equal((await new NativeOwnerStore(root).load()).get(key),null);
});
test('native review uses a private completion callback with unchanged schema/fruit floors', async () => {
  const config=validateNativeProvider({provider:'native',model:'fixture/model',tier:'native'});
  assert.throws(()=>validateNativeProvider({...config,baseUrl:'https://untrusted.example'}));
  let calls=0;
  const verdict={decision:'approve',scores:Object.fromEntries(DIMENSIONS.map(k=>[k,235])),fruits:Object.fromEntries(FRUITS.map(k=>[k,235])),usedRings:[],rationale:'A helpful grounded greeting.'};
  const completion=async (selected,args)=>{calls++; assert.deepEqual(selected,config); assert.ok(args.system.includes('independent pre-release covenant reviewer')); assert.equal(args.messages.length,1); return{text:JSON.stringify(verdict)};};
  assert.equal((await reviewWithCompletion(config,{input:'Hello',candidate:'Hello!',covenant:FRUITS},completion)).approved,true);
  verdict.fruits.kindness=179;
  assert.equal((await reviewWithCompletion(config,{input:'Hello',candidate:'Hello!',covenant:FRUITS},completion)).approved,false);
  assert.equal(calls,2);
});
