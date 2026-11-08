# Runtime memory and misleading readiness investigation

Investigated 2026-11-04. Fixes are prepared for 0.10.2; the measurements below preserve their 0.10.1 baseline scope. The published 0.10.1 installers do not contain these fixes.

## Confirmed defects

1. **Verifier worker launch failure.** Both 0.9.6 (OpenClaw 2026.10.9) and published 0.10.1 (2026.10.10) launch the gateway using `--input-type=module --eval`. OpenClaw forks a file-based database verifier while inheriting `execArgv`. Node rejects that file worker with `ERR_INPUT_TYPE_NOT_ALLOWED`, before database validation. The upstream parent discards worker stderr and reports a generic exit code 1. This was reproduced against both exact SDK versions with a healthy synthetic SQLite database; removing the eval flags makes verification succeed, with database bytes unchanged. An exit code 1 alone does not justify database repair, deletion, or a fresh chain.
2. **Misleading connection badge.** The old interface treated an authenticated app session and the configured backend name as proof that OpenClaw was connected. It did not require current process, private-control, and PoI readiness. A dead gateway could therefore leave a green badge.
3. **Avoidable controller import graph.** The controller imported the broad `plugin-sdk/gateway-runtime.js` barrel just to obtain `GatewayClient`. The barrel evaluates unrelated server/CLI helpers. Importing the exact same official client export directly saved approximately 77 MiB in a settled import-only experiment and about 67 MiB in the actual controller after a successful chat. This is measurable overhead, but does not explain an entire gigabyte.

## Same-version whole-process comparison

Frozen source: 0.10.1 commit `c0cc918ff0a6cb9b1fd74fbb01259ee41fc86ccd`, source ZIP SHA-256 `9c1d5f953b903548b682a61ed20110ee6838b158c790622dfcb44ac74d0538b4`. All four cases used OpenClaw 2026.10.10 and Node 26.13.0. Each ran in its own Linux cgroup capped at 3.1 GiB RAM and 512 MiB swap, on a WSL host with approximately 6 GiB RAM. A synthetic remote-model HTTP server supplied deterministic candidate/review responses. No real provider keys, browser automation, local LLM weights, or user data were involved.

Whole-process-tree phase peaks, in MiB RSS:

| Case | Startup | 5-second idle observation | First message | Overall peak PSS |
| --- | ---: | ---: | ---: | ---: |
| Same SDK, standalone | 1,188 | 1,956 | 2,088 | 1,869 |
| Published 0.10.1 source | 1,914 | 2,058 | 2,305 | 2,071 |
| File-bootstrap fix only | 1,959 | 2,054 | 2,307 | 2,072 |
| File bootstrap + narrower client import | 1,796 | 1,982 | 2,242 | 2,009 |

RSS sums count shared pages more than once. PSS apportions shared pages and is better for attributing physical-memory overhead. Each number is an observed single-run phase peak, not a guaranteed capacity requirement or a statistical benchmark. Startup boundaries follow each runtime's readiness event; startup and background initialization can overlap differently. The report also contains a 30-second observation after the answer.

All four completed an actual controlled `hello` with HTTP 200. All ChainChat cases had PoI approval and sealed ring 1. No cgroup OOM events occurred; owned processes and cgroups were removed after each run. These responses test transport/enforcement and sealing, not model answer quality.

After the narrower import, the observed remaining whole-tree overhead was about 140 MiB PSS relative to the same SDK without ChainChat. Most memory remained in the actual OpenClaw gateway and its native workers. An owned gateway sample showed about 1.4 GiB in anonymous mappings; this does not distinguish live JavaScript objects, native allocation, and allocator retention. It was not a large file-backed model. The controller and its private integration are additional processes/objects beyond a Markdown skill running inside an already-started OpenClaw agent.

A separate one-case experiment added only a numeric 512-MiB V8 old-space cap to the patched gateway launch. The controlled hello again returned HTTP 200 with PoI approval and ring 1. Peak tree RSS/PSS was 2,202/1,972 MiB, only about 37 MiB PSS below the uncapped patched case. There were no cgroup OOM events and all owned processes were cleaned up. This does not solve the larger SDK footprint or justify a production default: larger contexts, media, concurrency and repeated-run variance were not tested. The separate receipt is `work/memory-profile-heap512-report.json`, SHA-256 `e43829e497f8696f360686da8a3fcae65398abd4f7163b8556ad82cff3f455ec`.

## Follow-up attribution and limited-memory mitigation

Numeric SDK worker statistics resolve much of the anonymous-memory ambiguity:
the gateway retained up to 19 Worker-thread isolates, with approximately 1,039
MiB of committed worker heaps. Seven transcript workers accounted for about
392 MiB, two SQLite-store workers about 209 MiB, plus catalogue, reader and
other service heaps. Main-isolate V8 statistics do not include those heaps.
The extension allowlist alone does not establish that unused provider runtimes
execute eagerly. Removing provider capabilities was not justified by the data.

The pinned SDK already subscribes to `openclaw.memory.critical` to retire idle
worker resources. Its owners skip busy tasks, active actor operations,
maintenance scopes, pending transcript work and active reclamation. Resources
are recreated on demand. A controlled two-turn application-budget experiment
used that existing mechanism without SDK source edits or feature removal:

| Measure, MiB PSS unless specified | Matching baseline | Budget experiment |
| --- | ---: | ---: |
| Peak whole process tree | 2,022.64 | 1,810.90 |
| Between-turn final five-second mean | 1,820.50 | 1,322.85 |
| Retained workers between turns | 19 | 7 |
| First turn latency, seconds | 7.147 | 8.243 |
| Second turn latency, seconds | 4.075 | 7.486 |

Both distinct requests returned HTTP 200, PoI approval and sealed chat rings 1
and 15 (automatic registry/growth rings intervene). Lifecycle counters confirm
workers recreated for the second request. There were no cgroup OOM events and
all owned resources were cleaned up. These are synthetic-provider experiments
on the earlier frozen 0.10.1 source plus narrowly scoped prototype changes,
not broad workload guarantees for the final installer.

The successful prototype supplied the known 3.1-GiB fixture limit explicitly:
Node's detector missed a constrained ancestor whose leaf limit was unlimited.
Production 0.10.2 instead reads bounded metadata from standard cgroup-v2 and
legacy memory mounts, walks ancestors, and takes the minimum valid physical,
Node and cgroup capacity. Custom cgroup mount layouts rely on the Node/physical
fallback. On Linux at or below 4 GiB, a five-second unref'd timer requests the
existing idle reclamation only when measured gateway RSS exceeds 37.5% of
capacity (with a 256-MiB floor). This is an application cache budget; it does
not claim an OS OOM or impose a hard memory cap. No allocator default, worker
count patch, direct Worker termination, feature disablement or busy-work
cancellation was added. The internal SDK channel needs fresh compatibility
review and actual-runtime acceptance when upstream changes.

Receipts: `work/memory-dominant-census-report.json` SHA-256
`3adb0321a6464ef1d9e85e7ce12cdeeee39a142685bfdd7da1772f937a917897`
and `work/memory-dominant-idle-pressure-fixture-report.json` SHA-256
`bac617b1816546cabe885f371a055710be2f6346ee9eb70a81b8d0535b59d624`.

## Limits and interpretation

- The reported machine ran standalone OpenClaw 2026.6.1, whereas ChainChat 0.9.6 pins 2026.10.9. Those are different runtimes. The table deliberately compares matching 2026.10.10 runtimes; it does not quantify the change from 2026.6.1.
- The bounded WSL test did not include Firefox, Codex, a separate gateway, the user's databases, or the Lubuntu kernel. It does not reproduce the exact reported OOM. A system-wide OOM can kill a process at roughly 1 GiB RSS because the rest of the system also consumes memory.
- `memory-planning` is an application stage label for preparing relevant context. A failure there does not by itself establish a RAM allocation failure or database corruption. Remote DeepSeek does not require local DeepSeek model weights.
- SIGKILL alone does not prove an OOM kill. Kernel journal messages or cgroup `memory.events`/`oom_kill` evidence establish that cause.
- ChainChat filters inherited `NODE_OPTIONS` to prevent preload/debug injection. Thus an operator's standalone heap options are not necessarily applied to its child gateway. A V8 old-space cap is not a total-RSS cap; arbitrary inherited options must not be restored as a workaround.

## Changes and validation

- A real file bootstrap preserves upstream argv and the private supervisor shutdown channel, without leaking eval-only flags into forked workers.
- The client loader resolves the pinned SDK's exact official client re-export without executing the broad barrel. Unsupported layouts, escapes, and changed client APIs fail explicitly; authentication and protocol logic remain upstream code.
- Runtime status now tracks startup/PoI admission, live private-control readiness, owned process generation and sanitized exit metadata. Existing lightweight activity polling carries this metadata without an additional RPC or verification worker.
- The badge and setup readiness clear on runtime, enforcement, or transport failure. A late older response cannot restore green readiness. Fixed messages distinguish memory allocation failure, external kill, timeout, and unavailable enforcement without exposing private stderr.
- No PoI thresholds, independent review, database checks, chain format, or upstream source files were weakened or bypassed.

The combined focused Node 26 suite passed 85 tests with no failures. One symlink escape test was skipped because this Windows account cannot create unprivileged file symlinks. The separate verifier regressions exercise the real pinned SDK against owned healthy SQLite files; the UI/lifecycle tests inject bounded failure events and do not claim to reproduce an actual kernel OOM.

The final complete-patch actual-SDK acceptance run passed all 12 tests, with zero failures or skips, using the owned installed OpenClaw 2026.10.10, Node 26.13.0 and embedded Python. It covered real SQLite verification, bootstrap argv/shutdown, an existing-format chain introduction with current healthy/PoI-ready status, rejected fruitage, mismatched transport receipt, retrieval planning, paused learning and two-perspective collapse. Provider outputs and scores were synthetic fixtures; no paid model calls were made. Log: `work/runtime-memory-full-patch-integration.log`.

Investigation receipts are in the workspace `work/` directory: `worker-diagnostics-findings.json`, the two actual-SDK verifier proofs, `memory-profile-import-report.json`, `memory-profile-tree-r2-report.json`, and `runtime-health-oom-validation.json`. The immutable four-case report SHA-256 is `b5de2e5c795d58b83db7eeea883f571946d86e30a33655001c3363ec6f13b290`.

Primary references: [OpenClaw process troubleshooting](https://docs.openclaw.ai/gateway/troubleshooting/gateway-service-and-process), [managed-service heap policy and its scope](https://docs.openclaw.ai/cli/gateway/service), and [Linux cgroup memory accounting](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
