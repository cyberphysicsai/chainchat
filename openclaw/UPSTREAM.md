# Upstream maintenance

OpenClaw is a pinned runtime dependency, not a copied source tree. Most ChainChat
changes live in this application's plugin, launcher, adapter and UI. One explicit
metadata-only overlay forwards existing `params.inputProvenance` and
`params.currentSourceTurnId` into the same two early hook contexts in the
extracted runtime. The original npm archive/SRI remains
unchanged; the installed files have separately committed original and final
SHA-256 values. A separate API-key policy overlay holds built-in channel
provider login and suppresses native auth-status usage probing. The MIT license and dependency notices remain in the installed
package. The canonical Timechain engine has its own
independent source commitment and compatibility tests.

Two security backports have separate installed-file commitments:
`runtimeSecurityOverlays` covers the 18 embedded Zod files, while
`npmSecurityOverlays` covers ten files in npm's private dependency tree.
The Glob default-entry shims use its same-version raw exports; its raw walker
and standalone Minimatch retain the existing APIs with reviewed upstream fixes.
Original archives, package version metadata and licenses remain available.
Doctor, offline migration and Gateway startup attest every patched file before
native execution. See [the remediation evidence](SECURITY.md).

`upstream-lock.json` records the exact OpenClaw version and npm integrity. The
runtime `package.json` and `package-lock.json` must agree with that commitment.
`dependencyOverrides` records reviewed exact dependency patches applied through
npm overrides while retaining the original OpenClaw archive. The runtime
manifest, lockfile, installed packages and installer must agree on those pins.
`bundledDependencyOverlays` separately commits exact official same-major
dependency archives for copies bundled inside npm. The installer verifies both
npm SRI and SHA-256 before safe extraction, executes no package scripts, and
doctor checks the final installed copies. Keep the published npm lock evidence
intact and report these installed replacements separately from its raw audit.
`bootstrapNpm` pins the official npm archive by SRI and SHA-256. Verified Python
constructs the patched npm before the first dependency installation, without
extracting Node's original npm subtree. `npmSecurityProfile` is SHA-256 over the
canonical sorted JSON of `bootstrapNpm`, `bundledDependencyOverlays` and
`npmSecurityOverlays`. Its prefix selects a new portable Node directory; do not
rewrite another release's runtime directory. Repeat setup verifies the entire
replacement tree against freshly reconstructed expected bytes. CI and source
installation also use this secured CLI.
The Windows, macOS and Linux Node/CPython versions and archive SHA-256 values are pinned
in the same file. Setup refuses a different upstream version or damaged archive.
Windows uses the official embeddable CPython 3.15.2 archive. macOS and Linux
use Astral's CPython 3.15.2 standalone builds from its 20261026 release.

`runtimeCompatibilityOverlays` records two exact groups for OpenClaw 2026.11.3.
`early-hook-input-provenance-v2` covers two early hook files.
`api-key-channel-auth-v1` covers the shared raw `/login` dispatch, built-in
command registry and native auth-status handler. The installer validates all
five inputs before publishing any replacement and accepts exact original or
exact reviewed output bytes. Launcher doctor and Gateway require all five
final hashes before startup. The metadata overlay preserves typed
asynchronous task provenance and original client-nonce correlation at mandatory
early admission; message text or transport acknowledgment grants no authority.
On each upstream update, inspect the public hook contract and remove the overlay
when upstream supplies both fields, or
deliberately review new exact files and anchors. Never apply fuzzy replacements
to a different release.

An update is a reviewed release, not an unattended merge of executable code:

1. Read the upstream release notes and security advisories. Select an exact
   release; do not replace the pin with `latest`, a version range or a mutable
   Git branch.
   Run `npm audit --omit=dev` against the locked runtime tree and review the
   affected paths. npm's published bundled dependencies are not replaced by
   ordinary overrides; patching a top-level dependency does not clear findings
   in npm's bundled copy. An audit count is not a behavioral security proof.
2. Update the runtime dependency and lockfile, then update `upstream-lock.json`
   from the official npm metadata. For a Node/CPython update, verify the official
   checksum/signature metadata and update its exact URLs and SHA-256 values.
   Review every dependency override against the new upstream release; remove it
   only when the resulting locked dependency is patched and verified.
   Preserve or deliberately revise the exact downstream dependency overlay.
   Re-inventory embedded and default compiled entry points, not only package
   manifests. Keep backport helper constants, both startup verifiers, lock
   descriptors and the derived npm security profile consistent. Remove a
   backport only when every relevant executable copy includes the fix, and
   retest hostile input plus normal behavior through both default/raw exports.
   Run `npm audit --omit=dev`, inspect embedded library versions, and review the
   residual notices in `SECURITY.md`; external overrides do not fix embedded code.
3. Run plugin hook-contract tests and a real gateway smoke test with local model
   fixtures. Exercise a rejected tool action and rejected output, interrupted
   turns, retries, paused learning, credential isolation and fresh identity.
   The default direct tool surface uses `tools.toolSearch: false`. If the owner
   admits Tool Search, discover its actual synthesized controls through the
   public native tool factory and verify that `dispatch_action` traverses fresh
   PoI review for both the wrapper and its real target. A dispatcher grant must
   never confer an ungranted file, shell, browser or other primitive authority.
   Verify native goal completion, deterministic command delivery, reasoning
   capability restoration and model switches across a full app restart.
   Revalidate the reviewed context-engine contract, retained accepted-turn
   advancement store, every provider's stripped private route capability,
   and actual factory-fault denial before any deterministic legacy write.
   Verify the guarded factory health and commit fail-stop contract, and both
   automation clients' proxy-only authentication without origin credential leaks.
   Exercise actual
   native browser tool loops and per-child denial, scheduled signals, channel
   ingress/delivery revocation, and exact-artifact plugin trust/restore.
   Keep native browser execution in its upstream plugin owner scope; review the
   public before-tool, result-persistence and context-engine contracts before
   adopting a new runtime. Compound calls must not bypass primitive admission.
4. Run native chain/registry verification and original-skill round trips. No
   upstream update may rewrite old rings or replace the paired chain with an
   unrelated chat-memory format.
5. Build the sanitized application and installer, validate their hashes, and run
   setup twice into an isolated installation while checking existing data bytes.
   Do not activate a candidate that cannot pass the installed runtime check.
6. Publish the tested package and pin together. Preserve the previous immutable
   release so the launcher can select it for recovery. Back up persistent state
   before adopting any intentional, separately tested schema migration.

Upstream patches improve the inherited runtime only after a compatible update
has been tested and distributed. They do not automatically audit ChainChat's
plugin, enforce a model's semantic judgment, or guarantee benchmark scores.
