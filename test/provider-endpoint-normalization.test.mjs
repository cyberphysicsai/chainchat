import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { validateProvider, generate, review, DIMENSIONS, FRUITS } from '../lib/providers.mjs';
import { providerRequest } from '../openclaw/gateway.mjs';

const fixtures = [
  ['openai', '/v1/responses', '/v1', '/openai/v1/responses'],
  ['compatible', '/api/v1/chat/completions', '/api/v1', '/compatible/v1/chat/completions'],
  ['anthropic', '/v1/messages', '/v1', '/anthropic/v1/messages'],
  ['gemini', '/v1beta/models/fixture:generateContent', '/v1beta', '/gemini/v1beta/models/route:generateContent'],
];
const approved = () => ({ decision: 'approve', usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(name => [name, 240])),
  fruits: Object.fromEntries(FRUITS.map(name => [name, 240])), rationale: 'A supported and kind response.' });
const completion = (provider, text) => ({
  openai: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] },
  compatible: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] },
  anthropic: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  gemini: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] },
})[provider];

test('copied full endpoints become API base URLs without changing the selected protocol, origin, model or key', () => {
  for (const [provider, endpoint, base] of fixtures) {
    const input = { provider, model: 'fixture', baseUrl: 'https://provider.example' + endpoint + '/', apiKey: 'private-fixture-key' };
    const result = validateProvider(input);
    assert.deepEqual(result, { ...input, baseUrl: 'https://provider.example' + base });
    assert.deepEqual(validateProvider(result), result);
    assert.equal(input.baseUrl.endsWith(endpoint + '/'), true);
  }
  for (const suffix of ['/models/fixture', '/models/fixture:streamGenerateContent'])
    assert.equal(validateProvider({ provider: 'gemini', model: 'models/fixture', baseUrl: 'https://provider.example/v1beta' + suffix,
      apiKey: 'private-fixture-key' }).baseUrl, 'https://provider.example/v1beta');
  assert.equal(validateProvider({ provider: 'compatible', model: 'fixture', baseUrl: 'https://provider.example/custom/proxy',
    apiKey: 'private-fixture-key' }).baseUrl, 'https://provider.example/custom/proxy');
});

test('an endpoint for a different protocol or Gemini model is rejected before any credential can leave the app', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected provider request'); });
  for (const [protocol, endpoint] of fixtures) {
    for (const [provider] of fixtures) {
      if (provider === protocol) continue;
      await assert.rejects(generate({ provider, model: 'fixture', baseUrl: 'https://provider.example' + endpoint,
        apiKey: 'private-fixture-key' }, { messages: [{ role: 'user', content: 'Hello.' }] }),
      error => error.code === 'INVALID_PROVIDER' && /protocol/u.test(error.message));
    }
  }
  assert.throws(() => validateProvider({ provider: 'gemini', model: 'another-model',
    baseUrl: 'https://provider.example/v1beta/models/fixture:generateContent', apiKey: 'private-fixture-key' }),
  error => error.code === 'INVALID_PROVIDER' && /model does not match/u.test(error.message));
  assert.equal(calls, 0);
});

test('repeated and cross-protocol endpoint suffixes cannot change again on later validation', () => {
  const suffixes = [
    ['openai', '/responses'], ['compatible', '/chat/completions'],
    ['anthropic', '/messages'], ['gemini', '/models/fixture:generateContent'],
  ];
  for (const [provider, outer] of suffixes) for (const [, inner] of suffixes) {
    for (const separator of ['', '/'])
      assert.throws(() => validateProvider({ provider, model: 'fixture',
        baseUrl: 'https://provider.example/v1' + inner + separator + outer, apiKey: 'private-fixture-key' }),
      error => error.code === 'INVALID_PROVIDER' && /nested endpoint suffixes/u.test(error.message));
  }
});

test('native provider proxy uses the same normalized endpoint as direct required reviews', () => {
  for (const [provider, endpoint, base, nativePath] of fixtures) {
    const request = providerRequest({ provider, model: 'fixture', baseUrl: 'https://provider.example' + endpoint,
      apiKey: 'private-fixture-key' }, nativePath, { model: 'route', messages: [], contents: [] });
    assert.equal(request.url, 'https://provider.example' + (provider === 'gemini' ? base + '/models/fixture:generateContent' : endpoint));
    assert.equal(JSON.stringify(request.body).includes('private-fixture-key'), false);
  }
});

test('all four direct protocols complete generation and mandatory semantic review when a full endpoint is pasted', async t => {
  for (const [provider, endpoint] of fixtures) await t.test(provider, async t => {
    const calls = [];
    const server = http.createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); calls.push({ path: request.url, body });
      const valid = request.url === endpoint;
      const isReview = raw.includes('independent pre-release covenant reviewer');
      response.writeHead(valid ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(valid ? completion(provider, isReview ? JSON.stringify(approved()) : 'Hello.')
        : { error: { message: 'Unknown endpoint' } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const config = { provider, model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}` + endpoint,
      apiKey: 'private-fixture-key' };
    assert.equal((await generate(config, { messages: [{ role: 'user', content: 'Hello.' }] })).text, 'Hello.');
    assert.equal((await review(config, { input: 'Hello.', candidate: 'Hello.', covenant: [...FRUITS] })).approved, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.path === endpoint && !JSON.stringify(call.body).includes(config.apiKey)));
  });
});
