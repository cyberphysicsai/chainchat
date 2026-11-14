/** Read-only presentation of integrations declared by the pinned OpenClaw SDK.
 * Metadata is not installation, enablement, a schema, or a native-code trust grant.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const fail = () => Object.assign(new Error('The pinned SDK channel catalogue could not be read safely.'), {code: 'OPENCLAW_CHANNEL_CATALOGUE_INVALID', status: 503});
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value) && !forbidden.has(value);
const packageName = value => typeof value === 'string' && value.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value);
const version = value => typeof value === 'string' && value.length <= 80 && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.test(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
const within = (root, file) => {const relative = path.relative(root, file); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);};
const integrity = value => typeof value === 'string' && value.length <= 256 && /^(?:sha256:[a-f0-9]{64}|sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$/u.test(value);
function registrySpec(value, expected, prefix = '') {
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw fail();
  const spec = value.slice(prefix.length), suffix = spec.slice(expected.length);
  if (!spec.startsWith(expected) || suffix && (!suffix.startsWith('@') || !version(suffix.slice(1)))) throw fail();
  return {packageName: expected, ...(suffix ? {version: suffix.slice(1)} : {})};
}
function entry(row) {
  if (!plain(row) || row.kind !== 'channel' || !['official', 'external'].includes(row.source) || !packageName(row.name)) throw fail();
  const channel = row.openclaw?.channel, declared = row.openclaw?.install, plugin = row.openclaw?.plugin;
  if (!plain(channel) || !identifier(channel.id) || !text(channel.label, 256) || !plain(declared)) throw fail();
  const pluginId = plugin?.id ?? channel.id;
  if (!identifier(pluginId) || row.version !== undefined && !version(row.version) || row.description !== undefined && !text(row.description, 4000)) throw fail();
  if (declared.expectedIntegrity !== undefined && !integrity(declared.expectedIntegrity)) throw fail();
  const npm = declared.npmSpec !== undefined ? registrySpec(declared.npmSpec, row.name) : null;
  const clawhub = declared.clawhubSpec !== undefined ? registrySpec(declared.clawhubSpec, row.name, 'clawhub:') : null;
  if (!npm && !clawhub) throw fail();
  if (declared.defaultChoice !== undefined && !['npm', 'clawhub'].includes(declared.defaultChoice)) throw fail();
  const chosen = declared.defaultChoice === 'clawhub' && clawhub || !npm && clawhub;
  const selected = chosen || npm;
  const selectedVersion = selected.version || row.version;
  const installSource = chosen ? {source: 'clawhub', packageName: row.name, ...(selectedVersion ? {version: selectedVersion} : {}), expectedPluginId: pluginId} :
    {source: 'npm', spec: row.name + (selectedVersion ? '@' + selectedVersion : ''), pin: true, expectedPluginId: pluginId};
  if (declared.expectedIntegrity) installSource.expectedIntegrity = declared.expectedIntegrity;
  const install = row.source === 'official' ? {source: 'official', pluginId} : chosen ? {source: 'clawhub', packageName: row.name} : undefined;
  return {channelId: channel.id, pluginId, packageName: row.name, label: channel.label,
    description: row.description || (text(channel.blurb, 4000) ? channel.blurb : ''), sourceType: row.source,
    ...(row.version ? {version: row.version} : {}), ...(install ? {install} : {}), installSource,
    ...(text(declared.minHostVersion, 128) ? {minimumHostVersion: declared.minHostVersion} : {}),
    ...(typeof channel.docsPath === 'string' && channel.docsPath.length <= 256 && /^\/[a-zA-Z0-9/_-]+$/u.test(channel.docsPath) ? {docsPath: channel.docsPath} : {}),
    requiresExplicitTrust: true};
}

/** Only the fixed JSON path is read; no SDK module/package scripts are imported. */
export async function loadOfficialChannelCatalogue(packageRoot) {
  try {
    if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot)) throw fail();
    const root = await fs.realpath(packageRoot), file = path.join(root, 'scripts', 'lib', 'official-external-channel-catalog.json');
    const info = await fs.lstat(file), actual = await fs.realpath(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 2 || info.size > 1024 * 1024 || !within(root, actual)) throw fail();
    const handle = await fs.open(file, 'r');
    let bytes;
    try {const opened = await handle.stat(); if (!opened.isFile() || opened.size > 1024 * 1024 || opened.dev !== info.dev || opened.ino !== info.ino) throw fail(); bytes = await handle.readFile();}
    finally {await handle.close();}
    if (bytes.length > 1024 * 1024) throw fail();
    const body = JSON.parse(bytes.toString('utf8'));
    if (!plain(body) || Object.keys(body).some(key => key !== 'entries') || !Array.isArray(body.entries) || body.entries.length > 256) throw fail();
    const channels = body.entries.map(entry), ids = new Set(), plugins = new Set();
    for (const row of channels) {if (ids.has(row.channelId) || plugins.has(row.pluginId)) throw fail(); ids.add(row.channelId); plugins.add(row.pluginId);}
    return {channels, source: 'pinned-sdk-channel-catalogue'};
  } catch {throw fail();}
}

/** Native records own runtime facts. Fallback adds presentation and install
 * guidance only, and never converts an uninstalled integration into a usable one.
 */
export function mergeNativeChannelCatalogue(nativeEnvelope, fallback) {
  if (!plain(nativeEnvelope) || !Array.isArray(nativeEnvelope.plugins) || nativeEnvelope.plugins.length > 4096 ||
    !plain(fallback) || !Array.isArray(fallback.channels) || fallback.channels.length > 256) throw fail();
  const output = structuredClone(nativeEnvelope), native = output.plugins;
  for (const row of fallback.channels) {
    if (!identifier(row.pluginId) || !identifier(row.channelId) || !packageName(row.packageName) || !['official', 'external'].includes(row.sourceType) || !text(row.label, 256) || typeof row.description !== 'string' || row.description.length > 4000 || !plain(row.installSource)) throw fail();
    const source = row.installSource;
    if (source.expectedPluginId !== row.pluginId || source.expectedIntegrity !== undefined && !integrity(source.expectedIntegrity)) throw fail();
    if (source.source === 'npm') {
      if (Object.keys(source).some(key => !['source', 'spec', 'pin', 'expectedPluginId', 'expectedIntegrity'].includes(key)) || source.pin !== true) throw fail();
      registrySpec(source.spec, row.packageName);
    } else if (source.source === 'clawhub') {
      if (Object.keys(source).some(key => !['source', 'packageName', 'version', 'expectedPluginId', 'expectedIntegrity'].includes(key)) || source.packageName !== row.packageName || source.version !== undefined && !version(source.version)) throw fail();
    } else throw fail();
    if (row.install) {
      if (!plain(row.install)) throw fail();
      if (row.install.source === 'official') {
        if (Object.keys(row.install).some(key => !['source', 'pluginId'].includes(key)) || row.install.pluginId !== row.pluginId || row.sourceType !== 'official') throw fail();
      } else if (row.install.source !== 'clawhub' || Object.keys(row.install).some(key => !['source', 'packageName'].includes(key)) || row.install.packageName !== row.packageName) throw fail();
    }
    // Do not attach official install provenance to a different installed package
    // that deliberately uses the same plugin ID.
    const matches = native.filter(plugin => plugin?.id === row.pluginId || plugin?.packageName === row.packageName);
    const existing = matches.find(plugin => plugin.installed === true) || matches[0];
    if (existing) {
      if (existing.packageName && existing.packageName !== row.packageName) continue;
      const verifiedOfficial = row.sourceType === 'official' && existing.install?.source === 'official' && existing.install.pluginId === row.pluginId;
      if (existing.installed === true && existing.packageName !== row.packageName && !verifiedOfficial) continue;
      if (existing.installed !== true && (!Array.isArray(existing.channelIds) || !existing.channelIds.length)) existing.channelIds = [row.channelId];
      if (!existing.install && row.install) existing.install = structuredClone(row.install);
      if (!existing.installSource) existing.installSource = structuredClone(row.installSource);
      if (!existing.sourceType) existing.sourceType = row.sourceType;
      if (existing.installed !== true || existing.requiresExplicitTrust === undefined) existing.requiresExplicitTrust = true;
      if (!existing.catalogueSource) existing.catalogueSource = 'pinned-sdk-channel-catalogue';
      continue;
    }
    native.push({id: row.pluginId, name: row.label, packageName: row.packageName, description: row.description,
      ...(row.version ? {version: row.version} : {}), origin: row.sourceType, sourceType: row.sourceType,
      installed: false, enabled: false, state: 'not-installed', channelIds: [row.channelId], kind: ['channel'],
      category: 'channels', categories: ['channels'], ...(row.install ? {install: structuredClone(row.install)} : {}),
      installSource: structuredClone(row.installSource), requiresExplicitTrust: true, catalogueSource: 'pinned-sdk-channel-catalogue',
      ...(row.docsPath ? {docsPath: row.docsPath} : {}), ...(row.minimumHostVersion ? {minimumHostVersion: row.minimumHostVersion} : {})});
  }
  return output;
}
