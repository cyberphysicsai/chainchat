// Actual native runtime and default review transport; synthetic provider, no paid calls.
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const application = process.env.CT_CHAINCHAT_PACKAGE || fileURLToPath(new URL('..', import.meta.url));
const runtimePackage = process.env.CT_OPENCLAW_PACKAGE, runtimeNode = process.env.CT_OPENCLAW_NODE;
test('default active chat normalizes a copied endpoint, seals reviewed replies and preserves safe denial causes', {
  skip: !runtimePackage || !runtimeNode ? 'Set the pinned native runtime for active-chat reliability acceptance.' : false,
  timeout: 420000,
}, async t => {
const install = { release: application, node: runtimeNode };
const load = file => import(pathToFileURL(path.join(install.release, file)).href);
const [{ createApp }, { DIMENSIONS, FRUITS }, { engine }] = await Promise.all([
  load('server.mjs'), load('lib/providers.mjs'), load('lib/engine.mjs'),
]);
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-active-review-diagnosis-')));
const calls = [], diagnostics = [];
let format = 'bare', providerCap = null, truncatePlanner = false, holdPlanner = false, app, bearer;
const answer = 'Hello! I am Cypher Tempre. I can help you explore ideas carefully and acknowledge uncertainty.';
const plan = JSON.stringify({ queries: ['greeting'], entities: [], shapes: ['narrow'], rings: [], useReplay: false,
  labels: { senses: [], modalities: [] } });
const review = JSON.stringify({ decision: 'approve', usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])),
  rationale: 'The introduction uses configured identity and makes no unsupported memory claim.' });
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), text = JSON.stringify(body);
  const isReview = text.includes('independent pre-release covenant reviewer');
  const isPlanner = text.includes('Plan retrieval for a local Timechain agent');
  const kind = isReview ? 'review' : isPlanner ? 'planner' : 'answer';
  calls.push({ kind, route: req.url, canonicalSkill: text.includes('name: proof-of-interaction'),
    hostContract: text.includes('CHAINCHAT HOST CONTRACT'), privateCredentialInBody: text.includes('disposable-fixture-key'),
    bytes: Buffer.byteLength(raw), stream: body.stream === true, outputAllowance: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens });
  // An upstream that accepts arbitrary paths hides a duplicated endpoint suffix.
  // Match the actual provider route for generation, planning and required review.
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Synthetic provider route does not exist.' } }));
    return;
  }
  if (providerCap && kind === 'answer' && (body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens) > providerCap) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Fixture model output cap exceeded', type: 'invalid_request_error' } }));
    return;
  }
  const assessment = JSON.parse(review);
  if (format === 'missing-evidence') delete assessment.usedRings;
  if (format === 'low-score') assessment.fruits.kindness = 179;
  const assessmentText = JSON.stringify(assessment);
  const content = isReview ? (format === 'fenced' ? '```json\n' + assessmentText + '\n```' : assessmentText) : isPlanner ? plan : format === 'empty-answer' ? '' : answer;
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'local-fixture', choices: [{ message: { role: 'assistant', content }, finish_reason: isPlanner && holdPlanner ? 'content_filter' : isPlanner && truncatePlanner ? 'length' : 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: isPlanner && holdPlanner ? 'content_filter' : isPlanner && truncatePlanner ? 'length' : 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 } })}\n\n`);
  res.end('data: [DONE]\n\n');
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const results = [];
try {
  app = await createApp({ dataDir: path.join(directory, 'data'), pairingCode: 'ACTIVE-REVIEW-DIAGNOSIS',
    openclaw: { stateDir: path.join(directory, 'gateway'),
      packageRoot: runtimePackage, nodePath: install.node,
      pluginPath: path.join(install.release, 'openclaw/plugin'), onDiagnostic: line => diagnostics.push(line) } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (endpoint, body) => {
    const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin: base, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  bearer = (await call('/api/pair', { code: 'ACTIVE-REVIEW-DIAGNOSIS' })).body.token;
  assert.equal((await call('/api/agents', { name: 'Cypher Tempre' })).status, 201);
  const providerBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  const configured = await call('/api/provider', { provider: 'compatible', model: 'fixture-model', apiKey: 'disposable-fixture-key',
    baseUrl: `${providerBase}/chat/completions/` });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.provider.baseUrl, providerBase);
  assert.equal(JSON.stringify(configured.body).includes('disposable-fixture-key'), false);
  const state = await call('/api/state');
  for (const key of ['learning', 'semanticRecall', 'autoRoute', 'autoSprout']) assert.equal(state.body.cognition[key], true, key);
  async function chainFiles(root) {
    const output = {};
    async function visit(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file); else output[path.relative(root, file)] = (await fs.readFile(file)).toString('hex');
    } }
    await visit(root); return output;
  }
  for (const scenario of ['active-valid', 'active-fenced-review', 'paused-same-provider', 'active-provider-cap', 'paused-provider-cap', 'active-invalid-evidence', 'active-low-score', 'active-truncated-planner', 'active-provider-policy-hold', 'paused-low-score', 'active-empty-final', 'active-after-empty']) {
    if (scenario === 'active-fenced-review') format = 'fenced';
    if (scenario === 'active-provider-cap') {
      format = 'bare'; providerCap = 4096;
      assert.equal((await call('/api/cognition', { mode: 'active', confirm: true })).status, 200);
    }
    if (scenario === 'active-invalid-evidence' || scenario === 'active-low-score') {
      format = scenario === 'active-invalid-evidence' ? 'missing-evidence' : 'low-score';
      assert.equal((await call('/api/cognition', { mode: 'active', confirm: true })).status, 200);
    }
    if (scenario === 'active-truncated-planner') { format = 'bare'; truncatePlanner = true; }
    if (scenario === 'active-provider-policy-hold') { format = 'bare'; truncatePlanner = false; holdPlanner = true; }
    if (scenario === 'paused-low-score') { format = 'low-score'; truncatePlanner = false; holdPlanner = false; }
    if (scenario === 'active-empty-final') {
      format = 'empty-answer'; truncatePlanner = false; holdPlanner = false;
      assert.equal((await call('/api/cognition', { mode: 'active', confirm: true })).status, 200);
    }
    if (scenario === 'active-after-empty') format = 'bare'; // Same connected model and settings; no reconnect or manual restart.
    if (scenario.startsWith('paused-')) assert.equal((await call('/api/cognition', { mode: 'dormant', confirm: true })).status, 200);
    const chainFile = path.join(app.store.agents[0].root, 'chain', 'rings.jsonl');
    const beforeRings = await fs.readFile(chainFile);
    const beforePaused = scenario.startsWith('paused-') ? await chainFiles(app.store.agents[0].root) : null;
    const start = calls.length, response = await call('/api/chat', { message: 'Please introduce yourself' });
    const currentCalls = calls.slice(start), afterRings = await fs.readFile(chainFile);
    assert.ok(currentCalls.every(call => call.route === '/v1/chat/completions'),
      'The copied endpoint must normalize before every native provider request, including required review.');
    assert.ok(currentCalls.every(call => !call.privateCredentialInBody), 'API credentials cannot enter model prompts.');
    assert.ok(currentCalls.filter(call => call.kind === 'answer').every(call => call.canonicalSkill && call.hostContract),
      'Every real answer-generation call must wear the canonical skill and host contract.');
    if (response.status >= 400) {
      assert.equal(response.body.message?.content, undefined, 'A denied turn releases no candidate.');
      assert.equal(JSON.stringify(response.body).includes(answer), false);
      assert.deepEqual(afterRings, beforeRings, 'A denied turn must not append a conversation ring.');
    } else if (scenario.startsWith('active-')) {
      assert.equal(response.body.message.content, answer);
      assert.equal(response.body.message.gate.approved, true);
      assert.equal(response.body.state.gate.required, true);
      assert.ok(Number.isSafeInteger(response.body.message.ring?.index));
      assert.ok(currentCalls.some(call => call.kind === 'answer'));
      assert.ok(currentCalls.some(call => call.kind === 'review'), 'Successful native generation must receive a real mandatory review call.');
      assert.ok(afterRings.length > beforeRings.length, 'An accepted active turn must commit before release.');
      assert.deepEqual(afterRings.subarray(0, beforeRings.length), beforeRings, 'Existing ring bytes remain unchanged.');
    }
    if (beforePaused) {
      assert.deepEqual(await chainFiles(app.store.agents[0].root), beforePaused, 'Paused review must leave PAUSED, history and registries byte-identical.');
      if (response.status === 200) {
        assert.equal(response.body.message.raw, false); assert.equal(response.body.message.memoryPaused, true);
        assert.equal(response.body.message.gate.approved, true); assert.equal(response.body.message.ring, null);
        assert.equal(response.body.state.gate.required, true);
        assert.ok(calls.slice(start).some(call => call.kind === 'review'), 'Paused model answer still requires actual semantic review.');
      }
    }
    const result = { scenario, status: response.status, code: response.body.code ?? null, stage: response.body.stage ?? null,
      error: response.body.error ?? null, mode: response.body.message?.mode ?? null,
      answerReleased: typeof response.body.message?.content === 'string', calls: calls.slice(start) };
    results.push(result); t.diagnostic(JSON.stringify(result));
    if (scenario === 'active-empty-final' && response.body.code !== 'PROVIDER_NO_TEXT' || scenario === 'active-after-empty' && response.status !== 200) {
      // Runtime stderr can contain private prompts. Emit only exact fixed-code
      // supervisor diagnostics, bounded to the most recent sixteen lines.
      const fixed = diagnostics.join('').split(/\r?\n/u).filter(line =>
        /^\[chainchat\] private model request held code=(?:PROVIDER_(?:NO_TEXT|INCOMPLETE|CONTENT_HELD|HTTP_ERROR|RATE_LIMIT|INVALID_RESPONSE|CONNECTION_ERROR)|OPENCLAW_(?:MODEL_ADMISSION|CONTEXT_BUDGET))(?: systemMarkers=\d+ totalMarkers=\d+)?$/u.test(line) ||
        /^\[chainchat\] mandatory context fault reason=(?:FACTORY_FAILED|BOOTSTRAP_FAILED|INGEST_FAILED|ASSEMBLE_FAILED|COMPACT_FAILED|COMMIT_TURN_FAILED|UNKNOWN)$/u.test(line) ||
        /^\[chainchat\] native lifecycle event=(?:exit|control-close) generation=(?:\d+|UNKNOWN) code=(?:\d+|none|UNKNOWN) signal=(?:none|SIGTERM|SIGKILL|SIGINT|SIGHUP|SIGABRT|SIGSEGV|SIGBUS|SIGILL|UNKNOWN)$/u.test(line));
      t.diagnostic(JSON.stringify({scenario, fixedRuntimeDiagnostics: fixed.slice(-16)}));
    }
  }
  assert.equal(results[0].status, 200);
  assert.equal(results[1].status, 200);
  assert.equal(results[1].answerReleased, true);
  assert.equal(results[2].status, 200);
  assert.equal(results[3].status, 200);
  assert.ok(results[3].calls.every(call => call.outputAllowance <= 4096));
  assert.equal(results[4].status, 200);
  assert.equal(results[5].status, 422); assert.equal(results[5].code, 'GATE_INVALID_EVIDENCE');
  assert.equal(results[5].stage, 'review');
  assert.equal(results[5].answerReleased, false);
  assert.equal(results[6].status, 422); assert.equal(results[6].code, 'COVENANT_REJECTED');
  assert.equal(results[6].answerReleased, false);
  assert.equal(results[6].calls.filter(call => call.kind === 'review').length,
    results[6].calls.filter(call => call.kind === 'answer').length,
    'A complete low assessment is not retried without a newly generated candidate.');
  assert.equal(results[7].status, 200, 'An incomplete optional planner must fall back to verified native retrieval.');
  assert.equal(results[7].answerReleased, true);
  assert.ok(results[7].calls.some(call => call.kind === 'planner'));
  assert.equal(results[8].status, 422); assert.equal(results[8].code, 'PROVIDER_CONTENT_HELD');
  assert.equal(results[8].stage, 'memory-planning');
  assert.equal(results[8].answerReleased, false);
  assert.ok(results[8].calls.every(call => call.kind === 'planner'), 'Provider policy holds cannot use the optional planner fallback.');
  assert.equal(results[9].status, 422); assert.equal(results[9].code, 'COVENANT_REJECTED');
  assert.equal(results[9].answerReleased, false, 'Memory pause cannot release a low-fruit answer.');
  for (const result of [results[5], results[6], results[9]]) {
    assert.ok(result.calls.some(call => call.kind === 'answer'), `${result.scenario} must generate an actual candidate.`);
    assert.ok(result.calls.some(call => call.kind === 'review'), `${result.scenario} must be held by an actual independent review.`);
  }
  assert.equal(results[10].code, 'PROVIDER_NO_TEXT',
    'The explicit successful empty provider stop must be held before native fallback, never reported as a generic runtime failure.');
  assert.equal(results[10].status, 422);
  assert.equal(results[10].stage, 'generation');
  assert.equal(results[10].answerReleased, false, 'An empty native reply is a generation failure, not a fabricated PoI rejection.');
  assert.ok(results[10].calls.some(call => call.kind === 'answer'));
  assert.equal(results[11].status, 200, 'The next chat must recover with the same connected model and settings.');
  assert.equal(results[11].answerReleased, true);
  assert.ok(results[11].calls.some(call => call.kind === 'answer') && results[11].calls.some(call => call.kind === 'review'),
    'Recovery must generate and independently review a real new answer, then satisfy the active commit assertions above.');
  const selected = app.store.agents[0];
  assert.equal((await engine({ op: 'verify', root: selected.root })).verified, true);
} finally {
  await app?.closeRuntime();
  if (app?.server.listening) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('ct-active-review-diagnosis-'));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
}

});
