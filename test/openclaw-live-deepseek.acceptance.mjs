// Explicit CI-only, paid-provider acceptance. Never included in the ordinary test glob.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODEL = 'deepseek-v4.1-flash';
const PROVIDER = 'https://opencode.ai/inference/go/openai/v1';
const MAX_REQUESTS = 12, MAX_USD = 1;
const SAFE_CODES = new Set(['PROVIDER_HTTP_ERROR', 'PROVIDER_RATE_LIMIT', 'PROVIDER_CONTENT_HELD',
  'PROVIDER_TIMEOUT', 'PROVIDER_CONNECTION_ERROR', 'PROVIDER_NO_TEXT', 'PROVIDER_INCOMPLETE',
  'PROVIDER_INVALID_RESPONSE', 'COVENANT_REJECTED', 'POI_REJECTED', 'GATE_INVALID_REVIEW',
  'GATE_INVALID_EVIDENCE', 'GATE_INVALID_CONTEXT', 'OPENCLAW_EMPTY_RESPONSE', 'OPENCLAW_MODEL_FAILED',
  'OPENCLAW_NATIVE_HELD', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 'OPENCLAW_START_TIMEOUT',
  'BROWSER_AUTHORITY_DENIED', 'HOST_TOOL_DENIED', 'SESSION_CHANGED', 'INTEGRITY_FAILED']);
const SAFE_STAGES = new Set(['memory-planning', 'generation', 'review', 'native-review',
  'chain-preparation', 'context', 'runtime', 'authorization', 'commitment']);
const report = { version: 1, model: MODEL, isolated: true, actualProvider: true,
  maxInferenceRequests: MAX_REQUESTS, maximumReservedUsd: MAX_USD, passed: false,
  controlCenter: {}, turns: [], upstream: [], cleanup: false };
let stage = 'opt-in', secret = '', app, browser, directory, previousFetch, browserBearer = '';
let reservedUsd = 0, requestCount = 0, pageErrors = 0;
const hold = code => Object.assign(new Error('Live acceptance held.'), { acceptanceCode: code });
function check(value, code) { if (!value) throw hold(code); }
const safeFailure = result => ({ status: result.status,
  code: SAFE_CODES.has(result.body?.code) ? result.body.code : result.status >= 400 ? 'UNCLASSIFIED_LOCAL_FAILURE' : null,
  stage: SAFE_STAGES.has(result.body?.stage) ? result.body.stage : null });
async function scanOwnedFiles(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) await scanOwnedFiles(file);
    else if (entry.isFile()) {
      const stat = await fs.stat(file); check(stat.size <= 128 * 1024 * 1024, 'OWNED_SCAN_LIMIT');
      check(!(await fs.readFile(file)).includes(Buffer.from(secret)), 'PERSISTED_CREDENTIAL_HELD');
    }
  }
}

async function main() {
  if (process.env.CT_RUN_LIVE_DEEPSEEK !== '1') {
    console.log(JSON.stringify({ version: 1, skipped: true, reason: 'Explicit live-provider opt-in is required.' }));
    return;
  }
  check(process.env.CI === 'true', 'CI_REQUIRED');
  secret = process.env.CT_LIVE_API_KEY || '';
  delete process.env.CT_LIVE_API_KEY; // The owned Gateway must never inherit this credential.
  check(secret.length >= 16 && !/[\s\x00-\x20]/u.test(secret), 'KEY_REQUIRED');
  const runtimePackage = process.env.CT_OPENCLAW_PACKAGE, runtimeNode = process.env.CT_OPENCLAW_NODE;
  const executablePath = process.env.CT_BROWSER_EXECUTABLE;
  check(runtimePackage && runtimeNode && executablePath, 'ISOLATED_RUNTIME_REQUIRED');
  check(Number(process.env.CT_LIVE_MAX_USD || 1) === 1, 'FIXED_SPEND_LIMIT_REQUIRED');
  const application = path.resolve(process.env.CT_CHAINCHAT_PACKAGE || fileURLToPath(new URL('..', import.meta.url)));
  previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return previousFetch(input, init);
    check(url.origin === 'https://opencode.ai' && !url.username && !url.password && !url.search &&
      [PROVIDER + '/chat/completions', PROVIDER + '/models'].includes(url.href), 'REMOTE_ROUTE_HELD');
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : {}));
    check(headers.get('authorization') === `Bearer ${secret}`, 'PRIVATE_AUTHORITY_REQUIRED');
    const inference = url.pathname.endsWith('/chat/completions');
    if (!inference) return previousFetch(input, { ...init, redirect: 'error' });
    check(typeof init.body === 'string' && !init.body.includes(secret), 'CREDENTIAL_BODY_HELD');
    const body = JSON.parse(init.body), output = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
    check(body.model === MODEL && Number.isSafeInteger(output) && output > 0 && output <= 8192, 'MODEL_BUDGET_HELD');
    check(headers.get('user-agent')?.startsWith('CypherTempre-ChainChat') && headers.get('x-opencode-session'), 'GO_SESSION_REQUIRED');
    // Every UTF-8 byte is reserved as an input token. These $1/$4 per-million
    // rates exceed the documented Flash peak rates; output is reserved in full,
    // including any reasoning tokens, before sending the request.
    const reserve = (Buffer.byteLength(init.body) + output * 4) / 1_000_000;
    if (requestCount >= MAX_REQUESTS || reservedUsd + reserve > MAX_USD) {
      report.budgetHeld = true; throw hold('SPEND_LIMIT_HELD');
    }
    requestCount++; reservedUsd += reserve;
    const item = { kind: init.body.includes('independent pre-release covenant reviewer') ? 'review'
      : init.body.includes('Plan retrieval for a local Timechain agent') ? 'planner' : 'answer',
      canonicalSkill: init.body.includes('name: proof-of-interaction'),
      hostContract: init.body.includes('CHAINCHAT HOST CONTRACT'), inputBytes: Buffer.byteLength(init.body),
      maximumOutputTokens: output, status: null };
    report.upstream.push(item);
    const response = await previousFetch(input, { ...init, redirect: 'error' });
    item.status = response.status;
    return response;
  };
  stage = 'create-isolated-runtime';
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-live-deepseek-')));
  const [{ createApp }, { engine }, { chromium }] = await Promise.all([
    import(pathToFileURL(path.join(application, 'server.mjs')).href),
    import(pathToFileURL(path.join(application, 'lib/engine.mjs')).href),
    Promise.resolve(createRequire(path.join(path.resolve(runtimePackage), 'package.json'))('playwright-core')),
  ]);
  app = await createApp({ dataDir: path.join(directory, 'data'), pairingCode: 'DISPOSABLE-LIVE-ACCEPTANCE',
    openclaw: { stateDir: path.join(directory, 'gateway'), packageRoot: runtimePackage, nodePath: runtimeNode,
      pluginPath: path.join(application, 'openclaw/plugin'), onDiagnostic: () => {} } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function call(route, body, bearer = browserBearer) {
    const response = await previousFetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
    const result = { status: response.status, body: await response.json() };
    check(!JSON.stringify(result.body).includes(secret), 'CREDENTIAL_RESPONSE_HELD');
    return result;
  }
  const paired = await call('/api/pair', { code: 'DISPOSABLE-LIVE-ACCEPTANCE' });
  check(paired.status === 200 && paired.body.token, 'PAIR_FAILED');
  const created = await call('/api/agents', { name: 'Cypher Tempre acceptance' }, paired.body.token);
  check(created.status === 201, 'GENESIS_FAILED');
  const selected = app.store.agents[0];
  check(selected && path.resolve(selected.root).startsWith(directory + path.sep), 'CHAIN_ISOLATION_HELD');
  const chainFile = path.join(selected.root, 'chain', 'rings.jsonl');
  const genesisBytes = await fs.readFile(chainFile);
  stage = 'browser-authentication';
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(); page.setDefaultTimeout(120000);
  page.on('pageerror', () => pageErrors++);
  page.on('response', async response => {
    if (response.url() === origin + '/api/launch' && response.status() === 200) {
      try { browserBearer = (await response.json()).token || ''; } catch {}
    }
  });
  await page.goto(origin + '/#launch=' + app.issueLaunchNonce(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !location.hash && document.getElementById('agentName').textContent === 'Cypher Tempre acceptance');
  check(browserBearer, 'BROWSER_AUTH_FAILED');
  if (await page.locator('#setupDialog').evaluate(node => node.open)) await page.locator('#setupDismiss').click();
  stage = 'control-center';
  await page.waitForFunction(() => !document.getElementById('nativeConnectedControls').disabled, null, { timeout: 150000 });
  report.controlCenter = await page.evaluate(() => ({
    enabled: !document.getElementById('nativeConnectedControls').disabled,
    fieldCount: document.querySelectorAll('#nativeConfigFormMount input, #nativeConfigFormMount textarea, #nativeConfigFormMount select').length,
    textareaCount: document.querySelectorAll('#nativeConfigFormMount textarea').length,
    nativeTextareaTypes: [...document.querySelectorAll('#nativeConfigFormMount textarea')].every(node => node.type === 'textarea'),
    permissionRevocationEnabled: !document.getElementById('disableNativeTools').disabled,
    configurationFormActive: !document.getElementById('nativeConfigFormMount').inert,
    errorEmpty: !document.getElementById('nativeError').textContent.trim(),
  }));
  check(report.controlCenter.enabled && report.controlCenter.fieldCount > 0 && report.controlCenter.textareaCount > 0 &&
    report.controlCenter.nativeTextareaTypes && report.controlCenter.permissionRevocationEnabled &&
    report.controlCenter.configurationFormActive && report.controlCenter.errorEmpty, 'CONTROL_CENTER_FAILED');
  stage = 'model-connection';
  if (await page.locator('#setupDialog').evaluate(node => node.open)) await page.locator('#setupDismiss').click();
  await page.locator('#modelButton').click();
  await page.locator('#modelDialog details').evaluateAll(nodes => { for (const node of nodes) node.open = true; });
  await page.locator('#provider').selectOption('compatible');
  await page.locator('#modelId').fill(MODEL); await page.locator('#baseUrl').fill(PROVIDER);
  await page.locator('#modelContextWindow').fill('65536'); await page.locator('#modelOutputLimit').fill('8192');
  await page.locator('#apiKey').fill(secret);
  const connected = page.waitForResponse(response => response.url() === origin + '/api/provider' && response.request().method() === 'POST');
  await page.locator('#connectByokModel').click();
  const connectedResponse = await connected, connectedBody = await connectedResponse.json();
  check(connectedResponse.status() === 200 && !JSON.stringify(connectedBody).includes(secret), 'MODEL_CONNECTION_FAILED');
  await page.waitForFunction(() => !document.getElementById('modelDialog').open && document.getElementById('apiKey').value === '');
  check(await page.evaluate(key => !JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(key), secret), 'BROWSER_STORAGE_HELD');
  const activeState = await call('/api/state');
  check(activeState.status === 200 && activeState.body.gate?.required === true && activeState.body.cognition?.learning === true,
    'ACTIVE_POI_REQUIRED');
  report.keyInputCleared = true; report.browserStorageContainsNoKey = true;
  for (const [name, prompt] of [['introduction', 'Please introduce yourself in one short paragraph.'],
    ['coding', 'Write a short JavaScript function that adds two numbers. Give one example; do not use any tools.']]) {
    stage = `chat-${name}`;
    const before = await fs.readFile(chainFile), start = report.upstream.length;
    const responsePromise = page.waitForResponse(response => response.url() === origin + '/api/chat' && response.request().method() === 'POST', { timeout: 240000 });
    await page.locator('#messageInput').fill(prompt); await page.locator('#sendButton').click();
    const response = await responsePromise, body = await response.json(), result = { status: response.status(), body };
    check(!JSON.stringify(body).includes(secret), 'CREDENTIAL_CHAT_HELD');
    const current = report.upstream.slice(start), after = await fs.readFile(chainFile);
    const record = { name, ...safeFailure(result), approved: body.message?.gate?.approved === true,
      required: body.state?.gate?.required === true, responseReleased: typeof body.message?.content === 'string' && !!body.message.content.trim(),
      responseCharacters: typeof body.message?.content === 'string' ? body.message.content.length : 0,
      responseSha256: typeof body.message?.content === 'string' ? createHash('sha256').update(body.message.content).digest('hex') : null,
      ringIndex: Number.isSafeInteger(body.message?.ring?.index) ? body.message.ring.index : null,
      oldChainPrefixPreserved: after.subarray(0, before.length).equals(before), chainAdvanced: after.length > before.length,
      modelRequests: current.length, answerWoreSkill: current.some(item => item.kind === 'answer' && item.canonicalSkill && item.hostContract),
      independentlyReviewed: current.some(item => item.kind === 'review' && item.status === 200) };
    report.turns.push(record);
    check(record.status === 200 && record.approved && record.required && record.responseReleased && record.ringIndex !== null &&
      record.chainAdvanced && record.oldChainPrefixPreserved && record.answerWoreSkill && record.independentlyReviewed, 'ACTIVE_CHAT_FAILED');
    await page.waitForFunction(() => !document.getElementById('sendButton').disabled);
    check(await page.locator('#messages .message.assistant:not(.held)').count() >= report.turns.length, 'CHAT_UI_FAILED');
  }
  stage = 'final-verification';
  const verified = await engine({ op: 'verify', root: selected.root });
  check(verified.verified === true, 'FINAL_CHAIN_INVALID');
  check((await fs.readFile(chainFile)).subarray(0, genesisBytes.length).equals(genesisBytes), 'GENESIS_CHANGED');
  await scanOwnedFiles(directory);
  report.keyAbsentFromOwnedFiles = true; report.chainVerified = true; report.pageErrors = pageErrors;
  check(pageErrors === 0, 'BROWSER_SCRIPT_ERROR'); report.passed = true;
}

try { await main(); }
catch (error) { report.failure = { stage, code: /^[A-Z_]{3,64}$/u.test(error?.acceptanceCode || '') ? error.acceptanceCode : 'LIVE_ACCEPTANCE_FAILED',
  kind: ['TimeoutError', 'TypeError', 'ReferenceError', 'SyntaxError'].includes(error?.name) ? error.name : null }; }
finally {
  let cleaned = true;
  try { await browser?.close(); } catch { cleaned = false; }
  try { await app?.closeRuntime(); } catch { cleaned = false; }
  try { if (app?.server.listening) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); } } catch { cleaned = false; }
  if (directory && secret) {
    try { await scanOwnedFiles(directory); report.keyAbsentAfterShutdown = true; }
    catch {
      report.keyAbsentAfterShutdown = false; report.passed = false;
      report.failure ||= { stage: 'post-shutdown-key-scan', code: 'SHUTDOWN_CREDENTIAL_SCAN_HELD', kind: null };
    }
  }
  if (previousFetch) globalThis.fetch = previousFetch;
  try {
    if (directory) {
      check(directory.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('ct-live-deepseek-'), 'CLEANUP_PATH_HELD');
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
    }
  } catch { cleaned = false; }
  secret = ''; browserBearer = '';
  if (process.env.CT_RUN_LIVE_DEEPSEEK === '1') {
    report.cleanup = cleaned; report.reservedCostUsd = Number(reservedUsd.toFixed(6)); report.inferenceRequests = requestCount;
    if (!cleaned) report.passed = false;
    const safe = JSON.stringify(report, null, 2);
    if (process.env.CT_LIVE_REPORT) await fs.writeFile(path.resolve(process.env.CT_LIVE_REPORT), safe + '\n', { mode: 0o600 });
    console.log(safe); process.exitCode = report.passed ? 0 : 1;
  }
}
