import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { engine } from '../lib/engine.mjs';
import { createCanonicalSkillManager, captureCanonicalSkillRunner } from '../lib/canonical-skill.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';

test('native preparation facts bind the current canonical invocation across callbacks and reject another lease', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-preparation-receipt-')), root = path.join(directory, 'agent');
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const manager = createCanonicalSkillManager({ dataDir: directory, fetchImpl: async () => assert.fail('No update network in this fixture') });
  const first = await manager.acquire({ refresh: false });
  let prepared, runner;
  await first.run(async () => {
    const created = await engine({ op: 'init', root, registryRoot: root, name: 'Receipt fixture' });
    await engine({ op: 'dormancy', root, action: 'pause', confirmed: true, expectedHead: created.head.hash });
    prepared = await engine({ op: 'chat_prepare', root, input: 'Please introduce yourself.', loadout: [] });
    runner = await captureCanonicalSkillRunner();
  });
  const exchange = { op: 'chat_evaluate', root, input: 'Please introduce yourself.', loadout: [], expectedHead: prepared.head.hash,
    output: 'My host independently reviews my answers before release. Memory is paused, so I will not claim to have stored this exchange.',
    preparationReceipt: prepared.preparationReceipt, usedRings: [], scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
    assessment: { approved: true, fruitages: Object.fromEntries(FRUITS.map(key => [key, 240])), rationale: 'These are factual current host policies, without outside actions or memories.' } };
  const accepted = await runner(() => engine(exchange));
  assert.equal(accepted.accepted, true); assert.equal(accepted.sealed, false);
  first.release();
  await manager.run(async () => {
    await assert.rejects(engine(exchange), { code: 'PREPARATION_INVALID' });
    const latest = await engine({ op: 'chat_prepare', root, input: exchange.input, loadout: [] });
    assert.equal((await engine({ ...exchange, preparationReceipt: latest.preparationReceipt })).accepted, true);
    assert.equal((await engine({ op: 'verify', root })).head.hash, prepared.head.hash);
  }, { refresh: false });
});
