"""Pure metric helpers for the OCR benchmark.

Everything here compares OCR output with authored ground truth. Nothing reads
engine scores, and nothing folds diacritics when deciding equality.
"""
from __future__ import annotations

import sys
import unicodedata
from collections import Counter
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.ocr_punctuation import (  # noqa: E402
    canonical_punctuation,
    split_surface_token,
)

TONE_MARKS = {
    "́": "sắc", "̀": "huyền", "̉": "hỏi", "̃": "ngã", "̣": "nặng",
}
QUALITY_MARKS = {"̂": "mũ", "̆": "trăng", "̛": "râu"}
SENTENCE_TERMINATORS = {".", "!", "?"}


def lexical_key(token: str) -> str:
    """NFC, lower-cased lexical core; marks are preserved."""
    return unicodedata.normalize("NFC", split_surface_token(token).core).lower()


def attach_punctuation(tokens: list[str]) -> list[dict[str, object]]:
    """Group surface tokens into lexical tokens carrying their punctuation.

    A punctuation-only token ("–", "...") is not a word. It is attached as
    leading punctuation of the next word on the line, or as trailing
    punctuation of the previous word when it ends the sequence.
    """
    words: list[dict[str, object]] = []
    pending = ""
    for token in tokens:
        parts = split_surface_token(token)
        if not parts.core:
            pending += parts.trailing
            continue
        words.append({
            "surface": parts.surface,
            "key": lexical_key(token),
            "leading": canonical_punctuation(pending + parts.leading),
            "trailing": canonical_punctuation(parts.trailing),
        })
        pending = ""
    if pending and words:
        words[-1]["trailing"] = str(words[-1]["trailing"]) + canonical_punctuation(pending)
    return words


def align_words(truth: list[dict[str, object]], ocr: list[dict[str, object]]):
    """Order-preserving alignment on lexical keys (punctuation never shifts it)."""
    from app.services.admin_ocr_service import AdminOcrService
    from app.services.ocr_engine import align_ocr_tokens

    return AdminOcrService._collapse_isolated_replacements(
        align_ocr_tokens([str(w["key"]) for w in truth], [str(w["key"]) for w in ocr])
    )


def tone_of(word: str) -> str:
    decomposed = unicodedata.normalize("NFD", word)
    tones = [TONE_MARKS[ch] for ch in decomposed if ch in TONE_MARKS]
    return tones[0] if tones else "ngang"


def quality_signature(word: str) -> tuple[str, ...]:
    """Vowel-quality marks in order (mũ / trăng / râu), with their base letter."""
    decomposed = unicodedata.normalize("NFD", word.lower())
    signature = []
    for index, ch in enumerate(decomposed):
        if ch in QUALITY_MARKS:
            base = next(
                (decomposed[i] for i in range(index - 1, -1, -1)
                 if unicodedata.category(decomposed[i]) != "Mn"), "?")
            signature.append(base + QUALITY_MARKS[ch])
    return tuple(signature)


def base_letters(word: str) -> str:
    decomposed = unicodedata.normalize("NFD", word.lower())
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn").replace("đ", "d")


def _ratio(successes: int, total: int) -> tuple[int, int]:
    return successes, total


def text_metrics(truth_tokens: list[str], ocr_tokens: list[str]) -> dict[str, object]:
    """Recognition and punctuation metrics for one engine on one page."""
    import jiwer

    truth = attach_punctuation(truth_tokens)
    ocr = attach_punctuation(ocr_tokens)
    alignment = align_words(truth, ocr) if truth and ocr else []
    paired = [
        (truth[int(step["primary_index"])], ocr[int(step["secondary_index"])])
        for step in alignment
        if step["primary_index"] is not None and step["secondary_index"] is not None
    ]
    paired_truth = {int(step["primary_index"]) for step in alignment
                    if step["primary_index"] is not None and step["secondary_index"] is not None}
    paired_ocr = {int(step["secondary_index"]) for step in alignment
                  if step["primary_index"] is not None and step["secondary_index"] is not None}

    exact = sum(1 for t, o in paired if t["key"] == o["key"])
    marked = [w for w in truth if base_letters(str(w["key"])) != str(w["key"])]
    marked_exact = sum(
        1 for t, o in paired if t["key"] == o["key"] and base_letters(str(t["key"])) != str(t["key"]))

    tone_total = tone_correct = 0
    quality_total = quality_correct = 0
    d_total = d_correct = 0
    tone_confusion: Counter[tuple[str, str]] = Counter()
    vowel_confusion: Counter[tuple[str, str]] = Counter()
    consonant_confusion: Counter[tuple[str, str]] = Counter()
    for index, word in enumerate(truth):
        key = str(word["key"])
        partner = next((o for t, o in paired if t is word), None)
        other = str(partner["key"]) if partner is not None else None
        truth_tone = tone_of(key)
        if truth_tone != "ngang":
            tone_total += 1
            tone_correct += other is not None and tone_of(other) == truth_tone
        if other is not None:
            tone_confusion[(truth_tone, tone_of(other))] += 1
        else:
            tone_confusion[(truth_tone, "(mất từ)")] += 1
        if quality_signature(key):
            quality_total += 1
            quality_correct += other is not None and quality_signature(other) == quality_signature(key)
        if "đ" in key:
            d_total += 1
            d_correct += other is not None and other.count("đ") == key.count("đ")
        if other is not None and other != key:
            if quality_signature(other) != quality_signature(key):
                vowel_confusion[(" ".join(quality_signature(key)) or "(không)",
                                 " ".join(quality_signature(other)) or "(không)")] += 1
            truth_base, other_base = base_letters(key), base_letters(other)
            truth_d = key.replace("đ", "Đ")
            if key.count("đ") != other.count("đ"):
                consonant_confusion[("đ", "d")] += 1
            if len(truth_base) == len(other_base):
                for a, b in zip(truth_base, other_base):
                    if a != b and a not in "aeiouy" and b not in "aeiouy":
                        consonant_confusion[(a, b)] += 1
            del truth_d

    # Punctuation: multiset comparison per position (leading / trailing).
    true_positive = false_positive = false_negative = 0
    punctuation_confusion: Counter[tuple[str, str]] = Counter()
    boundary_total = boundary_correct = 0

    def compare(truth_marks: str, ocr_marks: str) -> None:
        nonlocal true_positive, false_positive, false_negative
        want, got = Counter(truth_marks), Counter(ocr_marks)
        hit = sum((want & got).values())
        true_positive += hit
        false_negative += sum(want.values()) - hit
        false_positive += sum(got.values()) - hit
        missing = list((want - got).elements())
        extra = list((got - want).elements())
        for a, b in zip(missing, extra):
            punctuation_confusion[(a, b)] += 1
        for a in missing[len(extra):]:
            punctuation_confusion[(a, "(mất)")] += 1
        for b in extra[len(missing):]:
            punctuation_confusion[("(không có)", b)] += 1

    for t, o in paired:
        compare(str(t["leading"]), str(o["leading"]))
        compare(str(t["trailing"]), str(o["trailing"]))
    for index, word in enumerate(truth):
        if index not in paired_truth:
            compare(str(word["leading"]) + str(word["trailing"]), "")
    for index, word in enumerate(ocr):
        if index not in paired_ocr:
            compare("", str(word["leading"]) + str(word["trailing"]))
    for word in truth:
        terminators = [ch for ch in str(word["trailing"]) if ch in SENTENCE_TERMINATORS]
        if terminators:
            boundary_total += 1
            partner = next((o for t, o in paired if t is word), None)
            boundary_correct += (
                partner is not None
                and [ch for ch in str(partner["trailing"]) if ch in SENTENCE_TERMINATORS] == terminators
            )

    truth_text = " ".join(str(w["key"]) for w in truth)
    ocr_text = " ".join(str(w["key"]) for w in ocr)
    return {
        "truth_words": len(truth),
        "ocr_words": len(ocr),
        "exact": exact,
        "marked_total": len(marked),
        "marked_exact": marked_exact,
        "cer": float(jiwer.cer(truth_text, ocr_text)) if ocr_text else 1.0,
        "wer": float(jiwer.wer(truth_text, ocr_text)) if ocr_text else 1.0,
        "tone": _ratio(tone_correct, tone_total),
        "vowel_quality": _ratio(quality_correct, quality_total),
        "d_stroke": _ratio(d_correct, d_total),
        "punct_tp": true_positive,
        "punct_fp": false_positive,
        "punct_fn": false_negative,
        "sentence_boundary": _ratio(boundary_correct, boundary_total),
        "paired_without_shift": _ratio(len(paired), len(truth)),
        "tone_confusion": tone_confusion,
        "vowel_confusion": vowel_confusion,
        "consonant_confusion": consonant_confusion,
        "punctuation_confusion": punctuation_confusion,
    }


def merge_text_metrics(items: list[dict[str, object]]) -> dict[str, object]:
    """Pool per-page metrics (micro-average; CER/WER are page means)."""
    import numpy as np

    def total(key: str) -> int:
        return sum(int(item[key]) for item in items)

    def pair(key: str) -> tuple[int, int]:
        return (sum(item[key][0] for item in items), sum(item[key][1] for item in items))

    def counter(key: str) -> Counter:
        merged: Counter = Counter()
        for item in items:
            merged.update(item[key])
        return merged

    tp, fp, fn = total("punct_tp"), total("punct_fp"), total("punct_fn")
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    return {
        "pages": len(items),
        "exact_word": (total("exact"), total("truth_words")),
        "diacritic_word": (total("marked_exact"), total("marked_total")),
        "mean_cer": float(np.mean([item["cer"] for item in items])) if items else None,
        "mean_wer": float(np.mean([item["wer"] for item in items])) if items else None,
        "tone": pair("tone"),
        "vowel_quality": pair("vowel_quality"),
        "d_stroke": pair("d_stroke"),
        "punct_precision": (tp, tp + fp),
        "punct_recall": (tp, tp + fn),
        "punct_f1": (
            2 * precision * recall / (precision + recall)
            if precision and recall else None
        ),
        "sentence_boundary": pair("sentence_boundary"),
        "alignment": pair("paired_without_shift"),
        "tone_confusion": counter("tone_confusion"),
        "vowel_confusion": counter("vowel_confusion"),
        "consonant_confusion": counter("consonant_confusion"),
        "punctuation_confusion": counter("punctuation_confusion"),
    }


# --- False yellow analysis ------------------------------------------------
FALSE_YELLOW_CAUSES = {
    "missing_engine_evidence": "Thiếu engine evidence (Tesseract không có token cho từ này)",
    "vietnamese_engines_disagree_marks": "Hai engine tiếng Việt đọc khác dấu",
    "vietnamese_engines_disagree_letters": "Hai engine tiếng Việt đọc khác chữ",
    "crop_gate": "Crop gate: vùng crop chạm biên/yếu",
    "bbox_gate": "Bbox gate: hình học box không hợp lệ",
    "token_mapping": "Token mapping (split/merge/không neo được vị trí)",
    "crop_contradiction": "Lượt đọc crop mâu thuẫn với lượt đọc dòng",
    "vietocr_unavailable": "VietOCR không có kết quả cho từ này",
    "other": "Nguyên nhân khác",
}


def false_yellow_cause(row: dict[str, object]) -> str:
    """Why a correctly recognized word was not confirmed, from its evidence."""
    viet, tess = row.get("vietocr"), row.get("tesseract")
    viet_key = lexical_key(viet) if isinstance(viet, str) and viet.strip() else None
    tess_key = lexical_key(tess) if isinstance(tess, str) and tess.strip() else None
    if row.get("engine_alignment") in {"split", "merge", "unresolved", "not_computed"}:
        return "token_mapping"
    engines_agree = viet_key is not None and viet_key == tess_key
    if engines_agree and row.get("bbox_quality") != "valid":
        return "bbox_gate"
    if engines_agree and row.get("crop_quality") != "usable":
        return "crop_gate"
    if viet_key is None:
        return "vietocr_unavailable"
    if tess_key is None:
        return "missing_engine_evidence"
    if viet_key != tess_key:
        return (
            "vietnamese_engines_disagree_marks"
            if base_letters(viet_key) == base_letters(tess_key)
            else "vietnamese_engines_disagree_letters"
        )
    crop_readings = [
        lexical_key(value) for value in (row.get("vietocr_crop"), row.get("tesseract_crop"))
        if isinstance(value, str) and value.strip()
    ]
    if any(reading != viet_key for reading in crop_readings):
        return "crop_contradiction"
    return "other"
