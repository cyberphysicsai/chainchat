import test from 'node:test';
import assert from 'node:assert/strict';
import { review, reviewWithCompletion, perspectiveTokenAllowance, DIMENSIONS, FRUITS } from '../lib/providers.mjs';

const approved = () => ({ decision: 'approve', usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(name => [name, 240])),
  fruits: Object.fromEntries(FRUITS.map(name => [name, 240])), rationale: 'A supported and kind response.' });
const args = { input: 'Hello.', candidate: 'Hello.', covenant: [...FRUITS] };
const completion = (provider, text, incomplete) => ({
  openai: incomplete ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
    usage: { output_tokens: 8192, output_tokens_details: { reasoning_tokens: 8192 } } }
    : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] },
  compatible: { choices: [{ finish_reason: incomplete ? 'length' : 'stop', message: { role: 'assistant', content: incomplete ? '' : text } }] },
  anthropic: { stop_reason: incomplete ? 'max_tokens' : 'end_turn', content: incomplete ? [] : [{ type: 'text', text }] },
  gemini: { candidates: [{ finishReason: incomplete ? 'MAX_TOKENS' : 'STOP', content: { parts: incomplete ? [] : [{ text }] } }] },
})[provider];

test('required BYOK review honors an explicit larger reasoning budget instead of silently capping it at 8192', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    const budget = body.max_output_tokens ?? body.max_tokens ?? body.generationConfig.maxOutputTokens;
    calls.push({ body, budget });
    const protocol = body.instructions ? 'openai' : body.system ? 'anthropic' : body.contents ? 'gemini' : 'compatible';
    return new Response(JSON.stringify(completion(protocol, JSON.stringify(approved()), budget < 16384)),
      { headers: { 'content-type': 'application/json' } });
  });
  for (const provider of ['openai', 'compatible', 'anthropic', 'gemini']) {
    const config = { provider, model: 'fixture', baseUrl: 'http://127.0.0.1:9999/v1', reasoningCapable: true,
      contextWindow: 65536, maxOutputTokens: 32768 };
    assert.equal((await review(config, args)).approved, true);
    assert.equal(calls.at(-1).budget, 32768);
    assert.equal(perspectiveTokenAllowance(config), 8192);
  }
  assert.equal(calls.length, 4);
});

test('native review shares explicit-budget behavior and retains the private completion RPC ceiling', async () => {
  for (const [configured, expected] of [[undefined, 8192], [1024, 1024], [32768, 32768], [262144, 32768]]) {
    const config = { provider: 'native', tier: 'native', model: 'provider/fixture',
      ...(configured === undefined ? {} : { maxOutputTokens: configured }) };
    let calls = 0;
    const result = await reviewWithCompletion(config, args, async (_selected, request) => {
      calls++; assert.equal(request.maxTokens, expected);
      return { text: JSON.stringify(approved()) };
    });
    assert.equal(result.approved, true); assert.equal(calls, 1);
  }
});

test('explicitly small BYOK budgets stay bounded and do not turn exhaustion into approval', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    assert.equal(body.max_tokens, 1024);
    return new Response(JSON.stringify(completion('compatible', '', true)));
  });
  await assert.rejects(review({ provider: 'compatible', model: 'fixture', reasoningCapable: true,
    maxOutputTokens: 1024 }, args), error => error.code === 'PROVIDER_INCOMPLETE' && error.stage === 'review');
  assert.equal(calls, 2);
});

test('required reviews reserve configured context room for input before using a larger explicit output budget', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    const budget = body.max_output_tokens ?? body.max_tokens ?? body.generationConfig.maxOutputTokens;
    calls.push({ body, budget });
    const protocol = body.instructions ? 'openai' : body.system ? 'anthropic' : body.contents ? 'gemini' : 'compatible';
    return new Response(JSON.stringify(completion(protocol, JSON.stringify(approved()), false)));
  });
  for (const provider of ['openai', 'compatible', 'anthropic', 'gemini']) {
    const result = await review({ provider, model: 'fixture', baseUrl: 'http://127.0.0.1:9999/v1',
      contextWindow: 16384, maxOutputTokens: 16383, reasoningCapable: true }, args);
    const { body, budget } = calls.at(-1);
    assert.equal(result.approved, true);
    assert.ok(budget >= 128 && budget < 16383);
    assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(body), 'utf8') / 3) + budget <= 16384);
  }
  let nativeCalls = 0;
  const result = await reviewWithCompletion({ provider: 'native', tier: 'native', model: 'provider/fixture',
    contextWindow: 16384, maxOutputTokens: 16383 }, args, async (_selected, request) => {
    nativeCalls++;
    const body = { systemPrompt: request.system, messages: request.messages, maxTokens: request.maxTokens,
      purpose: 'cypher-tempre-poi.review', agentId: 'main', requiredAuthMode: 'api-key' };
    assert.ok(request.maxTokens >= 128 && request.maxTokens < 16383);
    assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(body), 'utf8') / 3) + 128 + request.maxTokens <= 16384);
    return { text: JSON.stringify(approved()) };
  });
  assert.equal(result.approved, true); assert.equal(nativeCalls, 1);
});

test('review retries independently fit their longer prompt and never raise the configured cap', async t => {
  const budgets = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body); budgets.push(body.max_tokens);
    assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(body), 'utf8') / 3) + body.max_tokens <= 8192);
    return new Response(JSON.stringify(completion('compatible', budgets.length === 1 ? '{' : JSON.stringify(approved()), false)));
  });
  assert.equal((await review({ provider: 'compatible', model: 'fixture', contextWindow: 8192,
    maxOutputTokens: 8191 }, args)).approved, true);
  assert.equal(budgets.length, 2);
  assert.ok(budgets[0] < 8191 && budgets[1] < budgets[0]);
});

test('no configured review context room is a safe context hold before inference, including native completion', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No inference may run'); });
  const oversized = { ...args, candidate: 'A'.repeat(15000) };
  const held = error => error.code === 'OPENCLAW_CONTEXT_BUDGET' && error.stage === 'context' && error.status === 422;
  for (const provider of ['openai', 'compatible', 'anthropic', 'gemini'])
    await assert.rejects(review({ provider, model: 'fixture', baseUrl: 'http://127.0.0.1:9999/v1',
      contextWindow: 4096, maxOutputTokens: 1024 }, oversized), held);
  await assert.rejects(reviewWithCompletion({ provider: 'native', tier: 'native', model: 'provider/fixture',
    contextWindow: 4096, maxOutputTokens: 1024 }, oversized, async () => { calls++; throw new Error('No native inference may run'); }), held);
  assert.equal(calls, 0);
});

test('context fitting cannot turn a low-fruit verdict into approval or trigger a review retry', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; const value = approved(); value.fruits.kindness = 179;
    return new Response(JSON.stringify(completion('compatible', JSON.stringify(value), false)));
  });
  assert.equal((await review({ provider: 'compatible', model: 'fixture', contextWindow: 16384,
    maxOutputTokens: 16383 }, args)).approved, false);
  assert.equal(calls, 1);
});
