"""Canonical karaoke fingerprints and server-owned review invalidation."""
from copy import deepcopy
import hashlib
import json
import unicodedata
from uuid import UUID

from app.schemas.karaoke import Lyrics

POLICY_VERSION = "karaoke-review-v1"
META_FIELDS = ("title", "author", "min_grade", "max_grade", "source_note", "usage_note")


def _canonical(value):
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: _canonical(item) for key, item in value.items()}
    return value


def fingerprint(value):
    content = json.dumps(_canonical(value), ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def lyrics_hashes(value):
    snapshot = Lyrics.model_validate(value).model_dump(mode="json")
    text = deepcopy(snapshot)
    for line in text["lines"]:
        line.pop("start_ms", None)
        line.pop("end_ms", None)
        for unit in line.get("syllables") or []:
            unit.pop("start_ms", None)
            unit.pop("end_ms", None)
    return fingerprint(text), fingerprint(snapshot)


def content_fingerprint(version):
    return fingerprint({
        "policy": POLICY_VERSION,
        "draft_version_id": version.id,
        "audio_sha256": version.audio_sha256,
        "lyrics": Lyrics.model_validate(version.lyrics).model_dump(mode="json"),
        "metadata": {field: getattr(version, field) for field in META_FIELDS},
        "cover_identity": version.cover_path,
        "origin_job_id": getattr(version, "origin_job_id", None),
        "reference_audio_sha256": getattr(version, "reference_audio_sha256", None),
    })


def clear_review(version):
    version.reviewed_content_sha256 = None
    version.reviewed_by = None
    version.reviewed_at = None
    version.review_acknowledged_flag_ids = []


def reviewed_current(version):
    return bool(getattr(version, "reviewed_at", None)
                and getattr(version, "reviewed_content_sha256", None) == content_fingerprint(version))


def quality_flags(job):
    from app.schemas.karaoke_processing_types import QualityFlag
    report = getattr(job, "quality_report", None) or {}
    flags = report.get("flags", [])
    if not isinstance(flags, list) or len(flags) > 301:
        raise ValueError("Invalid quality report")
    result = [QualityFlag.model_validate(flag) for flag in flags]
    if len({flag.id for flag in result}) != len(result):
        raise ValueError("Duplicate quality flag")
    return result


def snapshot_matches(state, job):
    draft = state.draft
    return bool(draft and draft.state == "DRAFT" and draft.id == job.draft_version_id
                and state.song.revision == job.base_revision
                and draft.audio_sha256 == job.base_audio_sha256
                and getattr(draft, "reference_audio_sha256", None) == job.base_reference_sha256
                and lyrics_hashes(draft.lyrics)[1] == job.lyrics_snapshot_sha256)


def ambiguous_operations(operations):
    # PREPARED is conservative: a crash may have happened just after submission.
    # The only exception is our fixed offline subprocess adapters, whose marker
    # is persisted before execution. Browser requests cannot choose this identity.
    def known_local(op):
        usage = getattr(op, "usage", None) or {}
        return (op.provider in {"local_ctc", "local_demucs", "local_media"}
                and usage.get("execution") == "OFFLINE_LOCAL_V1"
                and usage.get("external_charge_possible") is False)
    return any(op.state in {"PREPARED", "SUBMITTED", "UNKNOWN"} and not known_local(op)
               for op in operations)
