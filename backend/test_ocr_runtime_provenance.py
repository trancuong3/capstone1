"""Per-scan VietOCR provenance tests without real weights, GPUs or Supabase.

Proves runtime identity is derived from the Predictor actually loaded with a
verified local file rather than an active-model database row. Live real-engine
coverage remains the separate strict real-OCR CI quality gate.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.services import ocr_engine


class FakePredictor:
    def __init__(self, config):
        self.config = config

    def predict(self, _image):
        return "Chú mèo"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class RuntimeProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="viread-ocr-provenance-")
        self.addCleanup(self.temp.cleanup)
        self.original_bytes = b"original fake pytorch weights - test only"
        self.flow1_bytes = b"flow1 fake pytorch weights - test only"
        self.flow2_bytes = b"flow2 fake pytorch weights - test only"
        self.paths = {}
        for profile, blob in (
            ("ORIGINAL", self.original_bytes),
            ("FLOW1_EXTERNAL_TRDG", self.flow1_bytes),
            ("FLOW2_ADMIN_VERIFIED", self.flow2_bytes),
        ):
            target = Path(self.temp.name) / (profile + ".pth")
            target.write_bytes(blob)
            self.paths[profile] = str(target)

        self.hashes = {
            "ORIGINAL": sha(self.original_bytes),
            "FLOW1_EXTERNAL_TRDG": sha(self.flow1_bytes),
            "FLOW2_ADMIN_VERIFIED": sha(self.flow2_bytes),
        }
        lock = json.loads((
            Path(ocr_engine.__file__).resolve().parents[3]
            / "ai" / "vietocr_v2" / "original_artifact.json"
        ).read_text(encoding="utf-8"))
        arch = lock["architecture"]
        self.base_config = {
            "backbone": arch["backbone"],
            "cnn": deepcopy(arch["cnn"]),
            "seq_modeling": arch["seq_modeling"],
            "transformer": deepcopy(arch["transformer"]),
            "dataset": deepcopy(arch["input"]),
            "vocab": "abc",
            "weights": self.paths["ORIGINAL"],
        }
        self.artifacts = {
            profile: (self.paths[profile], None, None)
            for profile in ("FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED")
        }

    def active(self, profile):
        return {
            "profile": profile,
            "checkpoint_sha256": self.hashes[profile],
            "storage_path": "private/test-manifest.json",
        }

    @contextmanager
    def runtime(self, active_model):
        def obtain_artifact(active):
            return self.artifacts[active["profile"]]

        fake_torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: False),
            set_num_threads=lambda _n: None,
        )
        cfg = SimpleNamespace(
            load_config_from_name=lambda _name: deepcopy(self.base_config)
        )
        with (
            patch.object(ocr_engine, "_paddle_engine", object()),
            patch.object(ocr_engine, "_vietocr_engine", None),
            patch.object(ocr_engine, "_ocr_dependencies_loaded", True),
            patch.object(ocr_engine, "Cfg", cfg),
            patch.object(ocr_engine, "Predictor", FakePredictor),
            patch.object(ocr_engine, "torch", fake_torch),
            patch.object(ocr_engine, "_active_viread_model", return_value=active_model),
            patch.object(ocr_engine, "_v2_artifact_from_storage", side_effect=obtain_artifact),
            patch.object(ocr_engine, "_find_cached_vietocr_weights", return_value=self.paths["ORIGINAL"]),
            patch.object(ocr_engine, "_ORIGINAL_VIETOCR_SHA256", self.hashes["ORIGINAL"]),
            patch.object(ocr_engine, "_ORIGINAL_VOCAB_SIZE", 3),
            patch.object(ocr_engine, "_ORIGINAL_VOCAB_SHA256", sha(json.dumps(
                "abc", ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8"))),
            patch.object(ocr_engine, "package_version", return_value="0.3.12"),
        ):
            yield

    def test_original_checkpoint_observed_from_loaded_predictor(self):
        with self.runtime(self.active("ORIGINAL")):
            _, predictor = ocr_engine._get_ocr_engines()
            result = ocr_engine._scan_runtime_context.provenance
            self.assertIsInstance(predictor, FakePredictor)
            self.assertEqual(result["model_profile"], "ORIGINAL")
            self.assertEqual(result["checkpoint_sha256"], self.hashes["ORIGINAL"])
            self.assertEqual(result["model_load_status"], "loaded")
            self.assertEqual(result["engine_version"], "0.3.12")
            self.assertIsNone(result["fallback_reason"])

    def test_flow1_and_flow2_have_different_verified_runtime_digests(self):
        for profile in ("FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED"):
            with self.subTest(profile=profile), self.runtime(self.active(profile)):
                _, predictor = ocr_engine._get_ocr_engines()
                result = ocr_engine._scan_runtime_context.provenance
                self.assertIsInstance(predictor, FakePredictor)
                self.assertEqual(result["model_profile"], profile)
                self.assertEqual(result["checkpoint_sha256"], self.hashes[profile])
                self.assertEqual(result["model_load_status"], "loaded")

    def test_invalid_cached_artifact_never_becomes_provenance(self):
        with self.runtime(self.active("FLOW1_EXTERNAL_TRDG")):
            self.artifacts["FLOW1_EXTERNAL_TRDG"] = (self.paths["ORIGINAL"], None, None)
            _, engine = ocr_engine._get_ocr_engines()
            self.assertIsNone(engine)
            result = ocr_engine._scan_runtime_context.provenance
            self.assertIsNone(result["checkpoint_sha256"])
            self.assertIsNone(result["model_profile"])
            self.assertEqual(result["model_load_status"], "unavailable")
            self.assertEqual(result["fallback_reason"], "model_initialization_failed")

    def test_failed_flow1_download_falls_back_to_verified_original(self):
        with self.runtime(self.active("FLOW1_EXTERNAL_TRDG")):
            self.artifacts.pop("FLOW1_EXTERNAL_TRDG")
            _, engine = ocr_engine._get_ocr_engines()
            self.assertIsInstance(engine, FakePredictor)
            result = ocr_engine._scan_runtime_context.provenance
            self.assertEqual(result["model_profile"], "ORIGINAL")
            self.assertEqual(result["checkpoint_sha256"], self.hashes["ORIGINAL"])
            self.assertEqual(result["model_load_status"], "fallback_loaded")
            self.assertEqual(result["fallback_reason"], "checkpoint_unavailable_or_invalid")

    def test_registry_change_retains_true_old_instance_hash_on_failed_reload(self):
        old_active = self.active("FLOW1_EXTERNAL_TRDG")
        new_active = self.active("FLOW2_ADMIN_VERIFIED")
        pointer = {"value": old_active}
        with self.runtime(old_active), patch.object(
            ocr_engine, "_active_viread_model", side_effect=lambda: pointer["value"]
        ):
            _, old_engine = ocr_engine._get_ocr_engines()
            pointer["value"] = new_active
            self.artifacts.pop("FLOW2_ADMIN_VERIFIED")
            # After the Flow 2 download fails, the runtime first attempts to
            # load verified Original. Force that SECOND attempt to fail too:
            # only then must the prior Flow 1 Predictor remain in service.
            with patch.object(
                ocr_engine.Cfg, "load_config_from_name",
                side_effect=RuntimeError("test-only Original load failure"),
            ):
                _, still_loaded = ocr_engine._get_ocr_engines()
            self.assertIs(still_loaded, old_engine)
            result = ocr_engine._scan_runtime_context.provenance
            self.assertEqual(result["model_profile"], "FLOW1_EXTERNAL_TRDG")
            self.assertEqual(result["checkpoint_sha256"], self.hashes["FLOW1_EXTERNAL_TRDG"])
            self.assertNotEqual(result["checkpoint_sha256"], new_active["checkpoint_sha256"])
            self.assertEqual(result["model_load_status"], "stale_loaded")
            self.assertEqual(result["fallback_reason"], "checkpoint_unavailable_or_invalid")

    def test_flow2_download_failure_uses_original_when_original_is_healthy(self):
        with self.runtime(self.active("FLOW2_ADMIN_VERIFIED")):
            self.artifacts.pop("FLOW2_ADMIN_VERIFIED")
            _, engine = ocr_engine._get_ocr_engines()
            self.assertIsInstance(engine, FakePredictor)
            snapshot = ocr_engine._scan_runtime_context.provenance
            self.assertEqual(snapshot["model_profile"], "ORIGINAL")
            self.assertEqual(snapshot["checkpoint_sha256"], self.hashes["ORIGINAL"])
            self.assertEqual(snapshot["model_load_status"], "fallback_loaded")
            self.assertEqual(snapshot["fallback_reason"], "checkpoint_unavailable_or_invalid")

    def test_runtime_identity_survives_concurrent_registry_switch(self):
        with self.runtime(self.active("FLOW1_EXTERNAL_TRDG")):
            _, original_instance = ocr_engine._get_ocr_engines()
            self.assertEqual(
                ocr_engine._scan_vietocr_snapshot(original_instance)["checkpoint_sha256"],
                self.hashes["FLOW1_EXTERNAL_TRDG"],
            )
            with patch.object(
                ocr_engine, "_active_viread_model",
                return_value=self.active("FLOW2_ADMIN_VERIFIED"),
            ):
                _, replacement_instance = ocr_engine._get_ocr_engines()
            self.assertIsNot(replacement_instance, original_instance)
            old_snapshot = ocr_engine._scan_vietocr_snapshot(original_instance)
            new_snapshot = ocr_engine._scan_vietocr_snapshot(replacement_instance)
            self.assertEqual(old_snapshot["checkpoint_sha256"], self.hashes["FLOW1_EXTERNAL_TRDG"])
            self.assertEqual(new_snapshot["checkpoint_sha256"], self.hashes["FLOW2_ADMIN_VERIFIED"])

    def test_foreign_or_mock_predictor_never_inherits_registry_digest(self):
        runtime = ocr_engine._scan_vietocr_snapshot(
            object(),
            requested_profile="FLOW1_EXTERNAL_TRDG",
            requested_sha="a" * 64,
        )
        self.assertEqual(runtime["model_load_status"], "unverified")
        self.assertIsNone(runtime["checkpoint_sha256"])
        self.assertIsNone(runtime["model_profile"])

    def test_scan_metadata_uses_verified_instance_and_excludes_private_paths(self):
        with self.runtime(self.active("FLOW2_ADMIN_VERIFIED")):
            _, engine = ocr_engine._get_ocr_engines()
            ocr_engine._scan_runtime_context.provenance = None
            with (
                patch.object(ocr_engine, "_get_ocr_engines", return_value=(object(), engine)),
                patch.object(ocr_engine, "_extract_text_and_boxes_dual_engine", return_value={
                    "text": "Chú mèo",
                    "words": [],
                    "metadata": {"engine": "paddleocr_vietocr_dual",
                                 "engine_statuses": {"paddleocr": "success", "vietocr": "success", "tesseract": "not_run"}},
                }),
            ):
                result = ocr_engine.extract_text_and_boxes(b"synthetic")
            meta = result["metadata"]
            self.assertEqual(meta["model_profile"], "FLOW2_ADMIN_VERIFIED")
            self.assertEqual(meta["checkpoint_sha256"], self.hashes["FLOW2_ADMIN_VERIFIED"])
            self.assertEqual(meta["vietocr_runtime_provenance"]["model_inference_status"], "success")
            self.assertNotIn("storage_path", str(meta))
            self.assertNotIn(self.paths["FLOW2_ADMIN_VERIFIED"], str(meta))

    def test_tesseract_scan_cannot_claim_a_loaded_vietocr_model(self):
        with (
            patch.object(ocr_engine, "_get_ocr_engines", side_effect=ocr_engine.OcrEngineUnavailable("paddle absent")),
            patch.object(ocr_engine, "_extract_text_and_boxes_tesseract", return_value={
                "text": "mèo", "words": [], "metadata": {"engine": "tesseract"},
            }),
        ):
            result = ocr_engine.extract_text_and_boxes(b"synthetic")
        meta = result["metadata"]
        self.assertIsNone(meta["checkpoint_sha256"])
        self.assertIsNone(meta["model_profile"])
        self.assertEqual(meta["model_load_status"], "not_run")
        self.assertEqual(meta["fallback_reason"], "paddle_unavailable")

    def test_scan_metadata_flags_inference_failure_without_exposing_exception(self):
        with self.runtime(self.active("ORIGINAL")):
            _, engine = ocr_engine._get_ocr_engines()
            with (
                patch.object(ocr_engine, "_get_ocr_engines", return_value=(object(), engine)),
                patch.object(ocr_engine, "_extract_text_and_boxes_dual_engine", return_value={
                    "text": "mèo", "words": [],
                    "metadata": {"engine": "paddleocr_vietocr_dual",
                                 "engine_statuses": {"paddleocr": "success", "vietocr": "error", "tesseract": "not_run"}},
                }),
            ):
                result = ocr_engine.extract_text_and_boxes(b"synthetic")
            self.assertEqual(result["metadata"]["fallback_reason"], "vietocr_inference_error")
            self.assertEqual(result["metadata"]["model_profile"], "ORIGINAL")

    def test_corrupt_chunk_is_cleaned_up_and_can_be_retried(self):
        import app.services.storage_service as storage
        content = b"part A" + b"part B"
        expected = sha(content)
        manifest = {
            "checkpoint_sha256": expected,
            "chunks": [
                {"index": 0, "path": "private/chunk-a", "bytes": 6, "sha256": sha(b"part A")},
                {"index": 1, "path": "private/chunk-b", "bytes": 6, "sha256": sha(b"part B")},
            ],
        }
        active = {"checkpoint_sha256": expected, "storage_path": "private/manifest"}
        chunks = {
            "private/manifest": json.dumps(manifest).encode("utf-8"),
            "private/chunk-a": b"part A",
            "private/chunk-b": b"INVALID",
        }
        with (
            patch.object(storage, "download_object", side_effect=lambda key: chunks[key]),
            patch.object(ocr_engine.tempfile, "gettempdir", return_value=self.temp.name),
        ):
            with self.assertRaises(ValueError):
                ocr_engine._v2_artifact_from_storage(active)
            self.assertEqual(
                list(Path(self.temp.name).glob(f"viread-vietocr-v2-{expected}-*.assembling")),
                [],
                "Invalid shards must not retain partial checkpoint files",
            )
            chunks["private/chunk-b"] = b"part B"
            path, config, config_sha = ocr_engine._v2_artifact_from_storage(active)
            self.assertIsNone(config)
            self.assertIsNone(config_sha)
            self.assertEqual(ocr_engine._sha256_path(path), expected)


if __name__ == "__main__":
    unittest.main()
