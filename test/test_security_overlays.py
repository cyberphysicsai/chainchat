import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('security_overlays', ROOT / 'installer/security_overlays.py')
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)

class SecurityOverlayTests(unittest.TestCase):
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
        content = b'{"name":"undici","version":"6.29.1","scripts":{"postinstall":"never-run"}}'
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            item = tarfile.TarInfo('package/package.json'); item.size = len(content); archive.addfile(item, io.BytesIO(content))
        with tempfile.TemporaryDirectory(prefix='ct-overlay-test-') as directory:
            overlay.extract_archive(output.getvalue(), Path(directory))
            self.assertEqual((Path(directory) / 'package/package.json').read_bytes(), content)

if __name__ == '__main__': unittest.main()
