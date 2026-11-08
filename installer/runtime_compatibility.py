"""Apply one exact metadata-only compatibility overlay to reviewed OpenClaw.

The original published archive/SRI is retained. Only already-private typed
inputProvenance and currentSourceTurnId values enter the existing early hook context.
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

VERSION = '2026.10.10'
IDENTITY = 'early-hook-input-provenance-v2'
PATCHES = (
    ('dist/embedded-agent-BgECZgbU.mjs',
     'cdbef6f9013548d66f1786e842406528cc0196dda9c28faa41ae596abdc2f402',
     'cc5b8cdad70c8b50a3a4a3bd0a309e3fd3dc74c43e1934cc0e9094c705de68c4',
     '\t' * 9 + 'trigger: params.trigger,\n' + '\t' * 9 + '...buildAgentHookContextChannelFields(params),',
     '\t' * 9 + 'trigger: params.trigger,\n' + '\t' * 9 + 'inputProvenance: params.inputProvenance,\n' + '\t' * 9 + 'currentSourceTurnId: params.currentSourceTurnId,\n' + '\t' * 9 + '...buildAgentHookContextChannelFields(params),'),
    ('dist/cli-runner-WFa8e-nn.mjs',
     'c7a6f8d6a0d4f430dc83c36e0508e3b30affc4136828392a1ddd169b6e96c842',
     '60ec71f91555bb10f92039a867a29e9dd6c69678138d7c572157b8d1d03042b4',
     '\t' * 3 + 'heartbeatEventQueueSessionKey: params.heartbeatEventQueueSessionKey,\n' + '\t' * 3 + 'sessionId: params.sessionId,',
     '\t' * 3 + 'heartbeatEventQueueSessionKey: params.heartbeatEventQueueSessionKey,\n' + '\t' * 3 + 'inputProvenance: params.inputProvenance,\n' + '\t' * 3 + 'currentSourceTurnId: params.currentSourceTurnId,\n' + '\t' * 3 + 'sessionId: params.sessionId,'),
)
DESCRIPTOR = {'id': IDENTITY, 'upstreamVersion': VERSION,
              'files': [{'path': name, 'originalSha256': before, 'sha256': after} for name, before, after, _, _ in PATCHES]}


def apply_package(package_root, overlays):
    if overlays != [DESCRIPTOR]:
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
    return [DESCRIPTOR]


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
