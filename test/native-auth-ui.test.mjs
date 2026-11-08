import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeAuthorizationURL, nativeAuthStatusView, nativeWizardView, nativeWizardAnswer,
  nativeProviderConfiguration, mountNativeAuth } from '../public/native-auth.js';

const secret = 'synthetic-native-secret-123456';
const status = () => ({ providers: [{ provider: 'fixture', displayName: 'Fixture', status: 'missing', apiKey: secret,
  profiles: [{ profileId: 'fixture:local', type: 'api_key', status: 'static', logoutSupported: true, apiKey: secret }] }],
  providerCapabilities: [{ provider: 'fixture', apiKeySupported: true, loginOptions: [{ id: 'fixture-plugin/oauth-choice',
    brandId: 'not-the-choice-id', label: '<img>Sign in</img>', kind: 'device-code', hint: 'Installed option.' }] }] });

test('native auth metadata uses actual installed login IDs and never copies credential fields', () => {
  const view = nativeAuthStatusView(status());
  assert.equal(view.capabilities[0].loginOptions[0].id, 'fixture-plugin/oauth-choice');
  assert.equal(JSON.stringify(view).includes(secret), false);
  assert.equal(JSON.stringify(view).includes('not-the-choice-id'), false);
  assert.equal(view.providers[0].profiles[0].logoutSupported, true);
  for (const url of ['javascript:alert(1)', 'data:text/html,unsafe', 'http://provider.example', 'https://user:password@provider.example', 'bad']) assert.equal(nativeAuthorizationURL(url), null);
  assert.equal(nativeAuthorizationURL('https://provider.example/authorize?client_id=public'), 'https://provider.example/authorize?client_id=public');
});

test('wizard projection bounds step types, keeps typed options, suppresses sensitive prefill and raw errors', () => {
  const view = nativeWizardView({ sessionId: 'synthetic-session', done: false, error: secret, step: {
    id: 'secret-step', type: 'text', title: 'A native step', message: '<script>literal</script>', sensitive: true,
    initialValue: secret, externalUrl: 'javascript:unsafe', unexpected: secret,
  } });
  assert.equal(view.answerRejected, true); assert.equal(view.step.externalUrl, null);
  assert.equal(JSON.stringify(view).includes(secret), false);
  const choose = nativeWizardView({ step: { id: 'choice', type: 'select', options: [{ label: 'Typed choice', value: { mode: 1, enabled: true } }] } }).step;
  assert.deepEqual(nativeWizardAnswer(choose, { mode: 1, enabled: true }), { stepId: 'choice', value: { mode: 1, enabled: true } });
  assert.throws(() => nativeWizardAnswer(choose, '0'));
  assert.deepEqual(nativeWizardAnswer({ id: 'note', type: 'note' }), { stepId: 'note' });
  assert.equal(nativeWizardAnswer({ id: 'progress', type: 'progress' }), undefined);
  assert.deepEqual(nativeWizardAnswer({ id: 'yes', type: 'confirm' }, false), { stepId: 'yes', value: false });
  assert.throws(() => nativeWizardAnswer({ id: 'yes', type: 'confirm' }, 'false'));
  assert.equal(nativeWizardView({ step: { id: 'future', type: 'execute-command' } }).step, null);
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
  const controls = mountNativeAuth({ document: doc, mount, context: () => owner, createSessionId: () => 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee',
    api: async (...args) => { calls.push(structuredClone(args)); return handler(...args); }, onBusy: value => busy.push(value), onUpdated: async () => { updated++; } });
  return { mount, calls, busy, controls, get updated() { return updated; },
    button: label => descendants(mount).find(node => node.tagName === 'button' && node.textContent === label),
    input: label => descendants(mount).find(node => node.tagName === 'label' && node.textContent === label)?.children.find(node => ['input', 'textarea'].includes(node.tagName)),
    changeOwner() { owner++; controls.sync(); } };
}
const wizardResult = (id, type, patch = {}) => ({ done: false, status: 'running', step: { id, type, ...patch } });

test('actual auth controls send native key actions only and clear the password without reading saved connections', async () => {
  const f = fixture(async (_url, payload) => payload ? { profileId: 'fixture:local' } : status());
  await f.controls.refresh();
  f.input('Native provider ID').value = 'fixture'; f.input('New native API key · never prefilled').value = secret;
  await f.button('Store key in native OpenClaw').fire();
  assert.deepEqual(f.calls.at(-1), ['/api/openclaw/auth', { action: 'key', provider: 'fixture', apiKey: secret }]);
  assert.equal(f.input('New native API key · never prefilled').value, ''); assert.equal(f.updated, 1);
  assert.equal(descendants(f.mount).some(node => node.textContent.includes(secret)), false);
  assert.deepEqual(f.busy, [true, false]);
});

test('installed wizard flows preserve step IDs and typed answers, with safe links and no echoed password errors', async () => {
  const f = fixture(async (_url, payload) => {
    if (!payload) return status();
    if (payload.action === 'login') return { sessionId: payload.sessionId, ...wizardResult('note-1', 'note', { message: '<script>literal</script>' }) };
    if (payload.action === 'next' && payload.answer?.stepId === 'note-1') return wizardResult('secret-1', 'text', { title: 'Native secret', sensitive: true, initialValue: secret });
    if (payload.action === 'next' && payload.answer?.stepId === 'secret-1') return { error: secret, ...wizardResult('choice-1', 'select', {
      title: 'Choose', externalUrl: 'https://provider.example/device', deviceCode: { code: 'SYNTHETIC', expiresInMinutes: 5 },
      options: [{ label: 'A typed native option', value: { enabled: true } }] }) };
    if (payload.action === 'next' && payload.answer?.stepId === 'choice-1') return wizardResult('confirm-1', 'confirm', { message: 'Continue setup?' });
    if (payload.action === 'next' && payload.answer?.stepId === 'confirm-1') return { done: true, status: 'done' };
    throw new Error('Unexpected synthetic operation');
  });
  await f.controls.refresh(); await f.button('<img>Sign in</img>').fire();
  assert.deepEqual(f.calls.at(-1)[1], { action: 'login', authChoice: 'fixture-plugin/oauth-choice', sessionId: 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee' });
  assert.equal(descendants(f.mount).some(node => node.tagName === 'img' || node.tagName === 'script'), false);
  await f.button('Continue').fire(); const password = f.input('Native secret'); assert.equal(password.type, 'password'); assert.equal(password.value, '');
  password.value = secret; await f.button('Submit native answer').fire();
  assert.deepEqual(f.calls.at(-1)[1].answer, { stepId: 'secret-1', value: secret }); assert.equal(password.value, '');
  assert.equal(descendants(f.mount).some(node => node.textContent.includes(secret)), false);
  const link = descendants(f.mount).find(node => node.tagName === 'a'); assert.equal(link.href, 'https://provider.example/device'); assert.equal(link.rel, 'noopener noreferrer');
  await f.button('A typed native option').fire(); assert.deepEqual(f.calls.at(-1)[1].answer, { stepId: 'choice-1', value: { enabled: true } });
  await f.button('No').fire(); assert.deepEqual(f.calls.at(-1)[1].answer, { stepId: 'confirm-1', value: false }); assert.equal(f.updated, 1);
});

test('cancel status stays truthful and stale or closed auth sessions cannot populate another owner view', async () => {
  let cancelCount = 0;
  const f = fixture(async (_url, payload) => !payload ? status() : payload.action === 'login'
    ? { sessionId: payload.sessionId, ...wizardResult('wait', 'progress', { message: 'Waiting' }) }
    : { status: ++cancelCount === 1 ? 'running' : 'cancelled' });
  await f.controls.refresh(); await f.button('<img>Sign in</img>').fire(); await f.button('Cancel native sign-in').fire();
  assert.ok(descendants(f.mount).some(node => /still running/.test(node.textContent)));
  await f.button('Cancel native sign-in').fire(); assert.ok(descendants(f.mount).some(node => node.textContent === 'Native sign-in cancelled.'));
  let release; const late = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = late.controls.refresh(); late.changeOwner(); release(status()); await pending;
  assert.equal(late.button('<img>Sign in</img>'), undefined); assert.deepEqual(late.busy, []);
});

test('multiselect values, progress polls and manual action acknowledgements follow the native wizard wire format', async () => {
  const f = fixture(async (_url, payload) => {
    if (!payload) return status();
    if (payload.action === 'login') return { sessionId: payload.sessionId, ...wizardResult('multi', 'multiselect', {
      options: [{ label: 'First', value: 7 }, { label: 'Second', value: { option: 'second' } }] }) };
    if (payload.answer?.stepId === 'multi') return wizardResult('manual', 'action', { executor: 'client', message: 'Complete the provider step yourself.' });
    if (payload.answer?.stepId === 'manual') return wizardResult('waiting', 'progress', { executor: 'gateway' });
    return { done: true, status: 'done' };
  });
  await f.controls.refresh(); await f.button('<img>Sign in</img>').fire();
  const checkbox = descendants(f.mount).find(node => node.tagName === 'label' && node.children.some(child => child.textContent === 'Second')).children[0];
  checkbox.checked = true; await f.button('Submit selected options').fire();
  assert.deepEqual(f.calls.at(-1)[1].answer, { stepId: 'multi', value: [{ option: 'second' }] });
  await f.button('I completed this native step').fire(); assert.deepEqual(f.calls.at(-1)[1].answer, { stepId: 'manual' });
  await f.button('Check progress').fire(); assert.deepEqual(f.calls.at(-1)[1], { action: 'next', sessionId: 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee' });
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
  await f.button('Remove saved sign-in · fixture:local').fire();
  assert.deepEqual(f.calls.at(-1)[1], { action: 'logout', provider: 'fixture', profileIds: ['fixture:local'] });
});

test('a failed wizard start retains explicit status and cancellation recovery without leaking its failure body', async () => {
  const f = fixture(async (_url, payload) => {
    if (!payload) return status();
    if (payload.action === 'login') throw new Error(secret);
    if (payload.action === 'cancel') return { status: 'cancelled' };
    return { status: 'running' };
  });
  await f.controls.refresh(); await f.button('<img>Sign in</img>').fire();
  assert.ok(f.button('Check sign-in status')); assert.ok(f.button('Cancel native sign-in'));
  assert.equal(descendants(f.mount).some(node => node.textContent.includes(secret)), false);
  await f.button('Cancel native sign-in').fire(); assert.ok(descendants(f.mount).some(node => node.textContent === 'Native sign-in cancelled.'));
});
