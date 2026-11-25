import test from 'node:test';
import assert from 'node:assert/strict';
import { chatToolAccess, chatToolActivity, hostToolChoices } from '../public/chat-tools.js';

const agent = { connected: true, agentId: 'selected', agentName: 'Selected', runtimeReady: true, modelConfigured: true };
const snapshot = {
  toolCatalogue: ['read', 'exec', { name: 'browser', available: true }, { name: 'offline', available: false }],
  toolAuthority: { grant: { enabled: true, acknowledged: true, tools: ['read', 'exec', 'browser'],
    roots: ['private-directory'], networkHosts: ['docs.example.com'], allowExecution: true } },
  browserRuntime: { state: 'available' },
};

test('a moved directory is indicated without exposing its path or losing independent grants', () => {
  const unavailable = { ...snapshot, toolDirectories: { available: 0, unavailable: 1 } };
  const view = chatToolAccess(unavailable, agent);
  assert.equal(view.status, 'Project directory needs attention');
  assert.match(view.detail, /1 saved project directory is unavailable or changed/);
  assert.match(view.detail, /Shell and process execution grant on/);
  assert.match(view.detail, /Update the paths and apply permissions in Tool access/);
  assert.doesNotMatch(view.detail, /private-directory/);
  assert.equal(chatToolActivity({ events: [{ ability: 'tool', status: 'held',
    label: 'An approved project directory is unavailable or changed. Update the directory and apply permissions in Tool access.' }] }, true),
  'Project directory needs attention · open Tool access');
});

test('saved tool grants are separate from runtime health, memory pause, executable discovery and host scope', () => {
  assert.equal(chatToolAccess(snapshot, agent).status, '3 tool grants saved');
  assert.equal(chatToolAccess(snapshot, { ...agent, runtimeReady: false }).status, 'Grants saved · runtime unavailable');
  assert.equal(chatToolAccess(snapshot, { ...agent, memoryPaused: true }).status, 'Tools paused with memory');
  assert.equal(chatToolAccess(snapshot, { ...agent, chainHeld: true }).status, 'Tools held for chain review');
  assert.match(chatToolAccess(snapshot, { ...agent, memoryPaused: true }).detail, /Resume Timechain to use tools; applying permissions does not resume it/);
  assert.match(chatToolAccess(snapshot, { ...agent, chainHeld: true }).detail, /Resolve the chain hold/);
  assert.equal(chatToolAccess(snapshot, { ...agent, learning: false }).status, '3 tool grants saved', 'Disabling learning alone does not pause admitted tools.');
  assert.equal(chatToolAccess(null, agent).status, 'Tool status unavailable');
  assert.equal(chatToolAccess(snapshot, { ...agent, agentId: '' }).status, 'Select a Timechain');
  assert.doesNotMatch(chatToolAccess(snapshot, agent).detail, /private-directory|docs\.example\.com/);
  assert.equal(chatToolAccess({ ...snapshot, browserRuntime: { state: 'not-installed' } }, agent).status, 'Some tool grants need setup');
  assert.equal(chatToolAccess({ ...snapshot, runtime: { hostTools: 'disabled' } }, agent).status, 'Some tool grants need setup');
  const onlyFileScope = { ...snapshot, toolAuthority: { grant: { ...snapshot.toolAuthority.grant, allowExecution: false } } };
  assert.equal(chatToolAccess(onlyFileScope, agent).status, 'Some tool grants need setup');
  assert.match(chatToolAccess(onlyFileScope, agent).detail, /execution grant off/);
  assert.equal(hostToolChoices(snapshot).find(tool => tool.name === 'offline').available, false);
});

test('tool activity separates approval from observed completion and expires across runs or stale polls', () => {
  const approval = { ability: 'gate', status: 'completed', label: 'PoI approved exec; native execution may now begin' };
  const result = { ability: 'tool', status: 'completed', label: 'Tool exec completed' };
  const activity = { events: [approval] };
  assert.equal(chatToolActivity(activity, true), 'exec · approved for execution');
  assert.equal(chatToolActivity({ events: [approval, result] }, true), 'exec · tool result received');
  assert.equal(chatToolActivity({ events: [result, { ability: 'operation', status: 'started' }] }, true), '');
  assert.equal(chatToolActivity({ events: [result] }, false), '');
  assert.equal(chatToolActivity({ events: [{ ...result, label: 'Tool exec completed with private output' }] }, true), '');
  assert.equal(chatToolActivity({ events: [{ ...result, status: 'failed', label: 'Tool exec failed' }] }, true), 'exec · tool reported failure');
  assert.equal(chatToolActivity({ events: [{ ...result, status: 'started', label: 'Tool image_generate started' }] }, true), 'image_generate · tool started');
});

test('additional native grants never imply an exec or scoped filesystem grant', () => {
  const nativeOnly = { toolCatalogue: snapshot.toolCatalogue, toolAuthority: { grant: {
    enabled: false, tools: [], roots: [], networkHosts: [], allowExecution: false, acknowledged: false,
    nativeCapabilities: { enabled: true, acknowledged: true, tools: ['sessions_list'], settings: ['messages.queue'] },
  } } };
  const view = chatToolAccess(nativeOnly, agent);
  assert.equal(view.status, 'Native grants only · exec off');
  assert.match(view.detail, /0 file, shell and network tool grants, 1 additional native tool grants/);
  assert.match(view.detail, /execution grant off/);
  assert.match(view.detail, /Additional OpenClaw tools or settings do not enable the separate read, write, edit, exec/);
  assert.equal(hostToolChoices(nativeOnly).some(tool => tool.selected), false);
});
