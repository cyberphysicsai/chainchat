"""Backport the reviewed Zod collection-size gate into exact embedded copies.

This is the upstream a0ebf970f2d752e5f58527cd2942ff48be4f46bd fix, adapted only
for the names/indentation of OpenClaw 2026.11.3's compiled bundles. The original
archive and version headers remain intact. No package scripts or model code run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

VERSION = '2026.11.3'
IDENTITY = 'embedded-zod-size-caps-v1'
FIX_COMMIT = 'a0ebf970f2d752e5f58527cd2942ff48be4f46bd'
MAX_FILE_BYTES = 12 * 1024 * 1024
MAX_TOTAL_BYTES = 40 * 1024 * 1024

# Exact original and final hashes generated from the verified official archive.
FILES = (
    ('dist/agents/harness/native-hook-relay-client.worker.js',
     '4e22689c48f92af58ef929506cbcfe869c19805fd8cff5cee7897e088559425a',
     '5c0c9a671150817f61c13362f3a200e2f3edc1d4437f6fb1529354b86081a511'),
    ('dist/compile-wI2qQAAF.mjs',
     'be8c3a8f65e20bcdf5c1bfc84597aef6a0ea308c7214bda413b4932d7ec2ddf5',
     '5a0a69310f79e3ad0bec34a098878da9bc60eb8061a40c4bd01d37d2e906efcc'),
    ('dist/config-doctor/schemas-C5K39dqU.js',
     '08b8259d210c3f0af9651891186de143804d09dc7e3cfd3eade553166bddfbdc',
     '408936ae1c700227667224b050c3fde90f745d16cfd166d1f7d623b2a31ad1d4'),
    ('dist/extensions/a2a/.setup/channel-base-BbG6akl6.mjs',
     '219dc4d2bdecc56f40f854db56c71c11374cafbedadfa5ed9ab4619cb59b0961',
     '4ee422c8a7f6d37721af371c473cc41344b5940f0371889a174e4c0e84734bbc'),
    ('dist/extensions/openai/capability-catalog.js',
     '4e63dec6972c5221603b3c06f995ef3bce0dd72e130a42fcebef201f26f08cc4',
     '17c17b450c22311bde0145a67e5b2a4b440d63f8013af55161754d685d82b802'),
    ('dist/extensions/reef/.setup/channel-plugin-api-BUIz9qeQ.mjs',
     '98d058f7f7ca3d909fbaf477c835411e8c49fb02b222ce992e15e5f75d3760bf',
     'ddebf82fb27b960c636668f964a95d3b63f759ac66fa86be17b334dd92636780'),
    ('dist/extensions/telegram/.setup/setup-plugin-api-DpPS-T6k.mjs',
     'd2466d085de8c777fb35e38a7584e17f8fab152b93fd54b13fb4594553b29424',
     'cf60869ad6954df5c0365cca075dd0f881b9d96608a8fd8d14cfa33f42bbbbf2'),
    ('dist/infra/gateway-state-owner-heartbeat.worker.js',
     '714d248a71822f8daab718aeeba3410d9a8fd9b092155bea1ffcf8c79cf4ef8c',
     '3e79a227d4dd540ddda7a9e226bc6a9fbc979830782c30976410fb48e95fbd24'),
    ('dist/infra/sqlite-readonly-schemas-CYdKD5YK.mjs',
     '3c680f49fd5e4df9e0191243949fd892690994ca5df6258fbc2c8f92eca21c84',
     'd67359de9fa51c3f3faee70616ee65806c8f49af0d346b871eb3d5c9a8025bb4'),
    ('dist/json-schema-processors-C6KO_BFy.mjs',
     '378fbcb16414bea6b37618814fcc9d549f4d75cb39ede64d2e87152b90916e54',
     '84934ad5cb447fff4972de40b159082ab984f5994381cc8417c7dda6b862e1df'),
    ('dist/managed-handoff-runtime.mjs',
     'b16501053708e8b5c5379db163fb1598b4bd7c8e61261c9895c366129f315eb9',
     '04938f29d9b39c6b32f355f59728d628649525b4464a902919141a8cb2572f57'),
    ('dist/native-hook-relay/worker-task-pool-Cn7mBBG4.mjs',
     '51541bc53b38728007b78aedebda4ac4c474503793fab91cdada700e6c15894d',
     '2e2bb1550ef5b39f7cb8f57b3cab7690be872318d4a647219172932b2bbfe524'),
    ('dist/package-update-activation-recovery.mjs',
     'fb6828ca5b78a0255b923143786bb03179194e2e040c3b2d09fb32aa8d086999',
     '087c29b61e71ca3f4cb7160705ede8807ac684697884fe2f5c778dcbe5ff6d67'),
    ('dist/process/supervisor/service-child-group-anchor.js',
     'dd9c7da91b967ade6b2b5928cfe9369228ec531728c3fa6e821b79b8a9561637',
     'b3c7408cc3770d7ffaea7b9128762026c5ea476bdd65dba650b82beb4e6cd8f9'),
    ('dist/state-retention/openclaw-state-db-cache-CaDjHBot.js',
     '3fefdbfe7828164c9ed5fd704a0c7eb9a7cda50bd5a4bf315be0182584fca937',
     '48fb105b43614df641c2f20cdb30a99202e5be0d92d5b07c955ab0f0338250d0'),
    ('dist/state/openclaw-state-lease-heartbeat.worker.js',
     '51b504cc0f5d757dbfa4109b5101000686ab9f5a89ab6cd40e9bbd4713d6000d',
     '94ce51aa2b0a9089b38a5196596f814f67a7d91ebe7bc91d1bafd2bbe2928d6f'),
    ('dist/state/openclaw-state-read-schemas-D2seJkFD.mjs',
     '0f2f394e7266b62cd5819407cd971e7d79e98af215cb81ea0754b6e84eb6dc19',
     'bac0b0fe0c012a93f494c0ae71bc9c6e1a9ab2b031f3218882a99cb91e1b84a8'),
    ('node_modules/chrome-devtools-mcp/build/src/third_party/index.js',
     'c988e0684584b75e87ae04b768c4f8ae7064401afe5187ec0d4878b2c6833f12',
     '88ab4806cb6dafffc1f8f29d754472a90d8748a47189ca723c685c3c91f6c444'),
)

SIZE_CAPS = '''function __chainchatZodSizeCaps(defChecks) {
  const caps = [];
  for (const ch of defChecks ?? []) {
    const d = ch._zod.def;
    if (!/_(length|size)$|_equals$/.test(d.check)) break;
    const max = d.maximum ?? d.length ?? d.size;
    if (max >= 0) caps.push([max, ch]);
  }
  return caps;
}
'''
CAP_SIZE = '''function __chainchatZodCapSize(inst, size) {
  const caps = __chainchatZodSizeCaps(inst._zod.def.checks);
  if (!caps.length) return;
  const cap = Math.min(...caps.map((c) => c[0]));
  const parse = inst._zod.parse;
  inst._zod.parse = (payload, ctx) => {
    const n = size(payload.value);
    if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
      for (const [max, ch] of __chainchatZodSizeCaps(inst._zod.def.checks)) {
        if (n > max && ch._zod.def.when(payload)) {
          const start = payload.issues.length;
          ch._zod.check(payload);
          payload.issues[start].continue = false;
          attachSchema(payload.issues, start, inst);
          return payload;
        }
      }
    }
    return parse(payload, ctx);
  };
}
'''
GENERATE_SIZE_GATE = '''function __chainchatZodGenerateSizeGate(doc, schema, size) {
  for (const [max, check] of __chainchatZodSizeCaps(schema._zod.def.checks)) {
    doc.write(`if (${size} > ${numericOperand(max, check._zod.def.check)}) return INVALID;`);
  }
}
'''


def patched_source(source):
    """Transform only pre-attested source; callers must verify before/after SHA."""
    if '__chainchatZod' in source:
        raise ValueError('The Zod source already contains a different overlay.')
    interpreter = '$ZodArray = ' in source
    compiler = 'function generateArrayCheck(' in source
    if not interpreter and not compiler:
        raise ValueError('The Zod source has no reviewed collection implementation.')
    if interpreter:
        anchor = 'function handleArrayResult('
        if source.count(anchor) != 1 or 'function attachSchema(' not in source:
            raise ValueError('The embedded Zod interpreter differs from review.')
        source = source.replace(anchor, SIZE_CAPS + CAP_SIZE + anchor, 1)
        for kind, predicate, size in [('Array', 'Array.isArray(input)', 'length'),
                                      ('Map', 'input instanceof Map', 'size'),
                                      ('Set', 'input instanceof Set', 'size')]:
            start = re.search(r'^(?P<indent>\t*)(?:(?:const|var) )?\$Zod' + kind + r' = .*$', source, re.M)
            if not start:
                if '$Zod' + kind + ' = ' in source:
                    raise ValueError('An unreviewed Zod constructor layout was found.')
                continue  # Other constructors were removed by upstream tree-shaking.
            indent = start['indent']
            end = re.search(r'^' + re.escape(indent) + r'\}\);$', source[start.end():], re.M)
            if not end:
                raise ValueError('The embedded Zod constructor boundary is missing.')
            position = start.end() + end.start()
            statement = indent + '\t__chainchatZodCapSize(inst, (input) => ' + predicate + ' ? input.' + size + ' : -1);\n'
            source = source[:position] + statement + source[position:]
    if compiler:
        anchor = 'function generateArrayCheck('
        if source.count(anchor) != 1 or 'function numericOperand(' not in source:
            raise ValueError('The embedded Zod compiler differs from review.')
        source = source.replace(anchor, ('' if interpreter else SIZE_CAPS) + GENERATE_SIZE_GATE + anchor, 1)
        for kind, condition, size in [('Array', '!Array.isArray(${accessor})', 'length'),
                                      ('Map', '!(${accessor} instanceof Map)', 'size'),
                                      ('Set', '!(${accessor} instanceof Set)', 'size')]:
            anchor = 'doc.write(`if (' + condition + ') return INVALID;`);'
            start = source.index('function generate' + kind + 'Check(')
            next_function = source.find('\nfunction ', start + 1)
            end = next_function if next_function != -1 else len(source)
            body = source[start:end]
            if body.count(anchor) != 1:
                raise ValueError('The embedded Zod compiler type guard differs from review.')
            body = body.replace(anchor, anchor + '\n\t__chainchatZodGenerateSizeGate(doc, schema, `${accessor}.' + size + '`);', 1)
            source = source[:start] + body + source[end:]
    return source


DESCRIPTOR = {
    'id': IDENTITY, 'upstreamVersion': VERSION, 'fixCommit': FIX_COMMIT,
    'files': [{'path': name, 'originalSha256': before, 'sha256': after}
              for name, before, after in FILES],
}


def apply_package(package_root, descriptor):
    if descriptor != DESCRIPTOR or len(FILES) != 18:
        raise ValueError('The embedded Zod overlay differs from its reviewed commitment.')
    package_root = Path(package_root).absolute()
    if package_root.is_symlink() or not package_root.is_dir() or package_root.resolve() != package_root:
        raise ValueError('The owned runtime package is invalid.')
    manifest_file = package_root / 'package.json'
    manifest_info = manifest_file.lstat()
    if (not stat.S_ISREG(manifest_info.st_mode) or manifest_info.st_nlink != 1
            or manifest_info.st_size > 1024 * 1024 or manifest_file.resolve() != manifest_file):
        raise ValueError('The owned runtime manifest is invalid.')
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    if manifest.get('name') != 'openclaw' or manifest.get('version') != VERSION:
        raise ValueError('The Zod overlay requires its exact reviewed OpenClaw release.')
    prepared, total = [], 0
    for name, before, after in FILES:
        target = package_root / name
        info = target.lstat()
        total += info.st_size
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE_BYTES
                or total > MAX_TOTAL_BYTES or target.resolve() != target):
            raise ValueError('The embedded Zod file is not a bounded regular owned file.')
        data = target.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest == after:
            continue
        if digest != before:
            raise ValueError('The embedded Zod source differs from the reviewed input.')
        patched = patched_source(data.decode('utf-8')).encode('utf-8')
        if hashlib.sha256(patched).hexdigest() != after:
            raise ValueError('The embedded Zod output differs from its reviewed hash.')
        prepared.append((target, patched, info.st_mode))
    # All inputs validate before the first write. Unknown or interrupted state
    # holds startup; exact original/final mixtures can be resumed idempotently.
    for target, data, mode in prepared:
        temporary = target.with_name(target.name + '.chainchat-zod-' + uuid.uuid4().hex + '.tmp')
        try:
            with temporary.open('xb') as output:
                output.write(data)
            temporary.chmod(stat.S_IMODE(mode))
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return DESCRIPTOR


def apply(application, package_root=None):
    application = Path(application).resolve(strict=True)
    lock = json.loads((application / 'openclaw/upstream-lock.json').read_text(encoding='utf-8'))
    descriptors = lock.get('runtimeSecurityOverlays')
    matching = [item for item in descriptors if isinstance(item, dict) and item.get('id') == IDENTITY] if isinstance(descriptors, list) else []
    if len(matching) != 1:
        raise ValueError('The required embedded Zod commitment is missing or duplicated.')
    return apply_package(package_root or application / 'openclaw/runtime/node_modules/openclaw', matching[0])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--application', type=Path, required=True)
    parser.add_argument('--package-root', type=Path)
    args = parser.parse_args()
    print(json.dumps({'runtimeSecurityOverlay': apply(args.application, args.package_root)}))
