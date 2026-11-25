"""Lightweight Stage 2/3 post-OCR helpers for Parent Private Books.

Strictly avoids importing heavy OCR ML dependencies (`ocr_engine`, `torch`,
`paddleocr`, `vietocr`, `pytesseract`, `jiwer`) so both the web process
(`run_parent_submission_post_ocr`) and the full in-process pipeline
(`parent_private_book_pipeline`) share one canonical contract for:
- candidate snapshot hashing
- word-box alignment on edited/proofread text
- word-level proofread suggestions (`{word_index, original, suggested, uncertain}`)
- spelling auto-acceptance rules
- deterministic quality + duplicate-page + rights-declaration findings
- full `ToolCheckScopeJson` and compact provider events
"""
from __future__ import annotations

import difflib
import hashlib
import re
import unicodedata
from typing import Any, Sequence

from app.services.book_quality_analyzer import (
    analyse_verified_text,
    content_fingerprint,
    duplicate_page_finding,
)
from app.services.ocr_ai.child_safety import content_hash as safety_content_hash
from app.services.ocr_text_utils import normalize_word

_WHITESPACE_RE = re.compile(r"\s+")


def normalize_private_book_text(value: str) -> str:
    return unicodedata.normalize(
        "NFC", str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    ).strip()


def compute_candidate_hash(
    candidate_text: str | None,
    *,
    source_sha256: str,
    is_image_only: bool = False,
) -> str:
    """Bind candidate snapshot hash to both normalized text and source image digest."""
    if is_image_only and not (candidate_text or "").strip():
        return hashlib.sha256(f"IMAGE_ONLY:{source_sha256}".encode("utf-8")).hexdigest()
    text_hash = safety_content_hash(candidate_text or "")
    return hashlib.sha256(f"{source_sha256}:{text_hash}".encode("utf-8")).hexdigest()


def valid_normalized_box(raw: object) -> list[float] | None:
    vals: list[float] | None = None
    if isinstance(raw, (list, tuple)) and len(raw) == 4:
        try:
            vals = [float(v) for v in raw]
        except (TypeError, ValueError):
            return None
    elif isinstance(raw, dict):
        try:
            vals = [
                float(raw["x"]),
                float(raw["y"]),
                float(raw.get("w", raw.get("width", 0.0))),
                float(raw.get("h", raw.get("height", 0.0))),
            ]
        except (KeyError, TypeError, ValueError):
            return None
    if vals is not None:
        x, y, w, h = vals
        if (
            0.0 <= x <= 1.0
            and 0.0 <= y <= 1.0
            and w > 0.0
            and h > 0.0
            and x + w <= 1.001
            and y + h <= 1.001
        ):
            return [
                round(x, 6),
                round(y, 6),
                round(min(w, 1.0 - x), 6),
                round(min(h, 1.0 - y), 6),
            ]
    return None


def extract_item_box(raw_item: dict[str, Any]) -> list[float] | None:
    for key in ("bounding_box", "bbox", "BoundingBox"):
        box = valid_normalized_box(raw_item.get(key))
        if box is not None:
            return box
    return None


def align_edited_text_to_words(
    edited_text: str,
    base_words: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Map edited/proofread Vietnamese text to valid normalized word boxes."""
    normalized_text = normalize_private_book_text(edited_text)
    if not normalized_text:
        return []
    lines = [line.strip() for line in normalized_text.split("\n") if line.strip()]
    tokens_with_lines: list[tuple[int, str]] = []
    for line_idx, line in enumerate(lines):
        for tok in _WHITESPACE_RE.split(line):
            if tok:
                tokens_with_lines.append((line_idx, tok))
    if not tokens_with_lines:
        return []

    raw_tokens = [tok for _, tok in tokens_with_lines]
    base_norms = [
        normalize_word(str(w.get("text") or w.get("Text") or ""))
        if isinstance(w, dict)
        else ""
        for w in base_words
    ]
    edit_norms = [normalize_word(tok) for tok in raw_tokens]
    matcher = difflib.SequenceMatcher(None, base_norms, edit_norms, autojunk=False)
    matched_base_for_edit: dict[int, int] = {}
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag in ("equal", "replace"):
            span = min(i2 - i1, j2 - j1)
            for offset in range(span):
                matched_base_for_edit[j1 + offset] = i1 + offset

    base_valid_norm_boxes: list[list[float]] = []
    for w in base_words:
        if isinstance(w, dict):
            b = extract_item_box(w)
            if b is not None:
                base_valid_norm_boxes.append(b)
    if base_valid_norm_boxes:
        left = max(0.02, min(b[0] for b in base_valid_norm_boxes))
        top = max(0.02, min(b[1] for b in base_valid_norm_boxes))
        right = min(0.98, max(b[0] + b[2] for b in base_valid_norm_boxes))
        bottom = min(0.98, max(b[1] + b[3] for b in base_valid_norm_boxes))
    else:
        left, top, right, bottom = 0.08, 0.08, 0.92, 0.92

    line_counts: dict[int, int] = {}
    for line_idx, _ in tokens_with_lines:
        line_counts[line_idx] = line_counts.get(line_idx, 0) + 1
    line_pos: dict[int, int] = {}
    total_lines = max(1, len(lines))
    total_h = max(0.08, bottom - top)
    line_h = min(0.08, total_h / total_lines)

    aligned: list[dict[str, Any]] = []
    for idx, (default_line_idx, token) in enumerate(tokens_with_lines):
        pos_in_line = line_pos.get(default_line_idx, 0)
        line_pos[default_line_idx] = pos_in_line + 1
        src_idx = matched_base_for_edit.get(idx)
        src = (
            base_words[src_idx]
            if src_idx is not None and src_idx < len(base_words) and isinstance(base_words[src_idx], dict)
            else None
        )
        raw_box = None
        line_idx = default_line_idx
        conf = None
        if src is not None:
            raw_box = extract_item_box(src)
            try:
                line_idx = max(
                    0, int(src.get("line_index", src.get("LineIndex", default_line_idx)) or 0)
                )
            except (TypeError, ValueError):
                line_idx = default_line_idx
            conf = src.get("ocr_confidence", src.get("OCRConfidence"))
        if raw_box is None:
            cols = max(1, line_counts.get(default_line_idx, 1))
            y = min(0.92, top + default_line_idx * (total_h / total_lines))
            slot_w = max(0.02, (right - left) / cols)
            x = min(0.95, left + pos_in_line * slot_w)
            w = max(0.015, min(slot_w * 0.9, 1.0 - x))
            h = max(0.015, min(line_h * 0.85, 1.0 - y))
            raw_box = [round(x, 6), round(y, 6), round(w, 6), round(h, 6)]
        entry: dict[str, Any] = {
            "word_index": idx,
            "line_index": line_idx,
            "text": token,
            "normalized_text": normalize_word(token) or token.casefold(),
            "bounding_box": raw_box,
            "bbox": raw_box,
        }
        if conf is not None:
            entry["ocr_confidence"] = conf
        aligned.append(entry)
    return aligned


def build_proofread_suggestions(
    ocr_words: list[dict[str, Any]],
    proofread_text: str,
    uncertain_indices: set[int] | Sequence[int] | None = None,
) -> list[dict[str, Any]]:
    """Compute canonical word-level spelling/diacritic diff between OCR and proofread output."""
    uncertain_set = {int(i) for i in (uncertain_indices or ())}
    proof_tokens = [tok for tok in normalize_private_book_text(proofread_text).split() if tok]
    suggestions: list[dict[str, Any]] = []
    for idx, word in enumerate(ocr_words):
        original = str(word.get("text") or "").strip() if isinstance(word, dict) else ""
        suggested = proof_tokens[idx] if idx < len(proof_tokens) else original
        is_uncertain = idx in uncertain_set
        if original != suggested or is_uncertain:
            suggestions.append(
                {
                    "word_index": idx,
                    "original": original,
                    "suggested": suggested,
                    "uncertain": is_uncertain,
                }
            )
    return suggestions


def should_auto_accept_spelling(
    suggestions: list[dict[str, Any]],
    uncertain_indices: set[int] | Sequence[int] | None = None,
) -> bool:
    """Auto-accept spelling only when zero suggested diffs and zero uncertain tokens exist."""
    return not suggestions and not bool(uncertain_indices)


def compact_provider_events(
    events: list[dict[str, Any]],
    *,
    default_stage: str = "TOOL_CHECK",
) -> list[dict[str, Any]]:
    compacted: list[dict[str, Any]] = []
    for evt in events:
        if not isinstance(evt, dict):
            continue
        compacted.append(
            {
                "provider": str(evt.get("provider") or "unknown"),
                "model": evt.get("model"),
                "stage": str(evt.get("stage") or default_stage),
                "chunk_id": evt.get("chunk_id"),
                "availability": evt.get("availability"),
                "error_code": evt.get("error_code"),
                "duration_ms": evt.get("duration_ms"),
            }
        )
    return compacted


def build_tool_check_scope(
    *,
    chunks_checked: int,
    total_chunks: int,
    requires_admin_visual_review: bool,
    local_ai_enforced: bool,
) -> dict[str, Any]:
    return {
        "modality": "TEXT_ONLY_WITH_OCR_IMAGE_PROOFREAD",
        "covers_all_chunks": True,
        "chunks_checked": int(chunks_checked),
        "total_chunks": int(total_chunks),
        "image_visual_safety_checked": False,
        "requires_admin_visual_review": bool(requires_admin_visual_review),
        "copyright_scanner_status": "NOT_CONFIGURED",
        "local_ai_enforced": bool(local_ai_enforced),
    }


def build_image_only_findings(source_sha256: str) -> list[dict[str, Any]]:
    return [
        {
            "finding_id": hashlib.sha256(
                f"IMAGE_ONLY:{source_sha256}".encode("utf-8")
            ).hexdigest()[:32],
            "source": "RULE",
            "category": "IMAGE_ONLY_OR_BLANK_PAGE",
            "severity": "MEDIUM",
            "content_type": "DESCRIPTION",
            "excerpt": "(Trang không phát hiện chữ hoặc chỉ có hình ảnh)",
            "explanation": (
                "OCR không phát hiện chữ tiếng Việt trên trang này. "
                "Tool Check chỉ kiểm tra văn bản nên không thể tự xác nhận an toàn "
                "cho trang chỉ có hình ảnh hoặc trang trắng."
            ),
            "recommendation": "Gửi Admin xem trực tiếp ảnh trang sách trước khi thêm vào sách.",
        }
    ]


def build_empty_text_findings(source_sha256: str) -> list[dict[str, Any]]:
    return [
        {
            "finding_id": hashlib.sha256(
                f"EMPTY:{source_sha256}".encode("utf-8")
            ).hexdigest()[:32],
            "source": "RULE",
            "category": "EMPTY_VERIFIED_TEXT",
            "severity": "MEDIUM",
            "content_type": "DESCRIPTION",
            "excerpt": "(Văn bản trống)",
            "explanation": "Nội dung trang sau chỉnh sửa đang trống.",
            "recommendation": "Bổ sung văn bản hợp lệ hoặc gửi Admin xem xét ảnh.",
        }
    ]


def build_rule_and_duplicate_findings(
    text_to_check: str,
    *,
    candidate_page_num: int,
    committed_texts: Sequence[tuple[int, str]],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for rule_finding in analyse_verified_text(text_to_check):
        findings.append(
            {
                "finding_id": hashlib.sha256(
                    f"RULE:{rule_finding.issue_type}:{rule_finding.excerpt_start}:{rule_finding.excerpt_end}".encode(
                        "utf-8"
                    )
                ).hexdigest()[:32],
                "source": "RULE",
                "category": rule_finding.issue_type,
                "severity": rule_finding.severity,
                "content_type": "DESCRIPTION",
                "excerpt": rule_finding.original_excerpt,
                "explanation": rule_finding.explanation,
                "recommendation": "Kiểm tra lại văn bản hoặc gửi Admin xem xét.",
            }
        )

    cand_fp = content_fingerprint(text_to_check)
    if cand_fp:
        for existing_page_num, existing_text in committed_texts:
            if content_fingerprint(existing_text) == cand_fp:
                dup = duplicate_page_finding(
                    text_to_check, candidate_page_num, existing_page_num
                )
                findings.append(
                    {
                        "finding_id": hashlib.sha256(
                            f"DUP:{existing_page_num}:{cand_fp}".encode("utf-8")
                        ).hexdigest()[:32],
                        "source": "RULE",
                        "category": dup.issue_type,
                        "severity": dup.severity,
                        "content_type": "DESCRIPTION",
                        "excerpt": dup.original_excerpt,
                        "explanation": dup.explanation,
                        "recommendation": (
                            "Kiểm tra xem trang này có bị tải trùng với trang đã có trong sách không."
                        ),
                    }
                )
                break
    return findings


def build_rights_declaration_finding(
    *,
    source_type: str,
    source_note: str | None,
    source_sha256: str,
) -> dict[str, Any] | None:
    if str(source_type or "").upper() == "OTHER" and len((source_note or "").strip()) < 10:
        return {
            "finding_id": hashlib.sha256(
                f"RIGHTS:{source_sha256}".encode("utf-8")
            ).hexdigest()[:32],
            "source": "RIGHTS_DECLARATION",
            "category": "RIGHTS_BASIS_UNSPECIFIED",
            "severity": "MEDIUM",
            "content_type": "DESCRIPTION",
            "excerpt": "(Chưa khai rõ nguồn/quyền sử dụng cho mục Nguồn khác)",
            "explanation": (
                "Hệ thống chưa có scanner bản quyền tự động và mục Nguồn khác chưa có căn cứ rõ ràng "
                "nên cần Admin rà soát thủ công."
            ),
            "recommendation": "Bổ sung rõ nguồn gốc hoặc gửi Admin xem xét.",
        }
    return None


def format_safety_findings(
    raw_safety_findings: Sequence[dict[str, Any]],
    *,
    suitability: str,
) -> tuple[list[dict[str, Any]], bool]:
    has_high_safety = suitability == "NOT_RECOMMENDED"
    formatted: list[dict[str, Any]] = []
    for sf in raw_safety_findings:
        if not isinstance(sf, dict):
            continue
        sev = str(sf.get("severity") or "MEDIUM")
        if sev == "HIGH":
            has_high_safety = True
        formatted.append(
            {
                "finding_id": sf.get("finding_id"),
                "source": "CHILD_SAFETY",
                "category": str(sf.get("category") or "OTHER_SENSITIVE"),
                "severity": sev,
                "content_type": sf.get("content_type"),
                "excerpt": str(sf.get("evidence_text") or sf.get("excerpt") or ""),
                "explanation": str(sf.get("explanation") or ""),
                "recommendation": sf.get("recommendation"),
            }
        )
    return formatted, has_high_safety
