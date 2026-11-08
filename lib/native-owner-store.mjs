import fs from 'node:fs/promises';
import path from 'node:path';
import {writeJSON} from './state.mjs';
import {validateNativeProvider} from './providers.mjs';
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,100}:[a-f0-9]{64}$/.test(value) && !/[\0\r\n\u2028\u2029]/.test(value);
const fail = () => Object.assign(new Error('Inspect the private native provider ownership file before starting native work.'), {code: 'NATIVE_OWNER_INVALID', status: 409});

// Contains only owner-selected native model references. API keys, browser
// tokens, prompts and arbitrary native job claims are never persisted here.
export class NativeOwnerStore {
  constructor(directory) {this.file = path.join(directory, 'native-provider-owners.json'); this.entries = new Map(); this.queue = Promise.resolve();}
  async load() {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw fail();
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!saved || Object.keys(saved).sort().join(',') !== 'owners,version' || saved.version !== 1 || !Array.isArray(saved.owners) || saved.owners.length > 4096) throw fail();
      for (const item of saved.owners) {
        if (!item || Object.keys(item).sort().join(',') !== 'config,key' || !validKey(item.key) || this.entries.has(item.key)) throw fail();
        this.entries.set(item.key, validateNativeProvider(item.config));
      }
    } catch (error) {if (error.code !== 'ENOENT') throw fail();}
    return this;
  }
  get(key) {const value = this.entries.get(key); return value ? structuredClone(value) : null;}
  clearAgent(agentId) {
    if (typeof agentId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(agentId)) return Promise.reject(fail());
    const action = this.queue.then(async () => {
      const next = new Map([...this.entries].filter(([key]) => !key.startsWith(agentId + ':')));
      if (next.size === this.entries.size) return;
      await writeJSON(this.file, {version: 1, owners: [...next].map(([key, config]) => ({key, config}))});
      this.entries = next;
    });
    this.queue = action.catch(() => {}); return action;
  }
  set(key, config) {
    if (!validKey(key)) return Promise.reject(fail());
    const normalized = config == null ? null : validateNativeProvider(config);
    const action = this.queue.then(async () => {
      const next = new Map(this.entries);
      if (normalized) next.set(key, normalized); else next.delete(key);
      if (next.size > 4096) throw fail();
      const saved = {version: 1, owners: [...next].map(([key, config]) => ({key, config}))};
      if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > 1024 * 1024) throw fail();
      await writeJSON(this.file, saved); this.entries = next;
    });
    this.queue = action.catch(() => {}); return action;
  }
}
