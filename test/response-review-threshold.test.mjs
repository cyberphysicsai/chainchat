import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIMENSIONS, FRUITS, REVIEW_THRESHOLD, RESPONSE_REVIEW_THRESHOLD,
  reviewThresholdForPurpose, parseReview, review, reviewWithCompletion,
} from '../lib/providers.mjs';

const judgment = (score = 150) => ({ decision: 'approve', usedRings: [],
  scores: { ...Object.fromEntries(DIMENSIONS.map(key => [key, 240])), covenant: score },
  fruits: Object.fromEntries(FRUITS.map(key => [key, score])), rationale: 'A grounded and compatible conversational reply.' });
const args = { input: 'Please introduce yourself.', candidate: 'Hello, I am Cypher Tempre.', covenant: [...FRUITS] };
const config = { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:9999/v1' };
function response(value) {
  const text = JSON.stringify(value);
  return new Response(JSON.stringify({ status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    stop_reason: 'end_turn', content: [{ type: 'text', text }],
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
  }), { headers: { 'content-type': 'application/json' } });
}

test('response review accepts 150 inclusively while default action review retains 180', () => {
  assert.equal(RESPONSE_REVIEW_THRESHOLD, 150); assert.equal(REVIEW_THRESHOLD, 180);
  assert.equal(reviewThresholdForPurpose('response'), 150);
  assert.equal(reviewThresholdForPurpose(), 180); assert.equal(reviewThresholdForPurpose('action'), 180);
  for (const score of [150, 179, 180, 255]) {
    const value = parseReview(JSON.stringify(judgment(score)), [], 'response');
    assert.equal(value.approved, true); assert.equal(value.threshold, 150);
  }
  for (const purpose of [undefined, 'action']) {
    assert.equal(parseReview(JSON.stringify(judgment(179)), [], purpose).approved, false);
    const passed = parseReview(JSON.stringify(judgment(180)), [], purpose);
    assert.equal(passed.approved, true); assert.equal(passed.threshold, 180);
  }
  for (const fruit of FRUITS) {
    const low = judgment(); low.fruits[fruit] = 149;
    assert.equal(parseReview(JSON.stringify(low), [], 'response').approved, false, fruit);
  }
  const lowCovenant = judgment(); lowCovenant.scores.covenant = 149;
  assert.equal(parseReview(JSON.stringify(lowCovenant), [], 'response').approved, false);
  const refused = judgment(); refused.decision = 'reject';
  assert.equal(parseReview(JSON.stringify(refused), [], 'response').approved, false);
  const spoofed = { ...judgment(179), threshold: 0, reviewPurpose: 'response' };
  const checked = parseReview(JSON.stringify(spoofed));
  assert.equal(checked.approved, false); assert.equal(checked.threshold, 180);
});

test('only the host-selected fixed review purpose can select the lower response floor', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(judgment()); });
  for (const invalid of [null, 0, 150, 180, '150', 'tool', 'response ', {}, ['response']]) {
    assert.throws(() => reviewThresholdForPurpose(invalid), { code: 'GATE_INVALID_CONTEXT' });
    assert.throws(() => parseReview(JSON.stringify(judgment()), [], invalid), { code: 'GATE_INVALID_CONTEXT' });
    await assert.rejects(review(config, { ...args, reviewPurpose: invalid }), { code: 'GATE_INVALID_CONTEXT' });
  }
  assert.equal(calls, 0, 'Invalid purposes are held before any provider request.');
});

test('all direct protocols and native review use the selected response floor in the prompt and parser', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body); requests.push(body);
    assert.match(JSON.stringify(body), /every fruitage and covenant score is at least 150/);
    return response(judgment());
  });
  for (const provider of ['openai', 'compatible', 'anthropic', 'gemini']) {
    const result = await review({ ...config, provider }, { ...args, reviewPurpose: 'response' });
    assert.equal(result.approved, true, provider); assert.equal(result.threshold, 150);
  }
  const native = await reviewWithCompletion({ provider: 'native', tier: 'native', model: 'provider/fixture' },
    { ...args, reviewPurpose: 'response' }, async (_selected, request) => {
      assert.match(request.system, /every fruitage and covenant score is at least 150/);
      return { text: JSON.stringify(judgment()) };
    });
  assert.equal(native.approved, true); assert.equal(native.threshold, 150); assert.equal(requests.length, 4);
});

test('the refusal and bounded-retry rules use the same threshold as response approval', async t => {
  for (const purpose of ['response', 'action']) await t.test(purpose, async t => {
    const low = purpose === 'response' ? 149 : 179;
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
      calls++;
      const body = JSON.parse(request.body);
      assert.match(body.messages[0].content, new RegExp(`every fruitage and covenant score is at least ${low + 1}`));
      return response({ ...judgment(low), usedRings: undefined });
    });
    await assert.rejects(review(config, { ...args, reviewPurpose: purpose }), { code: 'GATE_INVALID_EVIDENCE' });
    assert.equal(calls, 1, 'A known low score cannot be retried merely to get approval.');
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; return response(calls === 1 ? { ...judgment(), usedRings: undefined } : judgment());
  });
  const corrected = await review(config, { ...args, reviewPurpose: 'response' });
  assert.equal(corrected.approved, true); assert.equal(corrected.threshold, 150); assert.equal(calls, 2);
});
