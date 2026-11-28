"""Unit tests for scripts/windows/voice_worker.py STT helpers."""

from __future__ import annotations

import math
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np

from test_voice_internet_resilience import _load_voice_worker_module


class VoiceWorkerHelpersTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vw = _load_voice_worker_module()

    def test_ensure_bpe_vocab_exports_from_bpe_model_when_sentencepiece_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            model_dir = Path(tmp)
            # Without bpe.model -> returns None
            self.assertIsNone(self.vw._ensure_bpe_vocab(model_dir))

            (model_dir / "bpe.model").write_bytes(b"fake-sp-model")

            class _FakeSP:
                def load(self, path: str) -> None:
                    self.loaded = path

                def get_piece_size(self) -> int:
                    return 3

                def id_to_piece(self, idx: int) -> str:
                    return ["<unk>", "▁có", "▁cò"][idx]

                def get_score(self, idx: int) -> float:
                    return [0.0, -1.5, -2.0][idx]

            fake_spm = types.ModuleType("sentencepiece")
            fake_spm.SentencePieceProcessor = _FakeSP  # type: ignore[attr-defined]
            with patch.dict(sys.modules, {"sentencepiece": fake_spm}):
                vocab_path = self.vw._ensure_bpe_vocab(model_dir)

            self.assertIsNotNone(vocab_path)
            assert vocab_path is not None
            self.assertTrue(vocab_path.is_file())
            content = vocab_path.read_text(encoding="utf-8")
            self.assertIn("▁có\t-1.5\n", content)
            self.assertIn("▁cò\t-2.0\n", content)
            # Reuses existing bpe.vocab even without sentencepiece
            with patch.dict(sys.modules, {"sentencepiece": None}):
                reused = self.vw._ensure_bpe_vocab(model_dir)
            self.assertEqual(reused, vocab_path)

    def test_load_models_sync_configures_bpe_hotwords_when_vocab_exists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            model_dir = Path(tmp)
            (model_dir / "encoder.int8.onnx").write_bytes(b"enc")
            (model_dir / "decoder.onnx").write_bytes(b"dec")
            (model_dir / "joiner.int8.onnx").write_bytes(b"joi")
            (model_dir / "tokens.txt").write_text("a 0\n", encoding="utf-8")
            (model_dir / "bpe.vocab").write_text("▁có\t-1.0\n", encoding="utf-8")

            engine = self.vw.VoiceRuntimeEngine()
            engine.tts_engine = MagicMock()
            engine.tts_engine_fp32 = MagicMock()
            engine.tts_engine_int8 = MagicMock()
            captured_kwargs: dict = {}

            def _fake_from_transducer(**kwargs):
                captured_kwargs.update(kwargs)
                return MagicMock()

            fake_sherpa = SimpleNamespace(
                OfflineRecognizer=SimpleNamespace(from_transducer=_fake_from_transducer)
            )
            with (
                patch.object(self.vw, "SHERPA_MODEL_DIR", model_dir),
                patch.object(self.vw, "sherpa_onnx", fake_sherpa),
                patch.object(self.vw, "TTS_PRECISION", "none"),
            ):
                engine.load_models_sync()

            self.assertTrue(engine.stt_bpe_vocab_active)
            self.assertEqual(captured_kwargs["modeling_unit"], "bpe")
            self.assertEqual(captured_kwargs["bpe_vocab"], str(model_dir / "bpe.vocab"))
            self.assertEqual(captured_kwargs["hotwords_score"], 1.2)
            self.assertEqual(captured_kwargs["blank_penalty"], 0.0)

    def test_decode_stt_window_passes_hotwords_with_safe_fallback_and_extracts_logprobs(self) -> None:
        sr = 16000
        t = np.linspace(0, 0.35, int(sr * 0.35), dtype=np.float32)
        clip = (0.12 * np.sin(2 * np.pi * 260 * t)).astype(np.float32)

        class _FakeStream:
            def __init__(self) -> None:
                self.result = SimpleNamespace(
                    text="có",
                    tokens=["▁c", "ó"],
                    timestamps=[0.1, 0.2],
                    ys_log_probs=[-0.12, -0.18],
                )

            def accept_waveform(self, _sr: int, _samples: np.ndarray) -> None:
                pass

        seen_hotwords: list[str | None] = []

        class _HotwordRec:
            def create_stream(self, **kwargs):
                seen_hotwords.append(kwargs.get("hotwords"))
                return _FakeStream()

            def decode_stream(self, _stream) -> None:
                pass

        with (
            patch.object(self.vw.runtime, "stt_recognizer", _HotwordRec()),
            patch.object(self.vw.runtime, "stt_bpe_vocab_active", True),
        ):
            txt, words, _ = self.vw.decode_stt_window_sync(
                clip, keyterms='["có", "cò", "cỏ"]'
            )

        self.assertEqual(txt, "có")
        self.assertEqual(seen_hotwords[-1], "có/cò/cỏ")
        self.assertEqual(len(words), 1)
        self.assertAlmostEqual(words[0]["logprob"], -0.30, places=3)

        # Safe fallback to create_stream() when recognizer does not support hotwords kwarg
        fallback_calls = 0

        class _NoHotwordRec:
            def create_stream(self):
                nonlocal fallback_calls
                fallback_calls += 1
                return _FakeStream()

            def decode_stream(self, _stream) -> None:
                pass

        with (
            patch.object(self.vw.runtime, "stt_recognizer", _NoHotwordRec()),
            patch.object(self.vw.runtime, "stt_bpe_vocab_active", True),
        ):
            txt2, words2, _ = self.vw.decode_stt_window_sync(clip, keyterms=["có"])

        self.assertEqual(txt2, "có")
        self.assertEqual(fallback_calls, 1)
        self.assertIsNotNone(words2[0]["logprob"])

    def test_preprocess_audio_for_stt_trims_dead_air_uses_p90_tanh_and_avoids_double_amp(self) -> None:
        sr = 16000
        # 1) Dead air > 350ms (0.80s lead + 0.30s soft speech + 0.80s trail) + 1 tap spike
        lead = np.zeros(int(sr * 0.80), dtype=np.float32)
        t = np.linspace(0, 0.30, int(sr * 0.30), dtype=np.float32)
        soft_speech = (0.012 * np.sin(2 * np.pi * 260 * t)).astype(np.float32)
        trail = np.zeros(int(sr * 0.80), dtype=np.float32)
        clip = np.concatenate([lead, soft_speech, trail])
        # Single tap at sample 100 inside lead region? Put tap at start of speech so it's in voiced frames
        clip[int(sr * 0.80) + 10] = 0.99

        processed = self.vw.preprocess_audio_for_stt(clip)
        # Trimmed from 1.90s down to ~0.18s + 0.30s + 0.22s = ~0.70s
        self.assertLess(processed.size / sr, 0.85)
        self.assertGreater(processed.size / sr, 0.55)
        # Soft-limited by np.tanh below 0.96
        self.assertLessEqual(float(np.max(np.abs(processed))), 0.96)
        # Quiet speech still amplified despite 0.99 tap (not locked at gain=1.0)
        voiced_mid = processed[int(sr * 0.22) : int(sr * 0.42)]
        mid_rms = float(np.sqrt(np.mean(voiced_mid * voiced_mid)))
        self.assertGreater(mid_rms, 0.04)

        # 2) Clip already >= 0.065 RMS is NOT double-amplified
        t_loud = np.linspace(0, 0.30, int(sr * 0.30), dtype=np.float32)
        loud_clip = (0.14 * np.sin(2 * np.pi * 260 * t_loud)).astype(np.float32)
        loud_rms_before = float(np.sqrt(np.mean(loud_clip * loud_clip)))
        loud_after = self.vw.preprocess_audio_for_stt(loud_clip)
        loud_rms_after = float(np.sqrt(np.mean(loud_after * loud_after)))
        self.assertAlmostEqual(loud_rms_after, loud_rms_before, delta=0.015)

    def test_build_stt_words_handles_missing_ys_log_probs(self) -> None:
        words = self.vw.build_stt_words_from_sherpa(
            ["▁m", "ột"],
            [0.1, 0.2],
            0.5,
            ys_log_probs=None,
        )
        self.assertEqual(len(words), 1)
        self.assertEqual(words[0]["text"], "một")
        self.assertIsNone(words[0]["logprob"])


if __name__ == "__main__":
    unittest.main()
