import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createRuntimeHealth} from '../openclaw/runtime-health.mjs';
import {createRuntimeHealthDisplay} from '../public/runtime-health.js';
import {createOpenClawGateway, OPENCLAW_VERSION} from '../openclaw/gateway.mjs';
import {createApp} from '../server.mjs';
import {chatFailure} from '../public/chat-errors.js';

const paired = {paired: true, local: true};
const ready = (revision = 1) => ({backend: 'openclaw', running: true, healthy: true,
  enforcementHealthy: true, healthState: 'ready', healthRevision: revision, generation: 1});

test('runtime readiness requires both admitted startup and a current authenticated control client', () => {
  const health = createRuntimeHealth();
  assert.equal(health.snapshot(false).healthy, false);
  health.starting(1);
  assert.equal(health.snapshot(true, true).healthy, false);
  health.ready(1);
  assert.equal(health.snapshot(true, true).healthy, true);
  assert.equal(health.snapshot(true, false).healthy, false);
  assert.equal(health.snapshot(true, false).failureCode, 'OPENCLAW_CONTROL_CLOSED');
});

test('an unexpected SIGKILL is reported as killed, never inferred to be an OOM or corrupt database', () => {
  const health = createRuntimeHealth(); health.starting(1); health.ready(1);
  health.exited(1, null, 'SIGKILL');
  const state = health.snapshot(false);
  assert.equal(state.failureCode, 'OPENCLAW_PROCESS_KILLED');
  assert.deepEqual(state.lastExit, {generation: 1, code: null, signal: 'SIGKILL', expected: false});
  const view = createRuntimeHealthDisplay(); view.observe({backend: 'openclaw', running: false, ...state});
  assert.equal(view.view(paired).online, false);
  assert.match(view.view(paired).detail, /does not confirm an out-of-memory kill/);
  assert.doesNotMatch(view.view(paired).label, /MEMORY EXHAUSTED|CORRUPT/);
});

test('specific allocation failure survives later exit/fail-stop while intentional shutdown is not an OOM', () => {
  const health = createRuntimeHealth(); health.starting(1);
  health.failed('OPENCLAW_MEMORY_EXHAUSTED', 1); health.exited(1, 1, null);
  health.failed('OPENCLAW_START_FAILED', 1); health.stopping(); health.exited(1, null, 'SIGKILL'); health.stopped();
  assert.equal(health.snapshot(false).failureCode, 'OPENCLAW_MEMORY_EXHAUSTED');
  const normal = createRuntimeHealth(); normal.starting(1); normal.ready(1); normal.stopping(); normal.exited(1, null, 'SIGKILL');
  assert.equal(normal.snapshot(false).failureCode, null);
  assert.equal(normal.snapshot(false).lastExit.expected, true);
});

test('stale lifecycle events cannot overwrite a new generation; a pre-spawn failure can be retried explicitly', () => {
  const health = createRuntimeHealth(); health.starting(1); health.failed('OPENCLAW_START_FAILED'); health.stopping(); health.stopped();
  health.starting(1); health.ready(1); assert.equal(health.snapshot(true, true).healthy, true);
  health.stopping(); health.exited(1, 0, null); health.starting(2); health.ready(2);
  health.exited(1, null, 'SIGKILL'); health.failed('OPENCLAW_MEMORY_EXHAUSTED', 1);
  assert.equal(health.snapshot(true, true).healthy, true);
  assert.equal(health.snapshot(true, true).failureCode, null);
});

test('public health contains fixed enums and numbers and drops arbitrary private diagnostics', () => {
  const health = createRuntimeHealth(); health.starting(1); health.failed('private-api-key'); health.exited(1, 'private-api-key', 'private-api-key');
  assert.equal(JSON.stringify(health.snapshot(false)).includes('private-api-key'), false);
  const monitor = createRuntimeHealthDisplay(); monitor.observe({...ready(), apiKey: 'private-api-key', failureCode: 'private-api-key'});
  assert.equal(JSON.stringify(monitor.view(paired)).includes('private-api-key'), false);
});

test('a paired token or a live process without health confirmation cannot turn the badge green', () => {
  const monitor = createRuntimeHealthDisplay();
  assert.equal(monitor.view(paired).online, false);
  monitor.observe({backend: 'openclaw', running: false});
  assert.equal(monitor.view(paired).label, 'OPENCLAW STOPPED');
  monitor.observe({backend: 'openclaw', running: true});
  assert.equal(monitor.view(paired).online, false);
  monitor.observe(ready()); assert.equal(monitor.view(paired).label, 'OPENCLAW READY');
});

test('late poll responses and late transport failures cannot restore or erase a newer health observation', () => {
  const monitor = createRuntimeHealthDisplay(), oldRequest = monitor.revision;
  monitor.observe(ready());
  assert.equal(monitor.unavailable(oldRequest), false);
  const oldPoll = monitor.revision;
  monitor.failed('OPENCLAW_ENFORCEMENT_UNHEALTHY');
  assert.equal(monitor.observe(ready(), oldPoll), false);
  assert.equal(monitor.view(paired).online, false);
  monitor.observe({...ready(4), running: false, healthy: false, enforcementHealthy: false,
    failureCode: 'OPENCLAW_PROCESS_KILLED', healthState: 'unhealthy'});
  assert.equal(monitor.view(paired).label, 'OPENCLAW PROCESS KILLED');
  monitor.observe({...ready(5), generation: 2}); assert.equal(monitor.view(paired).online, true);
  assert.equal(monitor.observe(ready(4)), false);
});

test('lost app transport remains distinct from provider failure and a chain-worker failure needs actual engine recovery', () => {
  const monitor = createRuntimeHealthDisplay(); monitor.observe(ready());
  assert.equal(monitor.failed('PROVIDER_TIMEOUT'), false);
  assert.equal(monitor.view(paired).online, true);
  monitor.unavailable(); assert.equal(monitor.view(paired).label, 'LOCAL APP UNREACHABLE');
  monitor.observe(ready(2)); assert.equal(monitor.view(paired).online, true);
  monitor.failed('ENGINE_TIMEOUT'); monitor.observe(ready(3));
  assert.equal(monitor.view(paired).label, 'AGENT ENGINE UNAVAILABLE');
  monitor.observe(ready(4), monitor.revision, {agentVerified: true}); assert.equal(monitor.view(paired).online, true);
  monitor.reset(); assert.equal(monitor.view(paired).online, false);
});

test('memory, kill and exit error cards use causal fixed messages without changing PoI decisions', () => {
  assert.equal(chatFailure({code: 'OPENCLAW_MEMORY_EXHAUSTED'}).title, 'LOCAL MEMORY EXHAUSTED');
  assert.match(chatFailure({code: 'OPENCLAW_PROCESS_KILLED'}).message, /does not confirm an out-of-memory kill/);
  assert.match(chatFailure({code: 'OPENCLAW_PROCESS_EXITED'}).message, /does not establish database corruption/);
  assert.equal(chatFailure({code: 'POI_REJECTED'}).kind, 'gate');
});

class Child extends EventEmitter {
  constructor() { super(); this.exitCode = null; this.signalCode = null; this.connected = false; this.stdout = new PassThrough(); this.stderr = new PassThrough(); }
  kill(signal) { this.signalCode = signal; this.emit('exit', null, signal); return true; }
}
for (const [failure, expected] of [['killed', 'OPENCLAW_PROCESS_KILLED'], ['allocation', 'OPENCLAW_MEMORY_EXHAUSTED'], ['exit1', 'OPENCLAW_PROCESS_EXITED'],
  ['heap', 'OPENCLAW_MEMORY_EXHAUSTED'], ['late-heap', 'OPENCLAW_MEMORY_EXHAUSTED'], ['stdout-heap', 'OPENCLAW_PROCESS_EXITED'], ['abort', 'OPENCLAW_PROCESS_EXITED']]) {
  test(`real gateway lifecycle plumbing surfaces ${failure} without claiming database corruption`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-runtime-health-')), packageRoot = path.join(root, 'package');
    await fs.mkdir(packageRoot); await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({name: 'openclaw', version: OPENCLAW_VERSION}));
    const manager = createOpenClawGateway({stateDir: path.join(root, 'managed'), packageRoot, pluginPath: packageRoot, modelContextTokens: 48000,
      runtimeCompatibilityCheck: async () => {}, broker: {url: 'http://127.0.0.1:3210/v1/enforce', token: 'fixture-private-token', registerInvocation() {}, assertCandidate() {}},
      fetchImpl: async () => new Response(JSON.stringify({ok: false}), {status: 200}),
      spawnImpl() {
        const child = new Child();
        queueMicrotask(() => {
          if (failure === 'allocation') child.emit('error', Object.assign(new Error('private error contents'), {code: 'ENOMEM'}));
          if (failure === 'killed') { child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL'); }
          else if (['heap', 'late-heap', 'stdout-heap', 'abort'].includes(failure)) {
            const signature = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n';
            if (failure === 'late-heap') { child.signalCode = 'SIGABRT'; child.emit('exit', null, 'SIGABRT'); }
            if (failure !== 'abort') {
              const stream = failure === 'stdout-heap' ? child.stdout : child.stderr;
              stream.write(signature.slice(0, 40)); stream.write(signature.slice(40));
            }
            child.signalCode = 'SIGABRT';
            if (failure !== 'late-heap') child.emit('exit', null, 'SIGABRT');
            child.emit('close', null, 'SIGABRT');
          }
          else { child.exitCode = 1; child.emit('exit', 1, null); }
        });
        return child;
      },
    });
    t.after(async () => { await manager.close(); assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, {recursive: true, force: true}); });
    await assert.rejects(manager.start(), {code: expected});
    const state = manager.status();
    assert.equal(state.running, false); assert.equal(state.healthy, false); assert.equal(state.enforcementHealthy, false);
    assert.equal(state.failureCode, expected); assert.equal(JSON.stringify(state).includes('private error contents'), false);
    assert.equal(state.failureEvidence, ['heap', 'late-heap'].includes(failure) ? 'JAVASCRIPT_HEAP_OOM' : failure === 'allocation' ? 'OS_ALLOCATION_FAILURE' : null);
  });
}

test('existing activity polling returns updated runtime health without any new chain/verification worker or start', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-activity-health-'));
  let health = ready(), starts = 0, engineCalls = 0;
  const app = await createApp({dataDir: root, pairingCode: 'HEALTH-FIXTURE', canonicalUpdates: false,
    engine: async () => {engineCalls++; throw new Error('No chain engine belongs in activity polling.');},
    openclaw: {}, openclawFactory: () => ({start: async () => {starts++;}, close: async () => {}, status: () => structuredClone(health)}),
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {await app.closeRuntime(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); assert.ok(root.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, {recursive: true, force: true});});
  const paired = await fetch(base + '/api/pair', {method: 'POST', headers: {origin: base, 'content-type': 'application/json'}, body: JSON.stringify({code: 'HEALTH-FIXTURE'})});
  const {token} = await paired.json();
  const get = async () => (await fetch(base + '/api/activity', {headers: {origin: base, authorization: `Bearer ${token}`}})).json();
  assert.equal((await get()).executionRuntime.healthy, true);
  health = {...ready(2), running: false, healthy: false, enforcementHealthy: false, healthState: 'unhealthy', failureCode: 'OPENCLAW_PROCESS_KILLED'};
  const stopped = await get(); assert.equal(stopped.executionRuntime.running, false); assert.equal(stopped.executionRuntime.failureCode, 'OPENCLAW_PROCESS_KILLED');
  assert.equal(starts, 1); assert.equal(engineCalls, 0);
});
