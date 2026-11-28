"""Deterministic Vietnamese phonological & tonal confusion profiler.

Analyzes real oral reading mispronunciations across:
1. `readingcomparisonreports.alignment` (`SUBSTITUTE` pairs within reached words)
2. `readingevents` (`WORD_RETRY` with `FAILED` status and `recognized_text`)
3. `difficult_word_practice_attempts` (`INCORRECT` attempts with `spokentranscript`)

Key safeguards:
- Pure deterministic Vietnamese syllable decomposition (`vietnamese_phonics.py`) — zero LLM calls.
- Filters out alignment boundary-shift noise by requiring minimal/near-minimal syllable skeleton overlap
  (same onset+rhyme for TONE, same rhyme for ONSET, same onset+nucleus for CODA).
- Requires multi-session recurrence (`min_distinct_sessions = 3` by default) so one-off STT hiccups
  are never over-interpreted.
- Strictly non-clinical Vietnamese phrasing suitable for Grade 1–5 parents and children.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from app.services.vietnamese_phonics import (
    decompose_vietnamese_syllable,
    normalize_vietnamese_word,
    split_vietnamese_rhyme,
)

PhonologicalCategory = Literal["TONE", "ONSET", "CODA"]

TONE_LABELS_VI: dict[str, str] = {
    "ngang": "thanh ngang",
    "sac": "thanh sắc",
    "huyen": "thanh huyền",
    "hoi": "thanh hỏi",
    "nga": "thanh ngã",
    "nang": "thanh nặng",
}

NON_CLINICAL_DISCLAIMER_VI = (
    "Gợi ý luyện đọc dựa trên lịch sử nhận diện giọng nói tự động (không phải chẩn đoán y khoa hay âm ngữ trị liệu)."
)

# Curated, child-safe Grade 1-3 Vietnamese minimal pairs keyed by canonical contrast pair.
CURATED_MINIMAL_PAIRS: dict[str, list[tuple[str, str, str]]] = {
    "TONE:hoi<->nga": [
        ("mả", "mã", "Chú ngựa phi nhanh — chữ mã có dấu ngã ngân cao."),
        ("cổ", "cỗ", "Mâm cỗ ngày Tết — phân biệt dấu hỏi trầm và dấu ngã."),
        ("vẻ", "vẽ", "Bé vẽ bức tranh — dấu ngã nhấn nhẹ ở giữa vần."),
    ],
    "TONE:sac<->nang": [
        ("má", "mạ", "Cây mạ xanh non — dấu sắc vút lên, dấu nặng dứt gọn."),
        ("lá", "lạ", "Chiếc lá xanh tươi — nghe rõ độ cao cuối âm tiết."),
        ("cá", "cạ", "Đàn cá bơi lội — đọc chậm từng tiếng rõ thanh."),
    ],
    "TONE:huyen<->hoi": [
        ("bà", "bả", "Bà kể chuyện cổ tích — thanh huyền đi xuống êm nhẹ."),
        ("cò", "cỏ", "Cánh cò trên đồng cỏ — thanh hỏi uốn nhẹ rồi lên."),
        ("mè", "mẻ", "Hạt mè thơm bùi — giữ hơi đều khi đọc từng tiếng."),
    ],
    "TONE:ngang<->sac": [
        ("ma", "má", "Đôi má hồng hào — thanh ngang bằng phẳng, thanh sắc đi lên."),
        ("la", "lá", "Chiếc lá mùa thu — nghe kỹ chiều đi lên của dấu sắc."),
        ("ca", "cá", "Con cá vàng bơi — đọc rõ từng thanh điệu."),
    ],
    "TONE:ngang<->huyen": [
        ("ba", "bà", "Hai bà cháu đọc sách — thanh ngang giữ đều, thanh huyền trầm xuống."),
        ("co", "cò", "Con cò trắng bay — hạ nhẹ giọng ở thanh huyền."),
    ],
    "TONE:huyen<->nang": [
        ("bà", "bạ", "Đọc chậm rõ âm cuối: thanh huyền ngân dài, thanh nặng ngắt gọn."),
        ("mè", "mẹ", "Mẹ hiền yêu thương — thanh nặng dứt nhẹ dưới cổ họng."),
    ],
    "ONSET:l<->n": [
        ("lá", "ná", "Chiếc lá xanh — âm l chạm đầu lưỡi lên lợi trên, không đẩy hơi lên mũi."),
        ("lúa", "núa", "Bông lúa chín vàng — uốn nhẹ đầu lưỡi khi phát âm l."),
        ("lồi", "nồi", "Chiếc nồi cơm ấm — âm n có hơi ngân nhẹ qua mũi."),
    ],
    "ONSET:ch<->tr": [
        ("che", "tre", "Lũy tre xanh — âm tr cong đầu lưỡi nhẹ lên vòm miệng."),
        ("châu", "trâu", "Con trâu kéo cày — âm ch đặt mặt lưỡi thẳng nhẹ nhàng."),
        ("chả", "trả", "Bé trả lời lễ phép — phân biệt âm đầu thẳng và cong lưỡi."),
    ],
    "ONSET:s<->x": [
        ("sôi", "xôi", "Đĩa xôi gấc dẻo — âm s cong nhẹ đầu lưỡi, âm x bật hơi êm."),
        ("sao", "xao", "Ngôi sao lấp lánh — lắng nghe tiếng gió nhẹ ở đầu âm."),
        ("sương", "xương", "Giọt sương ban mai — đọc chậm từng tiếng rõ âm đầu."),
    ],
    "ONSET:d<->r": [
        ("da", "ra", "Bé bước ra sân — âm r rung nhẹ đầu lưỡi."),
        ("dổ", "rổ", "Chiếc rổ tre nhỏ — cong đầu lưỡi nhẹ khi đọc âm r."),
    ],
    "ONSET:d<->đ": [
        ("da", "đa", "Cây đa đầu làng — âm đ chạm rõ đầu lưỡi vào chân răng trên."),
        ("dê", "đê", "Triền đê xanh mát — đọc dứt khoát âm đ."),
    ],
    "ONSET:c<->t": [
        ("cá", "tá", "Con cá nhỏ bơi — âm c phát từ gốc lưỡi, âm t từ đầu lưỡi."),
        ("cổ", "tổ", "Tổ chim trên cành — nghe rõ vị trí bật âm đầu."),
    ],
    "CODA:n<->ng": [
        ("bàn", "bàng", "Cây bàng sân trường — âm cuối -n khép đầu lưỡi, -ng mở nhẹ gốc lưỡi."),
        ("lan", "lang", "Hoa lan tỏa hương — giữ đầu lưỡi chạm lợi khi kết thúc bằng -n."),
        ("khăn", "khăng", "Chiếc khăn quàng ấm — nghe rõ độ vang cuối vần."),
    ],
    "CODA:t<->c": [
        ("mắt", "mắc", "Đôi mắt sáng trong — âm cuối -t khép đầu lưỡi, -c khép gốc lưỡi."),
        ("bát", "bác", "Chiếc bát trắng tinh — ngắt gọn và đúng vị trí lưỡi cuối vần."),
    ],
    "CODA:n<->nh": [
        ("bàn", "bành", "Cái bàn học sạch — âm cuối -nh mở rộng mặt lưỡi nhẹ."),
        ("an", "anh", "Anh em đoàn kết — phân biệt âm mũi đầu lưỡi và mặt lưỡi."),
    ],
}


@dataclass(frozen=True)
class PracticeAttemptEvidenceRow:
    attempt_id: UUID
    session_id: UUID | None
    normalized_word: str
    display_text: str
    assessment_status: str
    spoken_transcript: str | None
    created_at: datetime


@dataclass(frozen=True)
class _ClassifiedConfusion:
    pattern_key: str
    category: PhonologicalCategory
    unit_a: str
    unit_b: str
    expected_word: str
    spoken_word: str
    recurrence_bucket: str


def _canonical_pair(left: str, right: str) -> tuple[str, str]:
    return (left, right) if left <= right else (right, left)


def _normalize_onset_group(onset: str) -> str:
    # Orthographic variants representing the same phoneme (/k/, /g/, /ŋ/):
    # c/k/q, g/gh, ng/ngh are spelling rules, NOT pronunciation confusions if identical phoneme!
    if onset in ("c", "k", "q"):
        return "c"
    if onset in ("g", "gh"):
        return "g"
    if onset in ("ng", "ngh"):
        return "ng"
    return onset


def classify_syllable_confusion(
    expected_raw: str,
    spoken_raw: str,
    *,
    recurrence_bucket: str,
) -> _ClassifiedConfusion | None:
    """Classify a single `(expected_word, spoken_word)` pair if and only if it forms
    a genuine Vietnamese minimal/near-minimal phonological contrast (not boundary shift noise).
    """
    expected = normalize_vietnamese_word(expected_raw)
    spoken = normalize_vietnamese_word(spoken_raw)
    if not expected or not spoken or expected == spoken:
        return None
    # Spoken transcript from retry/practice may contain multiple tokens; only compare
    # when it's a single syllable or extract the closest syllable of matching length.
    spoken_tokens = [normalize_vietnamese_word(tok) for tok in spoken_raw.split() if normalize_vietnamese_word(tok)]
    if len(spoken_tokens) > 2:
        return None
    if len(spoken_tokens) == 2:
        # If the child uttered 2 words during retry (e.g. "con cá" for "cá"), pick the non-exact token only if one matches skeleton.
        candidates = [tok for tok in spoken_tokens if tok != expected]
        if len(candidates) != 1:
            return None
        spoken = candidates[0]

    exp_parts = decompose_vietnamese_syllable(expected)
    spk_parts = decompose_vietnamese_syllable(spoken)
    if exp_parts is None or spk_parts is None:
        return None

    exp_nucleus, exp_coda = split_vietnamese_rhyme(exp_parts.rhyme)
    spk_nucleus, spk_coda = split_vietnamese_rhyme(spk_parts.rhyme)
    exp_onset_norm = _normalize_onset_group(exp_parts.onset)
    spk_onset_norm = _normalize_onset_group(spk_parts.onset)

    # 1. Exact TONE minimal pair: identical onset phoneme + identical untoned rhyme, different tone.
    if (
        exp_onset_norm == spk_onset_norm
        and exp_parts.rhyme == spk_parts.rhyme
        and exp_parts.tone != spk_parts.tone
    ):
        a, b = _canonical_pair(exp_parts.tone, spk_parts.tone)
        return _ClassifiedConfusion(
            pattern_key=f"TONE:{a}<->{b}",
            category="TONE",
            unit_a=a,
            unit_b=b,
            expected_word=expected,
            spoken_word=spoken,
            recurrence_bucket=recurrence_bucket,
        )

    # 2. Minimal ONSET confusion: non-identical onset phoneme, identical untoned rhyme (nucleus + coda).
    if (
        exp_onset_norm != spk_onset_norm
        and exp_onset_norm != ""
        and spk_onset_norm != ""
        and exp_parts.rhyme == spk_parts.rhyme
    ):
        a, b = _canonical_pair(exp_onset_norm, spk_onset_norm)
        return _ClassifiedConfusion(
            pattern_key=f"ONSET:{a}<->{b}",
            category="ONSET",
            unit_a=a,
            unit_b=b,
            expected_word=expected,
            spoken_word=spoken,
            recurrence_bucket=recurrence_bucket,
        )

    # 3. Minimal CODA confusion: identical onset phoneme + identical vowel nucleus, non-empty contrasting coda.
    if (
        exp_onset_norm == spk_onset_norm
        and exp_nucleus == spk_nucleus
        and exp_coda != spk_coda
        and exp_coda != ""
        and spk_coda != ""
    ):
        a, b = _canonical_pair(exp_coda, spk_coda)
        return _ClassifiedConfusion(
            pattern_key=f"CODA:{a}<->{b}",
            category="CODA",
            unit_a=a,
            unit_b=b,
            expected_word=expected,
            spoken_word=spoken,
            recurrence_bucket=recurrence_bucket,
        )

    return None


def _pattern_display_vi(category: PhonologicalCategory, unit_a: str, unit_b: str) -> tuple[str, str]:
    if category == "TONE":
        la = TONE_LABELS_VI.get(unit_a, unit_a)
        lb = TONE_LABELS_VI.get(unit_b, unit_b)
        return (
            f"Cặp {la} ↔ {lb}",
            f"Bé đôi khi đọc nhầm giữa {la} và {lb} trên cùng một vần; ba mẹ có thể cùng bé luyện đọc chậm từng tiếng rõ dấu để tai nghe phân biệt độ cao rõ hơn.",
        )
    if category == "ONSET":
        return (
            f"Phụ âm đầu {unit_a}- ↔ {unit_b}-",
            f"Bé đang làm quen sự khác nhau giữa âm đầu “{unit_a}” và “{unit_b}” (thường gặp theo thói quen phát âm vùng miền hoặc tốc độ đọc nhanh).",
        )
    return (
        f"Âm cuối -{unit_a} ↔ -{unit_b}",
        f"Bé đôi khi khép vần giữa “-{unit_a}” và “-{unit_b}” chưa thật rõ; đọc chậm và giữ vị trí lưỡi ở cuối tiếng sẽ cải thiện rất nhanh.",
    )


def _build_minimal_pairs_for_pattern(
    pattern_key: str,
    observed_examples: list[tuple[str, str]],
    limit: int = 3,
) -> list[dict[str, str]]:
    pairs: list[dict[str, str]] = []
    seen_keys: set[tuple[str, str]] = set()

    # 1. Include up to 1 real observed minimal pair from the child's own books first!
    for exp_w, spk_w in observed_examples:
        canon = _canonical_pair(exp_w, spk_w)
        if canon in seen_keys:
            continue
        seen_keys.add(canon)
        pairs.append(
            {
                "word_a": exp_w,
                "word_b": spk_w,
                "target_word": exp_w,
                "contrast_word": spk_w,
                "hint_vi": f"Từ gặp trong sách của bé: đọc chậm “{exp_w}” rồi phân biệt với “{spk_w}”.",
                "origin": "CHILD_HISTORY",
            }
        )
        if len(pairs) >= 1:
            break

    # 2. Fill remaining slots from curated Grade-1 Vietnamese minimal pairs.
    for word_a, word_b, hint_vi in CURATED_MINIMAL_PAIRS.get(pattern_key, []):
        canon = _canonical_pair(word_a, word_b)
        if canon in seen_keys:
            continue
        seen_keys.add(canon)
        pairs.append(
            {
                "word_a": word_a,
                "word_b": word_b,
                "target_word": word_a,
                "contrast_word": word_b,
                "hint_vi": hint_vi,
                "origin": "CURATED_GRADE1",
            }
        )
        if len(pairs) >= limit:
            break

    # 3. If still < limit (uncommon onset/coda pair), include additional observed examples.
    if len(pairs) < limit:
        for exp_w, spk_w in observed_examples:
            canon = _canonical_pair(exp_w, spk_w)
            if canon in seen_keys:
                continue
            seen_keys.add(canon)
            pairs.append(
                {
                    "word_a": exp_w,
                    "word_b": spk_w,
                    "target_word": exp_w,
                    "contrast_word": spk_w,
                    "hint_vi": f"Nghe mẫu và đọc chậm từng tiếng: “{exp_w}” và “{spk_w}”.",
                    "origin": "CHILD_HISTORY",
                }
            )
            if len(pairs) >= limit:
                break

    return pairs


def compute_phonological_patterns(
    *,
    start: date,
    end: date,
    session_ids_in_window: set[UUID],
    reports: list[Any],
    retries: list[Any],
    practice_attempts: list[PracticeAttemptEvidenceRow] | None = None,
    local_date_fn: Any,
    min_distinct_sessions: int = 3,
    limit: int = 4,
) -> list[dict[str, Any]]:
    """Aggregate phonological/tonal confusion patterns across reading reports, retries, and practice attempts."""
    confusions: list[_ClassifiedConfusion] = []

    # 1. ReadingComparisonReport.alignment SUBSTITUTE items (up to last attempted book_index).
    for report in reports:
        if report.session_id not in session_ids_in_window:
            continue
        if not (start <= local_date_fn(report.created_at) <= end):
            continue
        alignment = report.alignment
        if not isinstance(alignment, list):
            continue
        entries = [item for item in alignment if isinstance(item, dict)]
        attempted = [
            item.get("book_index")
            for item in entries
            if item.get("status") in ("MATCH", "SUBSTITUTE")
            and isinstance(item.get("book_index"), int)
        ]
        if not attempted:
            continue
        last_idx = max(attempted)
        bucket = f"session:{report.session_id}"
        for item in entries:
            idx = item.get("book_index")
            if not isinstance(idx, int) or idx > last_idx:
                continue
            if item.get("status") != "SUBSTITUTE":
                continue
            book_w = item.get("book_word")
            spoken_w = item.get("spoken_word")
            if isinstance(book_w, str) and isinstance(spoken_w, str):
                hit = classify_syllable_confusion(book_w, spoken_w, recurrence_bucket=bucket)
                if hit is not None:
                    confusions.append(hit)

    # 2. ReadingEvent(Type="WORD_RETRY", Status="FAILED") recognized_text vs target_word.
    for retry in retries:
        if getattr(retry, "event_type", "WORD_RETRY") != "WORD_RETRY":
            continue
        if getattr(retry, "status", "") != "FAILED":
            continue
        if retry.session_id not in session_ids_in_window:
            continue
        if not (start <= local_date_fn(retry.created_at) <= end):
            continue
        meta = getattr(retry, "metadata", None)
        if not isinstance(meta, dict):
            continue
        target_w = meta.get("target_word") or meta.get("normalized_word")
        recog_w = meta.get("recognized_text")
        if isinstance(target_w, str) and isinstance(recog_w, str):
            hit = classify_syllable_confusion(
                target_w,
                recog_w,
                recurrence_bucket=f"session:{retry.session_id}",
            )
            if hit is not None:
                confusions.append(hit)

    # 3. DifficultWordPracticeAttempt(AssessmentStatus="INCORRECT") SpokenTranscript vs NormalizedWord.
    for attempt in practice_attempts or []:
        if attempt.assessment_status != "INCORRECT":
            continue
        attempt_day = local_date_fn(attempt.created_at)
        if not (start <= attempt_day <= end):
            continue
        if not attempt.spoken_transcript:
            continue
        # Group sessionless standalone practice attempts by calendar day so rapid retries
        # in a single sitting count as 1 practice session toward multi-session recurrence.
        bucket = (
            f"session:{attempt.session_id}"
            if attempt.session_id is not None
            else f"practice-day:{attempt_day.isoformat()}"
        )
        hit = classify_syllable_confusion(
            attempt.display_text or attempt.normalized_word,
            attempt.spoken_transcript,
            recurrence_bucket=bucket,
        )
        if hit is not None:
            confusions.append(hit)

    if not confusions:
        return []

    buckets_by_key: dict[str, set[str]] = defaultdict(set)
    counts_by_key: Counter[str] = Counter()
    pair_counts_by_key: dict[str, Counter[tuple[str, str]]] = defaultdict(Counter)
    meta_by_key: dict[str, tuple[PhonologicalCategory, str, str]] = {}

    for hit in confusions:
        buckets_by_key[hit.pattern_key].add(hit.recurrence_bucket)
        counts_by_key[hit.pattern_key] += 1
        pair_counts_by_key[hit.pattern_key][(hit.expected_word, hit.spoken_word)] += 1
        meta_by_key[hit.pattern_key] = (hit.category, hit.unit_a, hit.unit_b)

    results: list[dict[str, Any]] = []
    for pattern_key, total_count in counts_by_key.items():
        distinct_sessions = len(buckets_by_key[pattern_key])
        if distinct_sessions < min_distinct_sessions:
            continue
        category, unit_a, unit_b = meta_by_key[pattern_key]
        title_vi, summary_vi = _pattern_display_vi(category, unit_a, unit_b)
        ranked_examples = [
            pair
            for pair, _cnt in sorted(
                pair_counts_by_key[pattern_key].items(),
                key=lambda kv: (-kv[1], kv[0][0], kv[0][1]),
            )
        ]
        example_dicts = [
            {
                "expected_word": exp_w,
                "spoken_word": spk_w,
                "occurrences": pair_counts_by_key[pattern_key][(exp_w, spk_w)],
            }
            for exp_w, spk_w in ranked_examples[:4]
        ]
        results.append(
            {
                "pattern_key": pattern_key,
                "category": category,
                "unit_a": unit_a,
                "unit_b": unit_b,
                "title_vi": title_vi,
                "summary_vi": summary_vi,
                "occurrences": total_count,
                "distinct_sessions": distinct_sessions,
                "examples": example_dicts,
                "minimal_pairs": _build_minimal_pairs_for_pattern(
                    pattern_key, ranked_examples, limit=3
                ),
            }
        )

    results.sort(
        key=lambda item: (
            -item["distinct_sessions"],
            -item["occurrences"],
            item["pattern_key"],
        )
    )
    return results[:limit]
