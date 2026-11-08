import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeModelCatalogue,requireNativeModel,validateNativeProviderEntry} from '../lib/native-provider-controls.mjs';
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
