import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { initOpenClawSettings, nativeConfigGuardFor } from '../public/openclaw-settings.js';
import { validateControlPatch } from '../lib/openclaw-controls.mjs';

const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const descendants = node => [node, ...node.children.flatMap(descendants)];
const camel = value => value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
class Node {
  constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.children = []; this.handlers = new Map(); this.dataset = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.checked = false; this.disabled = false; this.className = ''; if (tag === 'textarea') Object.defineProperty(this, 'type', { get: () => 'textarea' }); }
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
  const doc = { ids: new Map(), visibilityState: 'hidden', defaultView: { addEventListener() {} }, createElement(tag) { if (tag === 'textarea' && this.rejectTextareas) throw new Error('Injected settings renderer failure.'); return new Node(tag, this); }, getElementById(id) { return this.ids.get(id) || null; } };
  doc.root = doc.createElement('body'); doc.querySelectorAll = selector => doc.root.querySelectorAll(selector); doc.querySelector = selector => doc.root.querySelector(selector);
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*?)>/g)) {
    const attrs = [...match[2].matchAll(/([\w-]+)="([^"]*)"/g)];
    if (!attrs.some(attr => attr[1] === 'id' || attr[1].startsWith('data-native-') || attr[1] === 'data-goal-command' || attr[1] === 'data-browser-capability')) continue;
    const node = doc.createElement(match[1]); for (const attr of attrs) node.setAttribute(attr[1], attr[2]); doc.root.append(node);
  }
  const panel = doc.getElementById('openclawPanel');
  for (const node of [...doc.root.children]) if (node !== panel && (node.id?.startsWith('native') || node.dataset.nativeTab || node.dataset.nativeSection || node.dataset.goalCommand || node.dataset.browserCapability)) panel.append(node);
  const toolForm = doc.getElementById('nativeToolsForm');
  for (const id of ['nativeToolsTitle', 'nativeToolScopeStatus', 'nativeToolDraftStatus', 'nativeToolsEnabled', 'nativeToolChoices', 'nativeToolRoots', 'nativeToolHosts', 'nativeExecutionAllowed', 'nativeToolsAcknowledged']) toolForm.append(doc.getElementById(id));
  const submit = doc.createElement('button'); submit.type = 'submit'; doc.getElementById('nativeToolsForm').append(submit);
  return doc;
}
const snapshot = (revision = 'r1') => ({ runtime: { version: '2026.11.3' }, selectedAgentId: 'agent-a', sessionKey: 'agent:main:test', commands: [],
  schema: { schema: { type: 'object', $defs: { retries: { type: 'integer', minimum: 0 } }, properties: { agents: { type: 'object', properties: { defaults: { type: 'object', properties: { maxRetries: { $ref: '#/$defs/retries' } } } } } } }, uiHints: { 'agents.defaults.maxRetries': { label: 'Retries from the exact native schema' } } },
  config: { revision, baseHash: `hash-${revision}`, editable: {}, effective: { agents: { defaults: { maxRetries: 2 } } }, immutablePaths: ['gateway'], guards: { gateway: 'Private transport.' } },
  nativeConfig: { config: { agents: { defaults: { maxRetries: 2 } } }, hash: `hash-${revision}` }, services: { jobs: [], channels: [], occurrences: [] }, toolAuthority: { operations: ['save', 'revoke-all'], grant: {} } });
const settle = async () => { for (let count = 0; count < 12; count++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ save = async () => ({}), saveTools = async () => ({}), saveNativeCapabilities = async () => ({}), channels = { items: [] }, initial = snapshot() } = {}) {
  const doc = documentFixture(), calls = []; let current = initial, connected = true;
  const api = async (route, payload) => { calls.push([route, payload]); if (route === '/api/openclaw') return current; if (route === '/api/openclaw/channels') return channels; if (route === '/api/openclaw/config') return save(payload); if (route === '/api/openclaw/tools') return saveTools(payload); if (route === '/api/openclaw/native-capabilities') return saveNativeCapabilities(payload); if (route === '/api/openclaw/secrets') return { targets: [], bindings: [] }; return {}; };
  const controller = initOpenClawSettings({ document: doc, api, requireConnection: action => action(), executeCommand: async () => ({}), isConnected: () => connected });
  controller.syncConnection({ connected, agentId: 'agent-a' });
  return { doc, controller, calls, get: id => doc.getElementById(id), input: label => doc.querySelectorAll('input').find(node => node.attributes['aria-label'] === label),
    changeAgent(id, revision = 'r2') { current = { ...snapshot(revision), selectedAgentId: id }; controller.syncConnection({ connected, agentId: id }); }, disconnect() { connected = false; controller.syncConnection({ connected: false }); } };
}

function textareaSnapshot() {
  const next = snapshot();
  Object.assign(next.schema.schema.properties.agents.properties.defaults.properties, {
    notes: { type: 'string' },
    labels: { type: 'object', additionalProperties: { type: 'string' } },
    aliases: { type: 'array', items: { type: 'string' } },
  });
  next.schema.uiHints['agents.defaults.notes'] = { multiline: true };
  Object.assign(next.config.effective.agents.defaults, { notes: 'First line\nSecond line', labels: { testing: 'local' }, aliases: ['one'] });
  return next;
}

test('native textarea settings do not strand grants or channel loading on the first snapshot or reload', async () => {
  const next = textareaSnapshot();
  next.toolCatalogue = [{ name: 'browser', available: true }];
  next.toolAuthority = { ...next.toolAuthority, grant: { enabled: true, acknowledged: true, tools: ['browser'], networkHosts: ['example.com'] } };
  const f = fixture({ initial: next }); await settle();
  assert.equal(f.get('nativeError').textContent, '');
  assert.equal(f.get('nativeConnectedControls').disabled, false);
  assert.equal(f.get('saveNativeConfig').disabled, false);
  assert.equal(f.get('nativeToolsEnabled').checked, true);
  assert.equal(f.get('nativeToolHosts').value, 'example.com');
  assert.ok(f.get('nativeToolChoices').children.length > 0);
  assert.ok(descendants(f.get('nativeConfigFormMount')).some(node => node.tagName === 'textarea' && node.value === 'First line\nSecond line'));
  assert.ok(f.calls.some(([route]) => route === '/api/openclaw/channels'));
  await f.get('refreshNativeControls').fire('click'); await settle();
  assert.equal(f.get('nativeError').textContent, '');
  assert.equal(f.get('nativeConnectedControls').disabled, false);
  assert.equal(f.calls.filter(([route]) => route === '/api/openclaw/channels').length, 2);
});

test('a settings renderer failure holds config writes while independent permission revocation and reload remain available', async () => {
  const f = fixture({ initial: textareaSnapshot() }); f.doc.rejectTextareas = true; await settle();
  assert.equal(f.get('nativeConnectedControls').disabled, false);
  assert.equal(f.get('saveNativeConfig').disabled, true);
  assert.equal(f.get('nativeConfigFormMount').inert, true);
  assert.match(f.get('nativeConfigNotice').textContent, /could not render/i);
  assert.equal(f.get('disableNativeTools').disabled, false);
  assert.ok(f.calls.some(([route]) => route === '/api/openclaw/channels'));
  await f.get('saveNativeConfig').fire('click');
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/config'), false);
  await f.get('disableNativeTools').fire('click'); await settle();
  assert.deepEqual(f.calls.find(([route]) => route === '/api/openclaw/tools')?.[1], { operation: 'revoke-all' });
  f.doc.rejectTextareas = false;
  await f.get('refreshNativeControls').fire('click'); await settle();
  assert.equal(f.get('nativeError').textContent, '');
  assert.equal(f.get('nativeConfigFormMount').inert, false);
  assert.equal(f.get('saveNativeConfig').disabled, false);
});

test('a redraw failure while starting Apply is caught before any configuration write', async () => {
  const f = fixture({ initial: textareaSnapshot() }); await settle();
  f.doc.rejectTextareas = true;
  await f.get('saveNativeConfig').fire('click');
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/config'), false);
  assert.equal(f.get('saveNativeConfig').disabled, true);
  assert.equal(f.get('refreshNativeControls').disabled, false);
  assert.equal(f.get('disableNativeTools').disabled, false);
  assert.match(f.get('nativeError').textContent, /settings form could not render/i);
});

test('a redraw failure after a successful Apply holds further writes without retrying the completed operation', async () => {
  let f;
  f = fixture({ initial: textareaSnapshot(), save: async () => { f.doc.rejectTextareas = true; return { applied: true }; } }); await settle();
  await f.get('saveNativeConfig').fire('click'); await settle();
  assert.equal(f.calls.filter(([route]) => route === '/api/openclaw/config').length, 1);
  assert.equal(f.get('nativeConnectedControls').disabled, false);
  assert.equal(f.get('saveNativeConfig').disabled, true);
  assert.equal(f.get('refreshNativeControls').disabled, false);
  assert.equal(f.get('disableNativeTools').disabled, false);
  await f.get('saveNativeConfig').fire('click');
  assert.equal(f.calls.filter(([route]) => route === '/api/openclaw/config').length, 1);
  assert.match(f.get('nativeError').textContent, /settings form could not render/i);
});

test('root settings mount maps the native schema envelope/effective values to actual typed apply payloads', async () => {
  const f = fixture(); await settle();
  const input = f.input('agents.defaults.maxRetries'); assert.ok(input); assert.equal(input.value, '2');
  input.value = '4'; await input.fire('change'); await f.get('saveNativeConfig').fire('click');
  const payload = f.calls.find(([route]) => route === '/api/openclaw/config')?.[1];
  assert.deepEqual(payload, { patch: { agents: { defaults: { maxRetries: 4 } } }, removePaths: [], revision: 'r1', baseHash: 'hash-r1' });
  assert.ok(f.doc.querySelectorAll('strong').some(node => node.textContent === 'Retries from the exact native schema'));
});

test('available channel plugin selection prefills the real artifact-review form without installing or trusting code',async()=>{
  const installSource={source:'npm',spec:'@openclaw/discord@2026.11.3',pin:true,expectedPluginId:'discord'};
  const f=fixture({channels:{items:[{id:'discord',label:'Discord',pluginId:'discord',installed:false,enabled:false,installSource,accounts:[],schema:{},capabilities:{}}]}});
  await settle();const button=f.doc.querySelectorAll('button').find(node=>node.textContent==='Review integration plugin');
  assert.ok(button);await button.fire('click');
  assert.equal(f.get('nativePluginOperation').value,'install');assert.equal(f.get('nativePluginId').value,'');
  assert.deepEqual(JSON.parse(f.get('nativePluginSource').value),installSource);
  assert.equal(f.calls.some(([route])=>route.startsWith('/api/openclaw/plugins/')),false);
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

function permissionSnapshot() {
  const next = snapshot();
  next.toolCatalogue = ['read', 'exec', 'web_fetch'].map(name => ({ name, available: true }));
  next.nativeToolCatalogue = [{ name: 'sessions_list', source: 'native', available: true, description: 'Inspect native sessions.' }];
  next.toolAuthority = { ...next.toolAuthority, grant: { enabled: false, acknowledged: false, tools: [], roots: [], networkHosts: [], allowExecution: false } };
  return next;
}
const hostChoice = (f, name) => f.get('nativeToolsForm').querySelector(`[data-host-tool="${name}"]`);
async function editToolField(f, node, value) {
  if (typeof value === 'boolean') node.checked = value; else node.value = value;
  await f.get('nativeToolsForm').fire('input', { target: node });
}
async function editNativeField(f, node, value) {
  if (typeof value === 'boolean') node.checked = value; else node.value = value;
  await f.get('nativeCapabilityForm').fire('input', { target: node });
}

test('host checkbox choices remain unapplied until explicit acknowledged Apply and then show saved readback', async () => {
  const next = permissionSnapshot();
  const f = fixture({ initial: next, saveTools: async payload => {
    const { operation, ...grant } = payload;
    next.toolAuthority = { ...next.toolAuthority, revision: 'saved-host-grant', grant: structuredClone(grant) }; return { toolAuthority: next.toolAuthority };
  } }); await settle();
  assert.equal(f.get('nativeToolsEnabled').checked, false);
  await editToolField(f, f.get('nativeToolsEnabled'), true);
  await editToolField(f, hostChoice(f, 'read'), true); await editToolField(f, hostChoice(f, 'exec'), true);
  await editToolField(f, f.get('nativeToolRoots'), '/disposable-project');
  await editToolField(f, f.get('nativeExecutionAllowed'), true);
  assert.match(f.get('nativeToolDraftStatus').textContent, /Unapplied choices/);
  assert.match(f.get('nativeToolScopeStatus').textContent, /0 file, shell and network tool grants/);
  assert.match(f.get('nativeToolScopeStatus').textContent, /execution grant off/);
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/tools'), false);
  await f.controller.refresh();
  assert.equal(hostChoice(f, 'exec').checked, true, 'A passive snapshot must not erase an explicit local draft.');
  assert.match(f.get('nativeToolDraftStatus').textContent, /Unapplied choices/);
  await f.get('nativeToolsForm').fire('submit'); await settle();
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/tools'), false);
  assert.match(f.get('nativeError').textContent, /Acknowledge/);
  f.get('nativeToolsAcknowledged').checked = true;
  await f.get('nativeToolsForm').fire('submit'); await settle();
  const posted = f.calls.filter(([route]) => route === '/api/openclaw/tools'); assert.equal(posted.length, 1);
  assert.deepEqual(posted[0][1], { operation: 'save', enabled: true, tools: ['read', 'exec'], roots: ['/disposable-project'], networkHosts: [],
    allowExecution: true, acknowledged: true, browserCapabilities: { evaluate: false, credentials: false, payments: false } });
  assert.equal(f.get('nativeToolsEnabled').checked, true); assert.equal(hostChoice(f, 'exec').checked, true);
  assert.equal(f.get('nativeToolsAcknowledged').checked, false, 'A saved acknowledgement is never reused to authorize a later scope edit.');
  assert.match(f.get('nativeToolDraftStatus').textContent, /Showing the saved grant/);
  assert.match(f.get('nativeToolScopeStatus').textContent, /2 file, shell and network tool grants/);
  assert.match(f.get('nativeToolScopeStatus').textContent, /execution grant on/);
});

test('additional OpenClaw checkboxes save only their native grant and leave file and shell permissions off', async () => {
  const next = permissionSnapshot();
  const f = fixture({ initial: next, saveNativeCapabilities: async payload => {
    next.toolAuthority = { ...next.toolAuthority, grant: { ...next.toolAuthority.grant, nativeCapabilities: structuredClone(payload) } };
    return { toolAuthority: next.toolAuthority, catalogue: next.nativeToolCatalogue };
  } }); await settle();
  f.controller.syncConnection({ connected: true, agentId: 'agent-a', runtimeReady: true, modelConfigured: true });
  const nativeChoice = f.doc.querySelector('[data-native-extra-tool="sessions_list"]'); assert.ok(nativeChoice);
  f.get('nativeCapabilitiesEnabled').checked = true; nativeChoice.checked = true;
  f.get('nativeAllSettings').checked = true; f.get('nativeCapabilitiesAcknowledged').checked = true;
  await f.get('nativeCapabilityForm').fire('submit'); await settle();
  assert.equal(f.calls.filter(([route]) => route === '/api/openclaw/native-capabilities').length, 1);
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/tools'), false);
  assert.equal(f.get('nativeToolsEnabled').checked, false); assert.equal(f.get('nativeExecutionAllowed').checked, false);
  assert.equal(hostChoice(f, 'read').checked, false); assert.equal(hostChoice(f, 'exec').checked, false);
  assert.match(f.get('nativeCapabilityStatus').textContent, /does not enable/);
  assert.match(f.get('nativeToolScopeStatus').textContent, /execution grant off/);
  assert.match(f.get('chatToolsStatus').textContent, /Native grants only/);
  let focused = 0; f.get('nativeToolsTitle').focus = () => focused++;
  await f.get('nativeScopedToolsShortcut').fire('click'); assert.equal(focused, 1);
  assert.equal(f.calls.filter(([route]) => route === '/api/openclaw/tools').length, 0);
});

test('saved form grants show runtime and Timechain holds without changing permissions or resuming memory', async () => {
  const next = permissionSnapshot();
  next.toolAuthority.grant = { enabled: true, acknowledged: true, tools: ['read', 'exec'], roots: ['/disposable-project'], networkHosts: [], allowExecution: true };
  const f = fixture({ initial: next }); await settle();
  const baselineCalls = f.calls.length;
  const context = { connected: true, agentId: 'agent-a', runtimeReady: true, modelConfigured: true };
  f.controller.syncConnection({ ...context, memoryPaused: true });
  assert.equal(f.get('nativeToolsEnabled').checked, true); assert.equal(hostChoice(f, 'exec').checked, true);
  assert.match(f.get('nativeToolScopeStatus').textContent, /^Tools paused with memory\./);
  assert.match(f.get('nativeToolScopeStatus').textContent, /Resume Timechain to use tools; applying permissions does not resume it/);
  f.controller.syncConnection({ ...context, chainHeld: true });
  assert.match(f.get('nativeToolScopeStatus').textContent, /^Tools held for chain review\./);
  f.controller.syncConnection({ ...context, runtimeReady: false });
  assert.match(f.get('nativeToolScopeStatus').textContent, /^Grants saved · runtime unavailable\./);
  f.controller.syncConnection({ ...context, learning: false });
  assert.match(f.get('nativeToolScopeStatus').textContent, /^2 tool grants saved\./);
  assert.equal(f.calls.length, baselineCalls, 'Reading blocked or ready status must never send a grant change or chain resume.');
});

test('scope edits clear acknowledgement, incomplete scopes cannot Apply and rejected saves retain a visible draft', async () => {
  const f = fixture({ initial: permissionSnapshot(), saveTools: async () => { throw new Error('Synthetic grant validation failed.'); } }); await settle();
  await editToolField(f, f.get('nativeToolsEnabled'), true); await editToolField(f, hostChoice(f, 'exec'), true);
  f.get('nativeToolsAcknowledged').checked = true;
  await f.get('nativeToolsForm').fire('submit'); await settle();
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/tools'), false); assert.match(f.get('nativeError').textContent, /separate local execution/);
  await editToolField(f, f.get('nativeExecutionAllowed'), true); assert.equal(f.get('nativeToolsAcknowledged').checked, false);
  await editToolField(f, hostChoice(f, 'read'), true); f.get('nativeToolsAcknowledged').checked = true;
  await f.get('nativeToolsForm').fire('submit'); await settle();
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/tools'), false); assert.match(f.get('nativeError').textContent, /workspace directory/);
  await editToolField(f, f.get('nativeToolRoots'), '/disposable-project');
  await editToolField(f, hostChoice(f, 'web_fetch'), true); f.get('nativeToolsAcknowledged').checked = true;
  await f.get('nativeToolsForm').fire('submit'); await settle();
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/tools'), false); assert.match(f.get('nativeError').textContent, /public hostname/);
  await editToolField(f, f.get('nativeToolHosts'), 'docs.example.com'); f.get('nativeToolsAcknowledged').checked = true;
  await f.get('nativeToolsForm').fire('submit'); await settle();
  assert.equal(f.calls.filter(([route]) => route === '/api/openclaw/tools').length, 1);
  assert.match(f.get('nativeError').textContent, /Synthetic grant validation failed/);
  assert.match(f.get('nativeToolDraftStatus').textContent, /Unapplied choices/);
  assert.match(f.get('nativeToolScopeStatus').textContent, /execution grant off/);
  assert.equal(hostChoice(f, 'exec').checked, true);
  const capability = f.doc.querySelector('[data-browser-capability="payments"]'); capability.checked = true; await f.get('openclawPanel').fire('input', { target: capability });
  assert.equal(f.get('nativeToolsAcknowledged').checked, false, 'Browser capability edits also change the explicit scope.');
});

test('late host grant completion cannot apply its readback or clear the newly selected agent draft', async () => {
  let finish; const f = fixture({ initial: permissionSnapshot(), saveTools: () => new Promise(resolve => { finish = resolve; }) }); await settle();
  await editToolField(f, f.get('nativeToolsEnabled'), true); await editToolField(f, hostChoice(f, 'exec'), true);
  await editToolField(f, f.get('nativeExecutionAllowed'), true); f.get('nativeToolsAcknowledged').checked = true;
  await f.get('nativeToolsForm').fire('submit'); await settle(); assert.equal(typeof finish, 'function');
  f.changeAgent('agent-b'); await settle();
  await editToolField(f, f.get('nativeToolRoots'), '/agent-b-project');
  finish({ toolAuthority: { grant: { enabled: true, acknowledged: true, tools: ['exec'], allowExecution: true } } }); await settle();
  assert.equal(f.get('nativeToolsEnabled').checked, false); assert.equal(f.get('nativeToolRoots').value, '/agent-b-project');
  assert.match(f.get('nativeToolDraftStatus').textContent, /Unapplied choices/);
  assert.match(f.get('nativeToolScopeStatus').textContent, /execution grant off/);
});

for (const first of ['primary', 'native']) test(`applying the ${first} permission form preserves the other form's unapplied scope and acknowledgement`, async () => {
  const next = permissionSnapshot();
  const f = fixture({ initial: next, saveTools: async payload => {
    const { operation, ...grant } = payload;
    next.toolAuthority = { ...next.toolAuthority, grant: { ...structuredClone(grant), nativeCapabilities: next.toolAuthority.grant.nativeCapabilities } };
    return { toolAuthority: next.toolAuthority };
  }, saveNativeCapabilities: async payload => {
    next.toolAuthority = { ...next.toolAuthority, grant: { ...next.toolAuthority.grant, nativeCapabilities: structuredClone(payload) } };
    return { toolAuthority: next.toolAuthority, catalogue: next.nativeToolCatalogue };
  } }); await settle();
  await editToolField(f, f.get('nativeToolsEnabled'), true); await editToolField(f, hostChoice(f, 'exec'), true);
  await editToolField(f, f.get('nativeExecutionAllowed'), true); await editToolField(f, f.get('nativeToolsAcknowledged'), true);
  await editNativeField(f, f.get('nativeCapabilitiesEnabled'), true);
  await editNativeField(f, f.doc.querySelector('[data-native-extra-tool="sessions_list"]'), true);
  await editNativeField(f, f.get('nativeSettingPaths'), 'messages.queue');
  await editNativeField(f, f.get('nativeCapabilitiesAcknowledged'), true);
  assert.equal(f.calls.some(([route]) => ['/api/openclaw/tools', '/api/openclaw/native-capabilities'].includes(route)), false);
  await f.get(first === 'primary' ? 'nativeToolsForm' : 'nativeCapabilityForm').fire('submit'); await settle();
  if (first === 'primary') {
    assert.equal(f.get('nativeCapabilitiesEnabled').checked, true);
    assert.equal(f.doc.querySelector('[data-native-extra-tool="sessions_list"]').checked, true);
    assert.equal(f.get('nativeSettingPaths').value, 'messages.queue');
    assert.equal(f.get('nativeCapabilitiesAcknowledged').checked, true);
    assert.match(f.get('nativeCapabilityDraftStatus').textContent, /Unapplied native choices/);
    assert.match(f.get('nativeCapabilityStatus').textContent, /disabled/, 'Saved readback must still describe the unapplied native grant as disabled.');
  } else {
    assert.equal(f.get('nativeToolsEnabled').checked, true); assert.equal(hostChoice(f, 'exec').checked, true);
    assert.equal(f.get('nativeExecutionAllowed').checked, true); assert.equal(f.get('nativeToolsAcknowledged').checked, true);
    assert.match(f.get('nativeToolDraftStatus').textContent, /Unapplied choices/);
    assert.match(f.get('nativeToolScopeStatus').textContent, /execution grant off/, 'Saved readback must not claim the primary draft is active.');
  }
  await f.get(first === 'primary' ? 'nativeCapabilityForm' : 'nativeToolsForm').fire('submit'); await settle();
  assert.equal(f.calls.filter(([route]) => route === '/api/openclaw/tools').length, 1);
  assert.equal(f.calls.filter(([route]) => route === '/api/openclaw/native-capabilities').length, 1);
  assert.deepEqual(next.toolAuthority.grant.tools, ['exec']);
  assert.deepEqual(next.toolAuthority.grant.nativeCapabilities.tools, ['sessions_list']);
  assert.deepEqual(next.toolAuthority.grant.nativeCapabilities.settings, ['messages.queue']);
  assert.equal(f.get('nativeToolsAcknowledged').checked, false); assert.equal(f.get('nativeCapabilitiesAcknowledged').checked, false);
  assert.match(f.get('nativeToolDraftStatus').textContent, /Showing the saved grant/);
  assert.match(f.get('nativeCapabilityDraftStatus').textContent, /Showing the saved native grant/);
});

test('native scope changes clear acknowledgement and a rejected save preserves the draft until agent reset', async () => {
  const f = fixture({ initial: permissionSnapshot(), saveNativeCapabilities: async () => { throw new Error('Synthetic native grant rejection.'); } }); await settle();
  await editNativeField(f, f.get('nativeCapabilitiesEnabled'), true);
  await editNativeField(f, f.get('nativeSettingPaths'), 'messages.queue');
  await editNativeField(f, f.get('nativeCapabilitiesAcknowledged'), true);
  await editNativeField(f, f.get('nativeBackgroundRuns'), true);
  assert.equal(f.get('nativeCapabilitiesAcknowledged').checked, false);
  await f.get('nativeCapabilityForm').fire('submit'); await settle();
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/native-capabilities'), false);
  await editNativeField(f, f.get('nativeCapabilitiesAcknowledged'), true);
  await f.get('nativeCapabilityForm').fire('submit'); await settle();
  assert.match(f.get('nativeError').textContent, /Synthetic native grant rejection/);
  await f.controller.refresh();
  assert.equal(f.get('nativeCapabilitiesEnabled').checked, true); assert.equal(f.get('nativeBackgroundRuns').checked, true);
  assert.equal(f.get('nativeSettingPaths').value, 'messages.queue');
  assert.match(f.get('nativeCapabilityDraftStatus').textContent, /Unapplied native choices/);
  assert.match(f.get('nativeCapabilityStatus').textContent, /disabled/);
  f.changeAgent('agent-b'); await settle();
  assert.equal(f.get('nativeCapabilitiesEnabled').checked, false); assert.equal(f.get('nativeBackgroundRuns').checked, false);
  assert.equal(f.get('nativeCapabilitiesAcknowledged').checked, false); assert.equal(f.get('nativeSettingPaths').value, '');
  assert.doesNotMatch(f.get('nativeCapabilityDraftStatus').textContent, /Unapplied/);
});

for (const first of ['primary', 'native']) test(`primary-off Apply and native Apply preserve separate grants in ${first}-first order; explicit revoke-all clears both`, async () => {
  const next = permissionSnapshot();
  next.toolAuthority.grant = { ...next.toolAuthority.grant, enabled: true, acknowledged: true, tools: ['exec'], allowExecution: true };
  const f = fixture({ initial: next, saveTools: async payload => {
    if (payload.operation === 'revoke-all') next.toolAuthority.grant = { enabled: false, acknowledged: false, tools: [], roots: [], networkHosts: [], allowExecution: false,
      nativeCapabilities: { enabled: false, acknowledged: false, tools: [], settings: [], delegatedRuns: false, backgroundRuns: false } };
    else {
      const { operation, ...grant } = payload;
      next.toolAuthority.grant = { ...structuredClone(grant), nativeCapabilities: next.toolAuthority.grant.nativeCapabilities };
    }
    return { toolAuthority: next.toolAuthority };
  }, saveNativeCapabilities: async payload => {
    next.toolAuthority.grant = { ...next.toolAuthority.grant, nativeCapabilities: structuredClone(payload) };
    return { toolAuthority: next.toolAuthority, catalogue: next.nativeToolCatalogue };
  } }); await settle();
  await editToolField(f, f.get('nativeToolsEnabled'), false);
  assert.equal(f.get('nativeToolsAcknowledged').checked, false, 'Disabling a primary grant does not need a new privilege acknowledgement.');
  await editNativeField(f, f.get('nativeCapabilitiesEnabled'), true);
  await editNativeField(f, f.get('nativeSettingPaths'), 'messages.queue');
  await editNativeField(f, f.get('nativeCapabilitiesAcknowledged'), true);
  await f.get(first === 'primary' ? 'nativeToolsForm' : 'nativeCapabilityForm').fire('submit'); await settle();
  if (first === 'primary') {
    assert.equal(f.get('nativeCapabilitiesEnabled').checked, true); assert.equal(f.get('nativeSettingPaths').value, 'messages.queue');
    assert.equal(f.get('nativeCapabilitiesAcknowledged').checked, true); assert.match(f.get('nativeCapabilityDraftStatus').textContent, /Unapplied native choices/);
  } else {
    assert.equal(f.get('nativeToolsEnabled').checked, false); assert.match(f.get('nativeToolDraftStatus').textContent, /Unapplied choices/);
  }
  await f.get(first === 'primary' ? 'nativeCapabilityForm' : 'nativeToolsForm').fire('submit'); await settle();
  const off = f.calls.find(([route]) => route === '/api/openclaw/tools')[1];
  assert.equal(off.operation, 'save'); assert.equal(off.enabled, false);
  assert.equal(next.toolAuthority.grant.enabled, false); assert.equal(next.toolAuthority.grant.nativeCapabilities.enabled, true);
  assert.deepEqual(next.toolAuthority.grant.nativeCapabilities.settings, ['messages.queue']);
  assert.equal(f.get('nativeCapabilitiesEnabled').checked, true);
  await editNativeField(f, f.get('nativeSettingPaths'), 'messages.newDraft');
  await f.get('disableNativeTools').fire('click'); await settle();
  assert.deepEqual(f.calls.filter(([route]) => route === '/api/openclaw/tools').at(-1)[1], { operation: 'revoke-all' });
  assert.equal(next.toolAuthority.grant.enabled, false); assert.equal(next.toolAuthority.grant.nativeCapabilities.enabled, false);
  assert.equal(f.get('nativeCapabilitiesEnabled').checked, false); assert.equal(f.get('nativeSettingPaths').value, '');
  assert.doesNotMatch(f.get('nativeCapabilityDraftStatus').textContent, /Unapplied/);
});

test('older runtime cannot save separate primary scopes, but explicit revoke-all retains safe legacy behavior', async () => {
  const next = permissionSnapshot(); delete next.toolAuthority.operations;
  const f = fixture({ initial: next }); await settle();
  await f.get('nativeToolsForm').fire('submit'); await settle();
  assert.match(f.get('nativeError').textContent, /Update your local ChainChat to 1\.1\.3 to save separate permission scopes/);
  assert.equal(f.calls.some(([route]) => route === '/api/openclaw/tools'), false);
  await f.get('disableNativeTools').fire('click'); await settle();
  assert.deepEqual(f.calls.filter(([route]) => route === '/api/openclaw/tools').map(([, payload]) => payload), [{ enabled: false }]);
});
