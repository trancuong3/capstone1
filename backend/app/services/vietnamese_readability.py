"""Deterministic Vietnamese grade-readability and phonics-readiness analyzer.

Grounded in `app.services.vietnamese_phonics` syllable decomposition without
mutating `analyse_verified_text` findings (preserving OCR/moderation gates).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Literal

from app.services.vietnamese_phonics import (
    _extract_syllable_slices,
    _is_orthographically_valid,
    _resolve_underlying_rhyme,
    decompose_vietnamese_syllable,
    split_vietnamese_rhyme,
)

GradeBand = Literal["GRADE_1", "GRADE_2", "GRADE_3", "GRADE_4_5", "UNRATED"]
GradeMatchStatus = Literal["MATCHED", "TOO_HARD", "TOO_EASY", "UNRATED"]

_SENTENCE_SPLIT_RE = re.compile(r"(?:[.!?…]+(?:\s+|$)|\n+)")
_HYPHENATED_TOKEN_RE = re.compile(r"\b[\wÀ-ỹ]+(?:-[\wÀ-ỹ]+)+\b", re.UNICODE)

_COMPLEX_ONSETS = frozenset(
    {"ngh", "ng", "gh", "kh", "nh", "ch", "ph", "th", "tr", "qu", "gi"}
)
_COMPLEX_RHYMES = frozenset(
    {
        "oai",
        "oay",
        "oao",
        "oeo",
        "uây",
        "uôi",
        "ươi",
        "uya",
        "uyu",
        "iêu",
        "yêu",
        "ươu",
        "uyên",
        "uyêt",
        "oang",
        "oăng",
        "oanh",
        "oach",
        "uynh",
        "uych",
        "iêng",
        "ương",
        "uông",
        "ươc",
        "iêc",
        "oăt",
        "uât",
        "uân",
        "oan",
        "oăn",
        "oăt",
        "uêch",
        "uênh",
        "uơ",
    }
)


@dataclass(frozen=True)
class VietnameseReadabilityReport:
    syllable_count: int
    sentence_count: int
    avg_syllables_per_sentence: float
    complex_phonics_ratio: float
    multisyllable_ratio: float
    decodable_syllable_ratio: float
    estimated_grade_band: GradeBand
    estimated_min_grade: int
    estimated_max_grade: int
    grade_match_status: GradeMatchStatus
    phonics_readiness_score: float
    sample_complex_syllables: list[str]
    explanation_vi: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "syllable_count": self.syllable_count,
            "sentence_count": self.sentence_count,
            "avg_syllables_per_sentence": self.avg_syllables_per_sentence,
            "complex_phonics_ratio": self.complex_phonics_ratio,
            "multisyllable_ratio": self.multisyllable_ratio,
            "decodable_syllable_ratio": self.decodable_syllable_ratio,
            "estimated_grade_band": self.estimated_grade_band,
            "estimated_min_grade": self.estimated_min_grade,
            "estimated_max_grade": self.estimated_max_grade,
            "grade_match_status": self.grade_match_status,
            "phonics_readiness_score": self.phonics_readiness_score,
            "sample_complex_syllables": list(self.sample_complex_syllables),
            "explanation_vi": self.explanation_vi,
        }


def _is_complex_syllable(surface: str) -> tuple[bool, bool]:
    """Return (is_complex_phonics, is_orthographically_decodable)."""
    parts = decompose_vietnamese_syllable(surface)
    if parts is None:
        return False, False
    nucleus_or_rhyme = _resolve_underlying_rhyme(parts.onset, parts.rhyme)
    _, coda = split_vietnamese_rhyme(parts.rhyme)
    decodable = _is_orthographically_valid(parts.onset, parts.rhyme, coda, parts.tone)
    is_complex = (
        parts.onset in _COMPLEX_ONSETS
        or nucleus_or_rhyme in _COMPLEX_RHYMES
        or len(nucleus_or_rhyme) >= 4
    )
    return is_complex, decodable


def analyse_vietnamese_readability(
    text: str | None,
    *,
    min_grade: int | None = None,
    max_grade: int | None = None,
) -> VietnameseReadabilityReport:
    """Compute deterministic Vietnamese grade readability for verified/candidate text."""
    normalized = unicodedata.normalize("NFC", str(text or "")).strip()
    if not normalized:
        return VietnameseReadabilityReport(
            syllable_count=0,
            sentence_count=0,
            avg_syllables_per_sentence=0.0,
            complex_phonics_ratio=0.0,
            multisyllable_ratio=0.0,
            decodable_syllable_ratio=0.0,
            estimated_grade_band="UNRATED",
            estimated_min_grade=1,
            estimated_max_grade=5,
            grade_match_status="UNRATED",
            phonics_readiness_score=0.0,
            sample_complex_syllables=[],
            explanation_vi="Chưa có đủ văn bản đã xác minh để chấm độ khó theo khối lớp.",
        )

    raw_sentences = [
        chunk.strip()
        for chunk in _SENTENCE_SPLIT_RE.split(normalized)
        if chunk and chunk.strip()
    ]
    sentence_syllable_lists: list[list[tuple[str, str]]] = []
    all_syllables: list[tuple[str, str]] = []
    for chunk in raw_sentences:
        slices = [
            (surf, norm)
            for surf, norm in _extract_syllable_slices(chunk)
            if norm and not norm.isdigit()
        ]
        if slices:
            sentence_syllable_lists.append(slices)
            all_syllables.extend(slices)

    syllable_count = len(all_syllables)
    if syllable_count < 3:
        return VietnameseReadabilityReport(
            syllable_count=syllable_count,
            sentence_count=len(sentence_syllable_lists),
            avg_syllables_per_sentence=float(syllable_count),
            complex_phonics_ratio=0.0,
            multisyllable_ratio=0.0,
            decodable_syllable_ratio=1.0 if syllable_count else 0.0,
            estimated_grade_band="UNRATED",
            estimated_min_grade=1,
            estimated_max_grade=5,
            grade_match_status="UNRATED",
            phonics_readiness_score=50.0 if syllable_count else 0.0,
            sample_complex_syllables=[],
            explanation_vi="Văn bản quá ngắn (< 3 tiếng) nên chưa xếp bậc độ khó khối lớp.",
        )

    sentence_count = max(1, len(sentence_syllable_lists))
    avg_syllables = round(syllable_count / sentence_count, 2)

    complex_count = 0
    decodable_count = 0
    long_syllable_count = 0
    sample_complex: list[str] = []
    seen_complex: set[str] = set()

    for surface, norm in all_syllables:
        is_complex, is_decodable = _is_complex_syllable(surface)
        if is_decodable:
            decodable_count += 1
        if len(norm) >= 5:
            long_syllable_count += 1
        if is_complex:
            complex_count += 1
            if norm not in seen_complex and len(sample_complex) < 6:
                seen_complex.add(norm)
                sample_complex.append(surface)

    hyphenated_matches = _HYPHENATED_TOKEN_RE.findall(normalized)
    hyphenated_syllables = sum(len(m.split("-")) for m in hyphenated_matches)

    complex_ratio = round(complex_count / syllable_count, 4)
    multisyllable_ratio = round(
        min(1.0, (hyphenated_syllables + long_syllable_count * 0.5) / syllable_count),
        4,
    )
    decodable_ratio = round(decodable_count / syllable_count, 4)

    if avg_syllables <= 8.5 and complex_ratio <= 0.30:
        band: GradeBand = "GRADE_1"
        est_min, est_max = 1, 1
        band_label = "Lớp 1"
    elif avg_syllables <= 12.5 and complex_ratio <= 0.44:
        band = "GRADE_2"
        est_min, est_max = 2, 2
        band_label = "Lớp 2"
    elif avg_syllables <= 16.5 and complex_ratio <= 0.58:
        band = "GRADE_3"
        est_min, est_max = 3, 3
        band_label = "Lớp 3"
    else:
        band = "GRADE_4_5"
        est_min, est_max = 4, 5
        band_label = "Lớp 4–5"

    match_status: GradeMatchStatus = "UNRATED"
    grade_penalty = 0.0
    if (
        isinstance(min_grade, int)
        and not isinstance(min_grade, bool)
        and isinstance(max_grade, int)
        and not isinstance(max_grade, bool)
        and 1 <= min_grade <= 5
        and 1 <= max_grade <= 5
    ):
        low = min(min_grade, max_grade)
        high = max(min_grade, max_grade)
        if est_min > high:
            match_status = "TOO_HARD"
            grade_penalty = min(25.0, float(est_min - high) * 12.0)
        elif est_max < low:
            match_status = "TOO_EASY"
            grade_penalty = min(12.0, float(low - est_max) * 6.0)
        else:
            match_status = "MATCHED"

    raw_readiness = decodable_ratio * 100.0 - grade_penalty
    phonics_readiness_score = round(max(0.0, min(100.0, raw_readiness)), 1)

    if match_status == "MATCHED":
        status_phrase = f"Khớp tốt với mục tiêu Lớp {min_grade}–{max_grade}"
    elif match_status == "TOO_HARD":
        status_phrase = (
            f"Câu hoặc vần hơi khó so với Lớp {min_grade}–{max_grade} (ước lượng {band_label})"
        )
    elif match_status == "TOO_EASY":
        status_phrase = (
            f"Nhẹ hơn mục tiêu Lớp {min_grade}–{max_grade} (ước lượng {band_label}, phù hợp khởi động)"
        )
    else:
        status_phrase = f"Ước lượng độ khó tương đương {band_label}"

    explanation_vi = (
        f"{status_phrase}: trung bình {avg_syllables:.1f} tiếng/câu, "
        f"{round(complex_ratio * 100)}% vần/âm đầu ghép, "
        f"{phonics_readiness_score:.0f}% sẵn sàng đánh vần tiếng Việt."
    )

    return VietnameseReadabilityReport(
        syllable_count=syllable_count,
        sentence_count=sentence_count,
        avg_syllables_per_sentence=avg_syllables,
        complex_phonics_ratio=complex_ratio,
        multisyllable_ratio=multisyllable_ratio,
        decodable_syllable_ratio=decodable_ratio,
        estimated_grade_band=band,
        estimated_min_grade=est_min,
        estimated_max_grade=est_max,
        grade_match_status=match_status,
        phonics_readiness_score=phonics_readiness_score,
        sample_complex_syllables=sample_complex,
        explanation_vi=explanation_vi,
    )
