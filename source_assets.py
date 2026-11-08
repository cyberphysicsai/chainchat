"""Host-only immutable upload snapshots for standard native Blockspace files.

The JSON request contains metadata, never paths. The owning Node host supplies
the only readable media directory through a private child-process environment.
"""
from __future__ import annotations

import codecs
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile

TYPES = {"image/png": ("image", "png"), "image/jpeg": ("image", "jpg"), "image/webp": ("image", "webp"), "image/gif": ("image", "gif"),
         "audio/wav": ("audio", "wav"), "audio/mpeg": ("audio", "mp3"), "audio/ogg": ("audio", "ogg"), "audio/flac": ("audio", "flac"), "audio/mp4": ("audio", "m4a"),
         "video/mp4": ("video", "mp4"), "video/webm": ("video", "webm"), "application/pdf": ("document", "pdf"), "text/plain": ("document", "txt")}
FIELDS = {"version", "id", "sha256", "bytes", "mimeType", "fileName", "kind", "contentFile"}
MAX_FILE = 20 * 1024 * 1024
MAX_BATCH = 2 * 1024 * 1024 * 1024


class SourceAssetError(Exception):
    code = "SOURCE_ASSET_INVALID"


def invalid():
    raise SourceAssetError("An owned source asset could not be verified. No attachment was committed.")


def descriptors(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 32:
        invalid()
    result = []
    for item in value:
        if not isinstance(item, dict) or set(item) != FIELDS or isinstance(item.get("version"), bool) or item.get("version") != 1:
            invalid()
        identity = item.get("id")
        if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{64}", identity) or item.get("sha256") != identity:
            invalid()
        mime = item.get("mimeType")
        if not isinstance(mime, str) or mime not in TYPES or (item.get("kind"), item.get("contentFile")) != (TYPES[mime][0], "asset." + TYPES[mime][1]):
            invalid()
        if isinstance(item.get("bytes"), bool) or not isinstance(item.get("bytes"), int) or not 1 <= item["bytes"] <= MAX_FILE:
            invalid()
        label = item.get("fileName")
        if not isinstance(label, str) or not 1 <= len(label) <= 160 or re.search(r"[\x00-\x1f\x7f/\\\u2028\u2029]", label):
            invalid()
        result.append(dict(item))
    if len({item["id"] for item in result}) != len(result) or sum(item["bytes"] for item in result) > MAX_FILE:
        invalid()
    return result


def _directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink() or path.resolve() != path or os.name != "nt" and info.st_mode & 0o077:
        invalid()


def _regular(path, limit):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_nlink != 1 or not 1 <= info.st_size <= limit or path.resolve() != path or os.name != "nt" and info.st_mode & 0o077:
        invalid()
    return info


def _magic(head, mime):
    if mime == "image/png": return head.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg": return head.startswith(b"\xff\xd8\xff")
    if mime == "image/gif": return head.startswith((b"GIF87a", b"GIF89a"))
    if mime == "image/webp": return head.startswith(b"RIFF") and head[8:12] == b"WEBP"
    if mime == "audio/wav": return head.startswith(b"RIFF") and head[8:12] == b"WAVE"
    if mime == "audio/mpeg": return head.startswith(b"ID3") or len(head) > 1 and head[0] == 255 and head[1] & 224 == 224
    if mime == "audio/ogg": return head.startswith(b"OggS")
    if mime == "audio/flac": return head.startswith(b"fLaC")
    if mime in ("audio/mp4", "video/mp4"): return head[4:8] == b"ftyp"
    if mime == "video/webm": return head.startswith(b"\x1aE\xdf\xa3")
    if mime == "application/pdf": return head.startswith(b"%PDF-")
    return mime == "text/plain"


class SourceAssetArchive:
    def __init__(self, records):
        self.files, self.records, self._temporary = [], {}, None
        try:
            unique = {}
            for items in records:
                for item in items:
                    if item["id"] in unique and unique[item["id"]] != item:
                        invalid()
                    unique[item["id"]] = item
            if not unique:
                return
            if len(unique) > 4096 or sum(item["bytes"] for item in unique.values()) > MAX_BATCH:
                invalid()
            configured = os.environ.get("CT_CHAT_MEDIA_ROOT")
            if not configured or not Path(configured).is_absolute():
                invalid()
            root = Path(configured)
            _directory(root)
            self._temporary = tempfile.TemporaryDirectory(prefix="chainchat-commit-assets-")
            for identity, item in unique.items():
                home = root / identity
                _directory(home)
                metadata = home / "metadata.json"
                _regular(metadata, 4096)
                metadata_bytes = metadata.read_bytes()
                if json.loads(metadata_bytes.decode("utf-8")) != item:
                    invalid()
                source = home / item["contentFile"]
                before = _regular(source, MAX_FILE)
                if before.st_size != item["bytes"]:
                    invalid()
                role = identity + "." + TYPES[item["mimeType"]][1]
                snapshot = Path(self._temporary.name) / role
                digest, size, head = hashlib.sha256(), 0, b""
                decoder = codecs.getincrementaldecoder("utf-8")("strict") if item["mimeType"] == "text/plain" else None
                with source.open("rb") as incoming, snapshot.open("xb") as output:
                    os.chmod(snapshot, 0o600)
                    opened = os.fstat(incoming.fileno())
                    if (opened.st_ino, opened.st_dev, opened.st_nlink) != (before.st_ino, before.st_dev, 1):
                        invalid()
                    while chunk := incoming.read(1024 * 1024):
                        size += len(chunk)
                        if size > item["bytes"]:
                            invalid()
                        if len(head) < 16: head += chunk[:16 - len(head)]
                        if decoder:
                            if b"\0" in chunk: invalid()
                            decoder.decode(chunk)
                        digest.update(chunk)
                        output.write(chunk)
                    if decoder: decoder.decode(b"", final=True)
                    output.flush()
                    os.fsync(output.fileno())
                after = _regular(source, MAX_FILE)
                if (before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns) or metadata.read_bytes() != metadata_bytes:
                    invalid()
                if size != item["bytes"] or digest.hexdigest() != identity or not _magic(head, item["mimeType"]):
                    invalid()
                self.files.append(snapshot)
                self.records[identity] = {"hash": identity, "size": size, "mime": item["mimeType"], "name": item["fileName"], "kind": item["kind"], "role": role}
        except Exception:
            self.close()
            raise SourceAssetError("An owned source asset could not be verified. No attachment was committed.") from None

    def close(self):
        if self._temporary:
            target = Path(self._temporary.name).resolve()
            if target.parent != Path(tempfile.gettempdir()).resolve() or not target.name.startswith("chainchat-commit-assets-"):
                invalid()
            self._temporary.cleanup()
            self._temporary = None
