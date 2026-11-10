import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeAuthStatusView, nativeProviderConfiguration, mountNativeAuth } from '../public/native-auth.js';

const secret = 'synthetic-native-secret-123456';
const status = () => ({
  providers: [
    { provider: 'fixture', displayName: 'Fixture', apiKey: secret, profiles: [
      { profileId: 'fixture:local', type: 'api_key', status: 'static', logoutSupported: true, apiKey: secret },
      { profileId: 'fixture:retired', type: 'oauth', logoutSupported: true },
    ] },
    { provider: 'only-login', profiles: [{ profileId: 'only-login:retired', type: 'token', logoutSupported: true }] },
  ],
  providerCapabilities: [
    { provider: 'fixture', apiKeySupported: true, loginOptions: [{ id: 'fixture/retired-option', label: '<img>Sign in</img>' }] },
    { provider: 'only-login', apiKeySupported: false, loginOptions: [{ id: 'only-login/retired-option' }] },
  ],
});

test('native credential metadata exposes API keys only and discards credential values and other login options', () => {
  const view = nativeAuthStatusView(status());
  assert.deepEqual(view.capabilities, ['fixture']);
  assert.deepEqual(view.providers, [{ provider: 'fixture', name: 'Fixture',
    profiles: [{ id: 'fixture:local', name: 'fixture:local', status: 'static', logoutSupported: true }] }]);
  assert.doesNotMatch(JSON.stringify(view), new RegExp(secret + '|retired|only-login'));
});

test('nonsecret provider JSON preserves native schema values but rejects credential keys, auth URLs and expansions', () => {
  const configuration = { api: 'installed-native-api', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'fixture-model', contextWindow: 8192 }] };
  assert.deepEqual(nativeProviderConfiguration('custom-provider', JSON.stringify(configuration)), { provider: 'custom-provider', configuration });
  for (const unsafe of [{ apiKey: secret }, { headers: { Authorization: secret } }, { headers: { 'X-API-KEY': secret } },
    { baseUrl: 'https://user:password@provider.example' }, { baseUrl: 'https://provider.example?api_key=secret' }, { nested: { password: secret } }]) {
    assert.throws(() => nativeProviderConfiguration('fixture', JSON.stringify(unsafe)), { code: 'SECRET_IN_NATIVE_CONFIG' });
  }
  for (const source of ['[]', '{} invalid', '{"value":"${ENV}"}', '{"__proto__":{"bad":true}}']) assert.throws(() => nativeProviderConfiguration('fixture', source));
  assert.throws(() => nativeProviderConfiguration('chainchat-free', '{}'));
});

class Node {
  constructor(tag) { this.tagName = tag; this.textContent = ''; this.children = []; this.handlers = {}; this.attributes = {}; this.dataset = {}; this.value = ''; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tagName === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
  async fire(name = 'click', event = {}) { await this.handlers[name]?.(event); }
  click() { return this.fire(); }
  set innerHTML(_value) { throw new Error('Native auth must never insert markup'); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
function fixture(handler = async () => status()) {
  const mount = new Node('section'), calls = [], busy = []; let owner = 1, updated = 0;
  const doc = { createElement: tag => new Node(tag), getElementById() { throw new Error('Never read another connection field'); } };
  const controls = mountNativeAuth({ document: doc, mount, context: () => owner,
    api: async (...args) => { calls.push(structuredClone(args)); return handler(...args); }, onBusy: value => busy.push(value), onUpdated: async () => { updated++; } });
  return { mount, calls, busy, controls, get updated() { return updated; },
    button: label => descendants(mount).find(node => node.tagName === 'button' && node.textContent === label),
    input: label => descendants(mount).find(node => node.tagName === 'label' && node.textContent === label)?.children.find(node => ['input', 'textarea'].includes(node.tagName)),
    changeOwner() { owner++; controls.sync(); } };
}
test('actual auth controls send native key actions only and clear the password without reading saved connections', async () => {
  const f = fixture(async (_url, payload) => payload ? { profileId: 'fixture:local' } : status());
  await f.controls.refresh();
  f.input('Native provider ID').value = 'fixture'; f.input('New native API key').value = secret;
  await f.button('Store key in native OpenClaw').fire();
  assert.deepEqual(f.calls.at(-1), ['/api/openclaw/auth', { action: 'key', provider: 'fixture', apiKey: secret }]);
  assert.equal(f.input('New native API key').value, ''); assert.equal(f.updated, 1);
  assert.equal(descendants(f.mount).some(node => node.textContent.includes(secret)), false);
  assert.deepEqual(f.busy, [true, false]);
});

test('custom provider and saved-profile controls use their dedicated nonsecret payloads', async () => {
  const f = fixture(async (_url, payload) => payload ? { ok: true } : status());
  await f.controls.refresh(); f.input('Custom provider ID').value = 'custom-provider';
  f.input('Configuration validated against OpenClaw’s provider schema').value = '{"api":"installed-native-api","models":[{"id":"fixture"}]}';
  await f.button('Validate & save native provider').fire();
  assert.deepEqual(f.calls.at(-1), ['/api/openclaw/providers', { provider: 'custom-provider', configuration: { api: 'installed-native-api', models: [{ id: 'fixture' }] } }]);
  const previous = f.calls.length;
  f.input('Configuration validated against OpenClaw’s provider schema').value = JSON.stringify({ headers: { Authorization: secret } });
  await f.button('Validate & save native provider').fire(); assert.equal(f.calls.length, previous);
  assert.equal(f.input('Configuration validated against OpenClaw’s provider schema').value, '{}');
  await f.button('Remove saved key · fixture:local').fire();
  assert.deepEqual(f.calls.at(-1)[1], { action: 'logout', provider: 'fixture', profileIds: ['fixture:local'] });
});

test('old login options never become controls and a stale key status response cannot populate a new owner view', async () => {
  const f = fixture();
  await f.controls.refresh();
  assert.equal(f.button('<img>Sign in</img>'), undefined);
  assert.equal(f.button('Remove saved key · fixture:retired'), undefined);
  assert.equal(descendants(f.mount).some(node => node.tagName === 'a' || node.tagName === 'img'), false);
  assert.deepEqual(f.calls, [['/api/openclaw/auth', undefined]]);

  let release;
  const late = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = late.controls.refresh();
  late.changeOwner();
  release(status()); await pending;
  assert.equal(late.button('Remove saved key · fixture:local'), undefined);
  assert.deepEqual(late.busy, []);
});
