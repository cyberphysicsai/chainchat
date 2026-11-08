"""Source-only imports and host-selected immutable bundle integrity."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import py_compile
import struct
import subprocess
import sys
import tempfile
import unittest

PRODUCT = Path(__file__).resolve().parents[1]


class CanonicalBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.application = Path(self.temporary.name)
        self.root = self.application / "engine" / "proof-of-interaction"
        self.root.mkdir(parents=True)
        names = ["SKILL.md", "VERSION", "PoI.py", "timechain.py", "registry/modalities.json", "registry/senses.json",
                 *[f"fixture{number}.py" for number in range(14)]]
        self.files = {}
        for name in names:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            content = b'VERIFIED = "source-only"\n' if name.endswith(".py") else b"canonical fixture\n"
            file.write_bytes(content)
            self.files[name] = hashlib.sha256(content).hexdigest()
        (self.application / "openclaw").mkdir()
        self.write_manifest()

    def tearDown(self):
        self.temporary.cleanup()

    def write_manifest(self):
        (self.application / "openclaw" / "engine-integrity.json").write_text(json.dumps(self.files), encoding="utf-8")

    def run_loader(self, extra="", environment=None):
        script = ("from pathlib import Path; import canonical_bundle; "
                  f"root=canonical_bundle.resolve_engine(Path({str(self.application)!r})); "
                  "import timechain; assert timechain.VERIFIED == 'source-only'; " + extra)
        return subprocess.run([sys.executable, "-B", "-c", script], cwd=PRODUCT,
                              env={**os.environ, "CT_CHAT_CANONICAL_BUNDLE": "", **(environment or {})},
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)

    def test_verified_source_imports_without_creating_bytecode(self):
        self.assertEqual(self.run_loader().returncode, 0)
        self.assertFalse((self.root / "__pycache__").exists())

    def test_hash_mismatch_or_extra_importable_source_is_refused(self):
        (self.root / "fixture0.py").write_text("raise RuntimeError('changed source')", encoding="utf-8")
        self.assertNotEqual(self.run_loader().returncode, 0)
        (self.root / "fixture0.py").write_bytes(b'VERIFIED = "source-only"\n')
        (self.root / "unreviewed.py").write_text("raise RuntimeError('extra source')", encoding="utf-8")
        self.assertNotEqual(self.run_loader().returncode, 0)

    def test_manifest_path_traversal_is_refused_before_import(self):
        self.files["../escaped.py"] = "0" * 64
        self.write_manifest()
        self.assertNotEqual(self.run_loader().returncode, 0)

    def test_private_selection_requires_exact_fields_and_manifest_digest(self):
        value = {"root": str(self.root), "files": self.files, "commit": "a" * 40, "manifestSha256": "0" * 64}
        self.assertNotEqual(self.run_loader(environment={"CT_CHAT_CANONICAL_BUNDLE": json.dumps(value)}).returncode, 0)
        value["manifestSha256"] = hashlib.sha256(json.dumps(dict(sorted(self.files.items())), separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(self.run_loader(environment={"CT_CHAT_CANONICAL_BUNDLE": json.dumps(value)}).returncode, 0)
        value["untrustedRequestOverride"] = True
        self.assertNotEqual(self.run_loader(environment={"CT_CHAT_CANONICAL_BUNDLE": json.dumps(value)}).returncode, 0)

    def test_even_timestamp_matching_adjacent_bytecode_cannot_override_hash_verified_source(self):
        source = self.root / "timechain.py"
        malicious = self.application / "unreviewed.py"
        malicious.write_text("raise RuntimeError('unverified bytecode executed')", encoding="utf-8")
        compiled = Path(importlib.util.cache_from_source(str(source)))
        compiled.parent.mkdir()
        py_compile.compile(str(malicious), cfile=str(compiled), doraise=True)
        data = bytearray(compiled.read_bytes())
        stat = source.stat()
        data[8:16] = struct.pack("<II", int(stat.st_mtime), stat.st_size)
        compiled.write_bytes(data)
        self.assertEqual(self.run_loader().returncode, 0)


if __name__ == "__main__":
    unittest.main()
