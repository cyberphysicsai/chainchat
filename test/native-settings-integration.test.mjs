import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { initOpenClawSettings, nativeConfigGuardFor } from '../public/openclaw-settings.js';
import { validateControlPatch } from '../lib/openclaw-controls.mjs';

const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const descendants = node => [node, ...node.children.flatMap(descendants)];
const camel = value => value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
class Node {
  constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.children = []; this.handlers = new Map(); this.dataset = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.checked = false; this.disabled = false; this.className = ''; }
  set id(value) { this._id = value; this.doc.ids.set(value, this); } get id() { return this._id; }
  get options() { return this.children.filter(node => node.tagName === 'option'); }
  get classList() { const current = () => new Set(this.className.split(/\s+/).filter(Boolean)); return { contains: name => current().has(name), add: name => { const names = current(); names.add(name); this.className = [...names].join(' '); }, remove: name => { const names = current(); names.delete(name); this.className = [...names].join(' '); }, toggle: (name, enabled) => { const names = current(); if (enabled ?? !names.has(name)) names.add(name); else names.delete(name); this.className = [...names].join(' '); } }; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of [...nodes].reverse()) { node.remove(); node.parentElement = this; this.children.unshift(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parentElement = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  setAttribute(name, value) { this.attributes[name] = value; if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = value; else if (name === 'id') this.id = value; else if (['type', 'class', 'value'].includes(name)) this[name === 'class' ? 'className' : name] = value; }
  addEventListener(name, callback) { const handlers = this.handlers.get(name) || []; handlers.push(callback); this.handlers.set(name, handlers); }
  async fire(name, extra = {}) { for (const callback of this.handlers.get(name) || []) await callback({ preventDefault() {}, target: this, ...extra }); }
  querySelectorAll(selector) { return descendants(this).slice(1).filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {} scrollIntoView() {}
  set innerHTML(_value) { throw new Error('Dynamic metadata cannot become markup.'); }
}
function matches(node, selector) {
  const tag = selector.match(/^[a-z]+/)?.[0]; if (tag && node.tagName !== tag) return false;
  const className = selector.match(/\.([\w-]+)/)?.[1]; if (className && !node.classList.contains(className)) return false;
  for (const match of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const value = match[1].startsWith('data-') ? node.dataset[camel(match[1].slice(5))] : node[match[1]] ?? node.attributes[match[1]];
    if (value === undefined || match[2] !== undefined && String(value) !== match[2]) return false;
  }
  return !selector.includes(':checked') || node.checked;
}
function documentFixture() {
  const doc = { ids: new Map(), visibilityState: 'hidden', defaultView: { addEventListener() {} }, createElement(tag) { return new Node(tag, this); }, getElementById(id) { return this.ids.get(id) || null; } };
  doc.root = doc.createElement('body'); doc.querySelectorAll = selector => doc.root.querySelectorAll(selector); doc.querySelector = selector => doc.root.querySelector(selector);
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*?)>/g)) {
    const attrs = [...match[2].matchAll(/([\w-]+)="([^"]*)"/g)];
    if (!attrs.some(attr => attr[1] === 'id' || attr[1].startsWith('data-native-') || attr[1] === 'data-goal-command')) continue;
    const node = doc.createElement(match[1]); for (const attr of attrs) node.setAttribute(attr[1], attr[2]); doc.root.append(node);
  }
  const panel = doc.getElementById('openclawPanel');
  for (const node of [...doc.root.children]) if (node !== panel && (node.id?.startsWith('native') || node.dataset.nativeTab || node.dataset.nativeSection || node.dataset.goalCommand)) panel.append(node);
  const submit = doc.createElement('button'); submit.type = 'submit'; doc.getElementById('nativeToolsForm').append(submit);
  return doc;
}
const snapshot = (revision = 'r1') => ({ runtime: { version: '2026.11.3' }, selectedAgentId: 'agent-a', sessionKey: 'agent:main:test', commands: [],
  schema: { schema: { type: 'object', $defs: { retries: { type: 'integer', minimum: 0 } }, properties: { agents: { type: 'object', properties: { defaults: { type: 'object', properties: { maxRetries: { $ref: '#/$defs/retries' } } } } } } }, uiHints: { 'agents.defaults.maxRetries': { label: 'Retries from the exact native schema' } } },
  config: { revision, baseHash: `hash-${revision}`, editable: {}, effective: { agents: { defaults: { maxRetries: 2 } } }, immutablePaths: ['gateway'], guards: { gateway: 'Private transport.' } },
  nativeConfig: { config: { agents: { defaults: { maxRetries: 2 } } }, hash: `hash-${revision}` }, services: { jobs: [], channels: [], occurrences: [] }, toolAuthority: { grant: {} } });
const settle = async () => { for (let count = 0; count < 12; count++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ save = async () => ({}), channels = { items: [] }, initial = snapshot() } = {}) {
  const doc = documentFixture(), calls = []; let current = initial, connected = true;
  const api = async (route, payload) => { calls.push([route, payload]); if (route === '/api/openclaw') return current; if (route === '/api/openclaw/channels') return channels; if (route === '/api/openclaw/config') return save(payload); if (route === '/api/openclaw/secrets') return { targets: [], bindings: [] }; return {}; };
  const controller = initOpenClawSettings({ document: doc, api, requireConnection: action => action(), executeCommand: async () => ({}), isConnected: () => connected });
  controller.syncConnection({ connected, agentId: 'agent-a' });
  return { doc, controller, calls, get: id => doc.getElementById(id), input: label => doc.querySelectorAll('input').find(node => node.attributes['aria-label'] === label),
    changeAgent(id, revision = 'r2') { current = { ...snapshot(revision), selectedAgentId: id }; controller.syncConnection({ connected, agentId: id }); }, disconnect() { connected = false; controller.syncConnection({ connected: false }); } };
}

test('root settings mount maps the native schema envelope/effective values to actual typed apply payloads', async () => {
  const f = fixture(); await settle();
  const input = f.input('agents.defaults.maxRetries'); assert.ok(input); assert.equal(input.value, '2');
  input.value = '4'; await input.fire('change'); await f.get('saveNativeConfig').fire('click');
  const payload = f.calls.find(([route]) => route === '/api/openclaw/config')?.[1];
  assert.deepEqual(payload, { patch: { agents: { defaults: { maxRetries: 4 } } }, removePaths: [], revision: 'r1', baseHash: 'hash-r1' });
  assert.ok(f.doc.querySelectorAll('strong').some(node => node.textContent === 'Retries from the exact native schema'));
});

test('exact owner grants, mandatory immutables and host browser permissions match backend acceptance for compatible leaves', () => {
  const guards = { channels: 'Channel admission.', browser: 'Browser admission.', 'agents.defaults.compaction': 'Compaction admission.', gateway: 'Private transport.' };
  const config = { guards, immutablePaths: ['gateway', 'agents.defaults.model'] }, nativeCapabilities = { enabled: true, acknowledged: true, settings: ['channels.telegram', 'agents.defaults.compaction'] };
  const next = { config, toolAuthority: { grant: { nativeCapabilities } } };
  for (const [parts, value] of [[['channels', 'telegram', 'enabled'], true], [['agents', 'defaults', 'compaction', 'mode'], 'safeguard']]) {
    assert.equal(nativeConfigGuardFor(next, parts), '');
    const patch = parts.reduceRight((child, key) => ({ [key]: child }), value); assert.doesNotThrow(() => validateControlPatch(patch, { nativeCapabilities }));
  }
  assert.ok(nativeConfigGuardFor(next, ['channels', 'discord', 'enabled'])); assert.ok(nativeConfigGuardFor(next, ['gateway', 'bind']));
  assert.ok(nativeConfigGuardFor(next, ['agents', 'defaults'], { includeChildren: true }));
  const host = { config, toolAuthority: { grant: { enabled: true, acknowledged: true } } };
  assert.equal(nativeConfigGuardFor(host, ['browser', 'headless']), ''); assert.doesNotThrow(() => validateControlPatch({ browser: { headless: true } }, { allowHostConfiguration: true }));
});

test('late previous-agent config apply cannot discard a newly selected agent draft', async () => {
  let finish; const f = fixture({ save: () => new Promise(resolve => { finish = resolve; }) }); await settle();
  f.input('agents.defaults.maxRetries').value = '3'; await f.input('agents.defaults.maxRetries').fire('change');
  const pending = f.get('saveNativeConfig').fire('click'); f.changeAgent('agent-b'); await settle();
  f.input('agents.defaults.maxRetries').value = '7'; await f.input('agents.defaults.maxRetries').fire('change');
  finish({ applied: true }); await pending; await settle();
  assert.equal(f.input('agents.defaults.maxRetries').value, '7');
});

test('root channel controls use scoped catalogue/setup/action endpoints and clear on connection change', async () => {
  const item = { id: 'native-test', label: 'Runtime-discovered chat', installed: true, enabled: true, defaultAccountId: 'default', schema: { type: 'object', properties: { enabled: { type: 'boolean' } } }, accounts: [{ accountId: 'default', values: { enabled: false }, configPath: ['channels', 'native-test'] }], capabilities: { start: true }, credentialFields: [] };
  const f = fixture({ channels: { items: [item], baseHash: 'channel-hash' } }); await settle();
  const mount = f.get('nativeChannelSetupMount'), input = descendants(mount).find(node => node.attributes['aria-label'] === 'enabled'); input.checked = true; await input.fire('change');
  await f.controller.refresh(); assert.equal(descendants(mount).find(node => node.attributes['aria-label'] === 'enabled').checked, true, 'Passive root health refresh must preserve the channel configuration draft.');
  await descendants(mount).find(node => node.textContent === 'Save native channel configuration').fire('click');
  assert.deepEqual(f.calls.find(([route]) => route === '/api/openclaw/channels/setup')?.[1], { channelId: 'native-test', accountId: 'default', values: { enabled: true }, secretValues: [], baseHash: 'channel-hash' });
  await descendants(mount).find(node => node.textContent === 'Start channel').fire('click');
  assert.deepEqual(f.calls.find(([route]) => route === '/api/openclaw/channels/action')?.[1], { action: 'start', channelId: 'native-test', accountId: 'default' });
  f.disconnect(); assert.equal(descendants(mount).find(node => node.textContent === 'Save native channel configuration').disabled, true);
});

test('older local runtimes retain legacy controls while new settings forms and catalogue polling require an upgrade', async () => {
  const older = snapshot(); delete older.config.baseHash; delete older.config.effective; older.runtime.version = 'older-local-runtime';
  const f = fixture({ initial: older }); await settle();
  assert.equal(f.get('nativeConnectedControls').disabled, false);
  assert.equal(f.get('saveNativeConfig').disabled, true); assert.equal(f.input('agents.defaults.maxRetries').disabled, true);
  assert.match(f.get('nativeConfigNotice').textContent, /Install ChainChat 1\.1\.0/);
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/channels'), false);
  assert.equal(f.get('startNativeGoal').disabled, false, 'Existing selected-agent native controls remain available.');
  assert.equal(descendants(f.get('nativeChannelSetupMount')).find(node => node.textContent === 'Save native channel configuration').disabled, true);
});
