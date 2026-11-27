"""AI-assisted Grade-1 Vietnamese phonics analyzer for words outside static rules.

Provides a fast, bounded-cache, strictly validated fallback when the deterministic
frontend rule engine encounters an uncommon Vietnamese word, regional word,
proper name, or loanword that still benefits from step-by-step Grade-1 spelling.
"""

from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
from collections import OrderedDict
from typing import Any

import httpx

from app.schemas.voice import (
    PhonicsAnalyzeOnsetRead,
    PhonicsAnalyzeResponse,
    PhonicsAnalyzeRhymeRead,
    PhonicsAnalyzeStepRead,
    PhonicsAnalyzeToneRead,
)

logger = logging.getLogger("viread.phonics_ai")

_GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
_GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
_DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
_DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"
_CACHE_MAX_ENTRIES = 512

_VALID_TONE_KEYS = {"ngang", "sac", "huyen", "hoi", "nga", "nang"}
_VALID_STEP_KINDS = {
    "rhyme_build",
    "onset_blend",
    "tone_blend",
    "whole_syllable",
    "context_phrase",
}
_VALID_HIGHLIGHT_PARTS = {
    "rhyme",
    "onset_and_rhyme",
    "tone_and_syllable",
    "whole_syllable",
    "context",
}
_TONE_LABELS: dict[str, tuple[str, str | None]] = {
    "ngang": ("thanh ngang", None),
    "sac": ("dấu sắc", "sắc"),
    "huyen": ("dấu huyền", "huyền"),
    "hoi": ("dấu hỏi", "hỏi"),
    "nga": ("dấu ngã", "ngã"),
    "nang": ("dấu nặng", "nặng"),
}

_SPOKEN_UNSAFE_SYMBOLS_RE = re.compile(r"[→+\-/*=<>{}\[\]|\\~^_`#@$%&]+")
_OUTER_PUNCT_RE = re.compile(r"^[^\w]+|[^\w]+$", re.UNICODE)
_HAS_LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)
_HAS_DIGIT_RE = re.compile(r"\d")

_SYSTEM_PROMPT = """Bạn là giáo viên Tiếng Việt lớp 1 theo chương trình SGK chuẩn Việt Nam.
Nhiệm vụ: Phân tích 1 từ hoặc tiếng tiếng Việt (hoặc từ phiên âm/tên riêng đọc được bằng tiếng Việt) thành các bước ĐÁNH VẦN LỚP 1 thật chuẩn, ngắn gọn, dễ nghe cho bé 6-8 tuổi.

QUY TẮC BẮT BUỘC:
1. Chỉ trả về JSON hợp lệ theo schema yêu cầu, KHÔNG thêm markdown hay giải thích ngoài JSON.
2. Nếu là số thuần, ký hiệu vô nghĩa, chữ viết tắt không đọc thành tiếng (ví dụ: "21", "SGK", "UBND", "xyz123"), trả về {"supported": false}.
3. Với từ tiếng Việt hợp lệ (kể cả chữ IN HOA như "TRƯỜNG", "HỌC", từ địa phương, từ hiếm, tên riêng tiếng Việt, hoặc từ mượn đọc được theo âm tiết tiếng Việt), trả về {"supported": true} với 2 đến 5 bước theo trình tự SGK lớp 1:
   - Bước 1 (rhyme_build, nếu vần có từ 2 chữ cái trở lên): đánh vần vần, ví dụ display_text "ư · ơ · ngờ → ương", spoken_text "ư, ơ, ngờ, ương."
   - Bước 2 (onset_blend, nếu có âm đầu): ghép âm đầu với vần, ví dụ display_text "trờ + ương", spoken_text "trờ, ương." (nếu thanh ngang thì ghép thẳng tiếng, ví dụ "trờ, ương, trương.")
   - Bước 3 (tone_blend, nếu có dấu thanh khác ngang): thêm dấu thanh, ví dụ display_text "huyền → trường", spoken_text "huyền, trường."
   - Bước 4 (whole_syllable): đọc trơn cả tiếng, ví dụ display_text "trường", spoken_text "trường."
4. QUAN TRỌNG cho spoken_text (sẽ đọc bằng TTS):
   - KHÔNG BAO GIỜ chứa ký tự mũi tên "→", dấu "+", dấu "-", gạch chéo "/", hay ký hiệu kỹ thuật.
   - Đọc tên chữ cái phụ âm theo chuẩn lớp 1: b -> bờ, c -> cờ, ch -> chờ, d -> dờ, đ -> đờ, g -> gờ, gh -> gờ, gi -> di, h -> hờ, k -> ca, kh -> khờ, l -> lờ, m -> mờ, n -> nờ, ng -> ngờ, ngh -> ngờ, nh -> nhờ, p -> pờ, ph -> phờ, qu -> quờ, r -> rờ, s -> sờ, t -> tờ, th -> thờ, tr -> trờ, v -> vờ, x -> xờ.
   - Dùng dấu phẩy "," để ngắt nhịp nhẹ giữa các âm, kết thúc bằng dấu chấm ".".
"""

_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "supported": {"type": "boolean"},
        "focus_syllable": {"type": "string"},
        "onset_written": {"type": "string"},
        "onset_spoken": {"type": "string"},
        "rhyme_written": {"type": "string"},
        "rhyme_untoned": {"type": "string"},
        "rhyme_nucleus": {"type": "string"},
        "rhyme_coda": {"type": "string"},
        "rhyme_spoken": {"type": "string"},
        "tone_key": {
            "type": "string",
            "enum": ["ngang", "sac", "huyen", "hoi", "nga", "nang"],
        },
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "kind": {
                        "type": "string",
                        "enum": [
                            "rhyme_build",
                            "onset_blend",
                            "tone_blend",
                            "whole_syllable",
                            "context_phrase",
                        ],
                    },
                    "display_text": {"type": "string"},
                    "spoken_text": {"type": "string"},
                    "highlight_part": {
                        "type": "string",
                        "enum": [
                            "rhyme",
                            "onset_and_rhyme",
                            "tone_and_syllable",
                            "whole_syllable",
                            "context",
                        ],
                    },
                    "pause_after_ms": {"type": "integer"},
                },
                "required": ["kind", "display_text", "spoken_text", "highlight_part"],
            },
        },
    },
    "required": ["supported"],
}

_cache: OrderedDict[tuple[str, str], PhonicsAnalyzeResponse] = OrderedDict()


def clear_phonics_ai_cache() -> None:
    """Clear in-memory AI phonics analysis cache (used by tests)."""
    _cache.clear()


def _sanitize_spoken_text(raw: str) -> str:
    cleaned = unicodedata.normalize("NFC", raw or "").strip()
    cleaned = _SPOKEN_UNSAFE_SYMBOLS_RE.sub(", ", cleaned)
    cleaned = re.sub(r"\s*,\s*,+\s*", ", ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,")
    if cleaned and not cleaned.endswith((".", "!", "?")):
        cleaned = f"{cleaned}."
    return cleaned[:220]


def _clean_phrase(raw: str) -> str:
    nfc = unicodedata.normalize("NFC", raw or "").strip()
    return _OUTER_PUNCT_RE.sub("", nfc).strip()


def _unsupported_response(raw_text: str, clean: str, *, can_play: bool = True) -> PhonicsAnalyzeResponse:
    return PhonicsAnalyzeResponse(
        supported=False,
        source="none",
        raw_text=raw_text,
        clean_phrase=clean,
        message="Chưa có mẫu đánh vần",
        can_play_whole_word=can_play and bool(clean),
    )


def _decode_json_text(text: str) -> dict[str, Any] | None:
    cleaned = (text or "").strip()
    if not cleaned:
        return None
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        parsed = json.loads(cleaned)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _validate_ai_payload(
    raw_payload: dict[str, Any],
    *,
    raw_text: str,
    clean_phrase: str,
) -> PhonicsAnalyzeResponse | None:
    if not bool(raw_payload.get("supported")):
        return _unsupported_response(raw_text, clean_phrase)

    syllables = [tok for tok in re.findall(r"[^\W\d_]+", clean_phrase, re.UNICODE) if tok]
    if not syllables:
        return _unsupported_response(raw_text, clean_phrase, can_play=False)

    focus_raw = unicodedata.normalize(
        "NFC", str(raw_payload.get("focus_syllable") or syllables[-1])
    ).strip().lower()
    if not focus_raw or not _HAS_LETTER_RE.search(focus_raw):
        focus_raw = syllables[-1].lower()

    focus_idx = len(syllables) - 1
    for i, syl in enumerate(syllables):
        if syl.lower() == focus_raw:
            focus_idx = i
            break

    focus_surface = syllables[focus_idx]
    lower_clean = clean_phrase.lower()
    range_start = lower_clean.find(focus_surface.lower())
    if range_start < 0:
        range_start = 0
    range_end = min(len(clean_phrase), range_start + len(focus_surface))

    tone_key = str(raw_payload.get("tone_key") or "ngang").strip().lower()
    if tone_key not in _VALID_TONE_KEYS:
        tone_key = "ngang"
    tone_label, tone_spoken = _TONE_LABELS[tone_key]

    onset_written = unicodedata.normalize(
        "NFC", str(raw_payload.get("onset_written") or "")
    ).strip().lower()
    onset_spoken = unicodedata.normalize(
        "NFC", str(raw_payload.get("onset_spoken") or onset_written)
    ).strip().lower()
    onset = (
        PhonicsAnalyzeOnsetRead(written=onset_written, spoken=onset_spoken or onset_written)
        if onset_written
        else None
    )

    rhyme_written = unicodedata.normalize(
        "NFC", str(raw_payload.get("rhyme_written") or "")
    ).strip().lower()
    if not rhyme_written:
        rhyme_written = (
            focus_raw[len(onset_written):]
            if onset_written and focus_raw.startswith(onset_written) and len(focus_raw) > len(onset_written)
            else focus_raw
        )
    rhyme_untoned = (
        unicodedata.normalize("NFC", str(raw_payload.get("rhyme_untoned") or rhyme_written))
        .strip()
        .lower()
        or rhyme_written
    )
    rhyme_nucleus = (
        unicodedata.normalize("NFC", str(raw_payload.get("rhyme_nucleus") or rhyme_untoned))
        .strip()
        .lower()
        or rhyme_untoned
    )
    rhyme_coda = unicodedata.normalize(
        "NFC", str(raw_payload.get("rhyme_coda") or "")
    ).strip().lower()
    rhyme_spoken = (
        unicodedata.normalize("NFC", str(raw_payload.get("rhyme_spoken") or rhyme_written))
        .strip()
        .lower()
        or rhyme_written
    )

    raw_steps = raw_payload.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        return None

    onset_len = len(onset_written) if onset_written and len(onset_written) < len(focus_raw) else 0
    validated_steps: list[PhonicsAnalyzeStepRead] = []
    for idx, item in enumerate(raw_steps[:6]):
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip()
        if kind not in _VALID_STEP_KINDS:
            continue
        display_text = unicodedata.normalize(
            "NFC", str(item.get("display_text") or "")
        ).strip()[:120]
        spoken_text = _sanitize_spoken_text(str(item.get("spoken_text") or ""))
        if not display_text or not spoken_text:
            continue
        highlight_part = str(item.get("highlight_part") or "").strip()
        if highlight_part not in _VALID_HIGHLIGHT_PARTS:
            highlight_part = (
                "rhyme"
                if kind == "rhyme_build"
                else "onset_and_rhyme"
                if kind == "onset_blend"
                else "tone_and_syllable"
                if kind == "tone_blend"
                else "context"
                if kind == "context_phrase"
                else "whole_syllable"
            )
        raw_pause = item.get("pause_after_ms", 420)
        try:
            pause_ms = max(150, min(1500, int(raw_pause)))
        except (TypeError, ValueError):
            pause_ms = 420

        if kind == "rhyme_build":
            h_start, h_end = onset_len, len(focus_raw)
        elif kind == "context_phrase":
            h_start, h_end = 0, len(clean_phrase)
        else:
            h_start, h_end = 0, len(focus_raw)

        raw_id = re.sub(r"[^A-Za-z0-9_-]", "", str(item.get("id") or f"{kind}_{idx}"))[:60]
        step_id = raw_id or f"{kind}_{idx}"
        validated_steps.append(
            PhonicsAnalyzeStepRead(
                id=step_id,
                index=len(validated_steps),
                kind=kind,  # type: ignore[arg-type]
                display_text=display_text,
                spoken_text=spoken_text,
                highlight_part=highlight_part,  # type: ignore[arg-type]
                highlight_start=max(0, h_start),
                highlight_end=max(max(0, h_start), h_end),
                pause_after_ms=pause_ms,
            )
        )

    if len(validated_steps) < 2:
        return None

    # Ensure final whole_syllable step exists so child always hears the blended word
    if not any(s.kind == "whole_syllable" for s in validated_steps):
        validated_steps.append(
            PhonicsAnalyzeStepRead(
                id="whole_syllable",
                index=len(validated_steps),
                kind="whole_syllable",
                display_text=focus_raw,
                spoken_text=f"{focus_raw}.",
                highlight_part="whole_syllable",
                highlight_start=0,
                highlight_end=len(focus_raw),
                pause_after_ms=480,
            )
        )

    return PhonicsAnalyzeResponse(
        supported=True,
        source="ai",
        raw_text=raw_text,
        clean_phrase=clean_phrase,
        syllables=syllables,
        focus_syllable_index=focus_idx,
        focus_syllable=focus_raw,
        focus_range_start=range_start,
        focus_range_end=range_end,
        onset=onset,
        rhyme=PhonicsAnalyzeRhymeRead(
            written=rhyme_written,
            untoned=rhyme_untoned,
            nucleus=rhyme_nucleus,
            coda=rhyme_coda,
            spoken=rhyme_spoken,
        ),
        tone=PhonicsAnalyzeToneRead(
            key=tone_key,  # type: ignore[arg-type]
            label=tone_label,
            spoken=tone_spoken,
        ),
        steps=validated_steps,
        message="",
        can_play_whole_word=True,
    )


async def _call_gemini_phonics(
    *,
    clean_phrase: str,
    context_phrase: str | None,
    api_key: str,
    model: str,
    timeout_seconds: float,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any] | None:
    prompt_lines = [f'Từ cần phân tích đánh vần lớp 1: "{clean_phrase}"']
    if context_phrase:
        prompt_lines.append(f'Ngữ cảnh câu chứa từ: "{context_phrase}"')
    prompt_lines.append("Hãy trả về JSON đúng schema quy định.")

    payload = {
        "systemInstruction": {"parts": [{"text": _SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": "\n".join(prompt_lines)}]}],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
            "responseJsonSchema": _RESPONSE_SCHEMA,
        },
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            trust_env=False,
            follow_redirects=False,
            transport=transport,
        ) as client:
            response = await client.post(
                f"{_GEMINI_API_BASE}/models/{model}:generateContent",
                headers={"x-goog-api-key": api_key},
                json=payload,
            )
    except (httpx.TimeoutException, httpx.RequestError):
        return None
    if response.status_code != 200:
        return None
    try:
        data = response.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    return _decode_json_text(text)


async def _call_groq_phonics(
    *,
    clean_phrase: str,
    context_phrase: str | None,
    api_key: str,
    model: str,
    timeout_seconds: float,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any] | None:
    schema_hint = json.dumps(_RESPONSE_SCHEMA, ensure_ascii=False)
    prompt_lines = [f'Từ cần phân tích đánh vần lớp 1: "{clean_phrase}"']
    if context_phrase:
        prompt_lines.append(f'Ngữ cảnh câu chứa từ: "{context_phrase}"')
    payload = {
        "model": model,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": f"{_SYSTEM_PROMPT}\n\nJSON schema phải tuân theo:\n{schema_hint}",
            },
            {"role": "user", "content": "\n".join(prompt_lines)},
        ],
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            trust_env=False,
            follow_redirects=False,
            transport=transport,
        ) as client:
            response = await client.post(
                _GROQ_CHAT_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
    except (httpx.TimeoutException, httpx.RequestError):
        return None
    if response.status_code != 200:
        return None
    try:
        data = response.json()
        text = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    return _decode_json_text(text)


async def analyze_phonics_with_ai(
    text: str,
    *,
    context_phrase: str | None = None,
    timeout_seconds: float = 6.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> PhonicsAnalyzeResponse:
    """Analyze a word/phrase using AI to produce validated Grade-1 Vietnamese phonics."""
    raw_nfc = unicodedata.normalize("NFC", text or "").strip()
    clean = _clean_phrase(raw_nfc)
    if not clean or not _HAS_LETTER_RE.search(clean):
        return _unsupported_response(raw_nfc, clean, can_play=bool(clean))
    if _HAS_DIGIT_RE.search(clean):
        return _unsupported_response(raw_nfc, clean, can_play=True)

    ctx_clean = unicodedata.normalize("NFC", context_phrase or "").strip()[:160] or None
    cache_key = (clean.lower(), (ctx_clean or "").lower())
    cached = _cache.get(cache_key)
    if cached is not None:
        _cache.move_to_end(cache_key)
        return cached

    gemini_key = (os.getenv("GEMINI_API_KEY") or "").strip()
    gemini_model = (
        os.getenv("GEMINI_PHONICS_MODEL")
        or os.getenv("GEMINI_MODEL")
        or _DEFAULT_GEMINI_MODEL
    ).strip()
    groq_key = (os.getenv("GROQ_API_KEY") or "").strip()
    groq_model = (os.getenv("GROQ_PHONICS_MODEL") or _DEFAULT_GROQ_MODEL).strip()

    raw_ai: dict[str, Any] | None = None
    if gemini_key:
        raw_ai = await _call_gemini_phonics(
            clean_phrase=clean,
            context_phrase=ctx_clean,
            api_key=gemini_key,
            model=gemini_model,
            timeout_seconds=timeout_seconds,
            transport=transport,
        )
    if raw_ai is None and groq_key:
        raw_ai = await _call_groq_phonics(
            clean_phrase=clean,
            context_phrase=ctx_clean,
            api_key=groq_key,
            model=groq_model,
            timeout_seconds=timeout_seconds,
            transport=transport,
        )

    if raw_ai is None:
        return _unsupported_response(raw_nfc, clean, can_play=True)

    validated = _validate_ai_payload(raw_ai, raw_text=raw_nfc, clean_phrase=clean)
    if validated is None:
        return _unsupported_response(raw_nfc, clean, can_play=True)

    _cache[cache_key] = validated
    _cache.move_to_end(cache_key)
    while len(_cache) > _CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)
    logger.info(
        "phonics_ai_analyzed supported=%s steps=%d",
        validated.supported,
        len(validated.steps),
    )
    return validated
