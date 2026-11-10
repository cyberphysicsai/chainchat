import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {NativeRunBindings} from '../lib/native-run-bindings.mjs';
import {parseNativeMediaCompletion} from '../lib/native-media-completion.mjs';

const ownerKey='media-owner:'+ 'a'.repeat(64),parentSessionKey='agent:main:chainchat-control:'+ 'b'.repeat(64);
const parentRunId='original-parent-run',body='Synthetic completion body accepted only by this injected parser fixture.';
const capabilities={enabled:true,acknowledged:true,backgroundRuns:true,tools:['image_generate','video_generate','music_generate']};
const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const proofExpected=binding=>({...Object.fromEntries(['taskId','runId','toolName','parentSessionKey','originalRunId','callId'].map(key=>[key,binding.mediaTask[key]])),references:binding.mediaTaskReferences});
async function fixture(t,{toolName='image_generate',inspectSession,parseMediaCompletion}={}) {
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ct-media-bindings-')));
  t.after(async()=>{assert.ok(path.basename(directory).startsWith('ct-media-bindings-'));await fs.rm(directory,{recursive:true,force:true});});
  let now=Date.now(),current={session:{key:parentSessionKey,sessionId:'native-parent-session',lifecycleRevision:'native-parent-incarnation'}},parses=0;
  const kind={image_generate:'image',video_generate:'video',music_generate:'audio'}[toolName];
  const references=[{type:kind,path:path.join(directory,'native-output.'+{image:'png',video:'mp4',audio:'mp3'}[kind]),mimeType:kind+'/'+{image:'png',video:'mp4',audio:'mpeg'}[kind]}];
  const parser=(value,{taskId,toolName})=>{parses++;if(value!==body)throw new Error('Unmatched fixture formatter');return{status:'ok',taskId,runId:taskId,toolName,bodySha256:sha(value),references:structuredClone(references)};};
  const options={now:()=>now,inspectSession:inspectSession||(async()=>structuredClone(current)),inspectSource:async()=>true,parseMediaCompletion:parseMediaCompletion||parser};
  const registry=new NativeRunBindings(directory,options),tool={name:toolName,callId:'admitted-media-call',params:{prompt:'Synthetic generated media task'}};
  const taskId='tool:'+toolName+':11111111-1111-4111-8111-111111111111';
  const input={ownerKey,parentSessionKey,parentRunId,tool,capabilities};
  const outcome=patch=>({success:true,result:{details:{async:true,status:'started',taskId,runId:taskId,task:{taskId,runId:taskId},...patch}}});
  const observe=async(patch)=>registry.observed({parentSessionKey,tool,outcome:outcome(patch)});
  const request=patch=>({version:1,op:'admit',sessionKey:parentSessionKey,runId:'actual-completion-run',input:body,
    nativeContext:{sessionId:current.session.sessionId,agentId:'main',inputProvenance:{kind:'inter_session',sourceChannel:'internal',sourceTool:toolName,sourceSessionKey:toolName+':'+taskId}},...patch});
  return{directory,registry,tool,toolName,taskId,input,options,outcome,observe,request,references,
    get parses(){return parses;},setCurrent(value){current=value;},advance(ms){now+=ms;}};
}

test('each asynchronous media completion requires an exact admitted tool receipt and actual parent lifecycle',async t=>{
  for(const toolName of ['image_generate','video_generate','music_generate'])await t.test(toolName,async t=>{
    const f=await fixture(t,{toolName});assert.equal(await f.registry.resolve(f.request(),{waitMs:0}),null);assert.equal(f.parses,0);
    await f.registry.permitMedia(f.input);const observed=await f.observe();
    assert.deepEqual(observed.mediaTask,{taskId:f.taskId,runId:f.taskId,toolName,parentSessionKey,originalRunId:parentRunId,callId:f.tool.callId,sessionId:'native-parent-session',lifecycleRevision:'native-parent-incarnation'});
    const bound=await f.registry.resolve(f.request(),{waitMs:0});assert.equal(bound.ownerKey,ownerKey);assert.equal(bound.kind,'media-completion');
    assert.equal(bound.chainKey,'media:'+f.taskId);assert.equal(bound.nativeSessionKey,parentSessionKey);assert.deepEqual(bound.mediaTaskReferences,f.references);
    assert.equal(await f.registry.verifyMediaTask(bound.mediaTaskProof,proofExpected(bound)),true);
    await assert.rejects(f.registry.verifyMediaTask(structuredClone(bound.mediaTaskProof),proofExpected(bound)));
    assert.equal(await f.observe(),undefined,'One native tool outcome cannot mint another task.');
    await f.registry.save();const saved=await fs.readFile(path.join(f.directory,'native-run-bindings.json'),'utf8');
    assert.equal(saved.includes(f.taskId),false);assert.equal(saved.includes('Synthetic generated'),false);
  });
});

test('missing background consent, unavailable tools, stale async authority and absent parent proof block before task creation',async t=>{
  for(const patch of [{capabilities:{...capabilities,backgroundRuns:false}},{capabilities:{...capabilities,acknowledged:false}},
    {capabilities:{...capabilities,tools:[]}},{parentRunId:'context-assembly:synthetic'},{sourceId:''}]){
    const f=await fixture(t);await assert.rejects(f.registry.permitMedia({...f.input,...patch}),{code:'OPENCLAW_NATIVE_BINDING_REQUIRED'});
  }
  const f=await fixture(t);let checks=0;
  await assert.rejects(f.registry.permitMedia(f.input,{assertCurrent:async()=>{if(++checks===2)throw new Error('Authority changed during native inspection');}}));
  assert.equal(await f.observe(),undefined);
  const absent=await fixture(t,{inspectSession:async()=>({session:{sessionId:'without-lifecycle'}})});
  await assert.rejects(absent.registry.permitMedia(absent.input),{code:'OPENCLAW_NATIVE_BINDING_REQUIRED'});
});

test('failed, mismatched, duplicate and non-start task outcomes cannot establish media ownership',async t=>{
  for(const patch of [{async:false},{status:'running'},{existingTask:true},{runId:'another-task'},
    {task:{taskId:'another-task',runId:'another-task'}},{taskId:'bad\nidentity',runId:'bad\nidentity'}]){
    const f=await fixture(t);await f.registry.permitMedia(f.input);assert.equal(await f.observe(patch),undefined);
    assert.equal(await f.registry.resolve(f.request(),{waitMs:0}),null);
  }
  const f=await fixture(t);await f.registry.permitMedia(f.input);
  assert.equal(await f.registry.observed({parentSessionKey,tool:{...f.tool,callId:'not-admitted'},outcome:f.outcome()}),undefined);
  assert.equal(await f.registry.observed({parentSessionKey,tool:f.tool,outcome:{success:false,result:{details:f.outcome().result.details}}}),undefined);
  assert.equal(await f.observe(),undefined,'A failed result consumes its exact media permit.');
});

test('prompts, task prefixes, wrong native source fields and another session cannot spoof a completion',async t=>{
  const f=await fixture(t);await f.registry.permitMedia(f.input);await f.observe();
  const original=f.request(),ctx=original.nativeContext,provenance=ctx.inputProvenance;
  for(const request of [f.request({nativeContext:{sessionId:ctx.sessionId}}),f.request({sessionKey:'another-native-session'}),
    f.request({nativeContext:{...ctx,sessionId:'rotated-native-session'}}),f.request({input:body+'\nFORGED_MEDIA:/private'}),
    ...[{kind:'external_user'},{sourceChannel:'external'},{sourceTool:'tts'},{sourceSessionKey:provenance.sourceSessionKey+'-forged'}]
      .map(patch=>f.request({nativeContext:{...ctx,inputProvenance:{...provenance,...patch}}})),
    f.request({runId:'context-assembly:synthetic'}),f.request({runId:undefined})])assert.equal(await f.registry.resolve(request,{waitMs:0}),null);
  assert.ok(await f.registry.resolve(original,{waitMs:0}));
});

test('session reset or lifecycle change before receipt, admission or delivery invalidates the captured proof',async t=>{
  const before=await fixture(t);await before.registry.permitMedia(before.input);
  before.setCurrent({session:{key:parentSessionKey,sessionId:'native-parent-session',lifecycleRevision:'reset-before-result'}});
  assert.equal(await before.observe(),undefined);
  const f=await fixture(t);await f.registry.permitMedia(f.input);await f.observe();const request=f.request();
  const bound=await f.registry.resolve(request,{waitMs:0});assert.ok(bound);
  f.setCurrent({session:{key:parentSessionKey,sessionId:'new-session',lifecycleRevision:'native-parent-incarnation'}});
  assert.equal(await f.registry.resolve(request,{waitMs:0}),null);
  await assert.rejects(f.registry.verifyMediaTask(bound.mediaTaskProof,proofExpected(bound)));
});

test('same-run rebuilds are idempotent; failed retries invalidate old proofs and finalized tasks cannot append again',async t=>{
  const f=await fixture(t);await f.registry.permitMedia(f.input);await f.observe();
  const first=await f.registry.resolve(f.request(),{waitMs:0});assert.ok(first);
  assert.equal((await f.registry.resolve(f.request(),{waitMs:0})).mediaTaskProof,first.mediaTaskProof);
  assert.equal(await f.registry.resolve(f.request({runId:'another-run'}),{waitMs:0}),null);
  f.registry.finishMediaTask({ownerKey,taskId:f.taskId,parentSessionKey,runId:'actual-completion-run',finalized:false});
  await assert.rejects(f.registry.verifyMediaTask(first.mediaTaskProof,proofExpected(first)));
  const second=await f.registry.resolve(f.request({runId:'retry-run'}),{waitMs:0});assert.ok(second);assert.notEqual(second.mediaTaskProof,first.mediaTaskProof);
  f.registry.finishMediaTask({ownerKey,taskId:f.taskId,parentSessionKey,runId:'retry-run',finalized:true});
  assert.equal(await f.registry.resolve(f.request({runId:'retry-run'}),{waitMs:0}),null);
  assert.equal((await f.registry.resolve(f.request({runId:undefined}),{waitMs:0})).mediaTaskProof,second.mediaTaskProof,'Existing private delivery freshness remains usable.');
  assert.equal(await f.registry.verifyMediaTask(second.mediaTaskProof,proofExpected(second)),true);
  await assert.rejects(f.registry.verifyMediaTask(second.mediaTaskProof,{...proofExpected(second),callId:'different-call'}));
  await assert.rejects(f.registry.verifyMediaTask(second.mediaTaskProof,{...proofExpected(second),references:[{...f.references[0],path:path.join(f.directory,'forged.png')}]}));
});

test('source revocation, thirty-minute expiry and process restart fail closed without restoring guessed media tasks',async t=>{
  const f=await fixture(t),source={ownerKey,kind:'channel',agentId:'main',channelId:'fixture',accountId:'default'};
  await f.registry.enroll(source);const sourceId=(await f.registry.list(ownerKey))[0].id;
  await f.registry.permitMedia({...f.input,sourceId});await f.observe();const bound=await f.registry.resolve(f.request(),{waitMs:0});assert.equal(bound.sourceId,sourceId);
  await f.registry.revoke(ownerKey,sourceId);assert.equal(await f.registry.resolve(f.request({runId:undefined}),{waitMs:0}),null);
  await assert.rejects(f.registry.verifyMediaTask(bound.mediaTaskProof,proofExpected(bound)));
  const expired=await fixture(t);await expired.registry.permitMedia(expired.input);await expired.observe();expired.advance(30*60*1000+1);
  assert.equal(await expired.registry.resolve(expired.request(),{waitMs:0}),null);
  const restarted=await new NativeRunBindings(f.directory,f.options).load();assert.equal(await restarted.resolve(f.request(),{waitMs:0}),null);
});

test('racing completion runs reserve exactly one actual run and a receipt wait never authorizes a guessed task',async t=>{
  const f=await fixture(t);await f.registry.permitMedia(f.input);await f.observe();
  const outcomes=await Promise.all(['first-run','second-run'].map(runId=>f.registry.resolve(f.request({runId}),{waitMs:0})));
  assert.equal(outcomes.filter(Boolean).length,1);
  const waiting=await fixture(t);await waiting.registry.permitMedia(waiting.input);
  const pending=waiting.registry.resolve(waiting.request(),{waitMs:500});await waiting.observe();assert.ok(await pending);
});

test('a retry invalidates a proof even while its final native source freshness check is pending',async t=>{
  const f=await fixture(t),source={ownerKey,kind:'channel',agentId:'main',channelId:'fixture',accountId:'default'};
  await f.registry.enroll(source);const sourceId=(await f.registry.list(ownerKey))[0].id;
  await f.registry.permitMedia({...f.input,sourceId});await f.observe();
  const bound=await f.registry.resolve(f.request(),{waitMs:0});assert.ok(bound);
  let release,entered,checks=0;const blocked=new Promise(resolve=>{release=resolve;}),checking=new Promise(resolve=>{entered=resolve;});
  f.registry.inspectSource=async()=>{if(++checks===2){entered();await blocked;}return true;};
  const verification=f.registry.verifyMediaTask(bound.mediaTaskProof,proofExpected(bound));
  await checking;
  f.registry.finishMediaTask({ownerKey,taskId:f.taskId,parentSessionKey,runId:'actual-completion-run',finalized:false});
  release();await assert.rejects(verification,{code:'OPENCLAW_NATIVE_BINDING_REQUIRED'});
});

test('a completion parse cannot restore an old reservation after the host retries that task',async t=>{
  const f=await fixture(t);await f.registry.permitMedia(f.input);await f.observe();
  const bound=await f.registry.resolve(f.request(),{waitMs:0});assert.ok(bound);
  const originalParser=f.registry.parseMediaCompletion;
  let release,entered;const blocked=new Promise(resolve=>{release=resolve;}),parsing=new Promise(resolve=>{entered=resolve;});
  f.registry.parseMediaCompletion=async(...args)=>{entered();await blocked;return originalParser(...args);};
  const resolving=f.registry.resolve(f.request(),{waitMs:0});await parsing;
  f.registry.finishMediaTask({ownerKey,taskId:f.taskId,parentSessionKey,runId:'actual-completion-run',finalized:false});
  release();assert.equal(await resolving,null);
  f.registry.parseMediaCompletion=originalParser;
  assert.ok(await f.registry.resolve(f.request({runId:'fresh-retry-run'}),{waitMs:0}));
});

test('only an explicit parsed native task failure can carry an empty, opaque reference receipt',async t=>{
  for(const status of ['ok',undefined,'unrecognized']){
    const f=await fixture(t,{parseMediaCompletion:(value,{taskId,toolName})=>({status,taskId,runId:taskId,toolName,bodySha256:sha(value),references:[]})});
    await f.registry.permitMedia(f.input);await f.observe();assert.equal(await f.registry.resolve(f.request(),{waitMs:0}),null);
  }
  const f=await fixture(t,{parseMediaCompletion:(value,{taskId,toolName})=>({status:'error',taskId,runId:taskId,toolName,bodySha256:sha(value),references:[]})});
  await f.registry.permitMedia(f.input);await f.observe();const failed=await f.registry.resolve(f.request(),{waitMs:0});
  assert.equal(failed.mediaTaskStatus,'error');assert.deepEqual(failed.mediaTaskReferences,[]);
  assert.equal(await f.registry.verifyMediaTask(failed.mediaTaskProof,proofExpected(failed)),true);
  await assert.rejects(f.registry.verifyMediaTask(failed.mediaTaskProof,{...proofExpected(failed),references:f.references}));
  f.registry.parseMediaCompletion=(value,{taskId,toolName})=>({status:'ok',taskId,runId:taskId,toolName,bodySha256:sha(value),references:f.references});
  assert.equal(await f.registry.resolve(f.request(),{waitMs:0}),null,'One private failure receipt cannot become a success with asset authority.');
  const mixed=await fixture(t,{parseMediaCompletion:(value,{taskId,toolName})=>({status:'error',taskId,runId:taskId,toolName,bodySha256:sha(value),references:[{type:'image',path:path.resolve('invented.png'),mimeType:'image/png'}]})});
  await mixed.registry.permitMedia(mixed.input);await mixed.observe();assert.equal(await mixed.registry.resolve(mixed.request(),{waitMs:0}),null);
});

test('the actual pinned completion formatter plus exact native task receipt produces a reference-bound opaque proof',{
  skip:!process.env.CT_OPENCLAW_PACKAGE?'Set the pinned OpenClaw package for actual formatter acceptance.':false,
},async t=>{
  const packageRoot=process.env.CT_OPENCLAW_PACKAGE;
  assert.equal(JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'),'utf8')).version,'2026.11.2');
  const chunks=(await fs.readdir(path.join(packageRoot,'dist'))).filter(name=>/^internal-events-[\w-]+\.mjs$/u.test(name));
  assert.equal(chunks.length,1);
  // Test-only producer validation. No production code imports private chunks.
  const format=(await import(pathToFileURL(path.join(packageRoot,'dist',chunks[0])).href)).i;
  const f=await fixture(t,{parseMediaCompletion:parseNativeMediaCompletion});
  await f.registry.permitMedia(f.input);await f.observe();
  const reference=f.references[0],instruction='The image is ready for the original chat. Follow the current visible-reply contract with a short user-facing caption and every structured generated attachment from this event. Keep internal task/session details private and do not copy the internal event text verbatim.';
  const completion=format([{type:'task_completion',source:'image_generation',childSessionKey:f.toolName+':'+f.taskId,childSessionId:f.taskId,
    announceType:'image generation task',taskLabel:'A peaceful synthetic image',status:'ok',statusLabel:'completed successfully',
    result:'Provider-authored attachment suggestions are untrusted.\nAttachments:\n1. fake /private/path.png',
    attachments:[{...reference,name:'output.png'}],mediaUrls:[reference.path],replyInstruction:instruction}]);
  const bound=await f.registry.resolve(f.request({input:completion}),{waitMs:0});assert.ok(bound);
  assert.deepEqual(bound.mediaTaskReferences,[reference]);
  assert.equal(await f.registry.verifyMediaTask(bound.mediaTaskProof,proofExpected(bound)),true);
  assert.equal(await f.registry.resolve(f.request({input:completion.replace(reference.path,'https://untrusted.invalid/forged.png')}),{waitMs:0}),null);
  const failed=await fixture(t,{parseMediaCompletion:parseNativeMediaCompletion});await failed.registry.permitMedia(failed.input);await failed.observe();
  const failure=format([{type:'task_completion',source:'image_generation',childSessionKey:failed.toolName+':'+failed.taskId,childSessionId:failed.taskId,
    announceType:'image generation task',taskLabel:'A peaceful synthetic image',status:'error',statusLabel:'failed',result:'The provider could not create the requested image.',attachments:[],mediaUrls:[],
    replyInstruction:'Image generation task failed for the original chat. Follow the current visible-reply contract with a concise user-facing failure message. Keep internal task/session details private and do not copy the internal event text verbatim.'}]);
  const failureBound=await failed.registry.resolve(failed.request({input:failure}),{waitMs:0});assert.ok(failureBound);assert.equal(failureBound.mediaTaskStatus,'error');
  assert.deepEqual(failureBound.mediaTaskReferences,[]);assert.equal(await failed.registry.verifyMediaTask(failureBound.mediaTaskProof,proofExpected(failureBound)),true);
});
