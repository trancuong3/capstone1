from __future__ import annotations

from dataclasses import dataclass
import re
import unicodedata
from typing import Any, Sequence

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
_KNOWN_ACRONYMS = {
    "LEC", "LAB", "PDF", "AI", "TTS", "STT", "OCR", "API", "LAN",
    "APK", "URL", "HTTP", "HTTPS", "WIFI", "CPU", "GPU", "RAM",
}

_YEAR_RANGE_RE = re.compile(r"\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})\b")
_CODE_HYPHEN_RE = re.compile(r"\b([A-Z]{2,5})-(\d{1,5})\b")
_WORD_TOKEN_RE = re.compile(r"[A-Za-zÀ-ỹĐđ]+")
_SPOKEN_TOKEN_RE = re.compile(r"[^\s]+")
_ALPHA_CHARS_RE = re.compile(r"[A-Za-zÀ-ỹĐđ0-9]+")

QUIZ_CHOICE_LABEL_RE = re.compile(
    r"\b(Đáp án|đáp án|Câu|câu|Phương án|phương án)\s+([ABCD])\s*[:.\-–—]\s*",
    re.UNICODE,
)
_LEADING_CHOICE_LABEL_RE = re.compile(r"^([ABCD])\s*[:.\-–—]\s*", re.UNICODE)
_MID_ELLIPSIS_RE = re.compile(
    r'(?:(?<=\s)|(?<=["“\'‘\(]))(?:…|\.{3})(?=\s|["”\'’\),.!?]|$)',
    re.UNICODE,
)
_TRAILING_ELLIPSIS_RE = re.compile(r"(?:…|\.{3,})")

CHOICE_LETTER_SPOKEN: dict[str, str] = {
    "A": "a",
    "B": "bê",
    "C": "xê",
    "D": "đê",
}

_PHONICS_SINGLE_CHAR_FIX: dict[str, str] = {
    "ă": "á",
    "â": "ớ",
    "đ": "đờ",
    "b": "bờ",
    "c": "cờ",
    "d": "dờ",
    "g": "gờ",
    "h": "hờ",
    "k": "ca",
    "l": "lờ",
    "m": "mờ",
    "n": "nờ",
    "p": "pờ",
    "q": "quờ",
    "r": "rờ",
    "s": "sờ",
    "t": "tờ",
    "v": "vờ",
    "x": "xờ",
}

# Numbers, dates, percents, fractions, ordinals, hyphens & OCR/markdown symbols
_DATE_FULL_RE = re.compile(
    r"(?<!\d)(\d{1,2})\s*[/\-]\s*(\d{1,2})\s*[/\-]\s*((?:19|20)\d{2})(?!\d)"
)
_DATE_DAY_MONTH_PREFIXED_RE = re.compile(
    r"\b(ngày|Ngày|mùng|Mùng)\s+(\d{1,2})\s*[/\-]\s*(\d{1,2})(?!\d)"
)
_PERCENT_RE = re.compile(r"(?<!\d)(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,3}))?\s*%")
_FRACTION_RE = re.compile(r"(?<!\d)(\d{1,3})\s*/\s*(\d{1,3})(?!\d)")
_THOUSANDS_RE = re.compile(r"(?<!\d)(\d{1,3}(?:\.\d{3})+)(?!\d)")
_DECIMAL_COMMA_RE = re.compile(r"(?<!\d)(\d{1,6}),(\d{1,3})(?!\d)")
_ORDINAL_PREFIX_RE = re.compile(
    r"\b(thứ|Thứ|hạng|Hạng)\s+(1|4)\b",
    re.UNICODE,
)
_HYPHENATED_VIET_WORD_RE = re.compile(
    r"(?<=[A-Za-zÀ-ỹĐđ])-(?=[a-zà-ỹđA-ZÀ-ỸĐ])",
    re.UNICODE,
)
_LEADING_DIALOGUE_DASH_RE = re.compile(r"(?:^|(?<=[\n]))\s*[—–\-]\s*")
_MID_EM_DASH_RE = re.compile(r"\s*[—–]\s*")
_ARROW_RE = re.compile(r"\s*(?:→|=>|->)\s*")
_WORD_SLASH_RE = re.compile(r"(?<=[A-Za-zÀ-ỹĐđ])\s*/\s*(?=[A-Za-zÀ-ỹĐđ])", re.UNICODE)
_MARKDOWN_SYMBOL_RE = re.compile(r"[*_`~#\[\]{}|•▪●◆◇►▶]+")
_MULTI_EXCLAIM_RE = re.compile(r"!{2,}")
_MULTI_QUEST_RE = re.compile(r"\?{2,}")
_MIXED_QUEST_EXCLAIM_RE = re.compile(r"(?:\?!|!\?)+")
_TRAILING_CLOSERS = "\"”'’)]}»"

_VIET_DIGITS = (
    "không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín",
)


def _read_three_digits_vi(n: int, *, full_hundreds: bool = False) -> str:
    hundreds = n // 100
    tens = (n % 100) // 10
    ones = n % 10
    parts: list[str] = []
    if hundreds > 0 or full_hundreds:
        parts.append(f"{_VIET_DIGITS[hundreds]} trăm")
        if tens == 0 and ones > 0:
            parts.append("linh")
    if tens == 1:
        parts.append("mười")
        if ones == 5:
            parts.append("lăm")
        elif ones > 0:
            parts.append(_VIET_DIGITS[ones])
    elif tens > 1:
        parts.append(f"{_VIET_DIGITS[tens]} mươi")
        if ones == 1:
            parts.append("mốt")
        elif ones == 4:
            parts.append("tư")
        elif ones == 5:
            parts.append("lăm")
        elif ones > 0:
            parts.append(_VIET_DIGITS[ones])
    elif ones > 0:
        parts.append(_VIET_DIGITS[ones])
    return " ".join(parts)


def number_to_vietnamese_words(value: int) -> str:
    """Convert non-negative integer (0..999_999_999) into natural Vietnamese words."""
    if value < 0:
        return f"âm {number_to_vietnamese_words(-value)}"
    if value == 0:
        return "không"
    if value < 1000:
        return _read_three_digits_vi(value, full_hundreds=False)

    scales = ("", "nghìn", "triệu", "tỷ")
    groups: list[int] = []
    rem = value
    while rem > 0:
        groups.append(rem % 1000)
        rem //= 1000

    parts: list[str] = []
    for idx in range(len(groups) - 1, -1, -1):
        grp = groups[idx]
        if grp == 0:
            continue
        is_highest = idx == len(groups) - 1
        chunk = _read_three_digits_vi(grp, full_hundreds=not is_highest)
        scale = scales[idx] if idx < len(scales) else ""
        parts.append(f"{chunk} {scale}".strip())
    return " ".join(parts)


def _read_decimal_digits_vi(frac_str: str) -> str:
    if len(frac_str) <= 2 and not frac_str.startswith("0"):
        return number_to_vietnamese_words(int(frac_str))
    return " ".join(_VIET_DIGITS[int(ch)] for ch in frac_str)


def _replace_full_date(match: re.Match[str]) -> str:
    day = int(match.group(1))
    month = int(match.group(2))
    year = int(match.group(3))
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return match.group(0)
    return (
        f"ngày {number_to_vietnamese_words(day)} "
        f"tháng {number_to_vietnamese_words(month)} "
        f"năm {number_to_vietnamese_words(year)}"
    )


def _replace_prefixed_day_month(match: re.Match[str]) -> str:
    prefix = match.group(1)
    day = int(match.group(2))
    month = int(match.group(3))
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return match.group(0)
    return (
        f"{prefix} {number_to_vietnamese_words(day)} "
        f"tháng {number_to_vietnamese_words(month)}"
    )


def _replace_percent(match: re.Match[str]) -> str:
    whole_raw = match.group(1).replace(".", "")
    frac_raw = match.group(2)
    whole_words = number_to_vietnamese_words(int(whole_raw))
    if frac_raw:
        return f"{whole_words} phẩy {_read_decimal_digits_vi(frac_raw)} phần trăm"
    return f"{whole_words} phần trăm"


def _replace_fraction(match: re.Match[str]) -> str:
    num = int(match.group(1))
    den = int(match.group(2))
    if den == 0:
        return match.group(0)
    den_word = "tư" if den == 4 and num < 4 else number_to_vietnamese_words(den)
    return f"{number_to_vietnamese_words(num)} phần {den_word}"


def _replace_thousands(match: re.Match[str]) -> str:
    raw = match.group(1).replace(".", "")
    return number_to_vietnamese_words(int(raw))


def _replace_decimal_comma(match: re.Match[str]) -> str:
    whole = int(match.group(1))
    frac = match.group(2)
    return f"{number_to_vietnamese_words(whole)} phẩy {_read_decimal_digits_vi(frac)}"


def _replace_ordinal_prefix(match: re.Match[str]) -> str:
    prefix = match.group(1)
    digit = match.group(2)
    word = "nhất" if digit == "1" else "tư"
    return f"{prefix} {word}"


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
        rest = lower[len(onset) :]
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


def ensure_tts_terminal_punctuation(text: str) -> str:
    """Append a terminal period only when utterance lacks terminal punctuation (respecting quotes)."""
    cleaned = unicodedata.normalize("NFC", text or "").strip()
    if not cleaned:
        return ""
    core = cleaned.rstrip(_TRAILING_CLOSERS).rstrip()
    if not core:
        return cleaned
    if core[-1] in ".!?…":
        return cleaned
    return f"{cleaned}."


def normalize_vietnamese_tts_text(
    text: str,
    *,
    expand_ranges_and_codes: bool = True,
    for_phonics_step: bool = False,
) -> str:
    """Canonical Vietnamese TTS text normalizer shared by Local VieNeu & Google Cloud TTS.

    - Enforces Unicode NFC to preserve all 6 Vietnamese tones.
    - Expands quiz labels ("Đáp án B:" -> "Đáp án bê,"), redacted ellipses ("…" -> ", chỗ trống, "),
      dates (12/5/2026), percentages (25%), fractions (1/2), formatted thousands (1.500),
      Vietnamese decimals (3,5), ordinals (thứ 1/thứ 4), year ranges (2024-2025 -> 2024 đến 2025),
      academic codes (MTH-341 -> mờ tê hát 341), and hyphenated words (ba-lô -> ba lô).
    - Cleans heavy punctuation, dialogue dashes, arrows, and raw markdown/OCR markup so TTS
      never reads markup aloud or stutters on repeated punctuation.
    - Converts ALL-CAPS Vietnamese words to natural lowercase/sentence-case.
    - Handles single-character phonics sounds when `for_phonics_step=True`.
    """
    cleaned = unicodedata.normalize("NFC", text or "").strip()
    if not cleaned:
        return ""

    cleaned = re.sub(r"\s+", " ", cleaned)

    if for_phonics_step:
        stripped_phonics = _MARKDOWN_SYMBOL_RE.sub("", cleaned).strip()
        lower_key = stripped_phonics.lower()
        if lower_key in _PHONICS_SINGLE_CHAR_FIX:
            return _PHONICS_SINGLE_CHAR_FIX[lower_key]
        cleaned = stripped_phonics
    else:
        cleaned = QUIZ_CHOICE_LABEL_RE.sub(
            lambda m: f"{m.group(1)} {CHOICE_LETTER_SPOKEN.get(m.group(2), m.group(2).lower())}, ",
            cleaned,
        )
        cleaned = _LEADING_CHOICE_LABEL_RE.sub(
            lambda m: f"{CHOICE_LETTER_SPOKEN.get(m.group(1), m.group(1).lower())}, ",
            cleaned,
        )
        cleaned = _MID_ELLIPSIS_RE.sub(", chỗ trống, ", cleaned)
        cleaned = _TRAILING_ELLIPSIS_RE.sub(",", cleaned)
        cleaned = _ARROW_RE.sub(", sang ", cleaned)
        cleaned = _MARKDOWN_SYMBOL_RE.sub(" ", cleaned)
        cleaned = _LEADING_DIALOGUE_DASH_RE.sub("", cleaned)

    if expand_ranges_and_codes:
        cleaned = _YEAR_RANGE_RE.sub(r"\1 đến \2", cleaned)
        cleaned = _CODE_HYPHEN_RE.sub(_replace_code_hyphen, cleaned)

    if not for_phonics_step:
        cleaned = _DATE_FULL_RE.sub(_replace_full_date, cleaned)
        cleaned = _DATE_DAY_MONTH_PREFIXED_RE.sub(_replace_prefixed_day_month, cleaned)
        cleaned = _PERCENT_RE.sub(_replace_percent, cleaned)
        cleaned = _FRACTION_RE.sub(_replace_fraction, cleaned)
        cleaned = _THOUSANDS_RE.sub(_replace_thousands, cleaned)
        cleaned = _DECIMAL_COMMA_RE.sub(_replace_decimal_comma, cleaned)
        cleaned = _ORDINAL_PREFIX_RE.sub(_replace_ordinal_prefix, cleaned)
        cleaned = _HYPHENATED_VIET_WORD_RE.sub(" ", cleaned)
        cleaned = _WORD_SLASH_RE.sub(" hoặc ", cleaned)
        cleaned = _MID_EM_DASH_RE.sub(", ", cleaned)
        cleaned = _MIXED_QUEST_EXCLAIM_RE.sub("?", cleaned)
        cleaned = _MULTI_EXCLAIM_RE.sub("!", cleaned)
        cleaned = _MULTI_QUEST_RE.sub("?", cleaned)
        cleaned = re.sub(r"\s+([,.;:!?])", r"\1", cleaned)
        cleaned = re.sub(r",\s*,+", ",", cleaned)
        cleaned = re.sub(r"^[,\s]+", "", cleaned)

    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    # Normalize ALL-CAPS tokens while keeping sentence-start capitalization
    out_parts: list[str] = []
    last_end = 0
    for m in _WORD_TOKEN_RE.finditer(cleaned):
        prefix = cleaned[last_end : m.start()]
        out_parts.append(prefix)
        before_text = cleaned[: m.start()].rstrip().rstrip(_TRAILING_CLOSERS)
        is_start = not before_text or before_text[-1] in ".!?:;\n"
        out_parts.append(_normalize_uppercase_token(m, is_sentence_start=is_start))
        last_end = m.end()
    out_parts.append(cleaned[last_end:])

    result = "".join(out_parts)
    normalized = unicodedata.normalize("NFC", re.sub(r"\s+", " ", result).strip())
    if for_phonics_step and normalized.lower() in _PHONICS_SINGLE_CHAR_FIX:
        return _PHONICS_SINGLE_CHAR_FIX[normalized.lower()]
    return normalized


@dataclass(frozen=True, slots=True)
class NormalizedTokenMapping:
    """Explicit alignment between original surface page words and normalized TTS tokens."""

    source_words: tuple[str, ...]
    normalized_text: str
    normalized_tokens: tuple[str, ...]
    token_to_source_index: tuple[int, ...]
    source_to_token_span: tuple[tuple[int, int], ...]


def normalize_tokens_with_mapping(
    surface_words: Sequence[str],
    *,
    expand_ranges_and_codes: bool = True,
) -> NormalizedTokenMapping:
    """Normalize surface words while preserving an exact `source_word_index -> normalized_tokens` map."""
    source_list = [unicodedata.normalize("NFC", str(w or "")).strip() for w in surface_words]
    normalized_tokens: list[str] = []
    token_to_source: list[int] = []
    source_spans: list[tuple[int, int]] = []
    piece_texts: list[str] = []

    for idx, raw_word in enumerate(source_list):
        start_tok = len(normalized_tokens)
        if not raw_word:
            source_spans.append((start_tok, start_tok))
            continue
        norm_piece = normalize_vietnamese_tts_text(
            raw_word,
            expand_ranges_and_codes=expand_ranges_and_codes,
        )
        # Preserve sentence-start casing only at index 0 or after terminal punctuation.
        if idx > 0 and norm_piece and raw_word.isupper() and is_likely_vietnamese_syllable(raw_word):
            prev_text = piece_texts[-1].rstrip().rstrip(_TRAILING_CLOSERS) if piece_texts else ""
            if prev_text and prev_text[-1] not in ".!?:;\n":
                norm_piece = norm_piece.lower()
        piece_tokens = [
            tok for tok in _SPOKEN_TOKEN_RE.findall(norm_piece) if _ALPHA_CHARS_RE.search(tok)
        ]
        if piece_tokens:
            piece_texts.append(norm_piece)
            for tok in piece_tokens:
                normalized_tokens.append(tok)
                token_to_source.append(idx)
        source_spans.append((start_tok, len(normalized_tokens)))

    full_normalized = unicodedata.normalize("NFC", " ".join(piece_texts).strip())
    return NormalizedTokenMapping(
        source_words=tuple(source_list),
        normalized_text=full_normalized,
        normalized_tokens=tuple(normalized_tokens),
        token_to_source_index=tuple(token_to_source),
        source_to_token_span=tuple(source_spans),
    )


def _vietnamese_syllable_duration_weight(token: str) -> float:
    """Syllable-centered timing weight avoiding over-weighting long Vietnamese spelling."""
    alpha_len = len("".join(_ALPHA_CHARS_RE.findall(token)))
    base = 1.0 + 0.10 * min(max(alpha_len, 1), 7)
    stripped_closers = token.rstrip(_TRAILING_CLOSERS)
    if stripped_closers.endswith((".", "!", "?", "…")):
        base += 0.45
    elif stripped_closers.endswith((",", ";", ":")):
        base += 0.25
    return base


def project_chunk_spans_to_surface_words(
    surface_words: Sequence[str],
    chunk_spans: Sequence[tuple[str, float, float]],
    duration_seconds: float,
    *,
    expand_ranges_and_codes: bool = True,
) -> list[dict[str, Any]]:
    """Project chunk-level TTS spans back to original surface words preserving inter-chunk pauses.

    Even when normalizer expands 1 source token into multiple spoken words (e.g. `12/5/2026`,
    `25%`, `MTH-341`, `ba-lô`), every spoken token keeps its chunk timing and maps cleanly back
    to the originating surface word without discarding silence gaps between chunks.
    """
    if not surface_words:
        return []
    safe_dur = max(0.05, float(duration_seconds))
    mapping = normalize_tokens_with_mapping(
        surface_words,
        expand_ranges_and_codes=expand_ranges_and_codes,
    )
    norm_tokens = mapping.normalized_tokens
    n_norm = len(norm_tokens)

    # Extract spoken tokens per synthesized chunk to preserve exact chunk boundaries & pauses.
    valid_chunks: list[tuple[list[str], float, float]] = []
    for chunk_text, c_start, c_end in chunk_spans:
        c_tokens = [
            tok for tok in _SPOKEN_TOKEN_RE.findall(chunk_text or "") if _ALPHA_CHARS_RE.search(tok)
        ]
        s_clamped = max(0.0, min(safe_dur, float(c_start)))
        e_clamped = max(s_clamped, min(safe_dur, float(c_end)))
        valid_chunks.append((c_tokens, s_clamped, e_clamped))

    norm_timings: list[tuple[float, float]] = []
    if n_norm > 0 and valid_chunks:
        total_chunk_toks = sum(len(ct) for ct, _, _ in valid_chunks)
        if total_chunk_toks == n_norm:
            # Exact 1:1 token distribution across chunks — preserves every inter-chunk silence gap!
            tok_cursor = 0
            for c_tokens, c_start, c_end in valid_chunks:
                if not c_tokens:
                    continue
                slice_tokens = norm_tokens[tok_cursor : tok_cursor + len(c_tokens)]
                weights = [_vietnamese_syllable_duration_weight(t) for t in slice_tokens]
                w_sum = sum(weights) or float(len(slice_tokens))
                span = max(0.01, c_end - c_start)
                acc = c_start
                for w_val in weights:
                    w_dur = span * (w_val / w_sum)
                    t_start = max(0.0, min(safe_dur, acc))
                    t_end = max(t_start, min(safe_dur, acc + w_dur))
                    norm_timings.append((t_start, t_end))
                    acc += w_dur
                tok_cursor += len(c_tokens)
        else:
            # Partition normalized tokens proportionally across chunks by chunk token/duration share
            # so inter-chunk silence gaps are STILL preserved!
            chunk_weights = [
                float(len(ct)) if ct else max(0.05, c_end - c_start)
                for ct, c_start, c_end in valid_chunks
            ]
            total_cw = sum(chunk_weights) or 1.0
            assigned_counts: list[int] = []
            remaining = n_norm
            for idx, cw in enumerate(chunk_weights):
                if idx == len(chunk_weights) - 1:
                    cnt = remaining
                else:
                    raw_cnt = int(round(n_norm * (cw / total_cw)))
                    cnt = max(0, min(remaining, raw_cnt))
                assigned_counts.append(cnt)
                remaining -= cnt

            tok_cursor = 0
            for (_, c_start, c_end), cnt in zip(valid_chunks, assigned_counts):
                if cnt <= 0:
                    continue
                slice_tokens = norm_tokens[tok_cursor : tok_cursor + cnt]
                weights = [_vietnamese_syllable_duration_weight(t) for t in slice_tokens]
                w_sum = sum(weights) or float(cnt)
                span = max(0.01, c_end - c_start)
                acc = c_start
                for w_val in weights:
                    w_dur = span * (w_val / w_sum)
                    t_start = max(0.0, min(safe_dur, acc))
                    t_end = max(t_start, min(safe_dur, acc + w_dur))
                    norm_timings.append((t_start, t_end))
                    acc += w_dur
                tok_cursor += cnt

    # Fallback if text was pure punctuation or chunk_spans empty
    if len(norm_timings) != n_norm:
        active_start = valid_chunks[0][1] if valid_chunks else 0.0
        active_end = valid_chunks[-1][2] if valid_chunks else safe_dur
        weights = [_vietnamese_syllable_duration_weight(t) for t in norm_tokens]
        w_sum = sum(weights) or max(1.0, float(n_norm))
        span = max(0.01, active_end - active_start)
        norm_timings = []
        acc = active_start
        for w_val in weights:
            w_dur = span * (w_val / w_sum)
            t_start = max(0.0, min(safe_dur, acc))
            t_end = max(t_start, min(safe_dur, acc + w_dur))
            norm_timings.append((t_start, t_end))
            acc += w_dur

    timed_words: list[dict[str, Any]] = []
    prev_end = 0.0
    for idx, src_word in enumerate(mapping.source_words):
        t_lo, t_hi = mapping.source_to_token_span[idx]
        if t_hi > t_lo and t_hi <= len(norm_timings):
            raw_start = norm_timings[t_lo][0]
            raw_end = norm_timings[t_hi - 1][1]
            w_start = round(max(prev_end, min(safe_dur, raw_start)), 3)
            w_end = round(max(w_start, min(safe_dur, raw_end)), 3)
        else:
            # Punctuation-only source token gets zero-width non-overlapping timestamp
            w_start = round(min(safe_dur, prev_end), 3)
            w_end = w_start
        timed_words.append(
            {
                "word": src_word,
                "start": w_start,
                "end": w_end,
            }
        )
        prev_end = w_end

    return timed_words
