import importlib.util
import io
import json
import os
from pathlib import Path
import py_compile
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('security_overlays', ROOT / 'installer/security_overlays.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)

class SecurityOverlayTests(unittest.TestCase):
    def test_payload_helper_loads_source_instead_of_matching_unverified_bytecode(self):
        with tempfile.TemporaryDirectory(prefix='ct-source-helper-') as directory:
            source = Path(directory) / 'npm_security.py'
            source.write_text("MARKER = 'evil'\n", encoding='utf-8')
            py_compile.compile(str(source), doraise=True)
            before = source.stat()
            source.write_text("MARKER = 'safe'\n", encoding='utf-8')
            os.utime(source, ns=(before.st_atime_ns, before.st_mtime_ns))
            spec = importlib.util.spec_from_file_location('negative_control', source)
            negative = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(negative)
            self.assertEqual(negative.MARKER, 'evil')
            with mock.patch.object(overlay, '__file__', str(Path(directory) / 'security_overlays.py')):
                self.assertEqual(overlay._source_helper('npm_security').MARKER, 'safe')
                with self.assertRaises(ValueError): overlay._source_helper('../outside')

    def test_missing_bundled_commitment_holds_before_creating_cache(self):
        with tempfile.TemporaryDirectory(prefix='ct-overlay-test-') as directory:
            application = Path(directory)
            runtime = application / 'openclaw/runtime'
            runtime.mkdir(parents=True)
            (runtime.parent / 'upstream-lock.json').write_text('{}', encoding='utf-8')
            cache = application / 'cache'
            with self.assertRaisesRegex(ValueError, 'commitment is missing'):
                overlay.apply(application, cache)
            self.assertFalse(cache.exists())

    def test_reviewed_archive_pin_and_tamper_refusal(self):
        pin = json.loads((ROOT / 'openclaw/upstream-lock.json').read_text())['bundledDependencyOverlays'][0]
        overlay.validate_pin(pin)
        for change in [{'target': '../user-data'}, {'source': 'https://other.test/archive'}, {'version': '8.12.3'}, {'sha256': '0' * 64}]:
            with self.assertRaises(ValueError): overlay.validate_pin({**pin, **change})
        with self.assertRaises(ValueError): overlay.verify_archive(b'corrupted archive', pin)

    def test_archive_paths_links_and_duplicate_windows_names_are_rejected(self):
        for names in [['package/../../escape'], ['package/a', 'package/A'], ['package\\escape'], ['/package/absolute'], ['package/C:/escape'], ['package/link']]:
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz') as archive:
                for name in names:
                    item = tarfile.TarInfo(name)
                    if name.endswith('/link'): item.type, item.linkname = tarfile.SYMTYPE, '../../escape'
                    else: item.size = 1
                    archive.addfile(item, io.BytesIO(b'x') if item.isfile() else None)
            with tempfile.TemporaryDirectory(prefix='ct-overlay-test-') as directory:
                with self.assertRaises(ValueError): overlay.extract_archive(output.getvalue(), Path(directory))

    def test_verified_extraction_preserves_exact_file_bytes_without_lifecycle_execution(self):
        output = io.BytesIO()
        content = b'{"name":"ip-address","version":"10.7.6","scripts":{"postinstall":"never-run"}}'
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            item = tarfile.TarInfo('package/package.json'); item.size = len(content); archive.addfile(item, io.BytesIO(content))
        with tempfile.TemporaryDirectory(prefix='ct-overlay-test-') as directory:
            overlay.extract_archive(output.getvalue(), Path(directory))
            self.assertEqual((Path(directory) / 'package/package.json').read_bytes(), content)

if __name__ == '__main__': unittest.main()
