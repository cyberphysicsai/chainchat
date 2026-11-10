import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const execute = promisify(execFile);
const corpusSeed = `
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / "engine" / "proof-of-interaction"))
from continuum import Continuum
from timechain import Timechain
from immune import Immune
root, action = sys.argv[1:]
if action == "lock":
    Immune(root).lockdown()
elif action == "append":
    Timechain(root).seal("test", {"summary": "Independent native write"})
else:
    chain = Continuum(root, target=12000, min_=1, max_=15000)
    chain.open_task("Review local implementation", items_total=1)
    chain.ingest("local-example.py", "quorumThreshold = 37\\n" + ("arithmetic calibration example " * 730), label=False)
`;

test('owner-only maintenance preserves verified history and resumes a native corpus review', {timeout: 120_000}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-maintenance-test-'));
  const hosted = 'https://chainchat-maintenance-fixture.invalid';
  const noModel = () => assert.fail('Local maintenance must never call a model provider');
  const app = await createApp({ dataDir: directory, pairingCode: 'OWNER-MAINTENANCE', publicOrigins: [hosted],
    generate: noModel, review: noModel });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    assert.equal(path.basename(directory).startsWith('ct-maintenance-test-'), true);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const endpoint = '/api/timechain/maintenance';
  async function post(route, input, token, page = origin, status = 200) {
    const response = await fetch(origin + route, { method: 'POST', body: JSON.stringify(input), headers: {
      origin: page, 'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}),
    } });
    const payload = await response.json();
    assert.equal(response.status, status, JSON.stringify(payload));
    return payload;
  }
  assert.equal((await post(endpoint, { action: 'list' }, null, origin, 401)).code, 'PAIR_REQUIRED');
  const remote = (await post('/api/pair', { code: 'OWNER-MAINTENANCE' }, null, hosted)).token;
  assert.equal((await post(endpoint, { action: 'list' }, remote, hosted, 403)).code, 'LOCAL_ONLY');
  const owner = (await post('/api/pair', { code: 'OWNER-MAINTENANCE' })).token;
  const { agent } = await post('/api/agents', {name: 'MaintenanceFixture'}, owner, origin, 201);
  const command = (action, options, status = 200) => post(endpoint, {action, agentId: agent.id, ...options}, owner, origin, status);
  const preview = (action, details) => command(action, {...details, phase: 'preview'});
  const apply = (action, details, plan, status) => command(action, {...details, phase: 'apply', confirm: true, previewDigest: plan.previewDigest}, status);
  const native = action => execute(process.env.CT_CHAT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-c', corpusSeed, agent.root, action], { cwd: path.dirname(import.meta.dirname), windowsHide: true,
      env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1'} });

  const grown = path.join(agent.root, 'registry', 'grown.json');
  const legacy = Buffer.concat([Buffer.from('{"registry":"grown","modalities":[],"senses":[],"note":"legacy '),
    Buffer.from([0x97]), Buffer.from(' text"}')]);
  await fs.writeFile(grown, legacy);
  const listed = await post(endpoint, {action: 'list'}, owner);
  assert.equal(listed.agents[0].id, agent.id);
  const target = {target: 'registry/grown.json'};
  const encoding = await preview('encoding', target);
  assert.equal(encoding.plan.recoverable, true);
  assert.equal((await command('encoding', {...target, phase: 'apply'}, 409)).code, 'CONFIRMATION_REQUIRED');
  await fs.writeFile(grown, Buffer.concat([legacy, Buffer.from('\n')]));
  assert.equal((await apply('encoding', target, encoding, 422)).code, 'STALE_PREVIEW');
  assert.deepEqual(await fs.readFile(grown), Buffer.concat([legacy, Buffer.from('\n')]));
  const conversion = await apply('encoding', target, await preview('encoding', target));
  assert.deepEqual(await fs.readFile(path.join(path.dirname(grown), conversion.receipt.backup)), Buffer.concat([legacy, Buffer.from('\n')]));
  assert.match(await fs.readFile(grown, 'utf8'), /legacy — text/);

  const registry = {target: 'registry/senses.json', ring: 0};
  const snapshot = (await command('snapshots', {target: registry.target})).snapshots;
  assert.equal(snapshot[0].valid, true);
  const originalRings = await fs.readFile(path.join(agent.root, 'chain', 'rings.jsonl'));
  await apply('restore-registry', registry, await preview('restore-registry', registry));
  assert.deepEqual(await fs.readFile(path.join(agent.root, 'chain', 'rings.jsonl')), originalRings);
  const anchor = {reason: 'Owner reviewed restored registry and byte-exact backup'};
  assert.equal((await apply('reanchor', anchor, await preview('reanchor', anchor))).receipt.reanchored, true);

  const settings = { witnesses: 3, threshold: 2 };
  const firstWitnessPlan = await preview('witness-init', settings);
  await native('append');
  assert.equal((await apply('witness-init', settings, firstWitnessPlan, 422)).code, 'STALE_PREVIEW');
  const witnesses = await apply('witness-init', settings, await preview('witness-init', settings));
  assert.equal(witnesses.receipt.witness.agreeingAtHead, 3);
  const localConfig = JSON.parse(await fs.readFile(path.join(agent.root, 'chain', 'consensus', 'config.json'), 'utf8'));
  for (const {key} of localConfig.witnesses) assert.equal(JSON.stringify(witnesses).includes(key), false);
  assert.equal((await command('witness-init', {...settings, phase: 'preview'}, 422)).code, 'MAINTENANCE_HELD');

  await native('seed');
  assert.equal((await command('witness-verify')).witness.headAttested, true);
  const objective = {reason: 'Review each sealed corpus block against the local implementation'};
  await apply('corpus-open', objective, await preview('corpus-open', objective));
  assert.equal((await command('corpus-report')).report.final, false);
  const { block } = await command('corpus-next');
  assert.ok(block.text.startsWith('quorumThreshold = 37'));
  assert.ok(block.nextOffset > 0);
  const second = (await command('corpus-next', {ring: block.index, offset: block.nextOffset})).block;
  assert.equal(second.nextOffset, null);
  assert.equal(block.text.length + second.text.length, block.characters);
  const invalid = {ring: block.index, finding: 'Everything looked good and this unsupported generic statement has no exact identifier for a source observation.'};
  assert.equal((await command('corpus-record', {...invalid, phase: 'preview'}, 422)).code, 'MAINTENANCE_HELD');
  const finding = {ring: block.index, finding: 'The assignment quorumThreshold = 37 sets an explicit calibration baseline. The repeated arithmetic examples after it provide independent context, while no alternate threshold appears in this source block.'};
  await apply('corpus-record', finding, await preview('corpus-record', finding));
  const newSession = (await post('/api/pair', { code: 'OWNER-MAINTENANCE' })).token;
  const final = await post(endpoint, {action: 'corpus-report', agentId: agent.id}, newSession);
  assert.equal(final.report.final, true);
  assert.equal(final.corpus.deep, final.corpus.total);
  assert.equal((await command('witness-verify')).witness.headAttested, true);

  await native('lock');
  const recovery = {ring: (await command('status')).status.head.index, reason: 'Owner reviewed the affected tail ring and confirmed recovery'};
  const head = await fs.readFile(path.join(agent.root, 'chain', 'rings.jsonl'));
  const recovered = await apply('immune-recover', recovery, await preview('immune-recover', recovery));
  assert.equal(recovered.receipt.recoveryRing, recovery.ring + 1);
  assert.deepEqual((await fs.readFile(path.join(agent.root, 'chain', 'rings.jsonl'))).subarray(0, head.length), head);
  assert.equal((await command('status')).status.locked, false);
  const afterQuarantine = await command('corpus-report');
  assert.equal(afterQuarantine.report.final, false);
  assert.equal(afterQuarantine.corpus.deep, 0);
  assert.equal((await command('corpus-next')).block.index, block.index);
});
