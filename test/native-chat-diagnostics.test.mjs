import test from 'node:test';
import assert from 'node:assert/strict';
import { safeInvocationError, invocationError } from '../lib/runtime-errors.mjs';
import { chatFailure } from '../public/chat-errors.js';

test('native no-reply and admission failures survive the private diagnostic handoff', () => {
  const cases = [
    ['OPENCLAW_MODEL_ADMISSION', 'authorization', 403, 'native'],
    ['OPENCLAW_MODEL_FAILED', 'provider', 502, 'model'],
    ['OPENCLAW_NATIVE_HELD', 'runtime', 502, 'native'],
    ['OPENCLAW_EMPTY_RESPONSE', 'generation', 502, 'model'],
    ['OPENCLAW_MODEL_ROUTE_HELD', 'context', 422, 'model'],
  ];
  const privateValue = 'private-provider-body https://account.example/secret api-key';
  for (const [code, stage, status, action] of cases) {
    const original = Object.assign(new Error(privateValue), {
      code, body: privateValue, errorMessage: privateValue,
      gate: { approved: false, rationale: privateValue },
    });
    const snapshot = safeInvocationError(original), restored = invocationError(snapshot);
    assert.ok(snapshot, `${code} must not disappear behind a generic native hold`);
    assert.equal(snapshot.code, code);
    assert.equal(snapshot.stage, stage);
    assert.equal(snapshot.status, status);
    assert.equal(Object.hasOwn(snapshot, 'gate'), false, 'Transport errors never invent a PoI verdict.');
    assert.equal(JSON.stringify(snapshot).includes(privateValue), false);
    assert.equal(restored.code, code);
    assert.equal(restored.message.includes(privateValue), false);
    const view = chatFailure(restored);
    assert.equal(view.code, code, 'A known runtime failure must not collapse to REQUEST_FAILED.');
    assert.equal(view.stage, stage);
    assert.equal(view.action, action);
    assert.notEqual(view.kind, 'gate');
    assert.equal(JSON.stringify(view).includes(privateValue), false);
  }
});

test('generic native holds preserve an already known stage and do not claim PoI rejection', () => {
  for (const code of ['OPENCLAW_NATIVE_HELD', 'OPENCLAW_EMPTY_RESPONSE']) {
    const snapshot = safeInvocationError({ code, stage: 'generation' });
    const view = chatFailure(invocationError(snapshot));
    assert.equal(view.stage, 'generation');
    assert.match(view.message, /does not (?:identify|establish).*PoI rejection/);
    assert.notEqual(view.title, 'POI REVIEW HELD');
  }
  const unsafeStage = 'https://private.example/prompt-and-key';
  const snapshot = safeInvocationError({ code: 'OPENCLAW_EMPTY_RESPONSE', stage: unsafeStage });
  assert.equal(snapshot.stage, 'generation');
  assert.equal(chatFailure(snapshot).stage, 'generation');
  assert.equal(safeInvocationError({ code: unsafeStage, message: unsafeStage }), null);
  assert.equal(chatFailure({ code: unsafeStage, stage: unsafeStage }).code, 'REQUEST_FAILED');
});
