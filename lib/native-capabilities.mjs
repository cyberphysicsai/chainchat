// Owner-admitted native OpenClaw surfaces. This is authority metadata, never
// evidence that a tool executed or that native code runs in an OS sandbox.
const fields = new Set(['enabled', 'acknowledged', 'tools', 'settings', 'delegatedRuns', 'backgroundRuns']);
const reserved = new Set(['read', 'write', 'edit', 'web_fetch', 'browser', 'exec', 'process', 'chainchat_automation', 'get_goal', 'update_goal',
  'secrets', 'gateway', 'plugins', 'config', 'openclaw']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const deny = message => Object.assign(new Error(message), {code: 'NATIVE_CAPABILITY_DENIED', status: 403});
const toolName = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\0\r\n\u2028\u2029]/.test(value) && /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const settingPath = value => typeof value === 'string' && value.length <= 256 && !/[\0\r\n\u2028\u2029]/.test(value) && (value === '*' || /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value)) && !value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part));

export const disabledNativeCapabilities = () => ({enabled: false, acknowledged: false, tools: [], settings: [], delegatedRuns: false, backgroundRuns: false});
export const isScopedHostTool = name => reserved.has(name);

export function validateNativeCapabilities(value, {toolNames = []} = {}) {
  if (value == null) return disabledNativeCapabilities();
  if (!plain(value) || Object.keys(value).some(key => !fields.has(key))) throw deny('Invalid native capability grant.');
  for (const key of ['enabled', 'acknowledged', 'delegatedRuns', 'backgroundRuns'])
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw deny('Invalid native capability flag.');
  const tools = value.tools ?? [], settings = value.settings ?? [];
  if (!Array.isArray(tools) || tools.length > 128 || ![...tools].every(toolName) || new Set(tools).size !== tools.length ||
      !Array.isArray(settings) || settings.length > 256 || ![...settings].every(settingPath) || new Set(settings).size !== settings.length ||
      !Array.isArray(toolNames) || toolNames.length > 2048 || ![...toolNames].every(toolName)) throw deny('Native capability limits were exceeded.');
  const known = new Set(toolNames);
  if (tools.some(name => reserved.has(name) || !known.has(name)))
    throw deny('Choose discovered native tools. Scoped host tools, goals and protected administration use their dedicated controls.');
  if (value.enabled === true && value.acknowledged !== true) throw deny('Explicit local acknowledgement is required for native capabilities.');
  return {enabled: value.enabled === true, acknowledged: value.acknowledged === true, tools: [...tools], settings: [...settings],
    delegatedRuns: value.delegatedRuns === true, backgroundRuns: value.backgroundRuns === true};
}

export function nativeSettingsAllowed(snapshot, path) {
  if (!snapshot?.enabled || snapshot.acknowledged !== true || !settingPath(path) || path === '*' || !Array.isArray(snapshot.settings)) return false;
  return snapshot.settings.some(allowed => settingPath(allowed) && (allowed === '*' || path === allowed || path.startsWith(allowed + '.')));
}

export function nativeToolNames(snapshot) {
  return snapshot?.enabled === true && snapshot.acknowledged === true && Array.isArray(snapshot.tools)
    ? snapshot.tools.filter(name => toolName(name) && !reserved.has(name)) : [];
}

export function authorizeNativeTool(snapshot, tool, {toolNames = []} = {}) {
  const grant = validateNativeCapabilities(snapshot, {toolNames});
  if (!grant.enabled || !grant.acknowledged || !plain(tool) || !toolName(tool.name) || !grant.tools.includes(tool.name) ||
      typeof tool.callId !== 'string' || !tool.callId || tool.callId.length > 256 || /[\0\r\n]/.test(tool.callId) || !plain(tool.params))
    throw deny('This concrete native tool call has no current owner grant.');
  if (['sessions_spawn', 'sessions_send', 'subagents'].includes(tool.name) && !grant.delegatedRuns)
    throw deny('Delegated agent runs require their own inherited PoI admission.');
  if (['cron', 'automations', 'heartbeat', 'image_generate', 'video_generate', 'music_generate'].includes(tool.name) && !grant.backgroundRuns)
    throw deny('Background runs require a registered PoI binding.');
  let text;
  try {text = JSON.stringify(tool.params);} catch {throw deny('Native tool parameters must be JSON.');}
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024) throw deny('Native tool parameters exceed the review limit.');
  const check = (value, depth = 0) => {
    if (depth > 48) throw deny('Native tool parameters exceed the nesting limit.');
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw deny('Unsafe native tool parameter key.');
      check(value[key], depth + 1);
    }
  };
  check(tool.params);
  return {name: tool.name, params: JSON.parse(text), callId: tool.callId};
}
