import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { publicBrowserAddress } from './browser-authority.mjs';
import { quantity, rpcResult } from './base-rpc.mjs';
import {
  emergencyHaltTypedData, HALT_CHAIN_ID, HALT_CPHY_TOKEN, HALT_ZERO_HASH,
  HALT_WALLET_LIFETIME_SECONDS, HALT_CPHY_LIFETIME_SECONDS,
} from '../public/emergency-halt-protocol.js';

const BASE_RPC = 'https://mainnet.base.org';
export { HALT_CPHY_TOKEN };
const FEED_MAX_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 5000;
const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const WORD = /^0x[0-9a-f]{64}$/iu;
const SIGNATURE = /^0x[0-9a-f]{130}$/iu;
const TRANSFER = /^0xa9059cbb(0{24}[0-9a-f]{40})([0-9a-f]{64})$/iu;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = value => Buffer.from(value.slice(2), 'hex');
const sameHex = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const address = value => typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/iu.test(value);
const word = value => typeof value === 'string' && WORD.test(value) && !sameHex(value, HALT_ZERO_HASH);
const fail = (message, code = 'HALT_SIGNAL_INVALID', status = 422) => Object.assign(new Error(message), { code, status });

function feedUrl(value) {
  let url;
  try { if (typeof value === 'string' && value.length <= 2048 && /^https:\/\//iu.test(value) && !/[\s\\?#]/u.test(value)) url = new URL(value); }
  catch {}
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      !url.hostname.includes('.') || isIP(url.hostname) || url.hostname.endsWith('.') ||
      /(?:^|\.)(?:localhost|local|internal)$/iu.test(url.hostname) ||
      !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)))
    throw fail('Use an owner-controlled public HTTPS feed URL with no query, fragment or credentials.');
  return url;
}

export function normalizeEmergencySignalConfig(config) {
  if (config === null) return null;
  if (!plain(config) || Object.keys(config).some(key => !['wallet', 'feedUrl', 'cphyDestination'].includes(key)) ||
      !address(config.wallet)) throw fail('Enroll a nonzero owner wallet address and a public HTTPS feed.');
  const wallet = config.wallet.toLowerCase();
  const normalized = { wallet, feedUrl: feedUrl(config.feedUrl).href };
  if (config.cphyDestination != null && config.cphyDestination !== '') {
    if (!address(config.cphyDestination) || [wallet, HALT_CPHY_TOKEN].some(value => sameHex(config.cphyDestination, value)))
      throw fail('Choose a dedicated CPHY destination distinct from the owner wallet and token contract.');
    normalized.cphyDestination = config.cphyDestination.toLowerCase();
  }
  return Object.freeze(normalized);
}

export function emergencySignalProfile(installationId, nonce, config) {
  if (!config) return null;
  if (!word(installationId) || !word(nonce)) throw fail('The installation and arming nonce must be available.');
  const { wallet, cphyDestination } = normalizeEmergencySignalConfig(config);
  return { installationId, nonce, wallet, ...(cphyDestination ? { cphyDestination } : {}) };
}

function uintWord(value) { return Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex'); }

// The only accepted EIP-712 schema is shared with the static wallet signer.
function haltDigest(envelope, keccak256) {
  const hashString = value => keccak256(Buffer.from(value, 'utf8'));
  const typeHash = (name, fields) => hashString(name + '(' + fields.map(({ name, type }) => type + ' ' + name).join(',') + ')');
  const { domain, message, primaryType, types } = emergencyHaltTypedData(envelope);
  const domainSeparator = keccak256(Buffer.concat([
    typeHash('EIP712Domain', types.EIP712Domain), hashString(domain.name), hashString(domain.version),
    uintWord(domain.chainId), hex(domain.salt),
  ]));
  const structHash = keccak256(Buffer.concat([
    typeHash(primaryType, types.Halt), hashString(message.action), hex(message.nonce),
    uintWord(message.expiresAt), hex(message.transactionHash),
  ]));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domainSeparator, structHash]));
}

let signatureModules;
async function signedByOwner(envelope, wallet) {
  try {
    const serialized = hex(envelope.signature), value = serialized[64];
    const recovery = value === 27 || value === 28 ? value - 27 : value;
    if (recovery !== 0 && recovery !== 1) return false;
    // Ordinary local ChainChat runs load no wallet cryptography.
    const [{ secp256k1 }, { keccak_256 }] = await (signatureModules ??= Promise.all([
      import('@noble/curves/secp256k1.js'), import('@noble/hashes/sha3.js'),
    ]));
    const compact = serialized.subarray(0, 64), digest = haltDigest(envelope, keccak_256);
    const signature = secp256k1.Signature.fromBytes(compact, 'compact');
    if (signature.hasHighS()) return false;
    const publicKey = signature.addRecoveryBit(recovery).recoverPublicKey(digest).toBytes(false);
    const recovered = Buffer.from(keccak_256(publicKey.subarray(1)).subarray(12)).toString('hex');
    return wallet === '0x' + recovered;
  } catch { return false; }
}

const addressWord = value => '0x' + value.slice(2).padStart(64, '0');

function asQuantity(value) {
  try { return quantity(value); } catch { throw fail('Base returned an invalid quantity for the CPHY signal.'); }
}

async function defaultReadRpc(method, params, signal) {
  return rpcResult((url, options) => fetch(url, {
    ...options, signal: AbortSignal.any([options.signal, signal].filter(Boolean)),
  }), BASE_RPC, method, params);
}

async function verifyCphy(hash, { wallet, cphyDestination }, { readRpc, signal, now }) {
  if (!cphyDestination) throw fail('CPHY Emergency Halt is disabled on this installation.');
  const [chainId, transaction, receipt] = await Promise.all([
    readRpc('eth_chainId', [], signal),
    readRpc('eth_getTransactionByHash', [hash], signal),
    readRpc('eth_getTransactionReceipt', [hash], signal),
  ]);
  if (asQuantity(chainId) !== BigInt(HALT_CHAIN_ID)) throw fail('The CPHY signal requires Base mainnet.');
  if (!transaction || !receipt) return false;
  const transfer = typeof transaction.input === 'string' ? TRANSFER.exec(transaction.input) : null;
  if (!sameHex(transaction.hash, hash) || !sameHex(transaction.from, wallet) ||
      !sameHex(transaction.to, HALT_CPHY_TOKEN) || asQuantity(transaction.value) !== 0n ||
      !transfer || !sameHex('0x' + transfer[1], addressWord(cphyDestination)) || !word('0x' + transfer[2]) ||
      !sameHex(receipt.transactionHash, hash) || !sameHex(receipt.from, wallet) || !sameHex(receipt.to, HALT_CPHY_TOKEN) ||
      asQuantity(receipt.status) !== 1n || !word(receipt.blockHash) || !sameHex(transaction.blockHash, receipt.blockHash))
    throw fail('The signed hash must identify a successful direct CPHY transfer by the enrolled owner to the dedicated destination.');
  const number = asQuantity(receipt.blockNumber);
  if (asQuantity(transaction.blockNumber) !== number || !Array.isArray(receipt.logs) ||
      !receipt.logs.some(log => log && log.removed !== true && sameHex(log.address, HALT_CPHY_TOKEN) &&
        sameHex(log.transactionHash, hash) && sameHex(log.blockHash, receipt.blockHash) && sameHex(log.blockNumber, receipt.blockNumber) &&
        Array.isArray(log.topics) && log.topics.length === 3 && sameHex(log.topics[0], TRANSFER_TOPIC) &&
        sameHex(log.topics[1], addressWord(wallet)) && sameHex(log.topics[2], addressWord(cphyDestination)) &&
        sameHex(log.data, '0x' + transfer[2])))
    throw fail('The Base receipt does not contain the exact CPHY Transfer event.');

  const finalized = await readRpc('eth_getBlockByNumber', ['finalized', false], signal);
  if (!finalized || !word(finalized.hash) || asQuantity(finalized.number) < number) return false;
  const canonical = await readRpc('eth_getBlockByNumber', [receipt.blockNumber, false], signal);
  if (!canonical || !sameHex(canonical.hash, receipt.blockHash) || asQuantity(canonical.number) !== number ||
      (asQuantity(finalized.number) === number && !sameHex(finalized.hash, canonical.hash)) ||
      !Array.isArray(canonical.transactions) || !canonical.transactions.some(tx => sameHex(tx, hash)))
    throw fail('The CPHY transaction is absent from the finalized canonical Base block.');
  const age = BigInt(Math.floor(now() / 1000)) - asQuantity(canonical.timestamp);
  if (age < 0n || age > BigInt(HALT_CPHY_LIFETIME_SECONDS))
    throw fail('The finalized CPHY transaction falls outside the one-hour signal window.');
  return true;
}

/** A valid but unfinalized CPHY command returns null and can be checked again. */
export async function verifyEmergencyHaltEnvelope(envelope, state, { now = Date.now, readRpc = defaultReadRpc, signal } = {}) {
  if (!state?.config || state.halted) throw fail('Remote Emergency Halt is disabled or already active.');
  const config = normalizeEmergencySignalConfig(state.config);
  const fields = ['installationId', 'nonce', 'expiresAt', 'transactionHash', 'signature'];
  if (!plain(envelope) || Object.keys(envelope).length !== fields.length || !fields.every(key => Object.hasOwn(envelope, key)) ||
      !word(state.installationId) || !word(state.nonce) || !word(envelope.installationId) || !word(envelope.nonce) ||
      !sameHex(envelope.installationId, state.installationId) || !sameHex(envelope.nonce, state.nonce) ||
      !Number.isSafeInteger(envelope.expiresAt) || typeof envelope.transactionHash !== 'string' || !WORD.test(envelope.transactionHash) ||
      typeof envelope.signature !== 'string' || !SIGNATURE.test(envelope.signature))
    throw fail('The signed halt command is invalid or belongs to a different installation or arming nonce.');
  const cphy = !sameHex(envelope.transactionHash, HALT_ZERO_HASH);
  const secondsLeft = envelope.expiresAt - Math.floor(now() / 1000);
  if (secondsLeft <= 0 || secondsLeft > (cphy ? HALT_CPHY_LIFETIME_SECONDS : HALT_WALLET_LIFETIME_SECONDS))
    throw fail('The signed halt command is expired or outside its permitted lifetime.');
  if (!(await signedByOwner(envelope, config.wallet))) throw fail('The halt command was not signed by the enrolled owner wallet.');
  signal?.throwIfAborted();
  if (cphy && !(await verifyCphy(envelope.transactionHash, config, { readRpc, signal, now }))) return null;
  signal?.throwIfAborted();
  if (envelope.expiresAt <= Math.floor(now() / 1000)) throw fail('The halt command expired during verification.');
  return { source: cphy ? 'cphy' : 'wallet', nonce: state.nonce, installationId: state.installationId };
}

async function readEmergencyFeed(endpoint, signal, { lookup = dns.lookup, request = https.request } = {}) {
  const url = feedUrl(endpoint);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)].filter(Boolean));
  let cancelLookup;
  const cancelled = new Promise((_, reject) => {
    cancelLookup = () => reject(deadline.reason);
    deadline.addEventListener('abort', cancelLookup, { once: true });
  });
  let results;
  try {
    deadline.throwIfAborted();
    results = await Promise.race([cancelled, lookup(url.hostname, { all: true, verbatim: true })]);
  } finally { deadline.removeEventListener('abort', cancelLookup); }
  if (!results.length || results.some(({ address, family }) => isIP(address) !== family || !publicBrowserAddress(address)))
    throw fail('The emergency feed must resolve exclusively to public network addresses.');
  const { address: pinned, family } = results[0];
  return new Promise((resolve, reject) => {
    const incoming = request(url, {
      method: 'GET', agent: false, autoSelectFamily: false, signal: deadline, servername: url.hostname,
      lookup: (_host, _options, callback) => callback(null, pinned, family),
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' },
    }, response => {
      response.on('error', reject);
      if (response.statusCode === 204 || response.statusCode === 404) { response.destroy(); resolve(null); return; }
      if (response.statusCode !== 200) { response.destroy(); reject(fail('The emergency feed did not return a JSON command.')); return; }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > FEED_MAX_BYTES) {
          reject(fail('The emergency feed response exceeded its size limit.'));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
        catch { reject(fail('The emergency feed must contain a single JSON command.')); }
      });
    });
    incoming.on('error', reject);
    incoming.end();
  });
}

/** Outbound-only poller. The supervisor atomically consumes the current nonce. */
export function createEmergencySignalWatcher({
  getState, onHalt, now = Date.now, readEnvelope = readEmergencyFeed, readRpc = defaultReadRpc,
  intervalMs = POLL_INTERVAL_MS,
} = {}) {
  if (typeof getState !== 'function' || typeof onHalt !== 'function')
    throw new TypeError('Emergency signal watching requires state and a durable halt callback.');
  let timer, active, revision = 0, closed = false;
  const schedule = delay => { timer = setTimeout(poll, delay); timer.unref?.(); };
  async function poll() {
    timer = undefined;
    const state = getState();
    if (closed || state.halted || !state.config) return;
    const startedAt = revision, controller = new AbortController();
    const signal = controller.signal;
    active = controller;
    try {
      const envelope = await readEnvelope(state.config.feedUrl, signal);
      if (!envelope || signal.aborted) return;
      const command = await verifyEmergencyHaltEnvelope(envelope, state, { now, readRpc, signal });
      const current = getState();
      if (!command || signal.aborted || current.halted || current.nonce !== state.nonce ||
          current.installationId !== state.installationId || current.config?.wallet !== state.config.wallet ||
          current.config?.feedUrl !== state.config.feedUrl || current.config?.cphyDestination !== state.config.cphyDestination) return;
      await onHalt(command);
    } catch {
      // Invalid, stale or unavailable signals have no authority. A later poll
      // may receive a newly signed command or a newly finalized transaction.
    } finally {
      active = undefined;
      if (!closed && !getState().halted && getState().config) schedule(startedAt === revision ? intervalMs : 0);
    }
  }
  function refresh() {
    if (closed) return;
    revision++;
    clearTimeout(timer);
    if (active) active.abort();
    else schedule(0);
  }
  schedule(0);
  return {
    refresh,
    close() { closed = true; clearTimeout(timer); active?.abort(); },
  };
}

export { readEmergencyFeed };
