import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {createApp} from '../server.mjs';

test('restart reopens the explicitly selected Timechain while native child creation and provider keys cannot replace the preference',{timeout:90000},async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-selected-session-')));let app,adapter;
  const model='fixture/native',factory=options=>{adapter=options;return{start:async()=>{},close:async()=>{},resumeNativeSources:async()=>{},status:()=>({backend:'openclaw',running:true}),
    nativeModels:async()=>({configured:true,current:model,models:[{id:model,available:true}]}),setNativeModel:async()=>{},
    generateNative:async()=>{throw new Error('Selection must not call a model.');},completeNative:async()=>{throw new Error('Selection must not call a reviewer.');},
    toolCatalogue:async()=>({tools:[{name:'sessions_spawn'}]}),describeControls:async()=>({}),executeCommand:async()=>({})};};
  async function close(){if(!app)return;await app.closeRuntime();app.server.closeAllConnections();if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));app=null;}
  t.after(async()=>{await close();assert.ok(path.basename(root).startsWith('ct-selected-session-'));await fs.rm(root,{recursive:true,force:true});});
  let base,token;
  async function request(endpoint,payload){const result=await fetch(base+endpoint,{method:payload===undefined?'GET':'POST',headers:{origin:base,...(token?{authorization:`Bearer ${token}`}:{ }),...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});return{status:result.status,body:await result.json()};}
  async function open(){app=await createApp({dataDir:root,canonicalUpdates:false,pairingCode:'SELECTION-ONLY',openclaw:{},openclawFactory:factory});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base=`http://127.0.0.1:${app.server.address().port}`;token=null;token=(await request('/api/pair',{code:'SELECTION-ONLY'})).body.token;return request('/api/state');}
  await open();const first=(await request('/api/agents',{name:'Existing Codex Timechain'})).body.agent;
  const second=(await request('/api/agents',{name:'Another Timechain'})).body.agent;assert.equal(app.store.selectedId,second.id);
  const firstRoot=app.store.agents.find(row=>row.id===first.id).root,secondRoot=app.store.agents.find(row=>row.id===second.id).root;
  const before=await Promise.all([firstRoot,secondRoot].map(directory=>fs.readFile(path.join(directory,'chain','rings.jsonl'))));
  assert.equal((await request('/api/agents/pair',{root:firstRoot})).body.agent.id,first.id);assert.equal(app.store.selectedId,first.id);
  assert.equal((await request('/api/agents/select',{id:second.id})).body.agent.id,second.id);assert.equal(app.store.selectedId,second.id);
  assert.equal((await request('/api/agents/select',{id:first.id})).body.agent.id,first.id);
  const secret='synthetic-selection-memory-only-provider-key';assert.equal((await request('/api/provider',{provider:'compatible',model:'fixture/byok',baseUrl:'http://127.0.0.1:9999/v1',apiKey:secret})).status,200);
  const nativeSelected=await request('/api/openclaw/provider',{model});assert.equal(nativeSelected.status,200,JSON.stringify(nativeSelected.body));
  assert.equal((await request('/api/openclaw/native-capabilities',{enabled:true,acknowledged:true,tools:['sessions_spawn'],settings:[],delegatedRuns:true,backgroundRuns:false})).status,200);
  const child=await adapter.resolveNativeOwner({ownerKey:first.id+':'+first.genesis.hash,kind:'subagent',nativeSessionKey:'agent:main:subagent:selected-fixture',chainKey:'native-selected-fixture',input:'A synthetic native child request.'});
  assert.ok(child);assert.notEqual(child.context.root,firstRoot);child.release();assert.equal(app.store.selectedId,first.id);
  for(const file of['agents.json','selected-agent.json']){const bytes=await fs.readFile(path.join(root,file),'utf8');assert.equal(bytes.includes(secret),false);assert.equal(bytes.includes(token),false);assert.equal(bytes.includes('apiKey'),false);}
  assert.ok(Array.isArray(JSON.parse(await fs.readFile(path.join(root,'agents.json'),'utf8'))),'An earlier app release must still be able to read the index.');
  await close();const reopened=await open();assert.equal(reopened.body.agent.id,first.id);assert.equal(reopened.body.provider.configured,false);
  for(const [index,directory]of[firstRoot,secondRoot].entries())assert.deepEqual(await fs.readFile(path.join(directory,'chain','rings.jsonl')),before[index]);
  await close();await fs.writeFile(path.join(root,'selected-agent.json'),JSON.stringify({version:1,selectedId:'unknown-retired-selection'}));
  assert.equal((await open()).body.agent.id,first.id,'Invalid persisted selection falls back to the first registered chain.');
});
