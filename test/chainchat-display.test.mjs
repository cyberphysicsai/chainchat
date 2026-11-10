import test from "node:test";
import assert from "node:assert/strict";
import { blockHeight, supportedBridgeVersion, modelCatalogueView, modelSwitchPayload, providerConnectionView } from "../public/chainchat-display.js";

test("pairing requires the current ChainChat runtime", () => {
  for (const old of [undefined, null, "", "0.3.0", "0.4.0", "0.4.1", "0.4.3", "0.4.999", "0.5.0", "0.5.1", "0.5.999", "0.6.0", "0.6.1", "0.6.999", "0.7.0", "0.7.0-beta", "garbage", "0.07.0", "0.4.9007199254740993"])
    assert.equal(supportedBridgeVersion(old), false);
  assert.equal(supportedBridgeVersion("0.7.1"), false);
  assert.equal(supportedBridgeVersion("0.8.999"), false);
  assert.equal(supportedBridgeVersion("0.9.0"), false);
  assert.equal(supportedBridgeVersion("0.9.1"), false);
  assert.equal(supportedBridgeVersion("0.9.2"), false);
  assert.equal(supportedBridgeVersion("0.9.3"), false);
  assert.equal(supportedBridgeVersion("0.9.4"), false);
  assert.equal(supportedBridgeVersion("0.9.5"), false);
  assert.equal(supportedBridgeVersion("0.9.6"), false);
  assert.equal(supportedBridgeVersion("0.9.999"), false);
  assert.equal(supportedBridgeVersion("0.10.0"), false);
  assert.equal(supportedBridgeVersion("0.10.1"), false);
  assert.equal(supportedBridgeVersion("0.10.2"), false);
  assert.equal(supportedBridgeVersion("0.10.3"), false);
  for (const retired of ["1.0.0", "1.0.1", "1.0.2"])
    assert.equal(supportedBridgeVersion(retired), false);
  for (const current of ["1.0.3", "1.1.0"])
    assert.equal(supportedBridgeVersion(current), true);
});
test("current block height is the last sealed index, including genesis zero", () => {
  assert.equal(blockHeight(null), "\u2014");
  assert.equal(blockHeight({ head: { index: 2 } }, false), "\u2014");
  assert.equal(blockHeight({ head: { index: 0 }, ringCount: 1 }), "0");
  const agent = { head: { index: 21 }, ringCount: 22, pending: { bytes: 100000 } };
  assert.equal(blockHeight(agent), "21");
  agent.head.index = 22;
  assert.equal(blockHeight(agent), "22");
  assert.equal(blockHeight({ ringCount: 900 }), "\u2014");
  assert.equal(blockHeight({ head: { index: -1 } }), "\u2014");
  assert.equal(blockHeight({ head: { index: "9007199254740993" } }), BigInt("9007199254740993").toLocaleString());
  assert.equal(blockHeight(null).codePointAt(0), 0x2014);
});

test('model catalogue retains personal provider metadata and discards retired sources and credentials', () => {
  const source = { apiKey: 'synthetic-private-value', active: { tier: 'free', provider: 'relay', model: 'retired-model', key: 'synthetic-private-value' },
    tiers: [{ id: 'free', available: true, models: [{ id: 'retired-model', available: true }] },
      { id: 'byok', available: true, notice: 'Provider models', models: [
        { id: 'personal/model', available: true, contextWindow: 32768, maxOutputTokens: 4096, apiKey: 'synthetic-private-value' },
        { id: 'personal/model', name: 'Duplicate', available: true }, { id: '', available: true },
      ] }] };
  const view = modelCatalogueView(source), [personal] = view.tiers;
  assert.equal(JSON.stringify(view).includes('synthetic-private-value'), false);
  assert.equal(JSON.stringify(view).includes('retired-model'), false);
  assert.equal(view.active, null); assert.equal(view.tiers.length, 1);
  assert.equal(personal.models.length, 1); assert.equal(personal.models[0].available, true);
  assert.equal(personal.models[0].contextWindow, 32768); assert.equal(personal.models[0].maxOutputTokens, 4096);
  assert.equal(modelCatalogueView(null).tiers.every(tier => !tier.available && !tier.models.length), true);
});

test('custom model IDs and restoring a connection both use the existing personal provider', () => {
  const catalogue = { tiers: [{ id: 'byok', available: true, models: [] }] };
  for (const model of ['vendor/custom-model', 'vendor/custom-model:free'])
    assert.deepEqual(modelSwitchPayload(catalogue, ` ${model} `), { tier: 'byok', model });
  assert.deepEqual(modelSwitchPayload(catalogue), { tier: 'byok' });
  for (const model of [undefined, 'custom']) assert.throws(() => modelSwitchPayload(null, model), /Connect your API provider/);
  for (const id of ['', 'bad\nmodel', 'a'.repeat(257)]) assert.throws(() => modelSwitchPayload(catalogue, id));
});

test('a retired selection in a legacy runtime is disconnected without clearing personal or native provider state', () => {
  const personal = { tier: 'byok', provider: 'compatible', model: 'vendor/model', configured: true };
  const native = { tier: 'native', provider: 'native', model: 'vendor/model', configured: true };
  for (const retired of [null, { ...personal, tier: 'free' }, { ...personal, tier: 'other' }])
    assert.deepEqual(providerConnectionView(retired), { configured: false });
  for (const provider of [personal, native]) assert.equal(providerConnectionView(provider), provider);
});
