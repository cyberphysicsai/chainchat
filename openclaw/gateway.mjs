/** Managed, private OpenClaw agent transport. Real provider keys live only here.
 * The HTTP agent endpoint is never exposed to the browser. An authenticated
 * local broker must admit each invocation and attest the exact final text.
 */
import { spawn, execFile } from "node:child_process";
import { loadGatewayClient } from './gateway-client-loader.mjs';
import { randomBytes, randomUUID, timingSafeEqual, createHash, generateKeyPairSync, createPublicKey, createPrivateKey } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { validateProvider, validateNativeProvider, assertCredentialIsolation, isRetiredProviderCredential, isUnsupportedModelCredential } from "../lib/providers.mjs";
import { createNativeControls, readControlOverlay, mergeControlOverlay, validateControlPatch, NATIVE_PREFERENCES, controlSessionKey, redactNativeControl } from "../lib/openclaw-controls.mjs";
import { createPrivateNativeServices } from '../lib/openclaw-services.mjs';
import { createNativeBrowserInspector } from '../lib/native-browser-inspection.mjs';
import { safeInvocationError, invocationError } from '../lib/runtime-errors.mjs';

import { nativeApiKeyStatus, nativeModelCatalogue, nativeModelRef, requireNativeModel, validateNativeProviderEntry,bundledDefaultPlugins } from '../lib/native-provider-controls.mjs';
import {NativeRunBindings} from '../lib/native-run-bindings.mjs';
import {validateNativeAttachments} from '../lib/native-attachments.mjs';
import {parseNativeMediaCompletion} from '../lib/native-media-completion.mjs';
import {NativeSecrets} from '../lib/native-secrets.mjs';
import {createNativeHeartbeatScratch,readNativeHeartbeatMonitor} from '../lib/native-heartbeat-scratch.mjs';
import {waitForNativeSessionIdle} from '../lib/native-session-idle.mjs';
import {assertRuntimeCompatibility} from './runtime-compatibility.mjs';
import {isRemovedNativeModel, isRemovedNativeProvider, modelRouteForConfig} from './plugin/model-route.mjs';
import {prepareNativeUpgrade,completeNativeUpgrade} from './native-upgrade.mjs';
import {createNativeControlConnection,stopNativeControlClient} from './native-control-connection.mjs';
import {createRuntimeHealth} from './runtime-health.mjs';
import {createRuntimeStderrEvidence} from './runtime-stderr-evidence.mjs';

import { CONTEXT_POLICY } from './plugin/compaction.mjs';

export const OPENCLAW_VERSION = "2026.11.2";
const MAX_BYTES = 24 * 1024 * 1024;
const PROVIDERS = Object.freeze({
  openai: { id: "chainchat-openai", api: "openai-responses", prefix: "/openai/v1", endpoint: "/responses" },
  compatible: { id: "chainchat-compatible", api: "openai-completions", prefix: "/compatible/v1", endpoint: "/chat/completions" },
  anthropic: { id: "chainchat-anthropic", api: "anthropic-messages", prefix: "/anthropic/v1", endpoint: "/messages" },
  gemini: { id: "chainchat-gemini", api: "google-generative-ai", prefix: "/gemini", endpoint: null },
});
const fail = (message, code = "OPENCLAW_RUNTIME", status = 502) => Object.assign(new Error(message), { code, status });
const nativeKeyRequired = () => fail('This native model cannot verify an API-key-only route. Connect an API key directly in ChainChat to use the provider.', 'OPENCLAW_NATIVE_API_KEY_REQUIRED', 409);
const nativeAuthFailed = () => fail('The local native API-key operation did not complete.', 'OPENCLAW_NATIVE_AUTH_FAILED', 422);
export function nativeControlCloseError(code, reason) {
  // Close frames are untrusted transport data. Expose only this exact, known
  // watchdog condition; arbitrary native text must never reach the UI/logs.
  return code === 4000 && reason === 'tick timeout'
    ? fail('The native control heartbeat timed out. No unreviewed answer was released.', 'OPENCLAW_CONTROL_TIMEOUT', 504)
    : fail('The native control connection closed.', 'OPENCLAW_CONTROL_CLOSED');
}
export function nativeLifecycleDiagnostic(event, generation, code, signal) {
  const safeEvent = ['exit', 'control-close'].includes(event) ? event : 'UNKNOWN';
  const safeGeneration = Number.isSafeInteger(generation) && generation > 0 ? generation : 'UNKNOWN';
  const safeCode = code === null ? 'none' : Number.isSafeInteger(code) && code >= 0 && code <= 0xffffffff ? code : 'UNKNOWN';
  const safeSignal = signal === null ? 'none' : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL'].includes(signal) ? signal : 'UNKNOWN';
  return `[chainchat] native lifecycle event=${safeEvent} generation=${safeGeneration} code=${safeCode} signal=${safeSignal}\n`;
}
function nativeControlWatchdogMs(requestTimeoutMs) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 600000)
    throw new TypeError('The native invocation timeout must be an integer from 100 through 600000 milliseconds.');
  return Math.max(60000, requestTimeoutMs + 60000);
}
const secret = () => randomBytes(32).toString("hex");
const isLoopback = address => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
function authorized(actual, expected) {
  const a = Buffer.from(String(actual || "")), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function collect(stream, limit = MAX_BYTES) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw fail("The local model transport exceeded its response limit.", "OPENCLAW_RESPONSE_LIMIT");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function checkSignal(signal) {
  if (signal?.aborted) throw fail("The OpenClaw run was cancelled.", "REQUEST_CANCELLED", 499);
}
function emit(context, ability, status, label) {
  if (typeof context?.event === "function") context.event(ability, status, label);
  else context?.onEvent?.({ ability, status, label });
}
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(); };
    const timer = setTimeout(finish, timeoutMs); child.once("exit", finish);
  });
}
async function unusedPort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function atomicJson(file, object) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(object, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
}
async function supervisorIdentity(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "transport-identity.json");
  async function read() {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 4096 ||
        process.platform !== "win32" && (info.mode & 0o077))
      throw fail("The private Gateway transport identity needs local inspection.", "OPENCLAW_IDENTITY_INVALID");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value.version !== 1 || ![value.proxyPort, value.gatewayPort, ...(value.browserPort ? [value.browserPort] : [])].every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535) ||
        value.proxyPort === value.gatewayPort || ![value.proxyToken, value.gatewayToken].every(token => typeof token === "string" && /^[a-f0-9]{64}$/.test(token)))
      throw fail("The private Gateway transport identity is invalid.", "OPENCLAW_IDENTITY_INVALID");
    if (!value.browserPort) { do { value.browserPort = await unusedPort(); } while ([value.gatewayPort, value.proxyPort].includes(value.browserPort)); await atomicJson(file, value); }
    return value;
  }
  try { return await read(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const proxyPort = await unusedPort(); let gatewayPort;
  do { gatewayPort = await unusedPort(); } while (gatewayPort === proxyPort);
  let browserPort; do { browserPort = await unusedPort(); } while ([gatewayPort, proxyPort].includes(browserPort));
  const value = { version: 1, proxyPort, gatewayPort, browserPort, proxyToken: secret(), gatewayToken: secret() };
  try { await fs.writeFile(file, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); return value; }
  catch (error) { if (error.code === "EEXIST") return read(); throw error; }
}
async function operatorIdentity(directory) {
  const file = path.join(directory, 'operator-identity.json');
  async function read() {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4096 || process.platform !== 'win32' && (stat.mode & 0o077))
      throw fail('The private operator identity requires local inspection.', 'OPENCLAW_IDENTITY_INVALID');
    const item = JSON.parse(await fs.readFile(file, 'utf8'));
    const publicKey = createPublicKey(item.publicKeyPem), privateKey = createPrivateKey(item.privateKeyPem);
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    if (publicKey.asymmetricKeyType !== 'ed25519' || privateKey.asymmetricKeyType !== 'ed25519' ||
        !derived.equals(publicKey.export({ type: 'spki', format: 'der' })) ||
        createHash('sha256').update(derived.subarray(-32)).digest('hex') !== item.deviceId)
      throw fail('The private operator identity is invalid.', 'OPENCLAW_IDENTITY_INVALID');
    return item;
  }
  try { return await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pair = generateKeyPairSync('ed25519');
  const item = { deviceId: createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).digest('hex'),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  try { await fs.writeFile(file, JSON.stringify(item) + '\n', { mode: 0o600, flag: 'wx' }); return item; }
  catch (error) { if (error.code === 'EEXIST') return read(); throw error; }
}
function redactError() { return fail("The selected model failed inside the local OpenClaw runtime. No model text was released.", "OPENCLAW_MODEL_FAILED"); }
function* providerRecords(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  try { const value = JSON.parse(text); if (Array.isArray(value)) yield* value; else yield value; return; } catch {}
  let data = [];
  const parse = value => { try { return JSON.parse(value); } catch { return undefined; } };
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      if (data.length) { const value = parse(data.join('\n')); if (Array.isArray(value)) yield* value; else if (value !== undefined) yield value; }
      data = [];
    } else if (line === 'data') data.push('');
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length) { const value = parse(data.join('\n')); if (Array.isArray(value)) yield* value; else if (value !== undefined) yield value; }
}
function inspectResponse(config, buffer) {
  const text = buffer.toString("utf8"); assertCredentialIsolation(config, text);
  for (const record of providerRecords(buffer)) assertCredentialIsolation(config, record);
}

// Keep the provider's explicit stop condition across the native adapter. Some
// adapters otherwise turn a token-limited stream into a normal final reply.
export function assertProviderCompletion(provider, buffer) {
  const termination = code => { throw Object.assign(fail(
    code === 'PROVIDER_INCOMPLETE' ? 'The provider did not finish a complete response.'
      : code === 'PROVIDER_CONTENT_HELD' ? 'The provider held the model response.'
      : code === 'PROVIDER_RATE_LIMIT' ? 'The provider rate limit or quota was reached.'
      : code === 'PROVIDER_HTTP_ERROR' ? 'The provider rejected the model request.'
      : 'The provider returned an invalid or unsuccessful response.', code,
    code === 'PROVIDER_RATE_LIMIT' ? 429 : code === 'PROVIDER_CONTENT_HELD' ? 422 : 502), { stage: 'generation' }); };
  const providerFailure = error => {
    const codes = [error?.code, error?.type, error?.status].map(value => String(value ?? '').toLowerCase());
    if (codes.some(code => ['429', 'rate_limit_exceeded', 'rate_limit_error', 'rate_limit', 'quota_exceeded', 'insufficient_quota', 'resource_exhausted'].includes(code))) termination('PROVIDER_RATE_LIMIT');
    if (codes.some(code => ['401', '403', 'invalid_api_key', 'api_key_invalid', 'authentication_error', 'invalid_authentication', 'unauthorized', 'permission_denied', 'access_denied'].includes(code))) termination('PROVIDER_HTTP_ERROR');
    termination('PROVIDER_INVALID_RESPONSE');
  };
  for (const value of providerRecords(buffer)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    let incomplete = false, held = false;
    if (value.error || value.type === 'error') providerFailure(value.error || value);
    if (provider === 'compatible') {
      const choices = Array.isArray(value.choices) ? value.choices : [];
      const reasons = choices.map(choice => choice?.finish_reason);
      held = reasons.includes('content_filter') || choices.some(choice => choice?.message?.refusal || choice?.delta?.refusal);
      if (held) termination('PROVIDER_CONTENT_HELD');
      if (reasons.some(reason => reason != null && !['stop', 'length', 'tool_calls', 'function_call'].includes(reason))) termination('PROVIDER_INVALID_RESPONSE');
      incomplete = reasons.includes('length');
    } else if (provider === 'openai') {
      const result = value.response || value;
      if (result.error || result.status === 'failed' || value.type === 'response.failed') providerFailure(result.error);
      const reason = result.incomplete_details?.reason;
      held = reason === 'content_filter' || value.type === 'response.refusal.delta' || value.type === 'response.refusal.done' ||
        (Array.isArray(result.output) && result.output.some(item => Array.isArray(item?.content) && item.content.some(part => part?.type === 'refusal')));
      if (held) termination('PROVIDER_CONTENT_HELD');
      if (result.status != null && !['queued', 'in_progress', 'completed', 'incomplete'].includes(result.status)) termination('PROVIDER_INVALID_RESPONSE');
      if (result.status === 'incomplete' || value.type === 'response.incomplete') {
        if (![undefined, null, 'max_output_tokens'].includes(reason)) termination('PROVIDER_INVALID_RESPONSE');
        incomplete = true;
      }
    } else if (provider === 'anthropic') {
      const reason = value.delta?.stop_reason || value.stop_reason;
      held = reason === 'refusal' || value.content_block?.type === 'refusal' ||
        (Array.isArray(value.content) && value.content.some(part => part?.type === 'refusal'));
      if (held) termination('PROVIDER_CONTENT_HELD');
      if (reason != null && !['end_turn', 'stop_sequence', 'max_tokens', 'tool_use', 'pause_turn'].includes(reason)) termination('PROVIDER_INVALID_RESPONSE');
      incomplete = reason === 'max_tokens';
    } else if (provider === 'gemini') {
      const reasons = (Array.isArray(value.candidates) ? value.candidates : []).map(candidate => candidate?.finishReason);
      held = !!value.promptFeedback?.blockReason || reasons.some(reason => ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'].includes(reason));
      if (held) termination('PROVIDER_CONTENT_HELD');
      if (reasons.some(reason => reason != null && !['STOP', 'MAX_TOKENS'].includes(reason))) termination('PROVIDER_INVALID_RESPONSE');
      incomplete = reasons.includes('MAX_TOKENS');
    }
    if (incomplete) termination('PROVIDER_INCOMPLETE');
  }
}

/** A private per-invocation capability can occur once in system instructions.
 * Strip it before BYOK egress. Unreviewed fallback summarizers have no lease.
 */
export function consumeModelRouteCapability(body, provider, capability) {
  if (!/^[a-f0-9]{64}$/.test(capability || '')) throw fail('Private model admission is unavailable.', 'OPENCLAW_MODEL_ADMISSION', 403);
  const marker = `[CHAINCHAT_PRIVATE_MODEL_ROUTE:${capability}]`, copy = structuredClone(body);
  let total = 0, admitted = 0;
  const count = value => {
    if (typeof value === 'string') total += value.split(marker).length - 1;
    else if (Array.isArray(value)) value.forEach(count);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { count(key); count(child); }
  };
  count(copy);
  const strip = (object, key) => { if (typeof object?.[key] === 'string') {
    admitted += object[key].split(marker).length - 1; object[key] = object[key].replaceAll(marker, '');
  } };
  const content = (object, key) => {
    if (typeof object?.[key] === 'string') strip(object, key);
    else if (Array.isArray(object?.[key])) object[key].forEach(part => strip(part, 'text'));
  };
  if (provider === 'anthropic') content(copy, 'system');
  else if (provider === 'gemini') {
    for (const part of copy.systemInstruction?.parts || copy.system_instruction?.parts || []) strip(part, 'text');
  } else {
    strip(copy, 'instructions');
    for (const message of [...(Array.isArray(copy.messages) ? copy.messages : []), ...(Array.isArray(copy.input) ? copy.input : [])])
      if (['system', 'developer'].includes(message?.role)) content(message, 'content');
  }
  if (admitted !== 1 || total !== 1) throw Object.assign(fail('No exact model-route capability was supplied by the mandatory prompt hook.', 'OPENCLAW_MODEL_ADMISSION', 403),
    { admissionCounts: { system: admitted, total } });
  return copy;
}

/** Resolve only model protocol paths, never an arbitrary request URL. */
export function providerRequest(config, incomingPath, body, { openCodeSession, maxTokens } = {}) {
  if (typeof incomingPath !== "string" || !incomingPath.startsWith("/") || incomingPath.startsWith("//"))
    throw fail("Unsupported local provider route.", "OPENCLAW_PROXY_ROUTE", 404);
  config = validateProvider(config);
  const provider = PROVIDERS[config.provider];
  const incoming = new URL(incomingPath, "http://127.0.0.1");
  let suffix;
  if (provider.endpoint) {
    if (incoming.pathname !== provider.prefix + provider.endpoint || incoming.search)
      throw fail("Unsupported local provider route.", "OPENCLAW_PROXY_ROUTE", 404);
    suffix = provider.endpoint;
  } else {
    const match = incoming.pathname.match(/^\/gemini\/(?:v1beta\/)?models\/route:(streamGenerateContent|generateContent)$/);
    if (!match || [...incoming.searchParams.keys()].some(key => key !== "alt" && key !== "key") ||
        (incoming.searchParams.has("alt") && incoming.searchParams.get("alt") !== "sse"))
      throw fail("Unsupported local provider route.", "OPENCLAW_PROXY_ROUTE", 404);
    suffix = `/models/${encodeURIComponent(config.model.replace(/^models\//, ""))}:${match[1]}` +
      (incoming.searchParams.get("alt") === "sse" ? "?alt=sse" : "");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("Invalid local provider request.", "OPENCLAW_PROXY_REQUEST", 400);
  assertCredentialIsolation(config, body);
  const clean = structuredClone(body);
  if (config.provider === "gemini") delete clean.model; else clean.model = config.model;
  // Native chat.send may otherwise select the model catalogue ceiling instead
  // of the caller's per-turn allowance. Enforce the private admitted budget at
  // every provider forward, including later tool-loop calls.
  if (maxTokens !== undefined || config.maxOutputTokens !== undefined) {
    const ceiling = Math.min(maxTokens ?? 32768, config.maxOutputTokens ?? 32768);
    if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 32768)
      throw Object.assign(fail('The admitted output allowance is invalid.', 'OPENCLAW_OUTPUT_BUDGET', 422), { stage: 'generation' });
    const cap = (object, key) => {
      const value = object[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw Object.assign(fail('The native output allowance is invalid.', 'OPENCLAW_OUTPUT_BUDGET', 422), { stage: 'generation' });
      object[key] = Math.min(value ?? ceiling, ceiling);
    };
    if (config.provider === 'openai') cap(clean, 'max_output_tokens');
    else if (config.provider === 'anthropic') cap(clean, 'max_tokens');
    else if (config.provider === 'gemini') {
      const invalid = () => Object.assign(fail('The native output configuration is ambiguous or invalid.', 'OPENCLAW_OUTPUT_BUDGET', 422), { stage: 'generation' });
      if (clean.generation_config !== undefined) {
        if (clean.generationConfig !== undefined) throw invalid();
        clean.generationConfig = clean.generation_config; delete clean.generation_config;
      }
      clean.generationConfig ??= {};
      if (typeof clean.generationConfig !== 'object' || Array.isArray(clean.generationConfig)) throw invalid();
      const settings = clean.generationConfig;
      if (settings.max_output_tokens !== undefined) {
        if (!Number.isSafeInteger(settings.max_output_tokens) || settings.max_output_tokens < 1) throw invalid();
        if (settings.maxOutputTokens !== undefined && (!Number.isSafeInteger(settings.maxOutputTokens) || settings.maxOutputTokens < 1)) throw invalid();
        settings.maxOutputTokens = Math.min(settings.maxOutputTokens ?? settings.max_output_tokens, settings.max_output_tokens);
        delete settings.max_output_tokens;
      }
      cap(settings, 'maxOutputTokens');
    } else {
      const usesCompletion = Object.hasOwn(clean, 'max_completion_tokens');
      cap(clean, usesCompletion ? 'max_completion_tokens' : 'max_tokens');
      if (usesCompletion && Object.hasOwn(clean, 'max_tokens')) cap(clean, 'max_tokens');
    }
  }
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const endpoint = new URL(config.baseUrl);
  if (endpoint.protocol === "https:" && endpoint.hostname === "opencode.ai" && !endpoint.port &&
      endpoint.pathname.startsWith("/inference/go/")) {
    if (typeof openCodeSession !== "string" || !/^[a-f0-9-]{36}$/i.test(openCodeSession))
      throw fail("The private model session is unavailable.", "OPENCLAW_PROVIDER_SESSION");
    headers["user-agent"] = "CypherTempre-ChainChat";
    headers["x-opencode-session"] = openCodeSession;
  }
  if (config.provider === "anthropic") { headers["x-api-key"] = config.apiKey; headers["anthropic-version"] = "2023-06-01"; }
  else if (config.provider === "gemini") headers["x-goog-api-key"] = config.apiKey;
  else if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return { url: config.baseUrl + suffix, body: clean, headers };
}

/** Returns a manager; constructing it does not spawn processes or write files. */
export function createOpenClawGateway({ stateDir, packageRoot, nodePath = process.execPath, pluginPath, broker,
  toolsPolicy = { profile: "full", deny: [] }, startupTimeoutMs = 180000, requestTimeoutMs = 240000,
  fetchImpl = fetch, spawnImpl = spawn, onDiagnostic, browserService, serviceEnvironment = () => ({}), serviceSecrets = () => [],
  nativeCapabilities = () => null, resolveNativeOwner,resolveNativeModelRoute, deferNativeSources=false, mediaDirectory, mediaRoot=mediaDirectory, modelContextTokens,
  runtimeCompatibilityCheck=assertRuntimeCompatibility } = {}) {
  if (!stateDir || !packageRoot || !pluginPath || !broker || typeof broker.registerInvocation !== "function" ||
      typeof broker.assertCandidate !== "function") throw new TypeError("A local OpenClaw runtime, plugin and enforcement broker are required.");
  if (modelContextTokens !== undefined && (!Number.isSafeInteger(modelContextTokens) || modelContextTokens < 16384 || modelContextTokens > 131072))
    throw new TypeError('The private native model context cap must be an integer from 16384 through 131072.');
  const controlWatchdogTimeoutMs = nativeControlWatchdogMs(requestTimeoutMs);
  const directory = path.resolve(stateDir), upstream = path.resolve(packageRoot), plugin = path.resolve(pluginPath);
  if(typeof deferNativeSources!=='boolean')throw new TypeError('Native source readiness is a private boolean option.');
  if(mediaRoot!==undefined&&(typeof mediaRoot!=='string'||!path.isAbsolute(mediaRoot)||mediaRoot.length>32768||mediaRoot.includes('\0')))
    throw new TypeError('Native media needs an absolute supervisor-owned directory.');
  // Private transport identity remains stable so native session/goal storage
  // survives restarts without retaining a stale loopback model endpoint/token.
  // Real BYOK credentials are never stored in that identity or native config.
  const providerSessions = new WeakMap();
  let child = null, proxy = null, port = null, proxyPort = null, active = null, queue = Promise.resolve(), startup = null, stopping = null, stoppingChild = null;
  let gatewayToken = secret(), proxyToken = secret(), closed = false, suspended = false;
  let suspension, emergencyChild, haltEpoch = 0;
  const assertRunningAllowed = (epoch = haltEpoch) => {
    if (suspended || epoch !== haltEpoch) throw fail('Emergency Halt is active.', 'EMERGENCY_HALTED', 423);
    if (closed) throw fail('This OpenClaw manager is closed.', 'OPENCLAW_CLOSED');
  };
  let childGeneration = 0;
  const runtimeHealth = createRuntimeHealth();
  let identity = null, lastConfiguration = null, pendingOverlay = null;
  let browserHosts = [], reasoningCapable = false, capabilitiesInitialized = false;
  let contextWindow = modelContextTokens || 131072, outputCeiling = 32768;
  let managedServices = {};
  let nativeSelection = null, nativeProviders = {}, nativeAuthConfiguration = {}, nativeProvidersLoaded = false;
  let lastServiceEnvironmentHash = null;
  const nativeEvents = new Set();
  const nativeControl = createNativeControlConnection({
    getOwner: () => ({ child, generation: childGeneration, port, token: gatewayToken }),
    isOwnerCurrent: owner => !closed && !suspended && owner.child && owner.child === child && owner.generation === childGeneration &&
      owner.port === port && owner.token === gatewayToken && child.exitCode === null && child.signalCode === null,
    createClient: async (callbacks, owner) => {
      const GatewayClient = await loadGatewayClient(upstream);
      const deviceIdentity = await operatorIdentity(directory), controlUrl = `ws://127.0.0.1:${owner.port}`;
      return new GatewayClient({ url: controlUrl, deviceAuthScope: controlUrl, token: owner.token,
        clientName: 'cli', clientDisplayName: 'Cypher Tempre private controls', mode: 'backend', role: 'operator',
        caps: ['session-scoped-events', 'model-selection-policy'],
        // Keep long reviewed hooks bounded by the invocation and cleanup budget.
        tickWatchTimeoutMs: controlWatchdogTimeoutMs,
        scopes: ['operator.read', 'operator.write', 'operator.admin'], deviceIdentity, sharedStateMode: 'read-only',
        ...callbacks,
      });
    },
    onEvent(event) { for (const listener of nativeEvents) { try { listener(event); } catch {} } },
    onCloseDiagnostic(owner, code) { onDiagnostic?.(nativeLifecycleDiagnostic('control-close', owner.generation, code, null)); },
    closeError: nativeControlCloseError,
    authenticationError: () => fail('Native OpenClaw control authentication failed.', 'OPENCLAW_CONTROL_AUTH'),
    timeoutError: () => fail('The native OpenClaw control connection did not authenticate.', 'OPENCLAW_CONTROL_TIMEOUT'),
  });
  const nativeCredentialValues=new Set();
  const dynamicInvocations = new Map(), pendingDynamic = new Map(), routeInvocations = new Map(),dynamicRows=new Set();
  let nativeSourcesReady=!deferNativeSources,resolveNativeReadiness,nativeUpgrade;
  const nativeReadiness=new Promise(resolve=>{resolveNativeReadiness=resolve;});
  if(nativeSourcesReady)resolveNativeReadiness(true);
  const nativeIdentityKeys = new Set();
  const nativeSecretStore = new NativeSecrets(directory);
  const runBindings = new NativeRunBindings(directory, {inspectCron:id=>nativeRpc('cron.get',{id}),inspectSource:inspectNativeSource,
    inspectSession:key=>nativeRpc('sessions.describe',{key,includeDerivedTitles:false,includeLastMessage:false}),parseMediaCompletion:parseNativeMediaCompletion});
  const privateServiceSecrets = () => [gatewayToken, proxyToken, broker.token,...nativeCredentialValues,...nativeSecretStore.values(), ...(serviceSecrets() || []), ...(browserService?.redactionSecrets?.() || [])]
    .filter(value => typeof value === 'string' && value.length > 0);
  const checkServiceIsolation = value => {
    for (const secret of privateServiceSecrets()) {
      for (const encoded of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]))
        assertCredentialIsolation({ apiKey: encoded }, value);
    }
  };
  function serviceEnvironmentSnapshot() {
    const values = serviceEnvironment();
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([name, value]) =>
        !/^CHAINCHAT_CHANNEL_[A-F0-9]{32}_[A-Z0-9_]+$/.test(name) || typeof value !== 'string' || value.length > 65536 || /\0/.test(value)))
      throw fail('Private native channel environment is invalid.', 'OPENCLAW_SERVICE_DENIED', 403);
    return { values, hash: createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))))).digest('hex') };
  }
  const status = () => {
    const running = Boolean(child && child.exitCode === null && child.signalCode === null);
    return { backend: "openclaw", version: OPENCLAW_VERSION, running,
      ...runtimeHealth.snapshot(running, nativeControl.isReady()),
      localOnly: true, credentials: "session-memory", contextPolicy: structuredClone(CONTEXT_POLICY), hostTools: toolsPolicy.deny?.includes("*") ? "disabled" : "scoped-per-invocation" };
  };
  async function stopChild({ force = false, tree = false } = {}) {
    if (suspended && !tree) return;
    runtimeHealth.stopping();
    if (force) {
      // A missing assembly capability is a runtime integrity fault. Terminate
      // this exact owned process before acknowledging a failed model request:
      // graceful shutdown could let upstream persist a fallback summary first.
      const owned = child || stoppingChild || emergencyChild; child = null;
      if (tree) emergencyChild = owned;
      const client = nativeControl.invalidate();
      if (owned && owned.exitCode === null && owned.signalCode === null) {
        if (tree && process.platform === 'win32' && owned.pid) {
          await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'],
            { windowsHide: true, timeout: 7000 }, () => resolve()));
        } else if (tree && owned.pid) {
          try { process.kill(-owned.pid, 'SIGKILL'); }
          catch { owned.kill('SIGKILL'); }
        } else owned.kill('SIGKILL');
        await waitForExit(owned, 5000);
        if (owned.exitCode === null && owned.signalCode === null)
          throw fail('The isolated runtime could not be stopped after an integrity fault.', 'OPENCLAW_STOP_FAILED');
      }
      if (owned === emergencyChild) emergencyChild = null;
      await stopNativeControlClient(client); runtimeHealth.stopped();
      return;
    }
    if (stopping) return stopping;
    const owned = child; child = null;
    if (!owned || owned.exitCode !== null || owned.signalCode !== null) {
      const client = nativeControl.invalidate();
      await stopNativeControlClient(client); runtimeHealth.stopped(); return;
    }
    stoppingChild = owned;
    stopping = (async () => {
      const client = nativeControl.invalidate();
      await stopNativeControlClient(client);
      if (suspended) return;
      // An owned IPC pipe works on Windows without a visible console. The
      // bootstrap forwards only this fixed shutdown message to the pinned
      // runtime's native SIGTERM handler; it exposes no command interface.
      if (owned.connected && typeof owned.send === "function") {
        try { owned.send({ type: "chainchat:shutdown" }, () => {}); } catch {}
        await waitForExit(owned, 7000);
      }
      if (owned.exitCode !== null || owned.signalCode !== null) return;
      if (process.platform === "win32") {
        await new Promise(resolve => execFile("taskkill.exe", ["/PID", String(owned.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
        await waitForExit(owned, 3000);
      } else {
        try { process.kill(-owned.pid, "SIGTERM"); } catch { owned.kill("SIGTERM"); }
        await waitForExit(owned, 3000);
        if (owned.exitCode === null && owned.signalCode === null) { try { process.kill(-owned.pid, "SIGKILL"); } catch { owned.kill("SIGKILL"); } }
      }
    })().finally(() => { stopping = null; stoppingChild = null; runtimeHealth.stopped(); });
    return stopping;
  }
  async function handleProxy(request, response) {
    let current = active;
    let admitted = false;
    const epoch = haltEpoch;
    try {
      if (request.headers.origin || !isLoopback(request.socket.remoteAddress) || !authorized(request.headers.authorization ||
          (request.headers["x-api-key"] ? `Bearer ${request.headers["x-api-key"]}` : request.headers["x-goog-api-key"] ? `Bearer ${request.headers["x-goog-api-key"]}` :
            new URL(request.url, "http://127.0.0.1").searchParams.get("key") ? `Bearer ${new URL(request.url, "http://127.0.0.1").searchParams.get("key")}` : ""), proxyToken))
        throw fail("Local provider authentication required.", "OPENCLAW_PROXY_AUTH", 401);
      if (request.method !== 'POST') throw fail('No admitted local model invocation.', 'OPENCLAW_PROXY_INACTIVE', 409);
      assertRunningAllowed(epoch);
      const raw = await collect(request), received = JSON.parse(raw.toString('utf8'));
      const markers = [...JSON.stringify(received).matchAll(/\[CHAINCHAT_PRIVATE_MODEL_ROUTE:([a-f0-9]{64})\]/gu)];
      if (markers.length === 1) current = routeInvocations.get(markers[0][1]) || current;
      const stillCurrent = () => current === active || dynamicInvocations.get(current?.sessionKey) === current;
      if (current?.kind === 'compaction') {
        // Reviewed summaries use the parent broker's direct provider route.
        // Any child inference here is an unadmitted legacy summarizer; stop it
        // before even returning an error that could trigger a fallback write.
        try { await stopChild({ force: true }); } finally { current.controller.abort(); }
        throw fail('Unadmitted native compaction inference was held.', 'OPENCLAW_MODEL_ADMISSION', 403);
      }
      if (request.method !== "POST" || !current || current.controller.signal.aborted)
        throw fail("No admitted local model invocation.", "OPENCLAW_PROXY_INACTIVE", 409);
      await assertEnforcementHealthy({ duringStartup: true });
      if (!stillCurrent() || current.controller.signal.aborted)
        throw fail('The model invocation ended before forwarding.', 'REQUEST_CANCELLED', 499);
      let decoded;
      try { decoded = consumeModelRouteCapability(received, current.config.provider, current.modelRouteCapability); }
      catch (error) {
        // No response (including an HTTP error) reaches the native summarizer
        // while it could still write a deterministic fallback to its transcript.
        try { await stopChild({ force: true }); }
        finally { current.controller.abort(); }
        throw error;
      }
      checkServiceIsolation(decoded);
      admitted = true;
      const upstreamRequest = providerRequest(current.config, request.url, decoded, {
        openCodeSession: current.openCodeSession, maxTokens: current.args.maxTokens || 4096 });
      {
        // This is a bounded UTF-8 estimate, not a provider-specific tokenizer.
        // It catches plainly oversized first turns before a remote rejection.
        const inputEstimate = Math.ceil(Buffer.byteLength(JSON.stringify(upstreamRequest.body), 'utf8') / 3);
        const output = Math.min(current.args.maxTokens || 4096, current.config.maxOutputTokens || 32768);
        if (inputEstimate + output > Math.min(current.config.contextWindow ?? contextWindow, contextWindow))
          throw Object.assign(fail('The active request exceeds the configured model context window.', 'OPENCLAW_CONTEXT_BUDGET', 422), { stage: 'context' });
      }
      if (!stillCurrent()) throw fail("The model invocation ended.", "REQUEST_CANCELLED", 499);
      assertRunningAllowed(epoch);
      emit(current.context, "model", "started", "OpenClaw provider inference");
      let result;
      try { result = await fetchImpl(upstreamRequest.url, { method: "POST", headers: upstreamRequest.headers,
        body: JSON.stringify(upstreamRequest.body), redirect: "error", signal: current.controller.signal }); }
      catch (error) {
        if (current.controller.signal.aborted) throw error;
        throw Object.assign(fail('The provider connection failed.', 'PROVIDER_CONNECTION_ERROR'), { stage: 'generation' });
      }
      if (!result.ok) {
        await result.body?.cancel();
        throw Object.assign(fail(result.status === 429 ? 'The provider rate limit or quota was reached.'
          : 'The provider rejected the model request. Check its model, endpoint and limits.',
          result.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_HTTP_ERROR', result.status === 429 ? 429 : 502), { stage: 'generation' });
      }
      const payload = await collect(result.body); inspectResponse(current.config, payload); checkServiceIsolation(payload.toString('utf8'));
      assertProviderCompletion(current.config.provider, payload);
      if (!stillCurrent() || current.controller.signal.aborted) throw fail("The model invocation ended.", "REQUEST_CANCELLED", 499);
      assertRunningAllowed(epoch);
      current.providerError = null;
      emit(current.context, "model", "completed", "OpenClaw provider inference");
      response.writeHead(200, { "content-type": String(result.headers.get("content-type") || "application/json"), "cache-control": "no-store" });
      response.end(payload);
    } catch (error) {
      if (admitted && (current === active || dynamicInvocations.get(current?.sessionKey) === current) && !current.providerError)
        current.providerError = safeInvocationError(error, 'generation');
      onDiagnostic?.(`[chainchat] private model request held code=${/^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'PROVIDER_FAILED'}${error.admissionCounts ? ` systemMarkers=${error.admissionCounts.system} totalMarkers=${error.admissionCounts.total}` : ''}\n`);
      emit(current?.context, "model", "held", "OpenClaw provider held");
      if (!response.headersSent) response.writeHead(Number.isInteger(error.status) ? error.status : 502,
        { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { message: "The local provider request was held.", type: "chainchat_provider_error" } }));
    }
  }
  async function start() {
    const epoch = haltEpoch;
    assertRunningAllowed(epoch);
    if (startup) return startup;
    if (child && child.exitCode === null && child.signalCode === null) {
      await assertEnforcementHealthy({ duringStartup: true });
      return status();
    }
    startup = (async () => {
      await stopping;
      assertRunningAllowed(epoch);
      runtimeHealth.starting(childGeneration + 1);
      await initializeModelCapabilities(); await initializeNativeProviders();
      assertRunningAllowed(epoch);
      // Capture an old native installation before any supervisor configuration
      // overlay is written. Current/fresh state never runs Doctor.
      nativeUpgrade ||= await prepareNativeUpgrade({directory,packageRoot:upstream,nodePath,onDiagnostic});
      identity ||= await supervisorIdentity(directory);
      gatewayToken = identity.gatewayToken; proxyToken = identity.proxyToken;
      const runtimeState = path.join(directory, "native-state");
      const manifest = JSON.parse(await fs.readFile(path.join(upstream, "package.json"), "utf8"));
      if (manifest.name !== "openclaw" || manifest.version !== OPENCLAW_VERSION)
        throw fail(`Install the pinned OpenClaw ${OPENCLAW_VERSION} runtime.`, "OPENCLAW_VERSION_MISMATCH");
      await runtimeCompatibilityCheck(upstream);
      const brokerUrl = new URL(broker.url);
      if (brokerUrl.protocol !== "http:" || brokerUrl.hostname !== "127.0.0.1" || brokerUrl.username || brokerUrl.password || brokerUrl.search || brokerUrl.hash || !broker.token)
        throw fail("The enforcement broker must be an authenticated loopback service.", "OPENCLAW_BROKER_CONFIG");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.mkdir(runtimeState,{recursive:true,mode:0o700});
      const nativeStateStat=await fs.lstat(runtimeState);
      if(!nativeStateStat.isDirectory()||nativeStateStat.isSymbolicLink()||await fs.realpath(runtimeState)!==runtimeState||process.platform!=='win32'&&typeof process.getuid==='function'&&nativeStateStat.uid!==process.getuid())throw fail('Native state ownership requires private local inspection.','OPENCLAW_STATE_INVALID');
      if(process.platform!=='win32'&&(nativeStateStat.mode&0o077))await fs.chmod(runtimeState,0o700);
      await fs.mkdir(path.join(runtimeState, 'cache'), { recursive: true, mode: 0o700 });
      if(mediaRoot){await fs.mkdir(mediaRoot,{recursive:true,mode:0o700});const stat=await fs.lstat(mediaRoot);if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&stat.mode&0o077||await fs.realpath(mediaRoot)!==path.resolve(mediaRoot))throw fail('The native media directory requires private local inspection.','OPENCLAW_MEDIA_INVALID');}
      const workspace = path.join(directory, "workspace"); await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
      if (!proxy) {
        proxy = http.createServer((request, response) => { void handleProxy(request, response); });
        proxyPort = identity.proxyPort;
        try { await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(proxyPort, "127.0.0.1", resolve); }); }
        catch { proxy.close(); proxy = null; throw fail("The private Gateway provider port is occupied. Stop only the previous owned app and retry.", "OPENCLAW_PORT_OCCUPIED"); }
      }
      // The pinned runtime caches resolved model authentication in its own
      // state. Keep this private proxy credential and loopback route stable
      // across application restarts without persisting real provider keys.
      port = identity.gatewayPort;
      // Refuse an occupied native port before spawning; never connect to or
      // terminate an unrelated listener and never silently rotate persisted routes.
      const reservation = net.createServer();
      try { await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(port, "127.0.0.1", resolve); }); }
      catch { throw fail("The private Gateway port is occupied. Stop only the previous owned app and retry.", "OPENCLAW_PORT_OCCUPIED"); }
      await new Promise(resolve => reservation.close(resolve));
      const providers = Object.fromEntries(Object.values(PROVIDERS).map(value => [value.id, {
        baseUrl: `http://127.0.0.1:${proxyPort}${value.prefix}`, apiKey: "${CHAINCHAT_PROVIDER_TOKEN}", api: value.api,
        authHeader: true, models: [{ id: "route", name: "User selected model (in-memory transport)", api: value.api,
          reasoning: reasoningCapable, input: ["text"], contextWindow, maxTokens: Math.min(outputCeiling, contextWindow - 1),
          ...(modelContextTokens !== undefined ? { contextTokens: modelContextTokens } : {}),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      }]));
      const bundledPlugins=await bundledDefaultPlugins(upstream);
      const baseConfiguration = { gateway: { mode: "local", bind: "loopback", port,
          auth: { mode: "token", token: "${CHAINCHAT_GATEWAY_TOKEN}" }, controlUi: { enabled: false },
          http: { endpoints: { chatCompletions: { enabled: true } } } },
        // Additional skill documents enter through the owner-bound broker.
        agents: { defaults: { workspace, skipBootstrap: true, skills: [], model: { primary: nativeSelection || "chainchat-compatible/route" },
          // Automatic utility selection is independent of per-chat provider
          // overrides; it must never silently charge a saved native profile.
          utilityModel: '',
          compaction: { memoryFlush: { enabled: false } },
          heartbeat: { every: "0m" }, maxConcurrent: 1 } },
        // Upstream defaults to remote OpenAI embeddings and on-start sync.
        // Native memory remains available only by explicit owner opt-in.
        memory:{search:{enabled:false}},
        tools: mergeControlOverlay(toolsPolicy, { toolSearch: false,
          web: { fetch: { maxRedirects: 0, ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } } } }),
        browser: { enabled: true, evaluateEnabled: false, defaultProfile: 'openclaw', attachOnly: false, noSandbox: false,
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false, allowedHostnames: browserHosts }, profiles: { openclaw: { cdpPort: identity.browserPort } } },
        models: { mode: "merge", catalogRefresh: { enabled: false }, providers: { ...nativeProviders, ...providers } },
        ...(Object.keys(nativeAuthConfiguration).length ? {auth: keyAuthConfiguration(nativeAuthConfiguration)} : {}),
        discovery: { mdns: { mode: "off" } }, cron: { enabled: false },
        // Update only through the reviewed downstream installer/pin. This also
        // suppresses native background update checks and anonymous update pings.
        update: { checkOnStart: false, auto: { enabled: false } },
        logging: { level: "error", consoleLevel: "error" },
        plugins: { enabled: true, allow: [...new Set(["cypher-tempre-poi", "browser",...bundledPlugins])], slots: { contextEngine: "cypher-tempre-poi" }, load: { paths: [plugin] }, entries: {
          browser: { enabled: true },
          "cypher-tempre-poi": { enabled: true, llm:{allowAgentIdOverride:true}, hooks: { allowConversationAccess: true, allowPromptInjection: true }, config: {
            brokerUrl: brokerUrl.href.replace(/\/$/, ""), brokerTokenEnv: "CHAINCHAT_BROKER_TOKEN",...(mediaRoot?{mediaRoot:path.resolve(mediaRoot)}:{}) } } } } };
      const controlledConfiguration = mergeControlOverlay(baseConfiguration, managedServices);
      controlledConfiguration.plugins.allow=[...new Set([...baseConfiguration.plugins.allow,...(controlledConfiguration.plugins.allow||[])])];
      const overlay = pendingOverlay || (await readControlOverlay(directory)).patch;
      const nativeSecretProjection=await nativeSecretStore.project(keySafeOverlay(controlledConfiguration, overlay));
      const configuration = nativeSecretProjection.config;
      lastConfiguration = controlledConfiguration;
      const configPath = path.join(directory, "gateway.json");
      // Native config writes stamp their own last-known-good metadata. Dropping
      // it during a managed restart makes current upstream restore an older
      // snapshot, losing settings/provider changes. Retain only that bounded
      // metadata from this exact private owned file; protected settings still
      // come exclusively from the supervisor and approved overlays above.
      try {
        const savedStat=await fs.lstat(configPath);
        if(!savedStat.isFile()||savedStat.isSymbolicLink()||savedStat.nlink>1||savedStat.size>4*1024*1024||process.platform!=='win32'&&(savedStat.mode&0o077))throw fail('Native configuration ownership changed.','OPENCLAW_CONFIG_REJECTED');
        const saved=JSON.parse(await fs.readFile(configPath,'utf8'));
        if(saved.meta&&typeof saved.meta==='object'&&!Array.isArray(saved.meta)&&Buffer.byteLength(JSON.stringify(saved.meta))<=16384)configuration.meta=structuredClone(saved.meta);
      } catch(error){if(error.code!=='ENOENT')throw error;}
      await atomicJson(configPath, configuration);
      // Avoid importing other agents' credentials, diagnostics, preload scripts,
      // proxy settings or OpenClaw configuration into this managed child.
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        !/^(OPENCLAW_|CHAINCHAT_|CT_|OTEL_|SENTRY_)/i.test(name) &&
        !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
        !/^(?:NODE_OPTIONS|NODE_INSPECT_RESUME_ON_START|(?:HTTPS?|ALL|NO)_PROXY)$/i.test(name)));
      Object.assign(environment, { OPENCLAW_STATE_DIR: runtimeState, OPENCLAW_CONFIG_PATH: configPath,
        XDG_CACHE_HOME: path.join(runtimeState, 'cache'),
        CODEX_HOME: path.join(runtimeState, 'external-codex-disabled'), CLAUDE_CONFIG_DIR: path.join(runtimeState, 'external-claude-disabled'),
        OPENCLAW_NO_RESPAWN: "1", CHAINCHAT_GATEWAY_TOKEN: gatewayToken,
        CHAINCHAT_PROVIDER_TOKEN: proxyToken, CHAINCHAT_BROKER_TOKEN: broker.token,
        NO_PROXY: "127.0.0.1,localhost,::1" });
      if (!Object.values(managedServices.channels || {}).some(channel => channel && channel.enabled !== false)) environment.OPENCLAW_SKIP_CHANNELS = '1';
      const serviceEnv = serviceEnvironmentSnapshot();
      Object.assign(environment, serviceEnv.values);
      Object.assign(environment,nativeSecretProjection.environment);
      await completeNativeUpgrade(nativeUpgrade,{environment,reprojectManagedConfiguration:async()=>{
        const info=await fs.lstat(configPath);
        if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>4*1024*1024)throw fail('Native configuration ownership changed.','MIGRATION_FAILED');
        const repaired=JSON.parse(await fs.readFile(configPath,'utf8'));
        if(repaired.meta&&typeof repaired.meta==='object'&&!Array.isArray(repaired.meta)&&Buffer.byteLength(JSON.stringify(repaired.meta))<=16384)
          configuration.meta=structuredClone(repaired.meta);
        await atomicJson(configPath,configuration);
      }});
      assertRunningAllowed(epoch);
      child = spawnImpl(nodePath, [fileURLToPath(new URL('./gateway-bootstrap.mjs', import.meta.url)), path.join(upstream, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback"],
        { cwd: directory, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32" });
      const generation = ++childGeneration;
      const stderr = child.stderr, stderrEvidence = createRuntimeStderrEvidence();
      child.on('exit', (code, signal) => {
        runtimeHealth.exited(generation, code, signal, stderrEvidence.forExit(code, signal));
        try { onDiagnostic?.(nativeLifecycleDiagnostic('exit', generation, code, signal)); } catch {}
      });
      child.on('close', (code, signal) => runtimeHealth.terminalStderr(generation, stderrEvidence.forExit(code, signal)));
      lastServiceEnvironmentHash = serviceEnv.hash;
      let spawnError = false, spawnFailure = null;
      child.on("error", error => {
        spawnError = true;
        spawnFailure = error?.code === 'ENOMEM' ? 'OPENCLAW_MEMORY_EXHAUSTED' : 'OPENCLAW_START_FAILED';
        runtimeHealth.failed(spawnFailure, generation, error?.code === 'ENOMEM' ? 'OS_ALLOCATION_FAILURE' : null);
      });
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => {
        if (stream === stderr) stderrEvidence.write(chunk);
        let line = chunk.toString("utf8");
        for (const token of [gatewayToken, proxyToken, broker.token, active?.config?.apiKey, active?.modelRouteCapability, ...privateServiceSecrets()].filter(Boolean)) line = line.split(token).join("[REDACTED]");
        onDiagnostic?.(line.slice(-8192));
      });
      const readyAt = Date.now() + startupTimeoutMs;
      while (Date.now() < readyAt) {
        assertRunningAllowed(epoch);
        if (spawnError || !child || child.exitCode !== null || child.signalCode !== null)
          throw fail("The isolated OpenClaw gateway did not start. Inspect its process and memory diagnostics.", spawnFailure || status().failureCode || 'OPENCLAW_START_FAILED');
        try {
          // The listener and model catalog bind before the pinned runtime's
          // background SQLite admission finishes. Startupz explicitly waits
          // for that admission; a catalog response alone is not agent readiness.
          const probeOptions = { headers: { authorization: `Bearer ${gatewayToken}` }, signal: AbortSignal.timeout(1500), redirect: "error" };
          const startupProbe = await fetchImpl(`http://127.0.0.1:${port}/startupz`, probeOptions);
          const startupState = startupProbe.ok ? await startupProbe.json() : null;
          if (startupState?.ok !== true || startupState.status !== "started") throw fail("Agent startup is pending.", "OPENCLAW_PENDING");
          const readiness = await fetchImpl(`http://127.0.0.1:${port}/readyz`, { ...probeOptions, signal: AbortSignal.timeout(1500) });
          if (!readiness.ok || (await readiness.json()).ready !== true) throw fail("Agent readiness is pending.", "OPENCLAW_PENDING");
          const response = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${gatewayToken}` },
            signal: AbortSignal.timeout(1500), redirect: "error" });
          if (response.ok) { const result = await response.json(); if (result.data?.some(value => value.id === "openclaw/default" || value.id === "openclaw/main")) {
            await assertEnforcementHealthy({ duringStartup: true });
            assertRunningAllowed(epoch);
            return status();
          } }
        } catch (error) {
          if (['OPENCLAW_ENFORCEMENT_UNHEALTHY', 'OPENCLAW_STOP_FAILED'].includes(error.code)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw fail("The local OpenClaw gateway did not become ready in time.", "OPENCLAW_START_TIMEOUT");
    })().catch(async error => {
      const failure = error?.code === 'ENOMEM' ? fail('The local runtime reported a memory-allocation failure.', 'OPENCLAW_MEMORY_EXHAUSTED', 503) : error;
      runtimeHealth.failed(failure?.code, undefined, error?.code === 'ENOMEM' ? 'OS_ALLOCATION_FAILURE' : null); await stopChild(); throw failure;
    }).finally(() => { startup = null; });
    return startup;
  }
  async function nativeConnectionReady({ duringStartup = false } = {}) {
    const epoch = haltEpoch;
    assertRunningAllowed(epoch);
    if (!duringStartup) await start();
    assertRunningAllowed(epoch);
    return nativeControl.ready();
  }
  async function nativeRpc(method, params, { timeoutMs = 30000 } = {}) {
    const epoch = haltEpoch;
    const client = await nativeConnectionReady();
    assertRunningAllowed(epoch);
    return client.request(method, params, { timeoutMs });
  }
  const subscribeNativeEvents = listener => {
    if (typeof listener !== 'function') throw new TypeError('A private native event listener is required.');
    nativeEvents.add(listener); return () => nativeEvents.delete(listener);
  };
  const services = createPrivateNativeServices({ rpc: nativeRpc, subscribe: subscribeNativeEvents, nodePath });
  const controls = createNativeControls({
    nativeToolSurface:sessionKey=>nativeRpc('cypher-tempre.native.toolCatalogue',sessionKey?{sessionKey}:{}),
    nativeModelView:nativeModels,
    rpc: nativeRpc, getRuntime: status, readOverlay: () => readControlOverlay(directory),
    nativeCapabilities,
    nativeProvider:()=>Boolean(nativeSelection),
    sanitize: value => redactNativeControl(value, [gatewayToken, proxyToken, broker.token, identity?.proxyToken, identity?.gatewayToken,
      ...privateServiceSecrets()]),
    async runSystemCommand({ sessionKey, command }) {
      if (active) throw fail('Wait for the current model run before changing native session controls.', 'OPENCLAW_CONTROL_BUSY', 409);
      if (!/^\/(?:queue|context|usage)(?:\s|$)/.test(command)) throw fail('This native command is not admitted.', 'OPENCLAW_COMMAND_GUARDED', 403);
      if (typeof broker.registerControlInvocation !== 'function' || typeof broker.assertControlResult !== 'function' || typeof broker.readControlResult !== 'function')
        throw fail('The native deterministic command adapter is unavailable.', 'OPENCLAW_COMMAND_GUARDED', 403);
      const selected = await nativeRpc('sessions.describe', { key: sessionKey, includeDerivedTitles: false, includeLastMessage: false });
      if (!selected.session) await nativeRpc('sessions.patch', { key: sessionKey, model: 'chainchat-compatible/route' });
      const runId = randomUUID(), claim = await broker.registerControlInvocation({ sessionKey, runId, command });
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
      try {
        await nativeTurn({ sessionKey, message: command, idempotencyKey: runId, deliver: false }, controller, { allowEmptyFinal: true });
        // Native pure commands may intentionally omit their terminal message.
        // Their delivery hook still supplies an exact privately attested reply.
        const result = await broker.readControlResult({ claimId: claim.claimId });
        if (!result.text.trim() || result.text.trim() === 'NO_REPLY') throw fail('The native command did not return a deterministic result.', 'OPENCLAW_COMMAND_HELD');
        await broker.assertControlResult({ claimId: claim.claimId, candidate: result.text });
        return result;
      } finally { clearTimeout(timer); await broker.finishControlInvocation?.({ claimId: claim.claimId }); }
    },
    async saveOverlay(patch, revision) {
      const current = await readControlOverlay(directory);
      if (current.revision !== revision) throw fail('Settings changed. Refresh before saving.', 'OPENCLAW_CONFIG_STALE', 409);
      const next = { version: 1, patch, revision: createHash('sha256').update(JSON.stringify(patch)).digest('hex') };
      await atomicJson(path.join(directory, 'controls.json'), next); return next;
    },
    async applyOverlay(patch) {
      if (active) throw fail('Wait for the current model run before applying settings.', 'OPENCLAW_CONTROL_BUSY', 409);
      validateControlPatch(Object.keys(patch).length ? patch : { ui: {} }, { allowHostConfiguration: true,
        nativeCapabilities: {enabled:true,acknowledged:true,settings:['*']},nativeProvider:true });
      const current = await nativeRpc('config.get', {});
      // Native config.set performs the pinned runtime's own full schema and
      // secret-reference validation before writing its managed config file.
      const base = lastConfiguration;
      const previous = (await readControlOverlay(directory)).patch;
      pendingOverlay = patch;
      try {
        const utility = patch.agents?.defaults?.utilityModel;
        if (utility) {
          if (!nativeModelRef(utility)) throw nativeKeyRequired();
          await assertNativeKeyRoute(utility);
        }
        if (patch.memory?.search?.enabled && patch.memory.search.provider !== 'local')
          throw fail('Managed native memory search requires local embeddings.', 'OPENCLAW_SETTING_GUARDED', 403);
        const proposed = keySafeOverlay(base, patch);
        await nativeRpc('config.set', { raw: JSON.stringify(proposed), baseHash: current.hash });
        await stopChild(); await start();
      } catch (error) {
        const safe = redactNativeControl({ code: error?.code || 'OPENCLAW_CONFIG_APPLY_FAILED', message: String(error?.message || 'Native configuration apply failed.') },
          [gatewayToken, proxyToken, broker.token, active?.config?.apiKey, ...privateServiceSecrets()].filter(Boolean));
        onDiagnostic?.(`[chainchat] native settings apply held ${JSON.stringify(safe)}\n`);
        pendingOverlay = previous;
        await stopChild(); await start().catch(() => {});
        throw fail('OpenClaw did not apply the settings; the previous managed settings were restored.', 'OPENCLAW_CONFIG_REJECTED', 422);
      } finally { pendingOverlay = null; }
    },
  });
  function serializedControl(callback) {
    const epoch = haltEpoch;
    try { assertRunningAllowed(epoch); } catch (error) { return Promise.reject(error); }
    const operation = queue.then(() => { assertRunningAllowed(epoch); return callback(); });
    queue = operation.catch(() => {});
    return operation;
  }
  function validatedManagedServices(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => !['browser', 'cron', 'channels', 'plugins'].includes(key)) || Buffer.byteLength(JSON.stringify(patch)) > 256 * 1024)
      throw fail('Invalid private native service configuration.', 'OPENCLAW_SERVICE_DENIED', 403);
    for (const value of Object.values(patch)) if (!value || typeof value !== 'object' || Array.isArray(value))
      throw fail('Native service sections must be objects.', 'OPENCLAW_SERVICE_DENIED', 403);
    if (patch.cron && (Object.keys(patch.cron).some(key => key !== 'enabled') || typeof patch.cron.enabled !== 'boolean'))
      throw fail('Only managed scheduler activation is admitted.', 'OPENCLAW_SERVICE_DENIED', 403);
    if (patch.plugins && (patch.plugins.enabled === false ||
        Object.hasOwn(patch.plugins, 'slots') && (!patch.plugins.slots || Array.isArray(patch.plugins.slots) ||
          Object.hasOwn(patch.plugins.slots, 'contextEngine') && patch.plugins.slots.contextEngine !== 'cypher-tempre-poi') ||
        Object.hasOwn(patch.plugins, 'entries') && (!patch.plugins.entries || Array.isArray(patch.plugins.entries) || Object.hasOwn(patch.plugins.entries, 'cypher-tempre-poi') ||
          Object.hasOwn(patch.plugins.entries, 'browser') && patch.plugins.entries.browser?.enabled !== true) ||
        Object.hasOwn(patch.plugins, 'allow') && (!Array.isArray(patch.plugins.allow) || !['cypher-tempre-poi', 'browser'].every(id => patch.plugins.allow.includes(id))) ||
        Object.hasOwn(patch.plugins, 'deny') && (!Array.isArray(patch.plugins.deny) || ['cypher-tempre-poi', 'browser'].some(id => patch.plugins.deny.includes(id))) ||
        Object.hasOwn(patch.plugins, 'load') && (!patch.plugins.load || !Array.isArray(patch.plugins.load.paths) || !patch.plugins.load.paths.map(value => path.resolve(value)).includes(plugin))))
      throw fail('Managed services cannot replace mandatory PoI enforcement.', 'OPENCLAW_SERVICE_DENIED', 403);
    return structuredClone(patch);
  }
  async function applyManagedServices(patch, { forceReload = false, replaceChannelAccount } = {}) {
    if (typeof forceReload !== 'boolean') throw fail('Invalid private native service reload option.', 'OPENCLAW_SERVICE_DENIED', 403);
    if (active) throw fail('Wait for the current model run before changing native services.', 'OPENCLAW_CONTROL_BUSY', 409);
    const previous = managedServices, validated = validatedManagedServices(patch);
    let seed = previous;
    if (replaceChannelAccount !== undefined) {
      const selection = replaceChannelAccount, validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) &&
        !['__proto__', 'constructor', 'prototype'].includes(value);
      if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
          Object.keys(selection).length !== 2 || Object.keys(selection).some(key => !['channelId', 'accountId'].includes(key)) ||
          !validId(selection.channelId) || !validId(selection.accountId) ||
          !Object.hasOwn(validated.channels || {}, selection.channelId) ||
          !Object.hasOwn(validated.channels[selection.channelId]?.accounts || {}, selection.accountId))
        throw fail('An exact private native channel account replacement is required.', 'OPENCLAW_SERVICE_DENIED', 403);
      seed = structuredClone(previous);
      if (seed.channels?.[selection.channelId]?.accounts) delete seed.channels[selection.channelId].accounts[selection.accountId];
    }
    const next = mergeControlOverlay(seed, validated);
    if (!forceReload && JSON.stringify(previous) === JSON.stringify(next) && lastServiceEnvironmentHash === serviceEnvironmentSnapshot().hash) return status();
    managedServices = next;
    // A private service may be staged before the first start. Avoid starting a
    // Gateway only to stop it immediately once its owned browser lease exists.
    if (!child && !startup && !proxy) return status();
    try { await stopChild(); await start(); return status(); }
    catch (error) { managedServices = previous; await stopChild(); await start().catch(() => {}); throw error; }
  }
  async function initializeNativeProviders() {
    if (nativeProvidersLoaded) return;
    try {
      const file = path.join(directory, 'native-providers.json'), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1024 * 1024 || process.platform !== 'win32' && stat.mode & 0o077)
        throw fail('Native provider configuration requires private local inspection.', 'OPENCLAW_CONFIG_REJECTED');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.version !== 1 || value.model !== null && !nativeModelRef(value.model) || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers))
        throw fail('The saved native provider selection is invalid.', 'OPENCLAW_CONFIG_REJECTED');
      for (const [id, config] of Object.entries(value.providers)) {
        if (isRemovedNativeProvider(id) || ['oauth','token'].includes(config?.auth)) continue;
        const {apiKey:profileId,...metadata}=config;
        validateNativeProviderEntry(id,metadata);
        if(profileId !== undefined && (typeof profileId!=='string' || value.auth?.profiles?.[profileId]?.provider !== id || value.auth.profiles[profileId].mode !== 'api_key'))
          throw fail('A saved native credential reference is invalid.','OPENCLAW_CONFIG_REJECTED');
        nativeProviders[id]=config;
      }
      nativeSelection = isRemovedNativeModel(value.model) ? null : value.model;
      nativeAuthConfiguration = value.auth && typeof value.auth === 'object' && !Array.isArray(value.auth) ? value.auth : {};
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    nativeProvidersLoaded = true;
  }
  async function inspectNativeSource(source) {
    const roster=await nativeRpc('agents.list',{});
    if(!Array.isArray(roster.agents)||!roster.agents.some(agent=>agent.id===source.agentId))return false;
    const current=await nativeRpc('config.get',{}),config=current.config||{};
    if(source.kind==='channel') {
      const channel=config.channels?.[source.channelId];
      return !!(channel&&channel.enabled!==false&&(channel.accounts?channel.accounts[source.accountId]&&channel.accounts[source.accountId].enabled!==false:source.accountId===(channel.defaultAccount||'default')));
    }
    if(source.kind==='heartbeat') {
      const row=(Array.isArray(config.agents?.list)?config.agents.list:Array.isArray(config.agents?.entries)?config.agents.entries:[]).find(agent=>agent.id===source.agentId);
      if(!(row?.heartbeat||config.agents?.defaults?.heartbeat))return false;
      try{return !!await readNativeHeartbeatMonitor(nativeRpc,source.agentId);}catch{return false;}
    }
    if(source.kind==='background') {
      const selected=await nativeRpc('sessions.describe',{key:source.nativeSessionKey,includeDerivedTitles:false,includeLastMessage:false});
      return !!selected.session?.sessionId&&source.nativeSessionKey.startsWith('agent:'+source.agentId+':');
    }
    return false;
  }
  const heartbeatScratch=createNativeHeartbeatScratch({rpc:nativeRpc,listSources:ownerKey=>runBindings.list(ownerKey),inspectSource:inspectNativeSource,assertIsolation:checkServiceIsolation});
  async function nativeSources(input={}) {
    const {identity:nativeIdentity,action='list',source,id,content,expectedRevision}=input;
    const allowed=action==='scratch-get'?['identity','action','id']:action==='scratch-set'?['identity','action','id','content','expectedRevision']:action==='enroll'?['identity','action','source']:action==='revoke'?['identity','action','id']:['identity','action'];
    if(Object.keys(input).some(key=>!allowed.includes(key)))throw fail('Invalid native source action.','OPENCLAW_NATIVE_BINDING_REQUIRED',400);
    controlSessionKey(nativeIdentity);const ownerKey=nativeIdentity.agentId+':'+nativeIdentity.genesisHash.toLowerCase();
    await start();
    const result=async()=>({sources:await runBindings.list(ownerKey),available:await nativeSourceOptions()});
    if(action==='list')return result();
    if(action==='scratch-get')return heartbeatScratch({ownerKey,id,action});
    if(action==='revoke'&&typeof id==='string'&&/^[a-f0-9]{64}$/u.test(id)){await runBindings.revoke(ownerKey,id);for(const row of dynamicRows)if(row.binding?.sourceId===id&&row.binding.ownerKey===ownerKey)row.abortNative();return result();}
    const grant=await nativeCapabilities(nativeIdentity);
    if(grant?.enabled!==true||grant.acknowledged!==true||grant.backgroundRuns!==true)throw fail('Native background source enrollment requires an explicit owner capability grant.','OPENCLAW_NATIVE_BINDING_REQUIRED',403);
    if(action==='scratch-set')return heartbeatScratch({ownerKey,id,action,content,expectedRevision,canWrite:true});
    if(action==='enroll'){
      if(!source||Object.keys(source).some(key=>!['kind','agentId','channelId','accountId','nativeSessionKey'].includes(key)))throw fail('Invalid native source enrollment.','OPENCLAW_NATIVE_BINDING_REQUIRED',400);
      await runBindings.enroll({...source,ownerKey});
    }else throw fail('Invalid native source enrollment.','OPENCLAW_NATIVE_BINDING_REQUIRED',400);
    return{...await result(),notice:'Only this explicitly enrolled native source may start independently reviewed runs. Its owner capabilities and chain state are rechecked each time.'};
  }
  async function nativeSourceOptions() {
    const results=await Promise.allSettled([nativeRpc('agents.list',{}),nativeRpc('config.get',{}),nativeRpc('sessions.list',{limit:200,rowMode:'compact',configuredAgentsOnly:true,includeGlobal:false,includeUnknown:false,includeDerivedTitles:false,includeLastMessage:false})]);
    const roster=results[0].status==='fulfilled'?results[0].value:{},config=results[1].status==='fulfilled'?results[1].value.config||{}:{},nativeSessions=results[2].status==='fulfilled'?results[2].value:{};
    const valid=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\0\r\n]/u.test(value);
    const agents=(Array.isArray(roster.agents)?roster.agents:[]).slice(0,256).filter(row=>valid(row.id)&&row.id.length<=128).map(row=>{
      const entry=(Array.isArray(config.agents?.list)?config.agents.list:Array.isArray(config.agents?.entries)?config.agents.entries:[]).find(agent=>agent.id===row.id);
      return{id:row.id,...(valid(row.name)?{name:row.name.slice(0,256)}:{}),heartbeat:Boolean(entry?.heartbeat||config.agents?.defaults?.heartbeat)};
    });
    const channels=[];
    for(const[channelId,entry]of Object.entries(config.channels||{})){if(!valid(channelId)||channelId.length>128||!entry||entry.enabled===false||typeof entry!=='object')continue;
      for(const[accountId,account]of Object.entries(entry.accounts||{[entry.defaultAccount||'default']:entry})){if(valid(accountId)&&accountId.length<=128&&account&&account.enabled!==false)channels.push({channelId,accountId});if(channels.length>=1024)break;}
      if(channels.length>=1024)break;
    }
    const sessions=(Array.isArray(nativeSessions.sessions)?nativeSessions.sessions:[]).slice(0,200).filter(row=>valid(row.key)).flatMap(row=>{
      const agentId=valid(row.agentId)?row.agentId:/^agent:([^:]+):/u.exec(row.key)?.[1];if(!agents.some(agent=>agent.id===agentId))return[];
      return[{key:row.key,agentId,...(valid(row.label)?{label:row.label.slice(0,256)}:{})}];
    });
    const available={agents,channels,sessions};checkServiceIsolation(available);return available;
  }
  async function saveNativeProviders() {
    await fs.mkdir(directory, {recursive:true,mode:0o700});
    await atomicJson(path.join(directory, 'native-providers.json'), {version:1,model:nativeSelection,providers:nativeProviders,auth:nativeAuthConfiguration});
  }
  function keyAuthConfiguration(auth) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return {};
    const profiles = Object.fromEntries(Object.entries(auth.profiles || {}).filter(([, row]) => row?.mode === 'api_key' && !isRemovedNativeProvider(row.provider)));
    const order = Object.fromEntries(Object.entries(auth.order || {}).filter(([, rows]) => Array.isArray(rows))
      .map(([provider, rows]) => [provider, rows.filter(id => Object.hasOwn(profiles, id))]).filter(([, rows]) => rows.length));
    return {...auth, profiles, ...(Object.keys(order).length || auth.order ? {order} : {})};
  }
  function keySafeOverlay(base, patch) {
    const merged = mergeControlOverlay(base, patch);
    const retained = Object.values(nativeAuthConfiguration.profiles || {}).filter(row => row?.mode !== 'api_key');
    const defaults = merged.agents?.defaults;
    const utility = defaults?.utilityModel;
    if (utility && (!nativeModelRef(utility) || retained.some(row => typeof row?.provider === 'string' && row.provider.toLowerCase() === utility.split('/')[0].toLowerCase())))
      defaults.utilityModel = '';
    const search = merged.memory?.search;
    if (search?.enabled) {
      if (search.provider !== 'local') search.enabled = false;
      else search.fallback = 'none';
    }
    return merged;
  }
  async function readNativeKeyStatus(agentId = 'main') {
    try { return nativeApiKeyStatus(await nativeRpc('models.authStatus', {agentId})); }
    catch { throw nativeAuthFailed(); }
  }
  async function assertNativeKeyRoute(model, sessionKey) {
    const provider = model.split('/')[0].toLowerCase();
    if (isRemovedNativeProvider(provider)) throw nativeKeyRequired();
    const agentId = /^agent:([A-Za-z0-9_-]{1,64}):/u.exec(sessionKey || '')?.[1] || 'main';
    if ((await readNativeKeyStatus(agentId)).disabledProviders.has(provider)) throw nativeKeyRequired();
  }
  async function assertNativeMediaKeyRoute() {
    if ((await readNativeKeyStatus()).disabledProviders.size) throw nativeKeyRequired();
  }
  async function nativeModels(nativeIdentity) {
    if (nativeIdentity?.agentId) {
      const key=controlSessionKey(nativeIdentity);
      if(nativeIdentityKeys.size>=4096&&!nativeIdentityKeys.has(key))throw fail('Native identity capacity exceeded.','OPENCLAW_NATIVE_BINDING_REQUIRED',409);
      nativeIdentityKeys.add(key);
    }
    await start();
    const {disabledProviders} = await readNativeKeyStatus();
    const result = await nativeRpc('models.list', {agentId:'main', includeDetails:true, includeDefaultModels:true, view:'all',preparedOnly:true}, {timeoutMs:120000});
    checkServiceIsolation(result);
    const current = nativeSelection && !disabledProviders.has(nativeSelection.split('/')[0].toLowerCase()) ? nativeSelection : '';
    return nativeModelCatalogue({...result, models:result.models?.filter(row => !disabledProviders.has(row?.provider?.toLowerCase()))}, current);
  }
  async function setNativeModel(nativeIdentity, id) {
    if (active) throw fail('Wait for the active turn before changing the native default.', 'OPENCLAW_CONTROL_BUSY', 409);
    const selected = requireNativeModel(await nativeModels(nativeIdentity), id), previous = nativeSelection;
    if (nativeSelection === id) return {provider:'native',tier:'native',model:id,...selected};
    nativeSelection = id;
    try { await saveNativeProviders(); await stopChild(); await start(); }
    catch (error) { nativeSelection = previous; await saveNativeProviders(); await stopChild(); await start().catch(()=>{}); throw error; }
    return {provider:'native',tier:'native',model:id,...selected};
  }
  async function nativeSecrets({identity:nativeIdentity,action='list',...input}={}) {
    if(nativeIdentity?.agentId)controlSessionKey(nativeIdentity);
    const keys=Object.keys(input);
    if(!['list','set','remove'].includes(action)||keys.some(key=>!(action==='set'?['name','target','value']:action==='remove'?['name']:[]).includes(key)))
      throw fail('Select a dedicated native secret action.','OPENCLAW_NATIVE_SECRET_INVALID',400);
    if(action!=='list'&&active)throw fail('Wait for the active turn before changing native credentials.','OPENCLAW_CONTROL_BUSY',409);
    if(typeof input.value==='string'&&input.value.length)nativeCredentialValues.add(input.value);
    await start();
    const config=mergeControlOverlay(lastConfiguration,(await readControlOverlay(directory)).patch);
    if(action==='list')return nativeSecretStore.list(config);
    const result=action==='set'?await nativeSecretStore.set(input,config):await nativeSecretStore.remove(input.name,config);
    for(const row of [...dynamicRows])await row.release();
    await stopChild();await start();
    return result;
  }
  async function configureNativeProvider({identity:nativeIdentity, provider, configuration} = {}) {
    if (nativeIdentity?.agentId) controlSessionKey(nativeIdentity);
    if (active) throw fail('Wait for the active turn before changing native providers.', 'OPENCLAW_CONTROL_BUSY', 409);
    const checked = validateNativeProviderEntry(provider, configuration), previous = nativeProviders;
    checkServiceIsolation(checked); await start();
    const current = await nativeRpc('config.get', {});
    const proposed = keySafeOverlay(lastConfiguration, (await readControlOverlay(directory)).patch);
    proposed.models.providers = {...proposed.models.providers,[provider]:checked};
    // Upstream performs its full native API, endpoint and model schema checks.
    // No caller can replace the Gateway, enforcement plugin or private routes.
    await nativeRpc('config.set', {raw:JSON.stringify(proposed),baseHash:current.hash});
    nativeProviders = {...nativeProviders,[provider]:checked};
    try { await saveNativeProviders(); await stopChild(); await start(); }
    catch (error) { nativeProviders = previous; await saveNativeProviders(); await stopChild(); await start().catch(()=>{}); throw error; }
    return {ok:true,provider,notice:'Native credentials are configured separately and remain in the local OpenClaw credential store.'};
  }
  async function nativeAuth({identity:nativeIdentity, action='status', ...input} = {}) {
    const bounded = (value, limit=512) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\0\r\n]/u.test(value);
    const only = keys => Object.keys(input).every(key => keys.includes(key));
    const validProvider = bounded(input.provider,64) && /^[a-z0-9][a-z0-9_-]*$/u.test(input.provider) &&
      !input.provider.startsWith('chainchat-') && !isRemovedNativeProvider(input.provider);
    let method, params;
    if (action === 'status' && only([])) {
      if (nativeIdentity?.agentId) controlSessionKey(nativeIdentity);
      return redactNativeControl((await readNativeKeyStatus()).publicStatus, privateServiceSecrets());
    }
    if (action === 'key' && only(['provider','apiKey']) && validProvider && bounded(input.apiKey,16384) &&
        !isRetiredProviderCredential(input.apiKey) && !isUnsupportedModelCredential(input.apiKey)) {
      method='models.authSetApiKey'; params={agentId:'main',provider:input.provider,apiKey:input.apiKey};
    } else if (action === 'logout' && only(['provider','profileIds']) && validProvider && (input.profileIds === undefined ||
        Array.isArray(input.profileIds) && input.profileIds.length > 0 && input.profileIds.length <= 64 && input.profileIds.every(value=>bounded(value)))) {
      method='models.authLogout'; params={agentId:'main',provider:input.provider,...(input.profileIds ? {profileIds:input.profileIds} : {credentialType:'api_key'})};
    } else throw fail('Use the native provider API-key controls.', 'OPENCLAW_NATIVE_AUTH_INVALID', 400);
    if (nativeIdentity?.agentId) controlSessionKey(nativeIdentity);
    await start();
    if (active) throw fail('Wait for the active turn before changing native authentication.', 'OPENCLAW_CONTROL_BUSY', 409);
    if (action === 'key') {
      if (nativeCredentialValues.size >= 256) throw fail('Restart before adding more native credentials.', 'OPENCLAW_NATIVE_AUTH_FAILED', 409);
      nativeCredentialValues.add(input.apiKey);
    } else if (input.profileIds) {
      const {publicStatus} = await readNativeKeyStatus();
      const profiles = publicStatus.providers.find(row => row.provider === input.provider)?.profiles || [];
      if (input.profileIds.some(id => !profiles.some(row => row.profileId === id && row.logoutSupported)))
        throw fail('Select a saved native API key to remove.', 'OPENCLAW_NATIVE_AUTH_INVALID', 400);
    }
    let result;
    try { result = await nativeRpc(method, params, {timeoutMs:120000}); }
    catch { throw nativeAuthFailed(); }
    const current = await nativeRpc('config.get', {});
    // Store key metadata only. OpenClaw owns the credential values on disk.
    const previousProfiles = Object.fromEntries(Object.entries(nativeAuthConfiguration.profiles || {}).filter(([, row]) => row?.mode !== 'api_key'));
    const keyAuth = keyAuthConfiguration(current.config?.auth);
    nativeAuthConfiguration = {...keyAuth, profiles:{...previousProfiles, ...keyAuth.profiles}};
    if(action==='key' && typeof result?.profileId==='string' && nativeProviders[input.provider]) {
      if(nativeAuthConfiguration.profiles?.[result.profileId]?.provider!==input.provider) throw nativeAuthFailed();
      nativeProviders={...nativeProviders,[input.provider]:{...nativeProviders[input.provider],apiKey:result.profileId}};
    }
    if(action==='logout') {
      nativeProviders=Object.fromEntries(Object.entries(nativeProviders).map(([id,config])=>{
        if(config.apiKey && !nativeAuthConfiguration.profiles?.[config.apiKey]) {const {apiKey,...metadata}=config;return[id,metadata];}
        return[id,config];
      }));
    }
    await saveNativeProviders();
    return redactNativeControl(result, privateServiceSecrets());
  }
  async function utilitySession(nativeIdentity,requestedSessionKey,signal) {
    const selectedSessionKey = controlSessionKey(nativeIdentity), sessionKey = requestedSessionKey || selectedSessionKey;
    if(sessionKey === selectedSessionKey && !nativeIdentityKeys.has(selectedSessionKey))
      throw fail('No owner-bound native identity admits this completion.','OPENCLAW_NATIVE_BINDING_REQUIRED',403);
    if(sessionKey !== selectedSessionKey) {
      const bound=dynamicInvocations.get(sessionKey)?.context?.nativeIdentity;
      if(!bound||bound.agentId!==nativeIdentity.agentId||bound.genesisHash!==nativeIdentity.genesisHash)
        throw fail('No private native session binding admits this completion.','OPENCLAW_NATIVE_BINDING_REQUIRED',403);
    }
    checkSignal(signal); await start(); await assertEnforcementHealthy();
    if(sessionKey===selectedSessionKey) {
      const selected=await nativeRpc('sessions.describe',{key:sessionKey,includeDerivedTitles:false,includeLastMessage:false});
      if(!selected.session?.sessionId){
        if(!nativeSelection)throw fail('Choose a native main model before internal review.','OPENCLAW_NATIVE_MODEL_INVALID',409);
        // Upstream's session-scoped extension requires a real owned session.
        // This creates only native control metadata for an already registered
        // verified identity, never model inference or a Timechain block.
        await nativeRpc('sessions.patch',{key:sessionKey,model:nativeSelection});
      }
    }
    return sessionKey;
  }
  async function completeNative({identity:nativeIdentity,sessionKey:requestedSessionKey,system,messages,maxTokens=4096,purpose,signal} = {}) {
    const sessionKey=await utilitySession(nativeIdentity,requestedSessionKey,signal);
    if (!nativeSelection) throw nativeKeyRequired();
    await assertNativeKeyRoute(nativeSelection);
    const payload = {sessionKey,system,messages,maxTokens,purpose}; checkServiceIsolation(payload);
    // Deliberately not serialized behind generation: finalize() awaits this
    // tool-free semantic review while that same admitted generation is active.
    let result;
    try { result = await nativeRpc('cypher-tempre.native.complete', payload, {timeoutMs:requestTimeoutMs}); }
    catch (error) { const code = error?.details?.code || error?.gatewayCode || error?.code; throw fail('The native utility model did not complete an admissible review.', /^[A-Z_]+$/u.test(code || '') ? code : 'PROVIDER_INVALID_RESPONSE'); }
    checkSignal(signal); checkServiceIsolation(result);
    if (result?.sessionKey !== sessionKey || typeof result.text !== 'string' || !result.text.trim() || result.stopReason !== 'stop' || result.reviewerSelection !== 'owner-configured-main-default')
      throw fail('The native utility completion is invalid.', 'PROVIDER_INVALID_RESPONSE');
    return result;
  }
  async function analyzeNativeMedia({identity:nativeIdentity,sessionKey:requestedSessionKey,assetId,operation,signal}={}) {
    if(!mediaRoot||typeof assetId!=='string'||!/^[a-f0-9]{64}$/u.test(assetId)||!['describe-image','describe-video','transcribe-audio'].includes(operation))
      throw fail('Choose an owned native media asset and supported operation.','NATIVE_MEDIA_INVALID',400);
    const sessionKey=await utilitySession(nativeIdentity,requestedSessionKey,signal);
    await assertNativeMediaKeyRoute();
    let result;
    try{result=await nativeRpc('cypher-tempre.native.media',{sessionKey,assetId,operation},{timeoutMs:requestTimeoutMs});}
    catch(error){const code=error?.gatewayCode||error?.code;throw fail('The native media analysis was held.',/^[A-Z_]+$/u.test(code||'')?code:'NATIVE_MEDIA_FAILED');}
    checkSignal(signal);checkServiceIsolation(result);
    if(result?.assetId!==assetId||result.sha256!==assetId||result.operation!==operation||result.source!=='native-media-sdk'||result.modelDerived!==true||
      typeof result.text!=='string'||Buffer.byteLength(result.text)>64*1024||result.textSha256!==createHash('sha256').update(result.text,'utf8').digest('hex'))
      throw fail('The native media observation is invalid.','NATIVE_MEDIA_FAILED');
    return result;
  }
  function generateNative(config, args, context) {
    const checked = validateNativeProvider(config);
    return generate(checked,args,{...context,nativeProvider:true});
  }
  async function admitDynamic(request) {
    if (closed || suspended || typeof resolveNativeOwner !== 'function') return null;
    const existing=dynamicInvocations.get(request.sessionKey);
    if(existing&&!existing.ended)return existing.claim;
    if (pendingDynamic.has(request.sessionKey)) return pendingDynamic.get(request.sessionKey);
    const pending = (async()=>{
      const binding = await runBindings.resolve(request);
      if (!binding) return null;
      if(!nativeSourcesReady){
        let timer;
        try{const ready=await Promise.race([nativeReadiness,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),60000);})]);if(!ready||closed)throw fail('Native owner initialization did not finish; this source remains held.','OPENCLAW_NATIVE_NOT_READY',503);}
        finally{clearTimeout(timer);}
      }
      const input = typeof request.input === 'string' && request.input.trim() && Buffer.byteLength(request.input)<=1024*1024 ? request.input : null;
      // Context-engine requests have no user body. They can reuse an already
      // admitted native hook claim, but cannot invent a fresh job input.
      if (!input) return null;
      const owner = await resolveNativeOwner({...binding,input});
      if (!owner?.context || !owner.config) return null;
      let browserInvocation, claim;
      try {
        assertRunningAllowed();
        await owner.context.authorize?.();
        const config = owner.config.provider === 'native' ? validateNativeProvider(owner.config) : validateProvider(owner.config);
        if (config.provider === 'native') await assertNativeKeyRoute(config.model, request.sessionKey);
        const controller = new AbortController(), capability = config.provider === 'native' ? undefined : secret();
        const invocationId = randomUUID(), sessionKey = request.sessionKey;
        const abortNative=()=>{controller.abort();if(!closed&&!suspended)void nativeRpc('chat.abort',{sessionKey,...(!request.runId?.startsWith('context-assembly:')?{runId:request.runId}:{})}).catch(()=>{});};
        const args = {messages:[{role:'user',content:input}],maxTokens:Math.min(config.maxOutputTokens || 4096,32768)};
        const context = {...owner.context,nativeProvider:config.provider==='native',modelRouteCapability:capability,expectedNativeRunId:request.runId,
          signal:controller.signal,assertContentIsolation:checkServiceIsolation,
          assertNativeModel:provider=>assertNativeKeyRoute(provider,sessionKey), assertNativeMediaKeyRoute,
          ...(binding.sourceId?{nativeSourceId:binding.sourceId}:{}),
          ...(binding.mediaTask?{mediaTask:binding.mediaTask,mediaTaskStatus:binding.mediaTaskStatus,mediaTaskReferences:binding.mediaTaskReferences,mediaTaskProof:binding.mediaTaskProof,
            verifyMediaTask:(proof,expected)=>runBindings.verifyMediaTask(proof,expected)}:{}),
          authorize:async()=>{
            await owner.context.authorize?.();checkSignal(controller.signal);
            // This is a private freshness check, not a new run admission. The
            // broker separately binds the exact native run and old final hash.
            const current=await runBindings.resolve({...request,runId:undefined},{waitMs:0});
            if(!current||['ownerKey','nativeSessionKey','kind','chainKey','sourceId','jobId','parentSessionKey'].some(key=>current[key]!==binding[key]))
              throw fail('The native source or creation ownership was revoked.','OPENCLAW_NATIVE_BINDING_REQUIRED',403);
          },
          toolProtectedRoots:[...new Set([directory,upstream,plugin,...(owner.context.toolProtectedRoots||[])])]};
        if(browserService?.prepareInvocation) {
          const inspectNativeTarget=createNativeBrowserInspector({rpc:nativeRpc,assertIsolation:checkServiceIsolation,assertCurrent:async()=>{
            const current=dynamicInvocations.get(sessionKey);
            if(current?.context!==context||controller.signal.aborted)throw fail('The native browser invocation expired.','OPENCLAW_BROWSER_INSPECTION_DENIED',403);
            await context.authorize?.();
          }});
          browserInvocation=await browserService.prepareInvocation({...context,inspectNativeTarget});
          if(browserInvocation)context.browserInvocation=browserInvocation;
        }
        claim=await broker.registerInvocation({config,args,context,sessionKey,invocationId});
        if(!claim?.claimId)throw fail('The native child was not admitted.','OPENCLAW_ADMISSION_FAILED',422);
        const row={config,args,context,controller,sessionKey,claimId:claim.claimId,claim,binding,abortNative,modelRouteCapability:capability,openCodeSession:randomUUID(),
          release:async()=>{if(row.released)return;row.released=true;clearTimeout(row.timer);owner.context.signal?.removeEventListener('abort',abortNative);if(!row.ended)abortNative();else controller.abort();if(capability)routeInvocations.delete(capability);if(dynamicInvocations.get(sessionKey)===row)dynamicInvocations.delete(sessionKey);dynamicRows.delete(row);await broker.finishInvocation?.({claimId:claim.claimId});await browserInvocation?.releaseInvocation?.();await owner.release?.();}};
        row.timer=setTimeout(()=>{void row.release();},15*60*1000);row.timer.unref?.();
        dynamicInvocations.set(sessionKey,row);dynamicRows.add(row);if(capability)routeInvocations.set(capability,row);
        owner.context.signal?.addEventListener('abort',abortNative,{once:true});
        if(owner.context.signal?.aborted)abortNative();
        return claim;
      } catch(error) {if(claim)await broker.finishInvocation?.({claimId:claim.claimId});await browserInvocation?.releaseInvocation?.();await owner.release?.();throw error;}
    })();pendingDynamic.set(request.sessionKey,pending);
    try{return await pending;}finally{pendingDynamic.delete(request.sessionKey);}
  }
  broker.setNativeLifecycle?.({
    modelRoute:async request=>{
      if(closed||suspended||typeof resolveNativeModelRoute!=='function')return null;
      const ownerKey=await runBindings.modelRouteOwner(request);if(!ownerKey)return null;
      if(!nativeSourcesReady){let timer;try{const ready=await Promise.race([nativeReadiness,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),60000);})]);if(!ready||closed)return null;}finally{clearTimeout(timer);}}
      const owner=await resolveNativeModelRoute({ownerKey});if(!owner?.config||typeof owner.authorize!=='function')return null;
      await owner.authorize();if(closed||suspended)return null;
      const route=modelRouteForConfig(owner.config);await owner.authorize();return route;
    },
    normalizeOutput:async(candidate)=>{
      const sdk=await import(pathToFileURL(path.join(upstream,'dist/plugin-sdk/channel-outbound.js')).href);
      return sdk.projectOutboundPayloadPlanForDelivery(sdk.createOutboundPayloadPlan([{text:candidate}]));
    },
    admit:admitDynamic,
    toolAdmitted:async(claim,tool)=>{
      const input={ownerKey:claim.context.nativeOwnerKey,parentSessionKey:claim.sessionKey,parentRunId:claim.runId,tool,capabilities:claim.toolAuthority.nativeCapabilities,sourceId:claim.context.nativeSourceId};
      await runBindings.permitMedia?.(input,{assertCurrent:()=>claim.context.authorize?.()});
      runBindings.permit(input);
    },
    toolObserved:async(claim,tool,outcome)=>runBindings.observed({parentSessionKey:claim.sessionKey,tool,outcome}),
    spawned:request=>runBindings.spawned(request.nativeSpawn || request),
    verifyMediaTask:(proof,expected)=>runBindings.verifyMediaTask(proof,expected),
    canResumeSession:async(request,previous)=>{
      const binding=await runBindings.resolve(request,{waitMs:0});
      return binding?.kind==='media-completion'&&binding.ownerKey===previous.ownerKey&&binding.nativeSessionKey===previous.sessionKey&&
        request.runId!==previous.runId&&!!binding.mediaTaskProof;
    },
    ended:async claim=>{const row=dynamicInvocations.get(claim.sessionKey);if(row&&row.claimId===claim.claimId){
      if(row.binding.kind==='media-completion')runBindings.finishMediaTask({ownerKey:row.binding.ownerKey,taskId:row.binding.taskId,
        parentSessionKey:row.binding.parentSessionKey,runId:claim.runId,finalized:claim.finalized===true});
      row.ended=true;clearTimeout(row.timer);row.timer=setTimeout(()=>{void row.release();},5*60*1000);row.timer.unref?.();}},
  });
  async function initializeModelCapabilities() {
    if (capabilitiesInitialized) return;
    const file = path.join(directory, 'model-capabilities.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1000 || process.platform !== 'win32' && (stat.mode & 0o077))
        throw fail('The private model capability setting requires local inspection.', 'OPENCLAW_CONFIG_REJECTED');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (![1, 2].includes(value.version) || typeof value.reasoning !== 'boolean' || value.version === 2 &&
          (!Number.isSafeInteger(value.contextWindow) || value.contextWindow < 4096 || value.contextWindow > 2097152 ||
           !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 128 || value.maxOutputTokens > 32768))
        throw fail('The saved model capability setting is invalid.', 'OPENCLAW_CONFIG_REJECTED');
      reasoningCapable = value.reasoning;
      if (value.version === 2) {
        contextWindow = Math.min(value.contextWindow, modelContextTokens || 2097152);
        outputCeiling = value.maxOutputTokens;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    capabilitiesInitialized = true;
  }
  async function synchronizeModelCapabilities(capabilities) {
    await initializeModelCapabilities();
    const nextReasoning = typeof capabilities?.reasoning === 'boolean' ? capabilities.reasoning : reasoningCapable;
    const nextContext = Math.min(capabilities?.contextWindow ?? contextWindow, modelContextTokens || 2097152);
    const nextOutput = capabilities?.maxOutputTokens ?? outputCeiling;
    if (!Number.isSafeInteger(nextContext) || nextContext < 4096 || nextContext > 2097152 ||
        !Number.isSafeInteger(nextOutput) || nextOutput < 128 || nextOutput > 32768)
      throw fail('The selected model limits are invalid.', 'OPENCLAW_CONFIG_REJECTED');
    if (nextReasoning === reasoningCapable && nextContext === contextWindow && nextOutput === outputCeiling) return;
    reasoningCapable = nextReasoning; contextWindow = nextContext; outputCeiling = nextOutput;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(path.join(directory, 'model-capabilities.json'), { version: 2, reasoning: reasoningCapable,
      contextWindow, maxOutputTokens: outputCeiling });
    await stopChild();
  }
  async function nativeTurn(params, controller, { allowEmptyFinal = false } = {}) {
    await assertEnforcementHealthy();
    const client = await nativeConnectionReady();
    let expectedRun = params.idempotencyKey, settled = false, done, acknowledged = false, bufferedText = '';
    const earlyEvents = [];
    const completed = new Promise((resolve, reject) => {
      done = { resolve, reject };
    });
    // An admission RPC can fail before the terminal event is awaited. Keep its
    // sibling event promise observed while propagating the admission failure.
    completed.catch(() => {});
    const listener = event => {
      if (event.event !== 'chat' || event.payload?.sessionKey !== params.sessionKey) return;
      const payload = event.payload;
      if (!acknowledged && payload.runId !== expectedRun) { earlyEvents.push(event); return; }
      if (payload.runId !== expectedRun || settled) return;
      if (payload.state === 'delta') {
        const text = payload.deltaText;
        if (typeof text === 'string') {
          bufferedText = payload.replace === true ? text : bufferedText + text;
          if (Buffer.byteLength(bufferedText) > MAX_BYTES) { settled = true; done.reject(fail('The native text stream exceeded its limit.', 'OPENCLAW_RESPONSE_LIMIT')); }
        }
        return;
      }
      if (['error', 'aborted'].includes(payload.state)) { settled = true; done.reject(fail('The native OpenClaw turn stopped before an approved answer.', 'OPENCLAW_NATIVE_HELD')); }
      if (payload.state === 'final') {
        const content = payload.message?.content;
        const finalText = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : null;
        // Native deterministic commands publish replace=true deltaText followed
        // by a final frame with no message. Buffer privately until terminal and
        // require the broker's exact candidate/control receipt before release.
        const candidate = finalText?.trim() ? finalText : bufferedText;
        if (!candidate?.trim() && !allowEmptyFinal) { settled = true; done.reject(fail('OpenClaw ended this turn without an approved final reply. Native preflight or output policy may have held the request. No unreviewed text was released.', 'OPENCLAW_EMPTY_RESPONSE')); }
        else { settled = true; done.resolve({ text: candidate, usage: payload.message?.usage || {} }); }
      }
    };
    const aborted = () => {
      void client.request('chat.abort', { sessionKey: params.sessionKey, runId: expectedRun }).catch(() => {});
      if (!settled) done.reject(fail('The native OpenClaw turn was cancelled.', 'REQUEST_CANCELLED', 499));
    };
    const unsubscribeClose = nativeControl.subscribeClose(client, error => {
      if (!settled) { settled = true; done.reject(error); }
    });
    nativeEvents.add(listener); controller.signal.addEventListener('abort', aborted, { once: true });
    try {
      await client.request('sessions.messages.subscribe', { key: params.sessionKey, subscriptionId: 'chainchat-active-turn' });
      const acknowledgement = params.goalOperation
        ? await client.request('sessions.goal.update', params.goalOperation)
        : await client.request('chat.send', params);
      expectedRun = acknowledgement.runId || expectedRun;
      acknowledged = true;
      if (acknowledgement.replayed) throw fail('This native goal operation already completed; refresh its state.', 'OPENCLAW_GOAL_REPLAY', 409);
      for (const event of earlyEvents) listener(event);
      return await completed;
    } finally { unsubscribeClose(); nativeEvents.delete(listener); controller.signal.removeEventListener('abort', aborted);
      await client.request('sessions.messages.unsubscribe', { key: params.sessionKey, subscriptionId: 'chainchat-active-turn' }).catch(() => {});
    }
  }
  async function assertEnforcementHealthy({ duringStartup = false } = {}) {
    try {
      const owned = child;
      if (!owned || owned.exitCode !== null || owned.signalCode !== null)
        throw fail('No owned context engine is running.', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 503);
      const client = await nativeConnectionReady({ duringStartup });
      const result = await client.request('chainchat.enforcementHealth', {});
      if (owned !== child || owned.exitCode !== null || owned.signalCode !== null ||
          result?.version !== 1 || result.pluginId !== 'cypher-tempre-poi' || result.engineId !== 'cypher-tempre-poi' || result.healthy !== true || result.nativeCompletionPolicy!==true)
        throw fail('The mandatory context engine is not healthy.', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 503);
      runtimeHealth.ready(childGeneration);
    } catch {
      // Provider-route capabilities alone cannot stop a native deterministic
      // fallback from rewriting its transcript. Validate the actual mandatory
      // factory before entering any chat/compaction lifecycle, and fail-stop
      // this exact owned process if its guard is missing or latched unhealthy.
      runtimeHealth.failed('OPENCLAW_ENFORCEMENT_UNHEALTHY');
      try { await stopChild({ force: true }); }
      finally { active?.controller.abort(); }
      throw fail('The mandatory Proof of Interaction runtime is unavailable. This turn was held before native fallback; restart the local app after inspecting its runtime.', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 503);
    }
  }
  async function perform(config, args, context) {
    if (!args || !Array.isArray(args.messages) || !args.messages.length || args.messages.length > 200 ||
        args.messages.some(value => !value || !["user", "assistant"].includes(value.role) || typeof value.content !== "string") ||
        (args.system !== undefined && typeof args.system !== "string") ||
        (args.maxTokens !== undefined && (!Number.isSafeInteger(args.maxTokens) || args.maxTokens < 1 || args.maxTokens > 32768)))
      throw fail("A bounded valid OpenClaw model request is required.", "OPENCLAW_INVALID_REQUEST", 400);
    if (!context || !["candidate", "utility", "plain"].includes(context.purpose))
      throw fail("An explicit trusted OpenClaw invocation purpose is required.", "OPENCLAW_CONTEXT_REQUIRED", 422);
    const rawConfig = config, nativeProvider = config?.provider === 'native';
    const attachments=validateNativeAttachments(args.attachments);
    if(attachments.length&&!nativeProvider)throw fail('Attachments require the native provider mode.','OPENCLAW_ATTACHMENT_UNSUPPORTED',400);
    config = nativeProvider ? validateNativeProvider(config) : validateProvider(config); assertCredentialIsolation(config, args); checkServiceIsolation(args);
    if (!providerSessions.has(rawConfig)) providerSessions.set(rawConfig, randomUUID());
    const openCodeSession = providerSessions.get(rawConfig);
    if (!nativeProvider) await synchronizeModelCapabilities({ ...context.modelCapabilities,
      contextWindow: config.contextWindow ?? (modelContextTokens || 131072), maxOutputTokens: config.maxOutputTokens ?? 32768 });
    let browserInvocation = null;
    try {
    const inspectNativeTarget = createNativeBrowserInspector({ rpc: nativeRpc, assertIsolation: checkServiceIsolation,
      assertCurrent: async () => {
        if (active?.context !== context || active.controller.signal.aborted || context.purpose !== 'candidate' || browserInvocation?.profile !== 'chainchat-owned')
          throw fail('No current owned browser invocation admits native perception.', 'OPENCLAW_BROWSER_INSPECTION_DENIED', 403);
        await context.authorize?.();
      } });
    browserInvocation = browserService?.prepareInvocation ? await browserService.prepareInvocation({ ...context, inspectNativeTarget }) : null;
    if (browserInvocation?.config) await applyManagedServices({ browser: browserInvocation.config.browser || browserInvocation.config });
    // Chromium cannot pin a hostname to the addresses reviewed by the broker.
    // Keep strict hostname navigation closed until a managed browser network
    // adapter exists; allowedHostnames would otherwise trust private addresses.
    const desiredBrowserHosts = [];
    if (JSON.stringify(desiredBrowserHosts) !== JSON.stringify(browserHosts)) { browserHosts = desiredBrowserHosts; await stopChild(); }
    checkSignal(args.signal); await start(); await assertEnforcementHealthy(); checkSignal(args.signal);
    const invocationId = randomUUID();
    const modelRouteCapability = secret();
    // A paused Timechain still uses reviewed read-only skill context, but must
    // not inherit a saved active goal or its autonomous continuation authority.
    const native = context.memoryPaused ? undefined : args.nativeControl;
    if (nativeProvider) {
      const catalogue = await nativeModels(context.nativeIdentity);
      requireNativeModel(catalogue, config.model);
      if (catalogue.current !== config.model) throw fail('The native main default changed; reconnect this model before continuing.', 'OPENCLAW_NATIVE_MODEL_STALE', 409);
    }
    if (native && (context.purpose !== 'candidate' || !/^agent:main:chainchat-control:[a-f0-9]{64}$/.test(native.sessionKey || '') ||
        !(native.kind === 'message' || native.intent?.kind === 'session-goal-start' || native.goalOperation?.action === 'resume') ||
        context.nativeIdentity && native.sessionKey !== controlSessionKey(context.nativeIdentity)))
      throw fail('A valid host-registered native goal turn is required.', 'OPENCLAW_NATIVE_CONTROL_INVALID', 400);
    const sessionKey = native?.sessionKey || `agent:main:chainchat:${invocationId}`;
    const selected = context.nativeIdentity ? await controls.session(context.nativeIdentity) : null;
    if (native || nativeProvider) await waitForNativeSessionIdle({sessionKey, signal: args.signal,
      expectedSessionId: selected?.key === sessionKey ? selected.entry?.sessionId : undefined,
      requireExisting: dynamicInvocations.has(sessionKey),
      read: (key, {timeoutMs}) => nativeRpc('sessions.describe', {key, includeDerivedTitles: false, includeLastMessage: false}, {timeoutMs}),
      assertCurrent: async () => {checkSignal(args.signal); await context.authorize?.();}});
    const inherited = selected?.entry ? Object.fromEntries(NATIVE_PREFERENCES.filter(key => selected.entry[key] !== undefined)
      .map(key => [key, selected.entry[key]])) : {};
    if (!reasoningCapable && !['off', 'ultra'].includes(inherited.thinkingLevel)) delete inherited.thinkingLevel;
    const controller = new AbortController();
    const ownNativeGoal = !context.memoryPaused && native && context.nativeIdentity && context.purpose === 'candidate' &&
      native.sessionKey === controlSessionKey(context.nativeIdentity) &&
      (selected?.entry?.goal || native.intent?.kind === 'session-goal-start' || native.goalOperation?.action === 'resume');
    const registeredContext = { ...context, nativeProvider, modelRouteCapability: nativeProvider ? undefined : modelRouteCapability, assertContentIsolation: checkServiceIsolation,
      assertNativeModel:provider=>assertNativeKeyRoute(provider,sessionKey), assertNativeMediaKeyRoute,
      ...(browserInvocation ? { browserInvocation } : {}),
      ...((native||nativeProvider)?{expectedClientInputId:native?.goalOperation?.operationId||invocationId}:{}),
      goalAuthority: ownNativeGoal ? { enabled: true, sessionKey, ...(selected?.entry?.goal?.id ? { goalId: selected.entry.goal.id } : {}) } : undefined,
      readNativeGoal: ownNativeGoal ? async () => {
        const current = await nativeRpc('sessions.describe', { key: sessionKey, includeDerivedTitles: false, includeLastMessage: false });
        const goal = current.session?.goal;
        if (!goal || typeof goal.id !== 'string' || goal.id.length > 512 || typeof goal.objective !== 'string' ||
            goal.objective.length < 1 || goal.objective.length > 16000 ||
            !['active', 'paused', 'complete', 'blocked', 'budget_limited', 'usage_limited'].includes(goal.status) ||
            selected?.entry?.goal?.id && goal.id !== selected.entry.goal.id)
          throw fail('The selected native goal changed before action review.', 'OPENCLAW_GOAL_SCOPE_DENIED', 409);
        const snapshot = { id: goal.id, objective: goal.objective, status: goal.status };
        assertCredentialIsolation(config, snapshot); return snapshot;
      } : undefined,
      toolProtectedRoots: [...new Set([directory, upstream, plugin, ...(context.toolProtectedRoots || [])])] };
    // Official native compaction runs before admitting/appending the current
    // input. Never write through a second SessionManager during assemble: that
    // would stale OpenClaw's active writer and its transcript read fence.
    if (native && context.purpose === 'candidate' && context.nativeIdentity && selected?.entry?.sessionId &&
        typeof broker.estimateInvocation === 'function') {
      const estimate = await broker.estimateInvocation({ config, args, context: registeredContext, sessionKey, invocationId });
      const reserve = 12000 + Math.min(args.maxTokens || 4096, config.maxOutputTokens || 32768) + Math.ceil(Buffer.byteLength(args.messages.at(-1).content, 'utf8') / 4);
      const limit = Math.floor(contextWindow * 0.80);
      const readStats = async () => {
        const result = await nativeRpc('chainchat.compactionStats', { sessionKey, sessionId: selected.entry.sessionId });
        if (result?.version !== 1 || typeof result.known !== 'boolean' || result.known &&
            (result.sessionKey !== sessionKey || result.sessionId !== selected.entry.sessionId ||
             !Number.isSafeInteger(result.estimatedTokens) || result.estimatedTokens < 0 || typeof result.compactable !== 'boolean'))
          throw fail('Native context budget could not be verified.', 'OPENCLAW_COMPACTION_HELD', 422);
        return result;
      };
      let stats = await readStats();
      // An existing pre-upgrade session has not yet registered its trusted SDK
      // target. The official lifecycle seeds it; client paths are never used.
      if (!stats.known) {
        await performCompaction(config, { identity: context.nativeIdentity, signal: args.signal }, context);
        stats = await readStats();
        if (!stats.known) throw fail('The native session target is not available for budget verification.', 'OPENCLAW_COMPACTION_HELD', 422);
      }
      for (let pass = 0; stats.estimatedTokens + estimate.estimatedTokens + reserve > limit; pass++) {
        if (!stats.compactable || pass >= 8){
          onDiagnostic?.(`[chainchat] native context budget held history=${stats.estimatedTokens} prepared=${estimate.estimatedTokens} reserve=${reserve} limit=${limit}\n`);
          throw fail('The current request and retained native turns exceed the safe context budget. Shorten this input or start a new native conversation.', 'OPENCLAW_CONTEXT_BUDGET', 422);
        }
        const before = stats;
        const compacted = await performCompaction(config, { identity: context.nativeIdentity, signal: args.signal }, context);
        stats = await readStats();
        if (compacted.compacted !== true || !stats.known || stats.branchSha256 === before.branchSha256 || stats.estimatedTokens >= before.estimatedTokens)
          throw fail('Proof of Interaction held automatic compaction; the next turn was not admitted.', 'OPENCLAW_COMPACTION_HELD', 422);
      }
    }
    const claim = await broker.registerInvocation({ config, args, context: registeredContext, sessionKey, invocationId });
    if (!claim || typeof claim.claimId !== "string" || claim.sessionKey !== sessionKey)
      throw fail("The local enforcement broker refused the invocation.", "OPENCLAW_ADMISSION_FAILED", 422);
    const abort = () => { controller.abort(); void stopChild(); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, requestTimeoutMs);
    args.signal?.addEventListener("abort", abort, { once: true });
    active = { config, args, context, controller, claimId: claim.claimId, sessionKey, openCodeSession, modelRouteCapability };
    let responseComplete = false;
    try {
      checkSignal(args.signal);
      if (nativeProvider) await assertNativeKeyRoute(config.model,sessionKey);
      if (Object.keys(inherited).length && !native) await nativeRpc('sessions.patch', { key: sessionKey, ...inherited });
      if (native || nativeProvider) {
        await nativeRpc('sessions.patch', { key: sessionKey, model: nativeProvider ? config.model : `${PROVIDERS[config.provider].id}/route` });
        const generated = await nativeTurn({ sessionKey, message: args.messages.at(-1).content, idempotencyKey: native?.goalOperation?.operationId || invocationId,
          ...(native?.intent?.kind==='session-goal-start'?{}:{queueMode:'followup'}),
          deliver: false, ...(attachments.length?{attachments}:{}), ...(native?.intent ? { intent: native.intent } : {}), ...(native?.goalOperation ? { goalOperation: native.goalOperation } : {}) }, controller, {allowEmptyFinal:true});
        responseComplete = true; assertCredentialIsolation(config, generated); checkServiceIsolation(generated);
        let enforcement;
        const reviewed = typeof broker.readCandidate === 'function' ? await broker.readCandidate({claimId:claim.claimId}) : null;
        if (reviewed?.receipt?.outputAssets?.length) {
          if (typeof broker.assertDisplayCandidate !== 'function') throw fail('The generated media lacks a verified display projection.','NATIVE_OUTPUT_MEDIA_HELD');
          const sdk=await import(pathToFileURL(path.join(upstream,'dist/plugin-sdk/channel-outbound.js')).href);
          const projected=sdk.projectOutboundPayloadPlanForDelivery(sdk.createOutboundPayloadPlan([{text:reviewed.candidate}]));
          if (!Array.isArray(projected) || projected.length>1) throw fail('The generated media display could not be reduced safely.','NATIVE_OUTPUT_MEDIA_HELD');
          generated.text=typeof projected[0]?.text==='string'&&projected[0].text.trim()?projected[0].text:'Generated media is ready.';
          enforcement=await broker.assertDisplayCandidate({claimId:claim.claimId,display:generated.text});
        } else {
          if (!generated.text?.trim()) throw fail('OpenClaw ended this turn without an approved final reply.','OPENCLAW_EMPTY_RESPONSE');
          enforcement = await broker.assertCandidate({ claimId: claim.claimId, candidate: generated.text });
        }
        checkSignal(args.signal);
        return { ...generated, enforcement, runtime: { backend: 'openclaw', version: OPENCLAW_VERSION, invocationId, sessionKey } };
      }
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json",
          "x-openclaw-session-key": sessionKey, "x-openclaw-model": `${PROVIDERS[config.provider].id}/route` },
        body: JSON.stringify({ model: "openclaw/main", stream: false, max_completion_tokens: args.maxTokens || 4096,
          messages: [...(args.system ? [{ role: "system", content: args.system }] : []), ...args.messages] }),
        signal: controller.signal, redirect: "error" });
      const buffer = await collect(response.body); responseComplete = true;
      if (!response.ok) throw redactError();
      inspectResponse(config, buffer); checkServiceIsolation(buffer.toString('utf8'));
      const result = JSON.parse(buffer.toString("utf8")), candidate = result.choices?.[0]?.message?.content;
      if (typeof candidate !== "string" || !candidate.trim()) throw fail("OpenClaw returned no final candidate.", "OPENCLAW_EMPTY_RESPONSE");
      const enforcement = await broker.assertCandidate({ claimId: claim.claimId, candidate });
      checkSignal(args.signal); if (controller.signal.aborted) throw fail("The OpenClaw run was cancelled or timed out.", "REQUEST_CANCELLED", 499);
      return { text: candidate, enforcement, usage: { input: result.usage?.prompt_tokens || 0, output: result.usage?.completion_tokens || 0 },
        runtime: { backend: "openclaw", version: OPENCLAW_VERSION, invocationId } };
    } catch (error) {
      const providerError = active?.providerError;
      const brokerError = await broker.invocationError?.({ claimId: claim.claimId });
      controller.abort(); if (!responseComplete) await stopChild();
      if (args.signal?.aborted) throw fail("The OpenClaw run was cancelled.", "REQUEST_CANCELLED", 499);
      await context.authorize?.();
      if (timedOut) throw Object.assign(fail('The provider did not complete the native turn in time.', 'PROVIDER_TIMEOUT', 504), { stage: 'generation' });
      const specific = invocationError(providerError || brokerError);
      if (specific) throw specific;
      throw error;
    } finally {
      clearTimeout(timer); args.signal?.removeEventListener("abort", abort); active = null;
      await broker.finishInvocation?.({ claimId: claim.claimId });
    }
    } finally { await browserInvocation?.releaseInvocation?.(); }
  }
  function generate(config, args, context) {
    return serializedControl(() => perform(config, args, context));
  }
  async function performCompaction(rawConfig, { identity: nativeIdentity, instructions = '', signal } = {}, context) {
    if (closed) throw fail('This OpenClaw manager is closed.', 'OPENCLAW_CLOSED');
    if (!context || context.purpose !== 'candidate' || typeof instructions !== 'string' || Buffer.byteLength(instructions) > 16000 ||
        typeof broker.registerCompactionInvocation !== 'function' || typeof broker.finishCompactionInvocation !== 'function')
      throw fail('A privately admitted native compaction operation is required.', 'OPENCLAW_COMPACTION_HELD', 422);
    const nativeProvider = rawConfig?.provider === 'native';
    const config = nativeProvider ? validateNativeProvider(rawConfig) : validateProvider(rawConfig), sessionKey = controlSessionKey(nativeIdentity);
    assertCredentialIsolation(config, { instructions }); checkServiceIsolation({ instructions }); checkSignal(signal);
    if (!nativeProvider) await synchronizeModelCapabilities({ ...context.modelCapabilities,
      contextWindow: config.contextWindow ?? (modelContextTokens || 131072), maxOutputTokens: config.maxOutputTokens ?? 32768 });
    await start(); await assertEnforcementHealthy();
    if (nativeProvider) await assertNativeKeyRoute(config.model,sessionKey);
    const selected = await nativeRpc('sessions.describe', { key: sessionKey, includeDerivedTitles: false, includeLastMessage: false });
    if (!selected.session?.sessionId) return { ok: true, compacted: false, reason: 'No native conversation exists for this Timechain yet.' };
    const operationId = randomUUID(), controller = new AbortController();
    const abort = () => { controller.abort(); void stopChild(); };
    const timer = setTimeout(abort, requestTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    let claim;
    try {
      checkSignal(signal);
      claim = await broker.registerCompactionInvocation({ config, context: { ...context, nativeProvider, signal: controller.signal, assertContentIsolation: checkServiceIsolation },
        sessionKey, sessionId: selected.session.sessionId, operationId, instructions });
      if (!claim || typeof claim.claimId !== 'string' || claim.sessionKey !== sessionKey)
        throw fail('The compaction operation was not admitted.', 'OPENCLAW_COMPACTION_HELD', 422);
      active = { kind: 'compaction', config, context, controller, sessionKey, claimId: claim.claimId };
      emit(context, 'memory', 'started', 'Reviewing native conversation compaction');
      // The selected context engine obtains its summary through the admitted
      // broker operation, never through an unregistered model or tool run.
      const result = await nativeRpc('sessions.compact', { key: sessionKey }, { timeoutMs: requestTimeoutMs });
      checkSignal(signal); checkSignal(controller.signal);
      assertCredentialIsolation(config, result); checkServiceIsolation(result);
      const safe = redactNativeControl(result, [gatewayToken, proxyToken, broker.token]);
      emit(context, 'memory', result.compacted ? 'completed' : 'held', result.compacted ? 'Native conversation compacted after PoI review' : 'Native compaction did not change the transcript');
      return safe;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      active = null;
      if (claim) await broker.finishCompactionInvocation({ claimId: claim.claimId });
    }
  }
  function compact(config, args, context) {
    return serializedControl(() => performCompaction(config, args, context));
  }
  function suspend() {
    if (suspension) return suspension;
    suspended = true;
    haltEpoch++;
    nativeSourcesReady = false;
    managedServices = { ...managedServices, cron: { enabled: false } };
    suspension = (async () => {
      const stopped = stopChild({ force: true, tree: true });
      active?.controller.abort();
      proxy?.closeAllConnections();
      await stopped;
      await Promise.allSettled([...dynamicRows].map(row => row.release()));
      await startup?.catch(() => {});
      await queue;
      await stopChild({ force: true, tree: true });
    })().finally(() => { suspension = null; });
    return suspension;
  }
  async function resume() {
    const epoch = haltEpoch;
    await suspension;
    if (epoch !== haltEpoch) throw fail('Emergency Halt is active.', 'EMERGENCY_HALTED', 423);
    if (closed) throw fail('This OpenClaw manager is closed.', 'OPENCLAW_CLOSED');
    suspended = false;
    return start();
  }
  async function close() {
    closed = true;resolveNativeReadiness(false); services.close(); active?.controller.abort();
    for(const row of [...dynamicRows])await row.release();
    if (emergencyChild) await stopChild({ force: true, tree: true });
    await stopChild();
    await startup?.catch(() => {}); await stopChild();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = null; }
  }
  return { start, suspend, resume, generate, generateNative, completeNative, analyzeNativeMedia, nativeModels,
    resumeNativeSources:()=>{assertRunningAllowed();nativeSourcesReady=true;resolveNativeReadiness(true);return status();},
    nativeSources:request=>serializedControl(()=>nativeSources(request)), setNativeModel: (identity, id) => serializedControl(() => setNativeModel(identity, id)),
    configureNativeProvider: request => serializedControl(() => configureNativeProvider(request)),
    nativeSecrets:request=>serializedControl(()=>nativeSecrets(request)), nativeAuth, compact, close, status, nodePath,
    automationRpc: services.automationRpc, subscribeAutomation: services.subscribeAutomation,
    registerNativeService: services.registerNativeService,
    configureManagedServices: (patch, options) => serializedControl(() => applyManagedServices(patch, options)),
    enableManagedAutomation: () => serializedControl(() => applyManagedServices({ cron: { enabled: true } })),
    describeControls: identity => serializedControl(() => controls.describeControls(identity)),
    toolCatalogue: identity => serializedControl(() => controls.toolCatalogue(identity)),
    sessionControls: identity => serializedControl(() => controls.sessionControls(identity)),
    updateControls: request => serializedControl(() => controls.updateControls(request)),
    executeCommand: request => /^\s*\/(?:stop|model|config)(?:\s|$)/i.test(request?.command || '')
      ? controls.executeCommand(request) : serializedControl(async () => {
        await synchronizeModelCapabilities(request.modelCapabilities);
        return controls.executeCommand(request);
      }),
  };
}
