import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeSchemaInspector,nativeSensitiveFields,redactNativeConfiguration,assertNoNativeSecrets} from '../lib/native-config-schema.mjs';

test('operation hint index preserves inherited, wildcard and insertion-order overrides',()=>{
  const envelope={schema:{},uiHints:{
    'accounts.*':{sensitive:true,label:'All accounts'},
    'accounts.public':{sensitive:false,label:'Public account'},
    'accounts.*.value':{sensitive:true,label:'Account value'},
    '/accounts/public/value':{sensitive:false,label:'Public value'},
    '/accounts/has.dot/value':{sensitive:false,label:'Literal dotted name'},
    accounts:{label:'Late ancestor label',help:'Inherited documentation'},
  }};
  const inspector=createNativeSchemaInspector(envelope);
  assert.deepEqual(inspector.hint(['accounts','public','value']),{sensitive:false,label:'Late ancestor label',help:'Inherited documentation'});
  assert.equal(inspector.sensitive(['accounts','public','value']),false);
  assert.equal(inspector.sensitive(['accounts','private','value']),true);
  assert.equal(inspector.sensitive(['accounts','has.dot','value']),false);
  assert.equal(inspector.sensitive(['accounts','has','dot','value']),true);
  const paths=[['accounts'],['accounts','public'],['accounts','public','value'],['accounts','other','value'],['accounts','has.dot','value']];
  for(const parts of paths){let expected={};for(const [pattern,hint]of Object.entries(envelope.uiHints)){
    const wanted=pattern.startsWith('/')?pattern.slice(1).split('/'):pattern.split('.');
    if(wanted.length<=parts.length&&wanted.every((part,index)=>part==='*'||part===parts[index]))expected={...expected,...hint};
  }assert.deepEqual(inspector.hint(parts),expected,'The index must match the original complete insertion-order merge.');}
});

test('each operation indexes large unrelated hint catalogues once and shares schema ref expansion',()=>{
  let hintEnumerations=0,refReads=0;
  const hints={};for(let index=0;index<6000;index++)hints[`unrelated${index}.plugins.*.credential`]={sensitive:true,label:`Unrelated ${index}`};
  hints['work.accounts.*.credential']={sensitive:true,label:'Account credential'};
  const uiHints=new Proxy(hints,{ownKeys(target){hintEnumerations++;return Reflect.ownKeys(target);}});
  const account={type:'object',properties:{label:{type:'string'},credential:{type:'string'}}};
  const defs={};Object.defineProperty(defs,'account',{enumerable:true,get(){refReads++;return account;}});
  const root={type:'object',properties:{work:{type:'object',properties:{accounts:{type:'object',additionalProperties:{$ref:'#/$defs/account'}}}}},$defs:defs};
  for(let index=0;index<3000;index++)root.properties[`unrelated${index}`]={type:'object',properties:{nested:{$ref:'#/$defs/account'}}};
  const envelope={schema:root,uiHints},config={work:{accounts:Object.fromEntries(Array.from({length:80},(_,index)=>[`account.${index}`,{label:`Account ${index}`}]))}};
  for(const operation of [
    ()=>{const result=nativeSensitiveFields(config,envelope);assert.equal(result.length,80);assert.equal(result[0].label,'Account credential');},
    ()=>assert.deepEqual(redactNativeConfiguration(config,envelope),config),
    ()=>assert.equal(assertNoNativeSecrets(config,{schema:envelope}),config),
  ]){
    hintEnumerations=0;refReads=0;operation();
    assert.equal(hintEnumerations,1,'Unrelated UI hints must be enumerated only once per whole operation.');
    assert.equal(refReads,1,'All concrete accounts must share one expansion of their schema reference.');
  }
});

test('new calls see newly sensitive hints and schema mutations without a global stale cache',()=>{
  const config={feature:{value:'visible'}},envelope={schema:{properties:{feature:{properties:{value:{type:'string'}}}}},uiHints:{'feature.value':{sensitive:false}}};
  assert.deepEqual(redactNativeConfiguration(config,envelope),config);assert.equal(nativeSensitiveFields(config,envelope).length,0);assert.doesNotThrow(()=>assertNoNativeSecrets(config,{schema:envelope}));
  envelope.uiHints['feature.value'].sensitive=true;
  assert.equal(redactNativeConfiguration(config,envelope).feature.value,'[managed private value]');assert.equal(nativeSensitiveFields(config,envelope).length,1);assert.throws(()=>assertNoNativeSecrets(config,{schema:envelope}));
  envelope.uiHints['feature.value'].sensitive=false;envelope.schema.properties.feature.properties.value.writeOnly=true;
  assert.equal(redactNativeConfiguration(config,envelope).feature.value,'[managed private value]');assert.throws(()=>assertNoNativeSecrets(config,{schema:envelope}));
});
test('JSON prototype keys in hint metadata stay ordinary data and cannot forge sensitivity',()=>{
  const envelope={schema:{properties:{feature:{properties:{value:{type:'string'},privateValue:{type:'string'}}}}},uiHints:{
    'feature.value':JSON.parse('{"__proto__":{"sensitive":true,"label":"Forged inherited label"}}'),
    'feature.privateValue':{sensitive:true},
    '/feature/privateValue':JSON.parse('{"__proto__":{"sensitive":false,"label":"Forged public label"}}'),
  }};
  const inspector=createNativeSchemaInspector(envelope),parts=['feature','value'],hint=inspector.hint(parts);
  assert.equal(Object.getPrototypeOf(hint),Object.prototype);assert.equal(Object.hasOwn(hint,'__proto__'),true);
  assert.equal(hint.sensitive,undefined);assert.equal(hint.label,undefined);assert.equal(inspector.sensitive(parts),false);
  assert.equal(inspector.sensitive(['feature','privateValue']),true);
  const redacted=redactNativeConfiguration({feature:{value:'public',privateValue:'held'}},envelope);
  assert.equal(redacted.feature.value,'public');assert.equal(redacted.feature.privateValue,'[managed private value]');
});
