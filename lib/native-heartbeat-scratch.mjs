/** Owner notes for an enrolled, actual native system heartbeat monitor. */
const fail=(message,code='OPENCLAW_HEARTBEAT_SCRATCH_INVALID',status=400)=>Object.assign(new Error(message),{code,status});
const MAX_BYTES=262144;
const timestamp=value=>Number.isSafeInteger(value)&&value>=0?value:null;
export function heartbeatMonitorStatus(job){
  const state=job.state||{},status=state.lastRunStatus??state.lastStatus;
  const reason=state.lastError??state.lastSkipReason;
  return{enabled:job.enabled!==false,intervalMs:job.schedule?.kind==='every'?timestamp(job.schedule.everyMs):null,
    nextRunAtMs:timestamp(state.nextRunAtMs),lastRunAtMs:timestamp(state.lastRunAtMs),
    lastRunStatus:['ok','error','skipped','running'].includes(status)?status:null,
    lastSkipReason:['empty-heartbeat-file','disabled','no-route','alerts-disabled','requests-in-flight','cron-in-progress','quiet-hours'].includes(reason)?reason:null};
}
export async function readNativeHeartbeatMonitor(rpc,agentId){
  const result=await rpc('cron.list',{includeDisabled:true}),jobs=result.jobs;
  if(!Array.isArray(jobs)||jobs.length>10000)throw fail('The native heartbeat monitor is unavailable.','OPENCLAW_HEARTBEAT_SCRATCH_UNAVAILABLE',503);
  const matches=jobs.filter(job=>job&&job.declarationKey==='heartbeat:'+agentId&&job.agentId===agentId&&job.payload?.kind==='heartbeat'&&job.sessionTarget==='main');
  if(matches.length!==1||typeof matches[0].id!=='string'||matches[0].id.length>256)throw fail('The native heartbeat monitor is unavailable.','OPENCLAW_HEARTBEAT_SCRATCH_UNAVAILABLE',503);
  return matches[0];
}
export function createNativeHeartbeatScratch({rpc,listSources,inspectSource,assertIsolation=()=>{}}){
  async function monitor(ownerKey,id){
    const sources=await listSources(ownerKey),source=sources.find(row=>row.id===id&&row.kind==='heartbeat');
    if(!source||!await inspectSource(source))throw fail('Choose a currently enrolled heartbeat source.','OPENCLAW_NATIVE_BINDING_REQUIRED',403);
    const job=await readNativeHeartbeatMonitor(rpc,source.agentId);
    return{source,jobId:job.id,job};
  }
  return async function heartbeatScratch({ownerKey,id,action,content,expectedRevision,canWrite=false}){
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/u.test(id)||!['scratch-get','scratch-set'].includes(action))throw fail('Invalid heartbeat scratch action.');
    if(action==='scratch-set'){
      if(!canWrite)throw fail('Editing heartbeat notes requires the current owner background grant.','OPENCLAW_NATIVE_BINDING_REQUIRED',403);
      if(content!==null&&(typeof content!=='string'||Buffer.byteLength(content)>MAX_BYTES||content.includes('\0'))||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fail('Use bounded heartbeat notes and their current revision.');
      assertIsolation(content);
    }else if(content!==undefined||expectedRevision!==undefined)throw fail('A heartbeat read has no write fields.');
    const before=await monitor(ownerKey,id);
    const result=await rpc(action==='scratch-get'?'cron.scratch.get':'cron.scratch.set',{id:before.jobId,...(action==='scratch-set'?{content,expectedRevision}:{})});
    const after=await monitor(ownerKey,id);
    if(before.jobId!==after.jobId||before.source.agentId!==after.source.agentId)throw fail('The heartbeat source changed. Refresh before editing.','OPENCLAW_NATIVE_BINDING_REQUIRED',409);
    if(action==='scratch-set'&&result.ok!==true)throw fail('Heartbeat notes changed. Refresh before saving.','OPENCLAW_HEARTBEAT_SCRATCH_STALE',409);
    if(!Number.isSafeInteger(result.currentRevision)||result.currentRevision<0||result.scratch!==null&&result.scratch!==undefined&&(typeof result.scratch.content!=='string'||Buffer.byteLength(result.scratch.content)>MAX_BYTES))throw fail('The native heartbeat scratch response is invalid.','OPENCLAW_HEARTBEAT_SCRATCH_UNAVAILABLE',502);
    const output={sourceId:id,agentId:after.source.agentId,content:result.scratch?.content??null,currentRevision:result.currentRevision,maxBytes:MAX_BYTES,monitor:heartbeatMonitorStatus(after.job),
      notice:'Owner monitor notes only; no tool authority. An empty scratch skips scheduled heartbeat model work. Native automations must be enabled. Removing the scratch restores the configured native heartbeat prompt.'};
    assertIsolation(output);return output;
  };
}
