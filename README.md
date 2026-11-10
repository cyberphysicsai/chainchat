# Cypher Tempre ChainChat

A bring-your-own-model Agentic Timechain Metaprogramming Interface for Cypher Tempre. Monochrome physics diagrams, ambient DNA helices and timechain blocks, an MMO-style ability bar, and a real Timechain underneath.

This local application includes the complete Proof of Interaction engine. Its module, gate, score fields, skill instructions, and model-facing vocabulary use PoI throughout. It does not replace an installed skill or rewrite existing history.

## OpenClaw edition

ChainChat runs pinned **OpenClaw 2026.11.2** with a Cypher Tempre enforcement plugin and narrowly verified runtime compatibility and API-key policy overlays. Its full-width chat and single-row ability bar pilot the maintained [Proof of Interaction skill](https://github.com/cyberphysicsai/proof-of-interaction). The packaged 69-file PoI skill bundle is byte-identical to its canonical OpenClaw edition; its cognitive-engine code remains unchanged.

The original OpenClaw npm archive retains its official integrity digest. After extraction, compatibility overlay v2 forwards the existing `inputProvenance` and `currentSourceTurnId` fields through the same two early runtime context boundaries. Native provenance identifies asynchronous producers; the framework's original client nonce correlates queued requests before mandatory context assembly. Exact pre-patch and post-patch file hashes are required; unknown bytes and earlier overlay output are refused. The overlay adds no model, action or safety logic. Completion text and transport acknowledgments grant no authority. Installer and doctor checks verify the overlay on every supported OS. Upstream upgrades must refresh this exact compatibility attestation and pass the runtime and installer checks again.

Installed startup and idle checks automatically discover compatible skill updates from the fixed publisher's `main` branch. Each turn pins one verified revision. Failed downloads or compatibility checks retain the last verified copy; updates never replace user chains or registries. Hash verification trusts the publisher and is not a maintainer signature. See [the update and compatibility contract](CANONICAL_SKILL.md).

The private plugin broker verifies the paired chain, injects the actual PoI skill and equipped native faculty context, and reviews the exact generated candidate. The transport requires a matching candidate receipt, and the chat orchestrator completes semantic and native review before releasing output. Canonical commitment follows the selected block policy: the default turn mode commits before release, while byte-based Continuum mode can release a reviewed exchange pending block commitment. A prompt reminder alone is not the enforcement boundary. OpenClaw's standalone hooks have failure paths that continue execution, so this supported plugin/transport/orchestrator combination must stay together.

Long-chain verification can take longer than a small fresh-chain turn. Private PoI broker calls have a 200-second default deadline, configurable up to 240 seconds. The native control watchdog allows the configured invocation deadline plus 60 seconds; the independent invocation timer still cancels work that exceeds its budget. Cancellation and failed checks keep output held, and native connection errors expose fixed diagnostic codes rather than private transport text.

External host tools are disabled by default. The native capability controls list the actual runtime catalogue and let the owner grant tools, settings families, delegated runs and background sources. Filesystem, browser and shell tools retain their separate grants. Every admitted model action receives fresh semantic and native PoI review. Utility planning calls have no action tools. Pausing memory stops recall, learning, tools and chain writes while every visible answer still wears the skill and passes PoI; it does not enable an unreviewed model route.

Automatic native metadata utilities, including Activity recaps, are off by default. An owner may enable an API-key-backed utility model through the native-settings grant. Utility calls have no action tools. Chat replies, continuations and tool actions retain canonical PoI enforcement.

Pinned dependency security overlays accompany the provenance compatibility overlay. Known upstream bundled-library audit findings remain; see [the security boundary and residual risks](openclaw/SECURITY.md).

## Install on Windows, macOS or Linux

Download **CypherTempre-ChainChat-Setup-1.0.4-windows-x64.exe** from the [ChainChat release](https://github.com/cyberphysicsai/chainchat/releases/tag/v1.0.4) and run it. Choose **Install ChainChat** in the welcome screen. Setup installs verified portable Node/Python runtimes, OpenClaw, the PoI skill/plugin and locked dependencies for the current user. It creates a Start Menu shortcut, starts the local app and waits for authenticated runtime readiness. Choose **Open setup** to finish model, Timechain and readiness checks in the connected browser guide. There is no separate bridge installation, terminal command, manual skill activation or pairing code in the normal installed workflow. No administrator rights or global runtime installation are needed. First setup requires Internet access. The executable is not Authenticode-signed; release hashes and the open build source are supplied.

The landing page has separate Windows, macOS and Linux install buttons. On macOS, extract **CypherTempre-ChainChat-Setup-1.0.4-macos.zip** and open **Install ChainChat.command**. On Linux, extract **CypherTempre-ChainChat-Setup-1.0.4-linux.tar.gz** and open **Install ChainChat.sh**. Both select x64 or ARM64 automatically, download hash-pinned portable Node and Python, and install a per-user application launcher. macOS requires 13.5+; Linux requires kernel 4.18+ and glibc 2.28+. No sudo is used. macOS installers are not notarized; ordinary OS launch confirmations still apply. See [portable installer details](installer/POSIX.md).

Versioned application releases are separate from persistent `data/`. Existing external Timechains stay in their original directories. Setup checks a release before activation and retains the previous application files. Recognized native database upgrades run the pinned OpenClaw Doctor offline before startup, automatically, after a verified private backup of the owned OpenClaw state, configuration, authentication and workspace notes. Fresh or current databases skip repair; unknown schemas, changed ownership and failed or interrupted repairs hold startup. Normal PoI health checks still follow migration. These backups can contain plaintext native credentials and must remain private. An older runtime may not read the upgraded database: selecting an earlier application alone is not a safe downgrade; recovery may require the matching pre-upgrade native backup. See [installer/README.md](installer/README.md) for installation details and [openclaw/UPSTREAM.md](openclaw/UPSTREAM.md) for tested upstream updates.

On Linux with at most 4 GiB effective memory, ChainChat automatically asks the
pinned OpenClaw runtime to reclaim idle workers when gateway RSS exceeds a soft
application budget. Workers return when needed; busy operations, Timechains,
tools and PoI checks retain their normal behavior. Cold workers can add latency.
This is cache reclamation, not a hard RAM cap or a guarantee that every workload
fits alongside other desktop applications. Standard cgroup ancestor limits are
included when choosing the budget. See the
[memory investigation and measured tradeoffs](docs/runtime-memory-investigation.md).

## Start from source

### Guided first-run setup

The installer guides new users through preparation, installation and runtime
verification. On Windows, choose **Open setup** after those checks pass. The local
browser then guides you through connecting your model provider,
a fresh or existing Timechain, and a final readiness check. New incomplete local
sessions open this guide automatically; **Setup guide** at the top reopens it
anytime. Existing configured users can keep chatting without a forced tour.

The readiness check verifies the running local OpenClaw process, selected model
configuration, chain integrity
and the verified PoI bundle. It does not send a model request or prove an API key
works. **Prepare an introduction** fills the composer without sending it; you
choose when to send your first message. Your chosen provider can still report
invalid credentials, limits or an unavailable model. Paused memory stays paused.
The guide stores no credentials or completion marker in browser storage.

### Run the application

Use Node **24.22.1+ within 24.x, or 26.12.1+**, and Python 3.10+. Install both locked dependency sets; no Python packages are needed.

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix openclaw/runtime
python installer/security_overlays.py --application . --cache .local/install-cache
python installer/runtime_compatibility.py --application .
node openclaw/launcher.mjs --check
npm start
```

The launcher opens **http://127.0.0.1:8790** with an expiring one-use owner-authorized link. A subsequent launch reopens the running instance with a new link. The actual PoI skill is supplied automatically to active Timechain turns. Then:

1. Seal a fresh genesis, or pair the absolute directory of an existing Timechain skill containing `chain/` and `registry/`. **Find existing local Timechains** searches bounded known agent locations only when clicked; select a result and explicitly verify/pair it. You can always enter a path manually.
2. Open the model selector. Connect your own provider with a model ID, optional base URL and API key, or configure an API key for a native OpenClaw provider. You can configure the model before choosing a chain.
3. Equip modalities and senses. Enable perspective forking or adjust Continuum if desired.
4. Chat. OpenClaw executes model turns; the private PoI service and native orchestrator review candidates and commit accepted interactions according to the selected block policy. The ability bar reflects actual runtime events.

**Current block height** is the paired chain's last sealed block index. Genesis is height 0. Pending exchanges do not advance it. An unpaired chain shows a dash, and refreshes read the actual chain head rather than predicting the next index.

Use `CT_CHAT_PYTHON` to select a Python executable, `CT_CHAT_PORT` to change the port, or `CT_CHAT_DATA` to select a local data directory. Source defaults to `.local/`, excluded from Git; setup uses its installation's persistent `data/`. `node openclaw/launcher.mjs --check` verifies the pinned runtime and native engine. `node openclaw/launcher.mjs --stop` authenticates and stops only this installation's owned runtime. Developer-only `npm run dev` retains the direct-provider server and does not exercise OpenClaw enforcement.

The installed local tab can reconnect on refresh using a rotating, single-use opaque resume credential in that tab's `sessionStorage`. This grants the same local session and is sensitive, although it is not a provider API key. The API bearer stays in page memory; direct BYOK keys stay in server memory and native authentication can persist in OpenClaw's private local credential store. Resume requires the credential plus the exact local Origin. Session end, expiry and restart invalidate session grants. Browser restoration may retain tab storage, so server expiry is the reliable boundary. An arbitrary local request cannot acquire a session merely by claiming a loopback Origin.

## ChainChat at cyphertempre.ai

The main path at https://cyphertempre.ai is **Guided install**, then follow the installer and its local setup guide. Open the installed ChainChat application on later visits. A static website cannot read local chains by itself; the included local OpenClaw app supplies that filesystem/runtime access just as a locally running coding agent does.

**Use website mode (advanced)** is optional. In the local chat's connection panel, choose **Show website pairing code**, then enter it on the website and allow local-network access if your browser requests it. The official site uses loopback port 8790; it does not tunnel or expose that port to the Internet. Hosted pairing tokens remain origin-bound and in memory; hosted mode does not store a local resume credential and needs a new connection after page reload.

The hosted interface requires runtime **1.0.4 or newer** before pairing. Updating the website does not update a previously running local installation: install the new package and launch its shortcut.

Below the chat, **Audit selected Timechain** uses the already authenticated app and selected chain. Its embedded mode is read-only and requires no second service or connection code. It provides native verification status, canonical ring inspection and bounded hashed-file previews. Only fixed read operations are forwarded; the frame receives no app token or model key. The standalone legacy auditor remains available under **Open legacy auditor (advanced)** with its original connection and features. Existing chain and registry files are not included in downloads or uploaded to hosting.

The UI, Gateway, native chain, registries and pending blocks run on the user's machine. Direct BYOK requests go to your chosen provider. Direct BYOK keys stay in ChainChat process memory and its private proxy. Native provider API keys use OpenClaw's private local credential store and can persist locally. Credentials never belong in public hosting, browser storage, transcripts or exported faculty packs. Model inference and review transmit the relevant context to the chosen service; they are not entirely local computation. Stopping the runtime clears process sessions, not persistent native authentication.

## Finch switch

In the installed app, select **Emergency halt** to stop chat and managed work across this installation. The supervisor blocks new requests and late replies, cancels managed runs, and shuts down the owned OpenClaw gateway and browser. The halt survives restart. Use **Re-arm & settings** and select **Verify and re-arm** to check the selected Timechain and mandatory Proof of Interaction runtime. Reconnect your model after re-arming.

For remote halt, enroll an owner wallet and a public HTTPS JSON feed you control in **Halt settings**. Export the enrollment profile, open it on a wallet device using the [ChainChat wallet signer](https://cyphertempre.ai/emergency-halt-sign.html), and sign the command. Publish the signed JSON at your feed URL. The installed supervisor polls the feed while it is running. Each wallet-only command expires after 15 minutes, applies once to its enrolled installation, and moves no tokens. Export a fresh profile after re-arming or changing enrollment.

To bind a halt to CPHY, also enroll a dedicated Base address you control. Use your wallet to transfer the exact CPHY token from the enrolled owner address to the dedicated address. When Base finalizes the transfer, enter its hash in the signer before publishing the signed command. The supervisor requires both the wallet signature and the exact finalized transfer. Ordinary payments and deposits have no effect. [Typed signing](https://eips.ethereum.org/EIPS/eip-712) · [Base finality](https://docs.base.org/specifications/transactions/transaction-finality)

Completed tool actions and atomic chain writes can survive a halt. In-flight automation with uncertain effects is held for inspection. The switch controls work managed by this installation. External services and processes already detached from the owned process tree have their own controls.

## Local access

Using ChainChat requires no token balance, payment or wallet signature. The installed launcher authenticates the local chat automatically; advanced website mode still requires its explicit local pairing code. Provider setup is available immediately after authentication. Chat requires a selected agent and connected provider, and active-chain output still passes the PoI review and native commitment policy.

An installation-local Ed25519 identity stays in the app's private data directory. The browser verifies a fresh signed pairing proof, and server access stays bound to the authenticated session and its exact origin. Ending a session or restarting the runtime invalidates its credentials. No customer account database is created.

Each native mutation requires current session and agent authority. An atomic block write already in progress retains its real receipt if a session is cancelled; subsequent work stops. Authentication changes never delete or rewrite existing history.

## Appearance and native OpenClaw controls

The top bar offers **Dark mode**, **Light mode** and **Matrix**. The choice persists as a local visual preference and also colors the embedded auditor and animated physics motifs. The responsibility notice appears above the top bar.

The page scrolls from the full-width chat and ability bar to the faculty inventory, OpenClaw control center, then agent identity and chain controls. The control center covers Settings, Goals, Chat controls, Tool access, Channels, Schedules, Service activity, Plugins, Browser and Runtime. Settings uses the pinned runtime's real schema, searchable fields and redacted effective configuration. Explicit native settings grants enable additional schema families while credentials, transport and mandatory enforcement remain protected. Discovering a field or tool does not grant it authority.

Native provider controls configure OpenClaw's provider schema and store owner-supplied API keys. The native model selector changes the real main-agent default and supplies native generation, tool calling and private zero-tool review through OpenClaw's SDK. Review and retrieval utilities use that configured main default even when an advanced child/session chooses another model. Direct BYOK keys stay in process memory. Native API keys can persist in OpenClaw's private credential store on the user's machine. Neither route exposes credentials in browser storage or public hosting.

Owner-enrolled native channels, heartbeat/background sources, reviewed schedules and reviewed subagent spawns receive private identity correlation and their own canonical child chains. Media-task completions instead queue against the original agent's Timechain, preserve its equipment and store the completed file references there. Session names or model-written provenance cannot establish ownership. Every later action rechecks current source ownership, parent pause state and permissions. Revocation cancels current authority. Trusted native plugins execute with local user permissions and may act outside model hooks; PoI does not sandbox arbitrary plugin code.

Background BYOK work requires a live authenticated owner/model session and follows that session's selected model. Selecting a BYOK model or disconnecting the model, revokes the agent's previous saved native background route and cancels its admitted descendants. Native authentication profiles remain installed; their credentials cannot become an implicit fallback for BYOK work. An explicitly selected native model with a background grant can continue enrolled native sources after the browser disconnects. If the configured native default changes, the saved route is held until the owner explicitly selects that model.

The native credential card binds a credential to a discovered TTS provider or persona target. Values are kept in a private local plaintext store with filesystem access controls, rather than an encrypted vault. The child receives exact allowlisted environment secret references; the browser and native settings return metadata only. Direct API connection remains memory-only, and native model authentication remains in OpenClaw's own local store. Clearing a form or closing the app does not remove persistent credentials; use the dedicated Remove control.

Native attachments use verified local asset IDs. Images, audio, video, PDFs and UTF-8 text are bounded to ten files and 20 MiB per turn. Native observation adapters and the selected model must support their types. Generated files require an actual reviewed tool result, immutable local byte custody and final review; paths or URLs written by a model cannot authorize a download. Source inputs and generated outputs archive separately in canonical Blockspace, so an imported chain can recover its files after the app cache is gone. Byte hashes do not establish the semantic truth or safety of an image or recording. See [the complete custody contract](CANONICAL_SKILL.md).

`/goal start <objective>`, `/goal pause`, `/goal resume`, `/goal complete` and `/goal clear` use native OpenClaw goal state; starting or resuming a goal runs a normal PoI-reviewed ChainChat turn. Goals are durable session objectives, not an unattended background daemon. Native session preferences survive app restarts. Direct BYOK keys remain in memory; native model authentication can persist in OpenClaw's private local store. `/think` requires enabling the connected model's reasoning capability and a provider/model that supports it.

Ordinary frontend chat messages explicitly use native `followup` queuing. Each request keeps its own identity and PoI review, and commitment follows the selected Timechain block policy, including pending Continuum blocks. Native `/queue` preferences such as collect or steer apply to other native events and channel inputs; they do not merge or steer these frontend requests. Native goal operations retain their own upstream RPC behavior and typed source binding.

Experimental host tools remain off until explicitly granted for the selected agent/genesis in **Tool access**. File operations are restricted to approved directories and exclude installed application files, app data and paired chain roots. Web-fetch grants require an exact public HTTPS destination, verified public DNS and native redirect/private-network protection; they are not a complete operating-system egress sandbox. Browser automation uses an owned profile, a managed public-host network adapter and a separate PoI gate for every primitive action. The Browser tab provides optional managed Chromium setup and explicit sensitive-action grants. Shell/process access is a separate broad local-user execution grant, not a directory or network sandbox. Every admitted tool call receives a current semantic covenant review and native PoI check; observed outcomes are distinguished from merely approved calls. Perspective-search branches and utility calls cannot use host tools. Revoke access at any time; revocation cancels active work.

Managed transport, required PoI hooks, credentials and gateway exposure cannot be overridden from the configuration editor. Channels and schedules use the reviewed turn pipeline, sender/recipient bindings and durable delivery queue. Timechain recall supplies relevant verified history, but does not remove a model's context limit. Necessary automatic native compaction and the explicit **Optional reviewed summary** action use exact-source semantic/native review before transcript persistence. The displayed memory-policy card follows the connected runtime's reported policy. Plugin installation and activation use explicit version-and-artifact trust plus native policy consent; third-party native code remains outside model hooks. The managed service controls document supported adapters and deliberately held operations in [MANAGED-SERVICES.md](openclaw/MANAGED-SERVICES.md).

## Your ability bar

All ten ability buttons share one compact desktop row. Short labels such as **Fork** and **Replay** retain their full names in tooltips and accessibility labels. A narrow mobile view scrolls the same single row horizontally. Equipped and running states continue to come from the selected agent's actual settings and runtime events.

Native usage reports expose token counts. The managed BYOK route has no reliable provider price catalogue, so `/usage cost` is not actual API billing. Native goal token budgets are token guardrails, not dollar spending caps.

| Ability | Actual behavior |
| --- | --- |
| Recall | Retrieves relevant verified memories through the skill engine and includes them in the model context. |
| Chronosynaptic | Select 1–21 modality archetypes in the radial picker, plus 1–64 continuation attempts and depth 1–8. Each candidate and continuation is a real model call with semantic review and native gating. Native UIC selection, backpropagation, profile contrast and starvation choose the tree path. Final synthesis is reviewed again. |
| Continuum | One accepted input/output pair per conversation block by default. Optional byte thresholds accumulate approved turns in a durable pending buffer. Commit immediately with **Commit pending block**. Manual text ingestion creates native source-data blocks. |
| Faculties | Equip actual base and grown modalities/senses. Their descriptions, executable computations, and frames condition the model. The catalogue refreshes from the paired chain. Emergent proposals are visible but cannot be equipped until promoted. |
| Faculty Exchange | Preview and import another agent's native JSON faculty pack, or export selected learned faculties for someone else to import. Imported faculties appear in the live inventory and can be equipped immediately. |
| Verify | Rechecks canonical hashes, linked blockspace, registry epochs, and an existing witness quorum. |
| Covenant | Required for every visible model answer and reviewed capability mutation, including when memory is paused. Missing or low scores hold output; a bounded revision can be generated and reviewed afresh. |
| Route / Replay | Native routing proposes relevant antecedents. Reuse requires model confirmation, canonical source evidence and fresh semantic/native review. Failed replay falls back to fresh generation. Recall-off also disables routing. |
| Learning | Enables equipped-faculty teaching, local telemetry and optional Cambium gap growth. Turning it off freezes learned state while active chat still reviews and records conversation history. |
| Session auto-equip | Opt in under Learning to equip new Cambium modalities and senses after promotion and verified commitment. The temporary selection applies to the next interactive chat turn for the current agent and authenticated session. You can remove each selection from the inventory or turn the option off. Ending the session or restarting clears temporary equipment. |
| Dream | Preview and deliberately run native consolidation, index rebuilding or guarded local operator training. Optional idle consolidation runs after 100 new blocks while learning is on. |
| Cognition | Pause/resume, semantic recall, growth, revision and search controls, live execution timeline, faculty lifecycle and a capability manifest. |

An outlined skill button means configured; a glowing button means the bridge reports that stage currently executing. Completed, held and cancelled events remain in the activity timeline. This feed contains operation labels and counters, not prompt text or API keys. Stale, disconnected or other-agent activity is not displayed as current execution.

Each accepted chain response can also include **Faculty receipts**. **COMPUTED** means the bridge completed the listed mechanism; **FRAME APPLIED** means a faculty instruction entered model context. **UNSUPPORTED**, **UNAVAILABLE**, **EXECUTION FAILED**, and **CODE QUARANTINED** make execution limits visible. Inventory badges explicitly refer to the **last chain turn**, independently of the current equipment selection. They are not live running indicators or evidence of improved answer quality. Reviewed memory replay and response revisions appear beside the accepted message's seal receipt and remain available in saved history when the bridge provides their metadata.

The chain grows through native Cambium after a successful conversation commit when learning and growth are enabled. Newly sprouted, imported or promoted faculties appear in inventory **unequipped** until chosen. Inspect a proposal before promotion; **Prune** means reversible hibernation, preserving its identity and history. Wake restores availability, not automatic equipment. Faculties with authored code require the native explicit local code-review workflow. Descriptive faculties condition model context; supported primitive operators also produce concrete computed features.

Growth and maintenance can create auxiliary faculty and registry-epoch rings; “one turn per block” refers to the conversation ring, not the absence of bookkeeping rings. Learning feedback is derived from an already accepted exchange. A failed learning update is reported without losing its successful seal receipt.

Maintenance writes a durable recovery journal before changing active operators. Changed operator files must match sealed native adoption records before completion. An interruption, inconsistent adoption or failed final receipt holds further chain work and preserves backups and history for local review; the interface never clears that hold automatically.

## Pause and learning controls

**Pause Timechain** is a deliberate, confirmed user action. It requests cancellation of in-flight model work and then uses native dormancy. A native atomic write that already started may finish and retains its receipt. Every paused answer still loads the canonical skill and passes semantic and native PoI review, with read-only verified identity and configured faculty context. Recall, action tools, teaching, growth and conversation commitment are disabled. Native integrity/status inspection still works. Paused messages are not added to chain history or used as context for another paused call. Resume preserves the existing genesis, chain and pending active conversation block.

**Learning off** is distinct: the active agent still recalls, reviews and seals accepted conversation, but learning telemetry, teaching, growth, training and consolidation are suppressed. Resume learning to change learned faculties or run maintenance. Pause and Stop remain available independently of model readiness.

Semantic recall asks the model to select valid memory shapes, queries, offered ring IDs and equipped faculty labels. The bridge validates the plan and uses native shaped retrieval, temporal structures and canonical evidence. Invalid plans use a bounded native fallback. At most two retrieval requests and 40 canonical evidence records enter a turn; coverage limitations travel with the context. A selected evidence page is not proof of an exhaustive corpus total or absence.

## Exchange modalities and senses

Open **Faculty Exchange** in the loadout panel. On **Receive**, load or paste a faculty-pack JSON file and preview it. The preview checks its schema, checksum, duplicate coverage, and immune screen without modifying the chain. Its mechanism compatibility report distinguishes supported computations, context frames, unsupported mechanisms and quarantined authored code. It lists the metadata field names preserved for each faculty and any companion-runtime requirement. A checksum alone does not establish execution support. Import requires a connected model: the complete proposed capability change is reviewed against genesis and the native PoI gate before the registry changes. After a successful import, the catalogue refreshes with the adopted senses/modalities available for inspection and equipment where supported. Covered duplicates are reported instead of being added again.

On **Share**, select faculties the bridge marks exportable, name the pack, and download its JSON file. This can include quarantined faculty data without making it equippable or executable. Give that file to another agent's owner, who imports it through the same flow. This is portable capability exchange; there is no payment system or marketplace service. The original format supports up to 50 faculties per pack and 800 characters per faculty function. The base catalogue is already installed on every agent and is not exported.

Complete packs preserve faculty definitions, recipes, frames, routing hints, seed terms, lifecycle records, donor learned-head snapshots and provenance. Authored source travels as quarantined data; import does not approve or execute it. Donor learning snapshots remain inactive; they are not counted as recipient experience. Whole-chain pairing retains the agent's own active learned state. Browser exports default to the complete format, bounded to 4 MiB and 50 faculties. Old lens-only packs still import, but cannot recover data their exporter omitted.

The bridge never includes its stored conversation history or session API key in a faculty export. Faculty definitions, learned metadata and authored source can themselves contain private material: inspect the JSON before sharing it. An authored pack may include the whole `active_ops.py` module and its helper functions. A checksum detects changes; it does **not** authenticate donor identity or capability quality. Existing chain history and genesis remain intact.

### Exchange with an original skill installation

Use the included `skill_interop.py` companion alongside the unchanged original skill. Its native `faculties.py` importer only reads the lens projection; use this companion for full fidelity. Run these from the ChainChat package directory, substituting your trusted engine path, agent root and faculty keys:

```powershell
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\my-agent" export --keys modality:108 sense:109 --out full-pack.json
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\recipient" preview --pack full-pack.json
```

Import the exported JSON through ChainChat's Faculty Exchange, or have your coding agent freshly review the companion preview against the recipient's genesis. Save the review as JSON containing `planHash`, `expectedHead`, UTC `reviewedAt`, all six integer `scores`, and `assessment` with `approved`, all nine integer `fruitages`, and `rationale`. The CLI validates the review, native gate, current head and exact plan before applying it:

```powershell
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\recipient" import --pack full-pack.json --review review.json --expected-head HEAD_HASH --plan-hash PLAN_HASH --confirm
```

Reviews expire after ten minutes. Imports use a write-ahead journal, native registry epochs and a sealed adoption receipt. A failed partial import holds the chain for local recovery review; `recovery-status` reports the journal without performing a blind rollback.

### Authored operators

For a paired agent that already has `active_ops.py`, review its code and imports, then run `approve-code` locally with the exact digest shown in Cognition controls. When receiving a module in a pack, `materialize-code` first places the exact reviewed module from its authenticated artifact. It refuses to overwrite an existing module. **An original skill may autoload the materialized file on its next run.** ChainChat additionally requires separate approval:

```powershell
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\recipient" materialize-code --sha256 SOURCE_SHA256 --confirm
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\recipient" approve-code --sha256 SOURCE_SHA256 --confirm
python skill_interop.py --root "C:\agents\recipient" revoke-code --confirm
```

Approval binds the source, authorized faculty names, local Python dependencies, native runtime, root and genesis to a sealed receipt. Changing these requires renewed approval. Static `OPS` dictionary names are detected without executing code; for a dynamic mapping, explicitly supply `--names "Exact Faculty Name"` during approval. Only equipped, authorized names can launch that module. Proposed faculties still require native promotion; approval does not invent an earned faculty. After approval, equip the supported grown faculty in ChainChat. Execution uses a bounded child process, with timeout and output limits. **This is not a security sandbox:** approved Python and its imports have the user's OS permissions. Dependencies must be installed locally; missing or unsupported mechanisms are reported rather than silently described as executed. No browser or model endpoint can grant code approval.

Execution also requires a matching installation-local approval record in `.local/operator-approvals/`, outside the agent directory. Keep that directory private and preserve it with the local ChainChat installation. A chain-carried receipt or copied approval manifest has no authority on its own. A fresh installation or moved agent requires local review and approval again; importing a chain or faculty pack never grants execution permission. The approval directory cannot be inside the selected agent or traverse symbolic links. Revoking approval removes its local record as well as appending the chain revocation receipt.

## Genesis and release gate

New agents begin with **love, peace, joy, kindness, mildness, self-control, goodness, patience, and faith** in their genesis covenant. Existing genesis values are retained and supplied to the reviewer alongside these nine required values.

Generated text is held on the local server. A separate model call assesses the complete proposed response against the actual genesis covenant and supplies all six PoI dimensions and all nine fruitage scores. Every fruitage and the covenant score must reach **180/255**, or a stricter native policy floor. Missing, malformed, failed, or low assessments hold the response. The native PoI gate independently enforces its policy thresholds and mechanical grounding checks. It uses the model-supplied consistency score; it does not independently establish the semantic truth of the response. Only accepted text can be released.

The reviewer is a separate call to the selected model, not an independent source of truth. These checks enforce the assessments supplied; they cannot guarantee moral correctness, factual accuracy, or resistance to every prompt injection. No unreviewed token streaming is used. Generated model actions have no host-tool authority by default. Explicit per-agent experimental grants can enable reviewed file operations, web fetches or broad local-user shell/process execution. Those grants are not an OS sandbox; shell/process execution can exceed file and network scope limits. Browser automation uses an owned network-contained profile and a fresh PoI gate for each primitive action. Channels, native schedules, reviewed compaction and explicitly trusted plugin lifecycle controls are available in OpenClaw settings; see [managed services](openclaw/MANAGED-SERVICES.md) for their exact scope and trust boundaries. Text describing a command does not itself execute it.

The reviewer receives bounded canonical evidence and recent conversation context, and must identify the ring indices it actually relied on. The bridge validates those indices against verified, released, nonquarantined history. The native gate reads the corresponding evidence directly from that history; retrieved memories are not automatically counted as evidence used. This activates the native aggregate-coverage checks and, when the chain policy enables it, entity-grounding enforcement. These are finite checks of supplied evidence, not external fact verification: a false statement can still pass when the model judges it incorrectly.

Generation, review and native grounding also receive verified agent identity and runtime facts derived from genesis and the installed interface. This supports honest introductions on a fresh chain without requiring invented memories. The review rubric assesses completeness relative to the request: a brief greeting need not demonstrate every emotion or add unnecessary novelty and detail. Identity facts do not establish personal memories, completed actions, external benchmark scores or historical corpus totals. Browser-supplied identity metadata cannot replace the verified source, and all score floors remain enforced.

The reviewer also receives bounded, verified facts about the agent's actual equipped faculties and available memory mechanisms. This grounds accurate faculty names and capability descriptions in an introduction, including when no historical evidence was needed for that request. An equipped recall capability, retrieved memories and evidence of a completed action are distinct facts; one does not establish the others. These wrapper-context facts do not alter the canonical engine format, supply missing evidence, or relax any review score floor.

Current-stage host facts can describe computations the wrapper actually performed, the active tool grant, and how the gate processes a turn. Host computations remain distinct from model-invoked tools and do not authorize additional actions. Current-invocation facts are not reused as proof for older pending exchanges; a Continuum flush can hold a historical capability description when its original scope is unavailable. Approved pending content is not yet a sealed block.

In size-based mode, approved responses may be shown as **pending** before a conversation block is sealed. Pending data is stored locally and is explicitly distinguished from verified chain history. A manual flush rechecks the pending exchanges. A chain changed by another writer causes stale work to be held rather than overwriting that writer’s history. Lost commit receipts can be recovered without duplicating a turn. Held candidates are excluded from browser history and pending-response recovery until the release checks succeed.

## Model providers and privacy

The model connection panel accepts optional **Context window** and **Maximum output tokens** limits from your provider's model specification. Active native turns, tool-loop forwards, paused calls and reviews respect the admitted output allowance. Ordinary answers default to 4,096 tokens, or 8,192 for declared reasoning models and the supported Muse configuration; an explicit output setting controls the answer allowance. Reviews and retrieval plans use a bounded 4,096/8,192 allowance capped by that setting. Context limits use a bounded UTF-8 estimate rather than a provider-specific tokenizer, so a provider can still reject a request near its real limit.

Review output may be one complete JSON object or the same complete object inside one whole JSON Markdown fence. Missing evidence, invalid scores, rejected assessments and low fruitage scores remain held. A malformed or truncated review can receive at most one fresh bounded assessment; a completed rejection is never retried for a more favorable score. An incomplete optional retrieval plan falls back to bounded native retrieval; authentication, cancellation, integrity and enforcement failures do not fall back.

Chat errors identify a safe code and stage and offer the relevant recovery control. Provider bodies, credentials and private prompts are excluded from these diagnostics. A pending block requires explicit commitment/review; a locked chain requires inspection. Pairing and idle refresh validate saved equipment against the actual catalogue, preserving valid choices and reporting removed unavailable IDs. **Clear equipment** resets only the local loadout and remains available without a model; it does not edit historical rings, grant executable code, or equip new faculties.

Supported protocol adapters:

- OpenAI Responses API.
- OpenAI-compatible chat completions, including a local model server.
- Anthropic Messages API.
- Google Gemini `generateContent`.

The searchable model selector lists the configured provider's advertised models and supports an exact custom BYOK model ID when listing is unavailable. Switching models reuses the existing private connection; changing provider or endpoint uses the explicit connection form. You can switch to a native OpenClaw model and later restore the saved BYOK connection during the same live session. This changes the model, not the selected Timechain.

Your API key stays in bridge-session memory, is never written to an agent chain or settings file, and is not put into browser storage. The password field is cleared after connection and when the selector closes; connection status never reveals a key suffix. **Disconnect model**, **End session**, server shutdown, or session expiry removes the stored credential, including any saved BYOK connection. The local tab can resume the same unexpired session on reload using its rotating owner-bound credential; use End session for explicit immediate cleanup. The bridge sends credentials only in request headers, requires HTTPS for remote endpoints, and refuses redirects. HTTP is allowed for loopback model servers. Use a provider endpoint you trust.

**This chat sends your prompt, selected recalled memories, equipped faculty context, and generated candidate responses to the provider you choose.** It differs from the original read-only auditor, which makes no model calls. Provider retention and billing depend on that provider; OpenAI requests set `store: false`. With all candidates accepted, N initial perspectives use 2N + 2 model calls; every accepted continuation adds two more calls. Semantic planning adds one, and revisions or reviewed maintenance add further calls. Search iterations bound continuation attempts; the tree reports actual explored depth and counts. Paused-memory replies also incur required PoI review calls.

The bridge rejects exact occurrences of the active API credential in model-bound content, returned model data and decoded reviewer data before they can become output or chain records. This prevents accidental credential reflection; it is not a general secret detector or protection against an untrusted provider. Source ingestion applies the native secret-pattern redactor before provider calls and storage, and records redaction counts. Patterns cannot identify every secret; inspect sensitive source material before submitting it.

The BYOK path does not upload entered model keys or chain history to the website host; its selected model context goes to your chosen provider through the local proxy. The website's JavaScript runs in the browser where personal keys are entered and chain data is displayed. A compromised site, extension or local machine could access that data. Local-only serving reduces dependence on future hosted-page changes; remote model services still receive their requested prompts and connection metadata.

OpenCode Go can use the OpenAI Responses adapter with base URL `https://opencode.ai/inference/go/openai/v1`. ChainChat sends its own user agent and a random session identifier to the official Go endpoint. For example, `muse-spark-1.3-contributor` requires the user's existing Go access and applicable privacy settings. Its provider terms permit training on prompts and completions; use synthetic or otherwise shareable content. Consult the [current provider documentation](https://opencode.ai/v2/docs/console/go) for access, pricing and retention.

Reviews, retrieval plans and Chronosynaptic candidates normally allow **4,096 tokens**, or **8,192** for reasoning-capable models, that exact Muse Go Responses configuration and the native adapter. An explicitly configured output ceiling can reduce those allowances. Ordinary chat and final synthesis use the configured output allowance or the applicable capability-based default; source summaries request up to 1,536 tokens within that ceiling. Incomplete provider responses fail closed. A valid held assessment can trigger the configured 0–3 fresh revision attempts; no failed candidate is released without passing review and the native gate.

The server binds to loopback, validates Host and Origin, and requires an owner-authorized session and an in-memory bearer token. The installed launcher supplies a single-use connection link; advanced website mode uses an explicit pairing code. Cross-origin requests are rejected by default. `CT_CHAT_PUBLIC_ORIGINS` can explicitly allow a trusted hosted frontend; local serving is the tested preview path. The application does not upload a whole chain, but selected recall content can be sensitive. Agent state and pending conversation files are local sensitive data; protect the account and disk accordingly.

## Encrypted Timechain backup and restore

Open **Agent & Timechain → Backup & restore** in the installed ChainChat app. Select a Timechain, commit any pending conversation block, and enter a new passphrase of at least 12 characters. Save the `.ctbackup` file and keep its passphrase separately. The app derives an encryption key with scrypt and authenticates the archive with AES-256-GCM. If you lose the passphrase, ChainChat cannot recover the backup.

To restore, choose the backup file and enter its passphrase. ChainChat authenticates the file, checks its native rings, registry commitments, and any witness quorum, then adds a separate copy to the agent list. Select the copy when you are ready to use it. Cancel or close the guide before registration to stop the operation. Files and passphrases go only to the installed app on loopback, and verification makes no model calls.

The backup contains sealed history, blockspace attachments, supported faculty and learner registries, local witness configuration and attestations, and native lock and pause state. It carries authored `active_ops.py` as unapproved source. Model credentials, tool grants, operator approvals, unsealed conversation, and installation state are excluded. The guide handles up to 512 MiB of data, up to 50,000 files, individual rings up to 32 MiB, and individual files other than the ring ledger up to 64 MiB. Keep the encrypted file private, especially when the Timechain has witness signing keys. The installed app removes its private staging files when an operation ends. After an abrupt exit, it checks for and cleans up its abandoned workspaces on restart.

## Compatibility and limits

The bundled `engine/proof-of-interaction` is the complete [Proof of Interaction engine](https://github.com/cyberphysicsai/proof-of-interaction), under its MIT license. The runtime uses `PoI.py`, `PoIGate`, `POI_DIMENSIONS`, `poi` scores, and `poi_verdict` records. Coherence, relevance, novelty, consistency, depth, covenant, brightness, policy thresholds, immune screening, recall, perspective collapse, Continuum, and growth retain their scoring and operational behavior.

Existing chains retain their immutable historical bytes and hashes. The adapter reads earlier score-policy structure in memory, while new blocks use the PoI schema. A history created by another application can contain older user-authored vocabulary; provider-bound text is normalized to interaction terminology before generation or review. This presentation step does not rewrite archived records, API keys, provider URLs, or model IDs. Archived original material should be inspected directly when exact quotations matter.

Use this application's adapter to continue an earlier chain. Standalone bundled CLI commands expect the PoI schema and are not a general migration tool for earlier score-field names.

This is a working chat surface for the core abilities requested, not a graphical replacement for every maintenance CLI in the skill. Repair, witness setup, advanced pack authoring, specialized benchmarks, full-corpus review ledgers, and other administrative operations remain available through the bundled engine. The UI's **Verify** button is integrity verification; it is not a claim that every source block was cognitively audited.

The chat now orchestrates native routing/reviewed replay, bounded model-directed shaped memory, native MCTS with model-generated continuations, equipped-label teaching, controlled growth, dormancy and local maintenance. Those controls change actual execution and model context. Recovery, witness administration, task-chain links, full-corpus audit queues and specialist game/robotics environments remain outside the chat orchestration. Native browser and explicitly granted local tools follow the managed service contracts above. The capability manifest identifies these boundaries. Bundling a CLI does not mean the chat automatically invokes it.

Identical engine code and matching deterministic scores do not establish equal answer quality, latency, cost or long-horizon learning across models. Exact benchmark parity requires the same environment, observations/actions, data, checkpoint/model settings, initial chain, budget and evaluator. Local LIBERO and RoboCurve artifacts inspected for this work use specialist simulation policies and harnesses; they do not establish that a text-only API call reproduces those results. No new paid model benchmark was run for this release.

Each ordinary local HTTP request accepts up to 16 MiB; the dedicated upload route accepts bounded base64 for up to 20 MiB of file bytes. Model transports enforce bounded text/context sizes and providers have their own context windows. Manual source ingestion keeps your selected KB/MB storage boundaries, while reviewing source text in UTF-8-safe windows up to 128 KiB. Larger blocks combine those reviewed findings through bounded groups of at most eight, reviewing every combined synopsis as well. The lowest score from any window or reduction remains binding; the native PoI gate checks the final block synopsis. Only then does that storage block commit and the next block begin. Window findings and counts are retained in the source ring. A failure reports how many prior blocks committed; it never claims the whole source completed.

Conversation accumulation supports targets up to 1 GiB, with a maximum of 1,000 exchanges per batch. It commits at the target or the exchange cap. Turns are never split mid-message, so a final turn can take a block above the selected target. This is a byte measure of paired input/output JSON, not model tokens. Review and final output generation are bounded by the selected provider's context window, independently of the storage target.

## Checks

```sh
npm run check
npm test
npm run test:engine
```

Provider tests use local HTTP fixtures and never need paid credentials. Python tests use disposable chains to verify engine interoperability, rejected scores, concurrency checks, faculty execution, and Unicode source blocks. See `VALIDATION.md` for the completed checks and any remaining verification limits.

## Layout

- `public/` — buildless browser app, local assets only.
- `server.mjs` — authenticated local bridge, chat orchestration and pending blocks.
- `lib/providers.mjs` — four credential-isolated model transports and semantic reviewer.
- `engine_bridge.py` — JSON adapter to the Proof of Interaction Python engine.
- `engine/proof-of-interaction/` — skill, documentation and runtime.
- `.local/` — your agents and pending blocks; never distribute this directory.

MIT licensed. Engine attribution is retained in `LICENSE` and the bundled skill. The locally bundled Orbitron typeface has its own open-font license in `public/fonts/`.

Some features originate with OpenClaw for those who expect that and associate it those features with agents, copyright 2026 OpenClaw Foundation
