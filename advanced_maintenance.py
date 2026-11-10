"""Owner controls over the pinned native recovery, consensus and audit APIs."""

from contextlib import contextmanager
import hashlib
import hmac
import json
import os
import re
import stat
import tempfile
from pathlib import Path

import audit
import encoding_recovery
import epochs
import immune
import modality_ops
from consensus import Quorum, _mac
from continuum import redact_secrets
from registry_store import CANONICAL_REGISTRIES, validate_registry_object, validate_registry_set
from timechain import Timechain


RECOVERY_TARGETS = ("chain/rings.jsonl", *(f"registry/{name}" for name in CANONICAL_REGISTRIES))
MAX_SOURCE_PAGE = 16000  # Unicode code points; Python handles whole characters.
MAX_RECOVERY_BYTES = 64 * 1024 * 1024
HASH = re.compile(r"[a-f0-9]{64}\Z")


class MaintenanceHeld(ValueError):
    pass


def managed_path(root, relative):
    """Reject both symlinks and Windows junctions along every managed path."""
    path = root
    for part in Path(relative).parts:
        path = path / part
        try:
            meta = path.lstat()
        except FileNotFoundError:
            continue
        if (stat.S_ISLNK(meta.st_mode)
                or getattr(meta, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
                or (not stat.S_ISDIR(meta.st_mode) and (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1))):
            raise MaintenanceHeld("A managed path is linked or is not a regular store.")
    return path


def safe_root(request, bridge):
    recorded = Path(request["root"])
    root = bridge.project_root(request)
    if root != recorded:
        raise MaintenanceHeld("The saved Timechain directory moved. Pair its verified location again.")
    for relative in (*RECOVERY_TARGETS, "registry/policy.json", "chain/immune.json", "chain/LOCKED",
                     "chain/PAUSED", "chain/.seal.lock", "chain/checkpoints.jsonl", "chain/blockspace/blobs",
                     "chain/blockspace/index.json", "chain/consensus/config.json", "chain/consensus/attestations.jsonl",
                     "chain/MAINTENANCE_PENDING.json", "chain/PORTABILITY_PENDING.json"):
        managed_path(root, relative)
    return root


def immutable_chain(tc, bridge):
    for ring in tc.iter_rings():
        for ref in ring.get("blockspace_refs", []):
            digest = ref.get("hash", "")
            if not isinstance(digest, str) or not HASH.fullmatch(digest):
                raise bridge.BridgeError("INTEGRITY_FAILED", "An immutable ring has an invalid blockspace reference.")
            managed_path(tc.root, f"chain/blockspace/blobs/{digest}")
    ok, _ = tc.verify()
    if not ok or bridge.compact_head(tc) is None:
        raise bridge.BridgeError("INTEGRITY_FAILED", "The immutable rings or blockspace failed verification.")


def witness_info(quorum, head):
    if not quorum.cfg_path.exists():
        return {"configured": False, "incomplete": quorum.dir.exists()}
    cfg = quorum._cfg()
    witnesses = cfg["witnesses"]
    n, k = cfg["n"], cfg["quorum"]
    if (type(n) is not int or type(k) is not int or not 1 <= k <= n <= 128
            or not isinstance(witnesses, list) or len(witnesses) != n):
        raise MaintenanceHeld("Invalid local witness configuration.")
    keys = {}
    for row in witnesses:
        identifier, key = row["id"], row["key"]
        if (not isinstance(identifier, str) or not 1 <= len(identifier) <= 128 or identifier in keys
                or not isinstance(key, str) or not re.fullmatch(r"(?:[a-fA-F0-9]{2}){16,64}", key)):
            raise MaintenanceHeld("Invalid local witness configuration.")
        keys[identifier] = key
    if len({bytes.fromhex(key) for key in keys.values()}) != n:
        raise MaintenanceHeld("Duplicate local witness keys.")
    rows = quorum._attestations()
    current = {}
    if head:
        message = f"{head['index']}:{head['hash']}"
        for row in rows:
            if row["height"] == head["index"]:
                current.setdefault(row["witness"], row)
        agreeing = sum(row["ring_hash"] == head["hash"] and w in keys and
                       hmac.compare_digest(row["mac"], _mac(keys[w], message)) for w, row in current.items())
    else:
        agreeing = 0
    valid, _ = quorum.verify()
    return {"configured": True, "witnesses": n, "threshold": k, "agreeingAtHead": agreeing,
            "historyValid": bool(valid), "headAttested": bool(valid and agreeing >= k),
            "headRowsPresent": bool(current)}


class CorpusAudit(audit.Audit):
    """Preserve the last audit state across unrelated later Continuum imports."""

    def __init__(self, root, quarantined):
        super().__init__(root)
        self.quarantined = quarantined

    def _head_state(self):
        if not self.quarantined:
            state = super()._head_state()
            if (state or {}).get("audit"):
                return state
        latest = state = None
        for ring in self.tc.iter_rings():
            if ring["index"] in self.quarantined:
                continue
            candidate = (ring.get("payload") or {}).get("state")
            if isinstance(candidate, dict) and candidate:
                state = candidate
                if candidate.get("audit"):
                    latest = candidate
        if latest and state:
            return {**state, "audit": latest["audit"]}
        return latest or state

    @contextmanager
    def _active_reviews(self):
        if not self.quarantined:
            yield
            return
        rings = self.tc.iter_rings
        def filter_reviews():
            for ring in rings():
                if ring["index"] in self.quarantined and (ring.get("payload") or {}).get("event") == "audit_review":
                    continue
                yield ring
        self.tc.iter_rings = filter_reviews
        try:
            yield
        finally:
            self.tc.iter_rings = rings

    def _review_sets(self, scope):
        with self._active_reviews():
            return super()._review_sets(scope)

    def validate(self, require_complete=False, require_depth=False):
        with self._active_reviews():
            return super().validate(require_complete=require_complete, require_depth=require_depth)


def corpus_view(manager):
    status = manager.status()
    scope = status["scope"] if status else {"roles": None, "exclude_roles": []}
    included, reviewed, deep = manager._review_sets(scope)
    quarantined = manager.quarantined
    eligible = included - deep - quarantined
    pending = min(eligible) if eligible else None
    failures = (status or {}).get("challenge_failures", 0)
    return {"open": status is not None, "total": len(included), "reviewed": len(reviewed), "deep": len(deep),
            "next": pending, "quarantinedPending": len(included & quarantined), "scope": scope,
            "challengeFailures": failures, "complete": bool(included and deep == included and not failures and not included & quarantined)}


def digest_plan(plan):
    return hashlib.sha256(json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise MaintenanceHeld("Choose a number in the displayed range.")
    return value


def owner_text(value, name, maximum, bridge):
    value = bridge.text_value(value, name, maximum)
    safe, redacted = redact_secrets(value)
    if redacted or safe != value:
        raise MaintenanceHeld("Remove secret material before recording the note.")
    return value


def inspect_encoding(file):
    try:
        result = encoding_recovery.inspect_path(file)
        if result["recoverable"] and file.name in CANONICAL_REGISTRIES:
            value = json.loads(file.read_bytes().decode(result["source_encoding"]))
            validate_registry_object(file.name, value, file)
        return {"state": result["status"], "recoverable": result["recoverable"], "hash": result["sha256"]}
    except (encoding_recovery.RecoveryError, OSError, ValueError, RuntimeError):
        return {"state": "invalid", "recoverable": False}


def status_view(root, tc, bridge):
    status = {"targets": [name for name in RECOVERY_TARGETS if (root / name).is_file()],
              "interruptedMaintenance": bridge.maintenance_status(root),
              "locked": (tc.dir / "LOCKED").exists(), "paused": (tc.dir / "PAUSED").exists(),
              "integrity": False, "head": None}
    try:
        immutable_chain(tc, bridge)
        status["head"] = bridge.compact_head(tc)
        status["integrity"] = True
    except (bridge.BridgeError, ValueError, OSError, TypeError, KeyError, AttributeError):
        return status
    try:
        status["witness"] = witness_info(Quorum(root), status["head"])
    except (ValueError, OSError, TypeError, KeyError):
        status["witness"] = {"configured": True, "historyValid": False}
    try:
        immune_state = immune.Immune(root).state()
        status["locked"] = status["locked"] or immune_state.get("locked") is True
        status["corpus"] = corpus_view(CorpusAudit(root, set(immune_state["quarantine"])))
    except (ValueError, OSError, TypeError, KeyError):
        pass  # Preserve access to offline recovery controls when a separate store is damaged.
    return status


def witness_init(tc, n, threshold):
    # Stage the two private stores and publish them together. Existing witness
    # custody is never replaced, even when its configuration cannot be read.
    final = Quorum(tc.root).dir
    if final.exists():
        raise MaintenanceHeld("Existing witness storage needs local inspection.")
    with tempfile.TemporaryDirectory(prefix=".witness-", dir=tc.dir) as temp:
        quorum = Quorum(tc.root)
        quorum.dir = Path(temp) / "consensus"
        quorum.cfg_path = quorum.dir / "config.json"
        quorum.att_path = quorum.dir / "attestations.jsonl"
        quorum.init(n=n, quorum=threshold)
        quorum.dir.chmod(0o700)
        quorum.cfg_path.chmod(0o600)
        quorum.attest()
        quorum.att_path.chmod(0o600)
        head = tc.head()
        if not head or not witness_info(quorum, {"index": head["index"], "hash": head["ring_hash"]})["headAttested"]:
            raise MaintenanceHeld("The new witness quorum failed to attest the current head.")
        for file in (quorum.cfg_path, quorum.att_path):
            with file.open("r+b") as handle:
                os.fsync(handle.fileno())
        quorum.dir.rename(final)


def operation(root, tc, request, bridge):
    action = request["action"]
    if action == "status":
        return {"status": status_view(root, tc, bridge)}

    plan = {"action": action}
    if action in {"encoding", "snapshots", "restore-registry"}:
        target = request.get("target")
        if target not in RECOVERY_TARGETS or not (root / target).is_file():
            raise MaintenanceHeld("Select an existing managed recovery store.")
        file = root / target
        if action != "snapshots" and file.stat().st_size > MAX_RECOVERY_BYTES:
            raise MaintenanceHeld("This recovery store exceeds the browser tool's 64 MiB limit. Use the bundled native recovery tool with adequate memory.")
        plan["target"] = target

    # Encoding is the one operation that can repair unreadable ring bytes. The
    # native encoding tool checks every ring hash before any replacement.
    if action == "encoding":
        plan.update(inspect_encoding(file))
        if request.get("phase") == "preview":
            return {"plan": plan, "previewDigest": digest_plan(plan)}
        if not plan["recoverable"]:
            raise MaintenanceHeld("This store has no validated legacy encoding conversion.")
        confirm_plan(plan, request, bridge)
        result = encoding_recovery.recover_path(file, confirmed=True)
        return {"receipt": repair_receipt(result)}

    immutable_chain(tc, bridge)
    head = bridge.compact_head(tc)
    plan["head"] = head
    if action == "snapshots":
        if target == "chain/rings.jsonl":
            raise MaintenanceHeld("Select a registry to list its sealed snapshots.")
        rows = encoding_recovery.list_registry_snapshots(root, file.name)
        return {"snapshots": [{key: row[key] for key in ("ring", "hash", "valid")}
                              for row in reversed(rows[-200:]) if HASH.fullmatch(row.get("hash") or "")]}

    if action == "restore-registry":
        if target == "chain/rings.jsonl":
            raise MaintenanceHeld("A Timechain history cannot be replaced with a registry snapshot.")
        index = integer(request.get("ring"), 0, head["index"])
        _, ref, snapshot = encoding_recovery._registry_snapshot(tc, file.name, index)
        encoding_recovery._decode_registry_snapshot(file.name, snapshot, "cp1252", file)
        plan.update(ring=index, hash=ref["hash"], before=hashlib.sha256(file.read_bytes()).hexdigest())
        apply = lambda: repair_receipt(encoding_recovery.restore_registry_snapshot(root, file.name, index, confirmed=True))
    elif action == "reanchor":
        if any((tc.dir / name).exists() for name in ("LOCKED", "PAUSED", "MAINTENANCE_PENDING.json", "PORTABILITY_PENDING.json")):
            raise MaintenanceHeld("Resolve the separate Timechain hold before re-anchoring a registry.")
        if immune.Immune(root).state().get("locked"):
            raise MaintenanceHeld("Resolve immune lockdown before re-anchoring a registry.")
        validate_registry_set(root)
        bridge.compatible_policy(root)
        bridge.portable_faculties.verified_portability_state(root)
        witness = witness_info(Quorum(root), head)
        if witness["configured"] and not witness["headAttested"]:
            raise MaintenanceHeld("Verify the current witness quorum before re-anchoring.")
        reason = owner_text(request.get("reason"), "Recovery reason", 512, bridge)
        plan.update(registryHashes=epochs.registry_hashes(root), reason=reason)
        apply = lambda: {"reanchored": bool(epochs.seal_epoch(root, reason=reason, accept_current=True))}
    else:
        bridge.verified_chain(root, require_writable=action in {"witness-init", "witness-attest", "corpus-open", "corpus-record"})
        if action == "immune-recover":
            if bridge.maintenance_status(root) or (tc.dir / "PORTABILITY_PENDING.json").exists():
                raise MaintenanceHeld("A separate interrupted transaction requires local operator review.")
            guard = immune.Immune(root)
            state = guard.state()
            if not (guard.lock_path.exists() or state.get("locked")):
                raise MaintenanceHeld("Immune recovery requires an active lockdown.")
            first = integer(request.get("ring"), 1, head["index"])
            reason = owner_text(request.get("reason"), "Recovery reason", 512, bridge)
            plan.update(first=first, last=head["index"], reason=reason,
                        immuneState=digest_plan(state))
            def apply():
                if not guard.lock_path.exists():
                    bridge.durable_json(guard.lock_path, {"reason": "Owner-reviewed immune recovery"})
                return {"recoveryRing": guard.rollback(first, lesson=reason)["recovery_ring"]}
        elif action.startswith("witness-"):
            quorum = Quorum(root)
            witness = witness_info(quorum, head)
            if action == "witness-verify":
                return {"witness": witness}
            if action == "witness-init":
                if witness["configured"] or witness.get("incomplete"):
                    raise MaintenanceHeld("Witness storage already exists. Existing keys are never replaced here.")
                n = integer(request.get("witnesses"), 1, 16)
                threshold = integer(request.get("threshold"), 1, n)
                plan.update(witnesses=n, threshold=threshold)
                def apply():
                    witness_init(tc, n, threshold)
                    return {"witness": witness_info(Quorum(root), head)}
            else:
                if not witness["configured"] or not witness["historyValid"] or witness["headRowsPresent"]:
                    raise MaintenanceHeld("Only a verified chain with a missing head attestation can be attested here.")
                plan["witness"] = witness
                def apply():
                    quorum.attest()
                    return {"witness": witness_info(quorum, head)}
        else:
            quarantined = set(immune.Immune(root).state()["quarantine"])
            manager = CorpusAudit(root, quarantined)
            corpus = corpus_view(manager)
            if action == "corpus-next":
                if not corpus["open"] or corpus["next"] is None:
                    return {"corpus": corpus, "block": None}
                index = corpus["next"]
                if request.get("ring") is not None and request["ring"] != index:
                    raise MaintenanceHeld("The review queue advanced. Load the next block again.")
                content = manager._block_content(index)
                offset = integer(request.get("offset", 0), 0, len(content))
                page = content[offset:offset + MAX_SOURCE_PAGE]
                return {"corpus": corpus, "block": {"index": index, "text": page, "characters": len(content),
                        "offset": offset, "nextOffset": offset + len(page) if offset + len(page) < len(content) else None}}
            if action == "corpus-report":
                if not corpus["open"]:
                    raise MaintenanceHeld("Open a corpus review first.")
                valid, lines = manager.validate(require_complete=True, require_depth=True)
                final = valid and corpus["complete"]
                findings = (manager.status() or {}).get("recent_findings", [])[-8:]
                return {"corpus": corpus, "report": {"final": final,
                        "text": "\n".join(["Final review" if final else "Interim review", *lines[-16:], *findings])[:24000]}}
            if action == "corpus-open":
                if corpus["open"] or not corpus["total"]:
                    raise MaintenanceHeld("Use the current ledger or ingest source text before starting one.")
                objective = owner_text(request.get("reason"), "Review objective", 512, bridge)
                plan.update(blocks=corpus["total"], objective=objective)
                def apply():
                    _, ring = manager.open(objective=objective, exclude_roles=[], strict_depth=True)
                    return {"reviewRing": ring["index"]}
            elif action == "corpus-record":
                index = integer(request.get("ring"), 1, head["index"])
                if not corpus["open"] or index != corpus["next"]:
                    raise MaintenanceHeld("Record only the current queued review block.")
                finding = owner_text(request.get("finding"), "Finding", 4000, bridge)
                content = manager._block_content(index)
                if (len(finding) < manager.MIN_DEEP_FINDING_LEN or
                        modality_ops.richness(finding)["score"] < modality_ops.RICHNESS_FLOOR or
                        not audit._finding_anchors_in(finding, [{"content": content}])):
                    raise MaintenanceHeld("Write a substantive finding and cite an exact symbol or value from the block.")
                plan.update(ring=index, finding=finding, sourceHash=hashlib.sha256(content.encode("utf-8")).hexdigest())
                def apply():
                    # An independent import or quarantine can change the scope
                    # counts after the previous audit state was sealed.
                    state = manager._head_state()
                    current = state["audit"]
                    included, reviewed, deep = manager._review_sets(current["scope"])
                    total_lines = reviewed_lines = 0
                    for ring in tc.iter_rings():
                        if ring["index"] in included:
                            count = audit._block_lines(ring["payload"]["data"])
                            total_lines += count
                            if ring["index"] in reviewed:
                                reviewed_lines += count
                    current.update(total_blocks=len(included), total_lines=total_lines, reviewed_lines=reviewed_lines,
                                   deep_reviews=len(deep), shallow_reviews=len(reviewed - deep))
                    manager._head_state = lambda: state
                    _, ring, _ = manager.record([index], finding=finding, status="owner-reviewed")
                    return {"reviewRing": ring["index"]}
            else:
                raise MaintenanceHeld("Unknown Timechain maintenance action.")

    if request.get("phase") == "preview":
        return {"plan": plan, "previewDigest": digest_plan(plan)}
    confirm_plan(plan, request, bridge)
    # The CLI audit pointer belongs to an external skill installation. Browser
    # review resumes from canonical audit rings and never touches that pointer.
    audit._set_active = audit._clear_active = lambda *_: None
    with bridge.native_writes_under_lock(root):
        result = apply()
    return {"receipt": result, "head": bridge.compact_head(tc)}


def confirm_plan(plan, request, bridge):
    if request.get("phase") != "apply" or request.get("confirm") is not True:
        raise bridge.BridgeError("CONFIRMATION_REQUIRED", "Preview the action and explicitly confirm it.")
    proof = request.get("previewDigest")
    if not isinstance(proof, str) or not HASH.fullmatch(proof) or not hmac.compare_digest(proof, digest_plan(plan)):
        raise bridge.BridgeError("STALE_PREVIEW", "The Timechain or selected store changed. Open a new preview.")


def repair_receipt(value):
    backup = Path(value["backup"])
    backup.chmod(0o600)
    return {"backup": backup.name, "before": value["before_sha256"], "after": value["after_sha256"],
            "reanchored": False}


def handle(request, bridge):
    try:
        root = safe_root(request, bridge)
        tc = Timechain(root)
        if request.get("phase") == "apply":
            with bridge.strict_append_lock(tc):
                return operation(root, tc, request, bridge)
        return operation(root, tc, request, bridge)
    except encoding_recovery.RecoveryError as error:
        raise bridge.BridgeError("RECOVERY_HELD", "Native recovery could not validate the selected store or snapshot.") from error
    except MaintenanceHeld as error:
        raise bridge.BridgeError("MAINTENANCE_HELD", str(error)) from error
    except (ValueError, OSError, TypeError, KeyError) as error:
        # Native decoder errors can include raw file material.
        raise bridge.BridgeError("MAINTENANCE_HELD", "A local maintenance store failed validation.") from error
