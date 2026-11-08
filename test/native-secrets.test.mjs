import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {NativeSecrets,nativeSecretTargets} from '../lib/native-secrets.mjs';
const configuration={tts:{personas:{fixture:{providers:{openai:{baseUrl:'http://127.0.0.1:1234/v1',model:'tts-1'}}}}}};
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ct-native-secrets-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return new NativeSecrets(directory);}
test('dedicated native credentials become exact allowlisted references, never settings or public values',async t=>{
 const store=await fixture(t),value='sk-synthetic-native-persona-secret';
 assert.deepEqual(nativeSecretTargets(configuration).map(row=>row.target),['tts.personas.fixture.providers.openai.apiKey','tts.providers.openai.apiKey']);
 const result=await store.set({name:'speech',target:'tts.providers.openai.apiKey',value},configuration);
 assert.equal(JSON.stringify(result).includes(value),false);const projected=await store.project(configuration);
 assert.equal(JSON.stringify(projected.config).includes(value),false);const reference=projected.config.tts.providers.openai.apiKey;
 assert.deepEqual(reference,{source:'env',provider:'chainchat',id:reference.id});assert.match(reference.id,/^CHAINCHAT_NATIVE_[A-F0-9]{64}$/u);
 assert.deepEqual(projected.config.secrets.providers.chainchat,{source:'env',allowlist:[reference.id]});assert.equal(projected.environment[reference.id],value);
 const restart=new NativeSecrets(store.directory);assert.deepEqual(await restart.list(configuration),result);assert.deepEqual(await restart.project(configuration),projected);
 await restart.remove('speech',configuration);assert.deepEqual((await restart.project(configuration)).environment,{});
});
test('only configured TTS credential targets and generated environment names can be bound',async t=>{
 const store=await fixture(t),valid={name:'speech',target:'tts.providers.openai.apiKey',value:'synthetic-secret'};
 for(const changed of [{name:'NODE_OPTIONS'},{name:'../../escape'},{name:'constructor'},{target:'gateway.auth.token'},{target:'tts.providers.foreign.apiKey'},
  {target:'tts.personas.__proto__.providers.openai.apiKey'},{target:'models.providers.openai.apiKey'},{value:''},{value:'chainchat-free-tier'},{value:'x'.repeat(16385)},{value:'x\0y'}]){
  // NODE_OPTIONS is an ordinary label: its actual environment alias is hashed,
  // so it cannot override Node options or any operator-selected variable.
  if(changed.name==='NODE_OPTIONS'){const result=await store.set({...valid,...changed},configuration);assert.equal(result.bindings[0].name,'NODE_OPTIONS');assert.equal(Object.hasOwn((await store.project(configuration)).environment,'NODE_OPTIONS'),false);await store.remove('NODE_OPTIONS',configuration);}
  else await assert.rejects(store.set({...valid,...changed},configuration));
 }
 assert.deepEqual((await store.list(configuration)).bindings,[]);
});
test('a duplicate target, corrupted private file, or orphan target cannot silently reroute credentials',async t=>{
 const store=await fixture(t);await store.set({name:'speech',target:'tts.providers.openai.apiKey',value:'synthetic-secret'},configuration);
 await assert.rejects(store.set({name:'other',target:'tts.providers.openai.apiKey',value:'other-secret'},configuration));
 const orphan=await store.project({tts:{}});assert.deepEqual(orphan.environment,{});assert.equal((await store.list({tts:{}})).bindings[0].available,false);
 await fs.writeFile(path.join(store.directory,'native-secrets.json'),'{invalid');await assert.rejects(new NativeSecrets(store.directory).load());
});
test('private native secret file permissions are enforced on POSIX', {skip:process.platform==='win32'?'POSIX mode enforcement is tested in Linux CI.':false},async t=>{
 const store=await fixture(t);await store.set({name:'speech',target:'tts.providers.openai.apiKey',value:'synthetic-secret'},configuration);
 const file=path.join(store.directory,'native-secrets.json');assert.equal((await fs.stat(file)).mode&0o777,0o600);
 await fs.chmod(file,0o644);await assert.rejects(new NativeSecrets(store.directory).load());
});
