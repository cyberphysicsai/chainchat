# ChainChat release validation

ChainChat builds and tests Windows x64, macOS on Apple silicon and Intel, and
Linux on x64 and ARM64. The [ChainChat Actions workflow](.github/workflows/chainchat.yml)
runs the Python and JavaScript suites, exercises the pinned OpenClaw runtime,
and checks the installer on each native runner.

The compatibility tests verify that existing Timechains can be read and that
accepted replies still pass Proof of Interaction before they are committed.
Provider routing fixtures verify catalogue and chat traffic with owner-supplied
credentials, prevent implicit model fallback, and exercise the native provider
route. These fixtures use controlled providers and establish integration
behavior rather than model quality.

The canonical packaged skill version and update policy are described in
[Canonical Proof of Interaction runtime](CANONICAL_SKILL.md). For an independent
historical chain fixture, the workflow also checks a fixed source revision of
the original public skill. Prior ChainChat validation stays with the
[0.10.3 source](https://github.com/cyberphysicsai/proof-of-interaction/blob/4fda42928c5d46e50ead4e036a5e1c4fdb8a952e/apps/cypher-tempre-chat/VALIDATION.md).

Installer manifests and SHA-256 checksums accompany the
[release downloads](https://github.com/cyberphysicsai/chainchat/releases).
