import test from 'node:test';
import assert from 'node:assert/strict';
import { covenantThresholdLabel, gateRequirementsNote, supportedBridgeVersion } from '../public/chainchat-display.js';
import { safeInvocationError, invocationError } from '../lib/runtime-errors.mjs';
import { DIMENSIONS, FRUITS } from '../lib/providers.mjs';

test('connected threshold notes distinguish response and action floors without changing compatibility', () => {
  const current = gateRequirementsNote({ required: true, threshold: 150, actionThreshold: 150 });
  assert.match(current, /response.*\(150\/255\)/);
  assert.match(current, /Tool and action reviews retain a 150\/255 minimum/);
  assert.doesNotMatch(current, /Install ChainChat/);
  assert.equal(supportedBridgeVersion('1.0.4'), true);
  assert.equal(supportedBridgeVersion('1.0.7'), true);
  assert.equal(supportedBridgeVersion('1.0.8'), true);
  const legacy = gateRequirementsNote({ required: true, threshold: 180 });
  assert.match(legacy, /server-enforced.*\(180\/255\)/);
  assert.match(legacy, /Install ChainChat 1\.1\.0.*150\/255/);
  assert.match(legacy, /refreshing this page alone does not update the local runtime/);
});

test('historical and unavailable thresholds are reported without inventing a response floor', () => {
  assert.equal(covenantThresholdLabel({ threshold: 150 }), '150 / 255');
  assert.equal(covenantThresholdLabel({ threshold: 180 }), '180 / 255');
  assert.equal(covenantThresholdLabel({ threshold: 220 }), '220 / 255');
  for (const threshold of [undefined, null, '150', -1, 256, 150.5, 'private-url-or-key']) {
    assert.equal(covenantThresholdLabel({ threshold }), 'not reported');
    const note = gateRequirementsNote({ threshold });
    assert.match(note, /has not reported its response threshold/);
    assert.doesNotMatch(note, /private-url-or-key|150\/255|180\/255/);
  }
});

test('private gate-error handoff retains the trusted response or action threshold and no arbitrary value', () => {
  const values = { scores: Object.fromEntries(DIMENSIONS.map(key => [key, 149])),
    fruits: Object.fromEntries(FRUITS.map(key => [key, 149])) };
  for (const code of ['COVENANT_REJECTED', 'POI_REJECTED']) {
    for (const threshold of [150, 180, 190, 255]) {
      const original = { code, gate: { approved: false, threshold, ...values, rationale: 'private text' } };
      const snapshot = safeInvocationError(original), restored = invocationError(snapshot);
      assert.equal(snapshot.gate.threshold, threshold);
      assert.equal(restored.gate.threshold, threshold);
      assert.deepEqual(snapshot.gate.scores, values.scores);
      assert.deepEqual(snapshot.gate.fruits, values.fruits);
      assert.equal(JSON.stringify(snapshot).includes('private text'), false);
      assert.equal(original.gate.approved, false, 'Diagnostic policy labels cannot change the assessment.');
    }
    for (const threshold of [undefined, '150', 149, 256, 'private-url-or-key']) {
      const snapshot = safeInvocationError({ code, gate: { approved: false, threshold, ...values } });
      assert.equal(snapshot.gate.threshold, 150, 'Unknown diagnostics use the trusted host action threshold.');
      assert.equal(JSON.stringify(snapshot).includes('private-url-or-key'), false);
    }
  }
});
