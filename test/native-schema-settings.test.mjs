import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeSecrets,nativeSecretTargets} from '../lib/native-secrets.mjs';
import {assertNoNativeSecrets,redactNativeConfiguration,nativeSensitiveFields,parseConfigPath,deleteConfigPath} from '../lib/native-config-schema.mjs';
import {createNativeControls,validateControlPatch} from '../lib/openclaw-controls.mjs';
const schema={schema:{type:'object',properties:{channels:{type:'object',properties:{discord:{type:'object',properties:{enabled:{type:'boolean'},accounts:{type:'object',additionalProperties:{$ref:'#/$defs/account'}}}}}},plugins:{type:'object',properties:{entries:{type:'object',additionalProperties:{type:'object',properties:{config:{$ref:'#/$defs/plugin'}}}}}}},$defs:{account:{type:'object',properties:{label:{type:'string'},botToken:{type:'string'},customCredential:{anyOf:[{type:'string'},{type:'object',properties:{source:{type:'string'},provider:{type:'string'},id:{type:'string'}}}]}}},plugin:{type:'object',properties:{ordinary:{type:'string'},unusualField:{type:'string'}}}}},uiHints:{'channels.discord.accounts.*.botToken':{sensitive:true,label:'Discord bot token'},'channels.discord.accounts.*.customCredential':{sensitive:true},'plugins.entries.*.config.unusualField':{sensitive:true}}};
const config={channels:{discord:{enabled:true,accounts:{'main.work':{label:'Work'}}}},plugins:{entries:{trusted:{config:{ordinary:'value'}}}}};
const caps={enabled:true,acknowledged:true,settings:['*']};
async function storeFixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ct-schema-secrets-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return new NativeSecrets(directory);}
test('exact schema refs and wildcard hints discover missing credentials in concrete dotted account names',()=>{
 const targets=nativeSensitiveFields(config,schema);assert.ok(targets.some(row=>row.target==='/channels/discord/accounts/main.work/botToken'&&row.projection==='env-string'));
 assert.equal(targets.find(row=>row.target.endsWith('/customCredential')).projection,'secret-ref');
 assert.ok(targets.some(row=>row.target==='/plugins/entries/trusted/config/unusualField'));
 assert.deepEqual(parseConfigPath('/channels/discord/accounts/main.work/botToken'),['channels','discord','accounts','main.work','botToken']);
 assert.throws(()=>parseConfigPath('/__proto__/bad'));assert.throws(()=>parseConfigPath('/bad~2path'));
 const overlay={messages:{queue:{cap:2}},ui:{label:'keep'}};deleteConfigPath(overlay,['messages','queue','cap']);assert.deepEqual(overlay,{ui:{label:'keep'}});
});
test('generic settings reject schema-sensitive values and sentinels; safe display redacts unexpected plugin credentials',()=>{
 const value={plugins:{entries:{trusted:{config:{unusualField:'not-allowed'}}}}};
 assert.throws(()=>assertNoNativeSecrets(value,{schema}));assert.throws(()=>validateControlPatch(value,{nativeCapabilities:caps,schema}));
 assert.throws(()=>assertNoNativeSecrets({messages:{prefix:'__OPENCLAW_REDACTED__'}}));
 assert.equal(redactNativeConfiguration(value,schema).plugins.entries.trusted.config.unusualField,'[managed private value]');
 assert.deepEqual(validateControlPatch({agents:{defaults:{compaction:{mode:'default'}}},session:{maintenance:{mode:'warn'}},skills:{entries:{fixture:{enabled:true}}}},{nativeCapabilities:caps}),{agents:{defaults:{compaction:{mode:'default'}}},session:{maintenance:{mode:'warn'}},skills:{entries:{fixture:{enabled:true}}}});
});
test('new channel credentials stage atomically, persist encrypted and restore before a native schema exists',async t=>{
 const store=await storeFixture(t),target='/channels/discord/accounts/main.work/botToken',value='synthetic-new-discord-secret\nline-two';
 const transaction=await store.stage([{name:'discordWork',target,value,remember:true}],config,schema);
 assert.equal((await store.list(config,schema)).bindings[0].available,true);const staged=await store.project(config);
 assert.match(staged.config.channels.discord.accounts['main.work'].botToken,/^\$\{CHAINCHAT_NATIVE_[A-F0-9]{64}\}$/u);assert.equal(Object.values(staged.environment)[0],value);
 assert.equal(JSON.stringify(staged.config).includes(value),false);await transaction.abort();assert.deepEqual((await store.project(config)).environment,{});
 const second=await store.stage([{name:'discordWork',target,value}],config,schema);await second.commit();
 const disk=await fs.readFile(path.join(store.directory,'native-secrets.json'),'utf8');assert.equal(disk.includes(value),false);assert.equal(disk.includes(target),false);assert.equal(JSON.parse(disk).version,2);
 const restart=new NativeSecrets(store.directory);assert.deepEqual(await restart.project(config),staged);
 const orphan=await restart.project({channels:{discord:{accounts:{other:{}}}}});assert.deepEqual(orphan.environment,{});
});
test('session-only credentials disappear on restart, encrypted vault tampering or missing keys fail closed',async t=>{
 const store=await storeFixture(t),target='/plugins/entries/trusted/config/unusualField';
 await store.set({name:'session',target,value:'synthetic-session-secret',remember:false},config,schema);
 assert.equal(Object.keys((await store.project(config)).environment).length,1);assert.deepEqual((await new NativeSecrets(store.directory).list(config,schema)).bindings,[]);
 await store.set({name:'session',target,value:'synthetic-persistent-secret'},config,schema);
 const file=path.join(store.directory,'native-secrets.json'),saved=await fs.readFile(file,'utf8'),body=JSON.parse(saved);body.ciphertext=Buffer.from('tampered').toString('base64');await fs.writeFile(file,JSON.stringify(body));
 await assert.rejects(new NativeSecrets(store.directory).load());await fs.writeFile(file,saved);await fs.rm(path.join(store.directory,'native-secrets.key'));await assert.rejects(new NativeSecrets(store.directory).load());
});
test('array account credentials do not reroute on reorder or ambiguous identity',async t=>{
 const store=await storeFixture(t),arraySchema={schema:{properties:{bots:{type:'array',items:{properties:{id:{type:'string'},botToken:{type:'string'}}}}}}},first={bots:[{id:'a'},{id:'b'}]};
 await store.set({name:'botA',target:'/bots/0/botToken',value:'synthetic-array-secret'},first,arraySchema);
 assert.equal(Object.keys((await store.project(first)).environment).length,1);assert.deepEqual((await store.project({bots:[{id:'b'},{id:'a'}]})).environment,{});
 await assert.rejects(store.set({name:'ambiguous',target:'/bots/0/botToken',value:'synthetic-array-secret'},{bots:[{},{}]},arraySchema));
});
test('legacy TTS plaintext vault migrates to authenticated encryption without changing its reference',async t=>{
 const store=await storeFixture(t),tts={tts:{providers:{fixture:{model:'speech'}}}},value='synthetic-legacy-credential';
 await fs.writeFile(path.join(store.directory,'native-secrets.json'),JSON.stringify({version:1,bindings:[{name:'speech',target:'tts.providers.fixture.apiKey',value}]}),{mode:0o600});
 const projected=await store.project(tts);assert.equal(Object.values(projected.environment)[0],value);
 const saved=await fs.readFile(path.join(store.directory,'native-secrets.json'),'utf8');assert.equal(JSON.parse(saved).version,2);assert.equal(saved.includes(value),false);
});
function controlsFixture({ignoreApply=false,failSave=false}={}){
 let overlay={revision:'r1',patch:{messages:{queue:{cap:2}}}},effective={messages:{queue:{cap:2}}},hash='native-a';const events=[];
 const controls=createNativeControls({readOverlay:async()=>structuredClone(overlay),nativeCapabilities:async()=>caps,
  rpc:async method=>method==='config.schema'?schema:method==='config.get'?{config:structuredClone(effective),hash,valid:true}:{},
  applyOverlay:async(next,options)=>{events.push(['apply',structuredClone(next),options]);if(!ignoreApply){effective={messages:{queue:{cap:1}},...structuredClone(next)};hash='native-b';}},
  abortApply:async()=>events.push(['abort']),saveOverlay:async patch=>{events.push(['save']);if(failSave)throw new Error('disk full');return overlay={revision:'r2',patch};},sanitize:value=>value});
 return{controls,events,getOverlay:()=>overlay};
}
test('native settings check both revisions, apply resets against baseline and return effective readback',async()=>{
 const f=controlsFixture();await assert.rejects(f.controls.updateControls({revision:'r1',baseHash:'wrong',patch:{messages:{queue:{cap:4}}}}),{code:'OPENCLAW_CONFIG_STALE'});assert.deepEqual(f.events,[]);
 const result=await f.controls.updateControls({revision:'r1',baseHash:'native-a',removePaths:['/messages/queue/cap']});
 assert.deepEqual(result.config.editable,{});assert.equal(result.config.effective.messages.queue.cap,1);assert.equal(result.config.baseHash,'native-b');
 assert.equal(f.events[0][2].baseHash,'native-a');assert.equal(f.events.at(-1)[0],'save');
});
test('silent native rejection and persistence failure abort staged credentials before restoring previous overlay',async()=>{
 for(const options of [{ignoreApply:true},{failSave:true}]){const f=controlsFixture(options);
  await assert.rejects(f.controls.updateControls({revision:'r1',baseHash:'native-a',patch:{messages:{queue:{cap:4}}}}));
  assert.deepEqual(f.getOverlay().patch,{messages:{queue:{cap:2}}});
  const abort=f.events.findIndex(row=>row[0]==='abort');assert.ok(abort>0);assert.equal(f.events[abort+1][0],'apply');assert.deepEqual(f.events[abort+1][1],{messages:{queue:{cap:2}}});
 }
});
test('managed channel admission is exact, internal and resolves the nested selected identity',async()=>{
 let selected=null,applied=null,effective={},revision='r1';
 const controls=createNativeControls({nativeCapabilities:async identity=>{selected=identity;return{enabled:false,acknowledged:false,settings:[]};},
  readOverlay:async()=>({revision,patch:{}}),saveOverlay:async patch=>({revision:revision='r2',patch}),
  rpc:async method=>method==='config.schema'?schema:{config:effective},applyOverlay:async patch=>{applied=patch;effective=structuredClone(patch);}});
 const identity={agentId:'verified-owner',genesisHash:'a'.repeat(64)},patch={channels:{discord:{enabled:true}}};
 await assert.rejects(controls.updateControls({identity,revision:'r1',patch}),{code:'OPENCLAW_SETTING_GUARDED'});
 await assert.rejects(controls.updateControls({identity,revision:'r1',patch,admittedSettings:['gateway.auth']}));
 await assert.rejects(controls.updateControls({identity,revision:'r1',patch:{...patch,cron:{enabled:true}},admittedSettings:['channels.discord']}),{code:'OPENCLAW_SETTING_GUARDED'});
 await controls.updateControls({identity,revision:'r1',patch,admittedSettings:['channels.discord']});assert.deepEqual(selected,identity);assert.deepEqual(applied,patch);
});
test('numeric and dotted map reset paths stay literal while array item deletion is rejected',async()=>{
 let overlay={revision:'r1',patch:{channels:{discord:{accounts:{'123':{label:'Numeric'},'work.main':{label:'Dotted'}}}},ui:{tabs:['one','two']}}},effective=structuredClone(overlay.patch),applies=0;
 const controls=createNativeControls({nativeProvider:()=>true,nativeCapabilities:async()=>caps,readOverlay:async()=>overlay,
  rpc:async method=>method==='config.schema'?schema:{config:effective},saveOverlay:async patch=>overlay={revision:'r2',patch},
  applyOverlay:async patch=>{applies++;effective=structuredClone(patch);}});
 await assert.rejects(controls.updateControls({revision:'r1',removePaths:[['ui','tabs','0']]}));assert.equal(applies,0);
 const saved=await controls.updateControls({revision:'r1',removePaths:[['channels','discord','accounts','123'],['channels','discord','accounts','work.main','label']]});
 assert.equal(saved.config.editable.channels,undefined);assert.deepEqual(saved.config.editable.ui.tabs,['one','two']);assert.equal(saved.config.nativeProvider,true);
});
test('credential list and projection discover schema targets once for all stored bindings',async t=>{
 const store=await storeFixture(t);let enumerations=0;
 const envelope={schema:{properties:{channels:{properties:{fixture:{properties:{accounts:{additionalProperties:{properties:{botToken:{type:'string'}}}}}}}}}},uiHints:new Proxy({'channels.fixture.accounts.*.botToken':{sensitive:true}},{ownKeys(target){enumerations++;return Reflect.ownKeys(target);}})};
 const configuration={channels:{fixture:{accounts:Object.fromEntries(Array.from({length:24},(_,index)=>[`account${index}`,{}]))}}};
 const changes=Array.from({length:24},(_,index)=>({name:`account${index}`,target:`/channels/fixture/accounts/account${index}/botToken`,value:`synthetic-private-token-${index}`,remember:false}));
 const transaction=await store.stage(changes,configuration,envelope);await transaction.commit();
 enumerations=0;const listed=await store.list(configuration,envelope);assert.equal(listed.bindings.length,24);assert.ok(listed.bindings.every(row=>row.available));assert.equal(enumerations,1);
 enumerations=0;const projected=await store.project(configuration,envelope);assert.equal(Object.keys(projected.environment).length,24);assert.equal(enumerations,1);
});
