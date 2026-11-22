from __future__ import annotations

import unicodedata

from app.services.vietnamese_tts_normalizer import (
    is_likely_vietnamese_syllable,
    normalize_vietnamese_tts_text,
)


def test_normalizes_all_caps_vietnamese_preserving_all_six_tones() -> None:
    sample = "Môi TRƯỜNG HỌC TỰ NHIÊN Bộ môn: TOÁN Giảng viên: PHAN QUÝ"
    out = normalize_vietnamese_tts_text(sample)
    assert unicodedata.is_normalized("NFC", out)
    assert "trường học tự nhiên" in out
    assert "Toán" in out or "toán" in out
    assert "Phan quý" in out or "phan quý" in out
    assert "TRƯỜNG" not in out
    assert "TOÁN" not in out


def test_preserves_six_vietnamese_tones_explicitly() -> None:
    sample = "MA MÁ MÀ MẢ MÃ MẠ BẬC ĐÀO TẠO ĐẠI HỌC"
    out = normalize_vietnamese_tts_text(sample)
    assert out == "Ma má mà mả mã mạ bậc đào tạo đại học"


def test_normalizes_academic_codes_and_year_ranges() -> None:
    sample = "Mã học phần: MTH-341. Năm học: 2024-2025. Số tín chỉ: 3 cho LEC"
    out = normalize_vietnamese_tts_text(sample)
    assert "mờ tê hát 341" in out
    assert "2024 đến 2025" in out
    assert "lờ e xê" in out


def test_is_likely_vietnamese_syllable() -> None:
    assert is_likely_vietnamese_syllable("TRƯỜNG") is True
    assert is_likely_vietnamese_syllable("PHAN") is True
    assert is_likely_vietnamese_syllable("NHI") is True
    assert is_likely_vietnamese_syllable("LEC") is False
    assert is_likely_vietnamese_syllable("MTH") is False
