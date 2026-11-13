import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeChannels} from '../lib/native-channels.mjs';
import {nativeSecretTargets} from '../lib/native-secrets.mjs';

const clone = value => structuredClone(value);
const pointer = parts => '/' + parts.map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
const schema = {schema: {type: 'object', properties: {channels: {type: 'object', properties: {
  defaults: {type: 'object'},
  telegram: {type: 'object', properties: {enabled: {type: 'boolean'}, dmPolicy: {type: 'string', enum: ['pairing', 'disabled']}, botToken: {type: 'string', writeOnly: true},
    opaque: {type: 'string'}, accounts: {type: 'object', additionalProperties: {type: 'object', properties: {enabled: {type: 'boolean'}, botToken: {type: 'string', writeOnly: true}, dmPolicy: {type: 'string'}}}}}},
  discord: {type: 'object', properties: {token: {type: 'string', writeOnly: true}, accounts: {type: 'object', additionalProperties: {type: 'object', properties: {token: {type: 'string', writeOnly: true}, enabled: {type: 'boolean'}}}}}},
  future_chat: {type: 'object', properties: {enabled: {type: 'boolean'}}},
}}}}, uiHints: {'channels.telegram.opaque': {sensitive: true, label: 'Dedicated credential'}, 'channels.telegram.accounts.*.botToken': {sensitive: true}}};
function targets(config) {
  const output = [];
  for (const [name, value] of Object.entries(config.channels || {})) {
    if (name === 'telegram') for (const key of ['botToken', 'opaque']) output.push({target: pointer(['channels', name, key]), path: ['channels', name, key], label: key});
    for (const accountId of Object.keys(value.accounts || {})) {
      const key = name === 'discord' ? 'token' : 'botToken', path = ['channels', name, 'accounts', accountId, key];
      output.push({target: pointer(path), path, label: key});
    }
  }
  return output;
}
function fixture(overrides = {}) {
  const state = {
    config: {channels: {telegram: {enabled: true, dmPolicy: 'pairing', botToken: 'synthetic-top-secret', opaque: 'synthetic-opaque-secret'},
      discord: {accounts: {'alice.bot': {enabled: true, token: 'synthetic-alice-secret'}, bob: {enabled: true, token: 'synthetic-bob-secret'}}}}},
    hash: 'config-1', catalogue: {generation: 1, plugins: [
      {id: 'telegram-plugin', name: 'Telegram', channelIds: ['telegram'], installed: true, enabled: true, runtime: {state: 'active'}},
      {id: 'discord-plugin', name: 'Discord', channelIds: ['discord'], installed: true, enabled: true, runtime: {state: 'active'}},
      {id: 'future-plugin', name: 'Future Chat', channelIds: ['future_chat'], installed: false, enabled: false},
    ]}, status: {channelMeta: [{id: 'telegram', label: 'Telegram'}, {id: 'discord', label: 'Discord'}], channelAccounts: {
      telegram: [{accountId: 'default', configured: true, running: true, connected: true, lastError: 'oc_sk_SYNTHETICDO_NOT_REVEAL'}],
      discord: [{accountId: 'alice.bot', configured: true, running: true}, {accountId: 'bob', configured: true}],
    }, channelDefaultAccountId: {telegram: 'default', discord: 'alice.bot'}},
    requests: [{channel: 'telegram', accountId: 'default', requestId: 'request-a', senderId: 'sender-a'},
      {channel: 'discord', accountId: 'bob', requestId: 'request-b', senderId: 'sender-b'}],
    calls: [], reviews: [], applies: [], deny: false, time: 1000,
  };
  const rpc = async (method, params) => {
    state.calls.push({method, params: clone(params)});
    if (method === 'channels.status') return clone(state.status);
    if (method === 'channels.pairing.list') return {accounts: [], requests: clone(state.requests), commandOwnerConfigured: false, limits: {pendingPerAccount: 3, ttlMs: 1000}};
    if (method === 'web.login.start') return {sessionKey: 'native-private-session', qrDataUrl: 'data:image/png;base64,YWJj', message: 'Scan this QR code'};
    if (method === 'web.login.wait') return {connected: true, message: 'Connected'};
    if (method.startsWith('channels.pairing.')) return {requestId: params.requestId, senderId: 'sender-a', notification: 'not-requested'};
    return {ok: true, token: 'synthetic-native-secret'};
  };
  const api = createNativeChannels({rpc: overrides.rpc ? (method, params) => overrides.rpc(method, params, state, rpc) : rpc,
    schema: async () => clone(overrides.schema || schema), config: async () => ({config: clone(state.config), hash: state.hash}), plugins: async () => clone(state.catalogue),
    authorize: async intent => {state.reviews.push(clone(intent)); if (overrides.authorize) return overrides.authorize(intent, state); return !state.deny;},
    applyConfig: async value => {state.applies.push(clone(value)); if (overrides.applyConfig) return overrides.applyConfig(value, state);},
    secrets: {targets: overrides.targets || targets, redact: value => value.replace(/synthetic-[a-z-]+/g, '[redacted]')}, now: () => state.time});
  return {state, api};
}
const errorCode = code => error => error.code === code;

test('native channel catalogue discovers every declared channel and uses safe schema/account metadata', async () => {
  const {api, state} = fixture(), snapshot = await api.snapshot();
  assert.deepEqual(snapshot.items.map(row => row.id), ['discord', 'future_chat', 'telegram']);
  assert.equal(snapshot.items.find(row => row.id === 'future_chat').installed, false);
  const telegram = snapshot.items.find(row => row.id === 'telegram');
  assert.equal(telegram.webLoginAvailability, 'native-check'); assert.equal(telegram.capabilities.webLogin, true);
  assert.equal(telegram.accounts[0].values.botToken, undefined); assert.equal(telegram.accounts[0].values.opaque, undefined);
  assert.equal(telegram.schema.properties.botToken.type, 'string');
  assert.equal(telegram.credentialFields.some(row => row.target === '/channels/telegram/botToken'), true);
  assert.equal(telegram.credentialFields.some(row => row.target === '/channels/telegram/accounts/*/botToken'), true);
  const account = snapshot.items.find(row => row.id === 'discord').accounts.find(row => row.accountId === 'alice.bot');
  assert.deepEqual(account.configPath, ['channels', 'discord', 'accounts', 'alice.bot']); assert.deepEqual(account.values, {enabled: true});
  const encoded = JSON.stringify(snapshot); for (const secret of ['synthetic-top-secret', 'synthetic-opaque-secret', 'synthetic-alice-secret', 'oc_sk_SYNTHETIC']) assert.equal(encoded.includes(secret), false);
  assert.deepEqual(state.calls.map(row => row.method), ['channels.status']); assert.equal(state.reviews.length, 0);
});

test('future native plugin additions appear without hardcoded Telegram/Discord lists', async () => {
  const {api, state} = fixture(); state.catalogue.plugins.push({id: 'new-plugin', name: 'New platform', channelIds: ['new_platform'], installed: true, enabled: true});
  state.status.channelAccounts.new_platform = [{accountId: 'default', configured: true}];
  const item = (await api.snapshot()).items.find(row => row.id === 'new_platform'); assert.ok(item); assert.equal(item.capabilities.start, true);
});

test('managed setup binds credentials to exact account and never reviews or returns their raw values', async () => {
  const {api, state} = fixture();
  await api.save({channelId: 'discord', accountId: 'alice.bot', values: {enabled: false}, secretValues: [{name: 'alice-token', target: '/channels/discord/accounts/alice.bot/token', value: 'synthetic-new-token', remember: false}], baseHash: 'config-1'});
  assert.deepEqual(state.applies[0].patch, {channels: {discord: {accounts: {'alice.bot': {enabled: false}}}}});
  assert.equal(state.applies[0].secrets[0].value, 'synthetic-new-token');
  assert.equal(JSON.stringify(state.reviews).includes('synthetic-new-token'), false);
  assert.equal(state.reviews[0].operation, 'channels.configure'); assert.equal(state.reviews[0].accountId, 'alice.bot');
  assert.equal(state.calls.some(row => row.method.startsWith('config.') || row.method.startsWith('wizard.')), false);
});

test('new account setup supports schema-generated write-only credentials', async () => {
  const {api, state} = fixture();
  await api.save({channelId: 'telegram', accountId: 'fresh.bot', values: {enabled: true, dmPolicy: 'pairing'}, secretValues: [{name: 'fresh-bot', target: '/channels/telegram/accounts/fresh.bot/botToken', value: 'new-secret'}]});
  assert.deepEqual(state.applies[0].patch.channels.telegram.accounts['fresh.bot'], {enabled: true, dmPolicy: 'pairing'});
});

test('setup rejects cross-account/channel credentials, raw secret fields, hidden wildcard credentials and placeholders', async () => {
  const {api, state} = fixture();
  for (const input of [
    {values: {token: 'secret'}}, {values: {accounts: {bob: {token: 'secret'}}}}, {values: {enabled: '[redacted]'}},
    {values: {}, secretValues: [{name: 'other', target: '/channels/discord/accounts/bob/token', value: 'secret'}]},
    {values: {}, secretValues: [{name: 'other', target: '/channels/telegram/botToken', value: 'secret'}]},
    {values: {}, secretValues: [{name: '../../path', target: '/channels/discord/accounts/alice.bot/token', value: 'secret'}]},
  ]) await assert.rejects(api.save({channelId: 'discord', accountId: 'alice.bot', ...input}), errorCode('OPENCLAW_CHANNEL_INVALID'));
  await assert.rejects(api.save({channelId: 'telegram', accountId: 'default', values: {opaque: 'secret'}}));
  await assert.rejects(api.save({channelId: 'telegram', accountId: 'new', values: {botToken: 'secret'}}));
  assert.equal(state.applies.length, 0); assert.equal(state.reviews.length, 0);
});

test('setup rejects inherited keys, unknown fields, stale hashes and non-installed plugins', async () => {
  const {api, state} = fixture();
  for (const value of [{channelId: 'future_chat', accountId: 'default', values: {}}, {channelId: 'telegram', accountId: 'default', values: {}, baseHash: 'old'},
    {channelId: 'telegram', accountId: 'default', values: JSON.parse('{"__proto__":{"polluted":true}}')},
    {channelId: 'telegram', accountId: 'default', values: {}, method: 'config.patch'}]) await assert.rejects(api.save(value));
  assert.equal(state.applies.length, 0); assert.equal({}.polluted, undefined);
});

test('every lifecycle operation uses exact native RPC and requires owner/PoI admission', async () => {
  const {api, state} = fixture();
  for (const action of ['start', 'stop', 'logout']) {
    const result = await api.action({action, channelId: 'discord', accountId: 'alice.bot'});
    assert.equal(result.ok, true); assert.equal(result.channelId, 'discord'); assert.equal(result.accountId, 'alice.bot'); assert.equal(result.action, action);
    assert.deepEqual(state.calls.findLast(row => row.method === 'channels.' + action).params, {channel: 'discord', accountId: 'alice.bot'});
  }
  assert.deepEqual(state.reviews.map(row => row.operation), ['channels.start', 'channels.stop', 'channels.logout']);
  state.deny = true; await assert.rejects(api.action({action: 'stop', channelId: 'discord', accountId: 'alice.bot'}), errorCode('OPENCLAW_CHANNEL_DENIED'));
  assert.equal(state.calls.filter(row => row.method === 'channels.stop').length, 1);
});

test('unknown RPCs, unexpected params, omitted/defaulted accounts and cross-account changes are rejected', async () => {
  const {api, state} = fixture();
  for (const value of [{action: 'config.patch', channelId: 'telegram', accountId: 'default'}, {action: 'start', channelId: 'telegram'},
    {action: 'start', channelId: 'telegram', accountId: 'missing'}, {action: 'start', channelId: 'telegram', accountId: 'default', params: {channel: 'discord'}},
    {action: 'start', channelId: 'telegram', accountId: 'default', force: true}]) await assert.rejects(api.action(value));
  assert.equal(state.reviews.length, 0);
});

test('config/plugin changes while admission is pending invalidate the action', async () => {
  const {api, state} = fixture({authorize: (_intent, state) => {state.hash = 'config-2'; return true;}});
  await assert.rejects(api.action({action: 'start', channelId: 'telegram', accountId: 'default'}), errorCode('OPENCLAW_CHANNEL_STALE'));
  assert.equal(state.calls.some(row => row.method === 'channels.start'), false);
});

test('supervisor admission can revoke a pending native action before execution', async () => {
  const {api, state} = fixture({authorize: () => ({approved: true, assertCurrent: () => {throw new Error('halted');}})});
  await assert.rejects(api.action({action: 'start', channelId: 'telegram', accountId: 'default'}), /halted/);
  assert.equal(state.calls.some(row => row.method === 'channels.start'), false);
});

test('pairing list is account-filtered, and approvals use exact pending request with notify off by default', async () => {
  const {api, state} = fixture(), listed = await api.action({action: 'pairing-list', channelId: 'telegram', accountId: 'default'});
  assert.deepEqual(listed.requests.map(row => row.requestId), ['request-a']); assert.equal(state.reviews.length, 0);
  await api.action({action: 'pairing-approve', channelId: 'telegram', accountId: 'default', requestId: 'request-a'});
  assert.deepEqual(state.calls.find(row => row.method === 'channels.pairing.approve').params, {channel: 'telegram', accountId: 'default', requestId: 'request-a', notify: false, bootstrapCommandOwner: false});
  await assert.rejects(api.action({action: 'pairing-dismiss', channelId: 'telegram', accountId: 'default', requestId: 'request-b'}), errorCode('OPENCLAW_CHANNEL_PAIRING_STALE'));
  await assert.rejects(api.action({action: 'pairing-approve', channelId: 'telegram', accountId: 'default', code: 'CLI-CODE'}));
});

test('pairing notification/bootstrap intent is explicit, and disappearing requests cannot be approved', async () => {
  const {api, state} = fixture();
  await api.action({action: 'pairing-approve', channelId: 'telegram', accountId: 'default', requestId: 'request-a', notify: true, bootstrapCommandOwner: true});
  assert.equal(state.reviews[0].details.notify, true); assert.equal(state.reviews[0].details.bootstrapCommandOwner, true);
  const stale = fixture({authorize: (_intent, state) => {state.requests = []; return true;}});
  await assert.rejects(stale.api.action({action: 'pairing-dismiss', channelId: 'telegram', accountId: 'default', requestId: 'request-a'}), errorCode('OPENCLAW_CHANNEL_PAIRING_STALE'));
  assert.equal(stale.state.calls.some(row => row.method === 'channels.pairing.dismiss'), false);
});

test('web login challenge hides native session keys and binds wait to exact account', async () => {
  const {api, state} = fixture();
  const started = await api.action({action: 'web-login-start', channelId: 'discord', accountId: 'alice.bot'});
  assert.ok(started.challengeId); assert.equal(started.qrDataUrl, 'data:image/png;base64,YWJj'); assert.equal(started.sessionKey, undefined);
  await assert.rejects(api.action({action: 'web-login-wait', channelId: 'discord', accountId: 'bob', challengeId: started.challengeId}), errorCode('OPENCLAW_CHANNEL_LOGIN_STALE'));
  const result = await api.action({action: 'web-login-wait', channelId: 'discord', accountId: 'alice.bot', challengeId: started.challengeId, timeoutMs: 0});
  assert.equal(result.connected, true);
  assert.deepEqual(state.calls.find(row => row.method === 'web.login.wait').params, {channel: 'discord', accountId: 'alice.bot', timeoutMs: 0, sessionKey: 'native-private-session', currentQrDataUrl: 'data:image/png;base64,YWJj'});
  assert.equal(state.reviews.length, 2); assert.equal(JSON.stringify(state.reviews).includes('native-private-session'), false); assert.equal(JSON.stringify(state.reviews).includes('data:image'), false);
  await assert.rejects(api.action({action: 'web-login-wait', channelId: 'discord', accountId: 'alice.bot', challengeId: started.challengeId}), errorCode('OPENCLAW_CHANNEL_LOGIN_STALE'));
});

test('web login cannot accept caller native session/QR, expired challenge, unbounded wait or arbitrary fields', async () => {
  const {api, state} = fixture(); const started = await api.action({action: 'web-login-start', channelId: 'telegram', accountId: 'default'});
  for (const extra of [{sessionKey: 'attacker'}, {currentQrDataUrl: 'data:image/png;base64,YWJj'}, {timeoutMs: 30001}, {verbose: true}])
    await assert.rejects(api.action({action: 'web-login-wait', channelId: 'telegram', accountId: 'default', challengeId: started.challengeId, ...extra}));
  state.time += 5 * 60 * 1000 + 1;
  await assert.rejects(api.action({action: 'web-login-wait', channelId: 'telegram', accountId: 'default', challengeId: started.challengeId}), errorCode('OPENCLAW_CHANNEL_LOGIN_STALE'));
});

test('unsupported native login reports a safe error and does not leak native error credentials', async () => {
  const {api} = fixture({rpc: (method, params, state, original) => {if (method === 'web.login.start') throw new Error('unsupported oc_sk_PRIVATE_SECRET_CREDENTIAL'); return original(method, params);}});
  await assert.rejects(api.action({action: 'web-login-start', channelId: 'telegram', accountId: 'default'}), error => error.code === 'OPENCLAW_CHANNEL_REQUEST_FAILED' && !error.message.includes('PRIVATE_SECRET'));
});

test('explicit native capability metadata controls discovery instead of provider-specific assumptions', async () => {
  const {api, state} = fixture(); state.catalogue.channelCapabilities = {telegram: {webLogin: false, logout: false, pairing: false}, discord: {gatewayMethods: ['web.login.start', 'web.login.wait']}};
  const snapshot = await api.snapshot(), telegram = snapshot.items.find(row => row.id === 'telegram'), discord = snapshot.items.find(row => row.id === 'discord');
  assert.equal(telegram.capabilities.webLogin, false); assert.equal(discord.webLoginAvailability, 'verified');
  await assert.rejects(api.action({action: 'logout', channelId: 'telegram', accountId: 'default'}), errorCode('OPENCLAW_CHANNEL_UNSUPPORTED'));
});


test('real secret descriptor helper discovers required fields for fresh accounts and preserves literal account dots', async () => {
  const {api, state} = fixture({targets: nativeSecretTargets});
  const snapshot = await api.snapshot(), discord = snapshot.items.find(row => row.id === 'discord');
  assert.ok(discord.credentialFields.some(row => row.target === '/channels/discord/accounts/alice.bot/token'));
  assert.ok(discord.credentialFields.some(row => row.target === '/channels/discord/accounts/*/token'));
  await api.save({channelId: 'discord', accountId: 'new.bot', values: {enabled: true}, secretValues: [{name: 'new-discord', target: '/channels/discord/accounts/new.bot/token', value: 'new-discord-secret'}]});
  assert.equal(state.applies[0].secrets[0].target, '/channels/discord/accounts/new.bot/token');
});

test('subtree schemas resolve native local refs, retain account shape and reject obscure sensitive fields', async () => {
  const referenced = clone(schema);
  referenced.schema.$defs = {Telegram: clone(referenced.schema.properties.channels.properties.telegram)};
  referenced.schema.properties.channels.properties.telegram = {$ref: '#/$defs/Telegram'};
  referenced.schema.$defs.Telegram.properties.cryptic = {type: 'string', format: 'password'};
  const {api, state} = fixture({schema: referenced, targets: nativeSecretTargets}); state.config.channels.telegram.cryptic = 'synthetic-cryptic-secret';
  const telegram = (await api.snapshot()).items.find(row => row.id === 'telegram');
  assert.equal(telegram.schema.properties.dmPolicy.type, 'string'); assert.equal(telegram.accountSchema.properties.botToken.writeOnly, true);
  assert.equal(telegram.accounts[0].values.cryptic, undefined); assert.equal(JSON.stringify(telegram).includes('synthetic-cryptic-secret'), false);
  await assert.rejects(api.save({channelId: 'telegram', accountId: 'default', values: {cryptic: 'new-secret'}}));
  assert.equal(state.applies.length, 0);
});

test('login waits recheck owner authority after admission and serialize requests against the same account', async () => {
  let calls = 0, active = 0, maximum = 0;
  const {api} = fixture({authorize: () => ({approved: true, assertCurrent: () => {calls++;}}),
    rpc: async (method, params, state, original) => {
      if (method === 'channels.stop') {active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--;}
      return original(method, params);
    }});
  await Promise.all([api.action({action: 'stop', channelId: 'telegram', accountId: 'default'}), api.action({action: 'stop', channelId: 'telegram', accountId: 'default'})]);
  assert.equal(maximum, 1); assert.equal(calls, 4);
});

test('a QR challenge that expires during review is not dispatched even after approval', async () => {
  let reviewingWait = false;
  const {api, state} = fixture({authorize: () => {if (reviewingWait) state.time += 5 * 60 * 1000 + 1; return true;}});
  const started = await api.action({action: 'web-login-start', channelId: 'telegram', accountId: 'default'}); reviewingWait = true;
  await assert.rejects(api.action({action: 'web-login-wait', channelId: 'telegram', accountId: 'default', challengeId: started.challengeId}), errorCode('OPENCLAW_CHANNEL_LOGIN_STALE'));
  assert.equal(state.calls.some(row => row.method === 'web.login.wait'), false);
});


test('incomplete native login polls retain the bound private session without extending expiry', async () => {
  let waits = 0;
  const {api, state} = fixture({rpc: (method, params, state, original) => {
    if (method === 'web.login.wait' && waits++ === 0) return {connected: false, message: 'Still waiting'};
    return original(method, params);
  }});
  const start = await api.action({action: 'web-login-start', channelId: 'telegram', accountId: 'default'});
  state.time += 1000;
  const poll = await api.action({action: 'web-login-wait', channelId: 'telegram', accountId: 'default', challengeId: start.challengeId});
  assert.ok(poll.challengeId); assert.equal(poll.qrDataUrl, start.qrDataUrl); assert.equal(poll.sessionKey, undefined);
  const final = await api.action({action: 'web-login-wait', channelId: 'telegram', accountId: 'default', challengeId: poll.challengeId});
  assert.equal(final.connected, true); assert.equal(final.qrDataUrl, undefined);
  assert.equal(state.calls.find(row => row.method === 'web.login.wait').params.sessionKey, 'native-private-session');
});


test('lifecycle results retain native false states instead of falsely reporting a running or disconnected channel', async () => {
  const {api} = fixture({rpc: (method, params, state, original) => {
    if (method === 'channels.start') return {started: false, token: 'synthetic-secret'};
    if (method === 'channels.stop') return {stopped: false};
    if (method === 'channels.logout') return {cleared: false, loggedOut: false, token: 'synthetic-secret'};
    return original(method, params);
  }});
  const start = await api.action({action: 'start', channelId: 'telegram', accountId: 'default'}); assert.equal(start.ok, false); assert.equal(start.started, false);
  const stop = await api.action({action: 'stop', channelId: 'telegram', accountId: 'default'}); assert.equal(stop.ok, false); assert.equal(stop.stopped, false);
  const logout = await api.action({action: 'logout', channelId: 'telegram', accountId: 'default'});
  assert.equal(logout.ok, false); assert.equal(logout.cleared, false); assert.equal(logout.loggedOut, false); assert.equal(logout.credentialPolicy, 'retained');
  assert.match(logout.message, /did not confirm/); assert.match(logout.message, /remove them there/); assert.equal(JSON.stringify(logout).includes('synthetic-secret'), false);
});

test('a successful native logout reports retained credential policy without removing or reapplying stored tokens', async () => {
  const {api, state} = fixture({rpc: (method, params, state, original) => method === 'channels.logout' ? {cleared: true, loggedOut: true} : original(method, params)});
  const result = await api.action({action: 'logout', channelId: 'telegram', accountId: 'default'});
  assert.equal(result.ok, true); assert.equal(result.loggedOut, true); assert.equal(result.cleared, true); assert.equal(result.credentialPolicy, 'retained');
  assert.equal(state.applies.length, 0); assert.equal(state.config.channels.telegram.botToken, 'synthetic-top-secret');
});
