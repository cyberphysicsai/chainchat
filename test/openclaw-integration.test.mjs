/** Actual pinned OpenClaw, HTTP UI and native Python engine; no paid model calls.
 * Provider text and semantic scores are deterministic fixtures, so these are
 * boundary/integration tests, not answer-quality or benchmark measurements. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

// Release acceptance can target the installed application itself, in addition
// to using its locked runtime and embedded Python through CT_CHAT_PYTHON.
const application = process.env.CT_CHAINCHAT_PACKAGE ? path.resolve(process.env.CT_CHAINCHAT_PACKAGE)
  : fileURLToPath(new URL("..", import.meta.url));
const [{ createApp }, { engine }, { createOpenClawGateway }, { DIMENSIONS, FRUITS }] = await Promise.all([
  "server.mjs", "lib/engine.mjs", "openclaw/gateway.mjs", "lib/providers.mjs",
].map(file => import(pathToFileURL(path.join(application, file)).href)));

const runtimePackage = process.env.CT_OPENCLAW_PACKAGE;
const runtimeNode = process.env.CT_OPENCLAW_NODE;
const ANSWER = "Hello! I'm Cypher Tempre, your conversational assistant. I can help you think carefully and explore questions with patience, kindness and honesty.";
const PLAN = JSON.stringify({ queries: ["patient inquiry"], entities: [], shapes: ["narrow"], rings: [],
  useReplay: false, labels: { senses: [], modalities: [] } });
const goodReview = () => ({ approved: true, decision: "approve", usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])),
  rationale: "A supported, patient and honest fixture response compatible with the genesis covenant." });
const rings = async root => (await fs.readFile(path.join(root, "chain", "rings.jsonl"), "utf8"))
  .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const chats = async root => (await rings(root)).filter(ring => ring.payload?.event === "web_chat_turn");
const diagnostic = f => f ? `\nRuntime diagnostics:\n${f.diagnostics.join("").slice(-6000)}` : "";
const ok = (result, f) => assert.equal(result.status, 200, JSON.stringify(result.body) + diagnostic(f));

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ct-openclaw-ui-"));
  const root = path.join(directory, "existing-native-agent");
  await engine({ op: "init", root, name: "Cypher Tempre" });
  const original = await fs.readFile(path.join(root, "chain", "rings.jsonl"));
  const requests = [], reviews = [], calls = [], diagnostics = [];
  const state = { rejectFruit: false, alterReceiptCandidate: false, toolPlan: null };
  const upstream = http.createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), content = JSON.stringify(body);
    const utility = content.includes("Plan retrieval for a local Timechain agent");
    requests.push({ headers: request.headers, body, utility });
    const text = utility ? PLAN : ANSWER;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (!utility && state.toolPlan) {
      const { name, args } = state.toolPlan;
      state.toolPlan = null;
      const names = new Set((body.tools || []).map(tool => tool.function?.name || tool.name));
      const deferred = !names.has(name) && names.has("tool_call");
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "ct-shell-fixture", type: "function",
          function: { name: deferred ? "tool_call" : name, arguments: JSON.stringify(deferred ? { id: name, args } : args) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      return response.end("data: [DONE]\n\n");
    }
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  let app;
  t.after(async () => {
    await app?.closeRuntime();
    if (app?.server.listening) await new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); });
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith("ct-openclaw-ui-"));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  app = await createApp({ dataDir: path.join(directory, "application"), pairingCode: "OPENCLAW-UI-FIXTURE",
    engine: async request => { calls.push(structuredClone(request)); return engine(request); },
    review: async (_config, args) => {
      reviews.push(args); const result = goodReview();
      if (state.rejectFruit) result.fruits.kindness = 179;
      return result;
    },
    openclaw: { stateDir: path.join(directory, "gateway"), packageRoot: runtimePackage, nodePath: runtimeNode,
      pluginPath: path.join(application, "openclaw", "plugin"), onDiagnostic: line => diagnostics.push(line) },
    openclawFactory: options => createOpenClawGateway({ ...options, broker: {
      get url() { return options.broker.url; }, get token() { return options.broker.token; },
      registerInvocation: invocation => options.broker.registerInvocation(invocation),
      assertCandidate: invocation => options.broker.assertCandidate({ ...invocation,
        candidate: state.alterReceiptCandidate ? invocation.candidate + " altered after review" : invocation.candidate }),
      finishInvocation: invocation => options.broker.finishInvocation(invocation),
    } }),
  });
  await app.store.add(root, "Cypher Tempre", true);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let token;
  const call = async (endpoint, input) => {
    const response = await fetch(base + endpoint, { method: input === undefined ? "GET" : "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(input === undefined ? {} : { "content-type": "application/json" }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  const paired = await call("/api/pair", { code: "OPENCLAW-UI-FIXTURE" }); ok(paired); token = paired.body.token;
  ok(await call("/api/provider", { provider: "compatible", model: "fixture-model",
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "fixture-session-secret" }));
  ok(await call("/api/cognition", { autoRoute: false, semanticRecall: false, autoSprout: false, learning: false, revisionLimit: 0, searchDepth: 1 }));
  ok(await call("/api/settings", { recall: false }));
  return { ...app, directory, root, original, requests, reviews, calls, state, call, diagnostics };
}

test("pinned OpenClaw preserves ChainChat conversation, gates, controls and skill compatibility", {
  skip: !runtimePackage || !runtimeNode ? "Set CT_OPENCLAW_PACKAGE and CT_OPENCLAW_NODE for real runtime UI acceptance." : false,
  timeout: 420000,
}, async t => {
  const f = await fixture(t);
  try {
    await t.test("existing native chain, selected faculties, introduction and commit before release", async () => {
      ok(await f.call("/api/loadout", { modalities: ["2"], senses: ["5"] }));
      const start = f.requests.length;
      const response = await f.call("/api/chat", { message: "Please introduce yourself" }); ok(response, f);
      assert.equal(response.body.message.content, ANSWER);
      assert.equal(f.requests.length - start, 1, "No hidden duplicate generation or recursive reviewer run.");
      const request = f.requests.at(-1);
      assert.equal(request.headers.authorization, "Bearer fixture-session-secret");
      const context = JSON.stringify(request.body);
      assert.equal(context.includes("fixture-session-secret"), false);
      assert.ok(context.includes("CHAINCHAT HOST CONTRACT"));
      assert.ok(context.includes("Salience Anchoring"), "The selected native sense is supplied to OpenClaw.");
      const sealed = await chats(f.root); assert.equal(sealed.length, 1);
      assert.equal(sealed[0].payload.exchanges[0].output, ANSWER);
      assert.deepEqual(sealed[0].payload.labels.equipped, ["modality:2", "sense:5"]);
      assert.ok((await fs.readFile(path.join(f.root, "chain", "rings.jsonl"))).subarray(0, f.original.length).equals(f.original));
      assert.equal((await engine({ op: "verify", root: f.root })).verified, true);
      const runtime = (await f.call("/api/status")).body.runtime;
      assert.equal(runtime.backend, "openclaw");
      assert.equal(runtime.running, true);
      assert.equal(runtime.healthy, true, "The real SDK client and mandatory PoI engine must both be admitted.");
      assert.equal(runtime.enforcementHealthy, true);
      assert.equal(runtime.healthState, "ready");
      const observed = (await f.call("/api/activity")).body;
      assert.equal(observed.executionRuntime.healthy, true, "The lightweight poll must carry actual current runtime health.");
      const activity = observed.activity || observed;
      assert.equal(activity.running, false); assert.deepEqual(activity.activeAbilities, []);
      for (const ability of ["faculties", "gate", "seal"])
        assert.ok(activity.events.some(event => event.ability === ability && event.status === "completed"));
      assert.equal(JSON.stringify(activity).includes("fixture-session-secret"), false);
      const config = await fs.readFile(path.join(f.directory, "gateway", "gateway.json"), "utf8");
      assert.equal(config.includes("fixture-session-secret"), false);
    });
    await t.test("low covenant fruitage cannot release or append a candidate", async () => {
      const before = await fs.readFile(path.join(f.root, "chain", "rings.jsonl"));
      const start = f.requests.length, reviewed = f.reviews.length;
      f.state.rejectFruit = true;
      try {
        const response = await f.call("/api/chat", { message: "Please offer a patient introduction again." });
        assert.ok(response.status >= 400, JSON.stringify(response.body));
        assert.equal(response.body.message?.content, undefined);
        assert.equal(JSON.stringify(response.body).includes(ANSWER), false);
        assert.ok(f.requests.length > start, "The rejected candidate actually reached the local model fixture.");
        assert.ok(f.reviews.length > reviewed, "An actual semantic assessment, not an unrelated transport error, held the candidate.");
        assert.deepEqual(await fs.readFile(path.join(f.root, "chain", "rings.jsonl")), before);
      } finally { f.state.rejectFruit = false; }
    });
    await t.test("transport receipt mismatch cannot reach native conversation commitment", async () => {
      const before = await fs.readFile(path.join(f.root, "chain", "rings.jsonl"));
      const start = f.requests.length, reviewed = f.reviews.length;
      f.state.alterReceiptCandidate = true;
      try {
        const response = await f.call("/api/chat", { message: "Consider a careful and kind answer." });
        assert.ok(response.status >= 400, JSON.stringify(response.body));
        assert.equal(response.body.message?.content, undefined);
        assert.ok(f.requests.length > start, diagnostic(f)); assert.ok(f.reviews.length > reviewed, diagnostic(f));
        assert.deepEqual(await fs.readFile(path.join(f.root, "chain", "rings.jsonl")), before);
      } finally { f.state.alterReceiptCandidate = false; }
    });
    await t.test("utility retrieval JSON has no skill injection, tools or recursive conversation commit", async () => {
      ok(await f.call("/api/settings", { recall: true }));
      ok(await f.call("/api/cognition", { semanticRecall: true }));
      const before = (await chats(f.root)).length, start = f.requests.length;
      const response = await f.call("/api/chat", { message: "Plan a patient inquiry into an uncertain topic." }); ok(response, f);
      const current = f.requests.slice(start), planners = current.filter(request => request.utility);
      assert.equal(planners.length, 1); assert.equal(current.length, 2);
      assert.equal(JSON.stringify(planners[0].body).includes("CHAINCHAT HOST CONTRACT"), false);
      assert.equal(planners[0].body.tools?.length || 0, 0);
      assert.equal((await chats(f.root)).length, before + 1);
      assert.equal(response.body.message.content, ANSWER);
      ok(await f.call("/api/cognition", { semanticRecall: false }));
      ok(await f.call("/api/settings", { recall: false }));
    });
    await t.test("paused-memory chat still wears canonical skill and reviews without appending", async () => {
      ok(await f.call("/api/cognition", { mode: "dormant", confirm: true }));
      const before = await fs.readFile(path.join(f.root, "chain", "rings.jsonl"));
      const reviews = f.reviews.length, start = f.requests.length;
      const response = await f.call("/api/chat", { message: "Give an ordinary paused introduction." }); ok(response, f);
      assert.equal(response.body.message.raw, false); assert.equal(response.body.message.memoryPaused, true);
      assert.equal(response.body.message.gate.required, true); assert.equal(response.body.message.gate.approved, true);
      assert.equal(f.requests.length - start, 1); assert.equal(f.reviews.length, reviews + 2);
      assert.equal(JSON.stringify(f.requests.at(-1).body).includes("CHAINCHAT HOST CONTRACT"), true);
      assert.deepEqual(await fs.readFile(path.join(f.root, "chain", "rings.jsonl")), before);
      ok(await f.call("/api/cognition", { mode: "active", confirm: true }));
    });
    await t.test("chat invokes an equipped skill and a reviewed native shell tool with independent grants", async () => {
      const initial = await f.call("/api/openclaw/skills"); ok(initial, f);
      const { agentId, revision } = initial.body;
      const marker = "CHAINCHAT_SKILL_CONTEXT_FIXTURE";
      const text = `---\nname: acceptance-fixture\ndescription: Verify the guarded chat skill path.\n---\n\nUse this fixture instruction: ${marker}\n`;
      const saved = await f.call("/api/openclaw/skills/import", { agentId, text, acknowledged: true }); ok(saved, f);
      const { id, sha256 } = saved.body.skill;
      const start = f.requests.length;
      assert.equal((await f.call("/api/chat", { message: "/skill acceptance-fixture Introduce yourself" })).status, 409);
      assert.equal(f.requests.length, start);
      const selected = await f.call("/api/openclaw/skills/select", { agentId, revision, skills: [{ id, sha256 }], acknowledged: true });
      ok(selected, f);
      assert.equal(selected.body.skills[0].status, "selected");
      const stop = await f.call("/api/openclaw/command", { command: "/stop" }); ok(stop, f);
      assert.equal(stop.body.action, "stop");
      const result = await f.call("/api/chat", { message: "/skill acceptance-fixture Introduce yourself" }); ok(result, f);
      assert.equal(result.body.message.content, ANSWER);
      assert.equal(result.body.message.gate.approved, true);
      const skillContext = JSON.stringify(f.requests.at(-1).body);
      assert.ok(skillContext.includes("CHAINCHAT HOST CONTRACT"));
      assert.ok(skillContext.includes(marker));
      assert.equal((await f.call("/api/openclaw/tools", { enabled: true, tools: ["exec"], acknowledged: true })).status, 403);
      ok(await f.call("/api/openclaw/tools", { enabled: true, tools: ["exec"], roots: [], networkHosts: [],
        allowExecution: true, acknowledged: true }), f);
      const shellMarker = "CHAINCHAT_SHELL_OUTPUT_FIXTURE";
      f.state.toolPlan = { name: "exec", args: { command: `echo ${shellMarker}` } };
      const beforeShell = f.requests.length, beforeReview = f.reviews.length;
      ok(await f.call("/api/chat", { message: "Use the permitted shell tool to run the fixture echo command." }), f);
      assert.ok(f.reviews.slice(beforeReview).some(review => review.candidate.includes("proposed-host-tool-action") &&
        review.candidate.includes(shellMarker)), "The exact proposed command must reach PoI.");
      const returnedOutput = f.requests.slice(beforeShell).flatMap(request => request.body.messages.filter(message => message.role === "tool"));
      assert.ok(returnedOutput.some(message => JSON.stringify(message.content).includes(shellMarker)),
        `Actual shell output must come back through the native tool: ${JSON.stringify(returnedOutput)}`);
      const observed = await f.call("/api/activity"); ok(observed, f);
      const activity = observed.body.activity || observed.body;
      assert.ok(activity.events.some(event => event.ability === "tool" && event.status === "completed" && /exec/i.test(event.label)));
      assert.equal(JSON.stringify(activity.events).includes(shellMarker), false, "Tool activity must omit raw parameters and results.");
      ok(await f.call("/api/openclaw/tools", { enabled: false }), f);
      ok(await f.call("/api/openclaw/skills/select", { agentId, revision: selected.body.revision, skills: [], acknowledged: true }), f);
    });
    await t.test("two equipped perspectives are actual model calls and collapse to one conversation ring", async () => {
      ok(await f.call("/api/settings", { fork: true, perspectives: 2, archetypes: ["2", "5"] }));
      const before = (await chats(f.root)).length, start = f.requests.length;
      const response = await f.call("/api/chat", { message: "Consider a careful question from two perspectives." }); ok(response, f);
      assert.equal(f.requests.length - start, 3, "Two candidates and one synthesis must actually call the selected provider.");
      assert.equal(response.body.message.perspectives.length, 2);
      const sealed = await chats(f.root); assert.equal(sealed.length, before + 1);
      assert.equal(sealed.at(-1).payload.exchanges[0].chronosynaptic.collapsed_from, 2);
      assert.equal((await engine({ op: "verify", root: f.root })).verified, true);
    });
  } catch (error) { throw new Error(`${error.message}\nRuntime diagnostics:\n${f.diagnostics.join("").slice(-4000)}`, { cause: error }); }
});
