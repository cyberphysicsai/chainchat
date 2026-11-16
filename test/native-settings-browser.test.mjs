import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, executablePath = process.env.CT_BROWSER_EXECUTABLE;

test('native settings render and save with real browser textarea semantics', {
  skip: !packageRoot || !executablePath ? 'Set isolated OpenClaw package and browser executable paths for the DOM smoke test.' : false,
  timeout: 60000,
}, async t => {
  // Resolve only Playwright; this test never imports the native SDK or starts a Gateway.
  const { chromium } = createRequire(path.join(path.resolve(packageRoot), 'package.json'))('playwright-core');
  const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
  const html = (await fs.readFile(path.join(publicDirectory, 'index.html'), 'utf8'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, 'http://fixture.invalid').pathname);
      const filename = path.resolve(publicDirectory, `.${pathname}`), relative = path.relative(publicDirectory, filename);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { response.writeHead(403); response.end(); return; }
      const body = pathname === '/' ? html : await fs.readFile(filename);
      response.writeHead(200, { 'content-type': pathname === '/' ? 'text/html' : types[path.extname(filename)] || 'application/octet-stream',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const { initOpenClawSettings } = await import('/openclaw-settings.js');
    const effective = { agents: { defaults: { maxRetries: 2, notes: 'First line\nSecond line', labels: { testing: 'local' }, aliases: ['one'] } } };
    const snapshot = { runtime: { version: '2026.11.3' }, selectedAgentId: 'dom-fixture', sessionKey: 'agent:main:dom-fixture', commands: [],
      schema: { schema: { type: 'object', properties: { agents: { type: 'object', properties: { defaults: { type: 'object', properties: {
        maxRetries: { type: 'integer', minimum: 0, maximum: 8 }, notes: { type: 'string' },
        labels: { type: 'object', additionalProperties: { type: 'string' } }, aliases: { type: 'array', items: { type: 'string' } },
      } } } } } }, uiHints: { 'agents.defaults.notes': { multiline: true } } },
      config: { revision: 'r1', baseHash: 'hash-r1', effective, editable: {}, immutablePaths: ['gateway'], guards: { gateway: 'Private transport.' } },
      nativeConfig: { config: effective, hash: 'hash-r1' }, services: { jobs: [], channels: [], occurrences: [] },
      toolCatalogue: [{ name: 'browser', available: true }],
      toolAuthority: { grant: { enabled: true, acknowledged: true, tools: ['browser'], networkHosts: ['example.com'] } } };
    const fixture = window.__nativeSettingsFixture = { calls: [], channelsCompleted: 0 };
    const api = async (route, payload) => {
      fixture.calls.push({ route, payload: structuredClone(payload) });
      if (route === '/api/openclaw') return snapshot;
      if (route === '/api/openclaw/channels') { fixture.channelsCompleted++; return { items: [] }; }
      if (route === '/api/openclaw/secrets') return { targets: [], bindings: [] };
      if (route === '/api/openclaw/config') {
        effective.agents.defaults.maxRetries = payload.patch.agents.defaults.maxRetries;
        snapshot.config.editable = structuredClone(payload.patch); snapshot.config.revision = 'r2';
        snapshot.config.baseHash = snapshot.nativeConfig.hash = 'hash-r2';
      }
      return {};
    };
    fixture.controller = initOpenClawSettings({ api, requireConnection: action => action(), executeCommand: async () => ({}), isConnected: () => true });
    fixture.controller.syncConnection({ connected: true, agentId: 'dom-fixture' });
  });
  await page.waitForFunction(() => window.__nativeSettingsFixture.channelsCompleted === 1 && !document.getElementById('nativeConnectedControls').disabled);
  assert.equal(await page.locator('#nativeError').textContent(), '');
  assert.equal(await page.locator('#saveNativeConfig').isDisabled(), false);
  assert.equal(await page.locator('#nativeToolHosts').inputValue(), 'example.com');
  const editors = await page.locator('#nativeConfigFormMount textarea').evaluateAll(nodes => nodes.map(node => ({ type: node.type, rows: node.rows, value: node.value })));
  assert.ok(editors.some(node => node.type === 'textarea' && node.rows === 3 && node.value === 'First line\nSecond line'));
  assert.ok(editors.some(node => node.type === 'textarea' && node.rows === 5 && node.value === JSON.stringify({ testing: 'local' }, null, 2)));
  assert.ok(editors.some(node => node.type === 'textarea' && node.rows === 5 && node.value === JSON.stringify(['one'], null, 2)));
  assert.equal(await page.locator('#nativeConfigFormMount textarea').first().evaluate(node => {
    try { (function () { 'use strict'; node.type = 'text'; })(); return false; } catch (error) { return error instanceof TypeError && node.type === 'textarea'; }
  }), true);
  const retries = page.locator('input[aria-label="agents.defaults.maxRetries"]');
  assert.deepEqual(await retries.evaluate(node => ({ type: node.type, step: node.step, min: node.min, max: node.max })), { type: 'number', step: '1', min: '0', max: '8' });
  await retries.fill('4'); await retries.dispatchEvent('change');
  await page.locator('#saveNativeConfig').click();
  await page.waitForFunction(() => window.__nativeSettingsFixture.channelsCompleted >= 2);
  const payload = await page.evaluate(() => window.__nativeSettingsFixture.calls.find(item => item.route === '/api/openclaw/config')?.payload);
  assert.deepEqual(payload, { patch: { agents: { defaults: { maxRetries: 4 } } }, removePaths: [], revision: 'r1', baseHash: 'hash-r1' });
  assert.equal(await retries.inputValue(), '4');
  assert.equal(await page.locator('#nativeError').textContent(), '');
  assert.deepEqual(pageErrors, []);
});
