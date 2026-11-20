"""Durable step products; offline providers execute outside every DB boundary."""
from dataclasses import asdict, dataclass
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid5

from app.providers.karaoke_local_aligner_client import ALIGNMENT_MODEL, ALIGNMENT_BOUNDARIES, ALIGNMENT_ENGINE, STEM_MODEL
from app.providers.karaoke_local_aligner_client import KaraokeEngineError
from app.schemas.karaoke import Lyrics
from app.services.karaoke_alignment import FLAG_NAMESPACE, MAPPING_VERSION, lyric_units, map_alignment_to_lyrics
from app.services.karaoke_processing_review import fingerprint, lyrics_hashes, quality_flags


@dataclass(frozen=True)
class MediaAsset:
    path: str
    sha256: str
    size_bytes: int
    duration_ms: int


@dataclass
class StepProduct:
    payload: object
    usage: dict
    artifact_paths: list[str]
    checkpoint: dict


@dataclass(frozen=True)
class ProcessingResult:
    values: dict
    status: str = "NEEDS_REVIEW"


class KaraokeProcessingPipeline:
    def __init__(self, client):
        self.client = client

    async def process(self, job, context):
        await context.guard("VALIDATING_INPUT")
        source = MediaAsset(job.input_audio_path, job.input_audio_sha256,
                            job.input_audio_size_bytes, job.input_duration_ms)
        audio = await context.download(source, "source")
        reference = None
        if job.mode == "INSTRUMENTAL_WITH_REFERENCE":
            reference = MediaAsset(job.input_reference_path, job.input_reference_sha256,
                                   job.input_reference_size_bytes, job.input_reference_duration_ms)
            stem_input = await context.download(reference, "reference")
        else:
            stem_input = audio

        async def separate():
            stems = await self.client.separate(stem_input, context.workspace, context.cancel)
            vocal = await context.upload(stems.vocal)
            instrumental = await context.upload(stems.instrumental)
            expected_duration = reference.duration_ms if reference else source.duration_ms
            if any(abs(asset.duration_ms - expected_duration) > 100 for asset in (vocal, instrumental)):
                raise KaraokeEngineError("INVALID_PROVIDER_RESULT")
            usage = dict(artifacts={"vocal": asdict(vocal), "instrumental": asdict(instrumental)},
                         timeline_offset_ms=stems.timeline_offset_ms, diagnostics=stems.diagnostics)
            return StepProduct(dict(vocal=stems.vocal, instrumental=stems.instrumental,
                                    vocal_asset=vocal, instrumental_asset=instrumental,
                                    offset_ms=stems.timeline_offset_ms, diagnostics=stems.diagnostics),
                               usage, [vocal.path, instrumental.path], {})

        async def reuse_stems(usage, checkpoint):
            artifacts = {key: MediaAsset(**value) for key, value in usage["artifacts"].items()}
            vocal = await context.download(artifacts["vocal"], "cached-vocal")
            instrumental = await context.download(artifacts["instrumental"], "cached-instrumental")
            return StepProduct(
                dict(vocal=vocal, instrumental=instrumental, vocal_asset=artifacts["vocal"],
                     instrumental_asset=artifacts["instrumental"], offset_ms=usage["timeline_offset_ms"],
                     diagnostics=usage["diagnostics"]),
                usage, [asset.path for asset in artifacts.values()], {},
            )

        separation_hash = fingerprint(dict(input_sha256=reference.sha256 if reference else source.sha256,
                                            model=STEM_MODEL))
        stems = await context.step("PREPARING_AUDIO", "SEPARATE_STEMS", separation_hash,
                                   "local_demucs", STEM_MODEL, separate, reuse_stems)
        if job.mode == "INSTRUMENTAL_WITH_REFERENCE":
            async def verify():
                proof = await self.client.verify_reference(audio, stems.payload["instrumental"],
                                                           context.workspace, context.cancel)
                return StepProduct(proof, proof, [], {})
            async def reuse_proof(usage, checkpoint):
                # Inputs are immutable, hashed and step fingerprint-bound. No new
                # provider call is needed for a completed measured clock proof.
                if usage.get("verified") is not True:
                    raise ValueError("Invalid cached clock proof")
                return StepProduct(usage, usage, [], {})
            await context.step("PREPARING_AUDIO", "VERIFY_REFERENCE_TIMELINE",
                fingerprint(dict(instrumental=source.sha256,
                                 reference_instrumental=stems.payload["instrumental_asset"].sha256)),
                "local_media", "clock-v1", verify, reuse_proof)
            final_audio = source
            offset = 0
        else:
            final_audio = stems.payload["instrumental_asset"]
            offset = stems.payload["offset_ms"]

        async def align():
            evidence = await self.client.align(stems.payload["vocal"], lyric_units(job.input_lyrics),
                                                context.workspace, context.cancel)
            mapped = map_alignment_to_lyrics(job.input_lyrics, evidence,
                duration_ms=final_audio.duration_ms, job_id=job.id, offset_ms=offset)
            checkpoint = dict(result_lyrics=mapped["lyrics"], quality_report=mapped["quality_report"])
            return StepProduct(checkpoint, dict(model_revision=ALIGNMENT_MODEL, boundary_version=ALIGNMENT_BOUNDARIES,
                                diagnostics=mapped["diagnostics"]), [], checkpoint)

        async def reuse_alignment(usage, checkpoint):
            checkpoint = deepcopy(checkpoint)
            if lyrics_hashes(checkpoint["result_lyrics"])[0] != job.lyrics_text_sha256:
                raise ValueError("Cached lyrics changed")
            flags = quality_flags(SimpleNamespace(quality_report=checkpoint["quality_report"]))
            checkpoint["quality_report"] = {"flags": [
                flag.model_copy(update={"id": uuid5(FLAG_NAMESPACE, f"{job.id}:{flag.line_id}")})
                    .model_dump(mode="json") for flag in flags
            ]}
            return StepProduct(checkpoint, usage, [], checkpoint)

        aligned = await context.step("ALIGNING_LYRICS", "ALIGN_PROVIDED_LYRICS",
            fingerprint(dict(vocal=stems.payload["vocal_asset"].sha256,
                             final_audio=final_audio.sha256, lyrics=job.lyrics_snapshot_sha256,
                             offset_ms=offset, model=ALIGNMENT_ENGINE, mapping=MAPPING_VERSION)),
            "local_ctc", ALIGNMENT_ENGINE, align, reuse_alignment)
        await context.guard("VALIDATING_RESULT")
        # Download/parse the final immutable MP3 again, rather than binding timing
        # to a source/reference file or trusting provider duration.
        await context.download(final_audio, "validated-output")
        values = dict(
            **aligned.checkpoint, result_audio_path=final_audio.path,
            result_audio_sha256=final_audio.sha256, result_audio_size_bytes=final_audio.size_bytes,
            result_duration_ms=final_audio.duration_ms,
            provenance=dict(pipeline_version=job.pipeline_version, alignment_model=ALIGNMENT_MODEL,
                alignment_boundaries=ALIGNMENT_BOUNDARIES,
                alignment_mapping=MAPPING_VERSION,
                stem_model=STEM_MODEL, local_offline=True, quality_calibrated=False,
                timeline_offset_ms=offset, stems=stems.payload["diagnostics"],
                alignment=aligned.usage["diagnostics"]),
        )
        return ProcessingResult(values)
