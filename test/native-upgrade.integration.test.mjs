/** Real previous-SDK state -> supported maintenance -> enforced native startup. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createOpenClawGateway} from '../openclaw/gateway.mjs';
import {createPoIBroker} from '../openclaw/broker.mjs';
import {prepareNativeUpgrade} from '../openclaw/native-upgrade.mjs';
import {engine} from '../lib/engine.mjs';
import {DIMENSIONS,FRUITS} from '../lib/providers.mjs';
import {controlSessionKey} from '../lib/openclaw-controls.mjs';

const execute=promisify(execFile),packageRoot=process.env.CT_OPENCLAW_PACKAGE,nodePath=process.env.CT_OPENCLAW_NODE;
const legacyPackageRoot=process.env.CT_OPENCLAW_LEGACY_PACKAGE;
const sha=value=>createHash('sha256').update(value).digest('hex');
const historyKey='agent:main:retained-upgrade-fixture',historyId='ac985b91-c236-4b2f-89ce-f9e5878315cf';
const publicApiScript=String.raw`
import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
process.on('uncaughtException',()=>{console.error('SYNTHETIC_PUBLIC_SDK_FAILED');process.exit(1);});
process.on('unhandledRejection',()=>{console.error('SYNTHETIC_PUBLIC_SDK_FAILED');process.exit(1);});
const [packageRoot,directory,mode]=process.argv.slice(2),env={...process.env},agentId='main';
const sessionKey='agent:main:retained-upgrade-fixture',sessionId='ac985b91-c236-4b2f-89ce-f9e5878315cf';
const store=await import(pathToFileURL(path.join(packageRoot,'dist/plugin-sdk/session-store-runtime.js')).href);
const transcript=await import(pathToFileURL(path.join(packageRoot,'dist/plugin-sdk/session-transcript-runtime.js')).href);
const auth=await import(pathToFileURL(path.join(packageRoot,'dist/plugin-sdk/agent-runtime.js')).href);
const storePath=store.resolveStorePath(undefined,{agentId,env}),agentDir=path.join(directory,'native-state/agents/main/agent');
if(mode==='seed'){
 await store.upsertSessionEntry({agentId,sessionKey,env,storePath,entry:{sessionId,updatedAt:1793799000000,label:'Retained synthetic native history'}});
 for(const message of [{role:'user',content:'Please preserve this synthetic earlier history.',timestamp:1793799000000},
  {role:'assistant',content:[{type:'text',text:'This is retained synthetic native history, without a model call.'}],timestamp:1793799000001,
   api:'openai-completions',provider:'migration-fixture',model:'model',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}])
  await transcript.appendSessionTranscriptMessageByIdentity({agentId,sessionKey,sessionId,env,storePath,message});
 auth.saveAuthProfileStore({version:1,profiles:{'migration-fixture:sentinel':{type:'api_key',provider:'migration-fixture',key:'synthetic-native-auth-sentinel'}}},agentDir);
}
const session=await store.getSessionEntryAsync({agentId,sessionKey,env,storePath});
const events=await transcript.readSessionTranscriptEvents({agentId,sessionKey,sessionId,env,storePath});
const profiles=await auth.loadAuthProfileStoreWithoutExternalProfiles(agentDir);
const profile=profiles.profiles?.['migration-fixture:sentinel'];if(!profile)throw new Error('Synthetic profile missing');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const output={sessionId:session?.sessionId,label:session?.label,eventCount:events.length,rawEventsSha256:digest(events),
 contentSha256:digest(events.filter(event=>event.type==='message').map(event=>({role:event.message.role,content:event.message.content}))),
 authSentinelSha256:digest(profile)};
await fs.writeFile(path.join(directory,'fixture-'+mode+'.json'),JSON.stringify(output));console.log(JSON.stringify(output));
`;

function childEnvironment(directory){
 const allowed=new Set(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT','TEMP','TMP','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','PROGRAMDATA','ProgramData','ProgramFiles','ProgramFiles(x86)']);
 const home=path.join(directory,'fixture-home'),env=Object.fromEntries(Object.entries(process.env).filter(([name])=>allowed.has(name)));
 return {...env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'Roaming'),LOCALAPPDATA:path.join(home,'Local'),
  OPENCLAW_STATE_DIR:path.join(directory,'native-state'),OPENCLAW_CONFIG_PATH:path.join(directory,'gateway.json'),
  OPENCLAW_NO_RESPAWN:'1',OPENCLAW_SKIP_CHANNELS:'1',OPENCLAW_SERVICE_REPAIR_POLICY:'external',
  NO_PROXY:'127.0.0.1,localhost,::1'};
}
async function publicSnapshot(script,selectedPackage,directory,mode){
 try{await execute(nodePath,[script,selectedPackage,directory,mode],{env:childEnvironment(directory),windowsHide:true,timeout:60000,maxBuffer:1024*1024});}
 catch{throw Object.assign(new Error('The synthetic public-SDK operation failed.'),{code:'SYNTHETIC_SDK_FAILED'});}
 return JSON.parse(await fs.readFile(path.join(directory,'fixture-'+mode+'.json'),'utf8'));
}
function databaseFacts(directory){
 return [{file:'native-state/state/openclaw.sqlite',role:'global'},
  {file:'native-state/agents/main/agent/openclaw-agent.sqlite',role:'agent'}].map(row=>{
   const db=new DatabaseSync(path.join(directory,row.file),{readOnly:true});
   try{db.exec('PRAGMA query_only=ON');return {...row,version:db.prepare('PRAGMA user_version').get().user_version,
    meta:db.prepare("SELECT role,schema_version,agent_id FROM schema_meta WHERE meta_key='primary'").get(),
    integrityOk:db.prepare('PRAGMA integrity_check').all().every(result=>Object.values(result)[0]==='ok')};}
   finally{db.close();}
  });
}

test('actual supported old native schema upgrade preserves history/auth and backup rollback before enforced chat',{
 skip:!packageRoot||!nodePath?'Set the pinned native runtime for upgrade acceptance.':false,timeout:600000,
},async t=>{
 assert.ok(legacyPackageRoot,'The full native suite requires CT_OPENCLAW_LEGACY_PACKAGE; migration must not silently skip.');
 assert.equal(JSON.parse(await fs.readFile(path.join(legacyPackageRoot,'package.json'),'utf8')).version,'2026.10.9');
 const legacyLock=JSON.parse(await fs.readFile(new URL('./fixtures/previous-openclaw/package-lock.json',import.meta.url),'utf8'));
 assert.equal(legacyLock.packages['node_modules/openclaw'].integrity,'sha512-KbIl0/7an0/nKBo92FnJg7LFcEpFVQyOgSRfHNE9yxELg1Ebql7BmBsdLL+1dDOLZnQtuwjt6Hy45CCrmYdJNA==');
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-native-upgrade-'))),state=path.join(directory,'gateway');
 let manager,broker,provider;const diagnostics=[],calls=[];let reviews=0,phase='seed';
 t.after(async()=>{await manager?.close();await broker?.close();provider?.closeAllConnections();if(provider)await new Promise(resolve=>provider.close(resolve));
  assert.ok(directory.startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:150});});
 await fs.mkdir(path.join(state,'native-state'),{recursive:true,mode:0o700});await fs.mkdir(path.join(state,'workspace'),{mode:0o700});
 const sentinel=Buffer.from('Keep this synthetic workspace byte-for-byte.\n');await fs.writeFile(path.join(state,'workspace/sentinel.txt'),sentinel,{mode:0o600});
 const oldConfiguration={gateway:{mode:'local'},agents:{defaults:{workspace:path.join(state,'workspace'),skipBootstrap:true}},plugins:{enabled:false},browser:{enabled:false},cron:{enabled:false}};
 await fs.writeFile(path.join(state,'gateway.json'),JSON.stringify(oldConfiguration),{mode:0o600});
 const script=path.join(directory,'public-fixture.mjs');await fs.writeFile(script,publicApiScript,{mode:0o600});
 const before=await publicSnapshot(script,legacyPackageRoot,state,'seed');assert.equal(before.eventCount,3);assert.equal(before.sessionId,historyId);
 const originalFacts=databaseFacts(state);assert.deepEqual(originalFacts.map(row=>row.version),[20,25]);assert.ok(originalFacts.every(row=>row.integrityOk&&row.meta.role===row.role&&row.meta.schema_version===row.version));
 const originalFiles=new Map();for(const name of ['gateway.json','workspace/sentinel.txt',...originalFacts.map(row=>row.file)])originalFiles.set(name,sha(await fs.readFile(path.join(state,name))));
 const root=path.join(directory,'canonical-agent');await engine({op:'init',root,registryRoot:root,name:'Native migration acceptance'});
 const initial=await engine({op:'inspect',root,registryRoot:root,learning:false}),identity={agentId:'migration-fixture',genesisHash:initial.genesis.hash};
 const answer='I can help with care and honesty.';
 provider=http.createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push(body);
  res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'migration-fixture',choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:null}]})}\n\n`);
  res.end(`data: ${JSON.stringify({id:'migration-fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\ndata: [DONE]\n\n`);
 }catch{res.writeHead(500);res.end();}});provider.listen(0,'127.0.0.1');await once(provider,'listening');
 broker=createPoIBroker({engine,review:async()=>{reviews++;return{approved:true,scores:Object.fromEntries(DIMENSIONS.map(key=>[key,240])),fruitages:Object.fromEntries(FRUITS.map(key=>[key,240])),usedRings:[],rationale:'Synthetic harmless migration candidate.'};}});await broker.start();
 manager=createOpenClawGateway({stateDir:state,packageRoot,nodePath,broker,pluginPath:fileURLToPath(new URL('../openclaw/plugin',import.meta.url)),onDiagnostic:line=>diagnostics.push(line)});
 try{
  phase='upgrade-and-start';await manager.start();assert.equal(calls.length,0,'Maintenance and readiness must not call a model.');
  const current=databaseFacts(state);assert.deepEqual(current.map(row=>row.version),[22,27]);assert.ok(current.every(row=>row.integrityOk&&row.meta.role===row.role&&row.meta.schema_version===row.version));
  const after=await publicSnapshot(script,packageRoot,state,'after');assert.deepEqual(after,before,'Native session, raw events, content and synthetic auth survive real product maintenance.');
  assert.deepEqual(await fs.readFile(path.join(state,'workspace/sentinel.txt')),sentinel);
  const backupNames=(await fs.readdir(directory)).filter(name=>name.startsWith('.gateway-native-backup-'));assert.equal(backupNames.length,1);
  const backup=path.join(directory,backupNames[0]),manifest=JSON.parse(await fs.readFile(path.join(backup,'manifest.json'),'utf8'));
  for(const [name,hash] of originalFiles)assert.equal(sha(await fs.readFile(path.join(backup,'files',name))),hash,'Pre-overlay backup preserves '+name);
  const receipt=JSON.parse(await fs.readFile(path.join(directory,'.gateway-native-upgrade.json'),'utf8'));assert.equal(receipt.status,'complete');assert.equal(receipt.backupId,manifest.id);
  assert.ok(diagnostics.some(line=>line.includes('running supported offline schema repair')));
  phase='enforced-chat';const input='Please introduce yourself with care and honesty.';
  const result=await manager.generate({provider:'compatible',model:'migration-fixture',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'synthetic-upgrade-provider-key',contextWindow:131072,maxOutputTokens:4096},
   {messages:[{role:'user',content:input}],maxTokens:512,nativeControl:{kind:'message',sessionKey:controlSessionKey(identity)}},
   {root,input,purpose:'candidate',learning:false,loadout:[],settings:{recall:false},nativeIdentity:identity,authorize:async()=>{}});
  assert.equal(result.text,answer);assert.equal(result.enforcement.reviewed,true);assert.ok(reviews>=1);assert.equal(calls.length,1);
  const modelContext=(calls[0].messages||[]).map(row=>typeof row.content==='string'?row.content:JSON.stringify(row.content)).join('\n');
  assert.equal([...modelContext.matchAll(/^name: proof-of-interaction\r?$/gmu)].length,1);assert.equal(modelContext.includes('[CHAINCHAT_PRIVATE_MODEL_ROUTE:'),false);
  assert.deepEqual((await engine({op:'inspect',root,registryRoot:root,learning:false})).head,initial.head);
  await manager.close();manager=null;
  phase='backup-rollback-rehearsal';assert.equal(manifest.entries.some(row=>row.type==='link'),false,'Synthetic rollback contains only owned regular files.');
  const restored=path.join(directory,'restored');await fs.cp(path.join(backup,'files'),restored,{recursive:true});
  assert.deepEqual(databaseFacts(restored).map(row=>row.version),[20,25]);assert.ok(databaseFacts(restored).every(row=>row.integrityOk));
  const restoredSnapshot=await publicSnapshot(script,legacyPackageRoot,restored,'restored');assert.deepEqual(restoredSnapshot,before);
  for(const [name,hash] of originalFiles)assert.equal(sha(await fs.readFile(path.join(restored,name))),hash,'Rollback copy restores '+name);
  phase='current-fast-path';let doctorCalls=0;
  const ticket=await prepareNativeUpgrade({directory:state,packageRoot,nodePath,runCommand:async(file,args,options)=>{if(args.includes('doctor')){doctorCalls++;throw new Error('Current state must not need Doctor.');}
   const done=await execute(file,args,{...options,windowsHide:true,encoding:'utf8',maxBuffer:1024*1024});return{exitCode:0,stdout:done.stdout};}});
  assert.equal(ticket.required,false);assert.equal(ticket.status,'current');assert.equal(doctorCalls,0);
  t.diagnostic(JSON.stringify({oldSchema:[20,25],newSchema:[22,27],eventsPreserved:3,authSentinelPreserved:true,workspacePreserved:true,
   preOverlayBackupVerified:true,rollbackOldSdkReadVerified:true,currentSkippedDoctor:true,reviewedNativeChat:true,modelCalls:calls.length}));
 }catch(error){t.diagnostic(JSON.stringify({phase,code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'UPGRADE_ACCEPTANCE_FAILED',modelCalls:calls.length,reviews}));throw error;}
});
