"""Response policy boundaries use real disposable chains, not gate mocks."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PRODUCT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("response_threshold_bridge", PRODUCT / "engine_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ResponseThresholdTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "agent"
        self.call("init", name="Response threshold test agent")

    def tearDown(self):
        self.temporary.cleanup()

    def call(self, operation, **values):
        with contextlib.redirect_stdout(io.StringIO()):
            return bridge.dispatch({"op": operation, "root": str(self.root), "registryRoot": str(self.root),
                                    "learning": False, **values})

    def ledger(self):
        return (self.root / "chain" / "rings.jsonl").read_bytes()

    def head(self):
        return self.call("verify")["head"]["hash"]

    def exchange(self, floor=150):
        return {"input": "Please help me think carefully about the question.",
                "output": "We can consider the question carefully and acknowledge uncertainty when information is missing.",
                "scores": {key: floor for key in bridge.DIMENSIONS},
                "assessment": {"approved": True, "fruitages": {key: floor for key in bridge.FRUITAGES},
                               "rationale": "A kind, honest and patient response."}, "usedRings": []}

    def refused(self, code, operation, **values):
        before = self.ledger()
        with self.assertRaises(bridge.BridgeError) as caught:
            self.call(operation, **values)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.ledger(), before, "A held assessment cannot append a response ring.")

    def test_response_150_and_179_pass_native_gate_and_commit_without_rewriting_history(self):
        for floor in (150, 179):
            with self.subTest(floor=floor):
                exchange = self.exchange(floor)
                before = self.ledger()
                evaluated = self.call("evaluate", expectedHead=self.head(), **exchange)
                self.assertEqual(evaluated["assessment"]["floor"], 150)
                self.assertEqual(evaluated["verdict"]["decision"], "SEAL")
                self.assertEqual(self.ledger(), before)
                committed = self.call("commit", expectedHead=self.head(), growth=False, **exchange)
                self.assertTrue(committed["sealed"])
                self.assertTrue(self.ledger().startswith(before))
                self.assertGreater(len(self.ledger()), len(before))
        self.assertTrue(self.call("verify")["verified"])
        self.assertEqual(self.call("inspect")["capabilities"]["fruitageFloor"], 150)
        self.assertEqual(self.call("inspect")["capabilities"]["actionFruitageFloor"], 180)

    def test_response_149_in_any_fruitage_or_covenant_and_explicit_rejection_are_held(self):
        for key in bridge.FRUITAGES:
            value = self.exchange()
            value["assessment"]["fruitages"][key] = 149
            self.refused("COVENANT_REJECTED", "evaluate", **value)
            self.refused("COVENANT_REJECTED", "commit", expectedHead=self.head(), growth=False, **value)
        value = self.exchange()
        value["scores"]["covenant"] = 149
        self.refused("COVENANT_REJECTED", "evaluate", **value)
        value = self.exchange()
        value["assessment"]["approved"] = False
        self.refused("COVENANT_REJECTED", "evaluate", **value)

    def test_batch_revalidates_every_exchange_instead_of_averaging_a_low_score(self):
        good, low = self.exchange(), self.exchange()
        low["assessment"]["fruitages"]["love"] = 149
        self.refused("COVENANT_REJECTED", "commit", expectedHead=self.head(),
                     exchanges=[good, low], growth=False)

    def test_tool_action_and_summary_floors_remain_180_and_json_cannot_select_response_policy(self):
        source = "The user asked to think carefully about a question."
        summary = {"kind": "native-transcript", "text": source,
                   "sha256": hashlib.sha256(source.encode()).hexdigest()}
        for score in (150, 179):
            self.refused("COVENANT_REJECTED", "evaluate_action", **self.exchange(score),
                         response_generation=True, reviewPurpose="response", threshold=150)
            self.refused("COVENANT_REJECTED", "evaluate_summary", expectedHead=self.head(),
                         sourceData=summary, **self.exchange(score))
        action = self.call("evaluate_action", **self.exchange(180))
        self.assertTrue(action["accepted"])
        self.assertEqual(action["assessment"]["floor"], 180)

    def test_paused_response_150_is_read_only_and_149_remains_held(self):
        self.call("dormancy", action="pause", confirmed=True, expectedHead=self.head())
        before = {str(file.relative_to(self.root)): file.read_bytes()
                  for file in self.root.rglob("*") if file.is_file()}
        result = self.call("chat_evaluate", **self.exchange())
        self.assertEqual(result["assessment"]["floor"], 150)
        self.assertFalse(result["sealed"])
        self.refused("COVENANT_REJECTED", "chat_evaluate", **self.exchange(149))
        after = {str(file.relative_to(self.root)): file.read_bytes()
                 for file in self.root.rglob("*") if file.is_file()}
        self.assertEqual(after, before)

    def test_stricter_local_chain_policy_remains_binding_and_is_not_mutated(self):
        policy = self.root / "registry" / "policy.json"
        policy.write_text(json.dumps({"values": {"covenant_floor": 190}}), encoding="utf-8")
        before = policy.read_bytes()
        self.refused("COVENANT_REJECTED", "evaluate", **self.exchange(179))
        self.refused("COVENANT_REJECTED", "commit", expectedHead=self.head(), growth=False, **self.exchange(179))
        accepted = self.call("evaluate", **self.exchange(190))
        self.assertEqual(accepted["assessment"]["floor"], 190)
        self.assertEqual(policy.read_bytes(), before)

    def test_search_candidates_use_response_policy_and_low_candidate_cannot_enter_selection(self):
        request = {"input": self.exchange()["input"], "iterations": 3, "depth": 2,
                   "perspectives": [{"name": "Careful perspective", "summary": self.exchange()["output"],
                                     "scores": self.exchange()["scores"], "assessment": self.exchange()["assessment"],
                                     "usedRings": []}],
                   "rollouts": [{"path": ["Careful perspective", "Check uncertainty"],
                                 "summary": self.exchange()["output"], "scores": self.exchange()["scores"],
                                 "assessment": self.exchange()["assessment"], "usedRings": []}]}
        before = self.ledger()
        result = self.call("search", **request)
        self.assertEqual(result["search"]["winner"]["scores"], self.exchange()["scores"])
        self.assertIn(["Careful perspective", "Check uncertainty"],
                      [node["path"] for node in result["search"]["nodes"]])
        self.assertEqual(self.ledger(), before)
        bad = copy.deepcopy(request)
        bad["perspectives"][0]["assessment"]["fruitages"]["kindness"] = 149
        self.refused("COVENANT_REJECTED", "search", **bad)
        bad = copy.deepcopy(request)
        bad["rollouts"][0]["assessment"]["fruitages"]["kindness"] = 149
        self.refused("COVENANT_REJECTED", "search", **bad)

    def test_derived_response_learning_accepts_150_while_generic_feedback_stays_180(self):
        request = self.exchange()
        self.call("commit", expectedHead=self.head(), growth=False, **request)
        before = self.ledger()
        modality = next(item for item in self.call("inspect")["faculties"] if item["kind"] == "modality")
        labels = {"modalities": [modality["name"]], "senses": []}
        with patch.dict(os.environ, {"CT_TELEMETRY": "on"}):
            result = self.call("teach_response", expectedHead=self.head(), labels=labels, learning=True, **request)
        self.assertTrue(result["extractorTaught"])
        self.assertEqual(self.ledger(), before)
        for operation in ("teach", "feedback"):
            self.refused("COVENANT_REJECTED", operation, expectedHead=self.head(),
                         labels=labels, learning=True, response_generation=True, reviewPurpose="response", **request)


if __name__ == "__main__":
    unittest.main()
