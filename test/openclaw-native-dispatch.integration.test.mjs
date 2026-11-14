/** Actual upstream dispatcher must traverse the same primitive PoI scope checks. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {once} from 'node:events';import {fileURLToPath} from 'node:url';
import {createOpenClawGateway} from '../openclaw/gateway.mjs';import {createPoIBroker} from '../openclaw/broker.mjs';
import {engine} from '../lib/engine.mjs';import {DIMENSIONS,FRUITS} from '../lib/providers.mjs';
const packageRoot=process.env.CT_OPENCLAW_PACKAGE,nodePath=process.env.CT_OPENCLAW_NODE;
test('actual native dispatch_action preserves fresh target review and scoped read while refusing ungranted writes',{
 skip:!packageRoot||!nodePath?'Set the pinned native runtime.':false,timeout:240000,
},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-native-dispatch-'))),root=path.join(directory,'chain'),files=path.join(directory,'files');
 await fs.mkdir(files);const inputFile=path.join(files,'approved.txt'),outputFile=path.join(files,'never-created.txt');await fs.writeFile(inputFile,'CT_DISPATCH_READ_PROOF');
 const diagnostics=[],calls=[],reviews=[];let manager,broker,plan,issued=false;
 const answer='I can help with care and honesty.';
 const provider=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);calls.push(body);
  const issue=!!plan&&!issued;issued=true;
  const delta=issue?{role:'assistant',tool_calls:[{index:0,id:'dispatch-'+calls.length,type:'function',function:{name:'dispatch_action',arguments:JSON.stringify({id:plan.name,args:plan.params})}}]}:{role:'assistant',content:answer};
  res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'dispatch-fixture',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.end(`data: ${JSON.stringify({id:'dispatch-fixture',choices:[{index:0,delta:{},finish_reason:issue?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{await manager?.close();await broker?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));assert.ok(directory.startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});});
 await engine({op:'init',root,registryRoot:root,name:'Dispatch fixture'});const initial=await engine({op:'inspect',root,registryRoot:root,learning:false}),identity={agentId:'dispatch-fixture',genesisHash:initial.genesis.hash};
 const config={provider:'compatible',model:'fixture',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'synthetic-dispatch-key'};
 const nativeTools=['dispatch_action','tool_search','tool_describe'],nativeCapabilities={enabled:true,acknowledged:true,tools:nativeTools,settings:['tools.toolSearch'],delegatedRuns:false,backgroundRuns:false};
 const toolAuthority={enabled:true,acknowledged:true,tools:['read'],roots:[files],networkHosts:[],allowExecution:false,nativeCapabilities};
 broker=createPoIBroker({engine,review:async(_config,args)=>{reviews.push(args);return{approved:true,scores:Object.fromEntries(DIMENSIONS.map(key=>[key,240])),fruitages:Object.fromEntries(FRUITS.map(key=>[key,240])),usedRings:[],rationale:'Synthetic harmless scoped fixture.'};}});await broker.start();
 manager=createOpenClawGateway({stateDir:path.join(directory,'gateway'),packageRoot,nodePath,broker,nativeCapabilities:()=>nativeCapabilities,pluginPath:fileURLToPath(new URL('../openclaw/plugin',import.meta.url)),onDiagnostic:line=>diagnostics.push(line)});
 try{
  const controls=await manager.describeControls(identity);await manager.updateControls({revision:controls.config.revision,baseHash:controls.config.baseHash,patch:{tools:{toolSearch:true}}});
  const warmup='Initialize the native fixture conversation without tools.';await manager.generate(config,{messages:[{role:'user',content:warmup}],maxTokens:512,nativeControl:{kind:'message',sessionKey:(await manager.sessionControls(identity)).sessionKey}},{root,input:warmup,purpose:'candidate',learning:false,loadout:[],nativeIdentity:identity,authorize:async()=>{}});
  const catalogue=await manager.toolCatalogue(identity);assert.ok(catalogue.tools.some(tool=>tool.id==='dispatch_action'),'Owner discovery exposes the actual dispatcher: '+JSON.stringify({tools:catalogue.tools.map(tool=>tool.id),preview:catalogue.preview?.groups?.map(group=>({id:group.id,tools:group.tools?.map(tool=>tool.id)})),notices:catalogue.preview?.notices}));
  const generate=async next=>{plan=next;issued=false;const input='Perform the synthetic scoped dispatcher test.';return manager.generate(config,{messages:[{role:'user',content:input}],maxTokens:512,nativeControl:{kind:'message',sessionKey:(await manager.sessionControls(identity)).sessionKey}}, {root,input,purpose:'candidate',learning:false,loadout:[],nativeIdentity:identity,nativeTools,toolAuthority,authorize:async()=>{}});};
  const read=await generate({name:'read',params:{path:inputFile}});assert.equal(read.text,answer);
  const observation=read.enforcement.toolObservations.find(row=>row.name==='read');assert.equal(observation?.success,true,'The dispatched actual read returns a matched primitive observation.');assert.ok(JSON.stringify(observation.result).includes('CT_DISPATCH_READ_PROOF'));
  assert.ok(reviews.some(review=>review.candidate.includes('proposed-host-tool-action')&&review.candidate.includes('dispatch_action')));
  assert.ok(reviews.some(review=>review.candidate.includes('proposed-host-tool-action')&&review.candidate.includes('read')));
  const before=reviews.length;const denied=await generate({name:'write',params:{path:outputFile,content:'never'}});assert.equal(denied.text,answer);await assert.rejects(fs.stat(outputFile),error=>error.code==='ENOENT');assert.equal(denied.enforcement.toolObservations.some(row=>row.name==='write'&&row.success),false);
  assert.equal(reviews.slice(before).some(review=>review.candidate.includes('"name":"write"')),false,'Ungrantable target is refused before semantic execution review.');
  assert.ok(calls.some(body=>(body.tools||[]).some(tool=>tool.function?.name==='dispatch_action')));
 }catch(error){t.diagnostic(JSON.stringify({code:error.code||'ASSERTION',calls:calls.map(body=>({tools:(body.tools||[]).map(tool=>tool.function?.name),results:body.messages.filter(message=>message.role==='tool').map(message=>JSON.stringify(message.content).slice(0,600))}))}));t.diagnostic(diagnostics.join('').slice(-5000));throw error;}
});
