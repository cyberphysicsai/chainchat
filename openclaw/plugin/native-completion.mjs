/** Private, bounded JSON utility inference using the owner's native default.
 * This is not an agent runner: SDK direct completion supplies no tools and does
 * not enter context engines. No caller can select a model, agent or credential.
 */
export const NATIVE_COMPLETION_METHOD = 'cypher-tempre.native.complete';
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasOnly = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= max;
const denied = (code = 'OPENCLAW_NATIVE_COMPLETION_DENIED') => Object.assign(new Error('The private native review or memory-planning completion was not authorized.'), { code });
const fail = code => Object.assign(new Error('The native utility completion did not return an admissible text result.'), { code });
export const validNativeSessionKey = value => typeof value === 'string' && value.length <= 1080 && !/[\0\r\n\u2028\u2029]/u.test(value) &&
  /^agent:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9][A-Za-z0-9_.:-]{0,1000}$/u.test(value);
export function assertNativeCompletionPolicy(api) {
  const config = api.runtime?.config?.current ? api.runtime.config.current({ clone: true }) : api.config;
  const policy = config?.plugins?.entries?.['cypher-tempre-poi']?.llm;
  if (policy?.allowAgentIdOverride !== true || policy.allowModelOverride === true || policy.allowAuthProfileOverride === true) throw denied();
  return true;
}
export function validateNativeCompletionRequest(input) {
  if (!hasOnly(input, ['sessionKey', 'system', 'messages', 'maxTokens', 'purpose']) ||
      !validNativeSessionKey(input.sessionKey) ||
      !['review', 'memory-plan'].includes(input.purpose) || !text(input.system, 128 * 1024) ||
      !Number.isInteger(input.maxTokens) || input.maxTokens < 128 || input.maxTokens > 32768 ||
      !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 128 || Object.keys(input.messages).length !== input.messages.length ||
      input.messages.some(message => !hasOnly(message, ['role', 'content']) || !['user', 'assistant'].includes(message.role) || !text(message.content, 1024 * 1024)) ||
      Buffer.byteLength(JSON.stringify(input), 'utf8') > 2 * 1024 * 1024) throw denied();
  return { sessionKey: input.sessionKey, system: input.system, messages: input.messages.map(message => ({ role: message.role, content: message.content })),
    maxTokens: input.maxTokens, purpose: input.purpose };
}
function completionError(error, signal) {
  if (signal?.aborted || error?.code === 'LLM_COMPLETION_ABORTED') return fail('CANCELLED');
  if (error?.code === 'LLM_COMPLETION_NOT_AUTHORIZED') return denied();
  if (error?.code === 'LLM_COMPLETION_TIMEOUT') return fail('PROVIDER_TIMEOUT');
  // Raw SDK messages, causes, auth/profile objects and provider bodies never
  // cross this RPC boundary. Unknown failures are not truncation fallback.
  return fail('PROVIDER_INVALID_RESPONSE');
}
export function createNativeCompletion({ complete, assertPolicy = () => {} } = {}) {
  if (typeof complete !== 'function') throw denied();
  return async (input, { signal, assertCurrent = () => {} } = {}) => {
    const request = validateNativeCompletionRequest(input);
    if (signal?.aborted) throw fail('CANCELLED'); assertCurrent(); assertPolicy();
    let result;
    try {
      result = await complete({ systemPrompt: request.system, messages: request.messages,
        maxTokens: request.maxTokens, purpose: `cypher-tempre-poi.${request.purpose}`, agentId: 'main', signal });
    } catch (error) { throw completionError(error, signal); }
    if (signal?.aborted) throw fail('CANCELLED'); assertCurrent();
    if (!plain(result) || result.agentId !== 'main' || result.execution?.mode !== 'direct-provider') throw fail('PROVIDER_INVALID_RESPONSE');
    if (result.stopReason === 'length') throw fail('PROVIDER_INCOMPLETE');
    if (result.stopReason === 'toolUse') throw fail('PROVIDER_TOOL_CALL');
    if (result.stopReason !== 'stop' || !text(result.text, 256 * 1024)) throw fail('PROVIDER_INVALID_RESPONSE');
    const attribution = name => typeof result[name] === 'string' && result[name].length > 0 && result[name].length <= 256 && !/[\0\r\n]/u.test(result[name]) ? result[name] : null;
    const provider = attribution('provider'), model = attribution('model');
    if (!provider || !model) throw fail('PROVIDER_INVALID_RESPONSE');
    const usage = {};
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd']) {
      const value = result.usage?.[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) usage[key] = value;
    }
    return { text: result.text, usage, provider, model, agentId: 'main', stopReason: 'stop',
      reviewerSelection: 'owner-configured-main-default', sessionKey: request.sessionKey };
  };
}
export function registerNativeCompletion(api) {
  const complete = createNativeCompletion({ complete: input => api.runtime.llm.complete(input), assertPolicy: () => assertNativeCompletionPolicy(api) });
  api.registerGatewayMethod(NATIVE_COMPLETION_METHOD, async ({ params, respond, signal, hasCurrentClientAuthority }) => {
    const assertCurrent = () => { if (typeof hasCurrentClientAuthority !== 'function' || hasCurrentClientAuthority() !== true) throw denied(); };
    try { respond(true, await complete(params, { signal, assertCurrent })); }
    catch (error) { const safe = ['OPENCLAW_NATIVE_COMPLETION_DENIED', 'CANCELLED', 'PROVIDER_TIMEOUT', 'PROVIDER_INCOMPLETE', 'PROVIDER_TOOL_CALL', 'PROVIDER_INVALID_RESPONSE'].includes(error?.code) ? error : denied();
      respond(false, undefined, { code: safe.code, message: safe.message }); }
  }, { scope: 'operator.write', profileAccess: 'required', sessionAccess: { mode: 'write' } });
}
