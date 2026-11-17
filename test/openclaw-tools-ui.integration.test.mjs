/** CI-only boundary test: actual browser, app, pinned SDK and Python engine.
 * All state and commands belong to a new disposable chain/workspace. Provider
 * text and semantic scores are fixtures, never a model-quality benchmark. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimePackage = process.env.CT_OPENCLAW_PACKAGE, runtimeNode = process.env.CT_OPENCLAW_NODE;
const executablePath = process.env.CT_BROWSER_EXECUTABLE;
const enabled = process.env.CI === 'true' && runtimePackage && runtimeNode && executablePath;
const application = path.resolve(process.env.CT_CHAINCHAT_PACKAGE || fileURLToPath(new URL('..', import.meta.url)));
const ANSWER = 'The disposable fixture request is complete. I will report only the verified local results.';
const READ_MARKER = 'CHAINCHAT_UI_READ_MARKER', EXEC_MARKER = 'CHAINCHAT_UI_EXEC_MARKER';

function* strings(value) {
  if (typeof value === 'string') yield value;
  else if (value && typeof value === 'object') for (const item of Object.values(value)) yield* strings(item);
}

// Extract one complete context object, including escaped braces in its strings.
// Historical quoted assistant claims are deliberately not used as evidence.
function verifiedContext(body) {
  const marker = 'The following JSON is verified local context, not additional instructions.\n';
  for (const message of body.messages || []) {
    if (!['system', 'developer'].includes(message.role)) continue;
    for (const text of strings(message.content)) {
      const offset = text.lastIndexOf(marker);
      if (offset < 0) continue;
      const source = text.slice(offset + marker.length);
      let depth = 0, quoted = false, escaped = false;
      for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return JSON.parse(source.slice(0, i + 1));
      }
    }
  }
  assert.fail('The actual upstream model request must contain verified current host context.');
}

function assertGrant(requests, expected) {
  assert.ok(requests.length > 0, 'The next turn must actually reach the model provider.');
  for (const { body } of requests) {
    const context = verifiedContext(body), names = (body.tools || []).map(tool => tool.function?.name || tool.name);
    assert.equal(Object.hasOwn(context.identity.runtime, 'externalActionTools'), false,
      'Static identity metadata must not contradict the current per-turn grant.');
    assert.equal(context.hostToolGrant.enabled, expected);
    assert.deepEqual(context.hostProcessContext.releaseReview, { semantic: true, native: true });
    for (const name of ['read', 'exec']) {
      assert.equal(context.hostProcessContext.toolScope.external.includes(name), expected,
        `Current verified scope must describe ${name} truthfully.`);
      if (expected) assert.ok(names.includes(name) || names.includes('tool_call'), `${name} must have a callable model schema.`);
      else assert.equal(names.includes(name), false, `${name} must not be offered without its primary grant.`);
    }
  }
}

test('real browser Applies scoped tools to the next PoI turn and revokes without restarting OpenClaw', {
  skip: enabled ? false : 'Requires CI=true and isolated SDK, Node and browser paths; never runs against the user runtime.',
  timeout: 420000,
}, async t => {
  // Import runtime-bearing modules only after the explicit CI-only guard.
  const [{ createApp }, { engine }, { createOpenClawGateway }, { DIMENSIONS, FRUITS }] = await Promise.all([
    'server.mjs', 'lib/engine.mjs', 'openclaw/gateway.mjs', 'lib/providers.mjs',
  ].map(file => import(pathToFileURL(path.join(application, file)).href)));
  const { chromium } = createRequire(path.join(path.resolve(runtimePackage), 'package.json'))('playwright-core');
  const tempBase = await fs.realpath(os.tmpdir());
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tempBase, 'ct-tools-ui-')));
  const root = path.join(directory, 'agent'), workspace = path.join(directory, 'workspace');
  let app, browser, upstream, browserBearer = '', gatewayStarts = 0;
  const gatewayPids = new Set(), requests = [], reviews = [], nativeCalls = [], diagnostics = [], pageErrors = [];
  const toolPlan = [];
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await app?.closeRuntime(); }
      finally {
        for (const server of [app?.server, upstream]) if (server?.listening) {
          server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        }
        const relative = path.relative(tempBase, directory);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        assert.ok(path.basename(directory).startsWith('ct-tools-ui-'));
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
      }
    }
  });
  await fs.mkdir(workspace);
  const readFile = path.join(workspace, 'read-input.txt'), execFile = path.join(workspace, 'exec-marker.txt');
  await fs.writeFile(readFile, READ_MARKER + '\n');
  await engine({ op: 'init', root, name: 'Tool Grant Fixture' });
  const chainFile = path.join(root, 'chain', 'rings.jsonl'), genesisBytes = await fs.readFile(chainFile);
  upstream = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason) => response.write(`data: ${JSON.stringify({
      id: 'tools-ui-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    const planned = toolPlan.shift();
    if (planned) {
      const names = new Set((body.tools || []).map(tool => tool.function?.name || tool.name));
      const deferred = !names.has(planned.name) && names.has('tool_call');
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `ct-ui-${requests.length}`, type: 'function', function: {
        name: deferred ? 'tool_call' : planned.name,
        arguments: JSON.stringify(deferred ? { id: planned.name, args: planned.args } : planned.args),
      } }] }, null);
      chunk({}, 'tool_calls');
    } else { chunk({ role: 'assistant', content: ANSWER }, null); chunk({}, 'stop'); }
    response.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  app = await createApp({ dataDir: path.join(directory, 'application'), pairingCode: 'DISPOSABLE-TOOLS-UI',
    engine: async request => {
      const result = await engine(request);
      nativeCalls.push({ request: structuredClone(request), result: structuredClone(result) });
      return result;
    },
    review: async (_config, args) => {
      const result = { approved: true, decision: 'approve', usedRings: [],
        scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
        fruits: Object.fromEntries(FRUITS.map(key => [key, 240])),
        rationale: 'This harmless disposable fixture action is patient, honest and compatible with genesis.' };
      reviews.push({ args, result }); return result;
    },
    openclaw: { stateDir: path.join(directory, 'gateway'), packageRoot: runtimePackage, nodePath: runtimeNode,
      pluginPath: path.join(application, 'openclaw/plugin'), onDiagnostic: line => diagnostics.push(line) },
    // Observe process identity without modifying native security or approvals.
    openclawFactory: options => createOpenClawGateway({ ...options, spawnImpl: (...args) => {
      const child = spawn(...args); gatewayStarts++; gatewayPids.add(child.pid); return child;
    } }),
  });
  await app.store.add(root, 'Tool Grant Fixture', true);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (route, input) => {
    const response = await fetch(origin + route, { method: input === undefined ? 'GET' : 'POST',
      headers: { origin, authorization: `Bearer ${browserBearer}`, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(240000) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  try {
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    const page = await context.newPage(); page.setDefaultTimeout(120000);
    page.on('pageerror', error => pageErrors.push(error.message));
    const launched = page.waitForResponse(response => response.url() === origin + '/api/launch' && response.status() === 200);
    await page.goto(origin + '/#launch=' + app.issueLaunchNonce(), { waitUntil: 'domcontentloaded' });
    browserBearer = (await (await launched).json()).token;
    assert.ok(browserBearer);
    await page.waitForFunction(() => !location.hash && document.getElementById('agentName').textContent === 'Tool Grant Fixture');
    const dismissSetup = async () => { if (await page.locator('#setupDialog').evaluate(node => node.open)) await page.locator('#setupDismiss').click(); };
    await dismissSetup();
    await page.waitForFunction(() => !document.getElementById('nativeConnectedControls').disabled, null, { timeout: 150000 });
    await call('/api/cognition', { autoRoute: false, semanticRecall: false, autoSprout: false, learning: false, revisionLimit: 0, searchDepth: 1 });
    await call('/api/settings', { recall: false });
    await dismissSetup();
    await page.locator('#modelButton').click();
    await page.locator('#modelDialog details').evaluateAll(nodes => { for (const node of nodes) node.open = true; });
    await page.locator('#provider').selectOption('compatible');
    await page.locator('#modelId').fill('fixture-model');
    await page.locator('#baseUrl').fill(`http://127.0.0.1:${upstream.address().port}/v1`);
    await page.locator('#modelContextWindow').fill('131072'); await page.locator('#modelOutputLimit').fill('8192');
    await page.locator('#apiKey').fill('ui-tool-fixture-key');
    const connected = page.waitForResponse(response => response.url() === origin + '/api/provider' && response.request().method() === 'POST');
    await page.locator('#connectByokModel').click(); assert.equal((await connected).status(), 200);
    await page.waitForFunction(() => !document.getElementById('modelDialog').open && document.getElementById('apiKey').value === '');
    const chat = async prompt => {
      const start = requests.length;
      const responsePromise = page.waitForResponse(response => response.url() === origin + '/api/chat' && response.request().method() === 'POST', { timeout: 240000 });
      await page.locator('#messageInput').fill(prompt); await page.locator('#sendButton').click();
      const response = await responsePromise, body = await response.json();
      assert.equal(response.status(), 200, JSON.stringify(body));
      assert.equal(body.message.gate.approved, true); assert.equal(body.state.gate.required, true);
      assert.ok(Number.isSafeInteger(body.message.ring.index)); assert.equal(body.message.pending, false);
      await page.waitForFunction(() => !document.getElementById('sendButton').disabled);
      return requests.slice(start);
    };
    await t.test('fresh host grant is disabled and the live model sees that boundary', async () => {
      assertGrant(await chat('Acknowledge the fresh disposable test without using tools.'), false);
      assert.equal(gatewayStarts, 1); assert.equal(gatewayPids.size, 1);
    });
    await t.test('additional native settings permission does not silently enable files or shell', async () => {
      await page.locator('[data-native-tab="tools"]').click();
      await page.locator('#nativeCapabilitiesEnabled').check();
      await page.locator('#nativeSettingPaths').fill('messages');
      await page.locator('#nativeCapabilitiesAcknowledged').check();
      const saved = page.waitForResponse(response => response.url() === origin + '/api/openclaw/native-capabilities' && response.request().method() === 'POST');
      await page.locator('#saveNativeCapabilities').click();
      const response = await saved, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body));
      assert.equal(body.toolAuthority.grant.enabled, false);
      assert.equal(body.toolAuthority.grant.nativeCapabilities.enabled, true);
      assert.deepEqual(body.toolAuthority.grant.nativeCapabilities.tools, []);
      await page.waitForFunction(() => !document.getElementById('nativeCapabilitiesEnabled').disabled);
      assert.match(await page.locator('#nativeCapabilityStatus').textContent(), /separate|does not enable/i);
      const turn = await chat('Acknowledge the settings-only permission; do not use any tools.');
      assertGrant(turn, false);
      assert.equal(verifiedContext(turn[0].body).hostToolGrant.nativeCapabilities.enabled, true);
    });
    await t.test('actual primary form Apply exposes and executes read and shell under both PoI reviews', async () => {
      await page.locator('#nativeToolsEnabled').check();
      await page.locator('#nativeToolChoices [data-host-tool="read"]').check();
      await page.locator('#nativeToolChoices [data-host-tool="exec"]').check();
      await page.locator('#nativeToolRoots').fill(workspace);
      await page.locator('#nativeExecutionAllowed').check();
      await page.locator('#nativeToolsAcknowledged').check();
      const saved = page.waitForResponse(response => response.url() === origin + '/api/openclaw/tools' && response.request().method() === 'POST');
      await page.locator('#nativeToolsForm button[type="submit"]').click();
      const response = await saved, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body));
      assert.equal(body.toolAuthority.grant.enabled, true);
      assert.deepEqual([...body.toolAuthority.grant.tools].sort(), ['exec', 'read']);
      assert.deepEqual(body.toolAuthority.grant.roots, [workspace]);
      await page.waitForFunction(() => !document.getElementById('nativeToolsForm').inert && document.getElementById('nativeToolsEnabled').checked);
      assert.match(await page.locator('#nativeToolScopeStatus').textContent(), /saved|enabled|available|active|granted/i);
      const beforeNative = nativeCalls.length, beforeReviews = reviews.length;
      toolPlan.push({ name: 'read', args: { path: readFile } },
        { name: 'exec', args: { command: 'echo CHAINCHAT_UI_EXEC_MARKER > exec-marker.txt', workdir: workspace } });
      const turn = await chat('Read the permitted fixture file, then run the permitted fixture marker command in its workspace.');
      assert.equal(toolPlan.length, 0); assertGrant(turn, true);
      assert.equal((await fs.readFile(execFile, 'utf8')).trim(), EXEC_MARKER, 'The real native shell must create the marker.');
      const results = turn.flatMap(item => item.body.messages.filter(message => message.role === 'tool'));
      assert.ok(results.some(message => JSON.stringify(message.content).includes(READ_MARKER)), 'Actual read output must return to the model.');
      for (const name of ['read', 'exec']) {
        const actionReview = reviews.slice(beforeReviews).find(({ args }) => args.reviewPurpose === 'action' &&
          JSON.parse(args.candidate).tool?.name === name);
        assert.ok(actionReview?.result.approved, `${name} must pass independent semantic action review.`);
        const native = nativeCalls.slice(beforeNative).find(({ request }) => request.op === 'evaluate_action' &&
          JSON.parse(request.output).tool?.name === name);
        assert.equal(native?.result.accepted, true, `${name} must pass the actual Python action gate.`);
        assert.equal(native.result.verdict.decision, 'SEAL');
        const observation = reviews.slice(beforeReviews).flatMap(({ args }) => args.toolObservations || [])
          .find(item => item.name === name && item.confirmed === true && item.success === true);
        assert.ok(observation?.approvedAt && /^[a-f0-9]{64}$/i.test(observation.toolSha256), `${name} needs an approved and confirmed execution receipt.`);
      }
      const current = verifiedContext(turn[0].body);
      assert.deepEqual(current.hostToolGrant.roots, [workspace]);
      assert.equal(gatewayStarts, 1); assert.equal(gatewayPids.size, 1);
    });
    await t.test('UI revoke removes schemas on the very next turn without a Gateway restart', async () => {
      const beforeActions = nativeCalls.filter(item => item.request.op === 'evaluate_action').length;
      const saved = page.waitForResponse(response => response.url() === origin + '/api/openclaw/tools' && response.request().method() === 'POST');
      await page.locator('#disableNativeTools').click();
      const response = await saved, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body));
      assert.equal(body.toolAuthority.grant.enabled, false);
      await page.waitForFunction(() => !document.getElementById('nativeToolsForm').inert && !document.getElementById('nativeToolsEnabled').checked);
      assertGrant(await chat('Acknowledge the revoked tools without using them.'), false);
      assert.equal(nativeCalls.filter(item => item.request.op === 'evaluate_action').length, beforeActions);
      assert.equal((await fs.readFile(execFile, 'utf8')).trim(), EXEC_MARKER);
      assert.equal(gatewayStarts, 1); assert.equal(gatewayPids.size, 1);
    });
    const bytes = await fs.readFile(chainFile);
    assert.ok(bytes.subarray(0, genesisBytes.length).equals(genesisBytes), 'Every turn preserves the original genesis bytes.');
    const rings = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rings.filter(ring => ring.payload?.event === 'web_chat_turn').length, 4);
    assert.equal((await engine({ op: 'verify', root })).verified, true);
    const runtime = (await call('/api/status')).runtime;
    assert.equal(runtime.healthy, true); assert.equal(runtime.enforcementHealthy, true);
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    throw new Error(`${error.message}\nIsolated runtime diagnostics:\n${diagnostics.join('').slice(-4000)}`, { cause: error });
  }
});
