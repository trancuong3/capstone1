"""Version-aware karaoke lyric timing checks and lossless timing invalidation."""
from copy import deepcopy

from app.schemas.karaoke import Lyrics, ValidationIssue, canonical_lyric_text


def timing_issues(lyrics: Lyrics, duration_ms: int | None):
    issues = []

    def add(code, line, syllable=None):
        issues.append(ValidationIssue(code=code, field="lyrics", line_id=line.id,
                                      syllable_id=syllable.id if syllable else None))

    def check(item, line, previous_end, parent=None):
        start, end = item.start_ms, item.end_ms
        target = item if parent is not None else None
        if start is None or end is None:
            add("TIMING_REQUIRED", line, target)
            return previous_end
        if start >= end:
            add("TIMING_INVALID", line, target)
        if start < previous_end:
            add("TIMING_OVERLAP", line, target)
        if ((duration_ms is not None and end > duration_ms)
                or (parent is not None and (
                    (parent.start_ms is not None and start < parent.start_ms)
                    or (parent.end_ms is not None and end > parent.end_ms)))):
            add("TIMING_OUT_OF_RANGE", line, target)
        return end

    previous_end = 0
    for line in lyrics.lines:
        previous_end = check(line, line, previous_end)
        if lyrics.format_version != 2:
            continue
        if not line.syllables:
            add("SYLLABLES_REQUIRED", line)
            continue
        if canonical_lyric_text(" ".join(s.text for s in line.syllables)) != canonical_lyric_text(line.text):
            add("SYLLABLE_TEXT_MISMATCH", line)
        previous_syllable_end = line.start_ms or 0
        for syllable in line.syllables:
            previous_syllable_end = check(syllable, line, previous_syllable_end, line)
    return issues


def clear_timings(value):
    """Keep IDs/text/format; a replacement track invalidates every nested mark."""
    result = deepcopy(value)
    for line in result["lines"]:
        line.update(start_ms=None, end_ms=None)
        for syllable in line.get("syllables") or []:
            syllable.update(start_ms=None, end_ms=None)
    return result
