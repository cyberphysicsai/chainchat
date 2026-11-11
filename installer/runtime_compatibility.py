"""Apply exact metadata and API-key policy overlays to reviewed OpenClaw.

The original published archive/SRI is retained. Only already-private typed
inputProvenance and currentSourceTurnId values enter the existing early hook context.
The API-key policy holds channel login and skips provider usage queries.
Unknown source bytes, links, versions or manifests fail closed; no network,
model text, credentials, source evaluation or lifecycle scripts are involved.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import uuid

VERSION = '2026.11.3'
IDENTITY = 'early-hook-input-provenance-v2'
METADATA_PATCHES = (
    ('dist/embedded-agent-F7NpHcMm.mjs',
     'b5ceac9f43ddedf372fc994a4ded3a0b10ce79aeea8520316c7a08eb9cb07d78',
     'ca25bb54487aef08352019ccae8abba67cd6b1b0ecddf39a4626881d2eceef3b',
     '\t' * 9 + 'trigger: params.trigger,\n' + '\t' * 9 + '...buildAgentHookContextChannelFields(params),',
     '\t' * 9 + 'trigger: params.trigger,\n' + '\t' * 9 + 'inputProvenance: params.inputProvenance,\n' + '\t' * 9 + 'currentSourceTurnId: params.currentSourceTurnId,\n' + '\t' * 9 + '...buildAgentHookContextChannelFields(params),'),
    ('dist/cli-runner-DR6cu3XG.mjs',
     '93908e0144dd44781aa0bf66b0d984dd397232eb35d18bca3120d7ef899b13bc',
     'a7794c68daf999cdbf686a931f7707632fb9058f4721c1088bd4f7e361ea8a47',
     '\t' * 3 + 'heartbeatEventQueueSessionKey: params.heartbeatEventQueueSessionKey,\n' + '\t' * 3 + 'sessionId: params.sessionId,',
     '\t' * 3 + 'heartbeatEventQueueSessionKey: params.heartbeatEventQueueSessionKey,\n' + '\t' * 3 + 'inputProvenance: params.inputProvenance,\n' + '\t' * 3 + 'currentSourceTurnId: params.currentSourceTurnId,\n' + '\t' * 3 + 'sessionId: params.sessionId,'),
)
POLICY_PATCHES = (
    ('dist/provider-auth-login-flow-runtime-B18ky3JD.mjs',
     '9fe0edd695bbcc8bcee55f3e62d532251ca51ccdc9737b3f39a979aa31826085',
     'de9f6aac48d84f1754fdd6fda69802d0d6ef0908b2c053db61bcf21a6a92acab',
     '\tif (!match) return null;\n'
     '\tparams.signal?.throwIfAborted();\n'
     '\tif (!params.hasAdminScope',
     '\tif (!match) return null;\n'
     '\tparams.signal?.throwIfAborted();\n'
     '\treturn { status: "reply", reply: { text: "Use ChainChat Models to configure a provider API key." } };\n'
     '\tif (!params.hasAdminScope'),
    ('dist/commands-registry.data-B0OqwBdv.mjs',
     '425b577731f45a7c7cf5bf213af873e21f34b1992196735e44b8fa64a34b0c98',
     '10fd5e8c4b8b6d90670a98e6c4d8a7d4c6d737fafac933fa91b9366e133e357c',
     '\t\tdefineBuiltinCommand("login", "Connect a model provider.", "management", "standard", {\n'
     '\t\t\tmodelIndependent: "always",\n'
     '\t\t\tnativeProviders: [\n'
     '\t\t\t\t"discord",\n'
     '\t\t\t\t"slack",\n'
     '\t\t\t\t"telegram"\n'
     '\t\t\t],\n'
     '\t\t\targs: [defineCommandArgument("provider", "Provider or connection method")]\n'
     '\t\t}),\n'
     '\t\tdefineBuiltinCommand("openclaw",',
     '\t\tdefineBuiltinCommand("openclaw",'),
    ('dist/models-auth-status-DnznMCDh.mjs',
     '05bbabd1db046df80dcc16d3918d829b9410f1fe24fcba69b28c41ce2122ce8f',
     '87bcad538cf9378e739c92a2c48107c9a6813b1c89e1c5aafd39549fd55b4662',
     '\t\t\tconst providerUsageRuntime = await getProviderUsageRuntimeSnapshot({\n'
     '\t\t\t\tconfig: cfg,\n'
     '\t\t\t\tagentId,\n'
     '\t\t\t\tagentDir,\n'
     '\t\t\t\tstore\n'
     '\t\t\t});\n'
     '\t\t\tconst usageByProvider = readProviderUsageStaleWhileRevalidate({\n'
     '\t\t\t\tagentId,\n'
     '\t\t\t\tagentDir,\n'
     '\t\t\t\tauthStore: providerUsageRuntime.store,\n'
     '\t\t\t\tconfigRef: cfg,\n'
     '\t\t\t\tcredentialKey: providerUsageRuntime.credentialKey,\n'
     '\t\t\t\tforceRefresh: refreshRequested,\n'
     '\t\t\t\tproviderIds: usageProviderIds,\n'
     '\t\t\t\tnow\n'
     '\t\t\t});\n'
     '\t\t\tconst providers = [];',
     '\t\t\tconst usageByProvider = new Map();\n'
     '\t\t\tconst providers = [];'),
)
PATCH_GROUPS = ((IDENTITY, METADATA_PATCHES), ('api-key-channel-auth-v1', POLICY_PATCHES))
PATCHES = tuple(patch for _, group in PATCH_GROUPS for patch in group)
DESCRIPTORS = [
    {'id': identity, 'upstreamVersion': VERSION,
     'files': [{'path': name, 'originalSha256': before, 'sha256': after}
               for name, before, after, _, _ in group]}
    for identity, group in PATCH_GROUPS
]


def apply_package(package_root, overlays):
    if overlays != DESCRIPTORS:
        raise ValueError('The runtime compatibility overlay differs from its reviewed commitment.')
    package_root = Path(package_root).absolute()
    if package_root.is_symlink() or not package_root.is_dir() or package_root.resolve() != package_root:
        raise ValueError('The owned runtime package is invalid.')
    manifest = json.loads((package_root / 'package.json').read_text(encoding='utf-8'))
    if manifest.get('name') != 'openclaw' or manifest.get('version') != VERSION:
        raise ValueError('The compatibility overlay requires its exact reviewed OpenClaw release.')
    prepared = []
    for name, before, after, anchor, replacement in PATCHES:
        target = package_root / name
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 2 * 1024 * 1024 or target.resolve() != target:
            raise ValueError('The compatibility source file is not a regular owned file.')
        data = target.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest == after:
            if data.count(replacement.encode()) != 1:
                raise ValueError('The compatibility source anchor is invalid.')
            continue
        if digest != before or data.count(anchor.encode()) != 1:
            raise ValueError('The upstream source differs from the reviewed compatibility input.')
        patched = data.replace(anchor.encode(), replacement.encode())
        if hashlib.sha256(patched).hexdigest() != after:
            raise ValueError('The compatibility output differs from its reviewed hash.')
        prepared.append((target, patched, info.st_mode))
    # Validate every input before publishing any replacement. An interrupted
    # application remains restartable by this idempotent helper; doctor requires
    # both exact final hashes before any managed runtime starts.
    for target, data, mode in prepared:
        temporary = target.with_name(target.name + '.chainchat-' + uuid.uuid4().hex + '.tmp')
        try:
            with temporary.open('xb') as output:
                output.write(data)
            temporary.chmod(stat.S_IMODE(mode))
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return DESCRIPTORS


def apply(application, package_root=None):
    application = Path(application).resolve(strict=True)
    lock = json.loads((application / 'openclaw/upstream-lock.json').read_text(encoding='utf-8'))
    return apply_package(package_root or application / 'openclaw/runtime/node_modules/openclaw', lock.get('runtimeCompatibilityOverlays'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--application', type=Path, required=True)
    parser.add_argument('--package-root', type=Path, help='Explicit reviewed disposable package for development acceptance only.')
    args = parser.parse_args()
    print(json.dumps({'runtimeCompatibilityOverlays': apply(args.application, args.package_root)}))
