"""One definition of first-pass and practice metrics for every report view.

No database writes, transcript re-alignment, or inference from UI colors.
Legacy comparisons without a final evidence snapshot are not assessments.
"""
from __future__ import annotations

from collections import defaultdict

from app.schemas.reading import ReadingAssessmentMetrics


def initial_snapshot(summary):
    if not isinstance(summary, dict) or summary.get("assessment_version") != 1:
        return None
    snapshot = summary.get("initial_assessment")
    if not isinstance(snapshot, list) or not snapshot:
        return None
    if any(not isinstance(word, dict) or word.get("status") not in {
            "CORRECT", "MISPRONUNCIATION", "OMISSION", "UNCERTAIN",
        } or not isinstance(word.get("word_id"), str) or not word["word_id"].strip()
        or not isinstance(word.get("text"), str) or not word["text"].strip()
        or type(word.get("word_index")) is not int or word["word_index"] < 0
        for word in snapshot):
        return None
    if (len({word["word_id"] for word in snapshot}) != len(snapshot)
            or len({word["word_index"] for word in snapshot}) != len(snapshot)):
        return None
    return snapshot


def aggregate_assessment(session_id, reports, events) -> dict:
    words = {}
    transcripts = []
    pages = set()
    # Repository order is newest first; the earliest finalized snapshot wins
    # even for historical duplicates. Never repair historical rows in-place.
    for report in reversed(reports):
        if report.SessionId != session_id or not isinstance(report.Summary, dict):
            continue
        if report.Summary.get("assessment_version") != 1:
            continue
        page_key = (str(report.PageId), str(report.PageRevisionId))
        if page_key in pages:
            continue
        snapshot = initial_snapshot(report.Summary)
        if snapshot is None:
            continue
        pages.add(page_key)
        transcripts.append(report.Transcript)
        for word in snapshot:
            words[(*page_key, word["word_id"])] = word
    if not pages:
        return {"assessment": None}

    errors = {key for key, word in words.items()
              if word["status"] in {"MISPRONUNCIATION", "OMISSION"}}
    uncertain = {key for key, word in words.items() if word["status"] == "UNCERTAIN"}
    corrected = set()
    failed_attempts = defaultdict(set)
    evaluated_attempts = set()
    for event in events:
        if event.SessionId != session_id or event.Type != "WORD_RETRY":
            continue
        key = (str(event.PageId), str(event.PageRevisionId), str(event.WordId))
        if key not in errors or not isinstance(event.Metadata, dict):
            continue
        attempt = event.Metadata.get("retry_attempt", event.Metadata.get("attempt"))
        if type(attempt) is not int or attempt < 1:
            continue
        if event.Status == "UNCERTAIN":
            uncertain.add(key)
            continue
        if event.Status not in {"CONFIRMED", "FAILED"}:
            continue
        attempt_key = (*key, attempt)
        if attempt_key in evaluated_attempts:
            continue
        evaluated_attempts.add(attempt_key)
        if event.Status == "CONFIRMED":
            corrected.add(key)
        else:
            failed_attempts[key].add(attempt)

    correct_words = [word["text"] for word in words.values() if word["status"] == "CORRECT"]
    incorrect_words = [word["text"] for word in words.values() if word["status"] == "MISPRONUNCIATION"]
    omitted_words = [word["text"] for word in words.values() if word["status"] == "OMISSION"]
    assessed = len(correct_words) + len(errors)
    return {
        "assessment": ReadingAssessmentMetrics(
            first_pass_correct=len(correct_words), first_pass_incorrect=len(errors),
            self_corrected_words=len(corrected), unresolved_words=len(errors - corrected),
            retry_attempts=len(evaluated_attempts),
            skipped_after_retry_limit=sum(len(attempts) >= 3 for attempts in failed_attempts.values()),
            recognition_uncertain=len(uncertain),
        ),
        "correct_words": correct_words, "mispronounced_words": incorrect_words,
        "skipped_words": omitted_words, "transcripts": transcripts,
        "spoken_words": [word for transcript in transcripts for word in transcript.split()],
        "practiced_words": assessed,
        "score": int(len(correct_words) / assessed * 100 + 0.5) if assessed else None,
    }


def aggregate_period_assessment(sessions) -> dict:
    totals = {name: 0 for name in ReadingAssessmentMetrics.model_fields}
    assessed = 0
    for session_id, reports, events in sessions:
        metrics = aggregate_assessment(session_id, reports, events)["assessment"]
        if metrics is not None:
            assessed += 1
            for name, value in metrics.model_dump().items():
                totals[name] += value
    return {
        "assessment": ReadingAssessmentMetrics(**totals) if assessed else None,
        "assessment_coverage": {"assessed_sessions": assessed, "total_sessions": len(sessions)},
    }
