/** Offline, publisher-supported native schema upgrades; never a model/tool API. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {assertRuntimeCompatibility} from './runtime-compatibility.mjs';

const execute = promisify(execFile), tickets = new WeakMap();
const PIN = '2026.10.10', MAX_FILES = 20000, MAX_BYTES = 2 * 1024 ** 3;
const error = (code = 'MIGRATION_REQUIRED') => Object.assign(new Error(code === 'MIGRATION_FAILED'
  ? 'The offline native upgrade did not complete. Its private pre-upgrade backup was retained; inspect recovery before retrying.'
  : 'The native state needs a supported offline migration or local inspection before startup.'), {code,status:503});
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const agentId = value => typeof value === 'string' && idPattern.test(value) && !/[\r\n\u2028\u2029]/.test(value);
const same = (a,b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function stat(file) {try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw error();}}
function owned(info, directory = false) {
  if (!info || info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) ||
      !directory && info.nlink !== 1 || process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) throw error();
}
export async function validateOwnedStateDirectory(directory, {missing = false} = {}) {
  if (!path.isAbsolute(directory || '')) throw error();
  const info = await stat(directory);
  if (!info && missing) return false;
  owned(info,true);
  if (await fs.realpath(directory) !== path.resolve(directory)) throw error();
  return true;
}
async function privateFile(file, limit = 1024 * 1024) {
  const info = await stat(file); owned(info);
  if(info.size > limit || process.platform !== 'win32' && info.mode & 0o077)throw error('MIGRATION_FAILED');
  return fs.readFile(file);
}
async function atomicJson(file,value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temp,'wx',0o600);
  try {await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  await fs.rename(temp,file);
}
async function command(file,args,options) {
  try {const result = await execute(file,args,{...options,windowsHide:true,shell:false,encoding:'utf8',maxBuffer:1024*1024});return {exitCode:0,stdout:result.stdout};}
  catch(e) {if(Number.isInteger(e.code)&&typeof e.stdout==='string'&&Buffer.byteLength(e.stdout)<=1024*1024)return {exitCode:e.code,stdout:e.stdout};throw error('MIGRATION_FAILED');}
}
async function makePrivateDirectory(directory, run = command) {
  await fs.mkdir(directory,{mode:0o700});
  if(process.platform==='win32') {
    const system = path.join(process.env.SystemRoot || 'C:\\Windows','System32');
    const who = await run(path.join(system,'whoami.exe'),['/user','/fo','csv','/nh'],{timeout:10000});
    const sids = [...String(who.stdout).matchAll(/S-1-(?:[0-9]+-)*[0-9]+/g)].map(match=>match[0]);
    if(who.exitCode!==0 || sids.length!==1 || sids[0].length>184)throw error('MIGRATION_FAILED');
    const acl = await run(path.join(system,'icacls.exe'),[directory,'/inheritance:r','/grant:r',
      `*${sids[0]}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{timeout:10000});
    if(acl.exitCode!==0)throw error('MIGRATION_FAILED');
  }
  await validateOwnedStateDirectory(directory);
  const info = await fs.lstat(directory);
  if(process.platform!=='win32' && info.mode & 0o077)throw error('MIGRATION_FAILED');
}
async function readHash(file) {const before=await stat(file);owned(before);
  if(await fs.realpath(file)!==path.resolve(file))throw error('MIGRATION_FAILED');
  const handle=await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {if(!same(before,await handle.stat()))throw error('MIGRATION_FAILED');
    const hash=createHash('sha256');for await(const bytes of handle.createReadStream({autoClose:false}))hash.update(bytes);
    if(!same(before,await handle.stat())||!same(before,await stat(file)))throw error('MIGRATION_FAILED');
    return hash.digest('hex');}
  finally{await handle.close();}}
async function copyChecked(source,destination) {
  const before=await stat(source);owned(before);
  const input=await fs.open(source,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));let output;
  try {
    if(!same(before,await input.stat()))throw error('MIGRATION_FAILED');
    output=await fs.open(destination,'wx',0o600);let bytes=0;const hash=createHash('sha256');
    for await(const chunk of input.createReadStream({autoClose:false})) {bytes+=chunk.length;hash.update(chunk);
      for(let offset=0;offset<chunk.length;){const written=await output.write(chunk,offset,chunk.length-offset);if(written.bytesWritten<=0)throw error('MIGRATION_FAILED');offset+=written.bytesWritten;}}
    await output.sync();
    const digest=hash.digest('hex');
    if(bytes!==before.size||!same(before,await input.stat())||!same(before,await stat(source))||
      await readHash(source)!==digest||await readHash(destination)!==digest)throw error('MIGRATION_FAILED');
    return {bytes,sha256:digest};
  } finally {await output?.close();await input.close();}
}
async function coreFiles(directory) {
  const native=path.join(directory,'native-state'), files=[];
  if(!await stat(native))return files;
  await validateOwnedStateDirectory(native);
  const shared=path.join(native,'state');
  if(await stat(shared)) {await validateOwnedStateDirectory(shared);if(await stat(path.join(shared,'openclaw.sqlite')))files.push({relative:'native-state/state/openclaw.sqlite',role:'global'});}
  const agents=path.join(native,'agents');if(!await stat(agents))return files;
  await validateOwnedStateDirectory(agents);const names=await fs.readdir(agents);if(names.length>4096)throw error();let count=0;
  for(const name of names.sort()) {
    const home=path.join(agents,name),info=await stat(home);
    if(info?.isFile()){owned(info);continue;} // .DS_Store/desktop.ini are not native agents.
    if(!agentId(name)||++count>128)throw error();await validateOwnedStateDirectory(home);
    const agent=path.join(home,'agent');if(!await stat(agent))continue;await validateOwnedStateDirectory(agent);
    if(await stat(path.join(agent,'openclaw-agent.sqlite')))files.push({relative:`native-state/agents/${name}/agent/openclaw-agent.sqlite`,role:'agent',agentId:name});
  }
  return files;
}
async function inspectFacts(directory, run) {
  const files=await coreFiles(directory);if(!files.length)return [];
  const temp=path.join(path.dirname(directory),'.'+path.basename(directory)+'-native-inspect-'+randomUUID());
  await makePrivateDirectory(temp,run);
  const facts=[];
  try {
    const {DatabaseSync}=await import('node:sqlite');
    for(let index=0;index<files.length;index++) {
      const file=files[index],original=path.join(directory,file.relative),copy=path.join(temp,String(index)+'.sqlite');
      const copied=await copyChecked(original,copy);
      for(const suffix of ['-wal','-shm','-journal'])if(await stat(original+suffix))await copyChecked(original+suffix,copy+suffix);
      const db=new DatabaseSync(copy,{readOnly:true,timeout:1000});
      try {
        db.exec('PRAGMA query_only=ON');
        const version=db.prepare('PRAGMA user_version').get().user_version;
        const meta=db.prepare("SELECT role,schema_version,agent_id FROM schema_meta WHERE meta_key='primary'").get();
        const integrity=db.prepare('PRAGMA integrity_check').all();
        const valid=integrity.length===1&&Object.values(integrity[0])[0]==='ok';
        if(!meta||!valid||meta.role!==file.role||meta.schema_version!==version||
          file.role==='agent'&&meta.agent_id!==file.agentId||file.role==='global'&&meta.agent_id!==null)throw error();
        if(![...(file.role==='global'?[20,22]:[25,27])].includes(version))throw error();
        facts.push({...file,version,sha256:copied.sha256,integrityOk:true});
      } finally{db.close();}
    }
    return facts;
  } catch(e) {if(['MIGRATION_REQUIRED','MIGRATION_FAILED'].includes(e.code))throw e;throw error();}
  finally {if(path.dirname(temp)!==path.dirname(directory)||!path.basename(temp).startsWith('.'+path.basename(directory)+'-native-inspect-'))throw error();await fs.rm(temp,{recursive:true,force:true});}
}
export function classifyNativeUpgrade(lint,facts) {
  if(!plain(lint)||lint.schemaVersion!==1||typeof lint.ok!=='boolean'||!Array.isArray(lint.findings)||lint.findings.length>256)throw error();
  if(!Array.isArray(facts)||facts.length>129||facts.filter(row=>row.role==='global').length>1)throw error();
  const keys=new Set();
  for(const row of facts){const key=row.role==='global'?'global':row.agentId;
    if(!plain(row)||row.integrityOk!==true||keys.has(key)||
      !(row.role==='global'&&[20,22].includes(row.version)||row.role==='agent'&&agentId(row.agentId)&&[25,27].includes(row.version)))throw error();
    keys.add(key);}
  const shared=facts.find(row=>row.role==='global'),old=facts.filter(row=>row.role==='agent'&&row.version===25);
  let pending=false;const allowed=new Set();
  for(const finding of lint.findings) {
    if(!plain(finding)||!['info','warning','error'].includes(finding.severity))throw error();
    if(finding.severity==='info')continue;
    if(finding.checkId==='core/doctor/state-schema'&&finding.requirement==='state-schema-migration-pending'&&finding.severity==='warning'&&shared?.version===20){pending=true;continue;}
    if(finding.checkId==='core/doctor/agent-database-admission'&&finding.requirement==='agent-database-inspection-failed'&&finding.severity==='warning'&&
      old.some(row=>row.agentId===finding.target)&&typeof finding.message==='string'&&finding.message.includes('uses schema version 25; stop active agents and run openclaw doctor --fix to migrate session identities before using it.')){allowed.add(finding.target);continue;}
    throw error();
  }
  if(shared?.version===20&&!pending||old.some(row=>!pending&&!allowed.has(row.agentId)))throw error();
  return pending||old.length>0;
}
async function inventory(directory) {
  const rows=[];let total=0;
  const visit=async(relative='',depth=0)=>{
    if(depth>32)throw error('MIGRATION_FAILED');
    for(const name of (await fs.readdir(path.join(directory,relative))).sort()) {
      const child=path.join(relative,name),file=path.join(directory,child),info=await fs.lstat(file);
      if(++total>MAX_FILES)throw error('MIGRATION_FAILED');
      if(info.isSymbolicLink()){
        const normalized=child.split(path.sep).join('/');
        if(!/^(?:workspace\/skills|native-state\/plugin-skills)\/[^/]+$/.test(normalized))throw error('MIGRATION_FAILED');
        rows.push({path:child,type:'link',target:await fs.readlink(file)});continue;
      }
      if(info.isDirectory()){owned(info,true);rows.push({path:child,type:'directory',mode:info.mode&0o777});await visit(child,depth+1);}
      else {owned(info);rows.push({path:child,type:'file',bytes:info.size,mode:info.mode&0o777});}
    }
  };await visit();if(rows.reduce((sum,row)=>sum+(row.bytes||0),0)>MAX_BYTES)throw error('MIGRATION_FAILED');return rows;
}
async function backupDirectory(directory,run,facts) {
  const id=randomUUID(),backup=path.join(path.dirname(directory),'.'+path.basename(directory)+'-native-backup-'+id);
  await makePrivateDirectory(backup,run);await fs.mkdir(path.join(backup,'files'),{mode:0o700});
  const rows=await inventory(directory),entries=[];
  for(const row of rows) {
    if(row.type==='directory'){await fs.mkdir(path.join(backup,'files',row.path),{mode:0o700});entries.push(row);}
    else if(row.type==='file')entries.push({...row,...await copyChecked(path.join(directory,row.path),path.join(backup,'files',row.path))});
    else entries.push(row); // Link/junction targets are metadata only, never traversed or recreated.
  }
  for(const fact of facts)if(entries.find(row=>row.path===path.normalize(fact.relative))?.sha256!==fact.sha256)throw error('MIGRATION_FAILED');
  const manifest={version:1,id,source:path.resolve(directory),targetSdk:PIN,createdAt:new Date().toISOString(),entries};
  await atomicJson(path.join(backup,'manifest.json'),manifest);
  const manifestSha256=sha(await fs.readFile(path.join(backup,'manifest.json')));
  return {id,directory:backup,manifestSha256,manifest};
}
function receiptPath(directory){return path.join(path.dirname(directory),'.'+path.basename(directory)+'-native-upgrade.json');}
async function assertPin(packageRoot) {
  const info=JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'),'utf8'));
  if(info.name!=='openclaw'||info.version!==PIN)throw error();
  await assertRuntimeCompatibility(packageRoot);
}
export async function prepareNativeUpgrade({directory,packageRoot,nodePath=process.execPath,onDiagnostic,runCommand=command,verifyRuntime=assertPin}={}) {
  try {
  if(!path.isAbsolute(directory||'')||typeof runCommand!=='function'||typeof verifyRuntime!=='function'||
      verifyRuntime!==assertPin&&!process.env.NODE_TEST_CONTEXT||!path.isAbsolute(packageRoot||'')||!path.isAbsolute(nodePath))throw error();
  directory=path.resolve(directory);
  if(!await validateOwnedStateDirectory(directory,{missing:true})){const ticket=Object.freeze({required:false,status:'fresh',backup:null});tickets.set(ticket,{done:true});return ticket;}
  const marker=receiptPath(directory);
  if(await stat(marker)) {
    let prior;try{prior=JSON.parse(await privateFile(marker));}catch{throw error('MIGRATION_FAILED');}
    if(prior.version!==1||prior.source!==directory||!['complete','pending','failed'].includes(prior.status))throw error('MIGRATION_FAILED');
    if(prior.status!=='complete')throw error('MIGRATION_FAILED');
  }
  const facts=await inspectFacts(directory,runCommand);
  const required=facts.some(row=>row.version===(row.role==='global'?20:25));
  if(!required){const ticket=Object.freeze({required:false,status:facts.length?'current':'fresh',backup:null});tickets.set(ticket,{done:true});return ticket;}
  await verifyRuntime(packageRoot);
  let backup;try{backup=await backupDirectory(directory,runCommand,facts);}catch{throw error('MIGRATION_FAILED');}
  const receipt={version:1,source:directory,status:'pending',targetSdk:PIN,backupId:backup.id,manifestSha256:backup.manifestSha256,
    before:facts.map(({role,agentId,version})=>({role,...(agentId?{agentId}:{}),version}))};
  await atomicJson(marker,receipt);
  const ticket=Object.freeze({required:true,status:'pending',backup:Object.freeze({id:backup.id,directory:backup.directory,manifestSha256:backup.manifestSha256}),
    before:Object.freeze(facts.map(row=>Object.freeze({...row})))});
  tickets.set(ticket,{directory,packageRoot,nodePath,runCommand,verifyRuntime,onDiagnostic,backup,receipt,done:false});
  onDiagnostic?.('[chainchat] native upgrade: verified private pre-upgrade backup; offline schema repair pending\n');
  return ticket;
  } catch(e){throw error(e.code==='MIGRATION_FAILED'?'MIGRATION_FAILED':'MIGRATION_REQUIRED');}
}
function lintPayload(result) {
  if(![0,1].includes(result?.exitCode)||typeof result.stdout!=='string'||Buffer.byteLength(result.stdout)>1024*1024)throw error();
  try{return JSON.parse(result.stdout);}catch{throw error();}
}
export async function completeNativeUpgrade(ticket,{environment,reprojectManagedConfiguration}={}) {
  const context=tickets.get(ticket);if(!context)throw error();if(context.done)return {status:ticket.required?'migrated':ticket.status,migrationRan:ticket.required};
  if(context.failed)throw error('MIGRATION_FAILED');
  if(!plain(environment)||typeof reprojectManagedConfiguration!=='function')throw error('MIGRATION_FAILED');
  const {directory,packageRoot,nodePath,runCommand,verifyRuntime,backup,receipt,onDiagnostic}=context;
  const env={...environment,OPENCLAW_STATE_DIR:path.join(directory,'native-state'),OPENCLAW_CONFIG_PATH:path.join(directory,'gateway.json'),
    OPENCLAW_SERVICE_REPAIR_POLICY:'external',OPENCLAW_NO_RESPAWN:'1'};
  const args=[path.join(packageRoot,'openclaw.mjs'),'doctor'],lintArgs=[...args,'--lint','--only','core/doctor/agent-database-admission','--only','core/doctor/state-schema','--json'];
  try {
    await validateOwnedStateDirectory(directory);await verifyRuntime(packageRoot);
    if(sha(await privateFile(path.join(backup.directory,'manifest.json'),8*1024*1024))!==backup.manifestSha256)throw error('MIGRATION_FAILED');
    for(const row of backup.manifest.entries)if(row.type==='file') {
      if(await readHash(path.join(backup.directory,'files',row.path))!==row.sha256)throw error('MIGRATION_FAILED');
      if(row.path!=='gateway.json'&&await readHash(path.join(directory,row.path))!==row.sha256)throw error('MIGRATION_FAILED');
    }
    const facts=await inspectFacts(directory,runCommand);
    const before=lintPayload(await runCommand(nodePath,lintArgs,{cwd:directory,env,timeout:120000}));
    if(!classifyNativeUpgrade(before,facts))throw error();
    onDiagnostic?.('[chainchat] native upgrade: running supported offline schema repair\n');
    let result;
    try{result=await runCommand(nodePath,[...args,'--fix','--non-interactive'],{cwd:directory,env,timeout:300000});}
    finally{await reprojectManagedConfiguration();}
    if(result.exitCode!==0)throw error('MIGRATION_FAILED');
    const after=lintPayload(await runCommand(nodePath,lintArgs,{cwd:directory,env,timeout:120000}));
    const current=await inspectFacts(directory,runCommand);
    const identity=rows=>JSON.stringify(rows.map(row=>row.role==='global'?'global':'agent:'+row.agentId).sort());
    if(!after.ok||classifyNativeUpgrade(after,current)||identity(current)!==identity(facts)||current.some(row=>row.version!==(row.role==='global'?22:27)))throw error('MIGRATION_FAILED');
    await atomicJson(receiptPath(directory),{...receipt,status:'complete',completedAt:new Date().toISOString()});context.done=true;
    onDiagnostic?.('[chainchat] native upgrade: supported schemas verified; normal enforced startup continues\n');
    return {status:'migrated',migrationRan:true,backupId:backup.id};
  } catch(e) {
    context.failed=true;
    await atomicJson(receiptPath(directory),{...receipt,status:'failed'}).catch(()=>{});
    if(e.code==='MIGRATION_REQUIRED')throw e;throw error('MIGRATION_FAILED');
  }
}
