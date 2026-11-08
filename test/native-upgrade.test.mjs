import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {prepareNativeUpgrade,completeNativeUpgrade,classifyNativeUpgrade,validateOwnedStateDirectory} from '../openclaw/native-upgrade.mjs';

const execute=promisify(execFile),hash=data=>createHash('sha256').update(data).digest('hex');
const before={schemaVersion:1,ok:false,checksRun:2,checksSkipped:67,findings:[{checkId:'core/doctor/state-schema',severity:'warning',requirement:'state-schema-migration-pending'}]};
const after={schemaVersion:1,ok:true,checksRun:2,checksSkipped:67,findings:[]};
function createDatabase(file,role,version,owner=null){const db=new DatabaseSync(file);try{
  db.exec('CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY,role TEXT,schema_version INTEGER,agent_id TEXT); CREATE TABLE retained(value TEXT);');
  db.prepare('INSERT INTO schema_meta VALUES(?,?,?,?)').run('primary',role,version,owner);
  db.prepare('INSERT INTO retained VALUES(?)').run('Synthetic retained history and authentication sentinel.');db.exec(`PRAGMA user_version=${version}`);
}finally{db.close();}}
async function fixture(t,{current=false,empty=false}={}){
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'ct-upgrade-')),directory=path.join(parent,'owned');
  t.after(async()=>{assert.equal(path.dirname(parent),path.resolve(os.tmpdir()));assert.match(path.basename(parent),/^ct-upgrade-/);await fs.rm(parent,{recursive:true,force:true});});
  await fs.mkdir(directory,{mode:0o700});const shared=path.join(directory,'native-state/state'),agent=path.join(directory,'native-state/agents/main/agent');
  await fs.mkdir(shared,{recursive:true,mode:0o700});await fs.mkdir(agent,{recursive:true,mode:0o700});
  const sharedFile=path.join(shared,'openclaw.sqlite'),agentFile=path.join(agent,'openclaw-agent.sqlite');
  if(!empty){createDatabase(sharedFile,'global',current?22:20);createDatabase(agentFile,'agent',current?27:25,'main');}
  await fs.mkdir(path.join(directory,'workspace'),{mode:0o700});await fs.writeFile(path.join(directory,'workspace','AGENTS.md'),'Original managed workspace notes.');
  const config=path.join(directory,'gateway.json');await fs.writeFile(config,'{"old":"protected preimage"}',{mode:0o600});
  await fs.writeFile(path.join(directory,'native-auth-sentinel.json'),'Synthetic authentication preimage.',{mode:0o600});
  const calls=[];let phase=0,doctorError=false,unknownFinding=false;
  const runCommand=async(file,args,options)=>{
    calls.push({file,args:[...args],options});
    if(!args[0]?.endsWith('openclaw.mjs')){const result=await execute(file,args,{...options,windowsHide:true,shell:false,encoding:'utf8'});return{exitCode:0,stdout:result.stdout};}
    assert.equal(options.env.OPENCLAW_SERVICE_REPAIR_POLICY,'external');
    assert.equal(options.env.OPENCLAW_STATE_DIR,path.join(directory,'native-state'));assert.equal(options.env.OPENCLAW_CONFIG_PATH,config);
    assert.equal(args.includes('--force'),false);assert.equal(args.includes('--allow-exec'),false);assert.equal(args.includes('--generate-gateway-token'),false);
    if(args.includes('--lint'))return{exitCode:phase?0:1,stdout:JSON.stringify(phase?after:unknownFinding?{...before,findings:[...before.findings,{checkId:'core/doctor/agent-database-admission',severity:'warning',requirement:'agent-database-inspection-failed',message:'Unexpected integrity failure'}]}:before)};
    assert.deepEqual(args.slice(1),['doctor','--fix','--non-interactive']);
    if(doctorError)throw new Error('private secret token must never enter a public failure');
    for(const [filename,version]of [[sharedFile,22],[agentFile,27]]){const db=new DatabaseSync(filename);try{db.exec(`PRAGMA user_version=${version}`);db.prepare('UPDATE schema_meta SET schema_version=?').run(version);}finally{db.close();}}
    phase=1;await fs.writeFile(config,'{"doctor":"changed managed configuration"}');return{exitCode:0,stdout:'Do not forward private Doctor output.'};
  };
  const options={directory,packageRoot:path.join(parent,'pinned-package'),nodePath:process.execPath,runCommand,verifyRuntime:async()=>{}};
  let reprojected=0;
  const completeOptions={environment:{SYNTHETIC:'only'},reprojectManagedConfiguration:async()=>{reprojected++;await fs.writeFile(config,'{"managed":"current protected configuration"}',{mode:0o600});}};
  return{parent,directory,options,completeOptions,sharedFile,agentFile,config,calls,get reprojected(){return reprojected;},failDoctor:()=>{doctorError=true;},unknownFinding:()=>{unknownFinding=true;}};
}
test('fresh and current owned databases skip every Doctor call and create no upgrade backup',async t=>{
  for(const args of [{empty:true},{current:true}]){const f=await fixture(t,args),ticket=await prepareNativeUpgrade(f.options);assert.equal(ticket.required,false);
    assert.equal((await completeNativeUpgrade(ticket)).migrationRan,false);assert.equal(f.calls.some(row=>row.args.includes('doctor')),false);
    assert.equal((await fs.readdir(f.parent)).some(name=>name.includes('native-backup')),false);}
});
test('ordinary OS metadata files in the agent directory do not turn a current native store into a migration hold',async t=>{
  const f=await fixture(t,{current:true}),agents=path.join(f.directory,'native-state','agents');
  await fs.writeFile(path.join(agents,'.DS_Store'),'Synthetic Finder metadata.');await fs.writeFile(path.join(agents,'desktop.ini'),'Synthetic Explorer metadata.');
  assert.equal((await prepareNativeUpgrade(f.options)).required,false);assert.equal(f.calls.some(row=>row.args.includes('doctor')),false);
  await fs.mkdir(path.join(agents,'.invalid-agent-directory'));
  await assert.rejects(prepareNativeUpgrade(f.options),{code:'MIGRATION_REQUIRED'},'Invalid agent directories remain refused.');
});
test('known legacy native state is backed up before overlay writes, then repaired under fixed offline policy',async t=>{
  const f=await fixture(t),original=await fs.readFile(f.config),auth=await fs.readFile(path.join(f.directory,'native-auth-sentinel.json'));
  const ticket=await prepareNativeUpgrade(f.options);assert.equal(ticket.required,true);assert.ok(Object.isFrozen(ticket));
  assert.deepEqual(await fs.readFile(path.join(ticket.backup.directory,'files','gateway.json')),original);
  const manifestBytes=await fs.readFile(path.join(ticket.backup.directory,'manifest.json'));assert.equal(hash(manifestBytes),ticket.backup.manifestSha256);
  const manifest=JSON.parse(manifestBytes);for(const row of manifest.entries.filter(row=>row.type==='file'))assert.equal(hash(await fs.readFile(path.join(ticket.backup.directory,'files',row.path))),row.sha256);
  await fs.writeFile(f.config,'{"managed":"pre-Doctor overlay"}');
  const result=await completeNativeUpgrade(ticket,f.completeOptions);assert.equal(result.status,'migrated');assert.equal(f.reprojected,1);
  assert.deepEqual(await fs.readFile(path.join(f.directory,'native-auth-sentinel.json')),auth);
  assert.equal((await fs.readFile(f.config,'utf8')),'{"managed":"current protected configuration"}');
  for(const [file,target]of [[f.sharedFile,22],[f.agentFile,27]]){const db=new DatabaseSync(file,{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,target);assert.match(db.prepare('SELECT value FROM retained').get().value,/retained history/);}finally{db.close();}}
  const restarted=await prepareNativeUpgrade(f.options);assert.equal(restarted.required,false);
  assert.equal(f.calls.filter(row=>row.args.includes('--fix')).length,1);
});
test('unrecognized/newer schema and mismatched database owner cannot trigger backup or repair',async t=>{
  for(const kind of ['newer','metadata','owner']){const f=await fixture(t),db=new DatabaseSync(f.agentFile);try{
    if(kind==='newer'){db.exec('PRAGMA user_version=28');db.prepare('UPDATE schema_meta SET schema_version=28').run();}
    if(kind==='metadata')db.prepare('UPDATE schema_meta SET schema_version=27').run();
    if(kind==='owner')db.prepare('UPDATE schema_meta SET agent_id=?').run('other');
  }finally{db.close();}
    await assert.rejects(prepareNativeUpgrade(f.options),{code:'MIGRATION_REQUIRED'});assert.equal(f.calls.some(row=>row.args.includes('doctor')),false);}
});
test('generic lint faults are held even beside a valid shared migration finding',async t=>{
  const f=await fixture(t);f.unknownFinding();const ticket=await prepareNativeUpgrade(f.options);
  await assert.rejects(completeNativeUpgrade(ticket,f.completeOptions),{code:'MIGRATION_REQUIRED'});
  assert.equal(f.calls.some(row=>row.args.includes('--fix')),false);
  await assert.rejects(prepareNativeUpgrade(f.options),{code:'MIGRATION_FAILED'});
});
test('backup tampering, source mutation and interrupted receipt prevent Doctor',async t=>{
  for(const kind of ['backup','source','interrupted']){const f=await fixture(t),ticket=await prepareNativeUpgrade(f.options);
    if(kind==='interrupted')await assert.rejects(prepareNativeUpgrade(f.options),{code:'MIGRATION_FAILED'});
    else {const file=kind==='backup'?path.join(ticket.backup.directory,'files','native-auth-sentinel.json'):path.join(f.directory,'native-auth-sentinel.json');await fs.writeFile(file,'Changed bytes.');
      await assert.rejects(completeNativeUpgrade(ticket,f.completeOptions),{code:'MIGRATION_FAILED'});}
    assert.equal(f.calls.some(row=>row.args.includes('--fix')),false);}
});
test('Doctor exceptions stay redacted, restore managed config and retain a failed receipt',async t=>{
  const f=await fixture(t),ticket=await prepareNativeUpgrade(f.options);f.failDoctor();
  await assert.rejects(completeNativeUpgrade(ticket,f.completeOptions),e=>e.code==='MIGRATION_FAILED'&&!e.message.includes('secret token'));
  assert.equal(f.reprojected,1);await fs.access(path.join(ticket.backup.directory,'manifest.json'));
  await assert.rejects(completeNativeUpgrade(ticket,f.completeOptions),{code:'MIGRATION_FAILED'});
  assert.equal(f.calls.filter(row=>row.args.includes('--fix')).length,1);
});
test('hardlinks and unknown directory junctions are refused; derived skill links are metadata only',async t=>{
  for(const kind of ['hardlink','unknown','skill','plugin-skill']){const f=await fixture(t),outside=path.join(f.parent,'external');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'private.txt'),'Must not be copied.');
    if(kind==='hardlink')await fs.link(path.join(outside,'private.txt'),path.join(f.directory,'linked-secret'));
    else {const link=kind==='skill'?path.join(f.directory,'workspace','skills','derived'):kind==='plugin-skill'?path.join(f.directory,'native-state','plugin-skills','browser-automation'):path.join(f.directory,'unknown');await fs.mkdir(path.dirname(link),{recursive:true});await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');}
    if(kind==='skill'||kind==='plugin-skill'){const relative=kind==='skill'?path.join('workspace','skills','derived'):path.join('native-state','plugin-skills','browser-automation');
      const ticket=await prepareNativeUpgrade(f.options),manifest=JSON.parse(await fs.readFile(path.join(ticket.backup.directory,'manifest.json')));
      assert.equal(manifest.entries.some(row=>row.type==='link'&&row.path===relative),true);
      await assert.rejects(fs.access(path.join(ticket.backup.directory,'files',relative,'private.txt')));}
    else await assert.rejects(prepareNativeUpgrade(f.options),{code:'MIGRATION_FAILED'});
    assert.equal(f.calls.some(row=>row.args.includes('doctor')),false);}
});
test('ownership validation refuses a linked root and fabricated tickets grant no repair',async t=>{
  const f=await fixture(t),link=path.join(f.parent,'linked-root');await fs.symlink(f.directory,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(validateOwnedStateDirectory(link),{code:'MIGRATION_REQUIRED'});
  await assert.rejects(completeNativeUpgrade({...await prepareNativeUpgrade(f.options)},f.completeOptions),{code:'MIGRATION_REQUIRED'});
});
test('Windows backup root has an explicit protected owner/system/admin DACL', {skip:process.platform!=='win32'?'Windows ACL acceptance runs on Windows.':false},async t=>{
  const f=await fixture(t),ticket=await prepareNativeUpgrade(f.options);
  const aclFile=path.join(f.parent,'actual-backup-acl.txt');
  await execute(path.join(process.env.SystemRoot,'System32','icacls.exe'),[ticket.backup.directory,'/save',aclFile,'/q'],{windowsHide:true,shell:false,encoding:'utf8',timeout:10000});
  const sddl=(await fs.readFile(aclFile)).toString('utf16le');
  assert.match(sddl,/D:P/,'The new backup root disables inherited access.');
  const entries=[...sddl.matchAll(/\(A;OICI;FA;;;([^)]*)\)/g)].map(match=>match[1]);
  assert.equal(entries.length,3);assert.equal((sddl.match(/\(/g)||[]).length,3);
  assert.ok(entries.includes('SY'));assert.ok(entries.includes('BA'));assert.equal(entries.filter(sid=>sid.startsWith('S-1-')).length,1);
});
