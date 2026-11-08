import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { schemaFields, schemaFamilies, contextPolicyText, buildAutomationSchedule, nativeCommandDescription } from '../public/openclaw-settings.js';

test('memory-policy copy follows the reported native policy without inventing unlimited context or disabling required compaction', () => {
  const native = contextPolicyText({ mode: 'reviewed-native-compaction', automaticSummary: true, storedHistory: 'preserved', retainedRecentTurns: 2 });
  assert.match(native, /context pressure/); assert.match(native, /exact source/); assert.match(native, /through PoI/);
  assert.doesNotMatch(native, /compaction is off|unlimited/i);
  assert.match(contextPolicyText({ mode: 'timechain-retrieval', automaticSummary: false, storedHistory: 'preserved' }), /compaction is off/);
  for (const policy of [null, { mode: 'unknown' }, { mode: 'timechain-retrieval', automaticSummary: true, storedHistory: 'preserved' }]) {
    const message = contextPolicyText(policy); assert.match(message, /not reported a recognized/); assert.doesNotMatch(message, /compaction is off/);
  }
});

test('native schema search preserves exact editable field paths and bounds recursive schemas', () => {
  const schema = { schema: { properties: { agents: { type: 'object', properties: { defaults: { properties: {
    contextTokens: { type: 'integer', description: 'Safe context token budget' }, model: { type: 'string' },
  } } } }, gateway: { description: 'Managed authenticated transport', type: 'object' } } } };
  assert.deepEqual(schemaFields(schema, 'budget').map(x => x.name), ['agents.defaults.contextTokens']);
  assert.equal(schemaFields(schema, 'transport')[0].name, 'gateway');
  assert.equal(schemaFields(schema).some(x => x.name === 'agents.defaults.model'), true);
  const cyclic = { properties: {} }; cyclic.properties.again = cyclic;
  assert.ok(schemaFields(cyclic).length <= 16);
  assert.equal(schemaFields({ properties: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i), { type: 'boolean' }])) }).length, 500);
});

test('native utility settings disclose separate native credentials, billing and privacy', async () => {
  const schema = {properties:{agents:{properties:{defaults:{properties:{utilityModel:{type:'string',description:'Optional native utility model.'},model:{type:'string',description:'Primary model.'}}}}}}};
  const results = schemaFields(schema, 'billing');
  assert.deepEqual(results.map(row=>row.name), ['agents.defaults.utilityModel']);
  const description = results[0].description;
  for (const meaning of [/off by default/, /owner grant/, /native provider credentials/, /billing and privacy/, /no action tools/, /canonical PoI/]) assert.match(description, meaning);
  assert.equal(schemaFields(schema).find(row=>row.name==='agents.defaults.model').description,'Primary model.');
  assert.equal(schemaFields({properties:{agents:{type:'object'}}},'utilityModel').length,0,'An absent native schema setting must not become an invented editable field.');
  const html = await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const notice = html.match(/<p id="nativeUtilityModelNotice"[^>]*>([\s\S]*?)<\/p>/)?.[1];assert.ok(notice);
  for (const meaning of [/off by default/, /agents.defaults.utilityModel/, /owner grant/, /native provider credentials/, /billing and privacy/, /no action tools/, /canonical PoI/]) assert.match(notice,meaning);
});

test('every native schema family remains discoverable with authoritative management reasons and scoped field search', () => {
  const schema = { properties: { agents: { properties: { defaults: { properties: { model: { type: 'string' }, contextTokens: { type: 'integer' } } } } },
    gateway: { title: 'Private transport', type: 'object' }, futureNativeFamily: { type: 'object' } } };
  const guards = { gateway: 'Private local operator transport.', 'agents.defaults.model': 'Choose models through the connection selector.' };
  const families = schemaFamilies(schema, guards, [{ key: 'agents', classification: 'editable', reason: 'Schema-validated defaults; managed children remain protected.' },
    { key: 'gateway', classification: 'supervisor-owned', reason: 'Cannot change private binding or authentication.' }]);
  assert.deepEqual(families.map(item => item.name), ['agents', 'futureNativeFamily', 'gateway']);
  assert.equal(families.find(item => item.name === 'futureNativeFamily').classification, 'reference');
  assert.equal(families.find(item => item.name === 'gateway').protected, true);
  assert.match(families.find(item => item.name === 'gateway').reason, /private binding/);
  assert.deepEqual(families.find(item => item.name === 'agents').guards.map(item => item.path), ['agents.defaults.model']);
  assert.deepEqual(schemaFields(schema, '', 'agents').map(item => item.name), ['agents', 'agents.defaults', 'agents.defaults.model', 'agents.defaults.contextTokens']);
  const large = { properties: { bulk: { properties: Object.fromEntries(Array.from({ length: 700 }, (_, i) => ['field' + i, { type: 'string' }])) }, lastFamily: { properties: { visible: { type: 'boolean' } } } } };
  assert.equal(schemaFields(large).length, 500);
  assert.deepEqual(schemaFields(large, '', 'lastFamily').map(item => item.name), ['lastFamily', 'lastFamily.visible']);
});

test('queue controls explain separate frontend reviews without promising a separate block or inventing schema settings', async () => {
  const schema = { properties: { messages: { properties: { queue: { properties: {
    mode: { type: 'string', description: 'Native queue mode.' },
  } } } }, session: { type: 'object', description: 'Session settings.' } } };
  const queue = schemaFields(schema).find(row => row.name === 'messages.queue.mode');
  for (const meaning of [/followup/, /own identity and PoI review/, /selected Timechain block policy/, /other native events and channel inputs/, /frontend requests stay separate/])
    assert.match(queue.description, meaning);
  assert.match(nativeCommandDescription({ name: '/queue', description: 'Choose a queue mode.' }), /followup/);
  assert.match(nativeCommandDescription({ name: '/queue collect' }), /other native events and channel inputs/);
  assert.equal(nativeCommandDescription({ name: '/think', description: 'Choose reasoning.', mode: 'native' }), 'Choose reasoning. · native');
  assert.equal(schemaFields({ properties: { session: { type: 'object' } } }, 'followup').length, 0);
  assert.doesNotMatch(queue.description, /each.*(?:own|separate) (?:ring|block)/i);
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const notice = html.match(/<p id="nativeQueuePolicyNotice"[^>]*>([\s\S]*?)<\/p>/)?.[1];
  assert.ok(notice); assert.match(notice, /selected Timechain block policy/);
});

test('service forms create bounded native schedules without client-supplied execution fields', () => {
  assert.deepEqual(buildAutomationSchedule({ kind: 'every', minutes: '30' }), { kind: 'every', everyMs: 1800000 });
  assert.deepEqual(buildAutomationSchedule({ kind: 'at', at: '2026-11-02T09:00:00Z' }, Date.parse('2026-11-01T09:00:00Z')),
    { kind: 'at', at: '2026-11-02T09:00:00.000Z' });
  assert.deepEqual(buildAutomationSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }), { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' });
  for (const minutes of ['', '0', '0.5', '525601']) assert.throws(() => buildAutomationSchedule({ kind: 'every', minutes }));
  assert.throws(() => buildAutomationSchedule({ kind: 'cron', expr: '* * * * * *', tz: 'UTC' }));
  assert.throws(() => buildAutomationSchedule({ kind: 'at', at: 'not-a-date' }));
});
