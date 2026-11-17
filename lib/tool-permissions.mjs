import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeJSON } from './state.mjs';

export const disabledToolAuthority = () => ({ enabled: false, tools: [], roots: [], networkHosts: [], allowExecution: false, acknowledged: false });
// Interface capabilities are readback metadata, never permission fields or
// persisted authority. Older clients can still revoke with enabled:false.
const snapshot = entry => ({ ...structuredClone(entry), operations: ['save', 'revoke-all'] });
export class ToolPermissions {
  constructor(root) { this.file = path.join(root, 'tool-permissions.json'); this.entries = new Map(); this.pending = Promise.resolve(); }
  mutate(action) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.agents || typeof saved.agents !== 'object' || Array.isArray(saved.agents)) throw new Error('Invalid permissions');
      this.entries = new Map(Object.entries(saved.agents));
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Local tool permissions need inspection before startup.'); }
    return this;
  }
  get(identity) {
    const entry = this.entries.get(identity);
    return snapshot(entry || { revision: 'disabled', grant: disabledToolAuthority() });
  }
  async set(identity, grant) {
    const owned = structuredClone(grant);
    return this.update(identity, () => owned);
  }
  // Merge and asynchronous validation must share the mutation queue with the
  // write and with revoke-all. Serializing only replacement writes can revive
  // an old scope or lose a concurrently saved independent capability grant.
  async update(identity, transform) {
    return this.mutate(async () => {
    const grant = await transform(this.get(identity));
    const entry = { revision: randomBytes(16).toString('hex'), grant: structuredClone(grant) };
    const next = new Map(this.entries); next.set(identity, entry);
    await writeJSON(this.file, { version: 1, agents: Object.fromEntries(next) });
    this.entries = next;
    return snapshot(entry);
    });
  }
  async disableRecord(recordId) {
    return this.mutate(async () => {
    const next = new Map(this.entries);
    const entry = { revision: randomBytes(16).toString('hex'), grant: disabledToolAuthority() };
    for (const identity of next.keys()) if (identity.startsWith(recordId + ':')) next.set(identity, structuredClone(entry));
    await writeJSON(this.file, { version: 1, agents: Object.fromEntries(next) });
    this.entries = next;
    return snapshot(entry);
    });
  }
}
