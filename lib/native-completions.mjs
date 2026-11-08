import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeJSON} from './state.mjs';
const invalid=()=>Object.assign(new Error('Inspect the private native completion references.'),{code:'NATIVE_COMPLETION_INVALID',status:409});
const hash=value=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/u.test(value);
function checked(row){if(!row||Object.keys(row).sort().join(',')!=='agentId,createdAt,genesisHash,ringHash,ringIndex'||
  typeof row.agentId!=='string'||/[\0\r\n\u2028\u2029]/u.test(row.agentId)||!/^[A-Za-z0-9-]{1,100}$/u.test(row.agentId)||!hash(row.genesisHash)||!hash(row.ringHash)||
  !Number.isSafeInteger(row.ringIndex)||row.ringIndex<1||typeof row.createdAt!=='string'||row.createdAt.length>40||!Number.isFinite(Date.parse(row.createdAt))||new Date(row.createdAt).toISOString()!==row.createdAt)throw invalid();return row;}
/** Derived references only. Answer text and file bytes remain in canonical rings. */
export class NativeCompletions {
  constructor(directory){this.file=path.join(directory,'native-completion-references.json');this.rows=[];this.queue=Promise.resolve();}
  async load(){try{const stat=await fs.lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024*1024||process.platform!=='win32'&&(stat.mode&0o077))throw invalid();
    const value=JSON.parse(await fs.readFile(this.file,'utf8'));if(value.version!==1||!Array.isArray(value.rows)||value.rows.length>2048)throw invalid();
    this.rows=value.rows.map(checked);if(new Set(this.rows.map(row=>row.agentId+':'+row.genesisHash+':'+row.ringHash)).size!==this.rows.length)throw invalid();
  }catch(error){if(error.code!=='ENOENT')throw error;}return this;}
  list(agentId,genesisHash){const rows=this.rows.filter(row=>row.agentId===agentId&&row.genesisHash===genesisHash).slice(-100);
    return {revision:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),rows:structuredClone(rows)};}
  record(row){const record=checked({...row});const operation=this.queue.then(async()=>{
    if(this.rows.some(old=>old.agentId===record.agentId&&old.genesisHash===record.genesisHash&&old.ringHash===record.ringHash))return;
    const next=[...this.rows,record].slice(-2048);
    while(Buffer.byteLength(JSON.stringify({version:1,rows:next},null,2),'utf8')>1024*1024-1024)next.shift();
    await writeJSON(this.file,{version:1,rows:next});this.rows=next;
  });this.queue=operation.catch(()=>{});return operation;}
}
