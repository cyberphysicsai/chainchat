import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNativeCapabilities, nativeSettingsAllowed, nativeToolNames, authorizeNativeTool} from '../lib/native-capabilities.mjs';
const toolNames = ['image', 'pdf', 'sessions_spawn', 'sessions_send', 'cron', 'automations'];
const grant = () => ({enabled: true, acknowledged: true, tools: ['image', 'pdf'], settings: ['agents.defaults.verbosity'], delegatedRuns: false, backgroundRuns: false});
test('native grants require explicit acknowledgement, discovered tools and bounded settings', () => {
  assert.deepEqual(nativeToolNames(validateNativeCapabilities(null)), []);
  assert.throws(() => validateNativeCapabilities({...grant(), acknowledged: false}, {toolNames}));
  assert.throws(() => validateNativeCapabilities({...grant(), tools: ['invented']}, {toolNames}));
  assert.throws(() => validateNativeCapabilities({...grant(), tools: ['exec']}, {toolNames: ['exec']}));
  for (const name of ['secrets', 'gateway', 'plugins', 'config', 'openclaw'])
    assert.throws(() => validateNativeCapabilities({...grant(), tools: [name]}, {toolNames: [name]}));
  assert.throws(() => validateNativeCapabilities({...grant(), settings: ['agents.__proto__.model']}, {toolNames}));
  assert.throws(() => validateNativeCapabilities({...grant(), permissions: 'everything'}, {toolNames}));
  assert.throws(() => validateNativeCapabilities({...grant(), tools: ['image\n']}, {toolNames}));
  assert.throws(() => validateNativeCapabilities({...grant(), settings: ['agents.defaults.model\n']}, {toolNames}));
  assert.throws(() => validateNativeCapabilities({...grant(), settings: Array(1)}, {toolNames}));
  assert.throws(() => validateNativeCapabilities(grant(), {toolNames: Array(1)}));
  assert.deepEqual(nativeToolNames(validateNativeCapabilities(grant(), {toolNames})), ['image', 'pdf']);
});
test('setting admission uses exact path segments and cannot be manufactured by tool arguments', () => {
  const snapshot = validateNativeCapabilities(grant(), {toolNames});
  assert.ok(nativeSettingsAllowed(snapshot, 'agents.defaults.verbosity'));
  assert.ok(!nativeSettingsAllowed(snapshot, 'agents.defaults.verbosityOther'));
  assert.ok(!nativeSettingsAllowed(snapshot, 'agents.defaults.model'));
  assert.ok(nativeSettingsAllowed({...snapshot, settings: ['*']}, 'talk.providers'));
  assert.ok(!nativeSettingsAllowed({...snapshot, enabled: false}, 'agents.defaults.verbosity'));
});
test('concrete native calls preserve reviewed parameters and reject ungranted or delegated execution', () => {
  const tool = {name: 'image', callId: 'image-1', params: {prompt: 'Describe this image', images: ['owned-image']}};
  const result = authorizeNativeTool(grant(), tool, {toolNames});
  assert.deepEqual(result, tool); assert.notEqual(result.params, tool.params);
  assert.throws(() => authorizeNativeTool(grant(), {...tool, name: 'cron'}, {toolNames}));
  assert.throws(() => authorizeNativeTool({...grant(), tools: ['sessions_spawn']}, {...tool, name: 'sessions_spawn'}, {toolNames}));
  assert.throws(() => authorizeNativeTool({...grant(), tools: ['cron']}, {...tool, name: 'cron'}, {toolNames}));
  assert.throws(() => authorizeNativeTool({...grant(), tools: ['automations']}, {...tool, name: 'automations'}, {toolNames}));
  assert.equal(authorizeNativeTool({...grant(), tools: ['automations'], backgroundRuns: true}, {...tool, name: 'automations'}, {toolNames}).name, 'automations');
  assert.throws(() => authorizeNativeTool(grant(), {...tool, params: JSON.parse('{"constructor":{"prototype":{}}}')}, {toolNames}));
  assert.throws(() => authorizeNativeTool(grant(), {...tool, params: {text: 'x'.repeat(524289)}}, {toolNames}));
});
test('generated media keeps ordinary task actions and holds alternate native delivery controls', () => {
  const tools = ['image_generate', 'video_generate', 'music_generate', 'image'];
  const snapshot = {...grant(), tools, backgroundRuns: true};
  const admit = (name, params) => authorizeNativeTool(snapshot, {name, params, callId: 'synthetic-media'}, {toolNames: tools});
  for (const params of [{prompt: 'Generate a calm sky'}, {action: 'generate', prompt: 'Generate a calm sky'}, {action: 'list'}, {action: 'status'}])
    assert.deepEqual(admit('image_generate', params).params, params);
  for (const action of ['deliver', 'review', '  SUPERSEDE '])
    assert.throws(() => admit('image_generate', {action, taskId: 'synthetic-task'}), {code: 'NATIVE_CAPABILITY_DENIED'});
  for (const name of tools.slice(0, 3))
    assert.throws(() => admit(name, {prompt: 'Generate a calm sky', deliveryMode: 'review'}), {code: 'NATIVE_CAPABILITY_DENIED'});
  assert.deepEqual(admit('image', {image: 'owned.jpg'}).params, {image: 'owned.jpg'});
});
