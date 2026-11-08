import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createApp} from '../server.mjs';
import {engine} from '../lib/engine.mjs';
import {FRUITS, DIMENSIONS} from '../lib/providers.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const good = () => ({approved:true,decision:'approve',usedRings:[],scores:Object.fromEntries(DIMENSIONS.map(key=>[key,240])),fruits:Object.fromEntries(FRUITS.map(key=>[key,240])),rationale:'A grounded helpful greeting.'});

test('paired native APIs retain BYOK privately, reject invented model/tool authority, and give owned runs separate reviewed chains', {timeout:180000}, async t => {
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-native-contract-')));
  let app, adapter, current='fixture/first', resumeChecked=false, nativeArgs, sourceArgs;
  const models=[{id:'fixture/first',available:true},{id:'fixture/second',available:true},{id:'fixture/unconfigured',available:false}];
  const factory=options=>{
    adapter=options;
    return {start:async()=>{assert.equal(await options.resolveNativeOwner({ownerKey:'invented'}),null);},close:async()=>{},
      resumeNativeSources:async()=>{resumeChecked=true;},status:()=>({running:true,backend:'openclaw'}),
      describeControls:async()=>({runtime:{running:true,backend:'openclaw'},commands:[],revision:'fixture'}),executeCommand:async()=>({}),
      toolCatalogue:async()=>({tools:[{name:'sessions_spawn'},{name:'cron'},{name:'read'},{name:'trusted_fixture'}]}),
      nativeModels:async()=>({configured:true,current,models}),setNativeModel:async(_identity,model)=>{current=model;},
      generateNative:async(_config,args)=>{nativeArgs=args;return {text:'Hello! I can help you think carefully and acknowledge uncertainty.'};},completeNative:async()=>{throw new Error('No SDK inference requested by this API contract.');},
      analyzeNativeMedia:async({assetId,operation})=>{const text='MODEL-DERIVED MEDIA OBSERVATION: A selected image was supplied; no visual detail is independently established by this transport fixture.';return {assetId,sha256:assetId,operation,modelDerived:true,text,textSha256:sha(text)};},
      nativeAuth:async({action})=>({available:true,action,providers:[]}),
      nativeSources:async(args)=>{sourceArgs=args;return {sources:[],action:args.action,agentId:args.identity.agentId};}};
  };
  app=await createApp({dataDir:path.join(directory,'data'),pairingCode:'NATIVE-CONTRACT',openclaw:{},openclawFactory:factory,review:async()=>good()});
  assert.equal(resumeChecked,true);
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.closeRuntime();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));assert.ok(path.basename(directory).startsWith('ct-native-contract-'));await fs.rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;let token;
  const call=async(endpoint,payload,origin=base)=>{const response=await fetch(base+endpoint,{method:payload===undefined?'GET':'POST',headers:{origin,...(token?{authorization:`Bearer ${token}`} : {}),...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});return {status:response.status,body:await response.json()};};
  assert.equal((await call('/api/openclaw/provider')).status,401);
  token=(await call('/api/pair',{code:'NATIVE-CONTRACT'})).body.token;
  assert.equal((await call('/api/openclaw/sources',{action:'list'})).status,409);
  const created=await call('/api/agents',{name:'Native Contract'});assert.equal(created.status,201);
  const parent=app.store.agents[0], identity={agentId:parent.id,genesisHash:created.body.agent.genesis.hash};
  const ownerKey=identity.agentId+':'+identity.genesisHash;
  let parentHead=(await engine({op:'verify',root:parent.root})).head;
  assert.equal((await call('/api/provider',{provider:'openai',model:'byok-fixture',apiKey:'synthetic-private-byok-contract'})).status,200);
  assert.equal((await call('/api/openclaw/provider',{model:'fixture/unconfigured'})).status,409);
  assert.equal((await call('/api/openclaw/provider',{model:'fixture/first',apiKey:'forbidden-override'})).status,400);
  const switched=await call('/api/openclaw/provider',{model:'fixture/second'});assert.equal(switched.status,200);assert.equal(switched.body.provider.model,'fixture/second');
  const session=app.sessions.get(token);assert.equal(session.byokProvider.apiKey,'synthetic-private-byok-contract');assert.equal(session.provider.apiKey,undefined);
  assert.equal(JSON.stringify((await call('/api/state')).body).includes('synthetic-private-byok-contract'),false);
  const persisted=await fs.readFile(path.join(app.store.root,'native-provider-owners.json'),'utf8');assert.equal(persisted.includes('apiKey'),false);assert.equal(persisted.includes('synthetic-private-byok-contract'),false);
  const cap={enabled:true,acknowledged:true,tools:['sessions_spawn','cron'],settings:['agents'],delegatedRuns:true,backgroundRuns:true};
  assert.equal((await call('/api/openclaw/native-capabilities',{...cap,tools:['invented_tool']})).status,403);
  assert.equal((await call('/api/openclaw/native-capabilities',{...cap,tools:['read']})).status,403);
  assert.equal((await call('/api/openclaw/native-capabilities',cap)).status,200);
  assert.equal((await call('/api/openclaw/sources',{action:'list'})).body.agentId,parent.id);
  assert.equal((await call('/api/openclaw/sources',{action:'scratch-set',id:'owned-heartbeat',content:'Check the current task.',expectedRevision:0})).status,200);
  assert.deepEqual({...sourceArgs,identity:{agentId:sourceArgs.identity.agentId,genesisHash:sourceArgs.identity.genesisHash}},
    {action:'scratch-set',id:'owned-heartbeat',content:'Check the current task.',expectedRevision:0,identity});
  assert.equal((await call('/api/openclaw/sources',{action:'scratch-set',id:'owned-heartbeat',content:'Check the current task.',expectedRevision:0,agentId:'invented-native-owner'})).status,400);
  const content=Buffer.from('An explicitly selected UTF-8 test document.').toString('base64');
  const uploaded=await call('/api/media/upload',{mimeType:'text/plain',fileName:'notes.txt',content});assert.equal(uploaded.status,200);assert.equal(uploaded.body.asset.id,sha(Buffer.from(content,'base64')));
  const read=await call('/api/media/read',{assetId:uploaded.body.asset.id});assert.equal(read.status,200);assert.equal(read.body.content,content);
  assert.equal((await call('/api/media/read',{assetId:uploaded.body.asset.id,path:'private'})).status,400);
  assert.equal((await call('/api/media/read',{assetId:uploaded.body.asset.id},'https://untrusted.example')).status,403);
  const image=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10,0]),Buffer.from(['Po','QAAAAA'].join(''),'base64')]);
  const imageContent=image.toString('base64');assert.ok(imageContent.includes(['Po','Q'].join('')));
  const imageAsset=await call('/api/media/upload',{mimeType:'image/png',fileName:'transport-fixture.png',content:imageContent});assert.equal(imageAsset.status,200);
  assert.equal((await call('/api/cognition',{learning:false,autoSprout:false,autoRoute:false,semanticRecall:false,revisionLimit:0})).status,200);
  const mediaChat=await call('/api/chat',{message:'Please introduce yourself.',attachments:[imageAsset.body.asset.id]});
  assert.equal(mediaChat.status,200,JSON.stringify(mediaChat.body));
  assert.equal(nativeArgs.attachments[0].content,imageContent,'Terminology normalization must never mutate authenticated binary content.');
  assert.equal(sha(Buffer.from(nativeArgs.attachments[0].content,'base64')),imageAsset.body.asset.id);
  const cache=path.join(app.store.root,'native-media',imageAsset.body.asset.id);
  assert.ok((await fs.realpath(cache)).startsWith(directory+path.sep));await fs.rm(cache,{recursive:true});
  const recovered=await call('/api/media/read',{assetId:imageAsset.body.asset.id});assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.content,imageContent,'A portable canonical source asset remains readable after its app cache is removed.');
  parentHead=(await engine({op:'verify',root:parent.root})).head;
  const binding={ownerKey,nativeSessionKey:'agent:main:subagent:actual-fixture',kind:'subagent',input:'Please introduce yourself.'};
  assert.equal(await adapter.resolveNativeOwner({...binding,ownerKey:parent.id+':'+'a'.repeat(64)}),null);
  const mediaScope=await adapter.resolveNativeOwner({...binding,kind:'media-completion',nativeSessionKey:'agent:main:chainchat-control:'+'d'.repeat(64),
    mediaTask:{taskId:'private-fixture-task'},mediaTaskProof:{id:'private-fixture-proof'},mediaTaskReferences:[]});
  assert.ok(mediaScope);assert.equal(mediaScope.context.root,parent.root,'Media completion uses the original chain and its current equipment.');
  assert.equal((await call('/api/activity')).body.running,true);
  assert.equal((await call('/api/chat',{message:'This must wait for the current native completion.'})).status,409);
  mediaScope.context.onNativeEnd({finalized:false});mediaScope.release();
  assert.equal((await call('/api/activity')).body.running,false);
  assert.deepEqual((await engine({op:'verify',root:parent.root})).head,parentHead);
  const owned=await adapter.resolveNativeOwner(binding);assert.ok(owned);await owned.context.authorize();
  assert.notEqual(owned.context.root,parent.root);assert.equal(owned.config.provider,'native');assert.equal(owned.context.autonomousCommit,true);
  const childState=await owned.context.run(()=>engine({op:'inspect',root:owned.context.root}));assert.equal(childState.head.index,0);assert.deepEqual(childState.genesis.covenant,FRUITS);
  const registration=await adapter.broker.registerInvocation({config:owned.config,args:{system:'',messages:[{role:'user',content:binding.input}]},context:owned.context,sessionKey:binding.nativeSessionKey,invocationId:'actual-owned-run'});
  const enforce=async(op,fields={})=>{const response=await fetch(adapter.broker.url,{method:'POST',headers:{authorization:`Bearer ${adapter.broker.token}`,'content-type':'application/json'},body:JSON.stringify({version:1,op,sessionKey:binding.nativeSessionKey,runId:'owned-run-1',...fields})});return {status:response.status,body:await response.json()};};
  assert.equal((await enforce('admit')).status,200);assert.equal((await enforce('prepare')).status,200);
  const candidate='Hello! I can help you think through questions carefully and acknowledge uncertainty.';
  const finalized=await enforce('finalize',{candidate,candidateSha256:sha(candidate)});assert.equal(finalized.status,200,JSON.stringify(finalized.body));assert.equal(finalized.body.receipt.committed.ring.index,1);
  assert.deepEqual((await engine({op:'verify',root:parent.root})).head,parentHead);
  assert.ok((await engine({op:'verify',root:owned.context.root})).head.index>=finalized.body.receipt.committed.ring.index);
  const childRings=(await fs.readFile(path.join(owned.context.root,'chain','rings.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(childRings.flatMap(ring=>ring.payload?.exchanges||[]).filter(exchange=>exchange.output===candidate).length,1,'Exactly one answer exchange is committed; ordinary canonical faculty growth may append its own records.');
  await adapter.broker.finishInvocation(registration);owned.release();owned.release();
  const revoked=await adapter.resolveNativeOwner({...binding,nativeSessionKey:'agent:main:subagent:revoke-test'});assert.ok(revoked);
  assert.equal((await call('/api/openclaw/native-capabilities',{...cap,enabled:false,tools:[],settings:[],delegatedRuns:false,backgroundRuns:false})).status,200);
  await assert.rejects(revoked.context.authorize());revoked.release();
  assert.equal(await adapter.resolveNativeOwner(binding),null);
  assert.equal((await call('/api/openclaw/native-capabilities',cap)).status,200);
  const pausedChild=await adapter.resolveNativeOwner({...binding,nativeSessionKey:'agent:main:subagent:pause-test'});assert.ok(pausedChild);
  assert.equal((await call('/api/cognition',{mode:'dormant',confirm:true})).status,200);
  assert.equal(pausedChild.context.signal.aborted,true,'Pausing a parent immediately cancels its already admitted descendants.');
  await assert.rejects(pausedChild.context.authorize());pausedChild.release();
  assert.equal((await call('/api/cognition',{mode:'active',confirm:true})).status,200);
  const externalPause=await adapter.resolveNativeOwner({...binding,nativeSessionKey:'agent:main:subagent:cli-pause-test'});assert.ok(externalPause);
  const externalHead=(await engine({op:'inspect',root:parent.root,learning:false})).head.hash;
  await engine({op:'dormancy',root:parent.root,action:'pause',confirmed:true,expectedHead:externalHead,learning:false});
  await assert.rejects(externalPause.context.authorize(),/parent Timechain is paused/);externalPause.release();
  await app.closeRuntime();assert.equal(await adapter.resolveNativeOwner(binding),null);
});
