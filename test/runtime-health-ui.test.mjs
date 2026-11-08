import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createRuntimeHealthDisplay} from '../public/runtime-health.js';

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const apiSource = app.slice(app.indexOf('async function api('), app.indexOf('function toast('));
const stateSource = app.slice(app.indexOf('function applyState('), app.indexOf('async function refreshState('));
const ready = revision => ({backend: 'openclaw', running: true, healthy: true, enforcementHealthy: true,
  healthState: 'ready', healthRevision: revision, generation: 1, version: 'fixture-version'});
const dead = revision => ({...ready(revision), running: false, healthy: false, enforcementHealthy: false,
  healthState: 'unhealthy', failureCode: 'OPENCLAW_PROCESS_KILLED'});
const response = (body, status = 200) => ({ok: status < 400, status, json: async () => body});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };

function fixture() {
  const nodes = new Map(), routes = new Map(); let updates = 0, toolContext;
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {textContent: '', title: '', classList: {toggle(name, on) {if (on) classes.add(name); else classes.delete(name);}, contains: name => classes.has(name)}});
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    runtimeHealthDisplay: createRuntimeHealthDisplay(), state: {agent: {id: 'fixture-agent'}, settings: {}},
    token: 'fixture-session', localBridgePage: true, selectedBridgePort: 8790,
    location: {origin: 'http://127.0.0.1:8790'}, bridgeApiUrl: route => route,
    fetch: route => routes.get(route)(), $: node, setupWizard: {update() {updates++;}},
    cognition: () => ({mode: 'active'}), nativePanel: {syncConnection(value) {toolContext = value;}},
    clearLocalSession() {throw new Error('Unexpected session clearing');},
    DEFAULT_SETTINGS: {continuum: {}}, DEFAULT_COGNITION: {}, agentId: () => 'fixture-agent',
    normalizeCognition: value => value, renderState() {},
  });
  vm.runInContext(apiSource + '\n' + stateSource + '\nglobalThis.call = api; globalThis.apply = applyState; globalThis.snapshot = () => state;', context);
  return {call: context.call, apply: context.apply, snapshot: context.snapshot, node,
    respond(route, body, status) {routes.set(route, () => Promise.resolve(response(body, status)));},
    pending(route) {const pending = deferred(); routes.set(route, () => pending.promise); return pending;},
    updates: () => updates, toolContext: () => toolContext};
}

test('actual app API and full-state merge cannot restore a dead gateway from a late healthy response', async () => {
  const app = fixture();
  app.respond('/initial', {agent: {id: 'fixture-agent'}, executionRuntime: ready(1)});
  app.apply(await app.call('/initial'));
  assert.equal(app.node('bridgeDot').classList.contains('online'), true);
  assert.equal(app.toolContext().runtimeReady, true);
  const stale = app.pending('/old-state'), oldRequest = app.call('/old-state');
  app.respond('/api/activity', {activity: {}, executionRuntime: dead(2)});
  await app.call('/api/activity');
  assert.equal(app.snapshot().executionRuntime.healthy, false);
  assert.equal(app.node('bridgeDot').classList.contains('online'), false);
  assert.equal(app.toolContext().runtimeReady, false);
  assert.match(app.node('runtimeHealthNotice').textContent, /does not confirm an out-of-memory kill/);
  const beforeLate = app.updates();
  stale.resolve(response({agent: {id: 'fixture-agent'}, executionRuntime: ready(1)}));
  app.apply(await oldRequest);
  assert.equal(app.snapshot().executionRuntime.running, false);
  assert.equal(app.snapshot().executionRuntime.healthy, false);
  assert.equal(app.node('bridgeStatus').textContent, 'OPENCLAW PROCESS KILLED');
  assert.equal(app.updates(), beforeLate);
  app.respond('/recovered', {executionRuntime: {...ready(3), generation: 2}});
  await app.call('/recovered');
  assert.equal(app.snapshot().executionRuntime.healthy, true);
  assert.equal(app.node('bridgeStatus').textContent, 'OPENCLAW READY');
  assert.equal(app.toolContext().runtimeReady, true);
});

test('actual app transport failure invalidates setup readiness while late failures cannot erase recovery', async () => {
  const app = fixture();
  app.respond('/initial', {executionRuntime: ready(1)}); await app.call('/initial');
  const old = app.pending('/old'), pending = app.call('/old');
  app.respond('/fresh', {executionRuntime: ready(2)}); await app.call('/fresh');
  old.reject(new TypeError('private transport detail'));
  await assert.rejects(pending);
  assert.equal(app.snapshot().executionRuntime.healthy, true);
  const current = app.pending('/lost'), lost = app.call('/lost');
  const before = app.updates(); current.reject(new TypeError('private transport detail'));
  await assert.rejects(lost);
  assert.equal(app.snapshot().executionRuntime.healthy, false);
  assert.equal(app.snapshot().executionRuntime.enforcementHealthy, false);
  assert.equal(app.node('bridgeStatus').textContent, 'LOCAL APP UNREACHABLE');
  assert.equal(app.updates(), before + 1);
  assert.doesNotMatch(app.node('runtimeHealthNotice').textContent, /private transport detail/);
});

test('actual app native failure invalidates readiness; provider failure leaves verified runtime health intact', async () => {
  const app = fixture();
  app.respond('/ready', {executionRuntime: ready(1)}); await app.call('/ready');
  app.respond('/provider', {code: 'PROVIDER_TIMEOUT', error: 'Provider timed out'}, 504);
  await assert.rejects(app.call('/provider'), {code: 'PROVIDER_TIMEOUT'});
  assert.equal(app.snapshot().executionRuntime.healthy, true);
  app.respond('/native', {code: 'OPENCLAW_ENFORCEMENT_UNHEALTHY', error: 'Mandatory review unavailable'}, 503);
  await assert.rejects(app.call('/native'), {code: 'OPENCLAW_ENFORCEMENT_UNHEALTHY'});
  assert.equal(app.snapshot().executionRuntime.healthy, false);
  assert.equal(app.node('bridgeStatus').textContent, 'POI RUNTIME UNHEALTHY');
  assert.equal(app.node('bridgeDot').classList.contains('online'), false);
});
