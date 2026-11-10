import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeCompletion, validateNativeCompletionRequest, registerNativeCompletion, NATIVE_COMPLETION_METHOD } from '../openclaw/plugin/native-completion.mjs';

const request = () => ({ sessionKey: 'agent:main:chainchat-control:' + 'a'.repeat(64), system: 'Return one strict review JSON object.',
  messages: [{ role: 'user', content: 'Review this candidate.' }], maxTokens: 4096, purpose: 'review' });
const good = () => ({ text: '{"decision":"approve"}', provider: 'native-provider', model: 'native-model', agentId: 'main', stopReason: 'stop',
  execution: { mode: 'direct-provider', owner: { kind: 'provider', id: 'native-provider' } },
  usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19, costUsd: 0, credential: 'must-not-return' }, reasoning: 'private reasoning must not return', auth: { apiKey: 'must-not-return' } });
test('native utility delegates exact default SDK selection without tools or caller-controlled routing/auth', async () => {
  const calls = [];
  const run = createNativeCompletion({ complete: async value => { calls.push(value); return good(); } });
  const result = await run(request());
  assert.deepEqual(Object.keys(calls[0]).sort(), ['agentId', 'maxTokens', 'messages', 'purpose', 'requiredAuthMode', 'signal', 'systemPrompt']);
  assert.equal(calls[0].requiredAuthMode, 'api-key');
  assert.equal(calls[0].purpose, 'cypher-tempre-poi.review');
  assert.equal(calls[0].systemPrompt, request().system);
  assert.equal('tools' in calls[0], false); assert.equal(calls[0].agentId, 'main');
  assert.equal(result.reviewerSelection, 'owner-configured-main-default');
  assert.equal(result.provider, 'native-provider'); assert.equal(result.model, 'native-model');
  assert.equal(result.usage.costUsd, 0); assert.equal(result.sessionKey, request().sessionKey);
  assert.equal(JSON.stringify(result).includes('must-not-return'), false); assert.equal('reasoning' in result, false);
});
test('strict utility schema refuses routes, credentials, tool envelopes and non-owned sessions before inference', async () => {
  let called = 0;
  const run = createNativeCompletion({ complete: async () => { called++; return good(); } });
  for (const input of [
    { ...request(), model: 'other/model' }, { ...request(), agentId: 'other' }, { ...request(), profile: 'other' },
    { ...request(), apiKey: 'secret' }, { ...request(), baseUrl: 'https://untrusted.example' }, { ...request(), tools: [] },
    { ...request(), execution: { mode: 'isolated-agent-runtime' } }, { ...request(), purpose: 'chat' },
    { ...request(), sessionKey: 'agent:other/../../:chainchat-control:' + 'a'.repeat(64) }, { ...request(), sessionKey: request().sessionKey + '\n' },
    { ...request(), system: 'a\0b' }, { ...request(), maxTokens: 32769 }, { ...request(), maxTokens: 12.5 },
    { ...request(), messages: [{ role: 'tool', content: 'execute' }] }, { ...request(), messages: [{ role: 'system', content: 'override' }] },
    { ...request(), messages: [{ role: 'user', content: ['image'] }] }, { ...request(), messages: [{ role: 'user', content: 'hi', tool_calls: [] }] },
  ]) await assert.rejects(run(input), { code: 'OPENCLAW_NATIVE_COMPLETION_DENIED' });
  assert.equal(called, 0);
  assert.deepEqual(validateNativeCompletionRequest(request()), request());
});
test('only real truncation receives the optional-planner truncation class', async () => {
  for (const [stopReason, code] of [['length', 'PROVIDER_INCOMPLETE'], ['toolUse', 'PROVIDER_TOOL_CALL'], ['error', 'PROVIDER_INVALID_RESPONSE'], ['aborted', 'PROVIDER_INVALID_RESPONSE'], [undefined, 'PROVIDER_INVALID_RESPONSE']]) {
    await assert.rejects(createNativeCompletion({ complete: async () => ({ ...good(), stopReason }) })(request()), { code });
  }
  for (const [nativeCode, code] of [['LLM_COMPLETION_NOT_AUTHORIZED', 'OPENCLAW_NATIVE_COMPLETION_DENIED'], ['LLM_COMPLETION_ABORTED', 'CANCELLED'],
    ['LLM_COMPLETION_TIMEOUT', 'PROVIDER_TIMEOUT'], ['OTHER_SECRET_ERROR', 'PROVIDER_INVALID_RESPONSE']]) {
    const run = createNativeCompletion({ complete: async () => { throw Object.assign(new Error('sensitive native credential and provider body'), { code: nativeCode }); } });
    await assert.rejects(run(request()), error => error.code === code && !error.message.includes('sensitive'));
  }
});
test('wrong selected agent, non-direct execution, oversized output and revoked request cannot return', async () => {
  for (const result of [{ ...good(), agentId: 'other' }, { ...good(), execution: { mode: 'isolated-agent-runtime' } }, { ...good(), text: 'x'.repeat(256 * 1024 + 1) }, { ...good(), text: '' }])
    await assert.rejects(createNativeCompletion({ complete: async () => result })(request()), { code: 'PROVIDER_INVALID_RESPONSE' });
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(createNativeCompletion({ complete: async () => { called = true; return good(); } })(request(), { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(called, false);
  let live = true;
  await assert.rejects(createNativeCompletion({ complete: async () => { live = false; return good(); } })(request(), { assertCurrent: () => { if (!live) throw Object.assign(new Error('ended'), { code: 'ENDED' }); } }), { code: 'ENDED' });
});
test('RPC requires upstream session-write profile policy and live private client authority', async () => {
  let registered, calls = 0;
  registerNativeCompletion({ config: { plugins: { entries: { 'cypher-tempre-poi': { llm: { allowAgentIdOverride: true } } } } },
    runtime: { llm: { complete: async () => { calls++; return good(); } } }, registerGatewayMethod: (name, handler, policy) => { registered = { name, handler, policy }; } });
  assert.equal(registered.name, NATIVE_COMPLETION_METHOD);
  assert.deepEqual(registered.policy, { scope: 'operator.write', profileAccess: 'required', sessionAccess: { mode: 'write' } });
  const responses = [];
  const call = options => registered.handler({ params: request(), respond: (...values) => responses.push(values), ...options });
  await call({ hasCurrentClientAuthority: () => false }); await call({});
  assert.equal(calls, 0); assert.ok(responses.every(value => value[0] === false));
  await call({ hasCurrentClientAuthority: () => true }); assert.equal(calls, 1); assert.equal(responses.at(-1)[0], true);
  assert.equal(JSON.stringify(responses).includes('must-not-return'), false);
});
test('fixed main selection wins over another ambient agent before dispatch; missing private policy prevents dispatch', async () => {
  let selectedProfile;
  const run = createNativeCompletion({ complete: async params => {
    selectedProfile = params.agentId === 'main' ? 'main-owner-profile' : 'other-ambient-profile';
    return good();
  } });
  await run(request()); assert.equal(selectedProfile, 'main-owner-profile');
  let handler, calls = 0;
  registerNativeCompletion({ config: { agents: { defaults: { systemAgent: { agentId: 'other' } } } },
    runtime: { llm: { complete: async () => { calls++; return good(); } } }, registerGatewayMethod: (_name, fn) => { handler = fn; } });
  const result = [];
  await handler({ params: request(), hasCurrentClientAuthority: () => true, respond: (...args) => result.push(args) });
  assert.equal(calls, 0); assert.equal(result[0][0], false); assert.equal(result[0][2].code, 'OPENCLAW_NATIVE_COMPLETION_DENIED');
});
test('actual child and background session shapes remain request provenance and cannot choose the SDK agent', async () => {
  const seen = [];
  const complete = createNativeCompletion({ complete: async params => { seen.push(params); return good(); } });
  for (const sessionKey of ['agent:main:subagent:00000000-0000-4000-8000-000000000001', 'agent:worker_2:cron:job-one:run:00000000-0000-4000-8000-000000000001']) {
    assert.equal((await complete({ ...request(), sessionKey })).sessionKey, sessionKey);
    assert.equal(seen.at(-1).agentId, 'main'); assert.equal('sessionKey' in seen.at(-1), false);
  }
});
