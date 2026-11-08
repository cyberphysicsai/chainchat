import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createPoIBroker} from '../openclaw/broker.mjs';
import {engine} from '../lib/engine.mjs';
import {FRUITS,DIMENSIONS} from '../lib/providers.mjs';
const good=()=>({approved:true,decision:'approve',usedRings:[],scores:Object.fromEntries(DIMENSIONS.map(key=>[key,240])),fruitages:Object.fromEntries(FRUITS.map(key=>[key,240])),rationale:'A calm user-requested image action.'});
test('a fresh native proof cannot authorize cached media from different completion references', {timeout:60000}, async t=>{
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-deferred-broker-'))),root=path.join(directory,'chain-owner');
  await engine({op:'init',root,name:'Deferred custody contract'});
  const state=await engine({op:'inspect',root}),sessionKey='agent:main:chainchat-control:'+'d'.repeat(64),ownerKey='owner:'+state.genesis.hash;
  const task={taskId:'tool:image_generate:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',runId:'tool:image_generate:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',toolName:'image_generate',
    parentSessionKey:sessionKey,sessionId:'actual-native-session',lifecycleRevision:1,originalRunId:'parent-run',callId:'generated-image-1'};
  const referencesA=[{type:'image',path:path.join(directory,'native-image-A.png'),mimeType:'image/png'}],referencesB=[{...referencesA[0],path:path.join(directory,'native-image-B.png')}];
  const captured=Object.freeze({assets:[{assetId:'a'.repeat(64)}],deliveries:[]}),ticket=Object.freeze({id:'private-original-ticket'});
  let captureCalls=0,currentProof=Object.freeze({id:'first-private-proof'}),currentReferences=referencesA;
  // This fake PRIVATE custody service isolates the broker's proof/cache boundary.
  // File custody and real native provenance are covered by their separate tests.
  const custody={begin:async()=>ticket,defer:async()=>{},discard:()=>{},captureDeferred:async()=>{captureCalls++;return captured;},
    verifyDeliveries:async value=>{assert.equal(value,captured);return value;}};
  const broker=createPoIBroker({engine,review:async()=>good(),nativeOutputMedia:custody});await broker.start();
  t.after(async()=>{await broker.close();assert.ok(path.basename(directory).startsWith('ct-deferred-broker-'));await fs.rm(directory,{recursive:true,force:true});});
  broker.setNativeLifecycle({toolObserved:async()=>({mediaTask:task}),verifyMediaTask:async(proof,expected)=>proof===currentProof&&JSON.stringify(expected.references)===JSON.stringify(currentReferences)});
  const config={provider:'compatible',model:'fixture',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'synthetic-private-deferred-key'};
  const context={purpose:'candidate',root,input:'Generate a calm abstract image.',loadout:[],settings:{recall:false},nativeProvider:true,nativeOwnerKey:ownerKey,
    nativeTools:['image_generate'],toolAuthority:{nativeCapabilities:{enabled:true,acknowledged:true,tools:['image_generate'],settings:[],delegatedRuns:false,backgroundRuns:true}},authorize:async()=>{}};
  const registration=await broker.registerInvocation({config,args:{},context,sessionKey,invocationId:'parent'});
  const call=async(op,fields={})=>{const response=await fetch(broker.url,{method:'POST',headers:{authorization:`Bearer ${broker.token}`,'content-type':'application/json'},body:JSON.stringify({version:1,op,sessionKey,runId:'parent-run',...fields})});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  await call('admit');await call('prepare');
  await call('tool',{tool:{name:'image_generate',callId:task.callId,params:{prompt:'A calm abstract image.'}}});
  await call('tool_result',{tool:{name:'image_generate',callId:task.callId},outcome:{success:true,error:null,result:{details:{async:true,status:'started',taskId:task.taskId,runId:task.runId}}}});
  await broker.finishInvocation(registration);
  const continuation=(proof,refs,id)=>broker.registerInvocation({config,args:{},sessionKey,invocationId:id,context:{...context,mediaTask:task,mediaTaskProof:proof,mediaTaskReferences:refs,mediaTaskStatus:'ok'}});
  const first=await continuation(currentProof,referencesA,'first-completion');assert.equal(captureCalls,1);await broker.finishInvocation(first);
  currentProof=Object.freeze({id:'second-private-proof'});currentReferences=referencesB;
  await assert.rejects(continuation(currentProof,referencesB,'changed-completion'),{code:'NATIVE_OUTPUT_MEDIA_HELD'});
  assert.equal(captureCalls,1,'A new valid proof for different refs must not reuse or recapture the consumed file ticket.');
  currentProof=Object.freeze({id:'third-private-proof'});currentReferences=referencesA;
  const same=await continuation(currentProof,referencesA,'same-references-retry');assert.equal(captureCalls,1);await broker.finishInvocation(same);
  assert.equal((await engine({op:'verify',root})).head.index,0,'Neither admission nor held retry may fabricate a completed conversation block.');
});
