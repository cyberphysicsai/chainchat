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

VERSION = '2026.11.10'
IDENTITY = 'early-hook-input-provenance-v2'
# The SDK stores the source turn ID under its native channel-source symbol.
# Forward only that typed value and input provenance through the same early
# before_agent_reply context. A missing symbol remains undefined.
METADATA_PATCHES = (
    ('dist/embedded-agent-CSEHHQp1.mjs',
     'b704e9fb2490d409679480874c75827561a4d37afcbd3703871e747f02000ecd',
     'cdaf10bfda63955c06e5d8502ad2fbd5d11ce849a97f8a47c90196b7bb6f659e',
     'trigger:c.trigger,...buildAgentHookContextChannelFields(c)',
     'trigger:c.trigger,inputProvenance:c.inputProvenance,currentSourceTurnId:readChannelSourceTurnId(c),'
     '...buildAgentHookContextChannelFields(c)'),
    ('dist/cli-runner-D2YzRdD1.mjs',
     '04ad041e1393cc3a7e79ec55169b7975db984440b65dfbede4edb5f6f8e31edc',
     '1cb77261f6975f8c3dcf9ea491aa54d66045938acdf97e712cd8ab970b6619e5',
     'trigger:e.trigger,...buildAgentHookContextChannelFields(e),'
     '...buildAgentHookContextIdentityFields(e)},onDispatch:',
     'trigger:e.trigger,inputProvenance:e.inputProvenance,'
     'currentSourceTurnId:e[Symbol.for("openclaw.channelSourceTurnId")],'
     '...buildAgentHookContextChannelFields(e),...buildAgentHookContextIdentityFields(e)},onDispatch:'),
)
POLICY_PATCHES = (
    ('dist/provider-auth-login-flow-runtime-BQWiIgu2.mjs',
     '6d70a5a4e381c34b35673f96f314c7cd5cca47c60694a25f27b2bbe02fcf0ac2',
     '0b4357ae27c1f30303e0304c9820cdc507815d4e0bc38fd35952f28997d201a7',
     'if(!t)return null;e.signal?.throwIfAborted();if(!e.hasAdminScope',
     'if(!t)return null;e.signal?.throwIfAborted();return{status:"reply",'
     'reply:{text:"Use ChainChat Models to configure a provider API key."}};if(!e.hasAdminScope'),
    ('dist/commands-registry.data-BY7QvkMn.mjs',
     '2c3d0bae58985654be4bd2abc534957689d4ddc20fefadd82bbe7900338c4b49',
     '9168a8311b80b9378334c32e5bc7cf302e05bea7677b9f71984485468f7db252',
     'defineBuiltinCommand(`login`,`Connect a model provider.`,`management`,`standard`,'
     '{modelIndependent:`always`,nativeProviders:[`discord`,`slack`,`telegram`],'
     'args:[defineCommandArgument(`provider`,`Provider or connection method`)]}),'
     'defineBuiltinCommand(`openclaw`,',
     'defineBuiltinCommand(`openclaw`,'),
    ('dist/models-auth-status-DajZt9YG.mjs',
     '1806a063b5b857e20acfaf3fb924d8ccde8aaa87533359a5832e6e13db70444c',
     'a31adfb4b4708932c5cd6f8a979efbe01ab2cce33a8f85d03e12d02fde0d4402',
     'const S=await getProviderUsageRuntimeSnapshot({config:r,agentId:l,agentDir:u,store:d});'
     'const C={agentId:l,agentDir:u,authStore:S.store,configRef:r,credentialKey:S.credentialKey,'
     'forceRefresh:a,providerIds:g,now:i};const{usageByProvider:w,'
     'refreshAt:T}=await readProviderUsage({...C,awaitRefresh:Boolean(e.refreshUsage)});const E=[];',
     'const w=new Map();const T=void 0;const E=[];'),
)
# Upstream 11.10 keeps displaying unavailable baseline definitions even with
# a restricted prompt-hook policy. Present only the policy's direct schemas
# while retaining its exact existing execution allowlist and deferred catalogue.
TOOL_PRESENTATION_PATCHES = (
    ('dist/attempt-transcript-helpers-BEGc_WgE.mjs',
     '4e4bdc40e686429d73c118c4ff5072fc6fcf34cd822401db9f1c693b688f97f4',
     '318cb78c420356d44fa6bcdc454ba4e77e1d1bcb634d8475de98f22b6395e7ba',
     'const s=[...e.baseline.activeToolNames];e.session.setActiveToolsByName(s,r.callableToolNames);'
     'return{activeToolNames:s,callableToolNames:r.callableToolNames,'
     'effectiveTools:e.effectiveTools,uncompactedEffectiveTools:a,tools:o}',
     'const admittedSchemas=e.toolsAllow===void 0?null:new Set(r.tools.map(tool=>tool.name));'
     'const s=admittedSchemas?e.baseline.activeToolNames.filter(name=>admittedSchemas.has(name))'
     ':[...e.baseline.activeToolNames];e.session.setActiveToolsByName(s,r.callableToolNames);'
     'return{activeToolNames:s,callableToolNames:r.callableToolNames,'
     'effectiveTools:admittedSchemas?e.effectiveTools.filter(tool=>admittedSchemas.has(tool.name)):e.effectiveTools,'
     'uncompactedEffectiveTools:a,tools:o}'),
)
PATCH_GROUPS = (
    (IDENTITY, METADATA_PATCHES),
    ('api-key-channel-auth-v1', POLICY_PATCHES),
    ('admitted-tool-presentation-v1', TOOL_PRESENTATION_PATCHES),
)
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
