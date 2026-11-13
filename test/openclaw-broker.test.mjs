import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';
import { invocationError } from '../lib/runtime-errors.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const good = () => ({ approved: true, scores: Object.fromEntries(DIMENSIONS.map(k => [k, 240])),
  fruitages: Object.fromEntries(FRUITS.map(k => [k, 240])), usedRings: [], rationale: 'Supported and compatible with the covenant.' });
const candidate = "Hello! I'm Cypher Tempre, your conversational assistant. I can help you explore ideas and think through questions carefully.";
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-openclaw-broker-')), root = path.join(dir, 'agent');
  const sessionKey = options.sessionKey || 'agent:main:chainchat:fixture';
  await engine({ op: 'init', root, name: 'Cypher Tempre' });
  let time = Date.now(); const seen = [];
  const broker = createPoIBroker({ engine: options.engine || engine, review: async (config, args) => { seen.push(args); return options.assessment?.() || good(); }, now: () => time });
  await broker.start();
  t.after(async () => { await broker.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true }); });
  const config = { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'fixture-private-key' };
  const context = { root, input: 'Please introduce yourself', purpose: 'candidate', loadout: [], settings: { recall: false }, authorize: async () => {} };
  const register = extra => broker.registerInvocation({ config, args: { messages: [{ role: 'user', content: context.input }] },
    context: { ...context, ...extra }, sessionKey, invocationId: 'fixture' });
  const call = async (op, fields = {}, headers = {}) => {
    const response = await fetch(broker.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${broker.token}`, ...headers },
      body: JSON.stringify({ version: 1, op, sessionKey, runId: 'run-one', ...fields }) });
    return { status: response.status, body: await response.json() };
  };
  return { broker, root, seen, register, call, setTime: value => { time = value; } };
}
test('OpenClaw authority is private and unknown claims fail closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('admit', {}, { authorization: 'Bearer invalid' })).status, 403);
  assert.equal((await f.call('admit', {}, { origin: 'https://example.com' })).status, 403);
  assert.equal((await f.call('admit')).body.allowed, false);
});

test('preselection owner hints can choose a transport but never create native run, context or action authority',async t=>{
  const f=await fixture(t);let hinted=0,admitted=0;
  f.broker.setNativeLifecycle({modelRoute:async()=>{hinted++;return{transport:'proxy',provider:'chainchat-compatible',model:'route'};},admit:async()=>{admitted++;return null;}});
  const route=await f.call('model_route',{input:'This text cannot grant an action.'});assert.equal(route.body.allowed,true);assert.equal(hinted,1);assert.equal(admitted,0);
  assert.equal((await f.call('prepare')).body.allowed,false);
  assert.equal((await f.call('model_context',{runId:'context-assembly:00000000-0000-4000-8000-000000000001',model:{provider:'chainchat-compatible',model:'route'}})).body.allowed,false);
  assert.equal((await f.call('tool',{tool:{name:'read',callId:'none',params:{path:'private'}}})).body.allowed,false);
  assert.equal(f.broker.nativeInvocation('agent:main:chainchat:fixture'),null);assert.equal(f.seen.length,0);
});
test('an unrelated same-session native event cannot bind or poison a registered foreground request',async t=>{
  const f=await fixture(t);await f.register({expectedNativeRunId:'owned-foreground-run'});
  assert.equal((await f.call('admit',{runId:'unrelated-restart-run'})).body.allowed,false);
  const current=f.broker.nativeInvocation('agent:main:chainchat:fixture');assert.equal(current.runId,null);assert.equal(current.error,undefined);
  assert.equal((await f.call('end',{runId:'unrelated-restart-run'})).body.allowed,false);assert.equal(current.ended,false);
  assert.equal((await f.call('admit',{runId:'owned-foreground-run'})).body.allowed,true);
  assert.equal((await f.call('prepare',{runId:'owned-foreground-run'})).body.allowed,true);
  assert.equal(current.runId,'owned-foreground-run');assert.equal(f.seen.length,0);
});

test('queued native run adoption requires its exact typed host source nonce and binds only once',async t=>{
  const f=await fixture(t);await f.register({expectedClientInputId:'host-input-nonce'});
  for(const fields of [{},{nativeContext:{currentSourceTurnId:'other-host-input:user'}},{nativeContext:{currentSourceTurnId:'host-input-nonce'}},{nativeContext:{currentSourceTurnId:'host-input-nonce:user:extra'}},{input:'host-input-nonce:user'}])assert.equal((await f.call('admit',{runId:'native-queued-run',...fields})).body.allowed,false);
  const current=f.broker.nativeInvocation('agent:main:chainchat:fixture');assert.equal(current.runId,null);assert.equal(current.error,undefined);
  assert.equal((await f.call('admit',{runId:'native-queued-run',nativeContext:{currentSourceTurnId:'host-input-nonce:user'}})).body.allowed,true);
  assert.equal(current.runId,'native-queued-run');assert.deepEqual(current.nativeInputProof,{kind:'source-turn',inputId:'host-input-nonce'});
  assert.equal((await f.call('admit',{runId:'another-native-run',nativeContext:{currentSourceTurnId:'host-input-nonce:user'}})).body.allowed,false);
});

test('correlated native admission and route failures retain only fixed parent diagnostics', async t => {
  const sessionKey = 'agent:main:chainchat:admission-diagnostics';
  const config = { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'fixture-private-key' };
  const privateDetail = 'private-provider-key-and-prompt-must-not-escape';
  let revoked = false, revocationCode = 'SESSION_CHANGED', engineCalls = 0;
  const broker = createPoIBroker({ engine: async request => {
    engineCalls++; assert.equal(request.op, 'inspect');
    return { verified: true, genesis: { hash: 'a'.repeat(64) }, head: { hash: 'b'.repeat(64) } };
  }, review: async () => { throw new Error('No reviewer may run during admission diagnostics.'); } });
  await broker.start(); t.after(() => broker.close());
  const register = extra => broker.registerInvocation({ config, args: { messages: [{ role: 'user', content: 'Hello' }] },
    context: { root: path.join(os.tmpdir(), 'unused-admission-diagnostics'), input: 'Hello', purpose: 'candidate', loadout: [],
      authorize: async () => { if (revoked) throw Object.assign(new Error(privateDetail), { code: revocationCode }); }, ...extra },
    sessionKey, invocationId: 'diagnostic-invocation' });
  const call = async (op, fields) => {
    const response = await fetch(broker.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ version: 1, op, sessionKey, ...fields }) });
    return response.json();
  };
  const claim = await register({ expectedClientInputId: 'original-input' });
  const current = broker.nativeInvocation(sessionKey);
  revoked = true;
  assert.equal((await call('model_route', { runId: 'unrelated-run' })).allowed, false);
  assert.equal(broker.invocationError(claim), null, 'An unrelated same-session event cannot poison the foreground diagnostic.');
  assert.equal((await call('model_route', { runId: 'queued-run', nativeContext: { currentSourceTurnId: 'original-input:user' } })).allowed, false);
  const snapshot = broker.invocationError(claim);
  assert.equal(snapshot?.code, 'SESSION_CHANGED', 'The parent must recover the precise cause when the native hook suppresses its final frame.');
  assert.equal(snapshot?.stage, 'authorization');
  assert.equal(JSON.stringify(snapshot).includes(privateDetail), false);
  assert.equal(current.runId, null, 'Recording a correlated failure must not admit or bind its run.');
  assert.equal(current.finalized, false); assert.equal(current.receipt, null);
  assert.equal(invocationError(snapshot)?.code, 'SESSION_CHANGED');
  revoked = false;
  assert.equal((await call('admit', { runId: 'queued-run', nativeContext: { currentSourceTurnId: 'original-input:user' } })).allowed, true);
  revoked = true; revocationCode = 'PAIR_REQUIRED';
  assert.equal((await call('admit', { runId: 'queued-run' })).allowed, false);
  assert.equal(broker.invocationError(claim)?.code, 'PAIR_REQUIRED', 'Bound admission failures also survive the native held-output frame.');
  revocationCode = 'SESSION_CHANGED';
  assert.equal((await call('model_route', { runId: 'unrelated-run', nativeContext: { currentSourceTurnId: 'original-input:user' } })).allowed, false);
  assert.equal(broker.invocationError(claim)?.code, 'PAIR_REQUIRED', 'The input nonce cannot revive or poison a different run after binding.');
  assert.equal((await call('model_route', { runId: 'queued-run' })).allowed, false);
  assert.equal(broker.invocationError(claim)?.code, 'SESSION_CHANGED');
  assert.equal(current.finalized, false); assert.equal(engineCalls, 1);
});

test('private context budgeting prepares the actual skill without publishing a native claim', async t => {
  const f = await fixture(t);
  const inspected = await engine({ op: 'inspect', root: f.root, learning: false });
  const estimate = await f.broker.estimateInvocation({
    config: { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'fixture-private-key' },
    args: { messages: [{ role: 'user', content: 'Please introduce yourself' }] },
    context: { root: f.root, input: 'Please introduce yourself', purpose: 'candidate', loadout: [], settings: { recall: false } },
    sessionKey: 'agent:main:chainchat:fixture', invocationId: 'budget-only',
  });
  assert.ok(estimate.estimatedTokens > 1000, 'Budget must include the real installed skill and verified native context.');
  assert.deepEqual((await engine({ op: 'inspect', root: f.root, learning: false })).head, inspected.head);
  assert.equal((await f.call('admit')).body.allowed, false, 'A budget probe must leave no model-admissible claim.');
  await f.register();
  assert.equal((await f.call('admit')).body.allowed, true, 'The same session remains available for the real turn.');
  assert.equal(f.seen.length, 0, 'Budget probes must not contact the reviewer or model.');
});

test('a paused private budget preparation never publishes a late native route or context claim', async t => {
  let entered, release;
  const preparing = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {engine: async request => {
    if (request.op === 'prepare') { entered(); await held; }
    return engine(request);
  }});
  const sessionKey = 'agent:main:chainchat:fixture', correlation = 'context-assembly:00000000-0000-4000-8000-000000000001';
  const before = await engine({op:'inspect',root:f.root,learning:false});
  const pending = f.broker.estimateInvocation({
    config: {provider:'compatible',model:'fixture',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'fixture-private-key'},
    args: {messages:[{role:'user',content:'Please introduce yourself'}]},
    context: {root:f.root,input:'Please introduce yourself',purpose:'candidate',loadout:[],settings:{recall:false},
      expectedClientInputId:'future-host-input',modelRouteCapability:'c'.repeat(64)},
    sessionKey,invocationId:'budget-only',
  });
  await preparing;
  let estimate;
  try {
    assert.equal((await f.call('model_route',{runId:'late-unrelated-native-run'})).body.allowed,false,
      'A late native event must not select a route while private estimation awaits.');
    assert.equal(f.broker.nativeInvocation(sessionKey),null,'The preview never enters the native session map.');
    for (const [op,fields] of [['admit',{}],['model_context',{runId:correlation,model:{provider:'chainchat-compatible',model:'route'}}]])
      assert.equal((await f.call(op,fields)).body.allowed,false,'A preview grants no '+op+' authority.');
  } finally { release(); estimate = await pending; }
  assert.ok(estimate.estimatedTokens>1000);assert.equal(f.broker.nativeInvocation(sessionKey),null);
  for (const op of ['model_route','admit','model_context'])
    assert.equal((await f.call(op,op==='model_context'?{runId:correlation,model:{provider:'chainchat-compatible',model:'route'}}:{})).body.allowed,false);
  assert.equal(f.seen.length,0,'The entire preview path makes no model or reviewer call.');
  assert.deepEqual((await engine({op:'inspect',root:f.root,learning:false})).head,before.head);
  await f.register({expectedClientInputId:'actual-host-input',modelRouteCapability:'c'.repeat(64)});
  assert.equal((await f.call('admit',{runId:'actual-host-input'})).body.allowed,true);
  assert.equal((await f.call('prepare',{runId:'actual-host-input'})).body.allowed,true,'A genuine owned turn still prepares normally.');
});

test('a completed autonomous turn releases its session for the same owner without losing its exact delivery receipt', async t => {
  const f = await fixture(t);
  const owner = {nativeOwnerKey:'owned-agent:'+'a'.repeat(64),autonomousCommit:true,learning:false};
  const old = await f.register(owner);
  assert.equal((await f.call('admit')).body.allowed,true);
  assert.equal((await f.call('prepare')).body.allowed,true);
  await assert.rejects(f.register(owner),'An active run must not be replaced.');
  assert.equal((await f.call('finalize',{candidate})).body.allowed,true);
  assert.equal((await f.call('admit')).body.allowed,false,'A finalized candidate cannot authorize another model pass.');
  assert.equal((await f.call('finalize',{candidate})).body.allowed,true,'The exact finalized candidate retains idempotent receipt recovery.');
  await assert.rejects(f.register(owner),'A finalized but still-running turn must not be replaced.');
  assert.equal((await f.call('end')).body.allowed,true);
  for(const op of ['admit','prepare','finalize','tool','tool_result'])assert.equal((await f.call(op,{candidate})).body.allowed,false,'An ended run cannot regain '+op+' authority.');
  assert.equal((await f.call('outgoing',{candidate,candidateSha256:hash(candidate)})).body.allowed,true,'Exact previously reviewed late delivery remains available.');
  await assert.rejects(f.register({...owner,nativeOwnerKey:'another-owner'}));
  await assert.rejects(f.register({...owner,purpose:'utility'}));
  const next=await f.register({...owner,autonomousCommit:false});
  assert.equal((await f.call('admit',{runId:'next-run'})).body.allowed,true);
  assert.equal((await f.call('outgoing',{candidate,candidateSha256:hash(candidate)})).body.allowed,true,
    'Late delivery must match the retained original native run and candidate.');
  await f.broker.finishInvocation(old);
  assert.equal((await f.call('prepare',{runId:'next-run'})).body.allowed,true,
    'Old receipt cleanup must not remove the next turn.');
  await f.broker.finishInvocation(next);
  const held=await f.register(owner);
  assert.equal((await f.call('admit',{runId:'held-run'})).body.allowed,true);
  assert.equal((await f.call('end',{runId:'held-run'})).body.allowed,true);
  await assert.rejects(f.register(owner),'An ended turn without a final receipt must not be replaced.');
  await f.broker.finishInvocation(held);
});
test('model context correlation supplies the managed skill but cannot bind a native run or authorize tools', async t => {
  const f = await fixture(t), capability = 'c'.repeat(64);
  const text = '---\nname: examples\nmetadata: PRIVATE_INSTALL_METADATA\n---\nUse a concrete example when helpful.';
  await f.register({ modelRouteCapability: capability, additionalSkills: [{ id: 'a'.repeat(32), name: 'examples', sha256: hash(text), text }] });
  const route=await f.call('model_route',{runId:'early-selection-only'});
  assert.deepEqual(route.body.modelRoute,{transport:'proxy',provider:'chainchat-compatible',model:'route'});
  assert.equal((await f.call('tool',{runId:'early-selection-only',tool:{name:'read',callId:'unadmitted',params:{path:'private'}}})).body.allowed,false,'A route read must not bind a run or grant tools.');
  const correlation = 'context-assembly:00000000-0000-4000-8000-000000000001';
  assert.equal((await f.call('model_context',{runId:correlation,model:{provider:'paid-native',model:'paid'}})).body.allowed,false,'A saved native provider cannot bypass the admitted proxy before inference.');
  const supplied = await f.call('model_context', { runId: correlation,model:{provider:'chainchat-compatible',model:'route'} });
  assert.equal(supplied.body.allowed, true); assert.equal(supplied.body.binding.runId, correlation);
  assert.ok(supplied.body.context.includes('CHAINCHAT HOST CONTRACT'));
  assert.ok(supplied.body.context.indexOf('CHAINCHAT HOST CONTRACT') < supplied.body.context.indexOf('OWNER-SELECTED ADDITIONAL SKILL GUIDANCE'));
  assert.match(supplied.body.context, /Use a concrete example when helpful/);
  assert.doesNotMatch(supplied.body.context, /PRIVATE_INSTALL_METADATA/);
  assert.ok(supplied.body.context.includes(`[CHAINCHAT_PRIVATE_MODEL_ROUTE:${capability}]`));
  assert.equal((await f.call('tool', { runId: correlation, tool: { name: 'read', callId: 'fake', params: { path: 'private' } } })).body.allowed, false);
  assert.equal((await f.call('admit', { runId: 'actual-native-run' })).body.allowed, true, 'Context assembly must not steal claim.runId.');
  assert.deepEqual((await f.call('prepare', { runId: 'actual-native-run' })).body.toolsAllow, []);
  assert.equal((await f.call('model_context', { sessionKey: 'other-session', runId: correlation })).body.allowed, false);
});
test('original browser primitives each require fresh review and compound or personal-profile calls are refused', async t => {
  let reviews = 0, effects = 0;
  const events = [];
  const f = await fixture(t, { assessment: () => { const result = good(); if (++reviews === 2) result.fruitages.kindness = 20; return result; } });
  await f.register({ input: 'Click Continue, then click Finish in the owned browser.',
    event: (...event) => events.push(event),
    toolAuthority: { enabled: true, acknowledged: true, tools: ['browser'], roots: [], networkHosts: ['example.com'], allowExecution: false },
    browserInvocation: {
      describe: () => ({ profile: 'chainchat-owned', isolated: true, running: true, closed: false }),
      inspectAction: async params => ({ params, context: { fingerprint: 'fixed', role: 'button', text: params.request.ref } }),
      assertActionUnchanged: async params => ({ params, context: { fingerprint: 'fixed' } }),
    } });
  await f.call('admit');
  assert.deepEqual((await f.call('prepare')).body.toolsAllow, ['browser']);
  const children = ['Continue', 'Finish'].map(ref => ({ action: 'act', request: { kind: 'click', ref } }));
  const invoke = (callId, params) => f.call('tool', { tool: { name: 'browser', callId, params } });
  assert.equal((await invoke('batch', { action: 'act', request: { kind: 'batch', actions: children.map(item => item.request) } })).body.allowed, false);
  assert.equal((await invoke('profiles', { action: 'profiles' })).body.allowed, false);
  assert.equal((await invoke('multi-field', { action: 'act', request: { kind: 'fill', fields: [{ ref: 'a', value: 'one' }, { ref: 'b', value: 'two' }] } })).body.allowed, false);
  const first = await invoke('native-primitive-one', children[0]);
  assert.equal(first.body.allowed, true, JSON.stringify(first.body)); effects++;
  assert.deepEqual(events.filter(([ability]) => ability === 'tool'), [], 'Approval does not establish execution.');
  assert.equal((await invoke('native-primitive-one', children[0])).body.allowed, false, 'An approved call identifier cannot be replayed.');
  await f.call('tool_result', { tool: { name: 'browser', callId: 'native-primitive-one' }, outcome: { success: true, result: { clicked: 'Continue' }, error: null } });
  const denied = await invoke('native-primitive-two', children[1]);
  if (denied.body.allowed) effects++;
  assert.equal(denied.body.allowed, false); assert.equal(effects, 1); assert.equal(reviews, 2);
  assert.deepEqual(events.filter(([ability]) => ability === 'tool'), [['tool', 'completed', 'Tool browser completed']]);
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0);
});
test('managed model services require a fresh exact one-use approved native call', async t => {
  let effects = 0;
  const f = await fixture(t);
  await f.register({ input: 'List the managed schedules for this agent.',
    toolAuthority: { enabled: true, acknowledged: true, tools: ['chainchat_automation'], roots: [], networkHosts: [], allowExecution: false },
    executeManagedService: async params => { effects++; assert.deepEqual(params, { action: 'list' }); return { jobs: [] }; } });
  await f.call('admit'); await f.call('prepare');
  const execute = fields => f.call('managed_service_execute', { runId: 'real-service-call', params: { action: 'list' }, ...fields });
  assert.equal((await execute()).body.allowed, false);
  assert.equal((await f.call('tool', { tool: { name: 'chainchat_automation', callId: 'forged-target', params: { action: 'list', agentId: 'other' } } })).body.allowed, false);
  assert.equal((await f.call('tool', { tool: { name: 'chainchat_automation', callId: 'real-service-call', params: { action: 'list' } } })).body.allowed, true);
  assert.equal((await execute({ params: { action: 'list_channels' } })).body.allowed, false);
  assert.equal((await execute()).body.allowed, true); assert.equal(effects, 1);
  assert.equal((await execute()).body.allowed, false); assert.equal(effects, 1);
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0);
});
test('native prepare/review/evaluate bind an exact candidate, but UI retains commit ownership', async t => {
  const f = await fixture(t), claim = await f.register();
  assert.equal((await f.call('admit')).body.allowed, true);
  const prepared = (await f.call('prepare')).body;
  assert.ok(prepared.context.includes('Proof of Interaction'));
  assert.equal([...prepared.context.matchAll(/^name: proof-of-interaction\r?$/gmu)].length, 1, 'The native prepared context contains the canonical skill exactly once.');
  assert.ok(prepared.context.includes('CHAINCHAT HOST CONTRACT'));
  const hostedContract = prepared.context.slice(prepared.context.indexOf('CHAINCHAT HOST CONTRACT'));
  assert.match(hostedContract, /host owns the skill lifecycle and Timechain persistence/);
  assert.match(hostedContract, /Do not attempt the skill CLI or write to its default root/);
  assert.match(hostedContract, /candidate answer using the verified context and only the advertised tools/);
  assert.match(hostedContract, /does not authorize bypassing the host, replacing enforcement or directly modifying the protected Timechain/);
  assert.match(prepared.context, /Canonical commitment follows the selected block policy/);
  assert.match(prepared.context, /reviewed continuum answers may be visible while pending commitment/);
  assert.equal(prepared.context.includes('after host review and the atomic conversation commitment'), false);
  assert.deepEqual(prepared.toolsAllow, []);
  const final = (await f.call('finalize', { candidate, candidateSha256: hash(candidate),
    hostProcessContext: { toolScope: { external: ['exec'] }, releaseReview: { semantic: false, native: false } } })).body;
  assert.equal(final.allowed, true); assert.equal(final.receipt.reviewed, true);
  assert.equal(f.seen[0].trustedAgentContext.name, 'Cypher Tempre');
  const facts = f.seen[0].hostProcessContext;
  assert.deepEqual(facts.toolScope, { external: [], ownSession: [] });
  assert.deepEqual(facts.faculties, []);
  assert.deepEqual(facts.releaseReview, { semantic: true, native: true });
  assert.ok(prepared.context.includes(JSON.stringify(facts)), 'Generation and review use the same private facts.');
  assert.equal((await f.broker.assertCandidate({ claimId: claim.claimId, candidate })).commitOwner, 'chainchat');
  await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate: candidate + ' changed' }));
  assert.equal((await f.call('outgoing', { candidate: candidate + ' changed' })).body.allowed, false);
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0, 'Individual model candidates cannot double-commit the user turn.');
  assert.equal((await f.call('tool', { tool: { name: 'exec', params: { command: 'echo ungranted' } } })).body.allowed, false);
});

test('actual private goal-only admission exposes goal API names separately from disabled external actions', async t => {
  const sessionKey = 'agent:main:chainchat-control:' + 'a'.repeat(64);
  const f = await fixture(t, { sessionKey });
  await f.register({ goalAuthority: { enabled: true, sessionKey } }); await f.call('admit');
  const prepared = (await f.call('prepare')).body;
  assert.deepEqual(prepared.toolsAllow, ['get_goal', 'update_goal']);
  assert.equal((await f.call('finalize', { candidate })).body.allowed, true);
  assert.deepEqual(f.seen[0].hostProcessContext.toolScope, { external: [], ownSession: ['get_goal', 'update_goal'] });
  assert.equal((await f.call('tool', { tool: { name: 'exec', params: { command: 'echo ungranted' }, callId: 'not-a-goal' } })).body.allowed, false);
});
test('low semantic/native scores and changed run identities cannot release output', async t => {
  const f = await fixture(t, { assessment: () => { const result = good(); result.fruitages.love = 149; return result; } });
  const claim = await f.register(); await f.call('admit');
  assert.equal((await f.call('prepare', { runId: 'another-run' })).body.allowed, false);
  assert.equal((await f.call('finalize', { candidate })).body.allowed, false);
  await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate }));
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0);
});

test('native candidate response review accepts the inclusive 150 floor while retaining exact receipt checks', async t => {
  for (const score of [150, 179]) await t.test(String(score), async t => {
    const f = await fixture(t, { assessment: () => {
      const value = good(); value.scores.covenant = score;
      for (const fruit of FRUITS) value.fruitages[fruit] = score;
      return value;
    } });
    const claim = await f.register(); await f.call('admit'); await f.call('prepare');
    const result = await f.call('finalize', { candidate });
    assert.equal(result.body.allowed, true, 'A compatible response must reach native review at its response floor.');
    assert.equal(f.seen[0].reviewPurpose, 'response');
    assert.equal((await f.broker.assertCandidate({ claimId: claim.claimId, candidate })).reviewed, true);
    await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate: candidate + ' altered' }));
    assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0, 'The UI still owns conversation commitment.');
  });
});

test('the lower response floor never admits a host tool at 179 and action review uses its native backstop', async t => {
  let score = 179;
  const operations = [];
  const f = await fixture(t, { assessment: () => {
    const value = good(); value.scores.covenant = score;
    for (const fruit of FRUITS) value.fruitages[fruit] = score;
    return value;
  }, engine: async request => { operations.push(request.op); return engine(request); } });
  await f.register({ input: 'List this agent\'s managed schedules.',
    toolAuthority: { enabled: true, acknowledged: true, tools: ['chainchat_automation'], roots: [], networkHosts: [], allowExecution: false },
    executeManagedService: async () => { throw new Error('Review alone must never execute a service.'); } });
  await f.call('admit'); await f.call('prepare');
  const request = callId => f.call('tool', { tool: { name: 'chainchat_automation', callId, params: { action: 'list' } } });
  assert.equal((await request('action-low')).body.allowed, false);
  assert.equal(f.seen[0].reviewPurpose, 'action');
  assert.equal(operations.includes('evaluate_action'), false, 'A low semantic action score must stop before native admission.');
  score = 180;
  assert.equal((await request('action-boundary')).body.allowed, true);
  assert.equal(f.seen[1].reviewPurpose, 'action');
  assert.equal(operations.includes('evaluate_action'), true, 'Action review retains its distinct native 180 floor.');
  assert.equal(operations.includes('evaluate'), false, 'Tools cannot borrow the response-evaluation operation.');
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0);
});
test('utility invocations cannot acquire tool rights or pretend to be an active plain call', async t => {
  const f = await fixture(t);
  await assert.rejects(f.register({ purpose: 'plain' }));
  const claim = await f.register({ purpose: 'utility' }); await f.call('admit');
  const prepared = (await f.call('prepare')).body; assert.equal(prepared.context, ''); assert.deepEqual(prepared.toolsAllow, []);
  assert.equal((await f.call('finalize', { candidate: '{"queries":[]}' })).body.purpose, 'utility');
  assert.equal(f.seen.length, 0, 'Review/planning calls cannot recursively trigger model review.');
  assert.equal((await f.call('tool', { tool: { name: 'read', params: {} } })).body.allowed, false);
  f.setTime(Date.now() + 600_000);
  await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate: '{"queries":[]}' }));
});
