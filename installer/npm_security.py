"""Exact security backports for the original official npm 12.2.2 archive.

Retains npm's dependency APIs and original package/version metadata. The raw
lockfile audit therefore remains independent evidence, not a claim these files
are unmodified upstream releases. No npm code is executed by this module.

Backports derive from the upstream Glob abort fix 4682e8c9babee1b385202ede36389634e12076d7,
Minimatch bounds fix 77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8 plus the
allocation budget in v11.0.5, and escaping fix
784603e09641970d2ba2caf8c73a95d1015cc67d. Package license files remain intact.
Glob's published default bundles embed private dependency copies. Forwarding
their entry points to upstream's supported raw exports removes those duplicate
implementations, so every call uses the reviewed shared dependencies and walkers.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


FILES = [
    {
        "path": "node_modules/glob/dist/commonjs/walker.js",
        "originalSha256": "1138ced9d5429681a1740af32d13391a38184a3376d1d9d56eea64b7a43274a1",
        "sha256": "8dc8d70dda5219f6351d8267acf30bc17b0a97b353862db7edb8e234c4a38479"
    },
    {
        "path": "node_modules/glob/dist/commonjs/index.min.js",
        "originalSha256": "3178e109aa75b45d6970a51a718f01e5b5b8f87150563ee6cb4c0e75ec215617",
        "sha256": "8821342a5777229e58e6fd57ebfad9f8a18a476e02a6933049bb5412be393204"
    },
    {
        "path": "node_modules/glob/dist/esm/walker.js",
        "originalSha256": "3e15af549ecc74d8691982d571168fd4b0e38b494c2cbb3edcfb8f97d4036ac6",
        "sha256": "9e07bcdb1fe1ad47fd593cd9c89a1dc4e91d49e21392f19f9b62797e010852dd"
    },
    {
        "path": "node_modules/glob/dist/esm/index.min.js",
        "originalSha256": "9eff492e16fdf9ea47a5f3c3d64784f9238b607f95a278101eb5a4e882f6ea85",
        "sha256": "735600bb655a47acaf98ea0ea867c69a4984c37be9d1e74293bc750da05bbed2"
    },
    {
        "path": "node_modules/minimatch/dist/commonjs/index.js",
        "originalSha256": "d224f71f20d7c206fcc5b7e9f747324c7698345a0b2c28d717dd9cf698306783",
        "sha256": "b06dfc01bb62b61d2f97bdce59eee20f7c5708557a7e25e91fccb0f033886f76"
    },
    {
        "path": "node_modules/minimatch/dist/commonjs/escape.js",
        "originalSha256": "54b57f8f50c8e834f35a30c1848ac3f79acf8dd85894505f046afaf3965e63a0",
        "sha256": "d147f5713a26530ce089cf99eaa0537c5dc99bc4b085c7466ec982246d653d58"
    },
    {
        "path": "node_modules/minimatch/dist/esm/index.js",
        "originalSha256": "59821ec2ce0d3df968292036e5c831ad322b33e9c33a949ecbc9dfe125d165be",
        "sha256": "f80ffd4f76bac21aaf89210c8a1a0d5c5d142fc5cefbdf579075438980ae45f4"
    },
    {
        "path": "node_modules/minimatch/dist/esm/escape.js",
        "originalSha256": "8418e37c202bcd247e76b1c205d4eff9474f15fb76c1db1ef0688cb6a8ec3c94",
        "sha256": "d61cd0b8c7f8e06368320830bb80f12470a91e27e46c2dc2cbaa77c66390b79c"
    },
    {
        "path": "node_modules/minimatch/dist/commonjs/unescape.js",
        "originalSha256": "bec1bb4483a2c325599949dd6668b5b7daa2dcbe046c5a09899bc8c5b51c08c1",
        "sha256": "e154e594eac01e4dd5cd2a60785b8c07974345634743f52df2b91b9687b8ed99"
    },
    {
        "path": "node_modules/minimatch/dist/esm/unescape.js",
        "originalSha256": "2cd61ba96e616969f152445c61ec2ca129a0afd2028ea71309b862a4222304d6",
        "sha256": "685168109ac6f05b56ebda8fc6cc3744f3e791eb8ed2e5d9f7e0dbc9141803c6"
    }
]
DESCRIPTOR = {
    'id': 'npm-12.2.2-bundled-security-v1',
    'package': {'name': 'npm', 'version': '12.2.2'},
    'globEntryMode': 'official-raw-forwarders',
    'advisories': ['GHSA-3g3m-2fjr-6pw4', 'GHSA-g3hv-75wg-m249', 'GHSA-c859-jr93-m5j4'],
    'upstreamPatches': [
        'https://github.com/isaacs/node-glob/commit/4682e8c9babee1b385202ede36389634e12076d7',
        'https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8',
        'https://github.com/isaacs/minimatch/commit/73f0e1b1abcb97edf97b7c7a4b9132a141496338',
        'https://github.com/isaacs/minimatch/commit/9c6ebb18f45ff2f06003aea084c39a92a6ff7dbd',
        'https://github.com/isaacs/minimatch/commit/2d5578ba60f06bd6f362bd6c332b122c796bdd4d',
        'https://github.com/isaacs/minimatch/commit/784603e09641970d2ba2caf8c73a95d1015cc67d',
    ],
    'files': FILES,
}


def _replace(text, before, after, count=1):
    if text.count(before) != count:
        raise ValueError('The reviewed npm security anchor changed.')
    return text.replace(before, after)


def _transform(relative, content):
    text = content.decode('utf-8')
    if relative.startswith('node_modules/glob/') and relative.endswith('/walker.js'):
        text = _replace(text, '    onResume(fn) {\n        if (this.signal?.aborted)\n            return;\n',
                        '    onResume(fn) {\n')
        text = _replace(text, 'if (this.signal?.aborted)\n            cb();',
                        'if (this.signal?.aborted)\n            return cb();', 4)
    elif relative.startswith('node_modules/minimatch/') and relative.endswith('/escape.js'):
        before = r'''    if (magicalBraces) {
        return windowsPathsNoEscape ?
            s.replace(/[?*()[\]{}]/g, '[$&]')
            : s.replace(/[?*()[\]\\{}]/g, '\\$&');
    }
    return windowsPathsNoEscape ?
        s.replace(/[?*()[\]]/g, '[$&]')
        : s.replace(/[?*()[\]\\]/g, '\\$&');'''
        after = r'''    const e = magicalBraces ?
        windowsPathsNoEscape ? s.replace(/[?*()[\]{}]/g, '[$&]')
            : s.replace(/[?*()[\]\\{}]/g, '\\$&')
        : windowsPathsNoEscape ? s.replace(/[?*()[\]]/g, '[$&]')
            : s.replace(/[?*()[\]\\]/g, '\\$&');
    const c = e.charAt(0);
    if (c === '#') return (windowsPathsNoEscape ? '[#]' : '\\#') + e.slice(1);
    if (c === '!') return (windowsPathsNoEscape ? '@(!)' : '\\!') + e.slice(1);
    return e;'''
        text = _replace(text, before, after)
    elif relative.startswith('node_modules/minimatch/') and relative.endswith('/unescape.js'):
        recurse = '(0, exports.unescape)' if '/commonjs/' in relative else 'unescape'
        text = _replace(text, '    if (magicalBraces) {',
                        "    // Companion to escape()'s leading ! encoding in Windows mode.\n"
                        "    if (windowsPathsNoEscape && s.startsWith('@(!)')) {\n"
                        f"        return '!' + {recurse}(s.slice(4), {{ windowsPathsNoEscape, magicalBraces }});\n"
                        '    }\n'
                        '    if (magicalBraces) {')
    elif relative.startswith('node_modules/minimatch/') and relative.endswith('/index.js'):
        text = _replace(text, '    firstPhasePreProcess(globParts) {\n        let didSomething = false;',
                        '    firstPhasePreProcess(globParts) {\n'
                        '        const { braceExpandMax = 100_000 } = this.options;\n'
                        '        let splitCells = 0;\n'
                        '        const maxSplitCells = 1_000_000;\n'
                        '        let didSomething = false;')
        text = _replace(text, '                    didSomething = true;\n                    // edit parts in place, and push the new one',
                        '                    const addedCells = parts.length - 1;\n'
                        '                    if (globParts.length >= braceExpandMax || splitCells + addedCells > maxSplitCells) {\n'
                        '                        throw new RangeError("optimizationLevel 2: too many patterns from \'**/..\'");\n'
                        '                    }\n'
                        '                    didSomething = true;\n                    // edit parts in place, and push the new one')
        text = _replace(text, "                    other[gs] = '**';\n                    globParts.push(other);",
                        "                    other[gs] = '**';\n                    splitCells += addedCells;\n                    globParts.push(other);")
        text = _replace(text, '    secondPhasePreProcess(globParts) {\n        for',
                        '    secondPhasePreProcess(globParts) {\n        if (globParts.length > 1000) return globParts;\n        for')
        call = '(0, brace_expansion_1.expand)' if '/commonjs/' in relative else 'expand'
        text = _replace(text, f'    return {call}(pattern, {{ max: options.braceExpandMax }});',
                        r'''    let p = pattern.replace(/\\\\/g, '\\\\\\\\');
    if (options.windowsPathsNoEscape || options.allowWindowsEscape === false) {
        p = p.replace(/\[([{}])\]/g, '[\\$1]');
    }
''' + f'    return {call}(p, {{ max: options.braceExpandMax }});')
    elif relative.startswith('node_modules/glob/') and relative.endswith('/index.min.js'):
        # Upstream exports the same supported API as glob/raw. Forward both
        # default entries there instead of retaining duplicate private copies
        # of Minimatch, brace-expansion and the walker in minified bundles.
        header = '// ChainChat security: use upstream raw exports and reviewed shared dependencies.\n'
        text = ('"use strict";\n' + header + 'module.exports = require("./index.js");\n') if '/commonjs/' in relative else (header + 'export * from "./index.js";\n')
    else:
        raise ValueError('Unsupported npm security file.')
    # These source maps describe the original code. Keep the upstream evidence
    # but do not advertise stale mappings for modified executable bytes.
    text = re.sub(r'(?m)^//# sourceMappingURL=[^\r\n]*', '', text)
    return text.encode('utf-8')


def _root(npm_root):
    root = Path(npm_root).absolute()
    if root.is_symlink() or not root.is_dir() or root.resolve(strict=True) != root:
        raise ValueError('The exact owned npm package root is invalid.')
    package = _safe_file(root, 'package.json', 65536)
    identity = json.loads(package.read_text(encoding='utf-8'))
    if identity.get('name') != 'npm' or identity.get('version') != '12.2.2':
        raise ValueError('The npm package differs from the reviewed security target.')
    return root


def _safe_file(root, relative, limit=2 * 1024 * 1024):
    filename = root.joinpath(*relative.split('/'))
    if filename.is_symlink() or filename.resolve(strict=True) != filename or not filename.is_file():
        raise ValueError('The npm security file ownership changed.')
    stat = filename.stat()
    if stat.st_nlink != 1 or stat.st_size > limit:
        raise ValueError('The npm security file is linked or oversized.')
    return filename


def _validate(descriptor):
    if descriptor != DESCRIPTOR or len(DESCRIPTOR['files']) != 10:
        raise ValueError('The npm security commitment differs from the reviewed backport.')


def verify_npm_security(npm_root, descriptor):
    _validate(descriptor)
    root = _root(npm_root)
    for row in descriptor['files']:
        filename = _safe_file(root, row['path'])
        if hashlib.sha256(filename.read_bytes()).hexdigest() != row['sha256']:
            raise ValueError('The installed npm security backport failed verification.')
    return {'id': descriptor['id'], 'package': descriptor['package'], 'files': descriptor['files']}


def apply_npm_security(npm_root, descriptor):
    _validate(descriptor)
    root = _root(npm_root)
    pending = []
    for row in descriptor['files']:
        filename = _safe_file(root, row['path'])
        original = filename.read_bytes()
        digest = hashlib.sha256(original).hexdigest()
        if digest == row['sha256']:
            continue
        if digest != row['originalSha256']:
            raise ValueError('The original npm security file differs from the reviewed archive.')
        replacement = _transform(row['path'], original)
        if hashlib.sha256(replacement).hexdigest() != row['sha256']:
            raise ValueError('The calculated npm security backport differs from the reviewed output.')
        pending.append((filename, replacement))
    # Preflight every file before writing. Partially applied known output is
    # restartable, but the caller must verify the complete group before npm runs.
    for filename, replacement in pending:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(prefix='.chainchat-npm-security-', dir=filename.parent, delete=False) as output:
                temporary = Path(output.name)
                output.write(replacement)
                output.flush()
                os.fsync(output.fileno())
            temporary.chmod(0o644)
            os.replace(temporary, filename)
            temporary = None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return verify_npm_security(root, descriptor)
