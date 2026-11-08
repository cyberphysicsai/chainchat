/** Real native paid-profile defaults must never bill a proxy-owned child. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import {fileURLToPath,pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';
import {createOpenClawGateway} from '../openclaw/gateway.mjs';import {createPoIBroker} from '../openclaw/broker.mjs';import {engine} from '../lib/engine.mjs';import {DIMENSIONS,FRUITS} from '../lib/providers.mjs';import {controlSessionKey} from '../lib/openclaw-controls.mjs';import {currentCanonicalSkill} from '../lib/canonical-skill.mjs';
import {createMixedRouteResponsePlan,parentDirective} from './fixtures/mixed-route-response-plan.mjs';
const packageRoot=process.env.CT_OPENCLAW_PACKAGE,nodePath=process.env.CT_OPENCLAW_NODE;
test('actual native paid default cannot replace BYOK child transport, and native mode still works',{
 skip:!packageRoot||!nodePath?'Set the reviewed native package and Node paths.':false,timeout:420000,
},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-mixed-route-')));
 const canonicalSkill=(await currentCanonicalSkill()).skill,answer='I can help with care and honesty.';
 const calls=[],diagnostics=[],children=new Map(),routes=new Map(),responsePlan=createMixedRouteResponsePlan(),registrations=[],lifecycle=[],fixedDiagnostics=[];
 const began=Date.now();let manager,broker,phase='setup',failed=false,restoreRpc=()=>{},diagnosticBytes=0,omittedDiagnostics=0,omittedEvents=0,generation=0;
 const record=fields=>{if(lifecycle.length<2048)lifecycle.push({ms:Date.now()-began,phase,...fields});else omittedEvents++;};
 const diagnostic=line=>{
  const safe=String(line).replaceAll('synthetic-native-model-key','[SYNTHETIC_KEY]').replace(/synthetic-byok-route-key-[ab]/g,'[SYNTHETIC_KEY]');
  for(const match of safe.matchAll(/^\[chainchat\] (?:mandatory context fault reason=[A-Z_]+|native lifecycle event=[a-z-]+ generation=[0-9A-Z]+ code=[0-9a-zA-Z]+ signal=[A-Za-z]+)\r?$/gm))
   if(fixedDiagnostics.length<64)fixedDiagnostics.push(match[0]);
  if(diagnosticBytes+Buffer.byteLength(safe)<=512*1024){diagnostics.push(safe);diagnosticBytes+=Buffer.byteLength(safe);}else omittedDiagnostics++;
 };
 const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),native=req.url.startsWith('/native/');
  const text=(body.messages||[]).map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
  calls.push({phase,native,canonical:text.includes(canonicalSkill),privateMarker:raw.includes('[CHAINCHAT_PRIVATE_MODEL_ROUTE:'),model:body.model,auth:req.headers.authorization});
  const spawn=responsePlan.next(body.messages,{native});
  const delta=spawn?{role:'assistant',tool_calls:[{index:0,id:'mixedspawn'+spawn,type:'function',function:{name:'sessions_spawn',arguments:JSON.stringify({task:'CT_CHILD_TASK_'+spawn+': Please say you can help with care and honesty.',runtime:'subagent',agentId:'main',model:'fixture-native/paid',mode:'run',cleanup:'keep'})}}]}:{role:'assistant',content:answer};
  res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'mixed-route',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({id:'mixed-route',choices:[{index:0,delta:{},finish_reason:spawn?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{record({kind:'cleanup-start'});await manager?.close();restoreRpc();await broker?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));assert.ok(directory.startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  if(failed){t.diagnostic(JSON.stringify({lifecycle,omittedEvents,fixedDiagnostics,diagnosticBytes,omittedDiagnostics}));t.diagnostic(diagnostics.join(''));}});
 async function parentFor(label) {
  const root=path.join(directory,'parent-'+label);
  await engine({op:'init',root,registryRoot:root,name:'Mixed route parent '+label});
  const initial=await engine({op:'inspect',root,registryRoot:root,learning:false});
  const identity={agentId:'mixed-route-parent-'+label,genesisHash:initial.genesis.hash};
  return {root,initial,identity,ownerKey:identity.agentId+':'+identity.genesisHash};
 }
 const nativeParent=await parentFor('native');
 const nativeCapabilities={enabled:true,acknowledged:true,tools:['sessions_spawn'],settings:[],delegatedRuns:true,backgroundRuns:false};
 const toolAuthority={enabled:true,acknowledged:true,tools:[],roots:[],networkHosts:[],allowExecution:false,nativeCapabilities};
 const context=({root,identity,ownerKey},input)=>({root,input,purpose:'candidate',learning:false,loadout:[],settings:{recall:false},nativeIdentity:identity,nativeOwnerKey:ownerKey,nativeTools:['sessions_spawn'],toolAuthority,authorize:async()=>{}});
 broker=createPoIBroker({engine,review:async()=>({approved:true,scores:Object.fromEntries(DIMENSIONS.map(name=>[name,240])),fruitages:Object.fromEntries(FRUITS.map(name=>[name,240])),usedRings:[],rationale:'Synthetic local harmless route regression.'})});await broker.start();
 const register=broker.registerInvocation.bind(broker),finish=broker.finishInvocation.bind(broker);
 broker.registerInvocation=async input=>{const result=await register(input);registrations.push({phase,sessionKey:input.sessionKey,invocationId:input.invocationId,expected:input.context.expectedClientInputId||input.context.expectedNativeRunId,claimId:result.claimId});return result;};
 broker.finishInvocation=async input=>{const entry=registrations.find(row=>row.claimId===input.claimId);if(entry){const current=broker.nativeInvocation(entry.sessionKey);entry.observed=current?.claimId===input.claimId?current.runId:null;entry.sourceProof=current?.claimId===input.claimId?current.nativeInputProof:undefined;}return finish(input);};
 const runtime=await import(pathToFileURL(path.join(packageRoot,'dist/plugin-sdk/gateway-runtime.js')).href),originalRpc=runtime.GatewayClient.prototype.request;
 runtime.GatewayClient.prototype.request=async function(method,...args){
  const name=typeof method==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(method)?method:'UNKNOWN';record({kind:'rpc',method:name,event:'start'});
  try{const result=await originalRpc.call(this,method,...args);record({kind:'rpc',method:name,event:'end'});return result;}
  catch(error){record({kind:'rpc',method:name,event:'error',closed1006:String(error?.message||'').includes('(1006)')});throw error;}
 };
 restoreRpc=()=>{runtime.GatewayClient.prototype.request=originalRpc;};
 manager=createOpenClawGateway({stateDir:path.join(directory,'gateway'),packageRoot,nodePath,broker,deferNativeSources:true,pluginPath:fileURLToPath(new URL('../openclaw/plugin',import.meta.url)),onDiagnostic:diagnostic,
  spawnImpl:(...args)=>{const ownGeneration=++generation,child=spawn(...args);record({kind:'spawn',generation:ownGeneration});
   child.on('exit',(code,signal)=>record({kind:'exit',generation:ownGeneration,code:Number.isInteger(code)?code:null,signal:['SIGTERM','SIGKILL','SIGINT','SIGHUP','SIGABRT','SIGSEGV','SIGBUS','SIGILL'].includes(signal)?signal:null}));
   const kill=child.kill.bind(child);child.kill=signal=>{record({kind:'supervisor-kill',generation:ownGeneration,signal:['SIGTERM','SIGKILL','SIGINT'].includes(signal)?signal:'OTHER'});return kill(signal);};
   const send=child.send?.bind(child);if(send)child.send=(message,...rest)=>{record({kind:'supervisor-ipc',generation:ownGeneration,shutdown:message?.type==='chainchat:shutdown'});return send(message,...rest);};return child;},
  resolveNativeModelRoute:async({ownerKey})=>routes.get(ownerKey)||null,resolveNativeOwner:async binding=>{
  const route=routes.get(binding.ownerKey);if(!route)return null;
  assert.equal(binding.kind,'subagent');let child=children.get(binding.nativeSessionKey);
  if(!child){const childRoot=path.join(directory,'child-'+createHash('sha256').update(binding.nativeSessionKey).digest('hex'));await engine({op:'init',root:childRoot,registryRoot:childRoot,name:'Mixed route child'});const state=await engine({op:'inspect',root:childRoot,registryRoot:childRoot,learning:false});child={phase:route.phase,root:childRoot,identity:{agentId:'child-'+children.size,genesisHash:state.genesis.hash}};children.set(binding.nativeSessionKey,child);}
  return{config:route.config,context:{...context(route.parent,binding.input),authorize:route.authorize,root:child.root,nativeIdentity:child.identity,autonomousCommit:true},release:async()=>{}};
 }});
 try{
  const base=`http://127.0.0.1:${provider.address().port}`;
  await manager.configureNativeProvider({identity:nativeParent.identity,provider:'fixture-native',configuration:{baseUrl:base+'/native/v1',api:'openai-completions',models:[{id:'paid',name:'Synthetic native profile, no real fees',reasoning:false,input:['text'],contextWindow:131072,maxTokens:4096,cost:{input:1,output:1,cacheRead:0,cacheWrite:0}}]}});
  await manager.nativeAuth({identity:nativeParent.identity,action:'key',provider:'fixture-native',apiKey:'synthetic-native-model-key'});await manager.setNativeModel(nativeParent.identity,'fixture-native/paid');
  assert.equal(calls.length,0,'Onboarding must not silently start native model inference.');
  for(const selected of ['byok-a','byok-b']){
   phase=selected;
   // A child ledger commit can precede OpenClaw's requester announcement. Use
   // distinct requester sessions and keep each private route bound to its owner.
   const owner=await parentFor(selected);
   const config={provider:'compatible',tier:'byok',model:'proxy-fixture',baseUrl:base+'/proxy/v1',apiKey:'synthetic-byok-route-key-'+selected.at(-1),contextWindow:131072,maxOutputTokens:4096};
   const route={parent:owner,phase:selected,config,authorize:async()=>{
    if(routes.get(owner.ownerKey)!==route)throw Object.assign(new Error('Fixture owner retired.'),{code:'SESSION_CHANGED'});
   }};
   routes.set(owner.ownerKey,route);
   const input='CT_PARENT_SPAWN: Start the requested native child task, then say you can help with care and honesty.';
   const parent=await manager.generate(config,{system:parentDirective(selected),messages:[{role:'user',content:input}],maxTokens:512,nativeControl:{kind:'message',sessionKey:controlSessionKey(owner.identity)}},context(owner,input));
   assert.equal(parent.text,answer);assert.equal(parent.enforcement.reviewed,true);manager.resumeNativeSources();
   const deadline=Date.now()+60000;let accepted=false;
   while(Date.now()<deadline){for(const child of children.values())if(child.phase===selected){const state=await engine({op:'inspect',root:child.root,registryRoot:child.root,learning:false});if(state.verified&&state.head.index>=1)accepted=true;}if(accepted)break;await new Promise(resolve=>setTimeout(resolve,100));}
   assert.equal(accepted,true,'The actual '+selected+' child must finish through the admitted proxy, despite its explicit native paid model override.');
   assert.equal(calls.filter(call=>call.native).length,0,'No native paid-profile request is allowed during '+selected+' ownership.');assert.ok(calls.filter(call=>call.phase===selected).length>=3);
   assert.ok(calls.filter(call=>call.phase===selected).every(call=>call.model==='proxy-fixture'&&call.auth==='Bearer '+config.apiKey&&call.canonical&&!call.privateMarker));
   routes.delete(owner.ownerKey);
   assert.deepEqual((await engine({op:'inspect',root:owner.root,registryRoot:owner.root,learning:false})).head,owner.initial.head);
  }
  phase='native-final';const native={provider:'native',tier:'native',model:'fixture-native/paid',contextWindow:131072,maxOutputTokens:4096,reasoningCapable:false},input='Please introduce yourself with care and honesty.';
  const result=await manager.generateNative(native,{messages:[{role:'user',content:input}],maxTokens:512},context(nativeParent,input));assert.equal(result.text,answer);assert.equal(result.enforcement.reviewed,true);
  assert.ok(calls.some(call=>call.native&&call.phase==='native-final'&&call.model==='paid'&&call.auth==='Bearer synthetic-native-model-key'));
  assert.ok(calls.every(call=>call.canonical&&!call.privateMarker));assert.deepEqual((await engine({op:'inspect',root:nativeParent.root,registryRoot:nativeParent.root,learning:false})).head,nativeParent.initial.head);
  assert.ok(registrations.every(row=>!row.expected||!row.observed||row.expected===row.observed||row.sourceProof?.kind==='source-turn'&&row.sourceProof.inputId===row.expected),'Unrelated native turns must never consume a foreground request claim.');
  t.diagnostic(JSON.stringify({proxyPhasePaidCounter:Object.fromEntries(['byok-a','byok-b'].map(route=>[route,calls.filter(row=>row.phase===route&&row.native).length])),nativePositive:calls.some(row=>row.native&&row.phase==='native-final')}));
 }catch(error){failed=true;t.diagnostic(JSON.stringify({phase,code:error.code||'ASSERTION',runtimeRunningAtFailure:manager?.status().running===true,children:[...children.values()].map(child=>({phase:child.phase})),calls:calls.map(({auth,...safe})=>safe),registrations:registrations.map(({claimId,sessionKey,...safe})=>safe)}));throw error;}
});
