import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForNativeSessionIdle} from '../lib/native-session-idle.mjs';
const row = extra => ({session:{key:'owned-session',sessionId:'native-session',lifecycleRevision:'lifecycle-one',hasActiveRun:false,...extra}});
const options = extra => ({sessionKey:'owned-session',read:async()=>row(),...extra});

test('a new native session can be absent, but a previously known writer cannot disappear', async()=>{
  assert.equal(await waitForNativeSessionIdle(options({read:async()=>({session:null})})),null);
  for(const extra of [{requireExisting:true},{expectedSessionId:'native-session'}])
    await assert.rejects(waitForNativeSessionIdle(options({...extra,read:async()=>({session:null})})),{code:'SESSION_CHANGED'});
});
test('terminal persistence with no public run IDs remains busy until the actual idle projection', async()=>{
  let reads=0,clock=0,guards=0;
  const result=await waitForNativeSessionIdle(options({read:async()=>row({hasActiveRun:++reads<3}),now:()=>clock,
    wait:async ms=>{assert.equal(reads<3,true);clock+=ms;},assertCurrent:async()=>{guards++;}}));
  assert.deepEqual(result,{sessionId:'native-session',lifecycleRevision:'lifecycle-one'});assert.equal(reads,3);assert.equal(guards,6);
});
test('unknown idle state, wrong identity, lifecycle resets and contradictory projections fail closed', async()=>{
  for(const extra of [{hasActiveRun:undefined},{hasActiveRun:'false'},{sessionId:''},{lifecycleRevision:undefined},
    {key:'another-session'},{activeRunIds:['still-active']}])
    await assert.rejects(waitForNativeSessionIdle(options({read:async()=>row(extra)})),{code:'SESSION_CHANGED'});
  await assert.rejects(waitForNativeSessionIdle(options({expectedSessionId:'old-session'})),{code:'SESSION_CHANGED'});
  let reads=0;
  await assert.rejects(waitForNativeSessionIdle(options({read:async()=>row(++reads===1?{hasActiveRun:true}:{lifecycleRevision:'new-lifecycle'}),wait:async()=>{}})),{code:'SESSION_CHANGED'});
});
test('revocation after an awaited status read is checked before accepting idle', async()=>{
  let revoked=false;
  await assert.rejects(waitForNativeSessionIdle(options({read:async()=>{revoked=true;return row();},
    assertCurrent:async()=>{if(revoked)throw Object.assign(new Error('revoked'),{code:'SESSION_CHANGED'});}})),{code:'SESSION_CHANGED'});
});
test('the bounded native idle wait never aborts or steers the prior run', async()=>{
  let reads=0,clock=0;
  await assert.rejects(waitForNativeSessionIdle(options({read:async()=>{reads++;return row({hasActiveRun:true});},
    timeoutMs:450,now:()=>clock,wait:async ms=>{clock+=ms;}})),{code:'OPENCLAW_SESSION_BUSY'});
  assert.equal(clock,450);assert.equal(reads,3,'No additional status read starts after the budget is exhausted.');
});
test('cancellation wakes the native idle wait without accepting an old receipt', async()=>{
  const controller=new AbortController();
  await assert.rejects(waitForNativeSessionIdle(options({signal:controller.signal,read:async()=>row({hasActiveRun:true}),
    wait:async()=>{controller.abort();throw new Error('aborted');}})),{code:'REQUEST_CANCELLED'});
});
test('a stalled read is bounded and cancellable even if its adapter ignores the supplied deadline', async()=>{
  let supplied;
  await assert.rejects(waitForNativeSessionIdle(options({timeoutMs:20,read:async(_key,budget)=>{
    supplied=budget.timeoutMs;return new Promise(()=>{});
  }})),{code:'OPENCLAW_SESSION_BUSY'});
  assert.ok(supplied>0&&supplied<=20);
  const controller=new AbortController();
  await assert.rejects(waitForNativeSessionIdle(options({signal:controller.signal,read:async()=>{
    controller.abort();return new Promise(()=>{});
  }})),{code:'REQUEST_CANCELLED'});
});
