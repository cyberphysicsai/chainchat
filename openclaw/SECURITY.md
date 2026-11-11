# Security boundary and upstream dependencies

ChainChat is a local, authenticated OpenClaw distribution with a reviewed plugin
and native Timechain orchestrator. Functional tests do not establish perfect
security, truthful model judgment or an absence of dependency vulnerabilities.

The installed UI initially authenticates with an expiring, single-use launcher
nonce. Same-tab reload can use a rotating opaque resume credential stored in
local-origin `sessionStorage`. That credential grants access to the same live
session; it is sensitive even though no provider API key or API bearer is saved
there. Resume requires both owner proof and the exact local Origin. Merely
forging loopback Origin/fetch headers cannot create a session. Session end,
expiry and runtime restart invalidate the grant; closing a tab is not a reliable
server-side revocation signal. The embedded auditor is trusted same-origin UI,
not a sandbox boundary. Its messaging protocol deliberately forwards only fixed
reads and never sends the model key or parent bearer into the frame.

The original OpenClaw npm archive stays at the exact commitment in
`upstream-lock.json` (OpenClaw 2026.11.3). The metadata compatibility overlay,
`early-hook-input-provenance-v2`, forwards
only existing `inputProvenance: params.inputProvenance` and
`currentSourceTurnId: params.currentSourceTurnId` into the embedded-agent and CLI
runner's same early hook contexts. These typed native fields preserve private
asynchronous producer provenance and the framework's original client nonce for
queued-request correlation before mandatory PoI admission. Text markers and
transport acknowledgments never substitute for that provenance. No model, permission, tool or
safety semantics are changed by that overlay. The separate
`api-key-channel-auth-v1` overlay holds the built-in channel provider
`/login` before auth work, removes it from the stock command registry, and
skips usage probes in `models.authStatus` while preserving credential-status
metadata. The installer checks all five exact original SHA-256 values before
replacement, and doctor and Gateway require all five final hashes. The original
npm SRI describes the downloaded archive. A separate dependency overlay selects external
Undici 8.12.4, Zod 4.6.7, npm 12.2.2 and Minimatch 11.0.8. These are ordinary dependency overrides,
not edits to the upstream source tarball. The runtime lockfile, setup integrity
checks and launcher doctor validate these selections. Adoption requires actual
Gateway and installed-application regression tests. Automatic upstream update
checks and automatic application of updates are disabled in the managed Gateway.

The external overrides leave embedded dependency copies intact. The published
npm 12.2.2 archive includes fixed Undici 6.29.1. Its ip-address 10.7.5
already includes the zone-identifier fix. After `npm ci --ignore-scripts`,
both platform installers replace that copy with the official, hash-verified
ip-address 10.7.6 archive, which also escapes highlighted characters in IPv6
parse diagnostics. Launcher doctor verifies both installed versions. The npm
lock preserves the original bundled metadata, while the installer and doctor
attest the replacement separately.
[ip-address advisory](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rxp7-6hxx-x8q5)
[ip-address release changes](https://github.com/beaugunderson/ip-address/compare/v10.7.5...v10.7.6)

The managed installation also applies exact-hash upstream security backports.
They change executable code rather than relabeling versions:

- `runtimeSecurityOverlays` commits 18 files covering OpenClaw's embedded Zod
  4.6.5 and the browser tool's embedded Zod 4.6.2. The [upstream collection-bounds fix](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd)
  rejects oversized arrays, maps and sets before evaluating their children, in
  both interpreted and compiled schemas. Leading transforms, backward/skip-check
  behavior, nested issues and ordinary parsing keep the upstream semantics.
  Original version headers and license notices remain intact.
- `npmSecurityOverlays` commits eight files inside npm 12.2.2. These backport the
  [Glob abort fix](https://github.com/isaacs/node-glob/commit/4682e8c9babee1b385202ede36389634e12076d7),
  [Minimatch amplification bounds](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8)
  and allocation budgets, and the [literal-escaping fix](https://github.com/isaacs/minimatch/commit/784603e09641970d2ba2caf8c73a95d1015cc67d).
  Both CJS/ESM raw walkers are fixed. Glob's default minified entry points are
  replaced with exact-hash forwarders to the same release's official raw
  exports, removing their separate inline Minimatch/brace-expansion copies.
  Export parity and actual npm install/pack behavior are tested. The standalone
  Minimatch copies retain their existing npm-facing APIs. The
  backports cover [Glob cancellation](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4),
  [pattern amplification](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
  and [literal escaping](https://github.com/isaacs/minimatch/security/advisories/GHSA-c859-jr93-m5j4).
  The external Minimatch override is 11.0.8, also addressing the
  [11.x cache-weight issue](https://github.com/isaacs/minimatch/security/advisories/GHSA-hqmv-qgp3-jx75).
- Installers do not extract or execute Node's original npm 11.20.0 subtree.
  Before the first dependency install, verified portable Python constructs a
  complete npm 12.2.2 tree from the official SHA-256/SRI-pinned archive, applies
  the same eight-file backports and ip-address archive, and verifies it. The
  replacement has patched Undici 6.29.1 and ip-address 10.7.6. The original
  Node archive remains independently hash-verified; all non-npm files and links
  are checked against it. A new `npmSecurityProfile` identifies a separate Node
  directory. Existing runtime directories are verified or retained, never
  overwritten with a new security profile. Repeat setup reconstructs the
  expected npm tree from verified archives and compares every file, rather
  than trusting a writable installation receipt.

Launcher doctor and Gateway startup require all compatibility and security
backport hashes. Gateway checks precede native Doctor/SDK execution. Unknown
input bytes, incomplete commitments and changed output bytes hold startup.
The tests exercise actual vulnerable and patched code, including bounded
adversarial inputs; setup uses no package lifecycle scripts. CI and documented
source installs also prepare the secured npm before invoking any npm command.

The November 11, 2026 registry audit of the unmodified published lock metadata
reports 22 moderate findings and zero high/critical findings, rooted in npm's
bundled Glob/Minimatch closure. That metadata is deliberately preserved and
still names the original versions; ordinary audit tools do not inspect these
source backports. Those findings share the two bundled dependency roots. The exact backport
commitments, installed file checks and behavior tests provide the separate
remediation evidence for the attested installation. The two newly
published Minimatch advisories above were also reviewed directly because they
were not yet included in the registry's bulk advisory response. The application's
direct dependency bulk check reported no advisories. This is a review of known
findings, not proof that every dependency is free of vulnerabilities. Review
new findings independently; do not suppress them based on an earlier patch.

The portable Node pin is 26.13.1, the security release published on November
10, 2026. All five platform archive hashes were checked against the detached
signature using the official Node release keyring at immutable commit
`481637f813e912c4aa3622d7964ab426c97b8e8d`; the signing fingerprint was
`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`.
[Node.js November security release notice](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases)

The managed UI does not expose npm/package-manager tools. Host tools are
default-denied and require explicit per-agent grants, scope validation and fresh
semantic/native admission before each invocation. Exploratory search branches
and utility calls cannot use them. Gateway HTTP is authenticated and bound to numeric loopback; the UI never
receives its operator token. ChainChat constructs Gateway message envelopes,
limits them to 200 messages and sends no arbitrary browser-provided tool or
configuration schemas. Browser chat input becomes message text. The embedded Zod backport also protects collection schemas outside that HTTP
envelope; bounded UI input alone is not treated as a substitute for fixing
the dependency.

The provider proxy bounds responses, refuses redirects and strips transport
encoding headers when forwarding decoded content. Provider credentials remain
in the parent process; the child receives private proxy credentials. Native
admission and exact candidate receipts remain required regardless of model
output. Default-denied tools are not an OS sandbox: explicitly approved native
operator code still runs with the local user's permissions.

Do not expose the Gateway or ChainChat HTTP ports publicly or treat arbitrary
standalone OpenClaw plugins, channels, CLI commands or tools as covered by this
configuration's tests. Extending those paths requires a fresh security review.
Use `npm audit --omit=dev` in `openclaw/runtime` when reviewing updates, inspect
embedded libraries as well as lockfile findings. Retain backports until a reviewed
upstream release actually incorporates each fix in every relevant executable copy.
An audit with zero lockfile findings would not itself prove embedded copies are fixed.


## Native controls and explicit local tools

The native upgrade adapter recognizes only the reviewed shared-state 20-to-22
and agent-state 25-to-27 transitions. It checks regular-file ownership, schema
metadata and integrity using disposable copies, then retains a checksummed raw
backup before supervisor configuration changes. The backup includes the whole
owned OpenClaw directory, authentication and managed workspace notes. Only
derived workspace/plugin skill links are recorded as link metadata; their
targets are not copied. Other links and hardlinks are refused.

Backup directories disable inherited Windows access and grant only the current
owner, SYSTEM and Administrators, or use owner-only POSIX permissions. This is
filesystem protection, not encryption. The fixed offline Doctor invocation
uses the exact pinned runtime, noninteractive repair without force, external
service-repair policy, and scoped state/configuration. No model request is
authorized by migration. Unexpected findings retain the hold; failures retain
the backup and an interruption receipt. Managed configuration is reprojected
after Doctor, and all normal startup and PoI health checks remain required.
An earlier app pointer cannot make a newer native schema readable by an older
runtime. Offline recovery must use a compatible runtime and verified native
backup; the adapter never blindly downgrades a database or replaces a Timechain.

Automatic native utility routing is disabled with `agents.defaults.utilityModel:
""`, and native remote memory indexing/search is disabled with
`memory.search.enabled: false`. Upstream otherwise derives utility models from
the global native provider and defaults memory embeddings to OpenAI. ChainChat
holds automatic utility-model overrides and uses the admitted API-key model
for its private PoI review. An explicit owner setting grant can enable native
remote memory search with its separately configured provider.

BYOK native agent runs, including admitted children, are routed to the
owner's exact private proxy provider before native model selection. Their native
fallback chain is empty; a saved native profile cannot become a paid fallback.
The mandatory context engine independently checks the actual public native
runtime provider/model metadata before supplying any model context. Missing or
mismatched metadata triggers the existing owned-process fail-stop. Route lookup
can read a host-registered claim before native admission, but cannot bind its
run ID, prepare context, grant tools or revive a completed candidate. Native
provider mode retains explicitly configured native model overrides.
When upstream selects a continuation model before forwarding its full typed
input, a read-only routing hint may use an actually observed task/creation
receipt or an enrolled native source. Media hints recheck the exact parent
session, lifecycle and receipt epoch. They do not parse message text, reserve a
task or create a Timechain. The current owner connection is checked separately;
later admission still requires the complete native source proof and fresh
model-route verification before inference.

Recurring heartbeats require the native Automations scheduler and an explicitly
enrolled owner source. The source's monitor-note editor uses only the actual
system heartbeat job and upstream compare-and-swap scratch APIs. It rechecks
enrollment, native configuration and the exact monitor before and after each
read/write. Editing requires the owner's current background grant; reading or
revoking an owned source remains available after a grant is disabled. Notes
are prompt data, never tool authority. Upstream intentionally skips scheduled
model work for an empty scratch; removing the scratch restores the configured
heartbeat prompt. Each admitted turn still receives canonical policy and fresh
semantic/native review.

Native goals/preferences have durable local session state. Direct BYOK keys and local
session authority remain in parent-process memory; native provider sign-in uses
OpenClaw's private local credential store and may persist keys or OAuth tokens there.
Persistent native authentication is not cleared by closing a browser tab or stopping
the app. Dedicated TTS credentials use a separate plaintext local
`native-secrets.json` store, with owner-only file/directory modes on POSIX and the
installation's user-profile ACLs on Windows. This is not an encrypted vault.
Only configured native TTS provider/persona targets are accepted; settings hold
official `SecretInput` references to generated, exactly allowlisted child
environment names. Public state never contains the credential values. Deleting a
binding removes it from the managed child on the next owned restart. The operator token never reaches
the browser. Native schema inspection is redacted; edits cannot remove required
PoI enforcement or replace managed credentials, plugins or gateway bindings.
Deterministic native slash-command results are control output, not model answers
or fabricated conversation seals.

Granting exec/process permits broad execution as the local OS user. Directory and
requested-host lists do not sandbox arbitrary subprocesses. File grants are
canonicalized, reject symlink escapes and protect application/data/paired-chain
roots. Browser automation uses an owned profile and a managed authenticated
network proxy; requested-navigation checks alone cannot contain DNS changes,
redirects and page subresources. Each native primitive action receives fresh
semantic/native review. Compound actions and unverifiable cross-origin frame
references are held. Model-supplied JavaScript requires the separate broad
evaluation, credential and payment acknowledgments; it is not keyword-sandboxed.
Web-fetch grants retain
native DNS/private-network checks and disable redirects. These checks do not
constitute a system firewall or OS sandbox. Native channel text and scheduled
turns use explicit immutable bindings and the shared review/commit pipeline;
separate outgoing permits expire on source, local-session or provider revocation.

Compaction requires an exact-source summary receipt and native transcript CAS.
Private, per-invocation model-route capabilities identify proxy-mode invocations
and are stripped before provider forwarding. Native provider mode does not add
these proxy markers; it uses private session and assembly receipts. Missing reviewed
context, including a legacy engine fallback, cannot authorize model generation.
The mandatory factory is probed before startup is reported ready and before
native work/provider forwarding. Its guard latches faults without selecting a
legacy writer. Unexpected accepted-turn commit failures stop the owned Gateway
before native exception recovery; constructor-fault tests verify no deterministic
compaction append, even when no model call would have occurred.

Browser proxy credentials remain in the parent. The private CDP relay answers
only authentication challenges marked Proxy from the exact owned endpoint;
website authentication does not receive that credential. Capability-bound
discovery validates the actual owned browser/page endpoints. Real two-client
HTTPS and origin Basic-auth checks accompany bounded protocol, queue, shutdown
and revocation tests. This transport does not sandbox trusted native plugin code.

The pinned first-party browser backend is a required service; its original
tool receives mandatory parameter scoping, PoI review and result reduction. Third-party native plugins require explicit exact
artifact trust and native lifecycle consent. **They execute with the local user's
OS permissions and can act outside model hooks.** PoI gates model actions, not
arbitrary trusted plugin code. Do not treat importing a chain, enabling a tool,
or passing deterministic tests as a native-plugin sandbox or proof of security.
