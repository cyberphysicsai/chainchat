/** Secret-free native catalogue projection. Native credentials stay in OpenClaw's store. */
import fs from 'node:fs/promises';
import path from 'node:path';
const fail = () => Object.assign(new Error('Choose an available model from the native OpenClaw catalogue.'), {code:'OPENCLAW_NATIVE_MODEL_INVALID',status:400});
export const nativeModelRef = value => typeof value === 'string' && !/[\0\r\n\u2028\u2029]/u.test(value) && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value) && value.includes('/') && !value.startsWith('chainchat-');
export function nativeModelCatalogue(value, current = '') {
  if (!value || !Array.isArray(value.models) || value.models.length > 20000 || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024) throw fail();
  const rows = new Map();
  for (const item of value.models) {
    if (!item || typeof item.provider !== 'string' || typeof item.id !== 'string') continue;
    const id = item.id.startsWith(item.provider + '/') ? item.id : item.provider + '/' + item.id;
    if (!nativeModelRef(id) || rows.has(id)) continue;
    const available = item.available === true && item.manualSelectionAllowed !== false;
    const row = {id, name: typeof item.name === 'string' && item.name.length <= 512 ? item.name : id, available,
      reason: available ? '' : ['missing-auth','auth-failed','cooldown'].includes(item.unavailableReason) ? item.unavailableReason : 'Native authentication or runtime readiness has not been confirmed.'};
    if (Number.isSafeInteger(item.contextWindow) && item.contextWindow >= 4096 && item.contextWindow <= 2097152) row.contextWindow = item.contextWindow;
    if (Number.isSafeInteger(item.maxTokens) && item.maxTokens >= 128 && item.maxTokens <= 262144) row.maxOutputTokens = item.maxTokens;
    if (typeof item.reasoning === 'boolean') row.reasoningCapable = item.reasoning;
    if (Array.isArray(item.input)) row.input = item.input.filter(value => ['text','image','audio','video','document'].includes(value));
    rows.set(id, row);
  }
  return {models:[...rows.values()], current:nativeModelRef(current) ? current : '', configured: Boolean(nativeModelRef(current) && rows.get(current)?.available),
    notice:'Native OpenClaw providers use credentials stored privately on this machine. Review and memory planning use the owner-configured main default; advanced session or child model overrides may use another generation model. Authentication readiness is not a live inference test.'};
}
export function requireNativeModel(catalogue, id) {
  if (!nativeModelRef(id)) throw fail();
  const selected = catalogue.models.find(row => row.id === id && row.available);
  if (!selected) throw fail();
  return selected;
}
export function validateNativeProviderEntry(provider, configuration) {
  if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(provider) || provider.startsWith('chainchat-') ||
      !configuration || typeof configuration !== 'object' || Array.isArray(configuration) ||
      Buffer.byteLength(JSON.stringify(configuration)) > 256 * 1024) throw fail();
  // The owner can configure any upstream-supported API/model schema, but raw
  // credential entries and environment/exec expansions use the separate native
  // credential flow. Full schema validation remains OpenClaw's responsibility.
  const visit = value => {
    if (typeof value === 'string' && (/\0|\$\{/u.test(value))) throw fail();
    if(typeof value==='string'&&/^https?:/iu.test(value)){
      let url;try{url=new URL(value);}catch{throw fail();}
      if(url.username||url.password||[...url.searchParams.keys()].some(key=>/^(?:api[-_]?key|(?:access[-_]?|refresh[-_]?)?token|password|secret|authorization|credential)$/iu.test(key)))throw fail();
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (['__proto__','constructor','prototype'].includes(key) || /^(?:api[-_]?key|(?:access[-_]?|refresh[-_]?)?token|password|secret|credentials?|authorization|proxy-authorization|cookie|set-cookie)$/iu.test(key) ||
          /(?:^|[-_])(?:api[-_]?key|token|secret|password|authorization)(?:$|[-_])/iu.test(key)) throw fail();
      visit(entry);
    }
  };
  visit(configuration);
  return structuredClone(configuration);
}
export async function bundledDefaultPlugins(packageRoot) {
  const directory=path.join(packageRoot,'dist/extensions');
  let entries;try{entries=await fs.readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return[];throw error;}
  if(entries.length>512)throw fail();const ids=[];
  for(const entry of entries){if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    const file=path.join(directory,entry.name,'openclaw.plugin.json');let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512*1024)throw fail();
    const manifest=JSON.parse(await fs.readFile(file,'utf8'));
    if(manifest.enabledByDefault===true){if(typeof manifest.id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(manifest.id)||ids.includes(manifest.id))throw fail();ids.push(manifest.id);}
  }
  return ids.sort();
}
