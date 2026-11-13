/** Owner-private credentials. Configuration stores references; model BYOK remains memory-only. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {isRetiredProviderCredential} from './providers.mjs';
import {nativeSensitiveFields,parseConfigPath,getConfigPath,setConfigPath,configPointer,nativeRedactionValue,nativeCredentialKey} from './native-config-schema.mjs';
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const slug=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)&&!['constructor','prototype','__proto__'].includes(value);
const secret=value=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=16384&&!value.includes('\0')&&!nativeRedactionValue(value)&&!isRetiredProviderCredential(value);
const failure=()=>Object.assign(new Error('Native secret bindings require a valid dedicated credential and configured native target.'),{code:'OPENCLAW_NATIVE_SECRET_INVALID',status:400});
const alias=name=>'CHAINCHAT_NATIVE_'+createHash('sha256').update(name).digest('hex').toUpperCase();
const legacyTarget=value=>typeof value==='string'&&/^tts\.(?:providers\.[A-Za-z0-9_-]+|personas\.[A-Za-z0-9_-]+\.providers\.[A-Za-z0-9_-]+)\.apiKey$/u.test(value)&&value.length<=256&&value.split('.').every(part=>!['__proto__','constructor','prototype'].includes(part));
const descriptor=row=>({target:row.target,path:parseConfigPath(row.target),label:row.label||row.target,projection:row.projection||'secret-ref'});
export function nativeSecretTargets(config,schema) {
  const targets=new Map(),providers=new Set();
  for(const [provider,value]of Object.entries(config?.tts?.providers||{}))if(slug(provider)&&plain(value))providers.add(provider);
  for(const [persona,value]of Object.entries(config?.tts?.personas||{}))if(slug(persona)&&plain(value))
    for(const [provider,binding]of Object.entries(value.providers||{}))if(slug(provider)&&plain(binding)){
      providers.add(provider);const target=`tts.personas.${persona}.providers.${provider}.apiKey`;
      targets.set(target,descriptor({target,label:`TTS ${persona} / ${provider}`}));
    }
  for(const provider of providers){const target=`tts.providers.${provider}.apiKey`;targets.set(target,descriptor({target,label:`TTS ${provider}`}));}
  for(const row of nativeSensitiveFields(config,schema)){
    // Preserve stable legacy target spelling for existing TTS bindings.
    const legacy=row.path.join('.');if(targets.has(legacy))continue;targets.set(row.target,row);
  }
  if(targets.size>2048)throw failure();return[...targets.values()].sort((a,b)=>a.target.localeCompare(b.target));
}
function arrayFingerprint(item){const stable=value=>Array.isArray(value)?value.map(stable):plain(value)?Object.fromEntries(Object.keys(value).sort().filter(key=>!nativeCredentialKey(key)).map(key=>[key,stable(value[key])])):value;
  return createHash('sha256').update(JSON.stringify(stable(item))).digest('hex');}
function anchorsFor(config,parts){const anchors=[];let current=config;
  for(let index=0;index<parts.length;index++){const key=parts[index];if(Array.isArray(current)){
    const item=current[key];if(!plain(item))throw failure();const identity=['id','accountId','name'].find(field=>typeof item[field]==='string'&&item[field]&&current.filter(other=>other?.[field]===item[field]).length===1);
    if(!identity&&current.filter(other=>plain(other)&&arrayFingerprint(other)===arrayFingerprint(item)).length!==1)throw failure();
    // An indexed credential must never move silently to a different account.
    anchors.push({path:parts.slice(0,index+1),identity:identity||null,value:identity?item[identity]:arrayFingerprint(item)});
  }current=current?.[key];}return anchors;
}
function validRow(row){try{return plain(row)&&slug(row.name)&&secret(row.value)&&typeof row.remember==='boolean'&&plain(row.descriptor)&&
  row.target===row.descriptor.target&&['env-string','secret-ref'].includes(row.descriptor.projection)&&configPointer(parseConfigPath(row.target))===configPointer(row.descriptor.path)&&
  (legacyTarget(row.target)||row.target.startsWith('/')&&!['gateway','env','auth','secrets','models','update','discovery','meta'].includes(row.descriptor.path[0]))&&Array.isArray(row.anchors)&&row.anchors.length<=16;
}catch{return false;}}
function available(row,config,schema){
  if(schema)return nativeSecretTargets(config,schema).some(target=>configPointer(target.path)===configPointer(row.descriptor.path));
  if(legacyTarget(row.target))return nativeSecretTargets(config).some(target=>target.target===row.target);
  const parent=row.descriptor.path.length===1?config:getConfigPath(config,row.descriptor.path.slice(0,-1));return plain(parent)||Array.isArray(parent);
}
function anchored(row,config){return row.anchors.every(anchor=>{const item=getConfigPath(config,anchor.path),parent=getConfigPath(config,anchor.path.slice(0,-1));
  const matches=other=>plain(other)&&(anchor.identity?other[anchor.identity]===anchor.value:arrayFingerprint(other)===anchor.value);
  return Array.isArray(parent)&&matches(item)&&parent.filter(matches).length===1;});}
export class NativeSecrets {
  constructor(directory){this.directory=path.resolve(directory);this.rows=[];this.loaded=false;this.staged=null;}
  async privateDirectory(){await fs.mkdir(this.directory,{recursive:true,mode:0o700});const stat=await fs.lstat(this.directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(this.directory)!==this.directory||process.platform!=='win32'&&(stat.mode&0o077||typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw failure();}
  async privateRead(name){const file=path.join(this.directory,name),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>2*1024*1024||process.platform!=='win32'&&(stat.mode&0o077||typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw failure();return fs.readFile(file);}
  async encryptionKey(create=false){try{const value=await this.privateRead('native-secrets.key');if(value.length!==32)throw failure();return value;}
    catch(error){if(error.code!=='ENOENT')throw error;if(!create)throw failure();const value=randomBytes(32);try{await fs.writeFile(path.join(this.directory,'native-secrets.key'),value,{flag:'wx',mode:0o600});return value;}catch(error){if(error.code==='EEXIST')return this.encryptionKey();throw error;}}}
  async load(){if(this.loaded)return;await this.privateDirectory();
    try{const body=JSON.parse((await this.privateRead('native-secrets.json')).toString('utf8'));let rows;
      if(body?.version===1&&Array.isArray(body.bindings)&&Object.keys(body).length===2){rows=body.bindings.map(row=>{
        if(!plain(row)||Object.keys(row).length!==3||!legacyTarget(row.target))throw failure();return{...row,remember:true,descriptor:descriptor(row),anchors:[]};});}
      else if(body?.version===2&&body.algorithm==='aes-256-gcm'&&Object.keys(body).length===5){const decipher=createDecipheriv('aes-256-gcm',await this.encryptionKey(),Buffer.from(body.iv,'base64'));
        decipher.setAAD(Buffer.from('ChainChat native credentials v2'));decipher.setAuthTag(Buffer.from(body.tag,'base64'));rows=JSON.parse(Buffer.concat([decipher.update(Buffer.from(body.ciphertext,'base64')),decipher.final()]).toString('utf8'));}
      else throw failure();
      if(!Array.isArray(rows)||rows.length>256||rows.some(row=>!validRow(row))||new Set(rows.map(row=>row.name)).size!==rows.length||new Set(rows.map(row=>configPointer(row.descriptor.path))).size!==rows.length)throw failure();
      if(body.version===1)await this.save(rows);this.rows=rows;
    }catch(error){if(error.code!=='ENOENT')throw failure();}this.loaded=true;}
  async save(rows){await this.privateDirectory();const remembered=rows.filter(row=>row.remember);const key=await this.encryptionKey(true),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from('ChainChat native credentials v2'));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(remembered),'utf8'),cipher.final()]);
    const body=JSON.stringify({version:2,algorithm:'aes-256-gcm',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')})+'\n';if(Buffer.byteLength(body)>2*1024*1024)throw failure();
    const file=path.join(this.directory,'native-secrets.json'),temp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,body,{flag:'wx',mode:0o600});try{await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}
  active(){return this.staged?.rows||this.rows;}
  async list(config,schema){await this.load();const targets=nativeSecretTargets(config,schema);return{bindings:this.active().map(row=>({name:row.name,target:row.target,configured:true,remember:row.remember,available:available(row,config,schema)&&anchored(row,config)})),targets,
    notice:'Remembered credentials are encrypted in an owner-private local vault; its key is protected by local filesystem permissions, not an operating-system keychain. Session-only credentials disappear when ChainChat exits. Native settings contain references, never credential values.'};}
  async stage(changes,config,schema){await this.load();if(this.staged||!Array.isArray(changes)||changes.length>256)throw failure();let rows=structuredClone(this.rows);const targets=nativeSecretTargets(config,schema);
    for(const change of changes){if(!plain(change)||!slug(change.name))throw failure();
      if(change.remove===true){if(!rows.some(row=>row.name===change.name))throw failure();rows=rows.filter(row=>row.name!==change.name);continue;}
      const target=targets.find(row=>row.target===change.target);if(!target||!secret(change.value)||change.remember!==undefined&&typeof change.remember!=='boolean'||rows.some(row=>row.name!==change.name&&configPointer(row.descriptor.path)===configPointer(target.path)))throw failure();
      rows=rows.filter(row=>row.name!==change.name);rows.push({name:change.name,target:change.target,value:change.value,remember:change.remember!==false,descriptor:structuredClone(target),anchors:anchorsFor(config,target.path)});
    }
    if(rows.length>256)throw failure();const staged={rows};this.staged=staged;let finished=false;
    return{commit:async()=>{if(finished||this.staged!==staged)throw failure();await this.save(rows);this.rows=rows;this.staged=null;finished=true;},abort:async()=>{if(!finished&&this.staged===staged){this.staged=null;finished=true;}}};}
  async set(change,config,schema){const transaction=await this.stage([change],config,schema);try{await transaction.commit();}catch(error){await transaction.abort();throw error;}return this.list(config,schema);}
  async remove(name,config,schema){const transaction=await this.stage([{name,remove:true}],config,schema);try{await transaction.commit();}catch(error){await transaction.abort();throw error;}return this.list(config,schema);}
  values(){return [...new Set([...this.rows,...(this.staged?.rows||[])].map(row=>row.value))];}
  async project(config,schema){await this.load();const copy=structuredClone(config),environment={};
    for(const row of this.active()){if(!available(row,config,schema)||!anchored(row,config))continue;const id=alias(row.name);environment[id]=row.value;
      setConfigPath(copy,row.descriptor.path,row.descriptor.projection==='secret-ref'?{source:'env',provider:'chainchat',id}:'${'+id+'}');}
    if(Object.keys(environment).length){copy.secrets??={};copy.secrets.providers??={};copy.secrets.providers.chainchat={source:'env',allowlist:Object.keys(environment)};}
    return{config:copy,environment};}
}
