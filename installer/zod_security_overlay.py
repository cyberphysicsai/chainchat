"""Backport the reviewed Zod collection-size gate into exact embedded copies.

This is the upstream a0ebf970f2d752e5f58527cd2942ff48be4f46bd fix, adapted only
for the names/indentation of the compiled browser dependency embedded in OpenClaw 2026.11.10. The original
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

VERSION = '2026.11.10'
IDENTITY = 'embedded-zod-size-caps-v1'
FIX_COMMIT = 'a0ebf970f2d752e5f58527cd2942ff48be4f46bd'
MAX_FILE_BYTES = 12 * 1024 * 1024
MAX_TOTAL_BYTES = 40 * 1024 * 1024

# Exact original and final hashes generated from the verified official archive.
FILES = (
    ('node_modules/chrome-devtools-mcp/build/src/third_party/index.js',
     'e1752f75684b672362dc3ae77a399407c509b76471fca08f967fc44fe2cb267b',
     '003dca1baa7c6c22daaa843f3b387574e6f2ede044eeb77658950305927400b6'),
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
    if descriptor != DESCRIPTOR:
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
