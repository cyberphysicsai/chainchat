import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { modelCatalogueView } from '../public/chainchat-display.js';

test('the model picker only lists and switches models from the saved personal connection', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function renderModelCatalogue('), end = app.indexOf('async function refreshModelCatalogue(', start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map(), switches = [];
  const $ = id => {
    if (!nodes.has(id)) { const node = new NativeNode('div'); node.value = ''; nodes.set(id, node); }
    return nodes.get(id);
  };
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /data-model-tier|Free models|free-tier/);
  assert.doesNotMatch(html, /ChatGPT|Claude Code|subscription/i);
  assert.match(html, /Connect a model API/);
  const context = { $, modelCatalogueView, modelSwitchBusy: false, modelCatalogueLoading: false, modelCatalogueError: '', requestBusy: false,
    state: { provider: { configured: false } }, lastByokDetails: null, nativeModelPicker: null, nativeAuthControls: null, nativeMediaComposer: null,
    modelCatalogue: { active: { tier: 'free', model: 'old-shared-model' }, tiers: [
      { id: 'free', available: true, models: [{ id: 'old-shared-model', available: true }] },
      { id: 'byok', available: true, models: [{ id: 'vendor/model:free', available: true }] },
    ] },
    el(tag, className, text = '') { const node = new NativeNode(tag); node.className = className; node.textContent = text; return node; },
    switchModel: async (...args) => switches.push(args) };
  vm.createContext(context); vm.runInContext(app.slice(start, end), context);
  context.renderModelCatalogue();
  const [personal] = $('modelCatalogueList').children;
  assert.equal($('modelCatalogueList').children.length, 1);
  assert.equal(personal.attributes['aria-pressed'], 'false');
  assert.equal($('restoreByokModel').classList.contains('hidden'), false);
  await personal.fire();
  assert.deepEqual(switches, [['vendor/model:free']]);
});


test('native model metadata exposes only actual catalogue rows and preserves native active state without any credential fields', async () => {
  const { nativeModelCatalogueView, nativeModelSelection } = await import('../public/model-catalogue.js');
  const raw = { configured: true, current: 'vendor/model', apiKey: 'synthetic-private-value', models: [
    { id: 'vendor/model', name: 'Configured model', available: true, apiKey: 'synthetic-private-value' },
    { id: 'vendor/needs-auth', available: false, reason: 'Configure authentication locally.' }, { id: 'vendor/model', available: true },
    { id: 'bad\nmodel', available: true },
  ] };
  const view = nativeModelCatalogueView(raw);
  assert.equal(view.models.length, 2); assert.equal(view.models[1].available, false);
  assert.equal(JSON.stringify(view).includes('synthetic-private-value'), false);
  const selected = nativeModelSelection({ provider: { provider: 'native', tier: 'native', configured: true,
    model: 'vendor/model', apiKey: 'synthetic-private-value' } }, 'vendor/model');
  assert.deepEqual(selected, { provider: 'native', tier: 'native', configured: true, model: 'vendor/model' });
  assert.throws(() => nativeModelSelection({ provider: { ...selected, provider: 'compatible' } }, selected.model));
  assert.throws(() => nativeModelSelection({ provider: selected }, 'other/model'));
  assert.deepEqual(modelCatalogueView({ active: { tier: 'native', provider: 'native', model: selected.model } }).active,
    { tier: 'native', provider: 'native', model: selected.model });
});

class NativeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.attributes = {}; this.handlers = {};
    const names = new Set(); this.classList = { add: name => names.add(name), remove: name => names.delete(name), contains: name => names.has(name),
      toggle: (name, enabled) => enabled ? names.add(name) : names.delete(name) }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  async fire(name = 'click') { await this.handlers[name]?.(); }
  set innerHTML(_value) { throw new Error('Native metadata must be text'); }
}
function nativeDescendants(node) { return [node, ...node.children.flatMap(nativeDescendants)]; }

test('native picker reads configured models and switches only through the dedicated native endpoint without API keys', async () => {
  const { mountNativeModelPicker } = await import('../public/model-catalogue.js');
  const mount = new NativeNode('section'), calls = [], selected = [], busy = [];
  const doc = { createElement: tag => new NativeNode(tag) };
  const controller = mountNativeModelPicker({ document: doc, mount, api: async (url, payload) => {
    calls.push([url, payload]);
    return payload ? { provider: { provider: 'native', tier: 'native', configured: true, model: payload.model } }
      : { configured: true, current: 'vendor/model', models: [{ id: 'vendor/model', name: '<script>literal</script>', available: true },
        { id: 'vendor/no-auth', available: false, reason: 'Missing local authentication.' }] };
  }, onSelected: provider => selected.push(provider), onBusy: value => busy.push(value) });
  await mount.children[0].fire();
  const nodes = nativeDescendants(mount), available = nodes.find(node => node.tagName === 'button' && node.children.some(child => child.children?.some(item => item.textContent === '<script>literal</script>')));
  assert.ok(available); assert.equal(nodes.some(node => node.tagName === 'script'), false);
  await available.fire();
  assert.deepEqual(calls, [['/api/openclaw/provider', undefined], ['/api/openclaw/provider', { model: 'vendor/model' }]]);
  assert.deepEqual(selected, [{ provider: 'native', tier: 'native', configured: true, model: 'vendor/model' }]);
  assert.deepEqual(busy, [true, false]);
  controller.reset(); assert.equal(selected.length, 1);
});


test('native picker ignores stale owner responses and unavailable models cannot issue selection requests', async () => {
  const { mountNativeModelPicker } = await import('../public/model-catalogue.js');
  let owner = 1, release; const selected = [], calls = [], mount = new NativeNode('section');
  const doc = { createElement: tag => new NativeNode(tag) };
  const controller = mountNativeModelPicker({ document: doc, mount, context: () => owner, onSelected: value => selected.push(value),
    api: (...args) => { calls.push(args); return new Promise(resolve => { release = resolve; }); } });
  const pending = mount.children[0].fire(); owner++; controller.sync();
  release({ configured: true, current: 'vendor/old-model', models: [{ id: 'vendor/old-model', available: true }] }); await pending;
  assert.equal(nativeDescendants(mount).some(node => node.textContent === 'vendor/old-model'), false); assert.equal(selected.length, 0);
  const again = mount.children[0].fire(); release({ models: [{ id: 'vendor/no-auth', available: false }] }); await again;
  const unavailable = nativeDescendants(mount).find(node => node.tagName === 'button' && node.children.some(child => child.children?.some(item => item.textContent === 'vendor/no-auth')));
  assert.ok(unavailable); assert.equal(unavailable.disabled, true); await unavailable.fire();
  assert.equal(calls.length, 2, 'Only the two metadata GET requests were issued.');
});

test('opening native mode keeps saved BYOK details separate and clears the secret input', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function openModel() {'), end = app.indexOf('nativeModelPicker = mountNativeModelPicker(', start);
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, { value: 'old-input' }); return nodes.get(id); };
  const context = { $, state: { provider: { provider: 'native', model: 'native/selected', tier: 'native', configured: true } },
    lastByokDetails: { provider: 'compatible', model: 'saved/byok-model', baseUrl: 'https://provider.example/v1', configured: true },
    nativeModelPicker: { reset() {} }, nativeAuthControls: { reset() {} }, rememberByokProvider() {}, updateProviderPlaceholder() {}, renderOperationControls() {}, renderModelCatalogue() {}, openDialog() {}, refreshModelCatalogue() {} };
  vm.createContext(context); vm.runInContext(app.slice(start, end), context); context.openModel();
  assert.equal($('modelId').value, 'saved/byok-model'); assert.equal($('baseUrl').value, 'https://provider.example/v1');
  assert.equal($('apiKey').value, ''); assert.equal(context.lastByokDetails.model, 'saved/byok-model');
});
