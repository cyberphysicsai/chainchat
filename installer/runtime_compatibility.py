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

VERSION = '2026.11.2'
IDENTITY = 'early-hook-input-provenance-v2'
METADATA_PATCHES = (
    ('dist/embedded-agent-BJe8xfTT.mjs',
     '706bfad11e48c09d2d35ddace2c61296e1689ca8e260eae561cbdcd43389276e',
     '0c85be2382d98a6038d0e01a04acc29bd655650414ff7152d74af99cba5853d8',
     '\t' * 9 + 'trigger: params.trigger,\n' + '\t' * 9 + '...buildAgentHookContextChannelFields(params),',
     '\t' * 9 + 'trigger: params.trigger,\n' + '\t' * 9 + 'inputProvenance: params.inputProvenance,\n' + '\t' * 9 + 'currentSourceTurnId: params.currentSourceTurnId,\n' + '\t' * 9 + '...buildAgentHookContextChannelFields(params),'),
    ('dist/cli-runner-Cz6SuvHJ.mjs',
     '7cc8f440202c6804672a46f28383c821cbb6c97151c70088e75529dda779c97a',
     '723fa26dd7717bb5ecdffa93745da5bc590153bdf9f672232459a6d728ccc109',
     '\t' * 3 + 'heartbeatEventQueueSessionKey: params.heartbeatEventQueueSessionKey,\n' + '\t' * 3 + 'sessionId: params.sessionId,',
     '\t' * 3 + 'heartbeatEventQueueSessionKey: params.heartbeatEventQueueSessionKey,\n' + '\t' * 3 + 'inputProvenance: params.inputProvenance,\n' + '\t' * 3 + 'currentSourceTurnId: params.currentSourceTurnId,\n' + '\t' * 3 + 'sessionId: params.sessionId,'),
)
POLICY_PATCHES = (
    ('dist/provider-auth-login-flow-runtime-C2EOo219.mjs',
     'a38e4068297e840281f203a747ced7d8955f4b8e1c1a855377252ad4b3e0b58e',
     'ca23bce2f5b4e88bf7de2f6c01ce0b3c947ade30453e1df925fea5d2895e87c4',
     '\tif (!match) return null;\n'
     '\tparams.signal?.throwIfAborted();\n'
     '\tif (!params.hasAdminScope',
     '\tif (!match) return null;\n'
     '\tparams.signal?.throwIfAborted();\n'
     '\treturn { status: "reply", reply: { text: "Use ChainChat Models to configure a provider API key." } };\n'
     '\tif (!params.hasAdminScope'),
    ('dist/commands-registry.data-DP7hJyYX.mjs',
     '09b10d0b8b4068ab957da2a4820be85e086ae3a23c50b81b85518a2b324104cd',
     'f780135f2b79706b59931c7f6e81019e626ab61c35bf6bcd0537138a29c01c1e',
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
    ('dist/models-auth-status-BJezSSIf.mjs',
     '12aa60af31a29c8a59c69e7f4638c52a1097a8133e1669cf638a8e7e290ea3e0',
     '41ed7c57bec3a729d7a447642de2f5a998511d0e0fa78f8c34c1913b9caefeca',
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
