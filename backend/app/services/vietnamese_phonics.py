"""Canonical Vietnamese Grade-1 step-by-step phonics decomposition (SGK Tiếng Việt 1).

1:1 mirror of `frontend/lib/reading/phonics-lesson.ts` + `phonics-spelling.ts` so
precomputed phonics clips in `tts_audio_cache_entries` produce byte-identical
`canonical_phonics_key(steps)` SHA-256 hashes to live frontend requests.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

ONSETS: tuple[str, ...] = (
    "ngh",
    "ng",
    "nh",
    "ch",
    "gh",
    "gi",
    "kh",
    "ph",
    "qu",
    "th",
    "tr",
    "b",
    "c",
    "d",
    "đ",
    "g",
    "h",
    "k",
    "l",
    "m",
    "n",
    "p",
    "q",
    "r",
    "s",
    "t",
    "v",
    "x",
)

CODAS: tuple[str, ...] = ("ch", "ng", "nh", "c", "m", "n", "p", "t")

ONSET_SPOKEN: dict[str, str] = {
    "b": "bờ",
    "c": "cờ",
    "k": "ca",
    "d": "dờ",
    "đ": "đờ",
    "g": "gờ",
    "gh": "gờ",
    "gi": "gi",
    "h": "hờ",
    "l": "lờ",
    "m": "mờ",
    "n": "nờ",
    "p": "pờ",
    "ph": "phờ",
    "q": "quờ",
    "qu": "quờ",
    "r": "rờ",
    "s": "sờ",
    "t": "tờ",
    "th": "thờ",
    "tr": "trờ",
    "v": "vờ",
    "x": "xờ",
    "ch": "chờ",
    "kh": "khờ",
    "ng": "ngờ",
    "ngh": "ngờ",
    "nh": "nhờ",
}

CODA_SPOKEN: dict[str, str] = {
    "c": "cờ",
    "ch": "chờ",
    "m": "mờ",
    "n": "nờ",
    "ng": "ngờ",
    "nh": "nhờ",
    "p": "pờ",
    "t": "tờ",
}

VOWEL_LETTER_SPOKEN: dict[str, str] = {
    "a": "a",
    "ă": "á",
    "â": "ớ",
    "e": "e",
    "ê": "ê",
    "i": "i",
    "y": "y",
    "o": "o",
    "ô": "ô",
    "ơ": "ơ",
    "u": "u",
    "ư": "ư",
}

TONE_SPOKEN: dict[str, str | None] = {
    "ngang": None,
    "sac": "sắc",
    "huyen": "huyền",
    "hoi": "hỏi",
    "nga": "ngã",
    "nang": "nặng",
}

TONE_CHAR_MAP: dict[str, tuple[str, str]] = {
    "á": ("a", "sac"),
    "à": ("a", "huyen"),
    "ả": ("a", "hoi"),
    "ã": ("a", "nga"),
    "ạ": ("a", "nang"),
    "ắ": ("ă", "sac"),
    "ằ": ("ă", "huyen"),
    "ẳ": ("ă", "hoi"),
    "ẵ": ("ă", "nga"),
    "ặ": ("ă", "nang"),
    "ấ": ("â", "sac"),
    "ầ": ("â", "huyen"),
    "ẩ": ("â", "hoi"),
    "ẫ": ("â", "nga"),
    "ậ": ("â", "nang"),
    "é": ("e", "sac"),
    "è": ("e", "huyen"),
    "ẻ": ("e", "hoi"),
    "ẽ": ("e", "nga"),
    "ẹ": ("e", "nang"),
    "ế": ("ê", "sac"),
    "ề": ("ê", "huyen"),
    "ể": ("ê", "hoi"),
    "ễ": ("ê", "nga"),
    "ệ": ("ê", "nang"),
    "í": ("i", "sac"),
    "ì": ("i", "huyen"),
    "ỉ": ("i", "hoi"),
    "ĩ": ("i", "nga"),
    "ị": ("i", "nang"),
    "ó": ("o", "sac"),
    "ò": ("o", "huyen"),
    "ỏ": ("o", "hoi"),
    "õ": ("o", "nga"),
    "ọ": ("o", "nang"),
    "ố": ("ô", "sac"),
    "ồ": ("ô", "huyen"),
    "ổ": ("ô", "hoi"),
    "ỗ": ("ô", "nga"),
    "ộ": ("ô", "nang"),
    "ớ": ("ơ", "sac"),
    "ờ": ("ơ", "huyen"),
    "ở": ("ơ", "hoi"),
    "ỡ": ("ơ", "nga"),
    "ợ": ("ơ", "nang"),
    "ú": ("u", "sac"),
    "ù": ("u", "huyen"),
    "ủ": ("u", "hoi"),
    "ũ": ("u", "nga"),
    "ụ": ("u", "nang"),
    "ứ": ("ư", "sac"),
    "ừ": ("ư", "huyen"),
    "ử": ("ư", "hoi"),
    "ữ": ("ư", "nga"),
    "ự": ("ư", "nang"),
    "ý": ("y", "sac"),
    "ỳ": ("y", "huyen"),
    "ỷ": ("y", "hoi"),
    "ỹ": ("y", "nga"),
    "ỵ": ("y", "nang"),
}

SAC_VOWEL_MAP: dict[str, str] = {
    "a": "á",
    "ă": "ắ",
    "â": "ấ",
    "e": "é",
    "ê": "ế",
    "i": "í",
    "o": "ó",
    "ô": "ố",
    "ơ": "ớ",
    "u": "ú",
    "ư": "ứ",
    "y": "ý",
}

VALID_VIETNAMESE_UNTONED_RHYMES: frozenset[str] = frozenset(
    {
        # Single vowels
        "a", "e", "ê", "i", "o", "ô", "ơ", "u", "ư", "y",
        # Diphthongs & open rhymes
        "ai", "ao", "au", "ay", "âu", "ây", "eo", "êu", "ia", "iu",
        "oa", "oe", "oi", "ôi", "ơi", "ua", "ưa", "uê", "uơ", "ui",
        "ưi", "ưu", "uy", "uya", "uyu", "uôi", "ươi", "oai", "oao",
        "oay", "oeo", "uây", "iêu", "yêu", "ươu",
        # -m / -n / -ng / -nh rhymes
        "am", "ăm", "âm", "em", "êm", "im", "om", "ôm", "ơm", "um", "ưm",
        "iêm", "yêm", "uôm", "ươm", "oam", "oăm", "uâm", "uêm", "uym",
        "an", "ăn", "ân", "en", "ên", "in", "on", "ôn", "ơn", "un", "ưn",
        "oan", "oăn", "oen", "uan", "uân", "uyên", "uyn", "iên", "yên", "uôn", "ươn",
        "ang", "ăng", "âng", "eng", "ong", "ông", "ung", "ưng",
        "oang", "oăng", "oong", "oeng", "uang", "uâng", "iêng", "yêng", "uông", "ương",
        "anh", "ênh", "inh", "oanh", "uênh", "uynh",
        # Checked codas (-c / -ch / -p / -t)
        "ac", "ăc", "âc", "ec", "êc", "oc", "ôc", "uc", "ưc",
        "oac", "oăc", "oec", "ooc", "uâc", "uêc", "uôc", "iêc", "yêc", "ươc",
        "ach", "êch", "ich", "oach", "uêch", "uych",
        "ap", "ăp", "âp", "ep", "êp", "ip", "op", "ôp", "ơp", "up", "ưp",
        "oap", "oăp", "oep", "uâp", "uôp", "uyp", "iêp", "yêp", "ươp",
        "at", "ăt", "ât", "et", "êt", "it", "ot", "ôt", "ơt", "ut", "ưt",
        "oat", "oăt", "oet", "uat", "uât", "uêt", "uyt", "uyêt", "iêt", "yêt", "uôt", "ươt",
    }
)

_FOREIGN_LETTERS_RE = re.compile(r"[fjwzFJWZ]")
_DIGIT_RE = re.compile(r"\d")


@dataclass(frozen=True, slots=True)
class VietnameseSyllableParts:
    normalized: str
    onset: str
    rhyme: str
    untoned_syllable: str
    tone: str


def normalize_vietnamese_word(value: str) -> str:
    """Mirror `frontend/lib/reading/vietnamese-text.ts#normalizeVietnameseWord`."""
    text = unicodedata.normalize("NFC", str(value or "")).lower().strip()
    start = 0
    end = len(text)
    while start < end and unicodedata.category(text[start])[0] in {"P", "S"}:
        start += 1
    while end > start and unicodedata.category(text[end - 1])[0] in {"P", "S"}:
        end -= 1
    return unicodedata.normalize("NFC", text[start:end].strip())


def _strip_outer_non_alnum(raw: str) -> str:
    text = unicodedata.normalize("NFC", str(raw or "")).strip()
    start = 0
    end = len(text)
    while start < end and unicodedata.category(text[start])[0] not in {"L", "N"}:
        start += 1
    while end > start and unicodedata.category(text[end - 1])[0] not in {"L", "N"}:
        end -= 1
    return text[start:end]


def _extract_syllable_slices(clean_phrase: str) -> list[tuple[str, str]]:
    r"""Mirror `locateSyllableSlices` (`/[\p{L}\p{N}]+/gu`)."""
    out: list[tuple[str, str]] = []
    cur: list[str] = []
    for ch in clean_phrase:
        if unicodedata.category(ch)[0] in {"L", "N"}:
            cur.append(ch)
        elif cur:
            surface = unicodedata.normalize("NFC", "".join(cur))
            out.append((surface, normalize_vietnamese_word(surface)))
            cur = []
    if cur:
        surface = unicodedata.normalize("NFC", "".join(cur))
        out.append((surface, normalize_vietnamese_word(surface)))
    return out


def split_vietnamese_rhyme(rhyme: str) -> tuple[str, str]:
    for candidate in CODAS:
        if len(rhyme) > len(candidate) and rhyme.endswith(candidate):
            return rhyme[: -len(candidate)], candidate
    return rhyme, ""


def decompose_vietnamese_syllable(word: str) -> VietnameseSyllableParts | None:
    normalized = normalize_vietnamese_word(word)
    if not normalized or normalized.isdigit():
        return None
    tone = "ngang"
    untoned_chars: list[str] = []
    for ch in normalized:
        mapped = TONE_CHAR_MAP.get(ch)
        if mapped is not None:
            untoned_chars.append(mapped[0])
            tone = mapped[1]
        else:
            untoned_chars.append(ch)
    untoned = "".join(untoned_chars)

    onset = ""
    rhyme = untoned
    if untoned == "gi":
        onset = "gi"
        rhyme = "i"
    else:
        for candidate in ONSETS:
            if untoned.startswith(candidate) and len(untoned) > len(candidate):
                onset = candidate
                rhyme = untoned[len(candidate) :]
                break

    return VietnameseSyllableParts(
        normalized=normalized,
        onset=onset,
        rhyme=rhyme,
        untoned_syllable=untoned,
        tone=tone,
    )


def _resolve_underlying_rhyme(onset: str, rhyme: str) -> str:
    if onset == "gi" and rhyme in {"êng", "êt", "êc", "êu", "êm", "ên"}:
        return f"i{rhyme}"
    if onset == "qu" and rhyme in {"ynh", "yt", "ych"}:
        return f"u{rhyme}"
    return rhyme


def _is_orthographically_valid(onset: str, untoned_rhyme: str, coda: str, tone: str) -> bool:
    canonical_rhyme = _resolve_underlying_rhyme(onset, untoned_rhyme)
    if canonical_rhyme not in VALID_VIETNAMESE_UNTONED_RHYMES:
        return False
    if coda in {"c", "ch", "p", "t"} and tone not in {"sac", "nang"}:
        return False
    first_vowel = canonical_rhyme[0] if canonical_rhyme else ""
    if onset in {"gh", "ngh"} and first_vowel not in {"e", "ê", "i"}:
        return False
    if onset == "q":
        return False
    return True


def _apply_sac_for_checked_rhyme(untoned_rhyme: str, coda: str) -> str:
    nucleus = untoned_rhyme[: -len(coda)] if coda else untoned_rhyme
    target_idx = 0
    for idx, ch in enumerate(nucleus):
        if ch in "ăâêôơư":
            target_idx = idx
            break
    if (
        len(nucleus) >= 2
        and nucleus[target_idx] not in "ăâêôơư"
        and (
            nucleus.startswith("oa")
            or nucleus.startswith("oe")
            or nucleus.startswith("uy")
        )
    ):
        target_idx = 1
    ch = nucleus[target_idx]
    toned = SAC_VOWEL_MAP.get(ch, ch)
    return unicodedata.normalize(
        "NFC", nucleus[:target_idx] + toned + nucleus[target_idx + 1 :] + coda
    )


def _pick_focus_index(syllables: list[tuple[str, str]]) -> int:
    if len(syllables) == 1:
        return 0
    best_idx = len(syllables) - 1
    best_score = -1.0
    for idx, (_surface, norm) in enumerate(syllables):
        parts = decompose_vietnamese_syllable(norm)
        score = (
            len(parts.rhyme) * 2 + (1 if parts.tone != "ngang" else 0) + idx * 0.5
            if parts is not None
            else 0.0
        )
        if score >= best_score:
            best_score = score
            best_idx = idx
    return best_idx


def build_vietnamese_phonics_steps(raw_input: str) -> list[dict[str, Any]]:
    """Build exact SGK phonics TTS steps matching `frontend/lib/reading/phonics-lesson.ts`."""
    raw_nfc = unicodedata.normalize("NFC", str(raw_input or ""))
    clean_phrase = _strip_outer_non_alnum(raw_nfc)
    if not clean_phrase or _DIGIT_RE.search(clean_phrase):
        return []

    slices = _extract_syllable_slices(clean_phrase)
    if not slices:
        return []

    # Reject all-uppercase acronyms >= 2 chars (e.g. "SGK", "UBND", "TV")
    for surface, _norm in slices:
        if len(surface) >= 2 and surface == surface.upper() and surface != surface.lower():
            return []

    decomposed: list[VietnameseSyllableParts] = []
    for surface, norm in slices:
        if _FOREIGN_LETTERS_RE.search(surface):
            return []
        parts = decompose_vietnamese_syllable(norm)
        if parts is None:
            return []
        _nuc, coda = split_vietnamese_rhyme(parts.rhyme)
        if not _is_orthographically_valid(parts.onset, parts.rhyme, coda, parts.tone):
            return []
        decomposed.append(parts)

    focus_idx = _pick_focus_index(slices)
    parts = decomposed[focus_idx]
    canonical_rhyme = _resolve_underlying_rhyme(parts.onset, parts.rhyme)
    nucleus, coda = split_vietnamese_rhyme(canonical_rhyme)
    is_checked_coda = coda in {"c", "ch", "p", "t"}
    spoken_rhyme = (
        _apply_sac_for_checked_rhyme(canonical_rhyme, coda)
        if is_checked_coda
        else canonical_rhyme
    )
    focus_syllable = parts.normalized
    onset_spoken = ONSET_SPOKEN.get(parts.onset, parts.onset) if parts.onset else None
    tone_spoken = TONE_SPOKEN.get(parts.tone)

    steps: list[dict[str, Any]] = []

    # Step A: Build compound rhyme (2+ chars, e.g. "ô, tờ, ốt.")
    if len(canonical_rhyme) >= 2:
        spoken_letters = [VOWEL_LETTER_SPOKEN.get(ch, ch) for ch in nucleus]
        if coda:
            spoken_letters.append(CODA_SPOKEN.get(coda, coda))
        steps.append(
            {
                "id": "rhyme_build",
                "spoken_text": unicodedata.normalize(
                    "NFC", f"{', '.join(spoken_letters)}, {spoken_rhyme}."
                ),
                "pause_after_ms": 420,
            }
        )

    # Step B: Blend onset + rhyme
    if onset_spoken:
        if len(canonical_rhyme) >= 2:
            if parts.tone == "ngang":
                spoken = f"{onset_spoken}, {spoken_rhyme}, {focus_syllable}."
            else:
                spoken = f"{onset_spoken}, {spoken_rhyme}."
        else:
            vowel_spoken = VOWEL_LETTER_SPOKEN.get(canonical_rhyme, canonical_rhyme)
            spoken = f"{onset_spoken}, {vowel_spoken}, {parts.untoned_syllable}."
        steps.append(
            {
                "id": "onset_blend",
                "spoken_text": unicodedata.normalize("NFC", spoken),
                "pause_after_ms": 420,
            }
        )

    # Step C: Apply Vietnamese tone mark
    if tone_spoken:
        if not onset_spoken and len(canonical_rhyme) == 1:
            base_vowel = VOWEL_LETTER_SPOKEN.get(canonical_rhyme, canonical_rhyme)
            spoken = f"{base_vowel}, {tone_spoken}, {focus_syllable}."
        else:
            spoken = f"{tone_spoken}, {focus_syllable}."
        steps.append(
            {
                "id": "tone_blend",
                "spoken_text": unicodedata.normalize("NFC", spoken),
                "pause_after_ms": 450,
            }
        )

    # Step D: Clear whole toned syllable confirmation
    steps.append(
        {
            "id": "whole_syllable",
            "spoken_text": unicodedata.normalize("NFC", f"{focus_syllable}."),
            "pause_after_ms": 450 if len(slices) > 1 else 320,
        }
    )

    # Step E: Multi-syllable context phrase blend
    if len(slices) > 1:
        normalized_phrase = " ".join(norm for _surface, norm in slices)
        steps.append(
            {
                "id": "context_phrase",
                "spoken_text": unicodedata.normalize("NFC", f"{normalized_phrase}."),
                "pause_after_ms": 320,
            }
        )

    return steps
