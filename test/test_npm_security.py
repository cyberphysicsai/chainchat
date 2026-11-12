import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('npm_security', ROOT / 'installer/npm_security.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


def installed_npm():
    if os.environ.get('CT_NPM_SECURITY_PACKAGE'):
        return Path(os.environ['CT_NPM_SECURITY_PACKAGE'])
    if os.environ.get('CT_OPENCLAW_PACKAGE'):
        return Path(os.environ['CT_OPENCLAW_PACKAGE']).parent / 'npm'
    return None


class NpmSecurityTests(unittest.TestCase):
    def test_complete_companion_file_group_is_committed(self):
        paths = [row['path'] for row in overlay.DESCRIPTOR['files']]
        expected = {
            f'node_modules/{package}/dist/{flavor}/{filename}'
            for package, filenames in [('glob', ['walker.js', 'index.min.js']),
                                       ('minimatch', ['index.js', 'escape.js', 'unescape.js'])]
            for flavor in ['commonjs', 'esm']
            for filename in filenames
        }
        self.assertEqual(len(paths), 10)
        self.assertEqual(set(paths), expected)

    def test_unknown_commitments_hold_before_package_reads(self):
        for change in ({'id': 'unknown'}, {'files': []}, {'advisories': []}):
            descriptor = {**copy.deepcopy(overlay.DESCRIPTOR), **change}
            with self.assertRaisesRegex(ValueError, 'commitment differs'):
                overlay.apply_npm_security(Path('/not-an-owned-package'), descriptor)
            with self.assertRaisesRegex(ValueError, 'commitment differs'):
                overlay.verify_npm_security(Path('/not-an-owned-package'), descriptor)

    def test_arbitrary_file_or_hash_cannot_become_a_security_backport(self):
        for change in ({'path': '../outside'}, {'sha256': '0' * 64}, {'originalSha256': '0' * 64}):
            descriptor = copy.deepcopy(overlay.DESCRIPTOR)
            descriptor['files'][0].update(change)
            with self.assertRaisesRegex(ValueError, 'commitment differs'):
                overlay.apply_npm_security(Path('/not-an-owned-package'), descriptor)

    def test_wrong_npm_version_is_not_patched(self):
        with tempfile.TemporaryDirectory(prefix='ct-npm-security-test-') as directory:
            root = Path(directory).resolve()
            package = root / 'package.json'
            package.write_text(json.dumps({'name': 'npm', 'version': '11.20.0'}), encoding='utf-8')
            before = package.read_bytes()
            with self.assertRaisesRegex(ValueError, 'npm package differs'):
                overlay.apply_npm_security(root, overlay.DESCRIPTOR)
            self.assertEqual(package.read_bytes(), before)
            self.assertEqual(list(root.iterdir()), [package])

    def test_no_fuzzy_source_replacements(self):
        for row in overlay.DESCRIPTOR['files']:
            # Complete original/final SHA checking occurs in apply. Even the
            # transformer refuses incomplete anchors for actual source patches.
            if not row['path'].endswith('index.min.js'):
                with self.assertRaises(ValueError):
                    overlay._transform(row['path'], b'not the reviewed source')

    @unittest.skipUnless(installed_npm(), 'Installed npm acceptance runs with the real runtime in CI.')
    def test_installed_group_is_idempotent_and_tampering_holds(self):
        source = installed_npm()
        with tempfile.TemporaryDirectory(prefix='ct-npm-security-test-') as directory:
            root = Path(directory).resolve()
            for name in ['package.json', *[row['path'] for row in overlay.DESCRIPTOR['files']]]:
                destination = root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / name, destination)
            overlay.verify_npm_security(root, overlay.DESCRIPTOR)
            before = {row['path']: (root / row['path']).read_bytes() for row in overlay.DESCRIPTOR['files']}
            overlay.apply_npm_security(root, overlay.DESCRIPTOR)
            self.assertEqual(before, {name: (root / name).read_bytes() for name in before})
            bad = overlay.DESCRIPTOR['files'][-1]['path']
            (root / bad).write_bytes(before[bad] + b'\n// changed\n')
            held = {name: (root / name).read_bytes() for name in before}
            with self.assertRaisesRegex(ValueError, 'original npm security file differs'):
                overlay.apply_npm_security(root, overlay.DESCRIPTOR)
            self.assertEqual(held, {name: (root / name).read_bytes() for name in before})
            with self.assertRaisesRegex(ValueError, 'failed verification'):
                overlay.verify_npm_security(root, overlay.DESCRIPTOR)

    @unittest.skipUnless(installed_npm(), 'Installed npm acceptance runs with the real runtime in CI.')
    def test_hardlinked_security_file_is_refused(self):
        source = installed_npm()
        with tempfile.TemporaryDirectory(prefix='ct-npm-security-test-') as directory:
            root = Path(directory).resolve()
            for name in ['package.json', *[row['path'] for row in overlay.DESCRIPTOR['files']]]:
                destination = root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source / name, destination)
            linked = root / overlay.DESCRIPTOR['files'][0]['path']
            os.link(linked, root / 'same-file-alias')
            with self.assertRaisesRegex(ValueError, 'linked or oversized'):
                overlay.verify_npm_security(root, overlay.DESCRIPTOR)


if __name__ == '__main__':
    unittest.main()
