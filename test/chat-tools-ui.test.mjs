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

test('saved tool grants are separate from runtime health, memory pause, executable discovery and host scope', () => {
  assert.equal(chatToolAccess(snapshot, agent).status, '3 tool grants saved');
  assert.equal(chatToolAccess(snapshot, { ...agent, runtimeReady: false }).status, 'Grants saved · runtime unavailable');
  assert.equal(chatToolAccess(snapshot, { ...agent, memoryPaused: true }).status, 'Tools paused with memory');
  assert.equal(chatToolAccess(snapshot, { ...agent, chainHeld: true }).status, 'Tools held for chain review');
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
