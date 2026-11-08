import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeStderrEvidence} from '../openclaw/runtime-stderr-evidence.mjs';
import {createRuntimeHealth} from '../openclaw/runtime-health.mjs';

const fatal = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';

test('a complete V8 heap fatal signature split at any byte is recognized only with a terminal abort', () => {
  for (let split = 0; split <= fatal.length; split++) {
    const evidence = createRuntimeStderrEvidence();
    evidence.write(Buffer.from(fatal.slice(0, split))); evidence.write(Buffer.from(fatal.slice(split) + '\n'));
    assert.equal(evidence.forExit(null, 'SIGABRT'), 'JAVASCRIPT_HEAP_OOM');
    assert.equal(evidence.forExit(134, null), 'JAVASCRIPT_HEAP_OOM');
    assert.equal(evidence.forExit(null, 'SIGKILL'), null);
    assert.equal(evidence.forExit(null, 'SIGSEGV'), null);
    assert.equal(evidence.forExit(1, null), null);
  }
});

test('generic abort, worker exit 1 and arbitrary error text never establish a heap OOM', () => {
  for (const text of ['', 'database verification worker exited with code 1\n', 'out of memory\n',
    'provider said: ' + fatal + '\n', '"' + fatal + '"\n', fatal + ' is an example\n',
    'FATAL ERROR: invalid array size\n']) {
    const evidence = createRuntimeStderrEvidence(); evidence.write(text);
    assert.equal(evidence.forExit(null, 'SIGABRT'), null);
  }
});

test('an oversized line is discarded until newline, without accepting its fatal-looking suffix', () => {
  const evidence = createRuntimeStderrEvidence();
  evidence.write('private'.repeat(100000)); evidence.write(fatal + '\n');
  assert.equal(evidence.forExit(null, 'SIGABRT'), null);
  evidence.write(fatal + '\r\n');
  assert.equal(evidence.forExit(null, 'SIGABRT'), 'JAVASCRIPT_HEAP_OOM');
  assert.equal(JSON.stringify(evidence).includes('private'), false);
});

test('a final unterminated exact fatal line is valid and known GC variants remain explicit', () => {
  for (const reason of ['Reached heap limit', 'Ineffective mark-compacts near heap limit',
    'MarkCompactCollector: young object promotion failed', 'Scavenger: semi-space copy']) {
    const evidence = createRuntimeStderrEvidence();
    evidence.write(`FATAL ERROR: ${reason} Allocation failed - JavaScript heap out of memory`);
    assert.equal(evidence.forExit(null, 'SIGABRT'), 'JAVASCRIPT_HEAP_OOM');
  }
});

test('health retains only fixed evidence after an abort and cannot promote a bare signal or stale generation', () => {
  const health = createRuntimeHealth(); health.starting(1); health.ready(1);
  health.exited(1, null, 'SIGABRT', 'JAVASCRIPT_HEAP_OOM');
  assert.equal(health.snapshot(false).failureCode, 'OPENCLAW_MEMORY_EXHAUSTED');
  assert.equal(health.snapshot(false).failureEvidence, 'JAVASCRIPT_HEAP_OOM');
  health.failed('OPENCLAW_ENFORCEMENT_UNHEALTHY');
  assert.equal(health.snapshot(false).failureEvidence, 'JAVASCRIPT_HEAP_OOM');
  health.stopping(); health.stopped(); health.starting(2); health.ready(2);
  health.exited(1, null, 'SIGABRT', 'JAVASCRIPT_HEAP_OOM');
  assert.equal(health.snapshot(true, true).failureEvidence, null);
  health.exited(2, null, 'SIGABRT', 'private-secret');
  assert.equal(health.snapshot(false).failureCode, 'OPENCLAW_PROCESS_EXITED');
  assert.equal(JSON.stringify(health.snapshot(false)).includes('private-secret'), false);
});

test('even a fatal signature cannot reclassify SIGKILL or intentional shutdown as confirmed allocation failure', () => {
  const killed = createRuntimeHealth(); killed.starting(1); killed.ready(1);
  killed.exited(1, null, 'SIGKILL', 'JAVASCRIPT_HEAP_OOM');
  assert.equal(killed.snapshot(false).failureCode, 'OPENCLAW_PROCESS_KILLED');
  assert.equal(killed.snapshot(false).failureEvidence, null);
  const stopped = createRuntimeHealth(); stopped.starting(1); stopped.ready(1); stopped.stopping();
  stopped.exited(1, null, 'SIGABRT', 'JAVASCRIPT_HEAP_OOM');
  assert.equal(stopped.snapshot(false).failureCode, null);
});

test('stderr delivered after exit can refine that unexpected abort through cleanup, but never a newer process', () => {
  const health = createRuntimeHealth(); health.starting(1); health.ready(1);
  health.exited(1, null, 'SIGABRT'); health.stopping(); health.stopped();
  health.terminalStderr(1, 'JAVASCRIPT_HEAP_OOM');
  assert.equal(health.snapshot(false).failureCode, 'OPENCLAW_MEMORY_EXHAUSTED');
  assert.equal(health.snapshot(false).lastExit.expected, false);
  health.starting(2); health.ready(2); health.terminalStderr(1, 'JAVASCRIPT_HEAP_OOM');
  assert.equal(health.snapshot(true, true).failureCode, null);
});
