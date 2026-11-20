"""Async bridge to the fixed local engine; never imports torch into the API."""
import asyncio
import json
import os
from pathlib import Path
import signal

from app.providers.karaoke_alignment_provider import AlignmentEvidence
from app.providers.karaoke_stem_provider import StemArtifacts

ALIGNMENT_MODEL = "2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed"
ALIGNMENT_BOUNDARIES = "ctc-delimiter-envelope-v3"
ALIGNMENT_ENGINE = f"{ALIGNMENT_MODEL}:{ALIGNMENT_BOUNDARIES}"
STEM_MODEL = "demucs-4.0.1:955717e8:active-anchors-v2"
SAFE_ERRORS = {
    "NO_USABLE_VOCALS", "REFERENCE_TIMELINE_MISMATCH", "LYRICS_NOT_MATCHED",
    "INVALID_PROVIDER_RESULT", "MEDIA_UNAVAILABLE", "PROCESSING_CONFIGURATION_INVALID",
}


def _unique_pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


class KaraokeEngineError(RuntimeError):
    def __init__(self, code):
        self.code = code if code in SAFE_ERRORS | {"PROVIDER_TIMEOUT"} else "INVALID_PROVIDER_RESULT"
        super().__init__(self.code)


class KaraokeLeaseLost(RuntimeError):
    pass


async def _read_bounded(stream, maximum):
    blocks, size = [], 0
    while block := await stream.read(65536):
        size += len(block)
        if size > maximum:
            raise KaraokeEngineError("INVALID_PROVIDER_RESULT")
        blocks.append(block)
    return b"".join(blocks)


async def _terminate(process):
    if process.returncode is not None:
        return
    if os.name == "nt":
        # This PID belongs to the engine we just spawned, not a system scan.
        killer = await asyncio.create_subprocess_exec(
            str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"),
            "/PID", str(process.pid), "/T", "/F",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            creationflags=0x08000000,
        )
        try:
            await asyncio.wait_for(killer.wait(), timeout=5)
        except TimeoutError:
            killer.kill()
            await killer.wait()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except TimeoutError:
        process.kill()
        await process.wait()


def _artifact(workspace, value):
    path = Path(value).resolve(strict=True)
    root = workspace.resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file() or not 1 <= path.stat().st_size <= 20971520:
        raise KaraokeEngineError("INVALID_PROVIDER_RESULT")
    return path


class LocalKaraokeClient:
    def __init__(self, config):
        self.config = config

    async def _call(self, step, audio, workspace, cancel, **values):
        if cancel.is_set():
            raise KaraokeLeaseLost()
        root = workspace.resolve(strict=True)
        audio = _artifact(root, str(audio))
        request = json.dumps(dict(
            step=step, workspace=str(root), audio=str(audio),
            model_path=self.config.model_path, stem_model_path=self.config.stem_model_path, **values,
        ), ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(request) > 2 * 1024 * 1024:
            raise KaraokeEngineError("INVALID_PROVIDER_RESULT")
        # Do not pass backend API keys/DB credentials to the offline model process.
        env = {key: value for key, value in os.environ.items()
               if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "LANG", "LC_ALL",
                                  "USERPROFILE", "HOMEDRIVE", "HOMEPATH"}}
        env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                   HF_HUB_DISABLE_TELEMETRY="1", PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        process = await asyncio.create_subprocess_exec(
            self.config.python_path, "-B", self.config.engine_script, "--json",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, cwd=str(root), env=env,
            **({"creationflags": 0x08000000} if os.name == "nt" else {"start_new_session": True}),
        )
        async def collect():
            process.stdin.write(request)
            await process.stdin.drain()
            process.stdin.close()
            output, _ = await asyncio.gather(_read_bounded(process.stdout, 2 * 1024 * 1024),
                                            _read_bounded(process.stderr, 65536))
            await process.wait()
            return output
        collector = asyncio.create_task(collect())
        cancelled = asyncio.create_task(cancel.wait())
        try:
            done, _ = await asyncio.wait({collector, cancelled},
                timeout=self.config.provider_timeout_seconds, return_when=asyncio.FIRST_COMPLETED)
            if cancelled in done:
                raise KaraokeLeaseLost()
            if collector not in done:
                raise KaraokeEngineError("PROVIDER_TIMEOUT")
            output = collector.result()
            result = json.loads(output, object_pairs_hook=_unique_pairs,
                                parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
            if not isinstance(result, dict) or type(result.get("ok")) is not bool:
                raise KaraokeEngineError("INVALID_PROVIDER_RESULT")
            if not result["ok"]:
                raise KaraokeEngineError(result.get("error"))
            if process.returncode != 0 or set(result) != {"ok", "result"}:
                raise KaraokeEngineError("INVALID_PROVIDER_RESULT")
            return result["result"]
        except (ValueError, TypeError, KeyError):
            raise KaraokeEngineError("INVALID_PROVIDER_RESULT") from None
        finally:
            await _terminate(process)
            for task in (collector, cancelled):
                if not task.done():
                    task.cancel()
            await asyncio.gather(collector, cancelled, return_exceptions=True)

    async def separate(self, audio, workspace, cancel):
        result = await self._call("separate", audio, workspace, cancel)
        try:
            if set(result) != {"vocal", "instrumental", "model_version", "timeline_offset_ms", "duration_ms", "diagnostics"}:
                raise ValueError()
            if (result["model_version"] != STEM_MODEL or type(result["timeline_offset_ms"]) is not int
                    or abs(result["timeline_offset_ms"]) > 40 or type(result["duration_ms"]) is not int
                    or not 1 <= result["duration_ms"] <= 300000):
                raise ValueError()
            return StemArtifacts(
                vocal=_artifact(workspace, result["vocal"]), instrumental=_artifact(workspace, result["instrumental"]),
                model_version=STEM_MODEL, timeline_offset_ms=result["timeline_offset_ms"],
                duration_ms=result["duration_ms"], diagnostics=result["diagnostics"],
            )
        except (ValueError, TypeError, KeyError, OSError):
            raise KaraokeEngineError("INVALID_PROVIDER_RESULT") from None

    async def align(self, audio, texts, workspace, cancel):
        result = await self._call("align", audio, workspace, cancel, texts=texts)
        try:
            evidence = AlignmentEvidence.model_validate(result)
            if evidence.model_revision != ALIGNMENT_MODEL or evidence.boundary_version != ALIGNMENT_BOUNDARIES:
                raise ValueError()
            return evidence
        except ValueError:
            raise KaraokeEngineError("INVALID_PROVIDER_RESULT") from None

    async def verify_reference(self, audio, reference, workspace, cancel):
        result = await self._call("verify_reference", audio, workspace, cancel,
                                  reference=str(_artifact(workspace, str(reference))))
        if (not isinstance(result, dict) or result.get("verified") is not True
                or type(result.get("max_absolute_offset_ms")) is not int
                or not 0 <= result["max_absolute_offset_ms"] <= 40):
            raise KaraokeEngineError("REFERENCE_TIMELINE_MISMATCH")
        return result
