"""Real subprocess cancellation/bounds checks with a test-only engine fixture."""
import asyncio
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

from app.providers.karaoke_local_aligner_client import STEM_MODEL, KaraokeEngineError, KaraokeLeaseLost, LocalKaraokeClient


class LocalClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="karaoke-client-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.audio = self.workspace / "fixture.mp3"
        self.audio.write_bytes(b"fixture - not a playable song")
        self.config = SimpleNamespace(
            python_path=sys.executable,
            engine_script=str(Path(__file__).parent / "fixtures/karaoke_engine_fixture.py"),
            model_path="unused-by-test-fixture", stem_model_path="unused-by-test-fixture",
            provider_timeout_seconds=5,
        )
        self.client = LocalKaraokeClient(self.config)

    async def test_success_parses_strict_evidence(self):
        result = await self.client.align(self.audio, ["Bé"], self.workspace, asyncio.Event())
        self.assertEqual(result.units[0].text, "Bé")
        self.assertEqual(result.duration_ms, 1000)

    async def test_old_or_unknown_boundary_engine_is_rejected(self):
        for mode in ("__OLD_BOUNDARY__", "__UNKNOWN_BOUNDARY__", "__PREVIOUS_BOUNDARY__"):
            with self.subTest(mode=mode), self.assertRaises(KaraokeEngineError) as error:
                await self.client.align(self.audio, [mode], self.workspace, asyncio.Event())
            self.assertEqual(error.exception.code, "INVALID_PROVIDER_RESULT")

    async def test_error_is_safe_and_specific(self):
        with self.assertRaises(KaraokeEngineError) as error:
            await self.client.align(self.audio, ["__ERROR__"], self.workspace, asyncio.Event())
        self.assertEqual(error.exception.code, "NO_USABLE_VOCALS")
        self.assertNotIn(str(self.workspace), str(error.exception))

    def stem_result(self, version):
        backing = self.workspace / "fixture-backing.mp3"
        backing.write_bytes(b"fixture backing - not a playable song")
        return dict(vocal=str(self.audio), instrumental=str(backing), model_version=version,
                    timeline_offset_ms=0, duration_ms=1000, diagnostics={"fixture": True})

    async def test_current_stem_clock_recipe_is_accepted(self):
        with patch.object(self.client, "_call", return_value=self.stem_result(STEM_MODEL)):
            result = await self.client.separate(self.audio, self.workspace, asyncio.Event())
        self.assertEqual(result.model_version, STEM_MODEL)
        self.assertTrue(STEM_MODEL.endswith(":active-anchors-v2"))

    async def test_old_or_unknown_stem_clock_recipe_is_rejected(self):
        for version in ("demucs-4.0.1:955717e8", "unknown"):
            with self.subTest(version=version), patch.object(self.client, "_call", return_value=self.stem_result(version)):
                with self.assertRaises(KaraokeEngineError) as error:
                    await self.client.separate(self.audio, self.workspace, asyncio.Event())
                self.assertEqual(error.exception.code, "INVALID_PROVIDER_RESULT")

    async def test_pipeline_fences_stem_cache_by_clock_recipe(self):
        from app.services.karaoke_processing_pipeline import KaraokeProcessingPipeline
        from app.services.karaoke_processing_review import fingerprint
        captured = {}
        class StopAtStep(RuntimeError):
            pass
        class ProbeContext:
            async def guard(inner, stage):
                pass
            async def download(inner, asset, name):
                return self.audio
            async def step(inner, stage, step_key, digest, provider, model, execute, reuse):
                captured.update(step_key=step_key, digest=digest, model=model)
                raise StopAtStep()
        job = SimpleNamespace(mode="VOCAL_TRACK", input_audio_path="fixture/source.mp3",
                              input_audio_sha256="a" * 64, input_audio_size_bytes=10, input_duration_ms=1000)
        with self.assertRaises(StopAtStep):
            await KaraokeProcessingPipeline(self.client).process(job, ProbeContext())
        self.assertEqual(captured["step_key"], "SEPARATE_STEMS")
        self.assertEqual(captured["model"], STEM_MODEL)
        self.assertNotEqual(captured["digest"], fingerprint(dict(
            input_sha256=job.input_audio_sha256, model="demucs-4.0.1:955717e8")))

    async def test_duplicate_json_and_oversized_output_rejected(self):
        for mode in ("__DUPLICATE__", "__OVERSIZE__"):
            with self.subTest(mode=mode), self.assertRaises(KaraokeEngineError) as error:
                await self.client.align(self.audio, [mode], self.workspace, asyncio.Event())
            self.assertEqual(error.exception.code, "INVALID_PROVIDER_RESULT")

    async def test_pipeline_fences_alignment_cache_by_mapping_version(self):
        from app.services.karaoke_processing_pipeline import KaraokeProcessingPipeline, MediaAsset
        from app.services.karaoke_processing_review import fingerprint
        from app.providers.karaoke_local_aligner_client import ALIGNMENT_ENGINE
        from app.services.karaoke_alignment import MAPPING_VERSION
        captured = {}
        class StopAtStep(RuntimeError):
            pass
        class ProbeContext:
            async def guard(inner, stage):
                pass
            async def download(inner, asset, name):
                return self.audio
            async def step(inner, stage, step_key, digest, provider, model, execute, reuse):
                if step_key == "SEPARATE_STEMS":
                    return SimpleNamespace(payload=dict(
                        vocal_asset=MediaAsset("fixture/vocal.mp3", "b" * 64, 10, 1000),
                        instrumental_asset=MediaAsset("fixture/backing.mp3", "c" * 64, 10, 1000),
                        offset_ms=0))
                captured.update(step_key=step_key, digest=digest)
                raise StopAtStep()
        job = SimpleNamespace(mode="VOCAL_TRACK", input_audio_path="fixture/source.mp3",
                              input_audio_sha256="a" * 64, input_audio_size_bytes=10,
                              input_duration_ms=1000, lyrics_snapshot_sha256="d" * 64)
        with self.assertRaises(StopAtStep):
            await KaraokeProcessingPipeline(self.client).process(job, ProbeContext())
        identity = dict(vocal="b" * 64, final_audio="c" * 64, lyrics="d" * 64,
                        offset_ms=0, model=ALIGNMENT_ENGINE)
        self.assertEqual(captured["step_key"], "ALIGN_PROVIDED_LYRICS")
        self.assertNotEqual(captured["digest"], fingerprint(identity))
        self.assertEqual(captured["digest"], fingerprint(dict(identity, mapping=MAPPING_VERSION)))

    async def test_timeout_reaps_owned_process(self):
        self.config.provider_timeout_seconds = 0.2
        spawned = []
        original = asyncio.create_subprocess_exec
        async def capture(*args, **kwargs):
            process = await original(*args, **kwargs)
            if args[0] == sys.executable:
                spawned.append(process)
            return process
        with patch("asyncio.create_subprocess_exec", side_effect=capture):
            with self.assertRaises(KaraokeEngineError) as error:
                await self.client.align(self.audio, ["__WAIT__"], self.workspace, asyncio.Event())
        self.assertEqual(error.exception.code, "PROVIDER_TIMEOUT")
        self.assertEqual(len(spawned), 1)
        self.assertIsNotNone(spawned[0].returncode)

    async def test_cancel_reaps_owned_process(self):
        cancel, spawned = asyncio.Event(), []
        original = asyncio.create_subprocess_exec
        async def capture(*args, **kwargs):
            process = await original(*args, **kwargs)
            if args[0] == sys.executable:
                spawned.append(process)
            return process
        async def ready():
            while not (self.workspace / "started.marker").exists():
                await asyncio.sleep(0.02)
        with patch("asyncio.create_subprocess_exec", side_effect=capture):
            task = asyncio.create_task(self.client.align(self.audio, ["__WAIT__"], self.workspace, cancel))
            try:
                await asyncio.wait_for(ready(), timeout=5)
                cancel.set()
                with self.assertRaises(KaraokeLeaseLost):
                    await asyncio.wait_for(task, timeout=10)
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        self.assertIsNotNone(spawned[0].returncode)

    async def test_cancelled_before_spawn_never_runs_engine(self):
        cancel = asyncio.Event()
        cancel.set()
        with patch("asyncio.create_subprocess_exec") as spawn:
            with self.assertRaises(KaraokeLeaseLost):
                await self.client.align(self.audio, ["Bé"], self.workspace, cancel)
            spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
