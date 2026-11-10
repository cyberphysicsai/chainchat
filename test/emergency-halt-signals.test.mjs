import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  createEmergencySignalWatcher, emergencySignalProfile, HALT_CPHY_TOKEN,
  normalizeEmergencySignalConfig, readEmergencyFeed, verifyEmergencyHaltEnvelope,
} from '../lib/emergency-halt-signals.mjs';
import { HALT_ZERO_HASH } from '../public/emergency-halt-protocol.js';

const installationId = '0x' + '1'.repeat(64), nonce = '0x' + '2'.repeat(64);
const wallet = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';
const cphyDestination = '0x' + '4'.repeat(40);
const feedUrl = 'https://controls.example.com/chainchat-halt.json';
const state = { installationId, nonce, halted: false, config: { wallet, feedUrl, cphyDestination } };
const time = 2_000_000_000, now = () => time * 1000;
// Known answers produced independently by ethers' signTypedData using the
// deterministic Ethereum test key 1. No real wallet or RPC is used.
const walletCommand = {
  installationId, nonce, transactionHash: HALT_ZERO_HASH, expiresAt: time + 900,
  signature: '0x7a909eb250e869e6d04bea56f6e6021a7eb3ffed776f15cf7b030eea58099eb86ded0204bdfea688f4c8b589403ec5b33ef6f0fd341874d289517bf5830914341c',
};
const cphyCommand = {
  installationId, nonce, transactionHash: '0x' + '3'.repeat(64), expiresAt: time + 3600,
  signature: '0xc543a06f0a2abd73a9f0cfd308df6dfbccd6f9c92c6b53337897bc062bb2672a698bb20f799a233364d62d4eff3cd3f3174d33e33973bd2b509b9500f3cdd5251b',
};

test('EIP-712 owner halt authenticates locally and binds one arming nonce and installation', async () => {
  const readRpc = async () => { assert.fail('Wallet-only halt must verify without a blockchain RPC.'); };
  assert.deepEqual(await verifyEmergencyHaltEnvelope(walletCommand, state, { now, readRpc }),
    { source: 'wallet', nonce, installationId });
  const newNonce = '0x' + '5'.repeat(64);
  const otherInstallation = '0x' + '6'.repeat(64);
  for (const [envelope, current, clock] of [
    [walletCommand, { ...state, nonce: newNonce }, now],
    [{ ...walletCommand, nonce: newNonce }, { ...state, nonce: newNonce }, now],
    [walletCommand, { ...state, installationId: otherInstallation }, now],
    [{ ...walletCommand, installationId: otherInstallation }, { ...state, installationId: otherInstallation }, now],
    [walletCommand, { ...state, config: { ...state.config, wallet: cphyDestination } }, now],
    [walletCommand, { ...state, halted: true }, now],
    [walletCommand, state, () => (time + 900) * 1000],
    [walletCommand, state, () => (time - 1) * 1000],
    [{ ...walletCommand, action: 'resume' }, state, now],
    [{ ...walletCommand, expiresAt: time + 800 }, state, now],
    [{ ...cphyCommand, transactionHash: HALT_ZERO_HASH }, state, now],
  ]) {
    await assert.rejects(verifyEmergencyHaltEnvelope(envelope, current, { now: clock, readRpc }), { code: 'HALT_SIGNAL_INVALID' });
  }
});

const blockHash = '0x' + '7'.repeat(64), txHash = cphyCommand.transactionHash;
const abi = value => value.slice(2).padStart(64, '0');
const quantity = n => '0x' + n.toString(16);
const amount = '0x' + '0'.repeat(63) + '1';
function rpcFixture() {
  const tx = {
    hash: txHash, from: wallet, to: HALT_CPHY_TOKEN, value: '0x0',
    input: '0xa9059cbb' + abi(cphyDestination) + abi(amount), blockNumber: '0x40', blockHash,
  };
  const log = {
    address: HALT_CPHY_TOKEN, blockHash, blockNumber: tx.blockNumber, transactionHash: txHash, removed: false, data: amount,
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + abi(wallet), '0x' + abi(cphyDestination)],
  };
  const fixture = {
    chainId: quantity(8453), tx, log,
    receipt: { transactionHash: txHash, from: wallet, to: HALT_CPHY_TOKEN, status: '0x1', blockNumber: tx.blockNumber, blockHash, logs: [log] },
    canonical: { number: tx.blockNumber, hash: blockHash, timestamp: quantity(time - 1200), transactions: [txHash] },
    finalized: { number: '0x41', hash: '0x' + '8'.repeat(64) },
  };
  fixture.readRpc = async (method, params) => {
    switch (method) {
      case 'eth_chainId': assert.deepEqual(params, []); return fixture.chainId;
      case 'eth_getTransactionByHash': assert.deepEqual(params, [txHash]); return fixture.tx;
      case 'eth_getTransactionReceipt': assert.deepEqual(params, [txHash]); return fixture.receipt;
      case 'eth_getBlockByNumber':
        if (params[0] === 'finalized') { assert.deepEqual(params, ['finalized', false]); return fixture.finalized; }
        assert.deepEqual(params, [tx.blockNumber, false]); return fixture.canonical;
      default: assert.fail('Unexpected RPC method ' + method);
    }
  };
  return fixture;
}

test('CPHY halt waits for finality and requires signed intent plus an exact direct transfer', async () => {
  const fixture = rpcFixture();
  assert.deepEqual(await verifyEmergencyHaltEnvelope(cphyCommand, state, { now, readRpc: fixture.readRpc }),
    { source: 'cphy', nonce, installationId });
  fixture.finalized.number = '0x3f';
  assert.equal(await verifyEmergencyHaltEnvelope(cphyCommand, state, { now, readRpc: fixture.readRpc }), null);

  for (const mutate of [
    f => { f.chainId = quantity(84532); },
    f => { f.tx.from = cphyDestination; }, // Delegate, even if its Transfer log names owner.
    f => { f.tx.input = f.tx.input.replace('a9059cbb', '23b872dd'); }, // transferFrom
    f => { f.tx.to = cphyDestination; },
    f => { f.tx.input = '0xa9059cbb' + abi(wallet) + abi(amount); },
    f => { f.receipt.status = '0x0'; },
    f => { f.log.address = cphyDestination; },
    f => { f.log.removed = true; },
    f => { f.log.data = HALT_ZERO_HASH; },
    f => { f.canonical.hash = f.finalized.hash; },
    f => { f.canonical.transactions = []; },
    f => { f.canonical.timestamp = quantity(time - 3601); },
  ]) {
    const invalid = rpcFixture();
    mutate(invalid);
    await assert.rejects(verifyEmergencyHaltEnvelope(cphyCommand, state, { now, readRpc: invalid.readRpc }), { code: 'HALT_SIGNAL_INVALID' });
  }
  const readRpc = async () => { assert.fail('Unsigned intent or a disabled CPHY setting must make no RPC calls.'); };
  await assert.rejects(verifyEmergencyHaltEnvelope({ ...cphyCommand, signature: walletCommand.signature }, state, { now, readRpc }),
    { code: 'HALT_SIGNAL_INVALID' });
  await assert.rejects(verifyEmergencyHaltEnvelope(cphyCommand, { ...state, config: { wallet, feedUrl } }, { now, readRpc }),
    { code: 'HALT_SIGNAL_INVALID' });
});

test('feed enrollment and transport reject private addresses, redirects, and oversized bodies', async () => {
  assert.equal(normalizeEmergencySignalConfig(null), null);
  assert.deepEqual(emergencySignalProfile(installationId, nonce, state.config), { installationId, nonce, wallet, cphyDestination });
  for (const candidate of [
    'http://controls.example.com/halt', 'https://127.0.0.1/halt', 'https://[::1]/halt', 'https://private.local/halt',
    'https://username@controls.example.com/halt', 'https://controls.example.com/halt?secret=example',
    'https://controls.example.com/halt#fragment', 'https://controls.example.com:8443/halt',
  ]) assert.throws(() => normalizeEmergencySignalConfig({ wallet, feedUrl: candidate }), { code: 'HALT_SIGNAL_INVALID' });
  assert.throws(() => normalizeEmergencySignalConfig({ wallet, feedUrl, cphyDestination: wallet }), { code: 'HALT_SIGNAL_INVALID' });
  const signal = new AbortController().signal;
  const publicIp = { address: '1.1.1.1', family: 4 };
  await assert.rejects(readEmergencyFeed(feedUrl, signal, {
    lookup: async () => [publicIp, { address: '127.0.0.1', family: 4 }],
    request: () => assert.fail('Mixed private DNS must not connect.'),
  }), { code: 'HALT_SIGNAL_INVALID' });
  let requests = 0;
  const transport = (statusCode, body) => ({
    lookup: async () => [publicIp],
    request(url, options, respond) {
      requests++;
      assert.equal(url.href, feedUrl);
      assert.equal(options.servername, url.hostname);
      assert.equal(options.method, 'GET');
      assert.equal(options.agent, false);
      assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
      options.lookup(url.hostname, {}, (error, address, family) => {
        assert.equal(error, null);
        assert.deepEqual({ address, family }, publicIp);
      });
      const outgoing = new EventEmitter();
      outgoing.end = () => respond(Object.assign(Readable.from([Buffer.from(body)]), { statusCode }));
      return outgoing;
    },
  });
  assert.deepEqual(await readEmergencyFeed(feedUrl, signal, transport(200, JSON.stringify(walletCommand))), walletCommand);
  await assert.rejects(readEmergencyFeed(feedUrl, signal, transport(302, '')), { code: 'HALT_SIGNAL_INVALID' });
  await assert.rejects(readEmergencyFeed(feedUrl, signal, transport(200, ' '.repeat(16 * 1024 + 1))), { code: 'HALT_SIGNAL_INVALID' });
  assert.equal(requests, 3);
});

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('The isolated emergency watcher did not reach its expected state.');
}

test('watcher keeps disabled installations idle and cancels a stale poll without overlap', async () => {
  let current = { ...state, config: null }, reads = 0, accepted = 0, activeSignal, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const watcher = createEmergencySignalWatcher({
    getState: () => current, now, intervalMs: 20, onHalt: () => { accepted++; },
    async readEnvelope(_, signal) {
      reads++;
      if (reads === 1) { activeSignal = signal; await waiting; }
      return walletCommand;
    },
  });
  try {
    await delay(25);
    assert.equal(reads, 0);
    current = state;
    watcher.refresh();
    await waitFor(() => reads === 1);
    current = { ...state, nonce: '0x' + '9'.repeat(64) };
    watcher.refresh();
    assert.equal(activeSignal.aborted, true);
    await delay(25);
    assert.equal(reads, 1);
    release();
    await waitFor(() => reads >= 2);
    assert.equal(accepted, 0);
  } finally { release(); watcher.close(); }
});

test('watcher passes the valid command to the durable latch once', async () => {
  let current = state, result, reads = 0;
  const watcher = createEmergencySignalWatcher({
    getState: () => current, now, intervalMs: 20,
    async readEnvelope() { reads++; return walletCommand; },
    async onHalt(command) { result = command; current = { ...state, halted: true, nonce: '0x' + '9'.repeat(64) }; },
  });
  try {
    await waitFor(() => Boolean(result));
    await delay(45);
    assert.deepEqual(result, { source: 'wallet', nonce, installationId });
    assert.equal(reads, 1);
  } finally { watcher.close(); }
});
