import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {mergeHistoryMessages} from '../public/native-history.js';
import {nativeHistoryMedia} from '../public/native-media.js';
const genesis='a'.repeat(64),first='b'.repeat(64),second='c'.repeat(64),third='d'.repeat(64);
const pair=(hash=first,index=1,input='Please introduce yourself.',output='A grounded introduction.')=>[
  {role:'user',content:input,fromHistory:true},
  {role:'assistant',content:output,input,ring:{index,hash},gate:{approved:true},fromHistory:true},
];

test('a sealed asynchronous completion appears once while local acknowledgement, held, control and paused turns stay intact',()=>{
  const ack=pair(),held={role:'assistant',held:true,content:'Earlier held diagnostic.'},control={role:'assistant',control:true,content:'Goal status.'},paused={role:'assistant',memoryPaused:true,mode:'dormant',input:'Simple pause question',content:'Reviewed paused answer.'};
  const current=[...ack,held,control,paused],completion={role:'assistant',content:'The requested media is ready.',input:'Internal completion envelope',ring:{index:2,hash:second},nativeCompletion:true,media:[{id:third}],fromHistory:true};
  const refreshed=mergeHistoryMessages(current,[...ack,completion]);
  assert.equal(refreshed.messages.filter(row=>row.nativeCompletion).length,1);
  assert.ok(refreshed.messages.includes(held));assert.ok(refreshed.messages.includes(control));assert.ok(refreshed.messages.includes(paused));
  assert.equal(refreshed.messages.filter(row=>row.role==='user').length,1);
  const again=mergeHistoryMessages(refreshed.messages,[...ack,completion]);assert.equal(again.changed,false);assert.equal(again.messages.length,refreshed.messages.length);
});

test('pending or immediately accepted local exchanges acquire their saved receipt without a duplicate user or answer',()=>{
  for(const pending of [true,false]){
    const current=[{role:'user',content:'A repeated request.'},{role:'assistant',input:'A repeated request.',content:'Accepted response.',...(pending?{pending:true}:{})}];
    const result=mergeHistoryMessages(current,pair(first,1,'A repeated request.','Accepted response.'));
    assert.equal(result.messages.length,2);assert.equal(result.messages[1].ring.hash,first);assert.equal(result.messages[1].pending,false);
    const different=mergeHistoryMessages(result.messages,pair(second,2,'A repeated request.','Accepted response.'));
    assert.equal(different.messages.length,4,'A distinct sealed exchange remains visible even if its words repeat.');
  }
});

test('multiple identical exchanges in one continuum block are preserved and matched only once each',()=>{
  const history=[...pair(),...pair()],current=[{role:'user',content:history[0].content},{role:'assistant',content:history[1].content,input:history[1].input,pending:true},
    {role:'user',content:history[0].content},{role:'assistant',content:history[1].content,input:history[1].input,pending:true}];
  const result=mergeHistoryMessages(current,history);assert.equal(result.messages.length,4);assert.equal(result.messages.filter(row=>row.ring?.hash===first).length,2);
  assert.equal(mergeHistoryMessages(result.messages,history).changed,false);
});

test('a delayed completion marker removes only a matching historical internal input and never the original request',()=>{
  const original=pair(),previous=pair(second,2,'Internal completion envelope','The image is ready.'),completion={...previous[1],nativeCompletion:true};
  const result=mergeHistoryMessages([...original,...previous],[...original,completion]);
  assert.equal(result.messages.length,3);assert.equal(result.messages[0].content,original[0].content);assert.equal(result.messages[2].nativeCompletion,true);
  const held={role:'assistant',held:true,content:'A retry diagnostic.'};
  const recovered=mergeHistoryMessages([{role:'user',content:original[0].content},held],original);
  assert.equal(recovered.messages.filter(row=>row.role==='user').length,1);assert.ok(recovered.messages.includes(held));
});

test('actual history projection labels only current-agent current-genesis completion rings and preserves portable output media',async()=>{
  const app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8'),begin=app.indexOf('function historyMessages()'),end=app.indexOf('function reconcilePending()',begin);
  const turn={ring:2,hash:second,payload:{input:'Private native completion envelope',output:'A reviewed caption.',outputAssets:[{hash:third,size:12,mime:'image/png',name:'generated.png',kind:'image',direction:'output'}]}};
  const state={agent:{id:'fixture-agent',genesis:{hash:genesis},history:[turn]},nativeCompletions:{revision:first,rows:[{agentId:'fixture-agent',genesisHash:genesis,ringIndex:2,ringHash:second,createdAt:'2026-11-04T00:00:00Z'}]}};
  const context={state,nativeHistoryMedia};vm.createContext(context);vm.runInContext(app.slice(begin,end),context);
  const messages=structuredClone(context.historyMessages());assert.equal(messages.length,1);assert.equal(messages[0].nativeCompletion,true);assert.equal(messages[0].media[0].id,third);
  state.nativeCompletions.rows[0].genesisHash='e'.repeat(64);assert.equal(context.historyMessages().length,2);assert.equal(context.historyMessages()[1].nativeCompletion,undefined);
  state.nativeCompletions.rows[0].genesisHash=genesis;state.nativeCompletions.rows[0].agentId='another-agent';assert.equal(context.historyMessages().length,2);
});
