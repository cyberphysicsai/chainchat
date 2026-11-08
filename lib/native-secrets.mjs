/** Dedicated owner credential bindings. Values never enter native settings JSON. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isRetiredProviderCredential} from './providers.mjs';
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const slug=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)&&!['constructor','prototype','__proto__'].includes(value);
const secret=value=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=16384&&!value.includes('\0')&&!isRetiredProviderCredential(value);
const failure=()=>Object.assign(new Error('Native secret bindings require a valid dedicated credential and configured native target.'),{code:'OPENCLAW_NATIVE_SECRET_INVALID',status:400});
const alias=name=>'CHAINCHAT_NATIVE_'+createHash('sha256').update(name).digest('hex').toUpperCase();
export function nativeSecretTargets(config) {
  const targets=new Map(),providers=new Set();
  for(const [provider,value]of Object.entries(config?.tts?.providers||{}))if(slug(provider)&&plain(value))providers.add(provider);
  for(const [persona,value]of Object.entries(config?.tts?.personas||{}))if(slug(persona)&&plain(value))
    for(const [provider,binding]of Object.entries(value.providers||{}))if(slug(provider)&&plain(binding)){
      providers.add(provider);const target=`tts.personas.${persona}.providers.${provider}.apiKey`;
      targets.set(target,{target,label:`TTS ${persona} / ${provider}`});
    }
  for(const provider of providers){const target=`tts.providers.${provider}.apiKey`;targets.set(target,{target,label:`TTS ${provider}`});}
  if(targets.size>256)throw failure();
  return [...targets.values()].sort((a,b)=>a.target.localeCompare(b.target));
}
const validTarget=value=>typeof value==='string'&&/^tts\.(?:providers\.[A-Za-z0-9_-]+|personas\.[A-Za-z0-9_-]+\.providers\.[A-Za-z0-9_-]+)\.apiKey$/u.test(value)&&value.length<=256&&value.split('.').every(part=>!['__proto__','constructor','prototype'].includes(part));
export class NativeSecrets {
  constructor(directory){this.directory=path.resolve(directory);this.rows=[];this.loaded=false;}
  async privateDirectory(){await fs.mkdir(this.directory,{recursive:true,mode:0o700});const stat=await fs.lstat(this.directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(this.directory)!==this.directory||process.platform!=='win32'&&(stat.mode&0o077||typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw failure();}
  async load(){if(this.loaded)return;await this.privateDirectory();
    try{const file=path.join(this.directory,'native-secrets.json'),stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024*1024||process.platform!=='win32'&&(stat.mode&0o077||typeof process.getuid==='function'&&stat.uid!==process.getuid()))throw failure();
      const body=JSON.parse(await fs.readFile(file,'utf8'));
      if(!plain(body)||Object.keys(body).length!==2||body.version!==1||!Array.isArray(body.bindings)||body.bindings.length>64)throw failure();
      const names=new Set(),targets=new Set();for(const row of body.bindings){
        if(!plain(row)||Object.keys(row).length!==3||!slug(row.name)||!validTarget(row.target)||!secret(row.value)||names.has(row.name)||targets.has(row.target))throw failure();
        names.add(row.name);targets.add(row.target);
      }this.rows=body.bindings;
    }catch(error){if(error.code!=='ENOENT')throw failure();}this.loaded=true;}
  async save(rows){await this.privateDirectory();const body=JSON.stringify({version:1,bindings:rows})+'\n';if(Buffer.byteLength(body)>1024*1024)throw failure();
    const file=path.join(this.directory,'native-secrets.json'),temp=file+'.'+randomUUID()+'.tmp';
    await fs.writeFile(temp,body,{flag:'wx',mode:0o600});try{await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}this.rows=rows;
  }
  async list(config){await this.load();const targets=nativeSecretTargets(config),available=new Set(targets.map(row=>row.target));
    return{bindings:this.rows.map(({name,target})=>({name,target,configured:true,available:available.has(target)})),targets,
      notice:'Dedicated credentials are stored locally in a private owner-only file and passed only to the managed native process. Native settings contain allowlisted secret references.'};}
  async set({name,target,value},config){await this.load();if(!slug(name)||!validTarget(target)||!secret(value)||!nativeSecretTargets(config).some(row=>row.target===target))throw failure();
    if(this.rows.some(row=>row.name!==name&&row.target===target))throw failure();
    const rows=this.rows.filter(row=>row.name!==name);if(rows.length>=64)throw failure();rows.push({name,target,value});await this.save(rows);return this.list(config);}
  async remove(name,config){await this.load();if(!slug(name)||!this.rows.some(row=>row.name===name))throw failure();await this.save(this.rows.filter(row=>row.name!==name));return this.list(config);}
  values(){return this.rows.map(row=>row.value);}
  async project(config){await this.load();const copy=structuredClone(config),available=new Set(nativeSecretTargets(config).map(row=>row.target)),environment={};
    for(const row of this.rows){if(!available.has(row.target))continue;const id=alias(row.name);environment[id]=row.value;
      let current=copy;const parts=row.target.split('.');for(const key of parts.slice(0,-1))current=current[key]??={};
      current[parts.at(-1)]={source:'env',provider:'chainchat',id};}
    if(Object.keys(environment).length){copy.secrets??={};copy.secrets.providers??={};copy.secrets.providers.chainchat={source:'env',allowlist:Object.keys(environment)};}
    return{config:copy,environment};
  }
}
