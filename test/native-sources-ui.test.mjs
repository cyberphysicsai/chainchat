import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSourceView, nativeSourceEnrollment, nativeHeartbeatScratch, mountNativeSourceCard } from '../public/openclaw-settings.js';

const available = {
  agents: [{ id: 'main', name: '<img src=x onerror=alert(1)>', heartbeat: true }, { id: 'research', heartbeat: false }],
  channels: [{ channelId: 'matrix', accountId: 'primary' }],
  sessions: [{ key: 'agent:main:background:fixture', agentId: 'main', label: 'Existing native session' }],
};
const source = { id: 'a'.repeat(64), kind: 'channel', agentId: 'main', channelId: 'matrix', accountId: 'primary' };
const response = (sources = []) => ({ sources, available });
const snapshot = (grant = {}) => ({ sessionKey: 'synthetic-selected-chain', toolAuthority: { grant: { nativeCapabilities: {
  enabled: true, acknowledged: true, backgroundRuns: true, ...grant,
} } } });

test('enrollment uses only actual discovered agent, account and session identities and drops private metadata', () => {
  const view = nativeSourceView({ ...response([{ ...source, ownerKey: 'private-owner-key', token: 'private-secret' }]),
    available: { ...available, agents: [...available.agents, {id:'../invalid'}],
      sessions: [...available.sessions, { key: 'agent:other:fixture', agentId: 'main' }] } });
  assert.deepEqual(view.sources, [source]); assert.equal(JSON.stringify(view).includes('private-'), false);
  assert.equal(view.agents.length, 2); assert.equal(view.sessions.length, 1);
  assert.deepEqual(nativeSourceEnrollment(source, view), { action: 'enroll', source: {kind:'channel',agentId:'main',channelId:'matrix',accountId:'primary'} });
  assert.deepEqual(nativeSourceEnrollment({kind:'heartbeat',agentId:'main'},view), {action:'enroll',source:{kind:'heartbeat',agentId:'main'}});
  assert.deepEqual(nativeSourceEnrollment({kind:'background',agentId:'main',nativeSessionKey:available.sessions[0].key},view),
    {action:'enroll',source:{kind:'background',agentId:'main',nativeSessionKey:available.sessions[0].key}});
  for (const candidate of [{kind:'heartbeat',agentId:'research'}, {kind:'heartbeat',agentId:'invented'},
    {kind:'channel',agentId:'main',channelId:'matrix',accountId:'invented'},
    {kind:'background',agentId:'research',nativeSessionKey:available.sessions[0].key},
    {kind:'background',agentId:'main',nativeSessionKey:'agent:main:invented'}]) assert.throws(() => nativeSourceEnrollment(candidate,view));
});

class Node {
  constructor(tag, document) { this.tagName=tag;this.document=document;this.children=[];this.handlers={};this.dataset={};this.attributes={};this.textContent='';this.value='';this.checked=false;this.disabled=false; }
  set id(value){this._id=value;this.document.ids.set(value,this);} get id(){return this._id;}
  append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;} setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,handler){this.handlers[name]=handler;} async fire(name='click'){await this.handlers[name]?.({preventDefault(){}});}
  set innerHTML(_value){throw new Error('Discovered source metadata cannot become markup');}
}
const descendants = node => [node,...node.children.flatMap(descendants)];
const settle = async () => { for(let i=0;i<8;i++) await Promise.resolve(); };
function fixture(api = async () => response()) {
  const doc={ids:new Map(),createElement(tag){return new Node(tag,this);}},mount=doc.createElement('div'),calls=[];let owner=1;
  const controller=mountNativeSourceCard({document:doc,mount,api:async(...args)=>{calls.push(args);return api(...args);},context:()=>owner});
  return {doc,mount,calls,controller,get:id=>doc.ids.get(id),changeOwner(){owner++;controller.reset();}};
}

test('native source controls render dynamic IDs as text and submit exact typed channel, heartbeat and background requests', async () => {
  const f=fixture();f.controller.render(snapshot());await settle();
  assert.deepEqual(f.calls,[['/api/openclaw/sources',{action:'list'}]]);
  assert.ok(descendants(f.mount).some(node=>node.textContent.includes('<img src=x onerror=alert(1)>')));
  assert.equal(descendants(f.mount).some(node=>node.tagName==='img'),false);
  const choose = async (kind, target) => {
    f.get('nativeSourceKind').value=kind;await f.get('nativeSourceKind').fire('change');
    f.get('nativeSourceAgent').value='main';await f.get('nativeSourceAgent').fire('change');
    if(target!==undefined){f.get('nativeSourceTarget').value=target;await f.get('nativeSourceTarget').fire('change');}
    assert.equal(f.get('enrollNativeSource').disabled,true);
    f.get('nativeSourceAcknowledged').checked=true;await f.get('nativeSourceAcknowledged').fire('change');
    assert.equal(f.get('enrollNativeSource').disabled,false);await f.get('nativeSourceForm').fire('submit');
  };
  await choose('channel','0');
  assert.deepEqual(f.calls.at(-1),['/api/openclaw/sources',{action:'enroll',source:{kind:'channel',agentId:'main',channelId:'matrix',accountId:'primary'}}]);
  await choose('heartbeat');assert.deepEqual(f.calls.at(-1)[1],{action:'enroll',source:{kind:'heartbeat',agentId:'main'}});
  await choose('background',available.sessions[0].key);
  assert.deepEqual(f.calls.at(-1)[1],{action:'enroll',source:{kind:'background',agentId:'main',nativeSessionKey:available.sessions[0].key}});
  assert.doesNotMatch(f.get('nativeSourcesStatus').textContent,/started|executing|unrestricted|unreviewed/);
});

test('existing bindings can be revoked while background permission is off, and missing discovery never invents IDs', async () => {
  const f=fixture(async(_route,payload)=>payload.action==='revoke'?response():response([source]));
  f.controller.render(snapshot({enabled:false,acknowledged:false,backgroundRuns:false}));await settle();
  assert.equal(f.get('enrollNativeSource').disabled,true);assert.equal(f.get('refreshNativeSources').disabled,false);
  const revoke=descendants(f.mount).find(node=>node.dataset.nativeSourceId===source.id);
  assert.equal(revoke.disabled,false);await revoke.fire();
  assert.deepEqual(f.calls.at(-1),['/api/openclaw/sources',{action:'revoke',id:source.id}]);
  assert.match(f.get('nativeSourcesStatus').textContent,/revoked/);
  const missing=fixture(async()=>({sources:[]}));missing.controller.render(snapshot());await settle();
  assert.equal(missing.get('enrollNativeSource').disabled,true);
  assert.equal(missing.get('nativeSourceAgent').children.length,1);
  assert.equal(missing.get('refreshNativeSources').disabled,false);
});

test('stale source discovery and enrollment errors cannot leak another owner state or raw native error bodies', async () => {
  let release;const f=fixture(()=>new Promise(resolve=>{release=resolve;}));
  f.controller.render(snapshot());f.changeOwner();release(response([source]));await settle();
  assert.equal(f.get('refreshNativeSources').disabled,true);assert.equal(f.get('nativeEnrolledSources').children.length,1);
  assert.equal(descendants(f.mount).some(node=>node.dataset.nativeSourceId===source.id),false);
  const failed=fixture(async()=>{throw Object.assign(new Error('private-token https://private.invalid/path'),{code:'OPENCLAW_NATIVE_BINDING_REQUIRED'});});
  failed.controller.render(snapshot());await settle();
  assert.match(failed.get('nativeSourcesStatus').textContent,/OPENCLAW_NATIVE_BINDING_REQUIRED/);
  assert.doesNotMatch(failed.get('nativeSourcesStatus').textContent,/private-token|private.invalid/);
});

const heartbeat = {id:'b'.repeat(64),kind:'heartbeat',agentId:'main'};
const notes = (content='Review the local progress.', currentRevision=7) => ({sourceId:heartbeat.id,agentId:'main',content,currentRevision,maxBytes:262144});
test('heartbeat notes accept only the enrolled source identity, bounded UTF-8 content and current native revision',()=>{
  assert.deepEqual(nativeHeartbeatScratch({...notes(),jobId:'private-native-id',token:'not-public'},heartbeat),notes());
  assert.equal(nativeHeartbeatScratch(notes(null),heartbeat).content,null);assert.equal(nativeHeartbeatScratch(notes(''),heartbeat).content,'');
  for(const value of [{...notes(),sourceId:source.id},{...notes(),agentId:'other'},{...notes(),currentRevision:-1},{...notes(),maxBytes:262145},{...notes(),maxBytes:1,content:'é'},{...notes(),content:'a\0b'}])assert.throws(()=>nativeHeartbeatScratch(value,heartbeat));
  assert.throws(()=>nativeHeartbeatScratch(notes(),source));
});

test('heartbeat editor reads actual enrolled IDs and saves CAS notes, empty skip and configured-prompt reset without granting tools',async()=>{
  let revision=7;const f=fixture(async(_route,payload)=>payload.action==='list'?response([source,heartbeat]):
    payload.action==='scratch-get'?notes('<img src=x onerror=alert(1)>',revision):notes(payload.content,++revision));
  f.controller.render(snapshot());await settle();const edit=descendants(f.mount).find(node=>node.dataset.nativeScratchSource===heartbeat.id);assert.ok(edit);
  assert.equal(descendants(f.mount).filter(node=>node.dataset.nativeScratchSource).length,1);
  await edit.fire();assert.deepEqual(f.calls.at(-1),['/api/openclaw/sources',{action:'scratch-get',id:heartbeat.id}]);
  assert.equal(f.get('nativeHeartbeatScratchNotes').value,'<img src=x onerror=alert(1)>');assert.equal(descendants(f.mount).some(node=>node.tagName==='img'),false);
  f.get('nativeHeartbeatScratchNotes').value='Observe the bounded task and report uncertainty.';await f.get('nativeHeartbeatScratchForm').fire('submit');
  assert.deepEqual(f.calls.at(-1),['/api/openclaw/sources',{action:'scratch-set',id:heartbeat.id,content:'Observe the bounded task and report uncertainty.',expectedRevision:7}]);
  f.get('nativeHeartbeatScratchNotes').value='';await f.get('nativeHeartbeatScratchForm').fire('submit');
  assert.deepEqual(f.calls.at(-1)[1],{action:'scratch-set',id:heartbeat.id,content:'',expectedRevision:8});assert.match(f.get('nativeHeartbeatScratchStatus').textContent,/scheduled model work is skipped/);
  await f.get('resetNativeHeartbeatScratch').fire();assert.deepEqual(f.calls.at(-1)[1],{action:'scratch-set',id:heartbeat.id,content:null,expectedRevision:9});
  assert.match(f.get('nativeHeartbeatScratchStatus').textContent,/configured prompt applies/);
  assert.ok(descendants(f.mount).some(node=>node.textContent.includes('Notes grant no tools')));
});

test('a revoked background grant leaves heartbeat notes inspectable while saving stays disabled',async()=>{
  const f=fixture(async(_route,payload)=>payload.action==='list'?response([heartbeat]):notes());
  f.controller.render(snapshot({enabled:false,backgroundRuns:false}));await settle();await descendants(f.mount).find(node=>node.dataset.nativeScratchSource===heartbeat.id).fire();
  assert.equal(f.get('nativeHeartbeatScratchNotes').readOnly,true);assert.equal(f.get('saveNativeHeartbeatScratch').disabled,true);
  const before=f.calls.length;f.get('nativeHeartbeatScratchNotes').value='Should not save.';await f.get('nativeHeartbeatScratchForm').fire('submit');assert.equal(f.calls.length,before);
  assert.equal(f.get('refreshNativeHeartbeatScratch').disabled,false);
});

test('stale notes and revision conflicts preserve owner isolation and never render native error bodies',async()=>{
  let release;const f=fixture(async(_route,payload)=>payload.action==='list'?response([heartbeat]):new Promise(resolve=>{release=resolve;}));
  f.controller.render(snapshot());await settle();const pending=descendants(f.mount).find(node=>node.dataset.nativeScratchSource===heartbeat.id).fire();
  f.changeOwner();release(notes('Previous owner notes.'));await pending;assert.equal(f.get('nativeHeartbeatScratchNotes').value,'');assert.equal(f.get('nativeHeartbeatScratch').hidden,true);
  const conflict=fixture(async(_route,payload)=>{if(payload.action==='list')return response([heartbeat]);if(payload.action==='scratch-get')return notes();throw new Error('private-key https://private.invalid/path');});
  conflict.controller.render(snapshot());await settle();await descendants(conflict.mount).find(node=>node.dataset.nativeScratchSource===heartbeat.id).fire();
  conflict.get('nativeHeartbeatScratchNotes').value='My uncommitted edit.';await conflict.get('nativeHeartbeatScratchForm').fire('submit');
  assert.equal(conflict.get('nativeHeartbeatScratchNotes').value,'My uncommitted edit.');assert.match(conflict.get('nativeHeartbeatScratchStatus').textContent,/Reload notes/);
  assert.doesNotMatch(conflict.get('nativeHeartbeatScratchStatus').textContent,/private-key|private.invalid/);
});
