import test from 'node:test';
import assert from 'node:assert/strict';
import { controlSessionKey, createNativeControls, validateControlPatch, redactNativeControl, nativeConfigSections, readControlOverlay } from '../lib/openclaw-controls.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const identity = { agentId: 'paired-agent', genesisHash: 'a'.repeat(64) };
function fixture(entry = null) {
  const calls = [], key = controlSessionKey(identity);
  let overlay = { patch: {}, revision: 'r1' };
  const controls = createNativeControls({
    getRuntime: () => ({ hostTools: 'disabled' }), readOverlay: async () => overlay,
    applyOverlay: async patch => calls.push(['apply', patch]),
    saveOverlay: async patch => (overlay = { patch, revision: 'r2' }),
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (method === 'sessions.describe') return { session: entry ? { key, ...entry } : null };
      if (method === 'config.schema') return { schema: { properties: { maxTokens: { type: 'number' } } } };
      if (method === 'config.get') return { config: { gateway: { auth: { token: 'private' } }, maxTokens: 123 } };
      if (method === 'commands.list') return { commands: [{ name: 'think' }] };
      return { ok: true };
    },
  });
  return { controls, calls, key };
}

test('configuration guard preserves numeric token budgets and safe native schema documentation', () => {
  const patch = { agents: { defaults: { thinkingDefault: 'high', contextTokens: 32000 } }, messages: { queue: { cap: 25 } } };
  assert.deepEqual(validateControlPatch(patch), patch);
  for (const patch of [{ gateway: { bind: 'lan' } }, { models: {} }, { agents: { defaults: { workspace: '/tmp' } } },
    { agents: { list: [] } }, { agents: null }, { agents: { defaults: [] } }, { ui: { apiKey: 'private' } }, { tools: { profile: 'full' } }])
    assert.throws(() => validateControlPatch(patch), error => error.code === 'OPENCLAW_SETTING_GUARDED');
  const safe = redactNativeControl({ maxTokens: 100, tokenBudget: 200, contextTokens: 300, token: 'private',
    schema: { token: { type: 'string', description: 'A private operator token.' } }, raw: 'known-secret' }, ['known-secret']);
  assert.equal(safe.maxTokens, 100); assert.equal(safe.tokenBudget, 200); assert.equal(safe.contextTokens, 300);
  assert.equal(safe.token, '[managed private value]'); assert.equal(safe.schema.token.type, 'string'); assert.equal(safe.raw, '[private]');
  assert.deepEqual(validateControlPatch({ tools: { profile: 'full' } }, { allowHostConfiguration: true }), { tools: { profile: 'full' } });
  assert.throws(() => validateControlPatch({ tools: { web: { fetch: { maxRedirects: 3 } } } }, { allowHostConfiguration: true }), error => error.code === 'OPENCLAW_SETTING_GUARDED');
  assert.throws(() => validateControlPatch({ browser: { ssrfPolicy: null } }, { allowHostConfiguration: true }), error => error.code === 'OPENCLAW_SETTING_GUARDED');
});

test('the pinned agent roster and authority-bearing settings cannot replace managed chain admission', () => {
  for (const patch of [{ agents: { entries: { escape: { model: 'unbound/provider', workspace: '/elsewhere' } } } },
    { agents: { entries: null } }, { agents: { defaults: { systemAgent: { agentId: 'escape' } } } },
    { agents: { defaults: { sessionStore: { agentId: 'escape' } } } }, { agents: { defaults: { authInheritance: { agentId: 'escape' } } } },
    { agents: { defaults: { sandbox: { docker: { setupCommand: 'unreviewed process' } } } } },
    { agents: { defaults: { embeddedAgent: { projectSettingsPolicy: 'trusted', cyberFailover: { model: 'unbound/provider' } } } } },
    { agents: { defaults: { elevatedDefault: 'full' } } },
    { agents: { defaults: { models: { route: { agentRuntime: { id: 'unreviewed-harness' } } } } } },
    { agents: { defaults: { compaction: { provider: 'legacy-fallback' } } } },
    { session: { maintenance: { mode: 'enforce' } } }, { memory: { qmd: { command: 'unreviewed-process' } } },
    { browser: { allowSystemProfileImport: true } }, { logging: { redactSensitive: 'off' } },
    { skills: { load: { extraDirs: ['/unreviewed'] } } }])
    for (const allowHostConfiguration of [false, true]) assert.throws(() => validateControlPatch(patch, { allowHostConfiguration }),
      error => error.code === 'OPENCLAW_SETTING_GUARDED', JSON.stringify(patch));
});

test('native settings inventory includes every schema family with explicit editable or managed classification', async () => {
  const roots = ['agents', 'messages', 'tts', 'mcp', 'desktop', 'cloudWorkers', 'storage', 'gateway', 'channels', 'plugins'];
  const sections = nativeConfigSections({ schema: { properties: Object.fromEntries(roots.map(key => [key, { type: 'object' }])) } });
  assert.deepEqual(sections.map(section => section.key), roots.toSorted());
  assert.equal(sections.find(section => section.key === 'gateway').classification, 'supervisor-owned');
  assert.equal(sections.find(section => section.key === 'messages').classification, 'editable');
  assert.equal(sections.find(section => section.key === 'mcp').classification, 'managed');
  assert.ok(sections.find(section => section.key === 'agents').guardedPaths.includes('agents.entries'));
  assert.ok(sections.every(section => typeof section.reason === 'string' && section.reason.length > 0));
  const snapshot = await fixture().controls.describeControls(identity);
  assert.equal(snapshot.contextPolicy.mode, 'reviewed-native-compaction');
  assert.equal(snapshot.contextPolicy.automaticSummary, true); assert.equal(snapshot.contextPolicy.storedHistory, 'preserved');
  assert.equal(snapshot.contextPolicy.retainedRecentTurns, 2);
  assert.equal(snapshot.contextPolicy.manualSummary, 'reviewed-optional');
  assert.ok(Array.isArray(snapshot.config.sections));
});

test('controls select only the verified chain and project no held conversation preview', async () => {
  const f = fixture({ sessionId: 's1', goal: { id: 'g1', tokenBudget: 500 }, lastMessage: 'held response', preview: 'held', thinkingLevel: 'high' });
  const state = await f.controls.sessionControls(identity);
  assert.equal(state.sessionKey, f.key); assert.equal(state.session.thinkingLevel, 'high');
  assert.equal(state.goal.tokenBudget, 500); assert.equal(JSON.stringify(state).includes('held'), false);
  assert.deepEqual(await f.controls.sessionControls(null), { sessionKey: null, session: null, goal: null });
  assert.throws(() => controlSessionKey({ ...identity, genesisHash: 'invalid' }));
});

test('native slash preferences are real schema-backed mutations with session race protection', async () => {
  const f = fixture({ sessionId: 's1' });
  await f.controls.executeCommand({ ...identity, command: '/thinking high' });
  assert.deepEqual(f.calls.at(-1), ['sessions.patch', { key: f.key, expectedSessionId: 's1', thinkingLevel: 'high' }]);
  await f.controls.executeCommand({ ...identity, command: '/fast ultrafast' });
  assert.equal(f.calls.at(-1)[1].fastMode, 'ultrafast');
  await f.controls.executeCommand({ ...identity, command: '/reason default' });
  assert.equal(f.calls.at(-1)[1].reasoningLevel, null);
  await assert.rejects(f.controls.executeCommand({ ...identity, command: '/queue collect' }), error => error.code === 'OPENCLAW_COMMAND_GUARDED');
  assert.deepEqual(await f.controls.executeCommand({ ...identity, command: '/compact custom instructions' }),
    { kind: 'compaction', sessionKey: f.key, instructions: 'custom instructions' });
});

test('goal start and resume return only trusted native run plans; pause invokes durable goal RPC', async () => {
  const fresh = fixture();
  const start = await fresh.controls.executeCommand({ ...identity, command: '/goal start Investigate the example' });
  assert.equal(start.kind, 'turn'); assert.equal(start.message, 'Investigate the example');
  assert.equal(start.native.intent.kind, 'session-goal-start');
  assert.equal(fresh.calls.some(([method]) => method === 'chat.send'), false);
  const existing = fixture({ sessionId: 's1', goal: { id: 'g1', status: 'paused', objective: 'Investigate' } });
  const resume = await existing.controls.executeCommand({ ...identity, command: '/goal resume' });
  assert.equal(resume.native.goalOperation.action, 'resume'); assert.equal(resume.native.goalOperation.goalId, 'g1');
  await existing.controls.executeCommand({ ...identity, command: '/goal pause Stop now' });
  assert.equal(existing.calls.at(-1)[0], 'sessions.goal.update'); assert.equal(existing.calls.at(-1)[1].note, 'Stop now');
});

test('settings concurrency and guard failures never apply native configuration', async () => {
  const f = fixture();
  await assert.rejects(f.controls.updateControls({ revision: 'old', patch: { ui: {} } }), error => error.code === 'OPENCLAW_CONFIG_STALE');
  await assert.rejects(f.controls.updateControls({ revision: 'r1', patch: { gateway: {} } }), error => error.code === 'OPENCLAW_SETTING_GUARDED');
  assert.equal(f.calls.length, 0);
  const result = await f.controls.updateControls({ revision: 'r1', patch: { messages: { queue: { cap: 25 } } } });
  assert.equal(result.config.revision, 'r2'); assert.equal(f.calls[0][0], 'apply');
});

test('owner native setting paths remove adapter-only blocks without widening sibling paths', () => {
  const nativeCapabilities = { enabled: true, acknowledged: true, settings: ['cron.enabled', 'agents.defaults.subagents.maxChildren', 'mcp.servers'] };
  const patch = { cron: { enabled: true }, agents: { defaults: { subagents: { maxChildren: 2 } } }, mcp: { servers: {} } };
  assert.deepEqual(validateControlPatch(patch, { nativeCapabilities }), patch);
  for (const patch of [{ cron: { enabled: true, store: '/other' } }, { mcp: { secretValue: 'unadmitted' } },
    { agents: { defaults: { subagents: { maxChildren: 2, allowAgents: ['other'] } } } }])
    assert.throws(() => validateControlPatch(patch, { nativeCapabilities }), { code: 'OPENCLAW_SETTING_GUARDED' }, JSON.stringify(patch));
  assert.equal(nativeConfigSections({ properties: { cron: {}, mcp: {} } }, { nativeCapabilities })[0].classification, 'owner-admitted');
});

test('broad native owner consent cannot replace enforcement, credentials or owned browser transport', () => {
  const nativeCapabilities = { enabled: true, acknowledged: true, settings: ['*'] };
  const allowed = { plugins: { entries: { trustedCalendar: { config: { displayStyle: 'compact' } } } } };
  assert.deepEqual(validateControlPatch(allowed, { nativeCapabilities }), allowed);
  for (const patch of [{ plugins: { enabled: false } }, { plugins: { slots: { contextEngine: 'other' } } },
    { plugins: { allow: ['other'] } }, { plugins: { entries: { 'cypher-tempre-poi': { config: {} } } } },
    { plugins: { entries: { browser: { config: {} } } } }, { plugins: { entries: { trustedCalendar: { enabled: true } } } },
    { plugins: { entries: { trustedCalendar: null } } }, { models: {} }, { gateway: { auth: { token: 'private' } } },
    { agents: { defaults: { workspace: '/other', compaction: { provider: 'legacy' } } } },
    { browser: { cdpUrl: 'http://127.0.0.1:9222', noSandbox: true } }, { mcp: { apiKey: 'private' } }])
    assert.throws(() => validateControlPatch(patch, { nativeCapabilities }), { code: 'OPENCLAW_SETTING_GUARDED' }, JSON.stringify(patch));
});

test('private current capability resolver wins over stale update snapshots', async () => {
  let enabled = true, applied = 0;
  const controls = createNativeControls({ nativeCapabilities: async () => ({ enabled, acknowledged: enabled, settings: ['cron.enabled'] }),
    readOverlay: async () => ({ revision: 'r1', patch: {} }), applyOverlay: async () => { applied++; },
    saveOverlay: async patch => ({ revision: 'r2', patch }) });
  await controls.updateControls({ ...identity, revision: 'r1', patch: { cron: { enabled: true } } });
  enabled = false;
  await assert.rejects(controls.updateControls({ ...identity, revision: 'r1', patch: { cron: { enabled: true } },
    authority: { nativeCapabilities: { enabled: true, acknowledged: true, settings: ['*'] } } }), { code: 'OPENCLAW_SETTING_GUARDED' });
  assert.equal(applied, 1);
});

test('approved native configuration survives restart without persisting execution authority', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-overlay-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const patch = { cron: { enabled: true }, mcp: { servers: {} } };
  await fs.writeFile(path.join(directory, 'controls.json'), JSON.stringify({ version: 1, revision: 'a'.repeat(64), patch }));
  assert.deepEqual((await readControlOverlay(directory)).patch, patch);
  await fs.writeFile(path.join(directory, 'controls.json'), JSON.stringify({ version: 1, revision: 'a'.repeat(64), patch: { plugins: { enabled: false } } }));
  await assert.rejects(readControlOverlay(directory), { code: 'OPENCLAW_SETTING_GUARDED' });
});

test('native settings cannot bypass the reviewed skill library, including a previous stored overlay', async t => {
  const options = { nativeCapabilities: { enabled: true, acknowledged: true, settings: ['*'] } };
  const defaults = { thinkingDefault: 'high', skills: ['ambient'] };
  const list = [{ id: 'main', skills: ['ambient'] }];
  const entries = { other: { skills: ['ambient'] } };
  const skills = { load: { extraDirs: ['/unreviewed'] } };
  for (const patch of [{ skills }, { agents: { defaults } }, { agents: { list } }, { agents: { entries } }])
    assert.throws(() => validateControlPatch(patch, options), { code: 'OPENCLAW_SETTING_GUARDED' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-legacy-skill-overlay-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'controls.json');
  const revision = 'b'.repeat(64);
  const stored = JSON.stringify({ version: 1, revision, patch: { skills, agents: { defaults, list, entries } } });
  await fs.writeFile(file, stored);
  assert.deepEqual(await readControlOverlay(directory), { revision,
    patch: { agents: { defaults: { thinkingDefault: 'high' }, list: [{ id: 'main' }], entries: { other: {} } } } });
  assert.equal(await fs.readFile(file, 'utf8'), stored);
});

test('tool discovery uses the actual native catalogue and saved-session preview without granting tools', async () => {
  const calls = [], controls = createNativeControls({ rpc: async (method, params) => {
    calls.push([method, params]);
    if (method === 'sessions.describe') return { session: null };
    if (method === 'tools.catalog') return { agentId: 'main', profiles: [], groups: [{ source: 'core', tools: [{ id: 'sessions_spawn', label: 'Spawn' }] }] };
    if (method === 'tools.effective') return { entries: [{ id: 'mcp_calendar_search', source: 'mcp' }, { id: 'invalid\n', source: 'plugin' }] };
    throw new Error('Unexpected native method.');
  } });
  const result = await controls.toolCatalogue(identity);
  assert.deepEqual(result.tools.map(tool => tool.name), ['sessions_spawn', 'mcp_calendar_search']);
  assert.match(result.notice, /does not grant tools/);
  assert.deepEqual(calls.find(([method]) => method === 'tools.catalog')[1], { agentId: 'main', includePlugins: true });
  assert.deepEqual(calls.find(([method]) => method === 'tools.effective')[1], { sessionKey: controlSessionKey(identity) });
});


test('native media defaults require an actual native selection and exact owner setting admission', () => {
  const patch={agents:{defaults:{imageModel:{primary:'native/vision'},voiceModel:'native/voice',pdfModel:'native/pdf',mediaModels:{image:'native/vision'}}}};
  const nativeCapabilities={enabled:true,acknowledged:true,settings:['agents.defaults.imageModel','agents.defaults.voiceModel','agents.defaults.pdfModel','agents.defaults.mediaModels']};
  assert.deepEqual(validateControlPatch(patch,{nativeProvider:true,nativeCapabilities}),patch);
  assert.throws(()=>validateControlPatch(patch,{nativeProvider:false,nativeCapabilities}));
  assert.throws(()=>validateControlPatch(patch,{nativeProvider:true,nativeCapabilities:{...nativeCapabilities,settings:[]}}));
  assert.throws(()=>validateControlPatch({agents:{defaults:{model:{primary:'unreviewed/replacement'}}}},{nativeProvider:true,nativeCapabilities:{...nativeCapabilities,settings:['*']}}));
});

test('actual grouped effective inventory exposes synthesized native controls without inventing or granting names',async()=>{
  const controls=createNativeControls({rpc:async method=>{
    if(method==='sessions.describe')return {session:{sessionId:'existing-native-session'}};
    if(method==='tools.catalog')return {groups:[{tools:[{id:'read'}]}]};
    if(method==='tools.effective')return {groups:[{source:'core',tools:[{id:'dispatch_action',label:'Dispatch action'},{id:'tool_search'}]}]};
    throw new Error('Unexpected RPC.');
  }});
  const result=await controls.toolCatalogue(identity);
  assert.deepEqual(result.tools.map(tool=>tool.name),['read','dispatch_action','tool_search']);
});

test('separate native utility and embedding routes require explicit owner setting consent and exclude raw credential headers',()=>{
  const patch={agents:{defaults:{utilityModel:'native/owner-selected-utility'}},memory:{search:{enabled:true,provider:'openai'}}};
  assert.throws(()=>validateControlPatch(patch),{code:'OPENCLAW_SETTING_GUARDED'});
  const nativeCapabilities={enabled:true,acknowledged:true,settings:['agents.defaults.utilityModel','memory.search']};
  assert.deepEqual(validateControlPatch(patch,{nativeCapabilities}),patch);
  assert.deepEqual(validateControlPatch({agents:{defaults:{utilityModel:''}},memory:{search:{enabled:false}}},{nativeCapabilities}),
    {agents:{defaults:{utilityModel:''}},memory:{search:{enabled:false}}});
  for(const key of ['apiKey','Authorization','Proxy-Authorization','X-API-Key'])assert.throws(()=>validateControlPatch({memory:{search:{remote:{headers:{[key]:'must-not-be-stored'}}}}},{nativeCapabilities}),{code:'OPENCLAW_SETTING_GUARDED'});
});
