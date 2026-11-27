"""Unit tests for VietOCR V2 LMDB data_root resolution and Turing CUDA AMP->FP32 fallback."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = Path(__file__).resolve().parent
for candidate_dir in (str(REPO_ROOT), str(BACKEND_DIR)):
    if candidate_dir not in sys.path:
        sys.path.insert(0, candidate_dir)

from ai.vietocr_v2 import train as train_mod  # noqa: E402
from ai.vietocr_v2.contracts import DatasetRow, write_jsonl  # noqa: E402


class VietocrV2TrainCompatibilityAndAmpFallbackTests(unittest.TestCase):
    def test_data_gen_resolves_relative_lmdb_path_inside_data_root_not_cwd(self):
        captured_calls: list[dict[str, object]] = []

        class FakeOCRDataset:
            def __init__(self, **kwargs):
                captured_calls.append(dict(kwargs))
                self.cluster_indices = {64: [0, 1]}
                self.nSamples = 0
                self.txn = SimpleNamespace(
                    cursor=lambda: SimpleNamespace(
                        set_range=lambda _prefix: False,
                        close=lambda: None,
                    )
                )

            def get_bucket(self, idx):
                return 64

        class FakeCollator:
            def __init__(self, masked_language_model=True):
                self.masked_language_model = masked_language_model

        class FakeDataLoader:
            def __init__(self, dataset, batch_sampler=None, collate_fn=None, **kwargs):
                self.dataset = dataset
                self.batch_sampler = batch_sampler
                self.collate_fn = collate_fn
                self.kwargs = kwargs

        class FakeTrainer:
            def data_gen(self, *args, **kwargs):
                raise AssertionError("original data_gen should be replaced")

        fake_vietocr = ModuleType("vietocr")
        fake_tool = ModuleType("vietocr.tool")
        fake_create_dataset = ModuleType("vietocr.tool.create_dataset")
        fake_create_dataset.checkImageIsValid = lambda _b: (True, 32, 64)
        fake_tool.create_dataset = fake_create_dataset

        fake_loader = ModuleType("vietocr.loader")
        fake_dataloader = ModuleType("vietocr.loader.dataloader")
        fake_dataloader.OCRDataset = FakeOCRDataset
        fake_dataloader.Collator = FakeCollator
        fake_dataloader.resize = lambda w, h, *_a: (w, h)
        fake_loader.dataloader = fake_dataloader

        fake_model = ModuleType("vietocr.model")
        fake_trainer_mod = ModuleType("vietocr.model.trainer")
        fake_trainer_mod.Trainer = FakeTrainer
        fake_trainer_mod.DataLoader = FakeDataLoader
        fake_model.trainer = fake_trainer_mod

        fake_vietocr.tool = fake_tool
        fake_vietocr.loader = fake_loader
        fake_vietocr.model = fake_model

        fake_np = SimpleNamespace(uint8="uint8", int32="int32", frombuffer=lambda b, dtype=None: b)
        fake_cv2 = SimpleNamespace(IMREAD_GRAYSCALE=0, imdecode=lambda *_a: None)

        self.assertIs(
            train_mod._install_vietocr_compatibility,
            train_mod._install_vietocr_numpy_bytes_compatibility,
        )

        with tempfile.TemporaryDirectory() as tmp:
            cwd_dir = Path(tmp) / "isolated_cwd"
            data_root_dir = Path(tmp) / "run_dir" / "dataset"
            cwd_dir.mkdir(parents=True, exist_ok=True)
            data_root_dir.mkdir(parents=True, exist_ok=True)

            with patch.dict(
                sys.modules,
                {
                    "vietocr": fake_vietocr,
                    "vietocr.tool": fake_tool,
                    "vietocr.tool.create_dataset": fake_create_dataset,
                    "vietocr.loader": fake_loader,
                    "vietocr.loader.dataloader": fake_dataloader,
                    "vietocr.model": fake_model,
                    "vietocr.model.trainer": fake_trainer_mod,
                },
            ):
                train_mod._install_vietocr_numpy_bytes_compatibility(fake_np, fake_cv2)
                trainer_instance = SimpleNamespace(
                    vocab=object(),
                    batch_size=4,
                    config={
                        "dataset": {
                            "image_height": 32,
                            "image_min_width": 32,
                            "image_max_width": 512,
                        },
                        "dataloader": {"num_workers": 0, "pin_memory": False},
                    },
                )
                previous_cwd = Path.cwd()
                try:
                    os.chdir(cwd_dir)
                    FakeTrainer.data_gen(
                        trainer_instance,
                        "train_viread_v2_flow2_abc123",
                        str(data_root_dir),
                        str(data_root_dir / "train.tsv"),
                    )
                    FakeTrainer.data_gen(
                        trainer_instance,
                        "valid_viread_v2_flow2_abc123",
                        str(data_root_dir),
                        str(data_root_dir / "validation.tsv"),
                    )
                    explicit_abs_lmdb = str((Path(tmp) / "custom_abs.lmdb").resolve())
                    FakeTrainer.data_gen(
                        trainer_instance,
                        explicit_abs_lmdb,
                        str(data_root_dir),
                        str(data_root_dir / "train.tsv"),
                    )
                finally:
                    os.chdir(previous_cwd)

            self.assertEqual(len(captured_calls), 3)
            self.assertEqual(
                captured_calls[0]["lmdb_path"],
                str(data_root_dir / "train_viread_v2_flow2_abc123"),
            )
            self.assertEqual(
                captured_calls[1]["lmdb_path"],
                str(data_root_dir / "valid_viread_v2_flow2_abc123"),
            )
            self.assertEqual(captured_calls[2]["lmdb_path"], explicit_abs_lmdb)
            self.assertEqual(list(cwd_dir.iterdir()), [])

    def test_vietocr_sdpa_math_context_toggles_math_backend_cleanly(self):
        events: list[tuple[str, object]] = []

        @contextmanager
        def fake_sdpa_kernel(backend):
            events.append(("enter", backend))
            try:
                yield
            finally:
                events.append(("exit", backend))

        class FakeSDPBackend:
            MATH = "SDP_MATH_SENTINEL"

        fake_torch = SimpleNamespace(
            nn=SimpleNamespace(
                attention=SimpleNamespace(
                    SDPBackend=FakeSDPBackend,
                    sdpa_kernel=fake_sdpa_kernel,
                )
            )
        )

        with train_mod._vietocr_sdpa_math_context(fake_torch, enabled=True):
            events.append(("inside_enabled", None))
        self.assertEqual(
            events,
            [
                ("enter", "SDP_MATH_SENTINEL"),
                ("inside_enabled", None),
                ("exit", "SDP_MATH_SENTINEL"),
            ],
        )

        events.clear()
        with train_mod._vietocr_sdpa_math_context(fake_torch, enabled=False):
            events.append(("inside_disabled", None))
        self.assertEqual(events, [("inside_disabled", None)])

        # Safe no-op when torch.nn.attention is absent
        with train_mod._vietocr_sdpa_math_context(SimpleNamespace(), enabled=True):
            events.append(("inside_missing_attention", None))
        self.assertEqual(events[-1], ("inside_missing_attention", None))

    def test_run_training_falls_back_from_cuda_amp_accelerator_error_to_fp32(self):
        import torch
        import torch.nn as nn

        from app.services.viread_flow2_hygiene import LOCKED_VIETOCR_VOCAB

        lock = json.loads(
            (Path(train_mod.__file__).parent / "original_artifact.json").read_text(encoding="utf-8")
        )
        arch = lock["architecture"]
        base_cfg = {
            "backbone": arch["backbone"],
            "cnn": dict(arch["cnn"]),
            "seq_modeling": arch["seq_modeling"],
            "transformer": dict(arch["transformer"]),
            "vocab": LOCKED_VIETOCR_VOCAB,
            "dataset": dict(arch["input"]),
            "trainer": {},
            "aug": {},
            "optimizer": {},
            "dataloader": {},
        }

        class FakeAcceleratorError(RuntimeError):
            pass

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            img_train = tmp_path / "train.png"
            img_val = tmp_path / "val.png"
            img_train.write_bytes(b"fake-train-png-bytes")
            img_val.write_bytes(b"fake-val-png-bytes")
            sha_train = hashlib.sha256(img_train.read_bytes()).hexdigest()
            sha_val = hashlib.sha256(img_val.read_bytes()).hexdigest()

            rows = [
                DatasetRow(
                    str(img_train),
                    "xin",
                    "group-train",
                    "FLOW1_VERIFIED",
                    "train",
                    image_sha256=sha_train,
                    verified=True,
                ),
                DatasetRow(
                    str(img_val),
                    "chào",
                    "group-val",
                    "FLOW1_VERIFIED",
                    "validation",
                    image_sha256=sha_val,
                    verified=True,
                ),
            ]
            manifest_path = tmp_path / "manifest.jsonl"
            write_jsonl(manifest_path, rows)

            receipt_path = tmp_path / "receipt.json"
            receipt_path.write_text(
                json.dumps(
                    {
                        "schema": "viread-dataset-v1",
                        "source_flow": "FLOW1_VERIFIED",
                        "samples": [
                            {
                                "source_flow": r.source_flow,
                                "group_id": r.group_id,
                                "split": r.split,
                                "image_sha256": r.image_sha256,
                                "label": r.label,
                            }
                            for r in rows
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            receipt_sha = hashlib.sha256(receipt_path.read_bytes()).hexdigest()

            def fake_write_annotations(_rows, _manifest_dir, root: Path, *, vocabulary: str):
                self.assertEqual(vocabulary, LOCKED_VIETOCR_VOCAB)
                root.mkdir(parents=True, exist_ok=True)
                t_path = root / "train.tsv"
                v_path = root / "validation.tsv"
                t_path.write_text("train.png\txin\n", encoding="utf-8")
                v_path.write_text("val.png\tchào\n", encoding="utf-8")
                return t_path, v_path

            amp_state = {"autocast_active": False, "sdpa_math_active": False}
            autocast_calls: list[tuple[str, bool]] = []
            sdpa_calls: list[object] = []
            scaler_inits: list[tuple[str, bool]] = []
            forward_attempts: list[tuple[bool, bool]] = []

            @contextmanager
            def fake_autocast(*, device_type: str, dtype=None, enabled: bool = True):
                autocast_calls.append((device_type, bool(enabled)))
                prev = amp_state["autocast_active"]
                amp_state["autocast_active"] = bool(enabled)
                try:
                    yield
                finally:
                    amp_state["autocast_active"] = prev

            @contextmanager
            def fake_sdpa_kernel(backend):
                sdpa_calls.append(backend)
                prev = amp_state["sdpa_math_active"]
                amp_state["sdpa_math_active"] = True
                try:
                    yield
                finally:
                    amp_state["sdpa_math_active"] = prev

            class FakeGradScaler:
                def __init__(self, device: str = "cuda", enabled: bool = True):
                    self.device = device
                    self.enabled = enabled
                    scaler_inits.append((device, bool(enabled)))

                def scale(self, loss):
                    return loss

                def unscale_(self, _optimizer):
                    return None

                def step(self, optimizer):
                    optimizer.step()

                def update(self):
                    return None

                def state_dict(self):
                    return {"enabled": self.enabled}

                def load_state_dict(self, _state):
                    return None

            class TinyTuringModel(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.cnn = nn.Linear(4, 4)
                    self.decoder = nn.Linear(4, 4)

                def forward(self, img, _tgt_input, tgt_key_padding_mask=None):
                    forward_attempts.append(
                        (amp_state["autocast_active"], amp_state["sdpa_math_active"])
                    )
                    if amp_state["autocast_active"]:
                        # Leave dirty grad to prove zero_grad(set_to_none=True) cleans up before retry
                        self.decoder.weight.grad = torch.ones_like(self.decoder.weight)
                        raise FakeAcceleratorError(
                            "CUDA error: invalid argument in Turing sm_75 SDPA"
                        )
                    assert self.decoder.weight.grad is None, "zero_grad(set_to_none=True) must clear grad before FP32 retry"
                    return self.decoder(self.cnn(img)).unsqueeze(1)

            parent_model = TinyTuringModel()
            parent_path = tmp_path / "parent.pth"
            torch.save(parent_model.state_dict(), parent_path)

            val_losses = [0.45, 0.22, 0.18]
            validate_sdpa_flags: list[bool] = []

            class FakeTrainer:
                def __init__(self, cfg, pretrained=False):
                    self.config = cfg
                    self.iter = 0
                    self.model = TinyTuringModel()
                    self.train_gen = [
                        {
                            "img": torch.ones(2, 4),
                            "tgt_input": torch.zeros(2, 4),
                            "tgt_padding_mask": torch.zeros(2, 1, dtype=torch.bool),
                            "tgt_output": torch.zeros(2, 4),
                        }
                    ]
                    self.optimizer = None
                    self.scheduler = None

                def batch_to_device(self, batch):
                    return batch

                def criterion(self, out, _tgt):
                    return (out - 1.0).pow(2).sum()

                def validate(self):
                    validate_sdpa_flags.append(amp_state["sdpa_math_active"])
                    return val_losses.pop(0)

            fake_trainer_mod = ModuleType("vietocr.model.trainer")
            fake_trainer_mod.Trainer = FakeTrainer
            fake_cfg_mod = ModuleType("vietocr.tool.config")
            fake_cfg_mod.Cfg = SimpleNamespace(load_config_from_name=lambda _name: base_cfg)
            fake_vietocr = ModuleType("vietocr")
            fake_vietocr.model = ModuleType("vietocr.model")
            fake_vietocr.model.trainer = fake_trainer_mod
            fake_vietocr.tool = ModuleType("vietocr.tool")
            fake_vietocr.tool.config = fake_cfg_mod

            orig_torch_load = torch.load

            def cpu_safe_torch_load(*args, **kwargs):
                if kwargs.get("map_location") == "cuda":
                    kwargs["map_location"] = "cpu"
                return orig_torch_load(*args, **kwargs)

            sync_mock = MagicMock()
            empty_cache_mock = MagicMock()
            try:
                import torch._dynamo  # noqa: F401
            except Exception:
                pass
            try:
                import torch.nn.attention as torch_attention

                expected_math_backend = torch_attention.SDPBackend.MATH
                attention_patch = patch.object(
                    torch_attention, "sdpa_kernel", new=fake_sdpa_kernel
                )
            except ImportError:
                class FakeSDPBackend:
                    MATH = "SDP_MATH_BACKEND"

                expected_math_backend = FakeSDPBackend.MATH
                fake_attention_mod = ModuleType("torch.nn.attention")
                fake_attention_mod.SDPBackend = FakeSDPBackend
                fake_attention_mod.sdpa_kernel = fake_sdpa_kernel
                attention_patch = patch.object(
                    torch.nn, "attention", fake_attention_mod, create=True
                )

            with (
                patch.object(train_mod, "prepare_vietocr_training_runtime", return_value={}),
                patch.object(train_mod, "_write_annotations", side_effect=fake_write_annotations),
                patch.dict(train_mod.PROFILES["FLOW2_ADMIN_VERIFIED"], {"valid_every": 1}),
                patch.dict(
                    sys.modules,
                    {
                        "vietocr": fake_vietocr,
                        "vietocr.model": fake_vietocr.model,
                        "vietocr.model.trainer": fake_trainer_mod,
                        "vietocr.tool": fake_vietocr.tool,
                        "vietocr.tool.config": fake_cfg_mod,
                    },
                ),
                patch.object(torch, "AcceleratorError", FakeAcceleratorError, create=True),
                patch.object(torch, "autocast", side_effect=fake_autocast),
                patch.object(torch, "load", side_effect=cpu_safe_torch_load),
                patch.object(torch.amp, "GradScaler", FakeGradScaler),
                attention_patch,
                patch.object(torch.cuda, "is_available", return_value=True),
                patch.object(torch.cuda, "manual_seed_all", MagicMock()),
                patch.object(
                    torch.cuda,
                    "get_rng_state_all",
                    return_value=[torch.tensor([1, 2, 3], dtype=torch.uint8)],
                ),
                patch.object(torch.cuda, "set_rng_state_all", MagicMock()),
                patch.object(torch.cuda, "synchronize", sync_mock),
                patch.object(torch.cuda, "empty_cache", empty_cache_mock),
                self.assertLogs("viread.vietocr.train", level="WARNING") as captured_logs,
            ):
                result = train_mod.run_training(
                    profile="FLOW2_ADMIN_VERIFIED",
                    manifest_path=str(manifest_path),
                    output_dir=str(tmp_path / "run_amp_fallback"),
                    parent_checkpoint=str(parent_path),
                    total_steps=2,
                    dataset_receipt_path=str(receipt_path),
                    dataset_version_sha256=receipt_sha,
                    batch_size=2,
                    freeze_epochs=1,
                    use_fp16=True,
                )

            self.assertEqual(result["device"], "cuda")
            self.assertFalse(result["fp16"])
            self.assertEqual(result["steps"], 2)
            self.assertEqual(result["best_step"], 2)
            self.assertAlmostEqual(result["best_validation_loss"], 0.18)

            # Attempt 1 ran with autocast=True and sdpa_math=True, then retried in FP32 (autocast=False)
            self.assertEqual(
                forward_attempts,
                [
                    (True, True),   # step 1 initial AMP attempt -> AcceleratorError
                    (False, False), # step 1 FP32 retry -> succeeds
                    (False, False), # step 2 FP32 -> succeeds
                ],
            )
            self.assertEqual(autocast_calls, [("cuda", True), ("cuda", False), ("cuda", False)])
            self.assertEqual(scaler_inits, [("cuda", True), ("cuda", False)])
            self.assertEqual(sync_mock.call_count, 1)
            self.assertEqual(empty_cache_mock.call_count, 1)
            self.assertTrue(all(validate_sdpa_flags))
            self.assertIn(expected_math_backend, sdpa_calls)
            self.assertTrue(
                any("disabling AMP and retrying current batch in FP32" in msg for msg in captured_logs.output)
            )


if __name__ == "__main__":
    unittest.main()
