import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeSecretView,nativeSecretPayload,mountNativeSecretCard} from '../public/openclaw-settings.js';
const target='tts.providers.fixture.apiKey',secret='synthetic-dedicated-test-value';
const response=(bindings=[])=>({targets:[{target,label:'TTS <img src=x onerror=alert(1)>'}],bindings});
const binding={name:'speech-test',target,configured:true,available:true};
class Node {
  constructor(tag,doc){this.tagName=tag;this.doc=doc;this.children=[];this.handlers={};this.dataset={};this.attributes={};this.textContent='';this.value='';this.disabled=false;}
  set id(value){this._id=value;this.doc.ids.set(value,this);}get id(){return this._id;}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(name,handler){this.handlers[name]=handler;}async fire(name='click'){return this.handlers[name]?.({preventDefault(){}});}
  set innerHTML(_value){throw new Error('Native credential metadata cannot become markup.');}
}
const descendants=node=>[node,...node.children.flatMap(descendants)],settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture(api=async()=>response()){
  const doc={ids:new Map(),createElement(tag){return new Node(tag,this);}},mount=doc.createElement('div'),calls=[];let owner=1;
  const controller=mountNativeSecretCard({document:doc,mount,api:async(...args)=>{calls.push(args);return api(...args);},context:()=>owner});
  return{doc,mount,calls,controller,get:id=>doc.ids.get(id),reset(){owner++;controller.reset();}};
}
const connected={sessionKey:'selected-owner-native-session',config:{baseHash:'native-settings-hash'}};

test('older local credential endpoints receive their original payload and honest storage guidance',async()=>{
  const f=fixture();f.controller.render({sessionKey:'older-native-session'});await settle();
  assert.equal(f.get('nativeSecretRemember').disabled,true);
  f.get('nativeSecretName').value='speech-test';f.get('nativeSecretTarget').value=target;f.get('nativeSecretValue').value=secret;
  await f.get('nativeSecretForm').fire('submit');
  assert.deepEqual(f.calls.at(-1),['/api/openclaw/secrets',{action:'set',name:'speech-test',target,value:secret}]);
  assert.match(descendants(f.mount).map(node=>node.textContent).join(' '),/older runtime uses its earlier owner-private credential store/);
});

test('a local UTF-8 credential file preserves multiline bytes without rendering them or retaining an old owner read',async()=>{
  const f=fixture(async(_route,payload)=>payload.action==='set'?response([binding]):response());
  f.controller.render(connected);await settle();
  const value='-----BEGIN SYNTHETIC KEY-----\nfixture-only\n-----END SYNTHETIC KEY-----\n',bytes=new TextEncoder().encode(value);
  f.get('nativeSecretFile').files=[{size:bytes.length,arrayBuffer:async()=>bytes.buffer}];
  await f.get('nativeSecretFile').fire('change');
  assert.equal(f.get('nativeSecretValue').value,'');assert.equal(f.get('nativeSecretValue').required,false);
  assert.equal(descendants(f.mount).some(node=>node.textContent.includes(value)),false);
  f.get('nativeSecretName').value='speech-test';f.get('nativeSecretTarget').value=target;
  await f.get('nativeSecretForm').fire('submit');
  assert.equal(f.calls.at(-1)[1].value,value);assert.equal(f.get('nativeSecretFile').value,'');
  assert.equal(f.get('nativeSecretValue').required,true);
  let resolve;f.get('nativeSecretFile').files=[{size:bytes.length,arrayBuffer:()=>new Promise(done=>{resolve=done;})}];
  const pending=f.get('nativeSecretFile').fire('change');f.reset();resolve(bytes.buffer);await pending;
  assert.equal(f.get('nativeSecretFileStatus').textContent,'');assert.equal(f.get('nativeSecretValue').required,true);
});

test('dedicated credentials select only returned configured targets and response values never enter the public view',()=>{
  const view=nativeSecretView({...response([{...binding,value:secret}]),value:secret});
  assert.deepEqual(view.bindings,[binding]);assert.equal(JSON.stringify(view).includes(secret),false);
  assert.deepEqual(nativeSecretPayload({name:'speech-test',target,value:secret},view),{action:'set',name:'speech-test',target,value:secret});
  for(const input of [{name:'__proto__',target,value:secret},{name:'speech-test',target:'tts.providers.invented.apiKey',value:secret},
    {name:'speech-test',target,value:'x'.repeat(16385)}])assert.throws(()=>nativeSecretPayload(input,view));
  assert.equal(nativeSecretView({targets:[{target:'arbitrary.environment.TOKEN'}]}).targets.length,0);
});

test('credential controls post the exact discovered binding and clear the password before the request begins',async()=>{
  const f=fixture(async(_route,payload)=>{
    assert.equal(f.get('nativeSecretValue').value,'');
    return payload.action==='set'?response([binding]):response();
  });
  f.controller.render(connected);await settle();assert.deepEqual(f.calls[0],['/api/openclaw/secrets',{action:'list'}]);
  assert.ok(descendants(f.mount).some(node=>node.textContent.includes('<img src=x onerror=alert(1)>')));
  assert.equal(descendants(f.mount).some(node=>node.tagName==='img'),false);
  f.get('nativeSecretName').value='speech-test';f.get('nativeSecretTarget').value=target;f.get('nativeSecretValue').value=secret;
  await f.get('nativeSecretForm').fire('submit');assert.deepEqual(f.calls.at(-1),['/api/openclaw/secrets',{action:'set',name:'speech-test',target,value:secret,remember:false}]);
  assert.equal(f.get('nativeSecretValue').value,'');assert.equal(descendants(f.mount).some(node=>node.textContent.includes(secret)),false);
  assert.match(descendants(f.mount).map(node=>node.textContent).join(' '),/encrypted, owner-private local vault/);
});

test('configured credentials remain removable when their target disappears and unavailable targets cannot be invented',async()=>{
  const f=fixture(async(_route,payload)=>payload.action==='remove'?{bindings:[],targets:[]}:{bindings:[{...binding,available:false}],targets:[]});
  f.controller.render(connected);await settle();assert.equal(f.get('saveNativeSecret').disabled,true);
  const remove=descendants(f.mount).find(node=>node.dataset.nativeSecretName===binding.name);assert.equal(remove.disabled,false);await remove.fire();
  assert.deepEqual(f.calls.at(-1),['/api/openclaw/secrets',{action:'remove',name:'speech-test'}]);
  assert.match(f.get('nativeSecretsStatus').textContent,/removed/);
});

test('stale credential responses and raw native errors cannot leak a previous owner or credential',async()=>{
  let release;const f=fixture(()=>new Promise(resolve=>{release=resolve;}));f.controller.render(connected);f.get('nativeSecretValue').value=secret;
  f.reset();release(response([binding]));await settle();assert.equal(f.get('nativeSecretValue').value,'');
  assert.equal(f.get('refreshNativeSecrets').disabled,true);assert.equal(descendants(f.mount).some(node=>node.dataset.nativeSecretName===binding.name),false);
  const failed=fixture(async()=>{throw Object.assign(new Error(secret+' https://private.invalid/config'),{code:'OPENCLAW_CONTROL_BUSY'});});
  failed.controller.render(connected);await settle();assert.match(failed.get('nativeSecretsStatus').textContent,/OPENCLAW_CONTROL_BUSY/);
  assert.doesNotMatch(failed.get('nativeSecretsStatus').textContent,/synthetic-dedicated|private.invalid/);
});
