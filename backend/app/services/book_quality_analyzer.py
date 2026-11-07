from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class QualityFinding:
    issue_type: str
    severity: str
    original_excerpt: str
    excerpt_start: int
    excerpt_end: int
    explanation: str


def _normalise(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).casefold().split())


def content_fingerprint(value: str) -> str:
    return hashlib.sha256(_normalise(value).encode("utf-8")).hexdigest()


def analyse_verified_text(value: str) -> list[QualityFinding]:
    """Deterministic checks only; every excerpt is copied from the exact source."""
    findings: list[QualityFinding] = []
    if not value.strip():
        return [
            QualityFinding(
                "EMPTY_VERIFIED_TEXT",
                "HIGH",
                "",
                0,
                0,
                "Revision đang được đánh dấu VERIFIED nhưng VerifiedText rỗng.",
            )
        ]

    replacement_at = value.find("\ufffd")
    if replacement_at >= 0:
        start = max(0, replacement_at - 40)
        end = min(len(value), replacement_at + 41)
        findings.append(QualityFinding(
            "REPLACEMENT_CHARACTER", "HIGH", value[start:end], start, end,
            "Văn bản chứa ký tự thay thế U+FFFD; cần đối chiếu ảnh gốc.",
        ))

    control = next((index for index, char in enumerate(value)
                    if unicodedata.category(char) == "Cc" and char not in "\n\r\t"), None)
    if control is not None:
        start = max(0, control - 30)
        end = min(len(value), control + 31)
        findings.append(QualityFinding(
            "INVALID_CONTROL_CHARACTER", "MEDIUM", value[start:end], start, end,
            "Văn bản có ký tự điều khiển không phải xuống dòng hoặc tab.",
        ))

    repeated_word = re.search(
        r"(?iu)\b([\wÀ-ỹ]+)(?:[ \t]+\1){2,}\b",
        value,
    )
    if repeated_word:
        start, end = repeated_word.span()
        findings.append(QualityFinding(
            "REPEATED_WORD", "MEDIUM", value[start:end], start, end,
            "Một từ xuất hiện liên tiếp ít nhất ba lần; đây là dấu hiệu cần kiểm tra, không tự kết luận là lỗi.",
        ))

    paragraphs = re.finditer(r"[^\n\r]+", value)
    seen: dict[str, tuple[int, int]] = {}
    for match in paragraphs:
        original = match.group(0)
        normalized = _normalise(original)
        if len(normalized) < 40:
            continue
        previous = seen.get(normalized)
        if previous is None:
            seen[normalized] = match.span()
            continue
        start, end = match.span()
        findings.append(QualityFinding(
            "REPEATED_PARAGRAPH", "LOW", original, start, end,
            "Đoạn văn này lặp lại một đoạn trước đó trong cùng trang; có thể là chủ ý, cần Admin đối chiếu.",
        ))
        if len(findings) >= 20:
            break
    return findings


def duplicate_page_finding(value: str, page_number: int, other_page_number: int) -> QualityFinding:
    excerpt = value[: min(len(value), 500)]
    return QualityFinding(
        "POSSIBLE_DUPLICATE_PAGE",
        "LOW",
        excerpt,
        0,
        len(excerpt),
        f"Nội dung trang {page_number} trùng sau chuẩn hóa với trang {other_page_number}; có thể là trang lặp có chủ ý.",
    )


def page_gap_finding(page_number: int, previous_page_number: int) -> QualityFinding:
    return QualityFinding(
        "PAGE_NUMBER_GAP",
        "LOW",
        str(page_number),
        0,
        len(str(page_number)),
        f"Số trang đang chuyển từ {previous_page_number} sang {page_number}; cần kiểm tra thứ tự và trang còn thiếu.",
    )
