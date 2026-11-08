import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeInvocationError, errorStage, safeInvocationError} from '../lib/runtime-errors.mjs';
import {chatFailure} from '../public/chat-errors.js';

const killed = {backend: 'openclaw', healthy: false, running: false, failureCode: 'OPENCLAW_PROCESS_KILLED'};
test('owned gateway death stays the visible cause when a retrieval-planning socket fails', () => {
  const socket = Object.assign(new Error('private-url-and-key'), {code: 'OPENCLAW_CONTROL_CLOSED', stage: 'memory-planning'});
  const promoted = runtimeInvocationError(socket, killed);
  assert.equal(promoted.code, 'OPENCLAW_PROCESS_KILLED');
  assert.equal(promoted.stage, 'runtime');
  assert.equal(promoted.message.includes('private-url-and-key'), false);
  for (const code of ['OPENCLAW_MEMORY_EXHAUSTED', 'OPENCLAW_PROCESS_KILLED', 'OPENCLAW_PROCESS_EXITED',
    'OPENCLAW_START_FAILED', 'OPENCLAW_START_TIMEOUT', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 'OPENCLAW_CONTROL_CLOSED', 'OPENCLAW_CONTROL_AUTH']) {
    const error = {code, stage: 'memory-planning'};
    assert.equal(errorStage(error), 'runtime');
    assert.equal(safeInvocationError(error).stage, 'runtime');
    assert.equal(chatFailure(error).stage, 'runtime');
  }
});
test('a terminal runtime observation never masks provider, covenant, authentication or cancellation errors', () => {
  for (const code of ['PROVIDER_TIMEOUT', 'PROVIDER_HTTP_ERROR', 'PROVIDER_CREDENTIAL_REFLECTION', 'COVENANT_REJECTED',
    'POI_REJECTED', 'GATE_INVALID_REVIEW', 'SESSION_CHANGED', 'OPENCLAW_CONTROL_AUTH', 'REQUEST_CANCELLED', 'CANCELLED', 'INTEGRITY_FAILED']) {
    const original = Object.assign(new Error('fixture'), {code, stage: 'memory-planning'});
    assert.equal(runtimeInvocationError(original, killed), original, code);
  }
  const provider = {code: 'PROVIDER_INCOMPLETE', stage: 'memory-planning'};
  assert.equal(errorStage(provider), 'memory-planning');
  assert.equal(chatFailure(provider).stageLabel, 'Memory retrieval planning');
});
test('transport failure alone, healthy runtime, unknown failure or direct backend does not invent a process cause', () => {
  const error = Object.assign(new Error('fixture'), {code: 'OPENCLAW_CONTROL_CLOSED'});
  for (const runtime of [undefined, {backend: 'direct', failureCode: killed.failureCode},
    {...killed, healthy: true}, {...killed, failureCode: 'private-key'}, {...killed, failureCode: 'OPENCLAW_ENFORCEMENT_UNHEALTHY'}])
    assert.equal(runtimeInvocationError(error, runtime), error);
  const fetchError = new TypeError('fetch failed', {cause: {code: 'UND_ERR_SOCKET'}});
  assert.equal(runtimeInvocationError(fetchError, killed).code, killed.failureCode);
});
