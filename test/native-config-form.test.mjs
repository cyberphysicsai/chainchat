import test from 'node:test';
import assert from 'node:assert/strict';
import { mountNativeConfigForm, nativeConfigFields, nativeConfigValue, parseNativeConfigField, resolveNativeConfigSchema } from '../public/native-config-form.js';

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.value = ''; this.checked = false; this.disabled = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  async fire(name) { await this.handlers[name]?.({ preventDefault() {} }); }
  set innerHTML(_value) { throw new Error('Markup must never be interpreted'); }
}
export const descendants = node => [node, ...node.children.flatMap(descendants)];
function fixture(initial = {}) {
  const document = { createElement: tag => new Node(tag) }, mount = new Node('section'), changes = [], errors = [], navigation = [];
  const controller = mountNativeConfigForm({ document, mount, onChange: value => changes.push(value), onError: value => errors.push(value), onNavigate: value => navigation.push(value), ...initial });
  return { mount, changes, errors, navigation, controller, nodes: () => descendants(mount), field: path => descendants(mount).find(node => node.dataset.nativeConfigPath === path), input: label => descendants(mount).find(node => node.attributes['aria-label'] === label) };
}
const envelope = { schema: { type: 'object', $defs: { limits: { allOf: [ { type: 'object', properties: { retries: { type: 'integer', minimum: 0, maximum: 8 } } }, { type: 'object', properties: { timeout: { type: ['number', 'null'] } }, required: ['timeout'] } ] } }, properties: {
  agents: { $ref: '#/$defs/limits' }, models: { type: 'object', additionalProperties: { type: 'string' } },
  names: { type: 'array', items: { type: 'string' } }, mode: { anyOf: [{ type: 'string', enum: ['one', 'two'] }, { type: 'null' }] },
  enabled: { type: 'boolean', default: true }, endpoint: { type: 'string', description: '<img src=x onerror=1>' },
  channels: { type: 'object', properties: { telegram: { type: 'object', properties: { botToken: { type: 'string' }, enabled: { type: 'boolean' } } } } },
  custom: { type: 'string' }, future: { type: 'object', properties: { complete: { type: 'boolean' } } },
} }, uiHints: { custom: { sensitive: true }, 'agents.retries': { label: 'Retry count', advanced: true } } };

test('native fields retain refs, allOf, maps, arrays, nullable and alternatives without a 500-field cap', () => {
  const fields = nativeConfigFields(envelope, { effective: { mode: null } });
  assert.equal(fields.find(row => row.name === 'agents.retries').kind, 'integer');
  assert.equal(fields.find(row => row.name === 'agents.retries').title, 'Retry count');
  assert.equal(fields.find(row => row.name === 'agents.timeout').nullable, true);
  assert.equal(fields.find(row => row.name === 'models').kind, 'map');
  assert.equal(fields.find(row => row.name === 'names').kind, 'array');
  assert.equal(fields.find(row => row.name === 'mode').branch, 1);
  assert.equal(fields.find(row => row.name === 'custom').sensitive, true);
  const discriminator = { properties: { transport: { oneOf: [{ type: 'object', properties: { kind: { const: 'first' }, one: { type: 'boolean' } } }, { type: 'object', properties: { kind: { const: 'second' }, two: { type: 'boolean' } } }] } } };
  assert.equal(nativeConfigFields(discriminator, { effective: { transport: { kind: 'second', two: true } } }).find(row => row.name === 'transport').branch, 1);
  const large = { type: 'object', properties: Object.fromEntries(Array.from({ length: 801 }, (_, i) => [`future${i}`, { type: 'string' }])) };
  assert.equal(nativeConfigFields(large).length, 801);
  const recursive = { type: 'object', $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } }, properties: { list: { $ref: '#/$defs/node' } } };
  const recursiveFields = nativeConfigFields(recursive); assert.ok(recursiveFields.length > 1 && recursiveFields.length < 30);
  assert.equal(recursiveFields.at(-1).kind, 'json');
  assert.equal(resolveNativeConfigSchema({ $ref: '#/$defs/missing' }, recursive).__complex, true);
});

test('typed values preserve booleans, enum values, native null and bounded numbers', () => {
  assert.equal(parseNativeConfigField({ kind: 'integer', schema: { minimum: 0, maximum: 9 } }, '3'), 3);
  assert.throws(() => parseNativeConfigField({ kind: 'integer', schema: {} }, '1.5'));
  assert.throws(() => parseNativeConfigField({ kind: 'number', schema: { minimum: 2 } }, '1'));
  assert.equal(parseNativeConfigField({ kind: 'boolean', schema: {} }, false), false);
  assert.equal(parseNativeConfigField({ kind: 'null', schema: {} }, ''), null);
  assert.equal(parseNativeConfigField({ kind: 'enum', schema: { enum: [false, 0, 'zero'] } }, '0'), false);
  assert.equal(parseNativeConfigField({ kind: 'union', schema: { enum: ['one', 'two'], type: 'string' } }, '1'), 'two');
  assert.deepEqual(parseNativeConfigField({ kind: 'array', schema: { type: 'array' } }, '[1,null]'), [1, null]);
  assert.throws(() => parseNativeConfigField({ kind: 'array', schema: { type: 'array' } }, '{}'));
  assert.throws(() => nativeConfigValue(JSON.parse('{"__proto__":{"polluted":true}}')));
  assert.throws(() => nativeConfigValue({ number: Infinity }));
});

test('changes are exact typed deltas, reset is explicit, and native null is not deletion', () => {
  const f = fixture({ schema: envelope, effective: { agents: { retries: 2, timeout: 90 }, enabled: true }, editable: { agents: { retries: 2 } }, revision: 4, baseHash: 'safe-hash' });
  f.controller.setValue(['agents', 'retries'], 3);
  f.controller.setValue(['agents', 'timeout'], null);
  assert.deepEqual(f.controller.getPayload(), { patch: { agents: { retries: 3, timeout: null } }, removePaths: [], revision: 4, baseHash: 'safe-hash' });
  f.controller.removeOverride(['agents', 'retries']);
  assert.deepEqual(f.controller.getPayload(), { patch: { agents: { timeout: null } }, removePaths: [['agents', 'retries']], revision: 4, baseHash: 'safe-hash' });
  assert.equal(f.controller.getPatch().enabled, undefined);
  f.controller.setValue(['future'], { complete: true }); f.controller.setValue(['future', 'complete'], false);
  assert.deepEqual(f.controller.getPatch().future, { complete: false });
  f.controller.render({ revision: 5 }); assert.throws(() => f.controller.setValue(['endpoint'], 'new'), /Reload/);
  f.controller.render({ contextKey: 'another-agent', revision: 6, effective: {}, editable: {} });
  assert.deepEqual(f.controller.getPayload(), { patch: {}, removePaths: [], revision: 6, baseHash: 'safe-hash' });
  f.controller.setValue(['endpoint'], 'new'); f.controller.render({ baseHash: 'native-config-changed-externally' });
  assert.throws(() => f.controller.setValue(['endpoint'], 'overwrite'), /Reload/);
});

test('remove paths preserve literal dots in native map and account keys', () => {
  const f = fixture({ schema: { properties: { channels: { type: 'object' } } }, effective: { channels: { custom: { accounts: { 'alice.bot': { enabled: true } } } } }, editable: { channels: { custom: { accounts: { 'alice.bot': { enabled: true } } } } } });
  f.controller.removeOverride(['channels', 'custom', 'accounts', 'alice.bot', 'enabled']);
  assert.deepEqual(f.controller.getRemovedPaths(), [['channels', 'custom', 'accounts', 'alice.bot', 'enabled']]);
  assert.equal(f.controller.getPayload().removePaths[0].length, 5);
});

test('managed and sensitive paths never become ordinary config writes or rendered secrets', async () => {
  const actualSecret = 'sensitive-fixture-value-not-for-dom';
  const f = fixture({ schema: envelope, effective: { custom: actualSecret, channels: { telegram: { botToken: actualSecret, enabled: true } } }, guards: { 'agents.timeout': 'Owner policy manages timeout.' } });
  assert.equal(f.nodes().some(node => String(node.value).includes(actualSecret) || node.textContent.includes(actualSecret)), false);
  assert.throws(() => f.controller.setValue(['channels', 'telegram', 'botToken'], actualSecret), /credential/);
  assert.throws(() => f.controller.setValue(['channels'], { telegram: { botToken: actualSecret } }), /credential/);
  assert.throws(() => f.controller.setValue(['custom'], actualSecret), /credential/);
  assert.throws(() => f.controller.setValue(['endpoint'], '__OPENCLAW_REDACTED__'), /credential/);
  assert.throws(() => f.controller.setValue(['agents'], { retries: 2 }), /Owner policy/);
  f.controller.setValue(['agents', 'retries'], 4);
  assert.equal(f.controller.getPatch().channels, undefined);
  assert.ok(f.field('agents.timeout').children.some(node => node.textContent === 'Owner policy manages timeout.'));
  const button = descendants(f.field('custom')).find(node => node.textContent === 'Open dedicated control'); await button.fire('click');
  assert.deepEqual(f.navigation[0].path, ['custom']);
  assert.ok(f.nodes().some(node => node.textContent === '<img src=x onerror=1>'));
  assert.equal(f.nodes().some(node => node.tagName === 'img'), false);
});

test('array controls change real typed items, and configured secret arrays are visible but guarded', async () => {
  const f = fixture({ schema: envelope, effective: { names: ['first'], mode: 'one' } });
  const first = f.input('names item 1'); first.value = 'updated'; await first.fire('change');
  assert.deepEqual(f.controller.getPatch().names, ['updated']);
  // Redraw after the current draft so add/remove edits retain the typed draft.
  f.controller.render({});
  await descendants(f.field('names')).find(node => node.textContent === 'Add item').fire('click');
  assert.deepEqual(f.controller.getPatch().names, ['updated', '']);
  const union = f.input('mode value type'); union.value = '1'; await union.fire('change');
  assert.equal(f.controller.getPatch().mode, null);
  const nullable = f.input('agents.timeout null value'); nullable.value = 'null'; await nullable.fire('change');
  assert.equal(f.controller.getPatch().agents.timeout, null);
  const guarded = fixture({ schema: { type: 'object', properties: { credentials: { type: 'array', items: { type: 'object', properties: { token: { type: 'string' } } } } } }, effective: { credentials: [{ token: '__OPENCLAW_REDACTED__' }] } });
  assert.throws(() => guarded.controller.setValue(['credentials'], []), /dedicated/);
  assert.ok(guarded.nodes().some(node => node.textContent.includes('array contains configured credentials')));
  assert.equal(guarded.nodes().some(node => String(node.value).includes('__OPENCLAW_REDACTED__')), false);
});

test('search reveals advanced settings and progressive rendering never discards future native fields', async () => {
  const f = fixture({ schema: envelope }); assert.equal(f.field('agents.retries'), undefined);
  f.input('Search native settings').value = 'Retry count'; await f.input('Search native settings').fire('input'); assert.ok(f.field('agents.retries'));
  const large = fixture({ schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`future${i}`, { type: 'string' }])) } });
  assert.equal(large.nodes().filter(node => node.dataset.nativeConfigPath).length, 150);
  const more = large.nodes().find(node => node.textContent === 'Show more settings'); await more.fire('click'); await more.fire('click');
  assert.equal(large.nodes().filter(node => node.dataset.nativeConfigPath).length, 301);
  large.controller.destroy(); assert.equal(large.mount.children.length, 0);
});

test('exact-path owner admission overrides broad guard metadata while immutable descendants remain blocked', () => {
  const schema = { type: 'object', properties: { channels: { type: 'object', properties: { telegram: { type: 'object', properties: { enabled: { type: 'boolean' }, immutable: { type: 'string' } } }, other: { type: 'boolean' } } } } };
  const inspected = [], guardFor = (path, { includeChildren } = {}) => {
    inspected.push({ path, includeChildren }); const name = path.join('.');
    if (name === 'channels.telegram.immutable' || includeChildren && ['channels', 'channels.telegram'].includes(name)) return 'Immutable child belongs to the supervisor.';
    return name === 'channels.telegram.enabled' ? '' : 'Exact native consent is required.';
  };
  const f = fixture({ schema, guards: { channels: 'Broad legacy metadata.' }, guardFor });
  f.controller.setValue(['channels', 'telegram', 'enabled'], true);
  assert.deepEqual(f.controller.getPatch(), { channels: { telegram: { enabled: true } } });
  assert.throws(() => f.controller.setValue(['channels', 'other'], true), /consent/);
  assert.throws(() => f.controller.setValue(['channels', 'telegram', 'immutable'], 'bypass'), /Immutable child/);
  assert.throws(() => f.controller.setValue(['channels', 'telegram'], { enabled: true }), /Immutable child/);
  assert.ok(inspected.some(row => row.includeChildren));
  assert.ok(descendants(f.field('channels.telegram.enabled')).some(node => node.tagName === 'input' && node.disabled === false));
});

test('native writeOnly and sensitive schema markers are excluded even without secret-looking property names', () => {
  const schema = { type: 'object', properties: { preferences: { type: 'object', properties: { innocuousName: { type: 'string', writeOnly: true } } }, dictionary: { type: 'object', additionalProperties: { type: 'string', sensitive: true } } } };
  const f = fixture({ schema, effective: { preferences: { innocuousName: 'private-writeonly-value' }, dictionary: { ordinary: 'private-map-value' } } });
  assert.equal(f.nodes().some(node => `${node.textContent} ${node.value}`.includes('private-')), false);
  assert.throws(() => f.controller.setValue(['preferences', 'innocuousName'], 'value'), /credential/);
  assert.throws(() => f.controller.setValue(['dictionary'], { ordinary: 'value' }), /credential/);
  assert.equal(nativeConfigFields(schema).find(row => row.name === 'preferences.innocuousName').sensitive, true);
});
