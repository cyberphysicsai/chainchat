import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('zod_security_overlay', ROOT / 'installer/zod_security_overlay.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class ZodSecurityOverlayTests(unittest.TestCase):
    def package(self, directory):
        root = Path(directory).resolve()
        self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
        (root / 'package.json').write_text(json.dumps({'name': 'openclaw', 'version': overlay.VERSION}), encoding='utf-8')
        target = root / overlay.FILES[0][0]
        target.parent.mkdir(parents=True)
        return root, target

    def test_descriptor_refuses_modified_commit_file_list_and_target_before_io(self):
        self.assertEqual(len(overlay.DESCRIPTOR['files']), 18)
        self.assertEqual(len({row['path'] for row in overlay.DESCRIPTOR['files']}), 18)
        for key, value in [('fixCommit', '0' * 40), ('upstreamVersion', '2026.11.2'), ('files', [])]:
            descriptor = {**overlay.DESCRIPTOR, key: value}
            with self.assertRaisesRegex(ValueError, 'reviewed commitment'):
                overlay.apply_package('/missing', descriptor)
        descriptor = copy.deepcopy(overlay.DESCRIPTOR)
        descriptor['files'][0]['path'] = '../timechain'
        with self.assertRaisesRegex(ValueError, 'reviewed commitment'):
            overlay.apply_package('/missing', descriptor)

    def test_unknown_source_bytes_are_held_without_fuzzy_repair(self):
        with tempfile.TemporaryDirectory(prefix='ct-zod-overlay-test-') as directory:
            root, target = self.package(directory)
            target.write_bytes(b'changed upstream source')
            with self.assertRaisesRegex(ValueError, 'reviewed input'):
                overlay.apply_package(root, overlay.DESCRIPTOR)
            self.assertEqual(target.read_bytes(), b'changed upstream source')
            self.assertEqual(list(target.parent.glob('*.chainchat-zod-*.tmp')), [])

    def test_wrong_package_version_is_held_before_source_replacement(self):
        with tempfile.TemporaryDirectory(prefix='ct-zod-overlay-test-') as directory:
            root, target = self.package(directory)
            target.write_bytes(b'unchanged')
            (root / 'package.json').write_text('{"name":"openclaw","version":"2026.11.2"}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'exact reviewed OpenClaw'):
                overlay.apply_package(root, overlay.DESCRIPTOR)
            self.assertEqual(target.read_bytes(), b'unchanged')

    def test_oversized_or_hardlinked_files_are_held_before_reading_or_replacement(self):
        with tempfile.TemporaryDirectory(prefix='ct-zod-overlay-test-') as directory:
            root, target = self.package(directory)
            with target.open('wb') as output:
                output.truncate(overlay.MAX_FILE_BYTES + 1)
            with self.assertRaisesRegex(ValueError, 'bounded regular owned file'):
                overlay.apply_package(root, overlay.DESCRIPTOR)
        with tempfile.TemporaryDirectory(prefix='ct-zod-overlay-test-') as directory:
            root, target = self.package(directory)
            target.write_bytes(b'unchanged')
            os.link(target, root / 'same-file')
            with self.assertRaisesRegex(ValueError, 'bounded regular owned file'):
                overlay.apply_package(root, overlay.DESCRIPTOR)
            self.assertEqual(target.read_bytes(), b'unchanged')

    @unittest.skipUnless(os.environ.get('CT_OPENCLAW_PACKAGE'), 'Actual pinned package is enabled in native CI.')
    def test_already_attested_actual_package_is_idempotent_and_never_rewritten(self):
        root = Path(os.environ['CT_OPENCLAW_PACKAGE']).resolve()
        before = {}
        for name, _, digest in overlay.FILES:
            target = root / name
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), digest)
            before[name] = target.stat().st_mtime_ns
        self.assertEqual(overlay.apply_package(root, overlay.DESCRIPTOR), overlay.DESCRIPTOR)
        self.assertEqual({name: (root / name).stat().st_mtime_ns for name, _, _ in overlay.FILES}, before)


if __name__ == '__main__':
    unittest.main()
