/** Force the real idle→send race without forging an SDK frame or a proof. */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import {fileURLToPath,pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';
import {createOpenClawGateway} from '../openclaw/gateway.mjs';import {createPoIBroker} from '../openclaw/broker.mjs';import {engine} from '../lib/engine.mjs';import {controlSessionKey} from '../lib/openclaw-controls.mjs';import {DIMENSIONS,FRUITS} from '../lib/providers.mjs';import {currentCanonicalSkill} from '../lib/canonical-skill.mjs';
const packageRoot=process.env.CT_OPENCLAW_PACKAGE,nodePath=process.env.CT_OPENCLAW_NODE;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
test('actual queued native run binds its typed original input while a revoked prior actor cannot retry or deliver',{
 skip:!packageRoot||!nodePath?'Set the reviewed native runtime.':false,timeout:240000,
},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-native-queued-'))),root=path.join(directory,'agent'),diagnostics=[],admissions=[],calls=[];
 const answer='I can help with care and honesty.',input='Please introduce yourself with care and honesty.',foreignInput='A separate admitted native event is cancelled before this next owner turn.',foreignId=randomUUID(),foreignSeen=deferred(),releaseForeign=deferred();
 let manager,broker,relay,ownerNonce,boundProof,injected=false,foreignInjected=false,queuedReceipt=false,foreignTimer,client,providerError;
 const canonicalSkill=(await currentCanonicalSkill()).skill;
 const provider=http.createServer(async(req,res)=>{try{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);calls.push(body);
  const text=(body.messages||[]).map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
  assert.equal(raw.includes('[CHAINCHAT_PRIVATE_MODEL_ROUTE:'),false);assert.ok(text.includes(canonicalSkill));assert.equal(text.split(canonicalSkill).length-1,1);
  if(text.includes(foreignInput)){foreignSeen.resolve();await releaseForeign.promise;}
  res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'queued-fixture',choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({id:'queued-fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
  }catch(error){providerError=error;foreignSeen.resolve();res.writeHead(500,{'content-type':'application/json'});res.end('{"error":{"message":"Synthetic fixture assertion failed."}}');}
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const {GatewayClient}=await import(pathToFileURL(path.join(packageRoot,'dist/plugin-sdk/gateway-runtime.js')).href),request=GatewayClient.prototype.request;
 GatewayClient.prototype.request=async function(method,params,...options){
  client=this;
  if(method!=='chat.send'||params.message!==input||injected)return request.call(this,method,params,...options);
  injected=true;assert.equal(params.queueMode,'followup');assert.equal(params.idempotencyKey,ownerNonce);
  // The previous admitted run is genuinely still executing at its provider;
  // this actual followup must retain the new input's typed original nonce.
  const ack=await request.call(this,method,params,...options);
  // ACK precedes actual dispatch. Synchronize with the upstream's exact
  // accepted-input custody receipt, not timing or a client-run alias.
  const until=Date.now()+15000;
  while(Date.now()<until){const history=await request.call(this,'chat.history',{sessionKey:params.sessionKey,limit:1,maxBytes:4096,inputRunIds:[ownerNonce]});
   if(history.inputReceipts?.some(row=>row.runId===ownerNonce&&row.state==='pending'&&row.queued===true)){queuedReceipt=true;break;}
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(queuedReceipt,true,'The actual native input must be accepted into its queued followup custody before the prior run finishes.');
  releaseForeign.resolve();return ack;
 };
 t.after(async()=>{releaseForeign.resolve();clearTimeout(foreignTimer);GatewayClient.prototype.request=request;await manager?.close();relay?.closeAllConnections();if(relay)await new Promise(resolve=>relay.close(resolve));await broker?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));assert.ok(directory.startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});});
 await engine({op:'init',root,registryRoot:root,name:'Queued native input fixture'});const state=await engine({op:'inspect',root,registryRoot:root,learning:false}),identity={agentId:'queued-input',genesisHash:state.genesis.hash};
 broker=createPoIBroker({engine,review:async()=>({approved:true,scores:Object.fromEntries(DIMENSIONS.map(name=>[name,240])),fruitages:Object.fromEntries(FRUITS.map(name=>[name,240])),usedRings:[],rationale:'Synthetic harmless queued-input fixture.'})});await broker.start();
 const register=broker.registerInvocation.bind(broker),finish=broker.finishInvocation.bind(broker);
 broker.registerInvocation=async args=>{
  ownerNonce=args.context.expectedClientInputId;
  if(foreignInjected)return register(args);foreignInjected=true;
  // This happens after the Gateway's real idle proof. Start an actual admitted
  // run, await its provider, then revoke only that fixture claim. The native
  // runtime is still active while the independently owned next claim is made.
  const foreign=await register({...args,invocationId:foreignId,context:{...args.context,input:foreignInput,expectedClientInputId:foreignId}});
  await request.call(client,'chat.send',{sessionKey:args.sessionKey,message:foreignInput,idempotencyKey:foreignId,queueMode:'followup',deliver:false});
  await Promise.race([foreignSeen.promise,new Promise((_,reject)=>{foreignTimer=setTimeout(()=>reject(new Error('The actual admitted native run did not reach its provider.')),15000);})]);clearTimeout(foreignTimer);if(providerError)throw providerError;
  await finish(foreign);
  return register(args);
 };
 broker.finishInvocation=async ref=>{const current=broker.nativeInvocation(controlSessionKey(identity));if(current?.claimId===ref.claimId)boundProof={runId:current.runId,proof:current.nativeInputProof};return finish(ref);};
 relay=http.createServer(async(req,res)=>{try{const parts=[];for await(const part of req)parts.push(part);const raw=Buffer.concat(parts),packet=JSON.parse(raw);
   if(packet.op==='admit')admissions.push({runId:packet.runId,sourceMatches:packet.nativeContext?.currentSourceTurnId===ownerNonce+':user',sourceTurn:packet.nativeContext?.currentSourceTurnId,keys:Object.keys(packet.nativeContext||{})});
   const forwarded=await fetch(broker.url,{method:'POST',redirect:'error',headers:{authorization:req.headers.authorization,'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(30000)});const body=Buffer.from(await forwarded.arrayBuffer());res.writeHead(forwarded.status,{'content-type':'application/json'});res.end(body);
  }catch{res.writeHead(502,{'content-type':'application/json'});res.end('{"allowed":false}');}});relay.listen(0,'127.0.0.1');await once(relay,'listening');
 const observed=Object.create(broker);Object.defineProperty(observed,'url',{get:()=>`http://127.0.0.1:${relay.address().port}/v1/enforce`});
 manager=createOpenClawGateway({stateDir:path.join(directory,'gateway'),packageRoot,nodePath,broker:observed,pluginPath:fileURLToPath(new URL('../openclaw/plugin',import.meta.url)),onDiagnostic:line=>diagnostics.push(line)});
 await manager.configureNativeProvider({identity,provider:'queued-native',configuration:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,api:'openai-completions',models:[{id:'fixture',name:'Synthetic queued native model',reasoning:false,input:['text'],contextWindow:131072,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}});
 await manager.nativeAuth({identity,action:'key',provider:'queued-native',apiKey:'synthetic-queued-fixture-key'});await manager.setNativeModel(identity,'queued-native/fixture');
 const config={provider:'native',tier:'native',model:'queued-native/fixture',contextWindow:131072,maxOutputTokens:4096,reasoningCapable:false};
 try{
  const result=await manager.generateNative(config,{messages:[{role:'user',content:input}],maxTokens:512,nativeControl:{kind:'message',sessionKey:controlSessionKey(identity)}},{root,input,purpose:'candidate',learning:false,loadout:[],settings:{recall:false},nativeIdentity:identity,authorize:async()=>{}});
  if(providerError)throw providerError;
  assert.equal(result.text,answer);assert.equal(result.enforcement.reviewed,true);assert.equal(calls.length,2,'Only the previously admitted run and the separate queued owner input reach the model.');
  assert.ok(admissions.some(row=>row.runId===foreignId&&!row.sourceMatches));assert.ok(admissions.some(row=>row.runId!==foreignId&&row.runId!==ownerNonce&&row.sourceMatches),'The actual queued SDK run must have a new ID and the exact typed original nonce.');
  assert.notEqual(boundProof.runId,ownerNonce);assert.deepEqual(boundProof.proof,{kind:'source-turn',inputId:ownerNonce});assert.equal(broker.nativeInvocation(controlSessionKey(identity)),null);
  assert.deepEqual((await engine({op:'inspect',root,registryRoot:root,learning:false})).head,state.head);
  t.diagnostic(JSON.stringify({previousClaimRevoked:true,queuedInputReceiptObserved:queuedReceipt,queuedNativeIdDiffersFromInputNonce:true,typedSourceNonceMatched:true,modelCalls:calls.length}));
 }catch(error){releaseForeign.resolve();t.diagnostic(JSON.stringify({code:error.code||'ASSERTION',injected,ownerNonce,foreignId,admissions,modelCalls:calls.length,callKinds:calls.map(call=>{const last=(call.messages||[]).filter(row=>row.role==='user').at(-1);return{owner:JSON.stringify(last?.content).includes(input),previous:JSON.stringify(last?.content).includes(foreignInput),model:call.model};}),boundProof}));t.diagnostic(diagnostics.join('').slice(-7000));throw error;}
});
