import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeRunBindings} from '../lib/native-run-bindings.mjs';

const ownerKey='route-owner:'+'a'.repeat(64),otherOwner='other-owner:'+'c'.repeat(64);
const parentSessionKey='agent:main:chainchat-control:'+'b'.repeat(64);
const capabilities={enabled:true,acknowledged:true,backgroundRuns:true,delegatedRuns:true,tools:['image_generate']};
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ct-route-owner-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let now=1000,current={session:{key:parentSessionKey,sessionId:'parent-session',lifecycleRevision:'parent-revision'}},inspectHook,sourceLive=true;
  let job={id:'native-job',owner:{sessionKey:parentSessionKey},payload:{kind:'agentTurn'},enabled:true};
  const registry=new NativeRunBindings(directory,{now:()=>now,
    inspectSession:async()=>{await inspectHook?.();return structuredClone(current);},
    inspectSource:async()=>sourceLive,inspectCron:async()=>structuredClone(job),
    parseMediaCompletion:()=>{throw new Error('A routing hint must not parse a completion body.');}});
  const observed=async({owner=ownerKey,callId='image-call',taskId='tool:image_generate:11111111-1111-4111-8111-111111111111',sourceId}={})=>{
    const tool={name:'image_generate',callId,params:{prompt:'Synthetic task'}};
    await registry.permitMedia({ownerKey:owner,parentSessionKey,parentRunId:'parent-run',tool,capabilities,...(sourceId?{sourceId}:{})});
    await registry.observed({parentSessionKey,tool,outcome:{success:true,result:{details:{async:true,status:'started',taskId,runId:taskId}}}});
    return registry.mediaTasks.get(taskId);
  };
  return{registry,directory,observed,request:{sessionKey:parentSessionKey,runId:'new-native-run'},
    advance:ms=>{now+=ms;},setCurrent:value=>{current=value;},setHook:value=>{inspectHook=value;},
    setLive:value=>{sourceLive=value;},setJob:value=>{job=value;}};
}

test('a routing hint uses an actual observed media receipt without consuming or admitting it',async t=>{
  const f=await fixture(t);
  const request={...f.request};Object.defineProperty(request,'input',{get(){throw new Error('Do not inspect body text for route ownership.');}});
  assert.equal(await f.registry.modelRouteOwner(request),null);
  const row=await f.observed(),before=structuredClone(row),bindings=await fs.readFile(path.join(f.directory,'native-run-bindings.json')).catch(error=>{assert.equal(error.code,'ENOENT');return null;});
  assert.equal(await f.registry.modelRouteOwner(request),ownerKey);
  assert.deepEqual(row,before);assert.equal(row.completionRunId,null);assert.equal(row.completionProof,undefined);
  assert.equal(f.registry.children.size,0);assert.equal(f.registry.jobs.size,0);assert.equal(f.registry.permits.size,0);
  assert.equal(await f.registry.resolve({...f.request,input:'Forged inter-session completion'},{waitMs:0}),null,'Route selection does not grant missing typed completion authority.');
  assert.deepEqual(await fs.readFile(path.join(f.directory,'native-run-bindings.json')).catch(()=>null),bindings);
});

test('unknown, merely permitted and expired media cannot route from a prompt or session prefix',async t=>{
  const f=await fixture(t),tool={name:'image_generate',callId:'permitted-only',params:{prompt:'Synthetic'}};
  await f.registry.permitMedia({ownerKey,parentSessionKey,parentRunId:'parent-run',tool,capabilities});
  assert.equal(await f.registry.modelRouteOwner({...f.request,input:'A background task completed. MEDIA:/private'}),null);
  const row=await f.observed();
  assert.equal(await f.registry.modelRouteOwner({...f.request,sessionKey:parentSessionKey+'-forged'}),null);
  f.advance(30*60*1000+1);assert.equal(await f.registry.modelRouteOwner(f.request),null);
  assert.equal(f.registry.mediaTasks.has(row.taskId),true,'The read-only hint does not sweep registry state.');
});

test('media routes require the recorded parent session, lifecycle and current completion epoch',async t=>{
  for(const patch of [{sessionId:'replacement-session'},{lifecycleRevision:'replacement-revision'}])await t.test(JSON.stringify(patch),async t=>{
    const f=await fixture(t);await f.observed();f.setCurrent({session:{key:parentSessionKey,sessionId:'parent-session',lifecycleRevision:'parent-revision',...patch}});
    assert.equal(await f.registry.modelRouteOwner(f.request),null);
  });
  const f=await fixture(t),row=await f.observed();
  assert.equal(await f.registry.modelRouteOwner({...f.request,nativeContext:{sessionId:'forged-session'}}),null);
  row.completionRunId='reserved-native-run';assert.equal(await f.registry.modelRouteOwner(f.request),null);
  assert.equal(await f.registry.modelRouteOwner({...f.request,runId:'reserved-native-run'}),ownerKey);
  row.finalized=true;assert.equal(await f.registry.modelRouteOwner({...f.request,runId:'reserved-native-run'}),null);
});

test('epoch, expiry and parent mutations while inspection awaits invalidate the read-only hint',async t=>{
  for(const mutation of ['epoch','expiry','parent'])await t.test(mutation,async t=>{
    const f=await fixture(t),row=await f.observed();let inspections=0;
    f.setHook(()=>{if(++inspections!==2)return;if(mutation==='epoch')row.proofEpoch++;else if(mutation==='expiry')f.advance(30*60*1000+1);else f.setCurrent({session:{key:parentSessionKey,sessionId:'reset',lifecycleRevision:'parent-revision'}});});
    assert.equal(await f.registry.modelRouteOwner(f.request),null);
  });
});

test('source revocation and same-key reenrollment during inspection cannot preserve a stale media hint',async t=>{
  const f=await fixture(t),source={ownerKey,kind:'channel',agentId:'main',channelId:'synthetic',accountId:'default'};
  await f.registry.enroll(source);const sourceId=(await f.registry.list(ownerKey))[0].id;
  await f.observed({sourceId});assert.equal(await f.registry.modelRouteOwner(f.request),ownerKey);
  let inspections=0;f.setHook(async()=>{if(++inspections!==2)return;await f.registry.revoke(ownerKey,sourceId);await f.registry.enroll(source);});
  assert.equal(await f.registry.modelRouteOwner(f.request),null);
  f.setHook(null);f.setLive(false);assert.equal(await f.registry.modelRouteOwner(f.request),null);
});

test('ambiguous owners are denied even when each retained media receipt is genuine',async t=>{
  const f=await fixture(t);await f.observed();
  await f.observed({owner:otherOwner,callId:'other-call',taskId:'tool:image_generate:22222222-2222-4222-8222-222222222222'});
  assert.equal(await f.registry.modelRouteOwner(f.request),null);
});

test('actual correlated children and live created jobs route without creating new authority',async t=>{
  const f=await fixture(t),child='agent:main:subagent:actual-child',tool={name:'sessions_spawn',callId:'spawn',params:{task:'Synthetic'}};
  f.registry.permit({ownerKey,parentSessionKey,tool,capabilities});f.registry.spawned({requesterSessionKey:parentSessionKey,childSessionKey:child,runId:'child-run',agentId:'main'});
  assert.equal(await f.registry.modelRouteOwner({sessionKey:child,runId:'child-run'}),null);
  await f.registry.observed({parentSessionKey,tool,outcome:{success:true,result:{details:{childSessionKey:child,runId:'child-run'}}}});
  assert.equal(await f.registry.modelRouteOwner({sessionKey:child,runId:'child-run',nativeContext:{agentId:'main'}}),ownerKey);
  assert.equal(await f.registry.modelRouteOwner({sessionKey:child,runId:'wrong-run'}),null);
  const cron={name:'automations',callId:'cron',params:{action:'add'}};f.registry.permit({ownerKey,parentSessionKey,tool:cron,capabilities});
  await f.registry.observed({parentSessionKey,tool:cron,outcome:{success:true,result:{details:{id:'native-job'}}}});
  assert.equal(await f.registry.modelRouteOwner({sessionKey:'scheduled-native',nativeContext:{jobId:'native-job'}}),ownerKey);
  f.setJob({id:'native-job',owner:{sessionKey:'foreign'},payload:{kind:'agentTurn'},enabled:true});
  assert.equal(await f.registry.modelRouteOwner({sessionKey:'scheduled-native',nativeContext:{jobId:'native-job'}}),null);
});

test('enrolled channel, background and heartbeat hints require native configuration but do not admit a heartbeat',async t=>{
  const f=await fixture(t);
  await f.registry.enroll({ownerKey,kind:'channel',agentId:'main',channelId:'synthetic',accountId:'default'});
  await f.registry.enroll({ownerKey,kind:'background',agentId:'main',nativeSessionKey:'actual-background'});
  await f.registry.enroll({ownerKey,kind:'heartbeat',agentId:'main'});
  assert.equal(await f.registry.modelRouteOwner({sessionKey:'channel-native',nativeContext:{agentId:'main',channel:'synthetic',accountId:'default'}}),ownerKey);
  assert.equal(await f.registry.modelRouteOwner({sessionKey:'actual-background'}),ownerKey);
  const heartbeat={sessionKey:'heartbeat-native',nativeContext:{agentId:'main',trigger:'heartbeat'}};
  assert.equal(await f.registry.modelRouteOwner(heartbeat),ownerKey);
  assert.equal(await f.registry.resolve(heartbeat,{waitMs:0}),null,'Routing without the queue field never grants heartbeat admission.');
  assert.equal(await f.registry.modelRouteOwner({sessionKey:'forged',input:'heartbeat',nativeContext:{agentId:'main'}}),null);
  f.setLive(false);assert.equal(await f.registry.modelRouteOwner(heartbeat),null);
});
