import test from 'node:test';
import assert from 'node:assert/strict';
import { mountNativeChannelSetup, nativeChannelCredentialName, nativeChannelCredentialTarget } from '../public/native-channel-setup.js';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.checked = false; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  async fire(name) { await this.handlers[name]?.({ preventDefault() {} }); }
  set innerHTML(_value) { throw new Error('Untrusted markup insertion'); }
}
const nodes = node => [node, ...node.children.flatMap(nodes)];
const channel = overrides => ({ id: 'discovered-chat', label: '<script>native integration</script>', description: 'A runtime discovered integration.', pluginId: 'native.plugin', installed: true, enabled: true, configured: true,
  defaultAccountId: 'default', supportsAccounts: true, schema: { type: 'object', properties: { enabled: { type: 'boolean' }, botToken: { type: 'string' } } },
  accountSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, botToken: { type: 'string' } } },
  accounts: [{ accountId: 'default', configured: true, running: false, connected: false, values: { enabled: true }, configPath: ['channels', 'discovered-chat'] }],
  capabilities: { start: true, stop: true, logout: true, pairing: true, webLogin: true }, webLoginAvailability: 'native-check',
  credentialFields: [{ path: ['channels', 'discovered-chat', 'botToken'], target: '/channels/discovered-chat/botToken', label: 'Bot token', required: true, configured: true, sensitive: true },
    { path: ['channels', 'discovered-chat', 'accounts', '*', 'botToken'], target: '/channels/discovered-chat/accounts/*/botToken', label: 'Account token', required: true, sensitive: true }], ...overrides });
function fixture({ save = async () => ({}), action = async () => ({}), ...initial } = {}) {
  const document = { createElement: tag => new Node(tag) }, mount = new Node('section'), saves = [], actions = [], errors = []; let saved = 0, owner = 1;
  const controller = mountNativeChannelSetup({ document, mount, items: [channel()], context: () => owner,
    onSave: async value => { saves.push(value); return save(value); }, onAction: async value => { actions.push(value); return action(value); }, onSaved: () => saved++, onError: value => errors.push(value), ...initial });
  return { mount, controller, saves, actions, errors, nodes: () => nodes(mount), input: label => nodes(mount).find(node => node.attributes['aria-label'] === label), button: label => nodes(mount).find(node => node.tagName === 'button' && node.textContent === label),
    changeOwner() { owner++; controller.reset(); }, get saved() { return saved; } };
}

test('runtime integration metadata is text only; real typed configuration and dedicated secrets reach separate facade fields', async () => {
  const f = fixture({ baseHash: 'base-config-hash' });
  assert.ok(f.nodes().some(node => node.textContent === '<script>native integration</script>')); assert.equal(f.nodes().some(node => node.tagName === 'script'), false);
  const enabled = f.input('enabled'); enabled.checked = false; await enabled.fire('change');
  const key = f.input('Credential Bot token'); key.value = 'fixture-secret-never-in-overlay';
  await f.button('Save native channel configuration').fire('click');
  assert.equal(f.saves.length, 1); const saved = f.saves[0];
  assert.deepEqual(saved.values, { enabled: false }); assert.equal(saved.channelId, 'discovered-chat'); assert.equal(saved.accountId, 'default'); assert.equal(saved.baseHash, 'base-config-hash');
  assert.equal(saved.secretValues[0].target, '/channels/discovered-chat/botToken'); assert.match(saved.secretValues[0].name, /^channel_[a-f0-9]{56}$/); assert.equal(saved.secretValues[0].value, 'fixture-secret-never-in-overlay');
  assert.equal(key.value, ''); assert.equal(f.saved, 1); assert.doesNotMatch(JSON.stringify(saved.values), /fixture-secret/);
  assert.equal(f.nodes().some(node => node.textContent.includes('fixture-secret')), false);
});

test('custom accounts preserve literal dots in pointer targets and use collision-resistant distinct credential bindings', async () => {
  const f = fixture(); const account = f.input('Native channel account'); account.value = '__new__'; await account.fire('change');
  f.input('New native account ID').value = 'alice.bot'; await f.input('New native account ID').fire('change');
  assert.equal(f.input('Credential Bot token'), undefined);
  const key = f.input('Credential Account token'); key.value = 'new-account-fixture';
  await f.button('Save native channel configuration').fire('click');
  assert.equal(f.saves[0].accountId, 'alice.bot'); assert.equal(f.saves[0].secretValues[0].target, '/channels/discovered-chat/accounts/alice.bot/botToken');
  assert.notEqual(await nativeChannelCredentialName('/channels/discovered-chat/accounts/a/botToken'), await nativeChannelCredentialName('/channels/discovered-chat/accounts/b/botToken'));
  assert.equal(nativeChannelCredentialTarget({ path: ['channels', 'discovered-chat', 'accounts', '*', 'botToken'] }, { channelId: 'discovered-chat', accountId: 'a/b~c' }), '/channels/discovered-chat/accounts/a~1b~0c/botToken');
  assert.throws(() => nativeChannelCredentialTarget({ target: '/channels/wrong/token' }, { channelId: 'discovered-chat', accountId: 'a' }));
});

test('a nested native default account uses its own schema and exact credential metadata over wildcard templates', async () => {
  const selected = channel({ defaultAccountId: 'alice.bot', accounts: [{ accountId: 'alice.bot', configPath: ['channels', 'discovered-chat', 'accounts', 'alice.bot'], schema: { type: 'object', properties: { customSetting: { type: 'integer' } } }, values: { customSetting: 3 }, configured: true }], credentialFields: [
    { path: ['channels', 'discovered-chat', 'accounts', '*', 'botToken'], label: 'Wildcard token', required: true },
    { path: ['channels', 'discovered-chat', 'accounts', 'alice.bot', 'botToken'], label: 'Existing token', configured: true, required: true },
  ] });
  const f = fixture({ items: [selected] }); assert.ok(f.input('customSetting')); assert.equal(f.input('Credential Wildcard token'), undefined);
  assert.ok(f.input('Credential Existing token'));
  await f.button('Save native channel configuration').fire('click'); assert.equal(f.saves.length, 1); assert.equal(f.saves[0].accountId, 'alice.bot');
});

test('lifecycle, native pairing approval, and web-login use exact facade operations with no raw RPC/session data', async () => {
  const f = fixture({ action: async value => value.action === 'pairing-list' ? { requests: [{ requestId: 'request-1', channel: 'discovered-chat', accountId: 'default', senderId: '<img sender>' }] } :
    value.action === 'web-login-start' ? { challengeId: 'opaque-local-challenge', connected: false, qrDataUrl: 'data:image/png;base64,YQ==', message: 'Scan locally' } : { connected: true } });
  await f.button('Start channel').fire('click'); assert.deepEqual(f.actions[0], { action: 'start', channelId: 'discovered-chat', accountId: 'default' });
  await f.button('Review pairing requests').fire('click'); assert.ok(f.nodes().some(node => node.textContent === '<img sender>'));
  await f.button('Approve pairing').fire('click'); assert.deepEqual(f.actions[2], { action: 'pairing-approve', channelId: 'discovered-chat', accountId: 'default', requestId: 'request-1', notify: false });
  await f.button('Check native web login').fire('click'); assert.ok(f.nodes().some(node => node.tagName === 'img' && node.src === 'data:image/png;base64,YQ=='));
  await f.button('Check login completion').fire('click'); assert.deepEqual(f.actions.at(-1), { action: 'web-login-wait', channelId: 'discovered-chat', accountId: 'default', challengeId: 'opaque-local-challenge', timeoutMs: 1000 });
  assert.equal(f.actions.some(value => Object.hasOwn(value, 'sessionKey')), false);
});

test('missing required credentials and uninstalled plugins do not submit and unsafe QR URLs are not rendered', async () => {
  const f = fixture({ items: [channel({ credentialFields: [{ path: ['channels', 'discovered-chat', 'botToken'], label: 'Token', required: true }] })] });
  await f.button('Save native channel configuration').fire('click'); assert.equal(f.saves.length, 0); assert.match(f.errors.at(-1), /Enter Token/);
  f.controller.render({ items: [channel({ installed: false })] }); assert.equal(f.button('Save native channel configuration').disabled, true);
  await f.button('Save native channel configuration').fire('click'); assert.equal(f.saves.length, 0);
  const badQr = fixture({ action: async () => ({ challengeId: 'opaque', qrDataUrl: 'javascript:alert(1)' }) });
  await badQr.button('Check native web login').fire('click'); assert.equal(badQr.nodes().some(node => node.tagName === 'img'), false);
});

test('stale account/context responses cannot render login data or apply saved state to another owner', async () => {
  let release; const f = fixture({ action: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.button('Check native web login').fire('click'); f.changeOwner(); release({ challengeId: 'stale', qrDataUrl: 'data:image/png;base64,YQ==' }); await pending;
  assert.equal(f.nodes().some(node => node.tagName === 'img'), false);
  let complete; const save = fixture({ save: () => new Promise(resolve => { complete = resolve; }) });
  const pendingSave = save.button('Save native channel configuration').fire('click'); save.changeOwner(); complete({ applied: true }); await pendingSave;
  assert.equal(save.saved, 0); assert.equal(save.button('Save native channel configuration').disabled, true);
});

test('explicit multiline credential mode retains exact private text, bounds bytes, and clears after save or owner reset', async () => {
  const f = fixture(), multiline = f.input('Use multiline credential Bot token'), textarea = f.input('Multiline credential Bot token');
  assert.equal(textarea.hidden, true); multiline.checked = true; await multiline.fire('change'); assert.equal(textarea.hidden, false);
  const pem = '-----BEGIN PRIVATE KEY-----\nfixture line one\r\nfixture line two\n-----END PRIVATE KEY-----\n'; textarea.value = pem;
  await f.button('Save native channel configuration').fire('click'); assert.equal(f.saves[0].secretValues[0].value, pem); assert.equal(textarea.value, '');
  assert.equal(f.nodes().some(node => node.textContent.includes(pem)), false);
  textarea.value = 'é'.repeat(8193); await f.button('Save native channel configuration').fire('click'); assert.equal(f.saves.length, 1); assert.match(f.errors.at(-1), /16 KiB/); assert.equal(textarea.value, '');
  textarea.value = pem; f.changeOwner(); assert.equal(textarea.value, '');
});

test('passive account-health polling preserves typed settings and credentials instead of erasing onboarding', async () => {
  const f = fixture({ baseHash: 'unchanged-native-config', contextKey: 'owner-agent' });
  const enabled = f.input('enabled'); enabled.checked = false; await enabled.fire('change');
  const credential = f.input('Credential Bot token'); credential.value = 'private-in-progress-credential';
  f.controller.render({ items: [channel({ accounts: [{ accountId: 'default', connected: true, running: true, configured: true, values: { enabled: true }, configPath: ['channels', 'discovered-chat'] }] })], baseHash: 'unchanged-native-config', contextKey: 'owner-agent' });
  assert.equal(f.input('Credential Bot token'), credential); assert.equal(credential.value, 'private-in-progress-credential'); assert.equal(f.input('enabled').checked, false);
  assert.ok(f.nodes().some(node => node.textContent.includes('Connected: yes')));
  await f.button('Save native channel configuration').fire('click'); assert.deepEqual(f.saves[0].values, { enabled: false }); assert.equal(f.saves[0].secretValues[0].value, 'private-in-progress-credential');
});

test('changed native configuration blocks a preserved channel draft until an explicit reload', async () => {
  const f = fixture({ baseHash: 'old-native-config', onRefresh: async () => ({ items: [channel()], baseHash: 'new-native-config' }) });
  f.input('enabled').checked = false; await f.input('enabled').fire('change');
  f.controller.render({ baseHash: 'new-native-config' }); assert.equal(f.button('Save native channel configuration').disabled, true);
  await f.button('Save native channel configuration').fire('click'); assert.equal(f.saves.length, 0); assert.match(f.errors.at(-1), /Native configuration changed/);
  await f.button('Refresh native integrations').fire('click'); assert.equal(f.button('Save native channel configuration').disabled, false);
  await f.button('Save native channel configuration').fire('click'); assert.equal(f.saves[0].baseHash, 'new-native-config'); assert.deepEqual(f.saves[0].values, {});
});
