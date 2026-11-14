import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadOfficialChannelCatalogue, mergeNativeChannelCatalogue} from '../lib/native-channel-catalogue.mjs';
import {normalizePluginSource} from '../lib/trusted-plugin-manager.mjs';
import {createNativeChannels} from '../lib/native-channels.mjs';

const catalogue = () => ({entries: [
  {name: '@openclaw/discord', version: '2026.11.3', description: 'Discord chats.', source: 'official', kind: 'channel', openclaw: {
    channel: {id: 'discord', label: 'Discord', docsPath: '/channels/discord', setup: {fields: [{key: 'token', sensitive: true, default: 'must-not-copy'}]}},
    install: {npmSpec: '@openclaw/discord', clawhubSpec: 'clawhub:@openclaw/discord', defaultChoice: 'npm', minHostVersion: '>=2026.5.26'}}},
  {name: '@vendor/future', description: 'Future vendor chat.', source: 'external', kind: 'channel', openclaw: {
    plugin: {id: 'future-plugin'}, channel: {id: 'future-chat', label: 'Future chat'}, install: {npmSpec: '@vendor/future@1.2.3', defaultChoice: 'npm', expectedIntegrity: 'sha512-' + 'A'.repeat(86) + '=='}}},
  {name: '@vendor/mail', source: 'external', kind: 'channel', openclaw: {channel: {id: 'mail', label: 'Vendor mail'},
    install: {clawhubSpec: 'clawhub:@vendor/mail@0.2.1', defaultChoice: 'clawhub', expectedIntegrity: 'sha256:' + 'a'.repeat(64)}}},
]});
async function fixture(t, body = catalogue()) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-channel-catalogue-'))), root = path.join(directory, 'sdk');
  const folder = path.join(root, 'scripts', 'lib'); await fs.mkdir(folder, {recursive: true});
  const file = path.join(folder, 'official-external-channel-catalog.json'); await fs.writeFile(file, JSON.stringify(body));
  t.after(async () => {
    const temporary = await fs.realpath(os.tmpdir()); assert.ok(directory.startsWith(temporary + path.sep) && path.basename(directory).startsWith('ct-channel-catalogue-'));
    await fs.rm(directory, {recursive: true, force: true, maxRetries: 8, retryDelay: 100});
  });
  return {root, file, directory};
}
const invalid = error => error.code === 'OPENCLAW_CHANNEL_CATALOGUE_INVALID' && !error.message.includes('must-not-copy');

test('read-only SDK catalogue extracts declared channel identities and safe reviewed install sources', async t => {
  const f = await fixture(t), result = await loadOfficialChannelCatalogue(f.root);
  assert.deepEqual(result.channels.map(row => row.channelId), ['discord', 'future-chat', 'mail']);
  assert.equal(result.source, 'pinned-sdk-channel-catalogue');
  assert.deepEqual(result.channels[0].install, {source: 'official', pluginId: 'discord'});
  assert.deepEqual(result.channels[0].installSource, {source: 'npm', spec: '@openclaw/discord@2026.11.3', pin: true, expectedPluginId: 'discord'});
  assert.deepEqual(result.channels[2].installSource, {source: 'clawhub', packageName: '@vendor/mail', version: '0.2.1', expectedPluginId: 'mail', expectedIntegrity: 'sha256:' + 'a'.repeat(64)});
  for (const row of result.channels) assert.deepEqual(normalizePluginSource(row.installSource), row.installSource);
  assert.equal(JSON.stringify(result).includes('must-not-copy'), false); assert.equal(JSON.stringify(result).includes('setup'), false);
  assert.equal(result.channels[1].sourceType, 'external'); assert.equal(result.channels[1].requiresExplicitTrust, true);
});

test('native installed runtime facts and native install source shapes win over catalogue presentation', async t => {
  const f = await fixture(t), fallback = await loadOfficialChannelCatalogue(f.root);
  const native = {generation: 8, mutationAllowed: false, diagnostics: ['native-diagnostic'], plugins: [
    {id: 'discord', name: 'Native Discord name', packageName: '@openclaw/discord', installed: true, enabled: true, state: 'enabled',
      runtime: {state: 'active'}, schema: {native: true}, channelIds: ['discord', 'native-extra'], install: {source: 'clawhub', packageName: '@openclaw/discord'}},
    {id: 'other-native', name: 'Other', installed: true, enabled: false, state: 'disabled'},
  ]};
  const before = structuredClone(native), result = mergeNativeChannelCatalogue(native, fallback), discord = result.plugins.find(row => row.id === 'discord');
  assert.deepEqual(native, before); assert.equal(result.generation, 8); assert.equal(result.mutationAllowed, false); assert.deepEqual(result.diagnostics, native.diagnostics);
  for (const key of ['name', 'installed', 'enabled', 'state', 'runtime', 'schema', 'channelIds', 'install']) assert.deepEqual(discord[key], native.plugins[0][key]);
  const available = result.plugins.find(row => row.id === 'future-plugin'); assert.equal(available.installed, false); assert.equal(available.enabled, false); assert.equal(available.state, 'not-installed');
  assert.equal(available.sourceType, 'external'); assert.equal(available.requiresExplicitTrust, true); assert.equal(available.runtime, undefined); assert.equal(available.schema, undefined);
  assert.deepEqual(available.channelIds, ['future-chat']); assert.deepEqual(available.installSource, fallback.channels[1].installSource);
});

test('uninstalled native rows receive declared channelIds while installed channel identities remain authoritative', async t => {
  const f = await fixture(t), fallback = await loadOfficialChannelCatalogue(f.root);
  const result = mergeNativeChannelCatalogue({plugins: [{id: 'native-alias', packageName: '@openclaw/discord', installed: false, enabled: false}]}, fallback);
  assert.deepEqual(result.plugins[0].channelIds, ['discord']); assert.equal(result.plugins.filter(row => row.packageName === '@openclaw/discord').length, 1);
  const collision = mergeNativeChannelCatalogue({plugins: [{id: 'discord', packageName: '@another/discord', installed: true, enabled: true}]}, fallback);
  assert.equal(collision.plugins[0].installSource, undefined); assert.equal(collision.plugins[0].channelIds, undefined);
});

test('uninstalled fallback channels reach the picker with install guidance and no executable capabilities or fabricated schema', async t => {
  const f = await fixture(t), fallback = await loadOfficialChannelCatalogue(f.root), plugins = mergeNativeChannelCatalogue({plugins: [], generation: 1}, fallback);
  const controls = createNativeChannels({rpc: async () => ({channelAccounts: {}, channelMeta: []}), schema: async () => ({schema: {properties: {channels: {properties: {}}}}}),
    config: async () => ({config: {}, hash: 'fixture'}), plugins: async () => plugins, authorize: async () => {throw new Error('Metadata must not authorize native operations.');}, applyConfig: async () => {throw new Error('Metadata must not install or write settings.');}});
  const snapshot = await controls.snapshot(), discord = snapshot.items.find(row => row.id === 'discord');
  assert.equal(snapshot.items.length, 3); assert.equal(discord.installed, false); assert.equal(discord.enabled, false);
  assert.deepEqual(discord.installSource, fallback.channels[0].installSource); assert.equal(discord.sourceType, 'official'); assert.equal(discord.requiresExplicitTrust, true);
  assert.deepEqual(discord.schema, {}); assert.ok(Object.values(discord.capabilities).every(value => value === false));
  await assert.rejects(controls.action({action: 'start', channelId: 'discord', accountId: 'default'}), error => error.code === 'OPENCLAW_CHANNEL_UNAVAILABLE');
});

test('catalogue rejects unsafe registry locations, expanded fields, ambiguous identities and unbounded input', async t => {
  const f = await fixture(t);
  for (const change of [
    row => {row.openclaw.install.npmSpec = 'file:C:/private/plugin';}, row => {row.openclaw.install.npmSpec = 'https://user:secret@example/plugin.tgz';},
    row => {row.openclaw.install.npmSpec = '@another/package@1.0.0';}, row => {row.openclaw.install.npmSpec = '@openclaw/discord@latest';},
    row => {row.openclaw.install.clawhubSpec = 'clawhub:../private';}, row => {row.openclaw.channel.id = '__proto__';},
    row => {row.openclaw.channel.id = 'discord\nmalicious';}, row => {row.source = 'workspace';}, row => {row.version = '${SECRET}';},
    row => {row.description = 'x'.repeat(4001);}, row => {row.openclaw.install.expectedIntegrity = 'anything';},
  ]) {const body = catalogue(); change(body.entries[0]); await fs.writeFile(f.file, JSON.stringify(body)); await assert.rejects(loadOfficialChannelCatalogue(f.root), invalid);}
  const duplicate = catalogue(); duplicate.entries.push(structuredClone(duplicate.entries[0])); await fs.writeFile(f.file, JSON.stringify(duplicate)); await assert.rejects(loadOfficialChannelCatalogue(f.root), invalid);
  await fs.writeFile(f.file, ' '.repeat(1024 * 1024 + 1)); await assert.rejects(loadOfficialChannelCatalogue(f.root), invalid);
  await fs.writeFile(f.file, '{"entries":[],"extra":"not-native"}'); await assert.rejects(loadOfficialChannelCatalogue(f.root), invalid);
  await fs.writeFile(f.file, 'invalid JSON must-not-copy'); await assert.rejects(loadOfficialChannelCatalogue(f.root), invalid);
});

test('catalogue merge refuses source injection even when supplied a forged fallback object', async t => {
  const f = await fixture(t), fallback = await loadOfficialChannelCatalogue(f.root);
  for (const patch of [{source: 'local', path: 'C:/private'}, {source: 'npm', spec: 'file:private', pin: true, expectedPluginId: 'discord'},
    {source: 'npm', spec: '@openclaw/discord@2026.11.3', pin: false, expectedPluginId: 'discord'},
    {source: 'clawhub', packageName: '@another/package', expectedPluginId: 'discord'}]) {
    const forged = structuredClone(fallback); forged.channels[0].installSource = patch; assert.throws(() => mergeNativeChannelCatalogue({plugins: []}, forged), invalid);
  }
});

test('fixed catalogue read refuses file links or an escaping parent junction without following plugin code', async t => {
  const f = await fixture(t), outside = path.join(f.directory, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'official-external-channel-catalog.json'), JSON.stringify(catalogue()));
  await fs.rm(path.join(f.root, 'scripts', 'lib'), {recursive: true});
  try {await fs.symlink(outside, path.join(f.root, 'scripts', 'lib'), process.platform === 'win32' ? 'junction' : 'dir');}
  catch (error) {if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('This account cannot create a test directory link.'); throw error;}
  await assert.rejects(loadOfficialChannelCatalogue(f.root), invalid);
});


test('ambiguous installed IDs never inherit official installation provenance or manufactured channel identities', async t => {
  const f = await fixture(t), fallback = await loadOfficialChannelCatalogue(f.root);
  const native = {plugins: [{id: 'discord', name: 'Locally installed Discord', installed: true, enabled: true, state: 'enabled', runtime: {state: 'active'}}]};
  const result = mergeNativeChannelCatalogue(native, fallback);
  assert.deepEqual(result.plugins[0], native.plugins[0]); assert.equal(result.plugins[0].channelIds, undefined); assert.equal(result.plugins[0].installSource, undefined);
  const exactPackage = mergeNativeChannelCatalogue({plugins: [{...native.plugins[0], packageName: '@openclaw/discord'}]}, fallback);
  assert.equal(exactPackage.plugins[0].channelIds, undefined); assert.deepEqual(exactPackage.plugins[0].installSource, fallback.channels[0].installSource);
  const nativeOfficial = {plugins: [{...native.plugins[0], install: {source: 'official', pluginId: 'discord'}}]};
  const verified = mergeNativeChannelCatalogue(nativeOfficial, fallback);
  assert.deepEqual(verified.plugins[0].install, nativeOfficial.plugins[0].install); assert.equal(verified.plugins[0].channelIds, undefined);
  assert.deepEqual(verified.plugins[0].installSource, fallback.channels[0].installSource);
  const externalAmbiguous = mergeNativeChannelCatalogue({plugins: [{id: 'future-plugin', installed: true, enabled: true, install: {source: 'official', pluginId: 'future-plugin'}}]}, fallback);
  assert.equal(externalAmbiguous.plugins[0].installSource, undefined); assert.equal(externalAmbiguous.plugins[0].sourceType, undefined);
});
