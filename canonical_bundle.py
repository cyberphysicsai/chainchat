"""Host-owned canonical source selection. Never accepts a model/request path."""
from __future__ import annotations

import hashlib
import importlib.abc
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


class CanonicalBundleError(Exception):
    pass


def _safe_file(root, name):
    if not isinstance(name, str) or not name or "\\" in name or any(part in ("", ".", "..") for part in name.split("/")):
        raise CanonicalBundleError("Invalid canonical source path.")
    result = root.joinpath(*name.split("/"))
    for item in [root, *root.parents, result, *list(result.parents)[:len(result.parts) - len(root.parts)]]:
        if item.is_symlink():
            raise CanonicalBundleError("Canonical sources cannot be symbolic links.")
    return result


class _CanonicalLoader(importlib.machinery.SourceFileLoader):
    def __init__(self, filename, digest):
        super().__init__(filename.stem, str(filename))
        self.filename, self.digest = filename, digest

    def get_code(self, fullname):
        content = self.filename.read_bytes()
        if hashlib.sha256(content).hexdigest() != self.digest:
            raise CanonicalBundleError("The canonical source changed after selection.")
        # Compile reviewed source; never load an adjacent unverified .pyc.
        return self.source_to_code(content, str(self.filename))


class _CanonicalFinder(importlib.abc.MetaPathFinder):
    def __init__(self, root, files):
        self.root, self.files = root, files

    def find_spec(self, fullname, path=None, target=None):
        name = fullname + ".py"
        if "." in fullname or name not in self.files:
            return None
        filename = _safe_file(self.root, name)
        return importlib.util.spec_from_file_location(fullname, filename,
                                                     loader=_CanonicalLoader(filename, self.files[name]))


def resolve_engine(application):
    encoded = os.environ.get("CT_CHAT_CANONICAL_BUNDLE")
    if encoded:
        if len(encoded.encode("utf-8")) > 65536:
            raise CanonicalBundleError("Canonical source selection is oversized.")
        selected = json.loads(encoded)
        if not isinstance(selected, dict) or set(selected) != {"root", "files", "commit", "manifestSha256"}:
            raise CanonicalBundleError("Invalid canonical source selection.")
        root, files = Path(selected["root"]), selected["files"]
        if not root.is_absolute() or not isinstance(selected["commit"], str) or not re.fullmatch(r"[a-f0-9]{40}", selected["commit"]):
            raise CanonicalBundleError("Invalid canonical source identity.")
        if not isinstance(files, dict):
            raise CanonicalBundleError("Invalid canonical file manifest.")
        digest = hashlib.sha256(json.dumps(dict(sorted(files.items())), ensure_ascii=False,
                                          separators=(",", ":")).encode("utf-8")).hexdigest()
        if digest != selected["manifestSha256"]:
            raise CanonicalBundleError("Canonical manifest identity changed.")
    else:
        root = application / "engine" / "proof-of-interaction"
        files = json.loads((application / "openclaw" / "engine-integrity.json").read_text(encoding="utf-8"))
    if not isinstance(files, dict) or not 20 <= len(files) <= 256:
        raise CanonicalBundleError("Invalid canonical file manifest.")
    for name in ("SKILL.md", "VERSION", "PoI.py", "timechain.py", "registry/modalities.json", "registry/senses.json"):
        if name not in files:
            raise CanonicalBundleError("Incomplete canonical source.")
    total = 0
    for name, expected in files.items():
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise CanonicalBundleError("Invalid canonical file digest.")
        filename = _safe_file(root, name)
        if not filename.is_file() or filename.stat().st_size > 2 * 1024 * 1024:
            raise CanonicalBundleError("Invalid canonical source file.")
        content = filename.read_bytes()
        total += len(content)
        if total > 16 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != expected:
            raise CanonicalBundleError("The canonical source failed its integrity check.")
    packaged = application / "engine" / "proof-of-interaction"
    for filename in root.rglob("*"):
        if filename.is_symlink():
            raise CanonicalBundleError("Canonical sources cannot be symbolic links.")
        relative = filename.relative_to(root)
        if "__pycache__" in relative.parts and root == packaged:
            continue  # Source-only loader below ignores historical seed bytecode.
        if filename.is_file() and relative.as_posix() not in files:
            raise CanonicalBundleError("Unexpected file in canonical source.")
    sys.dont_write_bytecode = True
    sys.meta_path.insert(0, _CanonicalFinder(root, files))
    return root
