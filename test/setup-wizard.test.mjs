import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountSetupWizard, setupContext, setupProgress, setupCheckRows } from '../public/setup-wizard.js';

const secret = 'synthetic-onboarding-secret-never-render';
const head = 'a'.repeat(64);
const snapshot = () => ({ local: true, connected: true, generation: 4, state: {
  provider: { configured: true, provider: 'openai', tier: 'byok', model: 'fixture-model' },
  agent: { id: 'agent-one', name: 'Cypher Tempre', head: { hash: head }, verified: 'PASS' },
  agents: [{ id: 'agent-one', name: 'Cypher Tempre' }, { id: 'agent-two', name: 'Another agent' }],
  executionRuntime: { backend: 'openclaw', version: '2026.10.10', running: true, healthy: true, enforcementHealthy: true },
  canonicalSkill: { commit: 'c'.repeat(40), origin: 'fixed-publisher', immutableTurnSnapshot: true },
  cognition: { mode: 'active' },
} });
const readyReport = current => ({ version: 1, setupReady: true, nextStep: 'complete',
  checkedAt: '2026-11-04T21:00:00.000Z', inferencePerformed: false, modelConnectionTested: false,
  memoryPaused: false, checks: {
    connection: { ready: true }, runtime: { ready: true, configured: true, running: true, version: '2026.10.10' },
    model: { ready: true, configured: true, provider: current.state.provider.provider,
      tier: current.state.provider.provider === 'native' ? 'native' : 'byok',
      model: current.state.provider.model, connectionTested: false },
    timechain: { ready: true, selected: true, verified: true, agentId: current.state.agent.id,
      headHash: current.state.agent.head.hash, name: current.state.agent.name, blockHeight: 12, error: null },
    proof: { ready: true, required: true, verified: true, commit: 'b'.repeat(40) },
  } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function matches(node, selector) {
  if (selector === 'dialog[open]') return node.tagName === 'dialog' && node.open;
  if (selector === '[data-setup-step]') return Object.hasOwn(node.dataset, 'setupStep');
  if (selector === '[data-setup-panel]') return Object.hasOwn(node.dataset, 'setupPanel');
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  return node.tagName === selector;
}
class Node {
  constructor(doc, tag = 'div') {
    this.doc = doc; this.tagName = tag; this.children = []; this.handlers = new Map(); this.dataset = {};
    this.attributes = {}; this.className = ''; this.disabled = false; this.hidden = false; this.open = false;
    this._text = ''; this._value = ''; this.showCount = 0;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; this._text = ''; if (this.tagName === 'select') this._value = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { this.handlers.set(type, [...this.handlers.get(type) || [], handler]); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  async fire(type = 'click', event = {}) {
    if (type === 'click' && this.disabled) return;
    const wrapped = { target: this, currentTarget: this, preventDefault() {}, ...event };
    for (const handler of this.handlers.get(type) || []) await handler(wrapped);
  }
  showModal() { this.open = true; this.showCount++; }
  close() { if (!this.open) return; this.open = false; this.doc.queue.push(() => { for (const handler of this.handlers.get('close') || []) handler({ target: this }); }); }
  cloneNode(deep) {
    const copy = new Node(this.doc, this.tagName);
    copy._text = this._text; copy._value = this._value; copy.href = this.href; copy.className = this.className;
    copy.dataset = { ...this.dataset }; copy.attributes = { ...this.attributes };
    if (deep) copy.append(...this.children.map(child => child.cloneNode(true)));
    return copy;
  }
  set innerHTML(_value) { throw new Error('Setup must render text, not provider or agent markup'); }
}

function fixture({ initial = snapshot(), api, selectAgent } = {}) {
  let current = structuredClone(initial), clock = 1_000;
  const queue = [], ids = new Map(), calls = [], actionCalls = [];
  const doc = { queue, createElement: tag => new Node(doc, tag),
    getElementById(id) { assert.ok(ids.has(id), `Unexpected setup DOM access: ${id}`); return ids.get(id); },
    querySelector(selector) {
      if (selector === '#installDialog .platform-downloads') return downloads;
      if (selector === 'dialog[open]') return [...ids.values()].find(node => matches(node, selector)) || null;
      throw new Error('Unexpected document query: ' + selector);
    } };
  const add = (id, tag = 'div', parent = null) => { const node = new Node(doc, tag); node.id = id; ids.set(id, node); if (parent) parent.append(node); return node; };
  const dialog = add('setupDialog', 'dialog');
  for (const id of ['modelDialog', 'genesisDialog', 'existingDialog', 'pairDialog']) add(id, 'dialog');
  for (const id of ['setupProgressText', 'setupLocalStatus', 'setupModelStatus', 'setupChainStatus', 'setupSavedSection',
    'setupReadyTitle', 'setupReadyNote', 'setupPausedNote', 'setupError', 'setupDownloads']) add(id, 'div', dialog);
  add('setupCheckList', 'ul', dialog); add('setupSavedAgents', 'select', dialog);
  for (const id of ['setupBack', 'setupNext', 'setupModelAction', 'setupNewChain', 'setupExistingChain', 'setupSelectSaved',
    'setupCheck', 'setupFinish', 'setupFirstMessage', 'setupRepairModel', 'setupRepairChain', 'setupRepairRuntime',
    'setupAdvancedPair', 'setupDismiss', 'setupLater']) add(id, 'button', dialog);
  for (let index = 0; index < 4; index++) {
    const button = add('step-' + index, 'button', dialog); button.dataset.setupStep = String(index);
    const status = new Node(doc, 'small'); status.className = 'setup-step-state'; button.append(status);
    const panel = add('panel-' + index, 'section', dialog); panel.dataset.setupPanel = String(index);
  }
  const downloads = new Node(doc); downloads.className = 'platform-downloads';
  for (const platform of ['windows', 'macos', 'linux']) { const link = new Node(doc, 'a'); link.href = 'https://downloads.invalid/' + platform; link.textContent = platform; downloads.append(link); }
  const actions = Object.fromEntries([['model', 'modelDialog'], ['genesis', 'genesisDialog'], ['existing', 'existingDialog'], ['pair', 'pairDialog']]
    .map(([name, id]) => [name, () => { actionCalls.push({ action: name }); ids.get(id).showModal(); }]));
  actions.settings = () => actionCalls.push({ action: 'settings' });
  actions.finish = payload => actionCalls.push({ action: 'finish', ...payload });
  actions.selectAgent = async id => { actionCalls.push({ action: 'select', id }); return selectAgent?.(id); };
  const controls = mountSetupWizard({ document: doc, snapshot: () => current, defer: callback => queue.push(callback), now: () => clock, actions,
    api: async (...args) => { calls.push(structuredClone(args)); return api ? api(...args) : readyReport(current); } });
  return { doc, ids, calls, actionCalls, controls, downloads,
    id: id => doc.getElementById(id), get current() { return current; },
    change(callback, update = true) { callback(current); if (update) controls.update(); },
    advance(milliseconds, update = true) { clock += milliseconds; if (update) controls.update(); },
    async flush() { for (let turn = 0; turn < 8; turn++) { while (queue.length) queue.shift()(); await Promise.resolve(); } },
    text() { return [...ids.values()].map(node => node.textContent).join('\n'); } };
}

test('progress requires authenticated installation, a configured model, verified chain and complete server readiness', () => {
  const state = snapshot(), report = readyReport(state);
  assert.equal(setupProgress({ ...state, connected: false }, report).next, 0);
  state.state.provider.configured = false; state.state.agent = null;
  assert.equal(setupProgress(state, report).next, 1);
  state.state.provider.configured = true;
  assert.equal(setupProgress(state, report).next, 2);
  state.state.agent = snapshot().state.agent; state.state.agent.verified = 'FAIL';
  assert.equal(setupProgress(state, report).next, 2);
  state.state.agent.verified = true;
  assert.equal(setupProgress(state).next, 3); assert.equal(setupProgress(state).ready, false);
  assert.equal(setupProgress(state, readyReport(state)).ready, true);
  for (const field of ['connection', 'runtime', 'model', 'timechain', 'proof']) {
    const blocked = readyReport(state); blocked.checks[field].ready = false;
    assert.equal(setupProgress(state, blocked).ready, false, field);
  }
  for (const invalid of [{ setupReady: true }, { ...readyReport(state), version: 2 }]) assert.equal(setupProgress(state, invalid).ready, false);
});

test('context reflects authority, model and chain changes without serializing credentials or local paths', () => {
  const state = snapshot(); state.state.provider.apiKey = secret; state.token = secret; state.state.agent.root = 'C:\\private\\agent';
  const baseline = setupContext(state);
  assert.equal(baseline.includes(secret), false); assert.equal(baseline.includes('private'), false);
  for (const change of [s => s.generation++, s => { s.connected = false; }, s => { s.state.agent.id = 'different'; },
    s => { s.state.agent.head.hash = 'c'.repeat(64); }, s => { s.state.agent.locked = true; },
    s => { s.state.provider.model = 'another'; }, s => { s.state.provider.tier = 'native'; },
    s => { s.state.executionRuntime.enforcementHealthy = false; }, s => { s.state.cognition.mode = 'dormant'; },
    s => { s.state.executionRuntime.running = false; }, s => { s.state.executionRuntime.healthy = false; },
    s => { s.state.executionRuntime.version = 'different-runtime'; }, s => { s.state.agent.paused = true; },
    s => { s.state.canonicalSkill.commit = 'd'.repeat(40); }, s => { s.state.canonicalSkill.origin = 'packaged-fallback'; },
    s => { s.state.canonicalSkill.immutableTurnSnapshot = false; }]) {
    const changed = structuredClone(state); change(changed); assert.notEqual(setupContext(changed), baseline);
  }
});

test('readiness projections distinguish configuration from tested provider credentials and suppress unrelated secret fields', () => {
  const report = readyReport(snapshot()); report.apiKey = secret; report.checks.model.apiKey = secret;
  report.checks.model.connectionTested = true;
  const rows = setupCheckRows(report);
  assert.match(rows.find(row => row.label === 'Model selected').detail, /credentials not tested/i);
  assert.equal(JSON.stringify(rows).includes(secret), false);
  report.checks.runtime.running = false; report.checks.runtime.ready = false;
  assert.match(setupCheckRows(report)[1].detail, /stopped/i);
  report.checks.model.ready = false;
  assert.match(setupCheckRows(report)[2].detail, /check your model connection/i);
  report.checks.timechain.error = 'CHAIN_LOCKED'; report.checks.timechain.ready = false;
  assert.match(setupCheckRows(report)[3].detail, /recovery hold/i);
});

test('the installed local guide opens once, clones downloads and can be dismissed and resumed without storage or inference', async t => {
  const storage = { getItem() { throw new Error('No setup storage reads'); }, setItem() { throw new Error('No setup storage writes'); } };
  for (const name of ['localStorage', 'sessionStorage']) { const descriptor = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { configurable: true, value: storage }); t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]); }
  const current = snapshot(); current.connected = false; current.state.provider = { configured: false }; current.state.agent = null;
  const f = fixture({ initial: current }); f.controls.start();
  assert.equal(f.id('setupDialog').open, true); assert.match(f.id('setupProgressText').textContent, /Step 1/);
  assert.equal(f.id('setupNext').disabled, true); assert.equal(f.id('step-3').disabled, true);
  assert.deepEqual(f.id('setupDownloads').querySelectorAll('a').map(link => link.href), f.downloads.querySelectorAll('a').map(link => link.href));
  assert.notEqual(f.id('setupDownloads').children[0], f.downloads);
  await f.id('setupLater').fire(); await f.flush(); assert.equal(f.controls.active, false);
  f.controls.start(); f.controls.update(); assert.equal(f.id('setupDialog').open, false);
  f.controls.open(); assert.equal(f.id('setupDialog').open, true); assert.equal(f.calls.length, 0);
  const remote = fixture({ initial: { ...current, local: false } }); remote.controls.start();
  assert.equal(remote.id('setupDialog').open, false); remote.controls.open(); assert.equal(remote.id('setupDialog').open, true);
});

test('model and chain forms return to the first unfinished guide step and cannot skip missing prerequisites', async () => {
  const initial = snapshot(); initial.state.provider = { configured: false }; initial.state.agent = null;
  const f = fixture({ initial }); f.controls.open();
  assert.match(f.id('setupProgressText').textContent, /Step 2/);
  await f.id('step-3').fire(); assert.match(f.id('setupProgressText').textContent, /Step 2/);
  await f.id('setupModelAction').fire(); await f.flush();
  assert.equal(f.id('modelDialog').open, true); assert.equal(f.id('setupDialog').open, false); assert.equal(f.controls.active, true);
  f.change(s => { s.state.provider = snapshot().state.provider; });
  f.id('modelDialog').close(); await f.flush(); assert.match(f.id('setupProgressText').textContent, /Step 3/);
  await f.id('setupExistingChain').fire(); await f.flush(); assert.equal(f.id('existingDialog').open, true);
  f.change(s => { s.state.agent = snapshot().state.agent; });
  f.id('existingDialog').close(); await f.flush();
  assert.equal(f.id('setupDialog').open, true); assert.match(f.id('setupProgressText').textContent, /Step 4/);
  assert.equal(f.calls.length, 0, 'returning from a form does not submit a model request or claim readiness');
  await f.id('setupCheck').fire(); assert.equal(f.id('setupFinish').disabled, false);
});

for (const [button, dialog] of [['setupNewChain', 'genesisDialog'], ['setupAdvancedPair', 'pairDialog']]) {
  test(`${button} delegates the current form and returns after cancellation`, async () => {
    const f = fixture(); f.controls.open(); await f.id(button).fire(); await f.flush();
    assert.equal(f.id(dialog).open, true); assert.equal(f.id('setupDialog').open, false);
    f.id(dialog).close(); await f.flush(); assert.equal(f.id('setupDialog').open, true);
    assert.equal(f.calls.length, 0); assert.equal(f.id('setupFinish').disabled, true);
  });
}

test('readiness is a payload-free GET and finishing only prepares a message after explicit user action', async () => {
  const f = fixture(); f.controls.open(); await f.id('setupCheck').fire();
  assert.deepEqual(f.calls, [['/api/setup/readiness']]);
  assert.equal(f.actionCalls.length, 0); assert.equal(f.id('setupFinish').disabled, false);
  assert.match(f.id('setupReadyNote').textContent, /first message will test provider access/i);
  assert.match(f.id('setupCheckList').textContent, /credentials not tested/i);
  await f.id('setupFirstMessage').fire(); await f.flush();
  assert.deepEqual(f.actionCalls, [{ action: 'finish', prepareIntroduction: true }]);
  assert.equal(f.id('setupDialog').open, false); assert.equal(f.calls.length, 1);
});

test('model connection problems and chain recovery holds expose relevant repair controls without completing setup', async () => {
  let response;
  const f = fixture({ api: async () => response }); f.controls.open();
  response = readyReport(f.current); response.setupReady = false; response.checks.model.ready = false;
  await f.id('setupCheck').fire(); assert.equal(f.id('setupFinish').disabled, true);
  assert.equal(f.id('setupRepairModel').hidden, false); assert.match(f.id('setupCheckList').textContent, /check your model connection/i);
  response = readyReport(f.current); response.setupReady = false; response.checks.timechain.ready = false; response.checks.timechain.error = 'CHAIN_LOCKED';
  await f.id('setupCheck').fire(); assert.equal(f.id('setupFinish').disabled, true);
  assert.equal(f.id('setupRepairRuntime').hidden, false); assert.match(f.id('setupCheckList').textContent, /recovery hold/i);
  await f.id('setupRepairRuntime').fire(); await f.flush(); assert.deepEqual(f.actionCalls, [{ action: 'settings' }]);
});

test('malformed and failed readiness replies render a generic recovery message without raw errors or secrets', async () => {
  for (const reply of [() => { throw new Error(secret + ' https://private.invalid/key'); }, () => ({ version: 2, setupReady: true })]) {
    const f = fixture({ api: async () => reply() }); f.controls.open(); await f.id('setupCheck').fire();
    assert.equal(f.id('setupFinish').disabled, true); assert.ok(f.id('setupError').textContent.length > 0);
    assert.equal(f.text().includes(secret), false); assert.equal(f.text().includes('private.invalid'), false);
    assert.equal(f.id('setupCheck').disabled, false);
  }
});

test('agent and model labels are rendered as bounded text rather than interpreted markup', async () => {
  const initial = snapshot(); initial.state.agent.name = '<img src=x onerror=alert(1)>';
  initial.state.provider.model = '<script>model</script>';
  const f = fixture({ initial }); f.controls.open(); await f.id('setupCheck').fire();
  assert.match(f.id('setupCheckList').textContent, /<img src=x/);
  assert.equal(f.id('setupDialog').querySelectorAll('img').length, 0);
  assert.equal(f.id('setupDialog').querySelectorAll('script').length, 0);
});

const contextChanges = [
  ['authenticated session', s => s.generation++], ['connection', s => { s.connected = false; }],
  ['agent', s => { s.state.agent.id = 'agent-two'; }], ['head', s => { s.state.agent.head.hash = 'd'.repeat(64); }],
  ['model', s => { s.state.provider.model = 'another'; }], ['tier', s => { s.state.provider.tier = 'native'; }],
  ['PoI runtime health', s => { s.state.executionRuntime.enforcementHealthy = false; }],
  ['runtime backend', s => { s.state.executionRuntime.backend = 'direct'; }],
  ['runtime running state', s => { s.state.executionRuntime.running = false; }],
  ['runtime health', s => { s.state.executionRuntime.healthy = false; }],
  ['runtime version', s => { s.state.executionRuntime.version = 'different'; }],
  ['canonical commit', s => { s.state.canonicalSkill.commit = 'f'.repeat(40); }],
  ['canonical origin', s => { s.state.canonicalSkill.origin = 'packaged-fallback'; }],
  ['canonical snapshot policy', s => { s.state.canonicalSkill.immutableTurnSnapshot = false; }],
  ['paused chain', s => { s.state.agent.paused = true; }],
];
for (const [name, change] of contextChanges) {
  test(`pending readiness cannot complete a changed ${name}`, async () => {
    const wait = deferred(), f = fixture({ api: () => wait.promise }), original = structuredClone(f.current);
    f.controls.open(); const pending = f.id('setupCheck').fire();
    f.change(change); wait.resolve(readyReport(original)); await pending; await f.flush();
    assert.equal(f.id('setupFinish').disabled, true); assert.equal(f.actionCalls.length, 0);
  });
}

for (const [name, change] of [
  ['agent ID', r => { r.checks.timechain.agentId = 'agent-other'; }],
  ['head hash', r => { r.checks.timechain.headHash = 'e'.repeat(64); }],
  ['provider', r => { r.checks.model.provider = 'another-provider'; }],
  ['model', r => { r.checks.model.model = 'another-model'; }],
  ['tier', r => { r.checks.model.tier = 'free'; }],
]) {
  test(`readiness for a different server ${name} cannot enable finish`, async () => {
    const f = fixture({ api: () => { const report = readyReport(f.current); change(report); return report; } });
    f.controls.open(); await f.id('setupCheck').fire();
    assert.equal(f.id('setupFinish').disabled, true); assert.ok(f.id('setupError').textContent);
  });
}

test('dismissing and reopening invalidates old readiness replies and cannot clear a newer busy check', async () => {
  const first = deferred(), second = deferred(); let call = 0;
  const f = fixture({ api: () => ++call === 1 ? first.promise : second.promise }); f.controls.open();
  const old = f.id('setupCheck').fire(); f.controls.dismiss(); await f.flush();
  f.controls.open(); const current = f.id('setupCheck').fire();
  first.resolve(readyReport(f.current)); await old;
  assert.equal(f.id('setupCheck').disabled, true); assert.equal(f.id('setupFinish').disabled, true);
  second.resolve(readyReport(f.current)); await current; assert.equal(f.id('setupFinish').disabled, false);
  assert.equal(f.calls.length, 2);
});

test('a stale saved-agent action cannot overwrite the reopened guide or its newer readiness result', async () => {
  const selection = deferred(), readiness = deferred();
  const f = fixture({ selectAgent: () => selection.promise, api: () => readiness.promise });
  f.controls.open(); f.id('setupSavedAgents').value = 'agent-two';
  const old = f.id('setupSelectSaved').fire(); f.controls.dismiss(); await f.flush();
  f.controls.open(); const current = f.id('setupCheck').fire();
  selection.reject(new Error(secret)); await old;
  assert.equal(f.id('setupCheck').disabled, true); assert.equal(f.id('setupError').textContent, '');
  readiness.resolve(readyReport(f.current)); await current; assert.equal(f.id('setupFinish').disabled, false);
  assert.equal(f.text().includes(secret), false);
});

test('finish rechecks the captured context instead of using a readiness result from a different current chain', async () => {
  const f = fixture(); f.controls.open(); await f.id('setupCheck').fire(); assert.equal(f.id('setupFinish').disabled, false);
  f.change(s => { s.state.agent.head.hash = 'f'.repeat(64); }, false);
  await f.id('setupFinish').fire(); await f.flush();
  assert.equal(f.actionCalls.length, 0); assert.equal(f.id('setupFinish').disabled, true);
});

test('a ready report expires after sixty seconds and cannot finish or prepare a message until checked again', async () => {
  const f = fixture(); f.controls.open(); await f.id('setupCheck').fire();
  f.advance(59_999); assert.equal(f.id('setupFinish').disabled, false);
  f.advance(1, false); await f.id('setupFirstMessage').fire(); await f.flush();
  assert.equal(f.id('setupFinish').disabled, true); assert.equal(f.actionCalls.length, 0);
  assert.equal(f.calls.length, 1, 'expiry never sends an automatic inference or readiness request');
  await f.id('setupCheck').fire(); assert.equal(f.id('setupFinish').disabled, false); assert.equal(f.calls.length, 2);
});

test('reopening a dismissed guide cannot restore an expired success flag', async () => {
  const f = fixture(); f.controls.open(); await f.id('setupCheck').fire(); f.controls.dismiss(); await f.flush();
  f.advance(60_001); f.controls.open();
  assert.equal(f.id('setupFinish').disabled, true); assert.equal(f.id('setupFirstMessage').disabled, true);
  assert.equal(f.calls.length, 1);
});

test('setup markup keeps the dialog labels, all four steps and inert finish buttons available before JavaScript', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<dialog id="setupDialog"[^>]*aria-labelledby="setupTitle"[^>]*aria-describedby="setupSubtitle"/);
  assert.equal((html.match(/data-setup-step="[0-3]"/g) || []).length, 4);
  assert.equal((html.match(/data-setup-panel="[0-3]"/g) || []).length, 4);
  for (const id of ['setupFinish', 'setupFirstMessage']) assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*disabled`));
  for (const id of ['setupTitle', 'setupSubtitle', 'setupDialog', 'setupCheck', 'setupSavedAgents']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
});
