/** Scoped owner controls for native OpenClaw channels; no native wizard writes.
 * RPC shapes follow OpenClaw 2026.11.3 gateway-protocol channel schemas.
 * Credential values travel only through applyConfig.secrets, never the review or snapshot.
 */
import {createHash, randomUUID} from 'node:crypto';
import {assertNoNativeSecrets, isNativeSensitive, nativeSchemaNodes} from './native-config-schema.mjs';

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const fail = (message, code = 'OPENCLAW_CHANNEL_INVALID', status = 400) => Object.assign(new Error(message), {code, status});
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\0\r\n\u2028\u2029]/u.test(value) && !forbidden.has(value);
const channelId = value => id(value) && /^[a-z0-9][a-z0-9_-]*$/u.test(value);
const sensitiveName = /(?:^|[_-])(?:token|password|passphrase|secret|credential|authorization|api[_-]?key|private[_-]?key)(?:$|[_-])/iu;
const sensitiveCamel = /(?:apiKey|botToken|appToken|accessToken|refreshToken|clientSecret|signingSecret|privateKey|password)/u;
const pathPointer = parts => '/' + parts.map(part => String(part).replace(/~/gu, '~0').replace(/\//gu, '~1')).join('/');
const get = (value, parts) => parts.reduce((current, key) => plain(current) && Object.hasOwn(current, key) ? current[key] : undefined, value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => {
  const walk = (current, depth = 0) => {
    if (depth > 40) throw fail('Channel settings exceed the nesting limit.');
    if (current === null || ['string', 'boolean'].includes(typeof current) || typeof current === 'number' && Number.isFinite(current)) return;
    if (!plain(current) && !Array.isArray(current)) throw fail('Channel settings must be JSON.');
    for (const [key, child] of Object.entries(current)) {if (forbidden.has(key)) throw fail('Unsafe channel setting key.'); walk(child, depth + 1);}
  };
  walk(value);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 512 * 1024) throw fail('Channel settings exceed the size limit.');
  return JSON.parse(text);
};
const exactKeys = (value, keys) => {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('Unexpected channel operation fields.');
};
const merge = (base, patch) => {
  const output = plain(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) output[key] = plain(value) ? merge(output[key], value) : clone(value);
  return output;
};
const patchAt = (parts, value) => parts.reduceRight((child, key) => ({[key]: child}), value);
const properties = schema => {
  if (!plain(schema)) return {};
  const result = {...(plain(schema.properties) ? schema.properties : {})};
  for (const branch of [...(schema.allOf || []), ...(schema.anyOf || []), ...(schema.oneOf || [])]) Object.assign(result, properties(branch));
  return result;
};
const accountSchema = schema => {
  const accounts = properties(schema).accounts;
  return plain(accounts?.additionalProperties) ? accounts.additionalProperties : Object.values(accounts?.patternProperties || {}).find(plain);
};
const defaultRedact = value => {
  if (typeof value === 'string') return value.replace(/(?:oc_sk_|sk-(?:proj-|ant-)?)[A-Za-z0-9_-]{8,}/gu, '[redacted]');
  if (Array.isArray(value)) return value.map(defaultRedact);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, typeof child === 'string' && (sensitiveName.test(key) || sensitiveCamel.test(key)) ? '[redacted]' : defaultRedact(child)]));
  return value;
};
const hintedSensitive = (hints, parts) => Object.entries(hints || {}).some(([name, hint]) => {
  const target = name.split('.'); return hint?.sensitive === true && target.length === parts.length && target.every((part, index) => part === '*' || part === parts[index]);
});
const isSensitive = (key, schema, hints, parts) => schema?.sensitive === true || schema?.writeOnly === true ||
  hintedSensitive(hints, parts) || sensitiveName.test(key) || sensitiveCamel.test(key);
const safeValues = (value, schema, hints, parts, envelope) => {
  if (Array.isArray(value)) return value.map((child, index) => safeValues(child, schema?.items, hints, [...parts, String(index)], envelope));
  if (!plain(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isSensitive(key, properties(schema)[key], hints, [...parts, key]) && !isNativeSensitive(envelope, [...parts, key]))
    .map(([key, child]) => [key, safeValues(child, properties(schema)[key], hints, [...parts, key], envelope)]));
};
const checkNoSecrets = (value, schema, hints, parts) => {
  if (Array.isArray(value)) return value.forEach((child, index) => checkNoSecrets(child, schema?.items, hints, [...parts, String(index)]));
  if (typeof value === 'string' && /^(?:\[redacted\]|\*{3,}|\$\{[A-Z_][A-Z0-9_]*\})$/iu.test(value)) throw fail('Credential placeholders cannot be saved as native settings.');
  if (!plain(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const node = properties(schema)[key];
    if (isSensitive(key, node, hints, [...parts, key])) throw fail('Use the dedicated write-only credential fields for channel secrets.');
    checkNoSecrets(child, node, hints, [...parts, key]);
  }
};
const cleanSchema = value => {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!plain(value)) return value;
  const output = Object.fromEntries(Object.entries(value).filter(([key]) => !['default', 'examples'].includes(key)).map(([key, child]) => [key, cleanSchema(child)]));
  return output;
};
const resolvedSchema = (node, root, seen = new Set(), depth = 0) => {
  if (depth > 32) return {};
  if (Array.isArray(node)) return node.map(child => resolvedSchema(child, root, new Set(seen), depth + 1));
  if (!plain(node)) return node;
  let base = {};
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/') && !seen.has(node.$ref)) {
    const next = new Set(seen); next.add(node.$ref);
    const parts = node.$ref.slice(2).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
    base = resolvedSchema(get(root, parts), root, next, depth + 1) || {};
  }
  return {...base, ...Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref').map(([key, child]) => [key, resolvedSchema(child, root, new Set(seen), depth + 1)]))};
};
const flag = (value, key, fallback = false) => typeof value?.[key] === 'boolean' ? value[key] : fallback;
const string = value => typeof value === 'string' ? value.slice(0, 2000) : undefined;
const qr = value => typeof value === 'string' && value.length <= 16384 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(value) ? value : undefined;

/** All injected callbacks are local supervisor functions, never browser-supplied.
 * config() -> {config, hash}; schema() -> native config.schema envelope;
 * plugins() -> native plugins.list envelope, optionally trusted capabilities by channel.
 * authorize(intent) -> true | {approved:true,assertCurrent?}; applyConfig performs
 * managed schema validation, credential staging, apply/readback and rollback.
 */
export function createNativeChannels({rpc, schema, config, plugins, authorize, applyConfig, secrets = {}, now = Date.now}) {
  for (const callback of [rpc, schema, config, plugins, authorize, applyConfig]) if (typeof callback !== 'function') throw new TypeError('Native channel supervisor callbacks are required.');
  const pending = new Map(), scopeLocks = new Map();
  async function scoped(input, run) {
    if (!plain(input) || !channelId(input.channelId) || !id(input.accountId)) throw fail('Choose an exact channel and account.');
    const key = JSON.stringify([input.channelId, input.accountId]), prior = scopeLocks.get(key) || Promise.resolve();
    let release; const tail = new Promise(resolve => {release = resolve;}); scopeLocks.set(key, tail);
    await prior;
    try {return await run();} finally {release(); if (scopeLocks.get(key) === tail) scopeLocks.delete(key);}
  }
  const redact = value => {
    const safe = defaultRedact(value);
    const walk = child => typeof child === 'string' ? typeof secrets.redact === 'function' ? secrets.redact(child) : child :
      Array.isArray(child) ? child.map(walk) : plain(child) ? Object.fromEntries(Object.entries(child).map(([key, nested]) => [key, walk(nested)])) : child;
    return walk(safe);
  };
  async function read() {
    const [schemaEnvelope, configuration, catalogue, status] = await Promise.all([schema(), config(), plugins(), rpc('channels.status', {probe: false})]);
    const cfg = configuration?.config;
    if (!plain(cfg) || !plain(schemaEnvelope) || !plain(catalogue) || !plain(status)) throw fail('Native channel metadata is not ready.', 'OPENCLAW_CHANNEL_UNAVAILABLE', 503);
    const rootSchema = schemaEnvelope.schema || schemaEnvelope;
    const channelSchemas = Object.assign({}, ...nativeSchemaNodes(schemaEnvelope, ['channels']).map(node => properties(node)));
    for (const [name, node] of Object.entries(channelSchemas)) channelSchemas[name] = resolvedSchema(node, rootSchema);
    const hints = schemaEnvelope.uiHints || {};
    const pluginRows = Array.isArray(catalogue.plugins) ? catalogue.plugins : [];
    const metadata = new Map((status.channelMeta || []).filter(row => channelId(row.id)).map(row => [row.id, row]));
    const discovered = new Set([...metadata.keys(), ...Object.keys(status.channelAccounts || {}).filter(channelId)]);
    const owners = new Map();
    for (const plugin of pluginRows) for (const name of plugin.channelIds || []) if (channelId(name)) {discovered.add(name); if (!owners.has(name) || plugin.installed) owners.set(name, plugin);}
    const revision = digest({hash: configuration.hash || digest(cfg), generation: catalogue.generation ?? null, plugins: pluginRows.map(row => [row.id, row.installed, row.enabled, row.runtime?.state, row.channelIds])});
    const context = {schemaEnvelope, cfg, channelSchemas, hints, catalogue, status, owners, revision, baseHash: configuration.hash || null};
    const items = [];
    for (const name of [...discovered].sort()) {
      const plugin = owners.get(name), meta = metadata.get(name), settings = cfg.channels?.[name] || {}, node = channelSchemas[name];
      const installed = plugin ? plugin.installed === true : !!meta;
      const enabled = installed && plugin?.enabled !== false && settings.enabled !== false;
      const live = Array.isArray(status.channelAccounts?.[name]) ? status.channelAccounts[name] : [];
      const defaultId = status.channelDefaultAccountId?.[name] || settings.defaultAccount || 'default';
      const ids = new Set([defaultId, ...Object.keys(settings.accounts || {}), ...live.map(row => row.accountId)]);
      const accountNode = accountSchema(node);
      const accounts = [];
      for (const accountId of ids) {
        if (!id(accountId)) continue;
        const nested = Object.hasOwn(settings.accounts || {}, accountId) || accountId !== defaultId;
        const configPath = nested ? ['channels', name, 'accounts', accountId] : ['channels', name];
        const values = get(cfg, configPath) || {};
        const state = live.find(row => row.accountId === accountId) || {};
        const selectedSchema = nested ? accountNode : node;
        accounts.push({accountId, configPath, configured: state.configured === true, running: state.running === true, connected: state.connected === true,
          enabled: state.enabled !== false, ...(state.lastError ? {lastError: 'Native channel reported an error; inspect local runtime diagnostics.'} : {}),
          schema: cleanSchema(selectedSchema || {}), values: redact(safeValues(Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'accounts')), selectedSchema, hints, configPath, schemaEnvelope))});
      }
      const capability = catalogue.channelCapabilities?.[name] || plugin?.channelCapabilities?.[name] || {};
      const methods = new Set([...(capability.gatewayMethods || []), ...(plugin?.gatewayMethods || [])]);
      const active = installed && enabled;
      const templateAccount = '__chainchat_account_template__';
      const proposed = merge(cfg, {channels: {[name]: {...settings, ...(accountNode ? {accounts: {...settings.accounts, [templateAccount]: {}}} : {})}}});
      const targets = typeof secrets.targets === 'function' ? await secrets.targets(proposed, schemaEnvelope) : [];
      const credentialFields = targets.filter(row => Array.isArray(row.path) && row.path[0] === 'channels' && row.path[1] === name).map(row => ({target: row.target || pathPointer(row.path), path: row.path,
        label: row.label || row.path.at(-1), sensitive: true, required: row.required === true, configured: get(cfg, row.path) !== undefined || row.configured === true}))
        .map(row => row.path.includes(templateAccount) ? {...row, path: row.path.map(part => part === templateAccount ? '*' : part), target: pathPointer(row.path.map(part => part === templateAccount ? '*' : part))} : row);
      const schemaHints = Object.fromEntries(Object.entries(hints).filter(([key]) => key === `channels.${name}` || key.startsWith(`channels.${name}.`)));
      items.push({id: name, label: meta?.label || status.channelLabels?.[name] || plugin?.name || name,
        description: string(plugin?.description) || '', ...(plugin?.id ? {pluginId: plugin.id} : {}), installed, enabled,
        configured: accounts.some(row => row.configured), schema: cleanSchema(node || {}), accountSchema: cleanSchema(accountNode || {}),
        supportsAccounts: !!accountNode, defaultAccountId: defaultId, uiHints: cleanSchema(schemaHints), accounts, credentialFields,
        capabilities: {start: active && flag(capability, 'start', true), stop: active && flag(capability, 'stop', true),
          logout: active && flag(capability, 'logout', true), pairing: active && flag(capability, 'pairing', true),
          webLogin: active && flag(capability, 'webLogin', methods.size ? methods.has('web.login.start') && methods.has('web.login.wait') : true)},
        webLoginAvailability: !active || capability.webLogin === false ? 'unavailable' : capability.webLogin === true || methods.has('web.login.start') && methods.has('web.login.wait') ? 'verified' : 'native-check'});
    }
    return {...context, items};
  }
  const publicSnapshot = state => redact({items: state.items, revision: state.revision, baseHash: state.baseHash});
  const selected = (state, input, allowNew = false) => {
    if (!channelId(input.channelId) || !id(input.accountId)) throw fail('Choose an exact channel and account.');
    const item = state.items.find(row => row.id === input.channelId);
    if (!item || !item.installed) throw fail('Install and enable this discovered native channel before configuring its account.', 'OPENCLAW_CHANNEL_UNAVAILABLE', 409);
    let account = item.accounts.find(row => row.accountId === input.accountId);
    if (!account && allowNew && item.supportsAccounts) account = {accountId: input.accountId, configPath: ['channels', item.id, 'accounts', input.accountId], schema: item.accountSchema};
    if (!account) throw fail('This native channel account is not configured.', 'OPENCLAW_CHANNEL_ACCOUNT_UNKNOWN', 404);
    return {item, account};
  };
  async function admitted(state, intent) {
    const admission = await authorize(Object.freeze(clone(intent)));
    if (admission !== true && admission?.approved !== true) throw fail('This channel action was not admitted.', 'OPENCLAW_CHANNEL_DENIED', 403);
    const next = await read();
    if (next.revision !== state.revision) throw fail('Native channel configuration changed; review the action again.', 'OPENCLAW_CHANNEL_STALE', 409);
    if (typeof admission?.assertCurrent === 'function') await admission.assertCurrent();
    return async () => {if (typeof admission?.assertCurrent === 'function') await admission.assertCurrent();};
  }
  async function save(raw) {
    exactKeys(raw, ['channelId', 'accountId', 'values', 'secretValues', 'baseHash']);
    const input = clone(raw), state = await read(), {item, account} = selected(state, input, true);
    if (!plain(input.values) || Object.hasOwn(input.values, 'accounts')) throw fail('Save only the selected native account settings.');
    if (input.baseHash !== undefined && input.baseHash !== state.baseHash) throw fail('Native configuration changed; reload before saving.', 'OPENCLAW_CHANNEL_STALE', 409);
    checkNoSecrets(input.values, account.schema, state.hints, account.configPath);
    assertNoNativeSecrets(input.values, {schema: state.schemaEnvelope, basePath: account.configPath});
    const patch = patchAt(account.configPath, input.values), proposed = merge(state.cfg, patch);
    const changes = input.secretValues || [];
    if (!Array.isArray(changes) || changes.length > 64) throw fail('Invalid native channel credential bindings.');
    const targets = typeof secrets.targets === 'function' ? await secrets.targets(proposed, state.schemaEnvelope) : [];
    const allowed = new Map(targets.filter(row => Array.isArray(row.path) && row.path.length > account.configPath.length && account.configPath.every((part, i) => row.path[i] === part) &&
      // A top-level default account cannot write another account's credentials.
      row.path[account.configPath.length] !== 'accounts').map(row => [row.target || pathPointer(row.path), row]));
    const names = new Set(), bindings = new Set();
    for (const change of changes) {
      exactKeys(change, ['name', 'target', 'value', 'remember']);
      if (!allowed.has(change.target) || typeof change.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(change.name) || forbidden.has(change.name) || typeof change.value !== 'string' || !change.value || Buffer.byteLength(change.value) > 16384 || change.value.includes('\0') ||
        change.remember !== undefined && typeof change.remember !== 'boolean' || names.has(change.name) || bindings.has(change.target)) throw fail('Use a dedicated credential target for this exact channel account.');
      names.add(change.name); bindings.add(change.target);
    }
    await admitted(state, {operation: 'channels.configure', channelId: item.id, accountId: account.accountId,
      details: {configPath: account.configPath, values: redact(input.values), credentials: changes.map(({name, target, remember}) => ({name, target, remember: remember === true}))}});
    await applyConfig({patch, secrets: changes, baseHash: state.baseHash, reason: 'Native channel account setup', channelId: item.id, accountId: account.accountId});
    return publicSnapshot(await read());
  }
  async function pairing(state, input) {
    const result = await rpc('channels.pairing.list', {channel: input.channelId, accountId: input.accountId});
    return {accounts: (result.accounts || []).filter(row => row.channel === input.channelId && row.accountId === input.accountId),
      requests: (result.requests || []).filter(row => row.channel === input.channelId && row.accountId === input.accountId),
      commandOwnerConfigured: result.commandOwnerConfigured === true, limits: result.limits};
  }
  async function action(raw) {
    exactKeys(raw, ['action', 'channelId', 'accountId', 'requestId', 'notify', 'bootstrapCommandOwner', 'force', 'timeoutMs', 'challengeId']);
    const input = clone(raw), state = await read(), {item, account} = selected(state, input);
    const actions = {'start': 'channels.start', 'stop': 'channels.stop', 'logout': 'channels.logout', 'pairing-list': 'channels.pairing.list',
      'pairing-approve': 'channels.pairing.approve', 'pairing-dismiss': 'channels.pairing.dismiss', 'web-login-start': 'web.login.start', 'web-login-wait': 'web.login.wait'};
    if (!Object.hasOwn(actions, input.action)) throw fail('Unsupported native channel operation.');
    const permittedKeys = ['action', 'channelId', 'accountId', ...(input.action === 'pairing-approve' ? ['requestId', 'notify', 'bootstrapCommandOwner'] :
      input.action === 'pairing-dismiss' ? ['requestId'] : input.action === 'web-login-start' ? ['force', 'timeoutMs'] : input.action === 'web-login-wait' ? ['challengeId', 'timeoutMs'] : [])];
    exactKeys(input, permittedKeys);
    const capability = input.action.startsWith('pairing-') ? 'pairing' : input.action.startsWith('web-login-') ? 'webLogin' : input.action;
    if (!item.capabilities[capability]) throw fail('This native channel does not advertise this operation.', 'OPENCLAW_CHANNEL_UNSUPPORTED', 409);
    const params = {channel: item.id, accountId: account.accountId};
    if (input.action === 'pairing-list') return redact(await pairing(state, input));
    if (input.action === 'pairing-approve' || input.action === 'pairing-dismiss') {
      if (!id(input.requestId)) throw fail('Choose an exact pending pairing request.');
      const requests = await pairing(state, input);
      if (!requests.requests.some(row => row.requestId === input.requestId)) throw fail('The pairing request is not pending for this account.', 'OPENCLAW_CHANNEL_PAIRING_STALE', 409);
      params.requestId = input.requestId;
      if (input.action === 'pairing-approve') for (const key of ['notify', 'bootstrapCommandOwner']) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') throw fail('Invalid pairing approval option.');
        params[key] = input[key] === true;
      }
    }
    if (input.action.startsWith('web-login-')) {
      if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 30000)) throw fail('Use a web-login timeout of at most 30 seconds.');
      params.timeoutMs = input.timeoutMs ?? 1000;
      if (input.action === 'web-login-start') {
        if (input.force !== undefined && typeof input.force !== 'boolean') throw fail('Invalid web-login restart option.');
        params.force = input.force === true;
      } else {
        const challenge = pending.get(input.challengeId);
        if (!challenge || challenge.channelId !== item.id || challenge.accountId !== account.accountId || challenge.expires <= now()) throw fail('This account login challenge has expired.', 'OPENCLAW_CHANNEL_LOGIN_STALE', 409);
        if (challenge.sessionKey) params.sessionKey = challenge.sessionKey;
        if (challenge.qrDataUrl) params.currentQrDataUrl = challenge.qrDataUrl;
      }
    }
    const assertCurrent = await admitted(state, {operation: actions[input.action], channelId: item.id, accountId: account.accountId,
      details: Object.fromEntries(Object.entries(params).filter(([key]) => !['sessionKey', 'currentQrDataUrl'].includes(key)))});
    if (input.action === 'pairing-approve' || input.action === 'pairing-dismiss') {
      if (!(await pairing(state, input)).requests.some(row => row.requestId === input.requestId)) throw fail('The pairing request changed during review.', 'OPENCLAW_CHANNEL_PAIRING_STALE', 409);
    }
    if (input.action === 'web-login-wait' && pending.get(input.challengeId)?.expires <= now()) throw fail('This account login challenge has expired.', 'OPENCLAW_CHANNEL_LOGIN_STALE', 409);
    await assertCurrent();
    let result;
    try {result = await rpc(actions[input.action], params);} catch {throw fail('The native channel operation did not complete. Inspect local runtime diagnostics.', 'OPENCLAW_CHANNEL_REQUEST_FAILED', 502);}
    if (input.action.startsWith('web-login-')) {
      const priorChallenge = input.action === 'web-login-wait' ? pending.get(input.challengeId) : undefined;
      for (const [key, challenge] of pending) if (challenge.expires <= now() || challenge.channelId === item.id && challenge.accountId === account.accountId) pending.delete(key);
      const connected = result?.connected === true;
      const qrDataUrl = !connected ? qr(result?.qrDataUrl) || priorChallenge?.qrDataUrl : undefined;
      const sessionKey = typeof result?.sessionKey === 'string' && result.sessionKey.length <= 4096 ? result.sessionKey : priorChallenge?.sessionKey;
      const challengeId = !connected && (qrDataUrl || sessionKey) ? randomUUID() : undefined;
      if (challengeId) pending.set(challengeId, {channelId: item.id, accountId: account.accountId, expires: priorChallenge?.expires || now() + 5 * 60 * 1000, qrDataUrl, sessionKey});
      // QR data is an explicit ephemeral owner login artifact. It is never logged,
      // sealed to the Timechain, included in review, or available to the model.
      return {...(challengeId ? {challengeId} : {}), connected, ...(qrDataUrl ? {qrDataUrl} : {}), ...(string(result?.message) ? {message: redact(result.message)} : {})};
    }
    if (input.action === 'logout') for (const [key, challenge] of pending) if (challenge.channelId === item.id && challenge.accountId === account.accountId) pending.delete(key);
    if (input.action.startsWith('pairing-')) return redact({requestId: result?.requestId, senderId: result?.senderId, notification: result?.notification, commandOwnerBootstrap: result?.commandOwnerBootstrap});
    const resultFlags = {};
    if (input.action === 'start' && typeof result?.started === 'boolean') resultFlags.started = result.started;
    if (input.action === 'stop' && typeof result?.stopped === 'boolean') resultFlags.stopped = result.stopped;
    if (input.action === 'logout') {
      if (typeof result?.cleared === 'boolean') resultFlags.cleared = result.cleared;
      if (typeof result?.loggedOut === 'boolean') resultFlags.loggedOut = result.loggedOut;
      resultFlags.credentialPolicy = 'retained';
      resultFlags.message = `${result?.loggedOut === false || result?.cleared === false && result?.loggedOut !== true ? 'Native logout did not confirm a disconnected account.' : 'Native logout request completed.'} Stored credentials are retained in dedicated credential controls; remove them there to prevent reconnection after restart.`;
    }
    const completed = input.action === 'start' ? result?.started : input.action === 'stop' ? result?.stopped : result?.loggedOut ?? result?.cleared;
    return {ok: completed !== false, channelId: item.id, accountId: account.accountId, action: input.action, ...resultFlags};
  }
  return {snapshot: async () => publicSnapshot(await read()),
    save: async raw => {const input = clone(raw); return scoped(input, () => save(input));},
    action: async raw => {const input = clone(raw); return scoped(input, () => action(input));}};
}
