/** Real native sessions_spawn with independent PoI context and a real child ledger. */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {once} from 'node:events';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {createOpenClawGateway} from '../openclaw/gateway.mjs';import {createPoIBroker} from '../openclaw/broker.mjs';
import {engine} from '../lib/engine.mjs';import {DIMENSIONS,FRUITS} from '../lib/providers.mjs';import {controlSessionKey} from '../lib/openclaw-controls.mjs';
import {currentCanonicalSkill} from '../lib/canonical-skill.mjs';
const packageRoot=process.env.CT_OPENCLAW_PACKAGE,nodePath=process.env.CT_OPENCLAW_NODE;
test('actual native child runs require creation correlation, wear canonical skill and seal their own Timechain',{
  skip:!packageRoot||!nodePath?'Set the reviewed native package and Node paths.':false,timeout:240000,
},async t=>{
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-native-delegate-'))),root=path.join(directory,'parent');
  const diagnostics=[],calls=[],children=new Map();let spawned=false,manager,broker;
  const canonicalSkill=(await currentCanonicalSkill()).skill;
  const answer='I can help with care and honesty.';
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    assert.equal(raw.includes('[CHAINCHAT_PRIVATE_MODEL_ROUTE:'),false);
    const system=(body.messages||[]).filter(message=>message.role==='system').map(message=>typeof message.content==='string'?message.content:JSON.stringify(message.content)).join('\n');
    assert.ok(system.includes('CHAINCHAT HOST CONTRACT'),'Every actual child inference must wear the canonical host skill.');
    calls.push({canonical:system.includes(canonicalSkill),hasToolResult:(body.messages||[]).some(message=>message.role==='tool')});
    const spawn=!spawned&&(body.messages||[]).some(message=>message.role==='user'&&JSON.stringify(message.content).includes('CT_PARENT_SPAWN'));
    if(spawn)spawned=true;
    const delta=spawn?{role:'assistant',tool_calls:[{index:0,id:'actual_spawn_fixture',type:'function',function:{name:'sessions_spawn',arguments:JSON.stringify({task:'CT_CHILD_TASK: Please say you can help with care and honesty.',runtime:'subagent',agentId:'main',mode:'run',cleanup:'keep'})}}]}:{role:'assistant',content:answer};
    res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'native-child-fixture',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    res.end(`data: ${JSON.stringify({id:'native-child-fixture',choices:[{index:0,delta:{},finish_reason:spawn?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
  });provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{await manager?.close();await broker?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));assert.ok(directory.startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});});
  await engine({op:'init',root,registryRoot:root,name:'Delegation parent fixture'});
  const initial=await engine({op:'inspect',root,registryRoot:root,learning:false});
  const identity={agentId:'delegation-parent',genesisHash:initial.genesis.hash},ownerKey=identity.agentId+':'+identity.genesisHash;
  const config={provider:'compatible',model:'fixture',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'synthetic-delegation-key'};
  const nativeCapabilities={enabled:true,acknowledged:true,tools:['sessions_spawn'],settings:[],delegatedRuns:true,backgroundRuns:false};
  const toolAuthority={enabled:true,acknowledged:true,tools:[],roots:[],networkHosts:[],allowExecution:false,nativeCapabilities};
  const context=input=>({root,input,purpose:'candidate',learning:false,loadout:[],nativeIdentity:identity,nativeOwnerKey:ownerKey,nativeTools:['sessions_spawn'],toolAuthority,authorize:async()=>{}});
  broker=createPoIBroker({engine,review:async()=>({approved:true,scores:Object.fromEntries(DIMENSIONS.map(name=>[name,240])),fruitages:Object.fromEntries(FRUITS.map(name=>[name,240])),usedRings:[],rationale:'Synthetic local fixture claims only careful help and records real native observations.'})});await broker.start();
  manager=createOpenClawGateway({stateDir:path.join(directory,'gateway'),packageRoot,nodePath,broker,deferNativeSources:true,pluginPath:fileURLToPath(new URL('../openclaw/plugin',import.meta.url)),onDiagnostic:line=>diagnostics.push(line),
    resolveNativeModelRoute:async({ownerKey:key})=>{assert.equal(key,ownerKey);return{config,authorize:async()=>{}};},
    resolveNativeOwner:async binding=>{
      assert.equal(binding.ownerKey,ownerKey);assert.equal(binding.kind,'subagent');
      let child=children.get(binding.nativeSessionKey);
      if(!child){const childRoot=path.join(directory,'child-'+createHash('sha256').update(binding.nativeSessionKey).digest('hex'));await engine({op:'init',root:childRoot,registryRoot:childRoot,name:'Delegation child fixture'});const state=await engine({op:'inspect',root:childRoot,registryRoot:childRoot,learning:false});child={root:childRoot,identity:{agentId:'delegation-child',genesisHash:state.genesis.hash}};children.set(binding.nativeSessionKey,child);}
      return{config,context:{...context(binding.input),root:child.root,nativeIdentity:child.identity,autonomousCommit:true},release:async()=>{}};
    }});
  try{
    const input='CT_PARENT_SPAWN: Start the requested native child task, then say you can help with care and honesty.';
    const parent=await manager.generate(config,{messages:[{role:'user',content:input}],maxTokens:512,nativeControl:{kind:'message',sessionKey:controlSessionKey(identity)}},context(input));
    assert.equal(parent.text,answer);assert.equal(parent.enforcement.reviewed,true);assert.equal(spawned,true);
    assert.equal(children.size,0,'The native owner resolver must not run before application ownership initialization finishes.');manager.resumeNativeSources();
    const deadline=Date.now()+60000;let childState;
    while(Date.now()<deadline){for(const child of children.values()){const state=await engine({op:'inspect',root:child.root,registryRoot:child.root,learning:false});if(state.head?.index>=1){childState=state;break;}}if(childState)break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(children.size,1,'Only an actually correlated native child may acquire a canonical identity.');
    assert.equal(childState?.verified,true,'The actual child must seal and verify its own ledger.');assert.equal(childState.head.index,1);
    assert.notEqual(childState.genesis.hash,initial.genesis.hash);assert.ok(calls.length>=3&&calls.every(call=>call.canonical));assert.ok(calls.some(call=>call.hasToolResult));
    assert.deepEqual((await engine({op:'inspect',root,registryRoot:root,learning:false})).head,initial.head,'Child commitment must not race or rewrite the parent head.');
  }catch(error){t.diagnostic(JSON.stringify({spawned,children:children.size,providerCalls:calls.length,code:error?.code||'ASSERTION'}));t.diagnostic(diagnostics.join('').slice(-5000));throw error;}
});
