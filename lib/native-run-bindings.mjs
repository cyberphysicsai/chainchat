/** Private correlation of reviewed native creation receipts with native lifecycle facts.
 * Session names, model prompts and claimed provenance never establish ownership.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const valid = (value,max=512)=>typeof value === 'string' && value.length>0 && value.length<=max && !/[\0\r\n\u2028\u2029]/u.test(value);
const owner = value=>valid(value,180) && /^[A-Za-z0-9-]{1,100}:[a-f0-9]{64}$/u.test(value);
const automation = name => name === 'automations' || name === 'cron';
const mediaTools = new Set(['image_generate','video_generate','music_generate']);
const mediaTtl = 30 * 60 * 1000;
const fail=()=>Object.assign(new Error('No privately verified native owner binding exists for this run.'),{code:'OPENCLAW_NATIVE_BINDING_REQUIRED'});
export class NativeRunBindings {
  constructor(directory,{now=Date.now,inspectCron,inspectSource,inspectSession,parseMediaCompletion}={}) {this.directory=directory;this.now=now;this.inspectCron=inspectCron;this.inspectSource=inspectSource;this.inspectSession=inspectSession;this.parseMediaCompletion=parseMediaCompletion;this.permits=new Map();this.spawns=new Map();this.children=new Map();this.jobs=new Map();this.sources=new Map();this.mediaTasks=new Map();this.mediaProofs=new WeakMap();this.loading=null;}
  async load() {
    if(this.loading) return this.loading;
    this.loading=(async()=>{
      try {
        const file=path.join(this.directory,'native-run-bindings.json'),stat=await fs.lstat(file);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink>1||stat.size>1024*1024||process.platform!=='win32'&&(stat.mode&0o077)) throw fail();
        const value=JSON.parse(await fs.readFile(file,'utf8'));
        if(![1,2].includes(value.version)||!Array.isArray(value.jobs)||value.jobs.length>1024) throw fail();
        for(const row of value.jobs) {
          if(!row||Object.keys(row).some(key=>!['jobId','parentSessionKey','ownerKey','sourceId'].includes(key))||!valid(row.jobId)||!valid(row.parentSessionKey,2048)||!owner(row.ownerKey)||row.sourceId!==undefined&&!/^[a-f0-9]{64}$/u.test(row.sourceId)) throw fail();
          if(this.jobs.has(row.jobId)) throw fail();this.jobs.set(row.jobId,row);
        }
        if(value.version===2){if(!Array.isArray(value.sources)||value.sources.length>1024)throw fail();for(const row of value.sources){this.validateSource(row);const key=this.sourceKey(row);if(this.sources.has(key))throw fail();this.sources.set(key,row);}}
      } catch(error) {if(error.code!=='ENOENT') throw error;}
      return this;
    })();return this.loading;
  }
  async save() {
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    const file=path.join(this.directory,'native-run-bindings.json'),temporary=file+'.'+randomUUID()+'.tmp';
    await fs.writeFile(temporary,JSON.stringify({version:2,jobs:[...this.jobs.values()],sources:[...this.sources.values()]})+'\n',{flag:'wx',mode:0o600});
    try{await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}
  }
  sweep() {for(const [key,row] of this.permits) if(row.expiresAt<=this.now()) this.permits.delete(key);for(const [key,row]of this.spawns) if(row.expiresAt<=this.now())this.spawns.delete(key);for(const[key,row]of this.children)if(row.expiresAt<=this.now())this.children.delete(key);for(const[key,row]of this.mediaTasks)if(row.expiresAt<=this.now())this.mediaTasks.delete(key);}
  async mediaParent(parentSessionKey) {
    if(typeof this.inspectSession!=='function')throw fail();
    let result;try{result=await this.inspectSession(parentSessionKey);}catch{throw fail();}
    const row=result?.session;
    if(!valid(row?.sessionId,512)||!valid(row.lifecycleRevision,512)||row.key!==undefined&&row.key!==parentSessionKey)throw fail();
    return{sessionId:row.sessionId,lifecycleRevision:row.lifecycleRevision};
  }
  async permitMedia({ownerKey,parentSessionKey,parentRunId,tool,capabilities,sourceId}={}, {assertCurrent=()=>{}}={}) {
    if(!mediaTools.has(tool?.name))return;
    await this.load();this.sweep();
    if(!owner(ownerKey)||!valid(parentSessionKey,2048)||!valid(parentRunId,256)||parentRunId.startsWith('context-assembly:')||!valid(tool.callId,256)||!tool.params||typeof tool.params!=='object'||Array.isArray(tool.params)||
      capabilities?.enabled!==true||capabilities.acknowledged!==true||capabilities.backgroundRuns!==true||!Array.isArray(capabilities.tools)||!capabilities.tools.includes(tool.name)||typeof assertCurrent!=='function')throw fail();
    if(sourceId!==undefined&&this.sources.get(sourceId)?.ownerKey!==ownerKey)throw fail();
    await assertCurrent();
    if(!await this.liveSource({ownerKey,sourceId}))throw fail();
    const proof=await this.mediaParent(parentSessionKey);
    await assertCurrent();
    if(!await this.liveSource({ownerKey,sourceId})||this.permits.size>=1024)throw fail();
    const key=parentSessionKey+'\0'+tool.callId;
    if(this.permits.has(key))throw fail();
    this.permits.set(key,{ownerKey,parentSessionKey,parentRunId,tool:structuredClone(tool),mediaParent:proof,assertCurrent,
      ...(sourceId?{sourceId}:{}),expiresAt:this.now()+120000});
  }
  mediaProof(row) {return{taskId:row.taskId,runId:row.taskRunId,toolName:row.toolName,parentSessionKey:row.parentSessionKey,originalRunId:row.originalRunId,callId:row.callId,
    sessionId:row.sessionId,lifecycleRevision:row.lifecycleRevision};}
  permit({ownerKey,parentSessionKey,tool,capabilities,sourceId}) {
    this.sweep();
    if(!owner(ownerKey)||!valid(parentSessionKey,2048)||!valid(tool?.callId)||!tool.params||capabilities?.enabled!==true||capabilities.acknowledged!==true)return;
    if(['sessions_spawn','sessions_send'].includes(tool.name)&&capabilities.delegatedRuns!==true||automation(tool.name)&&capabilities.backgroundRuns!==true||!['sessions_spawn','sessions_send','cron','automations'].includes(tool.name))return;
    if(sourceId!==undefined&&this.sources.get(sourceId)?.ownerKey!==ownerKey)throw fail();
    if(this.permits.size>=1024)throw fail();
    this.permits.set(parentSessionKey+'\0'+tool.callId,{ownerKey,parentSessionKey,tool:structuredClone(tool),...(sourceId?{sourceId}:{}),expiresAt:this.now()+120000});
  }
  spawned({requesterSessionKey,childSessionKey,runId,agentId}) {
    this.sweep();
    if(![requesterSessionKey,childSessionKey,runId,agentId].every(value=>valid(value,2048))||requesterSessionKey===childSessionKey||this.spawns.size>=1024)throw fail();
    if(![...this.permits.values()].some(row=>row.parentSessionKey===requesterSessionKey&&row.tool.name==='sessions_spawn'))throw fail();
    this.spawns.set(childSessionKey,{requesterSessionKey,childSessionKey,runId,agentId,expiresAt:this.now()+120000});
  }
  async observed({parentSessionKey,tool,outcome}) {
    await this.load();this.sweep();
    const key=parentSessionKey+'\0'+tool?.callId,permit=this.permits.get(key);
    if(!permit||permit.tool.name!==tool.name)return;
    const result=outcome?.result?.details;
    if(mediaTools.has(tool.name)) {
      if(permit.mediaObserved)return;
      permit.mediaObserved=true;
      try {
      if(!permit.mediaParent||outcome?.success!==true||outcome.result?.isError===true||result?.async!==true||result.status!=='started'||result.existingTask===true||
        !valid(result.taskId,256)||result.taskId!==result.runId||result.task!==undefined&&
          (!result.task||result.task.taskId!==result.taskId||result.task.runId!==result.runId)||this.mediaTasks.has(result.taskId)||this.mediaTasks.size>=1024)return;
      await permit.assertCurrent();
      if(!await this.liveSource(permit))return;
      const proof=await this.mediaParent(parentSessionKey);await permit.assertCurrent();
      if(proof.sessionId!==permit.mediaParent.sessionId||proof.lifecycleRevision!==permit.mediaParent.lifecycleRevision||!await this.liveSource(permit)||permit.expiresAt<=this.now()||this.mediaTasks.has(result.taskId)||this.mediaTasks.size>=1024)return;
      const row={taskId:result.taskId,taskRunId:result.runId,toolName:tool.name,parentSessionKey,ownerKey:permit.ownerKey,originalRunId:permit.parentRunId,callId:permit.tool.callId,
        ...proof,...(permit.sourceId?{sourceId:permit.sourceId}:{}),expiresAt:this.now()+mediaTtl,completionRunId:null,finalized:false,proofEpoch:0};
      this.mediaTasks.set(row.taskId,row);return{mediaTask:this.mediaProof(row)};
      }finally{if(this.permits.get(key)===permit)this.permits.delete(key);}
    }
    if(outcome?.success!==true)return;
    if(tool.name==='sessions_spawn') {
      const childSessionKey=result?.childSessionKey,runId=result?.runId;
      if(!valid(childSessionKey,2048)||!valid(runId))return;
      const spawn=this.spawns.get(childSessionKey);
      if(!spawn||spawn.requesterSessionKey!==parentSessionKey||spawn.runId!==runId)return;
      this.children.set(childSessionKey,{ownerKey:permit.ownerKey,parentSessionKey,kind:'subagent',runId,agentId:spawn.agentId,...(permit.sourceId?{sourceId:permit.sourceId}:{}),expiresAt:this.now()+60*60*1000});
      this.permits.delete(key);
    } else if(tool.name==='sessions_send') {
      const target=result?.sessionKey||permit.tool.params.sessionKey,child=this.children.get(target),nextRun=result?.runId;
      if(!child||child.ownerKey!==permit.ownerKey||!valid(nextRun)||result?.status==='error'||permit.tool.params.sessionKey&&permit.tool.params.sessionKey!==target)return;
      this.children.set(target,{...child,runId:nextRun,expiresAt:this.now()+60*60*1000});this.permits.delete(key);
    } else if(automation(tool.name)&&['add','update'].includes(permit.tool.params.action)) {
      const jobId=result?.id||result?.job?.id;
      if(!valid(jobId)||typeof this.inspectCron!=='function')return;
      const actual=await this.inspectCron(jobId);
      if(actual?.id!==jobId||actual.owner?.sessionKey!==parentSessionKey||actual.payload?.kind!=='agentTurn')return;
      if(this.jobs.size>=1024&&!this.jobs.has(jobId))throw fail();
      this.jobs.set(jobId,{jobId,parentSessionKey,ownerKey:permit.ownerKey,...(permit.sourceId?{sourceId:permit.sourceId}:{})});await this.save();this.permits.delete(key);
    } else if(automation(tool.name)&&permit.tool.params.action==='remove') {
      const jobId=permit.tool.params.jobId||permit.tool.params.id;
      if(this.jobs.get(jobId)?.ownerKey===permit.ownerKey){this.jobs.delete(jobId);await this.save();}this.permits.delete(key);
    }
  }
  sourceKey(row){return createHash('sha256').update(JSON.stringify([row.kind,row.agentId,row.channelId||'',row.accountId||'',row.nativeSessionKey||''])).digest('hex');}
  validateSource(row){
    if(!row||!owner(row.ownerKey)||!['channel','heartbeat','background'].includes(row.kind)||!valid(row.agentId,128)||!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(row.agentId)||
      Object.keys(row).some(key=>!['ownerKey','kind','agentId','channelId','accountId','nativeSessionKey'].includes(key)))throw fail();
    if(row.kind==='channel'&&(!valid(row.channelId,128)||!valid(row.accountId,128)||row.nativeSessionKey!==undefined)||
      row.kind!=='channel'&&(row.channelId!==undefined||row.accountId!==undefined)||row.kind==='heartbeat'&&row.nativeSessionKey!==undefined||row.kind==='background'&&!valid(row.nativeSessionKey,2048))throw fail();
  }
  async enroll(row){await this.load();this.validateSource(row);if(typeof this.inspectSource!=='function'||!await this.inspectSource(row))throw fail();const key=this.sourceKey(row),previous=this.sources.get(key);if(previous&&previous.ownerKey!==row.ownerKey||!previous&&this.sources.size>=1024)throw fail();this.sources.set(key,structuredClone(row));await this.save();return structuredClone(row);}
  async revoke(ownerKey,key){await this.load();if(this.sources.get(key)?.ownerKey!==ownerKey)throw fail();this.sources.delete(key);await this.save();}
  async list(ownerKey){await this.load();return [...this.sources.values()].filter(row=>row.ownerKey===ownerKey).map(row=>({...row,id:this.sourceKey(row)}));}
  async liveSource(row){if(!row.sourceId)return true;const source=this.sources.get(row.sourceId);return !!(source&&source.ownerKey===row.ownerKey&&typeof this.inspectSource==='function'&&await this.inspectSource(source));}
  /** Routing hint only. It grants no run, task reservation, proof or executor.
   * Native selection can precede the typed media-completion envelope; retained
   * private receipts can select the owner's connection, while later admission
   * still requires the complete native provenance and opaque completion proof. */
  async modelRouteOwner(request={}) {
    const {sessionKey,runId,nativeContext}=request;
    await this.load();
    if(!valid(sessionKey,2048)||runId!==undefined&&!valid(runId,512))return null;
    const owners=new Set(),guards=[],sourceChecks=new Map();
    const sourceLive=async row=>{
      if(!row.sourceId)return true;
      const source=this.sources.get(row.sourceId);
      if(!source||source.ownerKey!==row.ownerKey||typeof this.inspectSource!=='function')return false;
      if(!sourceChecks.has(source))sourceChecks.set(source,Promise.resolve().then(()=>this.inspectSource(source)));
      if(!await sourceChecks.get(source))return false;
      guards.push(()=>this.sources.get(row.sourceId)===source);
      return this.sources.get(row.sourceId)===source;
    };
    const add=row=>{if(owner(row.ownerKey))owners.add(row.ownerKey);};
    try {
      // The parent key alone is not ownership: these rows exist only after an
      // approved tool, actual native async-start receipt and parent snapshot.
      const pending=row=>row.parentSessionKey===sessionKey&&!row.finalized&&row.expiresAt>this.now();
      const media=[...this.mediaTasks.values()].filter(pending);
      let parent=null;
      if(media.length)parent=await this.mediaParent(sessionKey);
      const usableMedia=[];
      for(const row of media) {
        const epoch=row.proofEpoch,completionRunId=row.completionRunId;
        const current=()=>this.mediaTasks.get(row.taskId)===row&&!row.finalized&&row.expiresAt>this.now()&&
          row.proofEpoch===epoch&&row.completionRunId===completionRunId&&(!completionRunId||runId===completionRunId);
        if(!current()||parent.sessionId!==row.sessionId||parent.lifecycleRevision!==row.lifecycleRevision||
          nativeContext?.sessionId!==undefined&&nativeContext.sessionId!==row.sessionId||!await sourceLive(row)||!current())continue;
        usableMedia.push(row);guards.push(current);add(row);
      }
      guards.push(()=>{const current=[...this.mediaTasks.values()].filter(pending);return current.length===media.length&&current.every(row=>media.includes(row));});
      const child=this.children.get(sessionKey);
      if(child&&child.expiresAt>this.now()&&(!runId||child.runId===runId)&&(!nativeContext?.agentId||nativeContext.agentId===child.agentId)&&await sourceLive(child)) {
        guards.push(()=>this.children.get(sessionKey)===child&&child.expiresAt>this.now());add(child);
      }
      const jobId=nativeContext?.jobId,job=this.jobs.get(jobId);
      if(job&&typeof this.inspectCron==='function'&&await sourceLive(job)) {
        const actual=await this.inspectCron(jobId);
        if(actual?.id===jobId&&actual.owner?.sessionKey===job.parentSessionKey&&actual.payload?.kind==='agentTurn'&&actual.enabled!==false) {
          guards.push(()=>this.jobs.get(jobId)===job);add(job);
        }
      }
      const matches=source=>source.kind==='background'&&source.nativeSessionKey===sessionKey&&(!nativeContext?.agentId||source.agentId===nativeContext.agentId)||
        source.agentId===nativeContext?.agentId&&(source.kind==='channel'&&source.channelId===nativeContext.channel&&source.accountId===nativeContext.accountId||
          source.kind==='heartbeat'&&nativeContext.trigger==='heartbeat');
      const sources=[...this.sources.values()].filter(matches);
      if(typeof this.inspectSource==='function')for(const source of sources) {
        if(!sourceChecks.has(source))sourceChecks.set(source,Promise.resolve().then(()=>this.inspectSource(source)));
        if(await sourceChecks.get(source)){guards.push(()=>this.sources.get(this.sourceKey(source))===source);add(source);}
      }
      guards.push(()=>{const current=[...this.sources.values()].filter(matches);return current.length===sources.length&&current.every(row=>sources.includes(row));});
      if(usableMedia.length) {
        const after=await this.mediaParent(sessionKey);
        if(after.sessionId!==parent.sessionId||after.lifecycleRevision!==parent.lifecycleRevision)return null;
      }
      return owners.size===1&&guards.every(check=>check())?[...owners][0]:null;
    }catch{return null;}
  }
  async resolveMedia({sessionKey,runId,nativeContext,op,input}={}) {
    const provenance=nativeContext?.inputProvenance;
    if(provenance?.kind!=='inter_session'||provenance.sourceChannel!=='internal'||!mediaTools.has(provenance.sourceTool)||!valid(provenance.sourceSessionKey,1024))return null;
    // Compare the complete source identity only against an actual reviewed
    // tool-result receipt. A recognizable prefix or prompt never adds a task.
    const row=[...this.mediaTasks.values()].find(task=>provenance.sourceTool===task.toolName&&provenance.sourceSessionKey===task.toolName+':'+task.taskId);
    if(!row||row.parentSessionKey!==sessionKey||nativeContext.sessionId!==row.sessionId||row.expiresAt<=this.now())return null;
    const proofEpoch=row.proofEpoch;
    try {
      if(!await this.liveSource(row))return null;
      const proof=await this.mediaParent(row.parentSessionKey);
      if(this.mediaTasks.get(row.taskId)!==row||proof.sessionId!==row.sessionId||proof.lifecycleRevision!==row.lifecycleRevision||!await this.liveSource(row))return null;
      if(typeof this.parseMediaCompletion!=='function'||typeof input!=='string'||!input.length||Buffer.byteLength(input,'utf8')>1024*1024||input.includes('\0'))return null;
      const parsed=await this.parseMediaCompletion(input,{toolName:row.toolName,taskId:row.taskId});
      const bodySha256=createHash('sha256').update(input,'utf8').digest('hex');
      // Failure authority requires the exact parser's explicit error result and
      // no references. An unspecified outcome never establishes completion.
      const status=parsed?.status;
      if(parsed?.taskId!==row.taskId||parsed.runId!==row.taskRunId||parsed.toolName!==row.toolName||parsed.bodySha256!==bodySha256||!this.mediaReferences(parsed.references,row.toolName,status))return null;
      if(this.mediaTasks.get(row.taskId)!==row||row.expiresAt<=this.now()||row.proofEpoch!==proofEpoch)return null;
      if(row.completionStatus&&row.completionStatus!==status)return null;
      const actualRun=valid(runId,256)&&!runId.startsWith('context-assembly:');
      if(actualRun) {
        if(row.finalized||op!=='admit'||row.completionRunId&&row.completionRunId!==runId)return null;
        if(row.bodySha256&&row.bodySha256!==bodySha256)return null;
        row.completionRunId=runId;
      } else if(runId!==undefined||!row.completionRunId)return null;
      if(row.bodySha256&&row.bodySha256!==bodySha256)return null;
      if(!row.completionProof) {
        const descriptor={taskId:row.taskId,runId:row.taskRunId,toolName:row.toolName,parentSessionKey:row.parentSessionKey,
          originalRunId:row.originalRunId,callId:row.callId,references:structuredClone(parsed.references)};
        const proof=Object.freeze({id:randomUUID()});
        this.mediaProofs.set(proof,{row,descriptor,status,epoch:row.proofEpoch,completionRunId:row.completionRunId,bodySha256});
        row.completionProof=proof;row.bodySha256=bodySha256;row.completionStatus=status;
      }
      return{ownerKey:row.ownerKey,nativeSessionKey:sessionKey,kind:'media-completion',chainKey:'media:'+row.taskId,
        parentSessionKey:row.parentSessionKey,taskId:row.taskId,taskRunId:row.taskRunId,toolName:row.toolName,
        mediaTask:this.mediaProof(row),mediaTaskStatus:status,mediaTaskReferences:structuredClone(parsed.references),mediaTaskProof:row.completionProof,...(row.sourceId?{sourceId:row.sourceId}:{})};
    }catch{return null;}
  }
  mediaReferences(value,toolName,status='ok') {
    if(status==='error')return Array.isArray(value)&&value.length===0;
    if(status!=='ok')return false;
    const kind={image_generate:'image',video_generate:'video',music_generate:'audio'}[toolName];
    return Array.isArray(value)&&value.length>0&&value.length<=32&&new Set(value.map(row=>row?.path)).size===value.length&&value.every(row=>
      row&&Object.keys(row).sort().join(',')==='mimeType,path,type'&&row.type===kind&&valid(row.path,32768)&&path.isAbsolute(row.path)&&
      valid(row.mimeType,128)&&row.mimeType.startsWith(kind+'/'));
  }
  async verifyMediaTask(proof,expected) {
    const captured=proof&&this.mediaProofs.get(proof),row=captured?.row;
    if(!row||this.mediaTasks.get(row.taskId)!==row||row.expiresAt<=this.now()||captured.epoch!==row.proofEpoch||captured.completionRunId!==row.completionRunId||
      row.bodySha256!==captured.bodySha256||captured.status!==row.completionStatus||!isDeepStrictEqual(expected,captured.descriptor))throw fail();
    if(!await this.liveSource(row))throw fail();
    const current=await this.mediaParent(row.parentSessionKey);
    if(current.sessionId!==row.sessionId||current.lifecycleRevision!==row.lifecycleRevision||!await this.liveSource(row))throw fail();
    // Retry/revocation may occur during native/source inspection. Compare the
    // opaque receipt again only after every awaited freshness operation.
    if(this.mediaTasks.get(row.taskId)!==row||row.expiresAt<=this.now()||captured.epoch!==row.proofEpoch||captured.completionRunId!==row.completionRunId||row.bodySha256!==captured.bodySha256||captured.status!==row.completionStatus)throw fail();
    return true;
  }
  finishMediaTask({ownerKey,taskId,parentSessionKey,runId,finalized}={}) {
    this.sweep();const row=this.mediaTasks.get(taskId);
    if(!row||ownerKey!==row.ownerKey||parentSessionKey!==row.parentSessionKey||runId!==row.completionRunId||typeof finalized!=='boolean')throw fail();
    if(finalized)row.finalized=true;
    else if(!row.finalized){row.completionRunId=null;row.completionProof=null;row.bodySha256=null;row.completionStatus=null;row.proofEpoch++;}
  }
  async resolve(request={}, {waitMs=4000}={}) {
    const {sessionKey,runId,nativeContext}=request;
    await this.load();this.sweep();
    if(!valid(sessionKey,2048))return null;
    const deadline=this.now()+waitMs;
    for(;;) {
      if(mediaTools.has(nativeContext?.inputProvenance?.sourceTool)) {
        const result=await this.resolveMedia(request);if(result)return result;
        const pending=[...this.permits.values()].some(permit=>permit.mediaParent&&permit.parentSessionKey===sessionKey&&permit.tool.name===nativeContext.inputProvenance.sourceTool&&permit.mediaParent.sessionId===nativeContext.sessionId);
        if(pending&&request.op==='admit'&&valid(runId,256)&&!runId.startsWith('context-assembly:')&&this.now()<deadline){await new Promise(resolve=>setTimeout(resolve,25));this.sweep();continue;}
        return null;
      }
      const row=this.children.get(sessionKey);
      if(row) {
        if(!await this.liveSource(row))return null;
        if(nativeContext?.agentId&&nativeContext.agentId!==row.agentId)return null;
        if(runId&&!runId.startsWith('context-assembly:')&&row.runId!==runId){
          const pending=[...this.permits.values()].some(permit=>permit.ownerKey===row.ownerKey&&permit.tool.name==='sessions_send'&&permit.tool.params.sessionKey===sessionKey);
          if(pending&&this.now()<deadline){await new Promise(resolve=>setTimeout(resolve,25));continue;}return null;
        }
        return {ownerKey:row.ownerKey,nativeSessionKey:sessionKey,chainKey:sessionKey,kind:'subagent',parentSessionKey:row.parentSessionKey,...(row.sourceId?{sourceId:row.sourceId}:{})};
      }
      const jobId=nativeContext?.jobId,job=this.jobs.get(jobId);
      if(job&&typeof this.inspectCron==='function') {
        if(!await this.liveSource(job))return null;
        const actual=await this.inspectCron(jobId);
        if(actual?.id===jobId&&actual.owner?.sessionKey===job.parentSessionKey&&actual.payload?.kind==='agentTurn'&&actual.enabled!==false)
          return {ownerKey:job.ownerKey,nativeSessionKey:sessionKey,chainKey:'cron:'+jobId,kind:'cron',jobId,parentSessionKey:job.parentSessionKey,...(job.sourceId?{sourceId:job.sourceId}:{})};
        return null;
      }
      if(valid(nativeContext?.agentId,128)&&typeof this.inspectSource==='function') {
        const candidates=[...this.sources.values()].filter(source=>source.agentId===nativeContext.agentId&&(
          source.kind==='channel'&&source.channelId===nativeContext.channel&&source.accountId===nativeContext.accountId||
          source.kind==='heartbeat'&&valid(nativeContext.heartbeatEventQueueSessionKey,2048)||
          source.kind==='background'&&source.nativeSessionKey===sessionKey));
        if(candidates.length===1&&await this.inspectSource(candidates[0])){const source=candidates[0];return{ownerKey:source.ownerKey,nativeSessionKey:sessionKey,chainKey:source.kind==='heartbeat'?'heartbeat:'+source.agentId:sessionKey,kind:source.kind,sourceId:this.sourceKey(source)};}
      }
      // Only a real native spawn observation can justify waiting for its
      // matching tool result. Unknown arbitrary sessions fail immediately.
      const pendingCreation=[...this.permits.values()].some(permit=>permit.tool.name==='sessions_spawn'||automation(permit.tool.name)&&permit.tool.params.action==='add');
      if(!this.spawns.has(sessionKey)&&!pendingCreation||this.now()>=deadline)return null;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
}
