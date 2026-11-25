/** CI-only real 11.10 startup with disposable state from an earlier installation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenClawGateway } from '../openclaw/gateway.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE;
const nodePath = process.env.CT_OPENCLAW_NODE;

test('retired native Heartbeat settings preserve legacy records and cannot start unreviewed work', {
  skip: process.env.CI !== 'true' || !packageRoot || !nodePath ? 'Set the pinned native runtime in isolated CI.' : false,
  timeout: 300000,
}, async t => {
  const temp = await fs.realpath(os.tmpdir());
  const directory = await fs.realpath(await fs.mkdtemp(path.join(temp, 'ct-retired-heartbeat-')));
  const stateDir = path.join(directory, 'gateway');
  const configFile = path.join(stateDir, 'controls.json');
  const bindingsFile = path.join(stateDir, 'native-run-bindings.json');
  const identity = { agentId: 'previous-heartbeat-owner', genesisHash: 'b'.repeat(64) };
  const ownerKey = identity.agentId + ':' + identity.genesisHash;
  const legacy = { ownerKey, kind: 'heartbeat', agentId: 'main' };
  const legacyControls = JSON.stringify({ version: 1, revision: 'a'.repeat(64), patch: {
    logging: { consoleLevel: 'debug' },
    agents: { defaults: { heartbeat: { every: '1s', prompt: 'Legacy review checklist.', target: 'none' } } },
  } }) + '\n';
  const legacyBindings = JSON.stringify({ version: 2, jobs: [], sources: [legacy] }) + '\n';
  let manager, broker, ownerRequests = 0, modelRequests = 0, engineRequests = 0;
  let diagnostics = '';
  t.after(async () => {
    try { await manager?.close(); }
    finally {
      try { await broker?.close(); }
      finally {
        assert.equal(path.dirname(directory), temp);
        assert.ok(path.basename(directory).startsWith('ct-retired-heartbeat-'));
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      }
    }
  });

  await fs.mkdir(stateDir, { mode: 0o700 });
  await fs.writeFile(configFile, legacyControls, { mode: 0o600 });
  await fs.writeFile(bindingsFile, legacyBindings, { mode: 0o600 });

  broker = createPoIBroker({
    engine: async () => { engineRequests++; assert.fail('Retired heartbeat cannot prepare or write a Timechain.'); },
    review: async () => assert.fail('Retired heartbeat cannot request a model review.'),
  });
  await broker.start();
  manager = createOpenClawGateway({
    stateDir, packageRoot, nodePath, broker,
    pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)),
    onDiagnostic: line => { diagnostics = (diagnostics + line).slice(-10000); },
    nativeCapabilities: () => ({ enabled: true, acknowledged: true, tools: [], settings: [], backgroundRuns: true }),
    resolveNativeModelRoute: async () => { modelRequests++; return null; },
    resolveNativeOwner: async () => { ownerRequests++; return null; },
  });

  try {
    await manager.start();
    assert.equal(manager.status().healthy, true);
    assert.equal(manager.status().enforcementHealthy, true);
    const controls = await manager.describeControls(identity);
    assert.equal(controls.nativeConfig.config.agents?.defaults?.heartbeat, undefined);
    assert.equal(controls.nativeConfig.config.logging.consoleLevel, 'debug');
    const before = await manager.nativeSources({ identity, action: 'list' });
    assert.equal(before.available.heartbeatRetired, true);
    assert.ok(before.available.agents.some(row => row.id === 'main' && row.heartbeat === false));
    assert.equal(before.sources.length, 1);
    const [saved] = before.sources;
    assert.equal(saved.kind, 'heartbeat');
    assert.match(saved.id, /^[a-f0-9]{64}$/);
    assert.equal(await fs.readFile(configFile, 'utf8'), legacyControls);
    assert.equal(await fs.readFile(bindingsFile, 'utf8'), legacyBindings);

    const retired = { code: 'OPENCLAW_HEARTBEAT_RETIRED', status: 409 };
    await assert.rejects(manager.nativeSources({ identity, action: 'enroll', source: { kind: 'heartbeat', agentId: 'main' } }), retired);
    await assert.rejects(manager.nativeSources({ identity, action: 'scratch-get', id: saved.id }), retired);
    await assert.rejects(manager.nativeSources({ identity, action: 'scratch-set', id: saved.id, content: 'Ignored', expectedRevision: 0 }), retired);
    assert.equal(await fs.readFile(bindingsFile, 'utf8'), legacyBindings);
    assert.equal(await fs.readFile(configFile, 'utf8'), legacyControls);
    assert.equal(ownerRequests, 0);
    assert.equal(modelRequests, 0);
    assert.equal(engineRequests, 0);

    const revoked = await manager.nativeSources({ identity, action: 'revoke', id: saved.id });
    assert.deepEqual(revoked.sources, []);
    assert.equal(revoked.available.heartbeatRetired, true);
    assert.equal(await fs.readFile(configFile, 'utf8'), legacyControls);
  } catch (error) {
    t.diagnostic(diagnostics);
    throw error;
  }
});
