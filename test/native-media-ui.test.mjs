import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { composerCommand } from '../public/chat-commands.js';
import { NATIVE_MEDIA_MAX_BYTES, nativeMediaAsset, nativeMediaFile, createNativeAttachmentQueue, nativeChatPayload,
  nativeHistoryMedia, nativeMessageMedia, verifiedNativeMedia, renderNativeMedia, mountNativeMediaComposer } from '../public/native-media.js';

const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3]);
const id = createHash('sha256').update(bytes).digest('hex');
const asset = patch => ({ id, fileName: 'fixture.png', mimeType: 'image/png', bytes: bytes.length, kind: 'image', ...patch });
const file = () => new File([bytes], 'fixture.png', { type: 'image/png' });
const native = () => ({ provider: 'native', tier: 'native', model: 'fixture/model', configured: true });

test('attachment metadata drops paths and URLs and accepts only bounded supported native files', () => {
  assert.deepEqual(nativeMediaAsset(asset({ contentFile: '/private/file', url: 'https://external.invalid' })), asset());
  for (const patch of [{ id: '../bad' }, { fileName: '/private/file.png' }, { mimeType: 'image/svg+xml' }, { kind: 'video' }, { bytes: NATIVE_MEDIA_MAX_BYTES + 1 }]) assert.equal(nativeMediaAsset(asset(patch)), null);
  assert.deepEqual(nativeMediaFile(file()), { fileName: 'fixture.png', mimeType: 'image/png', bytes: bytes.length, kind: 'image' });
  assert.throws(() => nativeMediaFile({ name: 'run.html', type: 'text/html', size: 2 }));
});

test('native uploads use only the local media endpoint and the chat receives IDs rather than bytes or paths', async () => {
  const calls = [], changes = [], errors = [];
  const queue = createNativeAttachmentQueue({ context: () => 'owner:agent:native:model', provider: native,
    api: async (...args) => { calls.push(args); return { asset: asset({ contentFile: '/private/path' }) }; }, onChange: state => changes.push(state), onError: value => errors.push(value) });
  await queue.upload([file()]);
  assert.deepEqual(calls, [['/api/media/upload', { fileName: 'fixture.png', mimeType: 'image/png', content: Buffer.from(bytes).toString('base64') }]]);
  const draft = queue.take(); assert.deepEqual(draft, { ids: [id], assets: [asset()] });
  assert.deepEqual(nativeChatPayload('Examine this file.', draft.ids, native()), { message: 'Examine this file.', attachments: [id] });
  assert.equal(JSON.stringify(draft).includes('/private/path'), false); assert.equal(queue.snapshot().assets.length, 0);
  assert.equal(changes.at(-1).uploading, false); assert.equal(errors.filter(Boolean).length, 0);
  assert.deepEqual(nativeChatPayload('Regular text.', [], {provider:'compatible'}), {message:'Regular text.'});
  assert.throws(() => nativeChatPayload('Do not forward.', [id], { provider:'compatible',tier:'byok',configured:true }));
});

test('non-native routes and over-limit batches cannot upload, and removal changes the outgoing IDs', async () => {
  let current = { provider: 'compatible', tier: 'byok', configured: true }, calls = 0; const errors = [];
  const queue = createNativeAttachmentQueue({ context: () => 'owner', provider: () => current, api: async () => { calls++; return { asset: asset() }; }, onError: error => errors.push(error) });
  await queue.upload([file()]); assert.equal(calls, 0); assert.match(errors.at(-1), /native OpenClaw/);
  current = native(); await queue.upload(Array.from({length:11}, file)); assert.equal(calls, 0);
  await queue.upload([{ name:'big.txt',type:'text/plain',size:NATIVE_MEDIA_MAX_BYTES },{name:'extra.txt',type:'text/plain',size:1}]); assert.equal(calls, 0);
  await queue.upload([file()]); assert.equal(calls, 1); queue.remove(id); assert.deepEqual(queue.take().ids, []);
});

test('changing agent or model invalidates pending encodes and upload responses before they enter another queue', async () => {
  let owner = 'agent:model-a', releaseEncode, releaseUpload, calls = 0;
  const encoded = createNativeAttachmentQueue({ context: () => owner, provider: native, encode: () => new Promise(resolve => { releaseEncode = resolve; }), api: async () => { calls++; return {asset:asset()}; } });
  const first = encoded.upload([file()]); owner = 'agent:model-b'; encoded.sync(); releaseEncode('encoded'); await first;
  assert.equal(calls, 0); assert.deepEqual(encoded.take().ids, []);
  const uploaded = createNativeAttachmentQueue({ context: () => owner, provider: native, encode: async () => 'encoded', api: () => new Promise(resolve => { releaseUpload = resolve; }) });
  const second = uploaded.upload([file()]); await Promise.resolve(); owner = 'other-agent:model-b'; uploaded.sync(); releaseUpload({asset:asset()}); await second;
  assert.deepEqual(uploaded.take().ids, []);
});

test('authenticated media reads verify exact content hashes and never accept remote URLs as bytes', async () => {
  const calls = [], api = async (...args) => { calls.push(args); return { asset: asset(), content: Buffer.from(bytes).toString('base64') }; };
  const read = await verifiedNativeMedia(api, asset(), { hash: async value => createHash('sha256').update(value).digest('hex') });
  assert.deepEqual(read.bytes, bytes); assert.deepEqual(calls[0].slice(0, 2), ['/api/media/read', {assetId:id}]);
  await assert.rejects(verifiedNativeMedia(async () => ({asset:asset(),content:'https://external.invalid/file'}),asset()));
  await assert.rejects(verifiedNativeMedia(api,asset(),{hash:async()=> '0'.repeat(64)}));
});

class Node {
  constructor(tag) { this.tagName=tag;this.children=[];this.textContent='';this.handlers={};this.attributes={};this.value='';this.disabled=false;this.dataset={};
    const set=new Set(); this.classList={toggle:(name,active)=>active?set.add(name):set.delete(name),contains:name=>set.has(name)}; }
  append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;} setAttribute(name,value){this.attributes[name]=value;}
  removeAttribute(name){delete this.attributes[name]; if(name==='src')delete this.src;}
  addEventListener(name,handler){this.handlers[name]=handler;} async fire(name='click',event={}){await this.handlers[name]?.(event);} click(){this.clicked=true;return this.fire();}
  pause(){this.paused=true;} set innerHTML(_value){throw new Error('Media labels cannot become markup');}
  focus(){}
}
const descendants = node => [node,...node.children.flatMap(descendants)];
const doc = () => ({createElement:tag=>new Node(tag)});

test('media bytes load only on an explicit view click and Blob URLs are revoked on cleanup', async () => {
  const mount = new Node('article'), revoked=[], loaded=[];
  const dispose = renderNativeMedia({document:doc(),mount,assets:[asset({url:'https://external.invalid'})],api:()=>{throw new Error('Use injected verified reader');},
    read:async()=>{loaded.push(id);return{asset:asset(),bytes};},createURL:blob=>{assert.equal(blob.type,'image/png');return'blob:local-preview';},revokeURL:url=>revoked.push(url)});
  assert.equal(loaded.length,0);const button=descendants(mount).find(node=>node.tagName==='button');await button.fire();
  const image=descendants(mount).find(node=>node.tagName==='img');assert.equal(image.src,'blob:local-preview');assert.equal(loaded.length,1);
  assert.equal(button.textContent,'Hide preview');await button.fire();assert.deepEqual(revoked,['blob:local-preview']);assert.equal(image.src,undefined);
  assert.equal(button.textContent,'View image');await button.fire();assert.equal(loaded.length,2);
  dispose();assert.deepEqual(revoked,['blob:local-preview','blob:local-preview']);
});

test('disposed pending media and held outputs cannot appear, and input receipts are distinct from native outputs', async () => {
  const outputs=asset({id:'a'.repeat(64),fileName:'output.png'});
  assert.deepEqual(nativeMessageMedia({role:'assistant',attachments:[asset()],media:[outputs]},{role:'user',attachments:[asset()]}),{inputs:[],outputs:[outputs],unknown:[]});
  assert.deepEqual(nativeMessageMedia({role:'assistant',held:true,media:[outputs]}).outputs,[]);
  let release,created=0;const mount=new Node('article');const dispose=renderNativeMedia({document:doc(),mount,assets:[asset()],api:()=>{},read:()=>new Promise(resolve=>{release=resolve;}),createURL:()=>{created++;return'blob:late';}});
  const pending=descendants(mount).find(node=>node.tagName==='button').fire();dispose();release({asset:asset(),bytes});await pending;
  assert.equal(created,0);
});

test('portable canonical history retains verified input and output references without assigning unknown attachment origins', async () => {
  const ref=(hash,name,direction)=>({hash,size:bytes.length,mime:'image/png',name,kind:'image',role:hash+'.png',...(direction?{direction}:{})});
  const source=ref(id,'source.png','input'),output=ref('b'.repeat(64),'output.png','output'),unknown=ref('c'.repeat(64),'older-native.png','unknown');
  const payload={input:'Inspect this image.',output:'An explicitly uncertain description.',sourceAssets:[source,unknown],outputAssets:[output]};
  assert.deepEqual(nativeHistoryMedia(payload,'input'),[asset({fileName:'source.png'})]);
  assert.deepEqual(nativeHistoryMedia(payload,'output'),[asset({id:output.hash,fileName:'output.png'})]);
  assert.deepEqual(nativeHistoryMedia(payload,'unknown'),[asset({id:unknown.hash,fileName:'older-native.png'})]);
  assert.deepEqual(nativeHistoryMedia({sourceAssets:[ref(id,'unattributed.png')]},'input'),[]);
  assert.equal(nativeHistoryMedia({sourceAssets:[ref(id,'unattributed.png')]},'unknown').length,1);
  assert.deepEqual(nativeHistoryMedia({sourceAssets:[{...source,direction:'output'}]},'output'),[]);
  assert.deepEqual(nativeHistoryMedia({attachments:[asset()],sourceAssets:[ref(id,'duplicate.png')]},'unknown'),[]);
  assert.deepEqual(nativeHistoryMedia({sourceAssets:[{...source,name:'/private/path.png',url:'https://untrusted.invalid'}]},'input'),[]);
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const begin=app.indexOf('function historyMessages()'),end=app.indexOf('function reconcilePending()',begin);
  const context={state:{agent:{history:[{ring:1,hash:'fixture-ring',payload}]},pending:{exchanges:[{...payload,attachments:[asset()],media:[asset({id:output.hash,fileName:'pending.png'})]}]}},nativeHistoryMedia};
  vm.createContext(context);vm.runInContext(app.slice(begin,end),context);
  const messages=structuredClone(context.historyMessages());
  assert.equal(messages[0].attachments[0].id,id);assert.equal(messages[1].media[0].id,output.hash);
  assert.equal(messages[1].unknownAttachments[0].id,unknown.hash);assert.equal(messages[3].pending,true);
  assert.equal(messages[3].media[0].fileName,'output.png');
  const displayed=nativeMessageMedia(messages[1],messages[0]);assert.equal(displayed.outputs.length,1);assert.equal(displayed.unknown.length,1);
  assert.deepEqual(nativeMessageMedia({...messages[1],held:true}).unknown,[]);
});

test('the composer exposes a native-only file control and its real change handler uploads the selected files', async () => {
  let current=native(); const button=new Node('button'),input=new Node('input'),notice=new Node('p'),mount=new Node('div'),calls=[];
  const controller=mountNativeMediaComposer({document:doc(),button,input,notice,queueMount:mount,context:()=>current.provider,provider:()=>current,
    api:async(...args)=>{calls.push(args);return{asset:asset()};},encode:async()=>Buffer.from(bytes).toString('base64')});
  await button.fire();assert.equal(input.clicked,true);input.files=[file()];await input.fire('change');
  assert.equal(calls[0][0],'/api/media/upload');assert.deepEqual(controller.take().ids,[id]);
  current={provider:'compatible',tier:'byok',configured:true};controller.sync();assert.equal(button.disabled,true);assert.match(notice.textContent,/native OpenClaw/);
  controller.dispose();
});

test('the actual chat submit handler sends uploaded IDs only on native chat and blocks pending or non-native attachment sends', async () => {
  const app = await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start = app.indexOf('function clearComposerDraft()'), end = app.indexOf('$("messageInput").addEventListener("keydown"',start);
  assert.ok(start>=0 && end>start);
  async function run(provider, uploading=false) {
    const nodes=new Map(), $=id=>{if(!nodes.has(id))nodes.set(id,new Node('div'));return nodes.get(id);};
    $('messageInput').value='Inspect the selected file.'; $('messageInput').dispatchEvent=()=>{};
    const calls=[],messages=[],notices=[];let takes=0;
    const context={ $, requestBusy:false, modelSwitchBusy:false, stoppingBusy:false, token:'synthetic-local-session',state:{agent:{id:'fixture-agent'},provider},
      nativeMediaComposer:{snapshot:()=>({uploading}),sync(){},take(){takes++;return{ids:[id],assets:[asset()]};}},
      composerCommand,nativeChatPayload,cognition:()=>({mode:'active'}),agentId:()=> 'fixture-agent',AbortController,Event,
      addMessage:value=>messages.push(value),activity(){},toast:value=>notices.push(value),openModel(){},openDialog(){},
      api:async(route,payload,options)=>{calls.push([route,structuredClone(payload),options]);return{message:{content:'Accepted synthetic response.',gate:{approved:true},ring:{index:1}}};},
      messageIsReviewedPause:()=>false,messageIsDormant:()=>false,renderOperationControls(){},renderRuntimeActivity(){},refreshState:async()=>{},refreshActivity:async()=>{} };
    vm.createContext(context);vm.runInContext(app.slice(start,end),context);await $('chatForm').fire('submit',{preventDefault(){}});
    return{calls,messages,notices,takes};
  }
  const accepted=await run(native());
  assert.deepEqual(accepted.calls[0].slice(0,2),['/api/chat',{message:'Inspect the selected file.',attachments:[id]}]);
  assert.ok(accepted.calls[0][2].signal instanceof AbortSignal);
  assert.equal(accepted.messages[0].attachments[0].id,id);
  const direct=await run({provider:'compatible',tier:'byok',configured:true});assert.equal(direct.calls.length,0);assert.match(direct.notices[0],/native OpenClaw/);
  const pending=await run(native(),true);assert.equal(pending.calls.length,0);assert.equal(pending.takes,0);
});
