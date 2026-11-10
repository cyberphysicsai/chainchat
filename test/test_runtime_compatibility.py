"""The exact metadata overlay is bounded, repeatable, and never best-effort."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runtime_compatibility', ROOT / 'installer/runtime_compatibility.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class RuntimeCompatibilityTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory).resolve()
        (root / 'dist').mkdir()
        (root / 'package.json').write_text(json.dumps({'name': 'openclaw', 'version': overlay.VERSION}))
        records = []
        for index in range(2):
            name, original, replacement = 'dist/source%d.mjs' % index, 'original%d\n' % index, 'forward%d\n' % index
            (root / name).write_text(original, newline='')
            records.append((name, hashlib.sha256(original.encode()).hexdigest(), hashlib.sha256(replacement.encode()).hexdigest(), original, replacement))
        descriptor = {'id': overlay.IDENTITY, 'upstreamVersion': overlay.VERSION,
                      'files': [{'path': name, 'originalSha256': before, 'sha256': after} for name, before, after, _, _ in records]}
        return root, tuple(records), descriptor

    def test_repeat_and_interrupted_application_are_exact_and_idempotent(self):
        with tempfile.TemporaryDirectory(prefix='ct-compat-') as directory:
            root, records, descriptor = self.fixture(directory)
            # A prior interrupted run may have published only one exact file.
            (root / records[0][0]).write_text(records[0][4], newline='')
            with patch.object(overlay, 'PATCHES', records), patch.object(overlay, 'DESCRIPTORS', [descriptor]):
                self.assertEqual(overlay.apply_package(root, [descriptor]), [descriptor])
                first = [(root / record[0]).read_bytes() for record in records]
                overlay.apply_package(root, [descriptor])
                self.assertEqual(first, [(root / record[0]).read_bytes() for record in records])
                self.assertEqual(first, [record[4].encode() for record in records])

    def test_later_corruption_refuses_before_any_original_file_is_changed(self):
        with tempfile.TemporaryDirectory(prefix='ct-compat-') as directory:
            root, records, descriptor = self.fixture(directory)
            (root / records[1][0]).write_text('unknown upstream bytes')
            first = (root / records[0][0]).read_bytes()
            with patch.object(overlay, 'PATCHES', records), patch.object(overlay, 'DESCRIPTORS', [descriptor]):
                with self.assertRaisesRegex(ValueError, 'upstream source differs'):
                    overlay.apply_package(root, [descriptor])
            self.assertEqual((root / records[0][0]).read_bytes(), first)

    def test_unknown_manifest_and_release_are_denied(self):
        with tempfile.TemporaryDirectory(prefix='ct-compat-') as directory:
            root, records, descriptor = self.fixture(directory)
            with patch.object(overlay, 'PATCHES', records), patch.object(overlay, 'DESCRIPTORS', [descriptor]):
                for commitment in [[], [dict(descriptor, id='unreviewed')],
                                   [dict(descriptor, id='early-hook-input-provenance-v1')],
                                   [dict(descriptor, upstreamVersion='latest')]]:
                    with self.assertRaisesRegex(ValueError, 'commitment'):
                        overlay.apply_package(root, commitment)
                (root / 'package.json').write_text(json.dumps({'name': 'openclaw', 'version': '2026.10.11'}))
                with self.assertRaisesRegex(ValueError, 'exact reviewed'):
                    overlay.apply_package(root, [descriptor])

    def test_hard_link_source_is_denied_without_changing_either_name(self):
        with tempfile.TemporaryDirectory(prefix='ct-compat-') as directory:
            root, records, descriptor = self.fixture(directory)
            target = root / records[0][0]
            alias = root / 'shared.mjs'
            os.link(target, alias)
            with patch.object(overlay, 'PATCHES', records), patch.object(overlay, 'DESCRIPTORS', [descriptor]):
                with self.assertRaisesRegex(ValueError, 'regular owned'):
                    overlay.apply_package(root, [descriptor])
            self.assertEqual(target.read_bytes(), records[0][3].encode())
            self.assertEqual(alias.read_bytes(), records[0][3].encode())

    @unittest.skipUnless(os.environ.get('CT_OPENCLAW_PACKAGE'), 'requires the exact reviewed SDK package')
    def test_actual_reviewed_source_diffs_are_exact_and_metadata_changes_only_two_fields(self):
        source = Path(os.environ['CT_OPENCLAW_PACKAGE']).resolve()
        with tempfile.TemporaryDirectory(prefix='ct-compat-real-') as directory:
            root = Path(directory).resolve()
            (root / 'dist').mkdir()
            (root / 'package.json').write_bytes((source / 'package.json').read_bytes())
            for name, before, after, anchor, replacement in overlay.PATCHES:
                data = (source / name).read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                self.assertIn(digest, [before, after])
                original = data.replace(replacement.encode(), anchor.encode()) if digest == after else data
                self.assertEqual(hashlib.sha256(original).hexdigest(), before)
                (root / name).write_bytes(original)
            overlay.apply_package(root, overlay.DESCRIPTORS)
            overlay.apply_package(root, overlay.DESCRIPTORS)
            for name, before, after, anchor, replacement in overlay.PATCHES:
                data = (root / name).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), after)
                self.assertEqual(data.count(replacement.encode()), 1)
                self.assertEqual(hashlib.sha256(data.replace(replacement.encode(), anchor.encode())).hexdigest(), before)
                added = [line.strip() for line in replacement.splitlines() if line not in anchor.splitlines()]
                if name in {row[0] for row in overlay.METADATA_PATCHES}:
                    self.assertEqual(added, ['inputProvenance: params.inputProvenance,',
                                             'currentSourceTurnId: params.currentSourceTurnId,'])

    @unittest.skipUnless(os.environ.get('CT_OPENCLAW_PACKAGE'), 'requires the exact reviewed SDK package')
    def test_actual_old_v1_bytes_are_not_silently_accepted_or_upgraded(self):
        source = Path(os.environ['CT_OPENCLAW_PACKAGE']).resolve()
        with tempfile.TemporaryDirectory(prefix='ct-compat-legacy-') as directory:
            root = Path(directory).resolve()
            (root / 'dist').mkdir()
            (root / 'package.json').write_bytes((source / 'package.json').read_bytes())
            for index, (name, before, after, anchor, replacement) in enumerate(overlay.PATCHES):
                data = (source / name).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), after)
                original = data.replace(replacement.encode(), anchor.encode())
                self.assertEqual(hashlib.sha256(original).hexdigest(), before)
                legacy = replacement.splitlines(keepends=True)
                legacy = ''.join(line for line in legacy if 'currentSourceTurnId:' not in line)
                (root / name).write_bytes(original if index == 0 else original.replace(anchor.encode(), legacy.encode()))
            first = root / overlay.PATCHES[0][0]
            original_first = first.read_bytes()
            with self.assertRaisesRegex(ValueError, 'upstream source differs'):
                overlay.apply_package(root, overlay.DESCRIPTORS)
            self.assertEqual(first.read_bytes(), original_first)


if __name__ == '__main__':
    unittest.main()
