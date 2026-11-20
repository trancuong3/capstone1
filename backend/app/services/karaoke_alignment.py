"""Pure mapping from measured evidence into stable karaoke v2 identities."""
from collections import Counter
from copy import deepcopy
import unicodedata
from uuid import UUID, uuid5

from app.providers.karaoke_alignment_provider import AlignmentEvidence
from app.schemas.karaoke import Lyrics, canonical_lyric_text
from app.schemas.karaoke_processing_types import QualityFlag
from app.services.karaoke_lyrics import clear_timings, timing_issues
from app.services.karaoke_transcript_agreement import transcript_agreement

FLAG_NAMESPACE = UUID("3799e1bf-3414-4c67-a85d-108bfbf24a50")
MAPPING_VERSION = "ordered-word-edits-v3"


class AlignmentRejected(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def canonical_text(value):
    value = unicodedata.normalize("NFC", value).lower()
    return " ".join("".join(char for char in word
                           if unicodedata.category(char).startswith(("L", "M")))
                    for word in value.split()).strip()


def lyric_units(lyrics):
    value = Lyrics.model_validate(lyrics)
    if value.format_version != 2 or not value.lines:
        raise AlignmentRejected("LYRICS_NOT_MATCHED")
    result = []
    for line in value.lines:
        if (not line.syllables or canonical_lyric_text(line.text) !=
                canonical_lyric_text(" ".join(unit.text for unit in line.syllables))):
            raise AlignmentRejected("LYRICS_NOT_MATCHED")
        result.extend(unit.text for unit in line.syllables)
    return result


def map_alignment_to_lyrics(input_lyrics, evidence, *, duration_ms, job_id, offset_ms=0):
    """Never divide a multi-unit word span or infer timing from lyric length.

    Thresholds below are conservative experimental review triggers, not a
    calibrated accuracy score. Until the held-out gate passes, the pipeline
    always emits NEEDS_REVIEW even when structural timing is complete.
    """
    value = Lyrics.model_validate(input_lyrics).model_dump(mode="json")
    texts = lyric_units(value)
    evidence = AlignmentEvidence.model_validate(evidence)
    if type(offset_ms) is not int or abs(offset_ms) > 100:
        raise AlignmentRejected("INVALID_PROVIDER_RESULT")
    if abs(evidence.duration_ms - duration_ms) > 100:
        raise AlignmentRejected("REFERENCE_TIMELINE_MISMATCH")
    expected = [canonical_text(text) for text in texts]
    recognized = canonical_text(evidence.recognized_text).split()
    agreement = transcript_agreement(expected, recognized)
    if not recognized:
        raise AlignmentRejected("NO_USABLE_VOCALS")
    if agreement < 0.35:
        raise AlignmentRejected("LYRICS_NOT_MATCHED")
    by_index, covered = {}, set()
    for unit in evidence.units:
        positions = set(range(unit.index, unit.index + unit.unit_count))
        if not positions or max(positions) >= len(texts) or covered & positions:
            raise AlignmentRejected("INVALID_PROVIDER_RESULT")
        covered.update(positions)
        if unit.unit_count == 1:
            by_index[unit.index] = unit
        # A provider word covering several Vietnamese syllables does not provide
        # internal boundaries. Deliberately leave those syllables null.
    raw = clear_timings(deepcopy(value))
    flags, cursor, previous_end = [], 0, 0
    counts = Counter(canonical_text(line["text"]) for line in raw["lines"])
    for line in raw["lines"]:
        codes, affected = set(), []
        for unit in line["syllables"]:
            acoustic = by_index.get(cursor)
            cursor += 1
            if acoustic is None:
                codes.add("UNALIGNED_SYLLABLES")
                affected.append(unit["id"])
                continue
            if canonical_text(acoustic.text) != canonical_text(unit["text"]):
                codes.update(("LYRIC_MISMATCH", "UNALIGNED_SYLLABLES"))
                affected.append(unit["id"])
                continue
            start = None if acoustic.start_ms is None else acoustic.start_ms + offset_ms
            end = None if acoustic.end_ms is None else acoustic.end_ms + offset_ms
            supported = acoustic.end_evidence != "unsupported"
            if acoustic.acoustic_support is None or acoustic.acoustic_support < 0.55:
                codes.add("LOW_ALIGNMENT_SUPPORT")
                affected.append(unit["id"])
            if start is None or end is None or not supported:
                codes.update(("UNALIGNED_SYLLABLES", "HELD_NOTE_UNCERTAIN"))
                affected.append(unit["id"])
                # An unknown sustain end does not erase a supported measured
                # onset. Keep it for manual review, never invent the end. Track
                # this onset in sequence so a later span cannot move backwards.
                if (start is not None and previous_end <= start < duration_ms
                        and acoustic.acoustic_support is not None
                        and acoustic.acoustic_support >= 0.55):
                    unit["start_ms"] = start
                    previous_end = start + 1
                continue
            if not previous_end <= start < end <= duration_ms:
                codes.add("UNALIGNED_SYLLABLES")
                affected.append(unit["id"])
                continue
            unit["start_ms"], unit["end_ms"] = start, end
            previous_end = end
        if agreement < 0.8:
            codes.add("LYRIC_MISMATCH")
            if counts[canonical_text(line["text"])] > 1:
                codes.add("AMBIGUOUS_REPEAT")
        if all(unit["start_ms"] is not None and unit["end_ms"] is not None
               for unit in line["syllables"]):
            line["start_ms"] = line["syllables"][0]["start_ms"]
            line["end_ms"] = line["syllables"][-1]["end_ms"]
        if codes:
            ordered = sorted(codes)
            ids = list(dict.fromkeys(affected))
            flags.append(QualityFlag(
                id=uuid5(FLAG_NAMESPACE, f"{job_id}:{line['id']}"),
                codes=ordered, line_id=line["id"], syllable_ids=ids[:10],
                affected_syllable_count=len(ids), message_key=ordered[0],
            ).model_dump(mode="json"))
    parsed = Lyrics.model_validate(raw)
    if not any(unit.start_ms is not None and unit.end_ms is not None
               for line in parsed.lines for unit in line.syllables):
        raise AlignmentRejected("LYRICS_NOT_MATCHED")
    blockers = timing_issues(parsed, duration_ms)
    # Missing marks are reviewable; invalid/overlapping spans must never be
    # returned as complete timing. The mapper already drops unsafe spans.
    if any(issue.code not in {"TIMING_REQUIRED"} for issue in blockers):
        raise AlignmentRejected("INVALID_PROVIDER_RESULT")
    return dict(
        lyrics=parsed.model_dump(mode="json"), quality_report={"flags": flags},
        diagnostics={"reference_units": len(texts), "aligned_units": sum(
            unit["start_ms"] is not None and unit["end_ms"] is not None
            for line in raw["lines"] for unit in line["syllables"]),
            "transcript_agreement": round(agreement, 4), "calibrated": False},
    )
