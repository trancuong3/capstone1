from __future__ import annotations

import re
import unicodedata

# Vietnamese diacritic characters (both uppercase & lowercase)
_VIET_DIACRITIC_RE = re.compile(
    r"[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ"
    r"ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]"
)

# Valid Vietnamese syllable structure (for ALL-CAPS diacritic-less words like PHAN, NHI, TIN, CHO, KHOA)
_VIET_ONSETS = (
    "ngh", "ng", "nh", "ch", "gh", "gi", "kh", "ph", "qu", "th", "tr",
    "b", "c", "d", "đ", "g", "h", "k", "l", "m", "n", "p", "q", "r", "s", "t", "v", "x", "",
)
_VIET_CODAS = ("nh", "ng", "ch", "c", "m", "n", "p", "t", "")
_VIET_VOWELS = set("aeiouyàáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ")

# Common Latin uppercase acronyms that should be spelled phonetically in Vietnamese
_LATIN_LETTER_VIET_NAMES: dict[str, str] = {
    "A": "a", "B": "bê", "C": "xê", "D": "đê", "E": "e", "F": "ép",
    "G": "gờ", "H": "hát", "I": "i", "J": "di", "K": "ca", "L": "lờ",
    "M": "mờ", "N": "nờ", "O": "o", "P": "pê", "Q": "quy", "R": "rờ",
    "S": "ét", "T": "tê", "U": "u", "V": "vê", "W": "vê kép", "X": "ích",
    "Y": "i", "Z": "dét",
}

# Known non-Vietnamese uppercase abbreviations in academic/OCR text
_KNOWN_ACRONYMS = {"LEC", "LAB", "PDF", "AI", "TTS", "STT", "OCR", "API", "LAN", "APK", "URL", "HTTP", "HTTPS", "WIFI", "CPU", "GPU", "RAM"}

_YEAR_RANGE_RE = re.compile(r"\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})\b")
_CODE_HYPHEN_RE = re.compile(r"\b([A-Z]{2,5})-(\d{1,5})\b")
_WORD_TOKEN_RE = re.compile(r"[A-Za-zÀ-ỹĐđ]+")


def is_likely_vietnamese_syllable(word: str) -> bool:
    """Return True if word looks like a valid Vietnamese syllable (with or without diacritics)."""
    lower = unicodedata.normalize("NFC", word).lower()
    if not lower or len(lower) > 8:
        return False
    if _VIET_DIACRITIC_RE.search(lower):
        return True
    if word.upper() in _KNOWN_ACRONYMS:
        return False
    # Check onset + vowel core + valid coda
    for onset in _VIET_ONSETS:
        if onset and not lower.startswith(onset):
            continue
        rest = lower[len(onset):]
        if not rest:
            continue
        for coda in _VIET_CODAS:
            if coda and not rest.endswith(coda):
                continue
            nucleus = rest[: len(rest) - len(coda)] if coda else rest
            if not nucleus or len(nucleus) > 3:
                continue
            if all(ch in _VIET_VOWELS for ch in nucleus):
                return True
    return False


def _spell_acronym_vietnamese(code: str) -> str:
    letters = [_LATIN_LETTER_VIET_NAMES.get(ch, ch.lower()) for ch in code.upper()]
    return " ".join(letters)


def _replace_code_hyphen(match: re.Match[str]) -> str:
    prefix = match.group(1)
    digits = match.group(2)
    return f"{_spell_acronym_vietnamese(prefix)} {digits}"


def _normalize_uppercase_token(match: re.Match[str], *, is_sentence_start: bool) -> str:
    token = match.group(0)
    if len(token) < 2 or not token.isupper():
        return token
    if token in _KNOWN_ACRONYMS:
        return _spell_acronym_vietnamese(token)
    if is_likely_vietnamese_syllable(token):
        lower = token.lower()
        return lower[0].upper() + lower[1:] if is_sentence_start else lower
    # Unknown all-caps Latin abbreviation (e.g., MTH, CS)
    if len(token) <= 4 and token.isascii():
        return _spell_acronym_vietnamese(token)
    return token.lower()


def normalize_vietnamese_tts_text(
    text: str,
    *,
    expand_ranges_and_codes: bool = True,
) -> str:
    """Normalize Vietnamese text for clear, full-tone TTS synthesis (VieNeu & Google).

    - Enforces Unicode NFC to preserve all 6 Vietnamese tones.
    - Converts ALL-CAPS Vietnamese words (TRƯỜNG, TOÁN, PHAN, NHI, BẬC...) to natural
      lowercase/sentence-case so neither Google TTS nor VieNeu misreads them as acronyms.
    - Optionally normalizes year ranges (2024-2025 -> 2024 đến 2025) and course codes
      (MTH-341 -> mờ tê hát 341).
    """
    cleaned = unicodedata.normalize("NFC", text or "").strip()
    if not cleaned:
        return ""

    # Normalize whitespace and stray OCR spacing around punctuation
    cleaned = re.sub(r"\s+", " ", cleaned)

    if expand_ranges_and_codes:
        cleaned = _YEAR_RANGE_RE.sub(r"\1 đến \2", cleaned)
        cleaned = _CODE_HYPHEN_RE.sub(_replace_code_hyphen, cleaned)

    # Normalize ALL-CAPS tokens while keeping sentence-start capitalization
    out_parts: list[str] = []
    last_end = 0
    for m in _WORD_TOKEN_RE.finditer(cleaned):
        prefix = cleaned[last_end : m.start()]
        out_parts.append(prefix)
        before_text = cleaned[: m.start()].rstrip()
        is_start = not before_text or before_text[-1] in ".!?:;\n"
        out_parts.append(_normalize_uppercase_token(m, is_sentence_start=is_start))
        last_end = m.end()
    out_parts.append(cleaned[last_end:])

    result = "".join(out_parts)
    return unicodedata.normalize("NFC", re.sub(r"\s+", " ", result).strip())
