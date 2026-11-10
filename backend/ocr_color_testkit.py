"""Shared, deterministic test data for the OCR three-color contract.

Ground truth here is authored text, never OCR output. The helpers build the
same evidence shapes the OCR engine persists, then run them through the real
service code (`_apply_verified_reference`, `_normalize_word_evidence`,
`classify_word_evidence`) so tests exercise production paths.
"""
from __future__ import annotations

import os
import unicodedata

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.services.admin_ocr_service import AdminOcrService, classify_word_evidence
from app.services.ocr_engine import normalize_word
from app.services.ocr_evidence import HYBRID_OCR_EVIDENCE_CONTRACT

# --- Vocabulary -----------------------------------------------------------
# The first 25 entries are the mandatory G001-G025 words.
MANDATORY_GREEN_WORDS = [
    "BỮA", "SÁNG", "CỦA", "NGỒI", "PHÒNG", "KHÁCH", "CHUẨN", "BỊ", "CHÀO",
    "BÀN", "ĂN", "BÁNH", "MÌ", "SỮA", "NGON", "CẢM", "ƠN", "MẸ", "ÔNG", "BÀ",
    "ĐẸP", "XUỐNG", "NHÀ", "HÔM", "NẮNG",
]

_EXTRA_WORDS = """
trường học sách vở bút thước cặp lớp thầy cô bạn bè chơi đùa vui vẻ buồn ngủ
dậy sớm muộn trưa chiều tối đêm ngày tháng năm tuần giờ phút mưa gió bão mây
trời đất nước lửa cây lá hoa quả rễ cành chim cá mèo chó gà vịt lợn bò trâu
ngựa khỉ hổ voi thỏ rùa ếch bướm kiến nhện đường phố chợ quê làng xóm ruộng
vườn sông suối biển núi đồi rừng cửa sổ ghế giường tủ đèn quạt bếp nồi chén
đũa thìa cơm canh rau thịt trứng đậu khoai ngô lúa gạo muối mật yêu thương
nhớ mong ước nghĩ biết hiểu hỏi trả lời đọc viết vẽ hát múa chạy nhảy bơi
leo nghỉ khoẻ mạnh nhỏ lớn thấp dài ngắn rộng hẹp mới cũ sạch bẩn nóng lạnh
ấm mát chữ nghĩa tiếng Việt Nguyễn quyển truyện khuya thuở ngoằn ngoèo khúc
khuỷu bố đi
""".split()


def _unique(words: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for word in words:
        key = normalize_word(word)
        if key and key not in seen:
            seen.add(key)
            result.append(unicodedata.normalize("NFC", word))
    return result


GREEN_WORDS = _unique(MANDATORY_GREEN_WORDS + _EXTRA_WORDS)

# The mandatory R001-R020 pairs: (ground truth, wrong OCR output).
MANDATORY_RED_PAIRS = [
    ("BỮA", "BỪA"), ("SÁNG", "SANG"), ("NGỒI", "NGÀI"), ("PHÒNG", "PHONG"),
    ("KHÁCH", "KHACH"), ("CHÀO", "CHAO"), ("BÀN", "BAN"), ("ĂN", "AN"),
    ("SỮA", "SUA"), ("MẸ", "ME"), ("BỐ", "BO"), ("ÔNG", "ONG"), ("BÀ", "BA"),
    ("CẢM", "CAM"), ("ƠN", "ON"), ("ĐI", "DI"), ("ĐẸP", "DEP"), ("NGON", "NGO"),
    ("XUỐNG", "XUÔNG"), ("NHÀ", "NHA"),
]

_GRAVE, _ACUTE, _CIRCUMFLEX, _TILDE = "̀", "́", "̂", "̃"
_BREVE, _HOOK, _HORN, _DOT = "̆", "̉", "̛", "̣"
_TONES = {_GRAVE, _ACUTE, _TILDE, _HOOK, _DOT}


def _nfd(value: str) -> str:
    return unicodedata.normalize("NFD", value)


def _nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def _swap(value: str, old: str, new: str) -> str:
    return _nfc(_nfd(value).replace(old, new, 1))


def corrupt(word: str, category: str) -> str | None:
    """Return a wrong OCR reading of ``word`` for one error category."""
    decomposed = _nfd(word)
    if category == "tone_dropped":
        result = _nfc("".join(ch for ch in decomposed if ch not in _TONES))
    elif category == "all_marks_dropped":
        result = _nfc(
            "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
        ).replace("đ", "d").replace("Đ", "D")
    elif category == "grave_to_hook":
        result = _swap(word, _GRAVE, _HOOK) if _GRAVE in decomposed else word
    elif category == "hook_to_tilde":
        result = _swap(word, _HOOK, _TILDE) if _HOOK in decomposed else word
    elif category == "tilde_to_hook":
        result = _swap(word, _TILDE, _HOOK) if _TILDE in decomposed else word
    elif category == "acute_to_dot":
        result = _swap(word, _ACUTE, _DOT) if _ACUTE in decomposed else word
    elif category == "circumflex_dropped":
        result = _swap(word, _CIRCUMFLEX, "") if _CIRCUMFLEX in decomposed else word
    elif category == "horn_dropped":
        result = _swap(word, _HORN, "") if _HORN in decomposed else word
    elif category == "breve_dropped":
        result = _swap(word, _BREVE, "") if _BREVE in decomposed else word
    elif category == "d_stroke_lost":
        result = word.replace("đ", "d").replace("Đ", "D")
    elif category == "last_char_missing":
        result = _nfc(word)[:-1] if len(_nfc(word)) >= 3 else word
    elif category == "extra_char":
        result = _nfc(word) + ("n" if word.islower() else "N")
    elif category == "wrong_first_char":
        first = _nfc(word)[0]
        replacement = "k" if first.lower() != "k" else "t"
        result = (replacement.upper() if first.isupper() else replacement) + _nfc(word)[1:]
    else:
        raise ValueError(f"unknown corruption category: {category}")
    if normalize_word(result) == normalize_word(word) or not normalize_word(result):
        return None
    return result


CORRUPTION_CATEGORIES = [
    "tone_dropped", "all_marks_dropped", "grave_to_hook", "hook_to_tilde",
    "tilde_to_hook", "acute_to_dot", "circumflex_dropped", "horn_dropped",
    "breve_dropped", "d_stroke_lost", "last_char_missing", "extra_char",
    "wrong_first_char",
]


def build_red_pairs() -> list[tuple[str, str, str]]:
    """(ground truth, wrong OCR output, error category), all distinct pairs."""
    pairs: list[tuple[str, str, str]] = [
        (truth, wrong, "mandatory") for truth, wrong in MANDATORY_RED_PAIRS
    ]
    seen = {(normalize_word(t), normalize_word(w)) for t, w, _ in pairs}
    for index, word in enumerate(GREEN_WORDS):
        # Rotate categories so every error family is exercised many times.
        for offset in range(len(CORRUPTION_CATEGORIES)):
            category = CORRUPTION_CATEGORIES[(index + offset) % len(CORRUPTION_CATEGORIES)]
            wrong = corrupt(word, category)
            if wrong is None:
                continue
            key = (normalize_word(word), normalize_word(wrong))
            if key in seen:
                continue
            seen.add(key)
            pairs.append((word, wrong, category))
            break
    return pairs


RED_PAIRS = build_red_pairs()


# --- Evidence builders ----------------------------------------------------
def engine_word(
    text: str,
    *,
    paddle: str | None = "__same__",
    vietocr: str | None = "__same__",
    tesseract: str | None = None,
    selected: str = "vietocr",
    statuses: dict[str, str] | None = None,
    alignment: str | None = None,
    bbox_quality: str = "valid",
    crop_quality: str = "usable",
    crop_evidence: dict[str, object] | None = None,
    token_index: int = 0,
    review_status: str | None = None,
    ocr_confidence: float | None = None,
) -> dict[str, object]:
    """One word exactly as the dual-engine pipeline emits it."""
    paddle_token = text if paddle == "__same__" else paddle
    vietocr_token = text if vietocr == "__same__" else vietocr
    both = isinstance(paddle_token, str) and isinstance(vietocr_token, str)
    agree = both and normalize_word(paddle_token) == normalize_word(vietocr_token)
    if alignment is None:
        alignment = "match" if agree else "substitute" if both else "unmatched"
    if crop_evidence is None:
        crop_evidence = (
            {"status": "not_needed", "reason": "engines_agree_but_agreement_is_not_verification"}
            if alignment == "match"
            else {"status": "skipped"}
        )
    engine_outputs: dict[str, object] = {"paddleocr": paddle_token, "vietocr": vietocr_token}
    default_statuses = {"paddleocr": "success", "vietocr": "success", "tesseract": "not_run"}
    if tesseract is not None:
        # Tesseract ran as the second Vietnamese engine and paired this token.
        engine_outputs["tesseract"] = tesseract
        default_statuses["tesseract"] = "success"
    return {
        "text": text,
        "ocr_confidence": ocr_confidence,
        "ocr_review_status": review_status or (
            "engine_agreement" if agree else "engine_disagreement" if both else "needs_review"
        ),
        "ocr_evidence": {
            "contract": HYBRID_OCR_EVIDENCE_CONTRACT,
            "engine_outputs": engine_outputs,
            "engine_statuses": statuses or default_statuses,
            "engine_errors": {},
            "paddle_token_index": token_index if isinstance(paddle_token, str) else None,
            "vietocr_token_index": token_index if isinstance(vietocr_token, str) else None,
            "alignment": alignment,
            "engine_agreement_score": 1.0 if agree else None,
            "calibrated_word_accuracy": None,
            "verification_source": None,
            "reference_text": None,
            "selected_engine": selected,
            "selection_reason": "vietocr_nonempty_nonrepetitive_provisional",
            "bbox_quality": bbox_quality,
            "crop_quality": crop_quality,
            "crop_evidence": crop_evidence,
            "review_reason": "test fixture",
        },
    }


def completed_crop(
    paddle: str | None,
    vietocr: str | None,
    tesseract: str | None = None,
    **extra: object,
) -> dict[str, object]:
    crop: dict[str, object] = {
        "status": "completed",
        "paddleocr_candidate": paddle,
        "vietocr_candidate": vietocr,
        "paddle_crop_recognition_score": 0.5,
        "vietocr_crop_recognition_score": 0.5,
    }
    if tesseract is not None:
        crop["tesseract_candidate"] = tesseract
    crop.update(extra)
    return crop


def classify_word(word: dict[str, object]) -> str:
    """Color of one pipeline word through the persisted-evidence path."""
    evidence = AdminOcrService._normalize_word_evidence(word.get("ocr_evidence"))
    return classify_word_evidence(
        str(word.get("ocr_review_status", "needs_review")), evidence, str(word["text"])
    )


def classify_page(
    words: list[dict[str, object]], reference_text: str | None
) -> list[str]:
    """Apply the verified reference (if any) and color every word."""
    if reference_text is not None:
        AdminOcrService._apply_verified_reference(words, reference_text)
    return [classify_word(word) for word in words]


def counts(colors: list[str]) -> dict[str, int]:
    return {group: colors.count(group) for group in ("green", "red", "yellow")}
