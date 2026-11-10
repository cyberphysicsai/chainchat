import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeApiKeyStatus,nativeModelCatalogue,requireNativeModel,validateNativeProviderEntry} from '../lib/native-provider-controls.mjs';
test('native picker reports only actual native rows and explicit readiness without auth material',()=>{
  const value = nativeModelCatalogue({models:[{provider:'fixture',id:'one',name:'One',available:true,contextWindow:16384,reasoning:true,apiKey:'must-not-escape'},
    {provider:'fixture',id:'unknown'},{provider:'fixture',id:'blocked',available:true,manualSelectionAllowed:false},
    {provider:'chainchat-compatible',id:'route',available:true}]},'fixture/one');
  assert.equal(value.configured,true); assert.equal(value.models.length,3); assert.equal(value.models[1].available,false);
  assert.equal(JSON.stringify(value).includes('must-not-escape'),false); assert.equal(requireNativeModel(value,'fixture/one').contextWindow,16384);
  for(const id of ['fixture/unknown','fixture/blocked','fixture/one\n','chainchat-compatible/route']) assert.throws(()=>requireNativeModel(value,id));
});
test('native provider setup preserves upstream API schema while reserving private route and credential expansion',()=>{
  const entry={baseUrl:'http://127.0.0.1:7777/v1',api:'openai-completions',models:[{id:'test'}]};
  assert.deepEqual(validateNativeProviderEntry('fixture',entry),entry);
  for(const [id,input] of [['chainchat-compatible',entry],['fixture',{...entry,apiKey:'private'}],['fixture',{...entry,headers:{x:'${PRIVATE}'}}],['fixture',{...entry,models:[{id:'x',token:'private'}]}],
    ...['Authorization','Proxy-Authorization','APIKEY','X-Api-Key','x-auth-token','ACCESS_TOKEN','refreshToken','Cookie'].map(key=>['fixture',{...entry,headers:{[key]:'private'}}]),
    ['fixture',{...entry,baseUrl:'https://private-secret@models.example/v1'}],['fixture',{...entry,baseUrl:'https://models.example/v1?APIKEY=private'}]])
    assert.throws(()=>validateNativeProviderEntry(id,input));
  assert.deepEqual(validateNativeProviderEntry('fixture',{...entry,auth:'api-key',headers:{'X-Client-Version':'1'}}),{...entry,auth:'api-key',headers:{'X-Client-Version':'1'}});
});

test('native model and auth views hide removed routes and hold mixed credential providers', () => {
  const view = nativeModelCatalogue({models:[
    {provider:'claude-cli',id:'claude',available:true},
    {provider:'openai-codex',id:'gpt',available:true},
    {provider:'anthropic',id:'cli-alias',agentRuntime:{id:'claude-cli'},available:true},
    {provider:'anthropic',id:'api',agentRuntime:{id:'openclaw'},available:true},
  ]});
  assert.deepEqual(view.models.map(row=>row.id), ['anthropic/api']);
  const result = nativeApiKeyStatus({providers:[{provider:'openai',profiles:[
    {type:'oauth',profileId:'private-removed-profile',email:'private-identity'},
    {type:'api_key',profileId:'key-profile',status:'static',logoutSupported:true,key:'private-key'},
  ]},{provider:'claude-cli',authProvider:'anthropic',profiles:[{type:'oauth',profileId:'private-cli-profile'}]},
  {provider:'fixture',profiles:[{type:'api_key',profileId:'fixture-key',logoutSupported:true}]}],
  providerCapabilities:[{provider:'openai',apiKeySupported:true,loginOptions:[{id:'private-login'}]},
    {provider:'claude-cli',apiKeySupported:true},{provider:'oauth-only',loginOptions:[{}]}]});
  assert.deepEqual([...result.disabledProviders], ['openai','claude-cli','anthropic']);
  assert.deepEqual(result.publicStatus.providerCapabilities,[{provider:'openai',apiKeySupported:true}]);
  assert.deepEqual(result.publicStatus.providers.map(row=>row.profiles.map(profile=>profile.profileId)), [['key-profile'],['fixture-key']]);
  assert.doesNotMatch(JSON.stringify(result.publicStatus), /private-/u);
  assert.throws(()=>nativeApiKeyStatus({providers:[],unavailable:{}}));
});
