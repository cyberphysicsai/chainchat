import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createOpenClawGateway } from '../openclaw/gateway.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';
import {trustedPluginRpcValidators} from '../lib/trusted-plugin-manager.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
test('real native goals, settings, scoped tools and durable app restarts retain enforcement and key isolation', {
  skip: !packageRoot || !nodePath ? 'Set CT_OPENCLAW_PACKAGE and CT_OPENCLAW_NODE for pinned native acceptance.' : false,
  timeout: 480000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-control-test-'));
  const root = path.join(directory, 'chain'), managed = path.join(directory, 'managed'), files = path.join(directory, 'granted');
  await fs.mkdir(files); const readFile = path.join(files, 'approved.txt'), ungrantedWrite = path.join(files, 'never-written.txt');
  await fs.writeFile(readFile, 'approved-native-file-content');
  await engine({ op: 'init', root, name: 'NativeControlFixture' });
  const inspected = await engine({ op: 'inspect', root, learning: false });
  const identity = { agentId: 'native-test', genesisHash: inspected.genesis.hash };
  const answer = "Hello! I'm NativeControlFixture. I can help with care, patience and honesty.";
  let toolPlan = null, toolReturned = false, lowFruit = false, reasoningCapable = false, canonicalGoalEvidence = null;
  const requests = [], events = [], reviews = [], diagnostics = [];
  const upstream = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push({ body, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = delta => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    if (toolPlan && !toolReturned) {
      toolReturned = true;
      const names = new Set((body.tools || []).map(tool => tool.function?.name || tool.name));
      const deferred = !names.has(toolPlan.name) && names.has('tool_call');
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'tool-fixture-' + requests.length, type: 'function',
        function: { name: deferred ? 'tool_call' : toolPlan.name, arguments: JSON.stringify(deferred ? { id: toolPlan.name, args: toolPlan.params } : toolPlan.params) } }] });
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      chunk({ role: 'assistant', content: answer });
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const makeBroker = () => createPoIBroker({ engine, review: async (_config, args) => {
    reviews.push(args.candidate);
    const action = args.candidate.includes('proposed-host-tool-action');
    return { approved: true, scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
      fruitages: Object.fromEntries(FRUITS.map(key => [key, action && lowFruit ? 20 : 240])),
      usedRings: action && args.candidate.includes('update_goal') && args.availableEvidence?.some(ring => ring.index === canonicalGoalEvidence) ? [canonicalGoalEvidence] : [],
      rationale: 'Supported fixture identity, exact scoped local action and covenant-compatible answer.' };
  } });
  let broker = makeBroker(); await broker.start();
  const makeManager = () => createOpenClawGateway({ stateDir: managed, packageRoot, nodePath,
    pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), broker, startupTimeoutMs: 180000,
    onDiagnostic: line => diagnostics.push(line) });
  let manager = makeManager();
  const config = key => ({ provider: 'compatible', model: 'fixture-model', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: key });
  const nativeContext = input => ({ root, input, loadout: [], learning: false, purpose: 'candidate', nativeIdentity: identity,
    modelCapabilities: { reasoning: reasoningCapable },
    event: (ability, status, label) => events.push({ ability, status, label }) });
  async function generate(input, nativeControl, grant) {
    return manager.generate(config('isolated-fixture-provider-key'), { messages: [{ role: 'user', content: input }], maxTokens: 512,
      ...(nativeControl ? { nativeControl } : {}) }, { ...nativeContext(input), ...(grant ? { toolAuthority: grant } : {}) });
  }
  t.after(async () => {
    await manager.close(); await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('ct-native-control-test-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  try {
    let state = await manager.describeControls(identity);
    assert.ok(state.schema.schema); assert.equal(state.session, null);
    const plan = await manager.executeCommand({ ...identity, command: '/goal start Please introduce yourself' });
    const introduced = await generate(plan.message, plan.native);
    assert.equal(introduced.text, answer); assert.equal(introduced.enforcement.reviewed, true);
    // The real UI seals an approved exchange before any later goal turn. Give
    // this direct-manager fixture the same canonical completion evidence.
    const scores = Object.fromEntries(DIMENSIONS.map(key => [key, 240]));
    const assessment = { approved: true, scores, fruitages: Object.fromEntries(FRUITS.map(key => [key, 240])), usedRings: [],
      rationale: 'The actual native-approved fixture introduction is supported by its verified genesis identity.' };
    const committed = await engine({ op: 'commit', root, expectedHead: introduced.enforcement.expectedHead,
      exchanges: [{ input: plan.message, output: introduced.text, scores, assessment, usedRings: [], loadout: [],
        model: { provider: 'compatible', model: 'fixture-model' } }], loadout: [], learning: false, growth: false });
    assert.equal(committed.accepted, true); canonicalGoalEvidence = committed.ring.index;
    state = await manager.sessionControls(identity);
    const goalId = state.goal.id;
    assert.equal(state.goal.status, 'active');
    await manager.executeCommand({ ...identity, command: '/goal pause Operator pause' });
    await manager.executeCommand({ ...identity, command: '/verbose full' });
    assert.equal((await manager.sessionControls(identity)).session.verboseLevel, 'full');
    assert.equal((await generate('Please introduce yourself again', { kind: 'message', sessionKey: state.sessionKey })).text, answer);
    const beforeControl = requests.length;
    const queue = await manager.executeCommand({ ...identity, command: '/queue collect debounce:0.5s cap:25 drop:summarize' });
    assert.match(queue.text, /collect/i);
    const contextReport = await manager.executeCommand({ ...identity, command: '/context json' });
    assert.ok(contextReport.text.length > 20); assert.equal(requests.length, beforeControl, 'Deterministic controls must never call a provider.');
    await manager.executeCommand({ ...identity, command: '/think high', modelCapabilities: { reasoning: true } });
    reasoningCapable = true;
    const beforeEffort = requests.length;
    assert.equal((await generate('Please introduce yourself with the selected native effort', { kind: 'message', sessionKey: state.sessionKey })).text, answer);
    assert.ok(requests.slice(beforeEffort).some(request => request.body.reasoning_effort === 'high' || request.body.reasoning?.effort === 'high'),
      'A reasoning-capable connected route must actually receive the selected effort.');
    const nativeSettings = await manager.describeControls(identity);
    const updated = await manager.updateControls({ identity, patch: { messages: { queue: { cap: 17 } } }, revision: nativeSettings.config.revision, baseHash: nativeSettings.config.baseHash });
    assert.equal(updated.config.editable.messages.queue.cap, 17);
    assert.equal(updated.config.effective.messages.queue.cap, 17);
    assert.equal((await manager.sessionControls(identity)).goal.id, goalId);
    const privateTransport = JSON.parse(await fs.readFile(path.join(managed, 'transport-identity.json'), 'utf8'));
    const publicState = JSON.stringify(await manager.describeControls(identity));
    for (const privateValue of [privateTransport.proxyToken, privateTransport.gatewayToken, broker.token, 'isolated-fixture-provider-key'])
      assert.equal(publicState.includes(privateValue), false, 'Operator/provider credentials must not reach settings responses.');
    await manager.close(); const previousBrokerToken = broker.token; await broker.close();
    broker = makeBroker(); await broker.start(); assert.notEqual(broker.token, previousBrokerToken);
    manager = makeManager();
    state = await manager.sessionControls(identity);
    assert.equal(state.goal.id, goalId); assert.equal(state.goal.status, 'paused'); assert.equal(state.session.verboseLevel, 'full');
    const resumed = await manager.executeCommand({ ...identity, command: '/goal resume' });
    assert.equal((await generate(resumed.message, resumed.native)).text, answer);
    assert.equal((await manager.sessionControls(identity)).goal.status, 'active');
    await manager.executeCommand({ ...identity, command: '/goal pause' });
    const grant = { enabled: true, tools: ['read'], roots: [files], networkHosts: [], allowExecution: false, acknowledged: true };
    toolPlan = { name: 'read', params: { path: readFile } }; toolReturned = false;
    const beforeRead = requests.length;
    assert.equal((await generate('Read the explicitly granted fixture file', null, grant)).text, answer);
    assert.ok(requests.slice(beforeRead).some(request => JSON.stringify(request.body.messages).includes('approved-native-file-content')),
      'The real upstream read tool must execute and feed its result back to the model.');
    assert.ok(reviews.some(candidate => candidate.includes('proposed-host-tool-action') && candidate.includes('approved.txt')));
    toolPlan = { name: 'write', params: { path: ungrantedWrite, content: 'must not execute' } }; toolReturned = false;
    await generate('A write is not in the grant', null, grant).catch(() => {});
    await assert.rejects(fs.access(ungrantedWrite));
    lowFruit = true; toolPlan = { name: 'read', params: { path: readFile } }; toolReturned = false;
    const beforeHeld = requests.length;
    await generate('Try the read with low covenant assessment', null, grant).catch(() => {});
    assert.equal(requests.slice(beforeHeld).some(request => JSON.stringify(request.body.messages).includes('approved-native-file-content')), false);
    assert.ok(events.some(event => event.status === 'held' && event.label.includes('read')));
    lowFruit = false; toolPlan = { name: 'update_goal', params: { status: 'complete', note: 'The requested fixture introduction was delivered and verified.' } }; toolReturned = false;
    const completePlan = await manager.executeCommand({ ...identity, command: '/goal resume' });
    const beforeGoalTool = requests.length, beforeGoalReview = reviews.length;
    assert.equal((await generate(completePlan.message, completePlan.native)).text, answer);
    assert.equal((await manager.sessionControls(identity)).goal.status, 'complete', 'The real native model-side goal tool must complete its own goal. ' + JSON.stringify({
      tools: requests[beforeGoalTool]?.body.tools?.map(tool => tool.function?.name || tool.name),
      results: requests.slice(beforeGoalTool).flatMap(request => (request.body.messages || []).filter(message => message.role === 'tool')).slice(-2),
      reviews: reviews.slice(beforeGoalReview).filter(candidate => candidate.includes('proposed-host-tool-action')).map(candidate => candidate.slice(0, 2000)),
      activity: events.slice(-12),
    }));
    reasoningCapable = false; toolPlan = null;
    const beforeModelSwitch = requests.length;
    assert.equal((await generate('Please introduce yourself using the new non-reasoning model', { kind: 'message', sessionKey: state.sessionKey })).text, answer);
    assert.equal(requests.slice(beforeModelSwitch).some(request => request.body.reasoning_effort === 'high'), false,
      'Switching to a non-reasoning model must clamp the previous high effort instead of holding a simple introduction.');
    const walk = async directory => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) assert.equal((await fs.readFile(file)).includes(Buffer.from('isolated-fixture-provider-key')), false, file);
    } };
    await manager.close(); await walk(managed);
  } catch (error) { assert.fail(`${error.stack || error.message}\n${diagnostics.join('').slice(-4000)}`); }
});

test('native schema settings and disabled Telegram credentials apply, survive recreation and reset without provider or channel traffic', {
  skip: !packageRoot || !nodePath ? 'Set CT_OPENCLAW_PACKAGE and CT_OPENCLAW_NODE for pinned native acceptance.' : false,
  timeout: 480000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-channel-settings-test-'));
  const root = path.join(directory, 'chain'), managed = path.join(directory, 'managed'), diagnostics = [], admissions = [];
  await engine({op:'init',root,name:'NativeChannelConfigurationFixture'});
  const inspected = await engine({op:'inspect',root,learning:false});
  const identity = {agentId:'native-channel-test',genesisHash:inspected.genesis.hash};
  let modelReviews = 0;
  const broker = createPoIBroker({engine,review:async()=>{modelReviews++;throw new Error('This settings-only fixture must not call a model.');}});
  await broker.start();
  const makeManager = () => createOpenClawGateway({stateDir:managed,packageRoot,nodePath,
    pluginPath:fileURLToPath(new URL('../openclaw/plugin',import.meta.url)),broker,startupTimeoutMs:180000,
    onDiagnostic:line=>diagnostics.push(line)});
  let manager = makeManager();
  const token = '123456789:' + 'A'.repeat(35); // Synthetic fixture; never enable this channel.
  t.after(async()=>{
    await manager.close();await broker.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
    assert.ok(path.basename(directory).startsWith('ct-native-channel-settings-test-'));
    await fs.rm(directory,{recursive:true,force:true,maxRetries:12,retryDelay:150});
  });
  try {
    const initial = await manager.describeControls(identity);
    assert.ok(initial.config.baseHash);assert.equal(initial.nativeConfig.valid,true);
    const settings = await manager.updateControls({identity,revision:initial.config.revision,baseHash:initial.config.baseHash,
      patch:{messages:{queue:{cap:17}}}});
    assert.equal(settings.config.effective.messages.queue.cap,17);
    await assert.rejects(manager.updateControls({identity,revision:settings.config.revision,baseHash:initial.config.baseHash,
      patch:{messages:{queue:{cap:18}}}}),{code:'OPENCLAW_CONFIG_STALE'});
    const catalogue = await manager.nativeChannels({mode:'catalogue',identity});
    const telegram = catalogue.items.find(item=>item.id==='telegram');
    assert.ok(telegram?.installed,'The pinned native Telegram channel must be discovered dynamically.');
    // In 2026.11.3 Discord is an official external plugin, not a bundled
    // installed channel. It belongs in the native Plugins catalogue until the
    // owner installs it; channel setup must not invent an executable adapter.
    const pluginReader=manager.registerNativeService({id:'native-channel-catalogue-fixture',methods:{
      'plugins.list':trustedPluginRpcValidators()['plugins.list'],
      'plugins.inspect':trustedPluginRpcValidators()['plugins.inspect'],
    }});
    const nativePlugins=await pluginReader.request('plugins.list',{});
    // The curated list may still be awaiting hosted catalogue enrichment.
    // Direct native inspection must resolve the pinned official fallback entry
    // deterministically, without downloading or installing the plugin.
    const discord=await pluginReader.request('plugins.inspect',{pluginId:'discord'});
    assert.equal(discord.plugin.id,'discord');assert.equal(discord.plugin.origin,'official');
    assert.equal(discord.plugin.installed,false);assert.equal(discord.plugin.enabled,false);
    assert.equal(discord.source.kind,'official-catalog');assert.equal(discord.source.packageName,'@openclaw/discord');
    assert.ok(discord.source.spec,'The external Discord integration must retain its native installation source.');
    const listedDiscord=nativePlugins.plugins.find(item=>item.id==='discord'||item.packageName==='@openclaw/discord');
    if(listedDiscord){assert.equal(listedDiscord.installed,false);assert.equal(listedDiscord.enabled,false);}
    assert.equal(catalogue.items.some(item=>item.id==='discord'&&item.installed),false,'An uninstalled plugin must not be presented as a usable channel.');
    const field = telegram.credentialFields.find(row=>row.path.length===3&&row.path[2]==='botToken');
    assert.ok(field,'The native Telegram schema must expose its write-only bot credential.');
    const configured = await manager.nativeChannels({mode:'setup',identity,channelId:'telegram',accountId:telegram.defaultAccountId,
      baseHash:catalogue.baseHash,values:{enabled:false},secretValues:[{name:'fixtureTelegram',target:field.target,value:token,remember:true}],
      authorize:async action=>{admissions.push(action);assert.equal(JSON.stringify(action).includes(token),false);return{approved:true};}});
    assert.equal(admissions.length,1);assert.equal(admissions[0].operation,'channels.configure');
    assert.equal(configured.items.find(item=>item.id==='telegram').enabled,false);
    let current = await manager.describeControls(identity);
    assert.equal(current.nativeConfig.valid,true);assert.equal(current.config.effective.channels.telegram.enabled,false);
    assert.equal(current.config.effective.messages.queue.cap,17);
    assert.equal(JSON.stringify(current).includes(token),false);
    assert.match(current.nativeConfig.config.channels.telegram.botToken,/REDACTED|managed private|private/iu);
    const vault = await fs.readFile(path.join(managed,'native-secrets.json'),'utf8');
    assert.equal(JSON.parse(vault).version,2);assert.equal(vault.includes(token),false);
    const nativeFile = await fs.readFile(path.join(managed,'gateway.json'),'utf8');
    assert.equal(nativeFile.includes(token),false);assert.match(nativeFile,/CHAINCHAT_NATIVE_[A-F0-9]{64}/u);
    await manager.close();manager=makeManager();
    current = await manager.describeControls(identity);
    assert.equal(current.nativeConfig.valid,true);assert.equal(current.config.effective.messages.queue.cap,17);
    assert.equal(current.config.effective.channels.telegram.enabled,false);assert.equal(JSON.stringify(current).includes(token),false);
    const bindings = await manager.nativeSecrets({identity,action:'list'});
    assert.ok(bindings.bindings.some(row=>row.name==='fixtureTelegram'&&row.available&&row.remember));
    const restored = await manager.nativeChannels({mode:'catalogue',identity});
    assert.equal(restored.items.find(item=>item.id==='telegram').enabled,false);
    assert.ok(restored.items.find(item=>item.id==='telegram').accounts.every(account=>!account.running&&!account.connected));
    const reset = await manager.updateControls({identity,revision:current.config.revision,baseHash:current.config.baseHash,
      removePaths:['/messages/queue/cap']});
    assert.equal(reset.config.editable.messages?.queue?.cap,undefined);
    assert.notEqual(reset.config.effective.messages?.queue?.cap,17);
    assert.equal(reset.config.effective.channels.telegram.enabled,false);
    assert.equal(modelReviews,0,'Configuring disabled native integrations never requests inference.');
    assert.equal(diagnostics.join('').includes(token),false,'Credentials must not reach runtime diagnostics.');
  } catch(error) { assert.fail(`${error.stack||error.message}\n${diagnostics.join('').slice(-4000)}`); }
});
