import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeCapabilityCatalogue, nativeCapabilityPayload, mountNativeCapabilityCard, schemaFamilies } from '../public/openclaw-settings.js';

const rows = [
  { name: 'sessions_spawn', description: '<img src=x onerror=alert(1)>', source: 'native', available: true },
  { name: 'native.custom-tool', description: 'A discovered extension.', source: 'native', available: true },
  { name: 'read', description: 'Separate file scope.', source: 'native', available: true },
  { name: 'offline_tool', source: 'native', available: false },
];
const grant = patch => ({ enabled: true, acknowledged: true, tools: ['sessions_spawn'], settingsText: 'agents.defaults.timeoutSeconds', delegatedRuns: true, backgroundRuns: false, ...patch });

test('native capabilities admit only discovered available extra tools and explicit bounded setting paths', () => {
  assert.deepEqual(nativeCapabilityPayload(grant(), rows), { enabled: true, acknowledged: true, tools: ['sessions_spawn'],
    settings: ['agents.defaults.timeoutSeconds'], delegatedRuns: true, backgroundRuns: false });
  assert.deepEqual(nativeCapabilityPayload(grant({ allSettings: true }), rows).settings, ['*']);
  for (const patch of [{ acknowledged: false }, { tools: ['read'] }, { tools: ['unknown'] }, { tools: ['offline_tool'] },
    { tools: ['sessions_spawn', 'sessions_spawn'] }, { settingsText: '*' }, { settingsText: '__proto__.field' },
    { settingsText: 'agents..defaults' }, { settingsText: 'same.path\nsame.path' }]) assert.throws(() => nativeCapabilityPayload(grant(patch), rows));
  assert.deepEqual(nativeCapabilityCatalogue([...rows, { name: '<script>', source: 'native', available: true }, rows[0],
    { name: 'plugin_tool', source: 'plugin', available: true }]).map(row => row.name), rows.map(row => row.name));
  assert.equal(nativeCapabilityCatalogue(rows).find(row => row.name === 'read').scopedHostTool, true);
  const sections = schemaFamilies({ properties: { agents: {} } }, {}, [{ key: 'agents', classification: 'owner-admitted', reason: 'Exact admitted paths only.' }]);
  assert.equal(sections[0].classification, 'owner-admitted'); assert.equal(sections[0].protected, false);
});

class Node {
  constructor(tag, document) { this.tagName = tag; this.document = document; this.children = []; this.handlers = {}; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.checked = false; this.disabled = false; }
  set id(value) { this._id = value; this.document.ids.set(value, this); }
  get id() { return this._id; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  async fire(name) { await this.handlers[name]?.({ preventDefault() {} }); }
  // Dynamic metadata must never be interpreted as markup.
  set innerHTML(_value) { throw new Error('Unsafe markup insertion'); }
}
function fixture({ api = async () => ({toolAuthority:{grant:{nativeCapabilities:{}}},catalogue:rows}) } = {}) {
  const doc = { ids: new Map(), createElement(tag) { return new Node(tag, this); } };
  const mount = doc.createElement('section'), calls = [], errors = []; let saved = 0, owner = 1;
  const controller = mountNativeCapabilityCard({ document: doc, mount, api: async (...args) => { calls.push(args); return api(...args); },
    onSaved: async () => { saved++; }, onError: value => errors.push(value), context: () => owner });
  return { doc, mount, calls, errors, controller, get saved() { return saved; }, changeOwner() { owner++; controller.reset(); },
    get: id => doc.ids.get(id) };
}
const snapshot = patch => ({ sessionKey: 'synthetic-selected-agent', nativeToolCatalogue: rows, toolAuthority: { grant: { nativeCapabilities: {
  enabled: false, acknowledged: false, tools: [], settings: [], delegatedRuns: false, backgroundRuns: false } } }, ...patch });
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test('native card renders only discovered names as text and submits the exact six-field owner grant', async () => {
  const f = fixture(); f.controller.render(snapshot());
  const nodes = descendants(f.mount), choice = name => nodes.find(node => node.dataset.nativeExtraTool === name);
  assert.ok(nodes.some(node => node.textContent === '<img src=x onerror=alert(1)>'));
  assert.equal(nodes.some(node => node.tagName === 'img'), false);
  assert.equal(choice('read').disabled, true); assert.equal(choice('offline_tool').disabled, true);
  f.get('nativeCapabilitiesEnabled').checked = true; choice('sessions_spawn').checked = true;
  f.get('nativeCapabilitiesAcknowledged').checked = true; f.get('nativeDelegatedRuns').checked = true;
  f.get('nativeSettingPaths').value = 'agents.defaults.timeoutSeconds';
  await f.get('nativeCapabilityForm').fire('submit');
  assert.deepEqual(f.calls, [['/api/openclaw/native-capabilities', { enabled: true, acknowledged: true, tools: ['sessions_spawn'],
    settings: ['agents.defaults.timeoutSeconds'], delegatedRuns: true, backgroundRuns: false }]]);
  assert.equal(f.saved, 1);
  assert.doesNotMatch(f.get('nativeCapabilityStatus').textContent, /running|executed|unrestricted access/i);
});

test('native grant needs acknowledgement, revocation clears every field, and disconnected or stale responses cannot re-enable it', async () => {
  const f = fixture(); f.controller.render(snapshot()); f.get('nativeCapabilitiesEnabled').checked = true;
  await f.get('nativeCapabilityForm').fire('submit'); assert.equal(f.calls.length, 0); assert.match(f.errors.at(-1), /Acknowledge/);
  await f.get('revokeNativeCapabilities').fire('click');
  assert.deepEqual(f.calls[0][1], { enabled: false, acknowledged: false, tools: [], settings: [], delegatedRuns: false, backgroundRuns: false });
  f.controller.reset(); await f.get('nativeCapabilityForm').fire('submit'); assert.equal(f.calls.length, 1); assert.equal(f.get('saveNativeCapabilities').disabled, true);
  let release;
  const late = fixture({ api: () => new Promise(resolve => { release = resolve; }) });
  late.controller.render(snapshot());
  const pending = late.get('revokeNativeCapabilities').fire('click'); late.changeOwner();
  release({toolAuthority:{grant:{nativeCapabilities:{enabled:true,tools:['sessions_spawn']}}},catalogue:rows}); await pending;
  assert.equal(late.saved, 0); assert.equal(late.get('saveNativeCapabilities').disabled, true); assert.equal(late.get('nativeCapabilitiesEnabled').checked, false);
});
