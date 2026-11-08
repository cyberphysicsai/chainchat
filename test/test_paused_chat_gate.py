"""Paused memory never becomes a route around the live PoI review."""
import contextlib
import copy
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PRODUCT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("paused_chat_bridge", PRODUCT / "engine_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class PausedChatGateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "agent"
        self.call("init", name="Paused test agent")
        self.call("dormancy", action="pause", confirmed=True,
                  expectedHead=self.call("verify")["head"]["hash"])

    def tearDown(self):
        self.temporary.cleanup()

    def call(self, op, **values):
        with contextlib.redirect_stdout(io.StringIO()):
            return bridge.dispatch({"op": op, "root": str(self.root), "registryRoot": str(self.root), **values})

    def files(self):
        return {str(file.relative_to(self.root)): file.read_bytes()
                for file in self.root.rglob("*") if file.is_file()}

    def exchange(self):
        return {"input": "Please introduce yourself.",
                "output": "I can help you reason carefully and state uncertainty where information is missing.",
                "scores": {name: 230 for name in bridge.DIMENSIONS},
                "assessment": {"approved": True, "fruitages": {name: 235 for name in bridge.FRUITAGES},
                               "rationale": "An honest, kind and patient introduction."}, "usedRings": []}

    def refused(self, code, op, **values):
        with self.assertRaises(bridge.BridgeError) as caught:
            self.call(op, **values)
        self.assertEqual(caught.exception.code, code)

    def test_paused_prepare_and_gate_are_read_only_and_leave_pause_and_all_history_untouched(self):
        before = self.files()
        prepared = self.call("chat_prepare", input="Please introduce yourself.", learning=True, recall=True)
        self.assertEqual(prepared["runtime"]["mode"], "dormant")
        self.assertFalse(prepared["runtime"]["learning"])
        self.assertEqual(prepared["memories"], [])
        self.assertEqual(prepared["recentHistory"], [])
        self.assertIn("facultyExecution", prepared)
        result = self.call("chat_evaluate", expectedHead=prepared["head"]["hash"], learning=True, **self.exchange())
        self.assertTrue(result["accepted"])
        self.assertFalse(result["sealed"])
        self.assertEqual(result["verdict"]["decision"], "SEAL")
        self.assertEqual(self.files(), before)

    def test_paused_output_cannot_skip_semantic_fields_fruit_floors_or_ring_validation(self):
        before = self.files()
        exchange = self.exchange()
        self.refused("COVENANT_REJECTED", "chat_evaluate", **{**exchange, "assessment": None})
        self.refused("COVENANT_REJECTED", "chat_evaluate", **{**exchange, "assessment": {
            **exchange["assessment"], "fruitages": {**exchange["assessment"]["fruitages"], "faith": 0}}})
        self.refused("POI_REJECTED", "chat_evaluate", **{**exchange, "scores": {**exchange["scores"], "consistency": 0}})
        self.refused("EVIDENCE_INVALID", "chat_evaluate", **{**exchange, "usedRings": [99999]})
        self.assertEqual(before, self.files())

    def test_original_writes_still_refuse_pause_and_reviewed_chat_does_not_bypass_immune_lock(self):
        self.refused("CHAIN_PAUSED", "prepare", input="Hello")
        self.refused("CHAIN_PAUSED", "evaluate", **self.exchange())
        (self.root / "chain" / "LOCKED").write_text("Synthetic local lockdown", encoding="utf-8")
        before = self.files()
        self.refused("CHAIN_LOCKED", "chat_prepare", input="Hello")
        self.refused("CHAIN_LOCKED", "chat_evaluate", **self.exchange())
        self.assertEqual(before, self.files())

    def test_actual_paused_host_policy_is_grounded_without_adding_execution_or_memory_credit(self):
        before = self.files()
        prepared = self.call("chat_prepare", input="Please introduce yourself.")
        exchange = {**self.exchange(), "output": "My host applies my equipped faculties and independently reviews my answers before release. Memory is paused, so I will not claim to have stored this exchange.",
                    "preparationReceipt": prepared["preparationReceipt"], "expectedHead": prepared["head"]["hash"]}
        result = self.call("chat_evaluate", **exchange)
        self.assertEqual(result["verdict"]["decision"], "SEAL")
        self.assertEqual(result["usedRings"], [])
        # More verified implementation context must never rescue an actual
        # semantic refusal, low fruit, fabricated ring or an invented faculty.
        for output in ["I already executed a browser action successfully.", "My equipped faculty is Imaginary-Telescope-48219.", "I remember your earlier telescope serial 48219."]:
            invalid = {**exchange, "output": output, "scores": {**exchange["scores"], "consistency": 0}}
            self.refused("POI_REJECTED", "chat_evaluate", **invalid)
        self.refused("EVIDENCE_INVALID", "chat_evaluate", **{**exchange, "usedRings": [99999]})
        self.assertEqual(before, self.files())

    def test_preparation_receipts_cannot_be_forged_replayed_for_other_input_or_gain_raw_function_authority(self):
        prepared = self.call("chat_prepare", input="Please introduce yourself.")
        exchange = {**self.exchange(), "preparationReceipt": prepared["preparationReceipt"]}
        before = self.files()
        for mutate in [lambda receipt: receipt.update(signature="0" * 64),
                       lambda receipt: receipt["payload"].update(invocation="another-turn"),
                       lambda receipt: receipt["payload"]["faculties"][0].update(function="guarantees truth"),
                       lambda receipt: receipt["payload"].update(issuedAt=0)]:
            forged = copy.deepcopy(prepared["preparationReceipt"]); mutate(forged)
            self.refused("PREPARATION_INVALID", "chat_evaluate", **{**exchange, "preparationReceipt": forged})
        self.refused("PREPARATION_INVALID", "chat_evaluate", **{**exchange, "input": "Another actual request."})
        self.assertEqual(before, self.files())

    def test_paused_readonly_preparation_never_invokes_owner_approved_arbitrary_python(self):
        before = self.files()
        with patch.object(bridge.approved_ops, "run_approved", side_effect=AssertionError("Authored operator must remain off while paused")) as worker:
            prepared = self.call("chat_prepare", input="Please introduce yourself.")
        self.assertFalse(worker.called)
        self.assertTrue(any(row["mechanism"] == "base-op" and row["status"] == "completed" for row in prepared["facultyExecution"]["entries"]))
        self.assertEqual(before, self.files())


if __name__ == "__main__":
    unittest.main()
