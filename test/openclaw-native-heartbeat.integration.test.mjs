/** Real native heartbeat owner enrollment, not a prompt-claimed source. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import {fileURLToPath} from 'node:url';
import {createOpenClawGateway} from '../openclaw/gateway.mjs';import {createPoIBroker} from '../openclaw/broker.mjs';import {engine} from '../lib/engine.mjs';import {DIMENSIONS,FRUITS} from '../lib/providers.mjs';import {currentCanonicalSkill} from '../lib/canonical-skill.mjs';
const packageRoot=process.env.CT_OPENCLAW_PACKAGE,nodePath=process.env.CT_OPENCLAW_NODE;
test('actual native heartbeat requires owner enrollment and every accepted iteration wears canonical policy and seals a separate verified chain',{
 skip:!packageRoot||!nodePath?'Set the pinned native runtime.':false,timeout:300000,
},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-native-heartbeat-'))),root=path.join(directory,'parent'),childRoot=path.join(directory,'heartbeat');
 const diagnostics=[],calls=[],bindings=[],admissions=[];let manager,broker,child,eligible=false,monitor;
 const canonicalSkill=(await currentCanonicalSkill()).skill;
 const provider=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),messages=JSON.stringify(body.messages||[]);
  const text=(body.messages||[]).map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
  assert.ok(text.includes(canonicalSkill),'Every actual enrolled heartbeat inference wears the full canonical skill.');assert.equal(raw.includes('[CHAINCHAT_PRIVATE_MODEL_ROUTE:'),false);
  calls.push({canonical:true,heartbeat:messages.includes('CT_REAL_HEARTBEAT')});
  res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'heartbeat-fixture',choices:[{index:0,delta:{role:'assistant',content:'I can help with care and honesty.'},finish_reason:null}]})}\n\n`);
  res.end(`data: ${JSON.stringify({id:'heartbeat-fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{await manager?.close();await broker?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));assert.ok(directory.startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});});
 await engine({op:'init',root,registryRoot:root,name:'Heartbeat parent fixture'});const initial=await engine({op:'inspect',root,registryRoot:root,learning:false});
 const identity={agentId:'heartbeat-parent',genesisHash:initial.genesis.hash},ownerKey=identity.agentId+':'+identity.genesisHash;
 const config={provider:'compatible',model:'fixture',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'synthetic-heartbeat-key'};
 const nativeCapabilities={enabled:true,acknowledged:true,tools:[],settings:['agents.defaults.heartbeat'],delegatedRuns:false,backgroundRuns:true};
 broker=createPoIBroker({engine,review:async()=>({approved:true,scores:Object.fromEntries(DIMENSIONS.map(name=>[name,240])),fruitages:Object.fromEntries(FRUITS.map(name=>[name,240])),usedRings:[],rationale:'Synthetic harmless native heartbeat fixture.'})});await broker.start();
 // Read-only fixture observation of the actual private lifecycle input. It
 // forwards the original callback/request and grants no missing provenance.
 const setLifecycle=broker.setNativeLifecycle.bind(broker);broker.setNativeLifecycle=callbacks=>setLifecycle({...callbacks,admit:async request=>{admissions.push({op:request.op,nativeContext:request.nativeContext});return callbacks.admit(request);}});
 manager=createOpenClawGateway({stateDir:path.join(directory,'gateway'),packageRoot,nodePath,broker,nativeCapabilities:()=>nativeCapabilities,pluginPath:fileURLToPath(new URL('../openclaw/plugin',import.meta.url)),onDiagnostic:line=>diagnostics.push(line),
  resolveNativeModelRoute:async({ownerKey:key})=>{assert.equal(key,ownerKey);return{config,authorize:async()=>{}};},
  resolveNativeOwner:async binding=>{assert.equal(eligible,true,'A timer without explicit enrollment never acquires a canonical owner.');assert.equal(binding.kind,'heartbeat');assert.equal(binding.ownerKey,ownerKey);bindings.push(binding);
   if(!child){await engine({op:'init',root:childRoot,registryRoot:childRoot,name:'Heartbeat child fixture'});const state=await engine({op:'inspect',root:childRoot,registryRoot:childRoot,learning:false});child={agentId:'heartbeat-child',genesisHash:state.genesis.hash};}
   return{config,context:{root:childRoot,input:binding.input,purpose:'candidate',learning:false,loadout:[],nativeIdentity:child,nativeOwnerKey:ownerKey,autonomousCommit:true,authorize:async()=>{}},release:async()=>{}};
  }});
 try{
  // Current upstream persists heartbeat monitors in Automations; a cadence
  // cannot tick while the owner's native scheduler remains disabled.
  await manager.enableManagedAutomation();
  const controls=await manager.describeControls(identity);await manager.updateControls({revision:controls.config.revision,patch:{logging:{consoleLevel:'debug'},agents:{defaults:{heartbeat:{every:'3s',timeoutSeconds:30,prompt:'CT_REAL_HEARTBEAT: Please say you can help with care and honesty.',target:'none'}}}}});
  const liveConfig=(await manager.describeControls(identity)).nativeConfig.config;
  assert.equal(liveConfig.cron.enabled,true);
  const heartbeatView=value=>value?{every:value.every,timeoutSeconds:value.timeoutSeconds,agentId:value.agentId,target:value.target}:null;
  t.diagnostic(JSON.stringify({nativeHeartbeat:heartbeatView(liveConfig.agents?.defaults?.heartbeat),agentHeartbeats:(Array.isArray(liveConfig.agents?.entries)?liveConfig.agents.entries:Array.isArray(liveConfig.agents?.list)?liveConfig.agents.list:[]).map(row=>({id:row.id,heartbeat:heartbeatView(row.heartbeat)}))}));
  const roster=await manager.nativeSources({identity,action:'list'});assert.ok(roster.available.agents.some(row=>row.id==='main'&&row.heartbeat===true));
  await new Promise(resolve=>setTimeout(resolve,4000));assert.equal(bindings.length,0);assert.equal(calls.length,0);
  eligible=true;const enrolled=await manager.nativeSources({identity,action:'enroll',source:{kind:'heartbeat',agentId:'main'}});assert.equal(enrolled.sources.length,1);
  // Upstream creates an empty private monitor scratch and intentionally skips
  // ambient model work until the owner supplies a real checklist.
  const notes=await manager.nativeSources({identity,action:'scratch-get',id:enrolled.sources[0].id});
  const saved=await manager.nativeSources({identity,action:'scratch-set',id:enrolled.sources[0].id,content:'CT_REAL_HEARTBEAT: Please check whether you can help with care and honesty.',expectedRevision:notes.currentRevision});
  assert.equal(saved.content,'CT_REAL_HEARTBEAT: Please check whether you can help with care and honesty.');
  monitor=saved.monitor;assert.equal(monitor.enabled,true,'The actual configured native monitor must be enabled.');assert.equal(monitor.intervalMs,3000);
  // The native scheduler deliberately defers missed heartbeat monitors by
  // 120 seconds at startup (scheduler-actor.worker, default12e4). Honor its
  // persisted due time; do not change app deadlines or force a manual run.
  assert.ok(Number.isSafeInteger(monitor.nextRunAtMs));assert.ok(monitor.nextRunAtMs-Date.now()<=125000);
  const deadline=Math.max(Date.now()+30000,monitor.nextRunAtMs+30000);let state;
  while(Date.now()<deadline){if(child){state=await engine({op:'inspect',root:childRoot,registryRoot:childRoot,learning:false});if(state.head.index>=1)break;}await new Promise(resolve=>setTimeout(resolve,100));}
  monitor=(await manager.nativeSources({identity,action:'scratch-get',id:enrolled.sources[0].id})).monitor;
  assert.ok(bindings.length>=1,'The actual native scheduler must acquire a privately enrolled owner.');assert.equal(state?.verified,true);assert.ok(state.head.index>=1);assert.ok(calls.length>=1&&calls.every(call=>call.canonical&&call.heartbeat));
  assert.deepEqual((await engine({op:'inspect',root,registryRoot:root,learning:false})).head,initial.head);
  await manager.nativeSources({identity,action:'revoke',id:enrolled.sources[0].id});assert.deepEqual((await manager.nativeSources({identity,action:'list'})).sources,[]);
 }catch(error){t.diagnostic(JSON.stringify({code:error.code||'ASSERTION',monitor,bindings:bindings.length,calls,admissions}));t.diagnostic(diagnostics.join('').slice(-15000));throw error;}
});
