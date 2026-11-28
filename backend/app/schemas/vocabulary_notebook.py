"""Pydantic schemas for Feature #6: Contextual Kids Glossary & Vocabulary Notebook."""

from __future__ import annotations

from datetime import datetime
import re
from typing import Literal
import unicodedata
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

GradeBand = Literal["GRADE_1_2", "GRADE_3_5"]
NotebookVisibility = Literal["PARENT_PRIVATE"]

_OUTER_PUNCT_RE = re.compile(r"^[^\w]+|[^\w]+$", re.UNICODE)
_HAS_LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)
_HAS_DIGIT_RE = re.compile(r"\d")
_CONTROL_OR_TAG_RE = re.compile(r"[<>{}\[\]\\|`~^#$%&*=+]+")


def normalize_glossary_word(raw: str) -> tuple[str, str]:
    """Normalize a tapped Vietnamese word or multi-syllable lexical phrase.

    Returns `(display_word, normalized_word)` in Unicode NFC.
    Raises `ValueError("INVALID_GLOSSARY_WORD")` when empty, numeric, or malformed.
    """
    nfc = unicodedata.normalize("NFC", raw or "")
    nfc = "".join(ch for ch in nfc if unicodedata.category(ch) != "Cf")
    cleaned = _OUTER_PUNCT_RE.sub("", nfc.strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned or len(cleaned) > 80:
        raise ValueError("INVALID_GLOSSARY_WORD")
    if _HAS_DIGIT_RE.search(cleaned) or _CONTROL_OR_TAG_RE.search(cleaned):
        raise ValueError("INVALID_GLOSSARY_WORD")
    if not _HAS_LETTER_RE.search(cleaned):
        raise ValueError("INVALID_GLOSSARY_WORD")
    tokens = cleaned.split(" ")
    if len(tokens) > 6:
        raise ValueError("INVALID_GLOSSARY_WORD")
    normalized = cleaned.casefold()
    return cleaned, normalized


def build_spoken_glossary_tts(
    word: str,
    definition_vi: str,
    example_sentence_vi: str,
    nuance_note_vi: str | None = None,
) -> str:
    """Build smooth, symbol-free Vietnamese TTS text for reading meaning + example."""
    clean_word = unicodedata.normalize("NFC", word or "").strip(" .!?,;:")
    clean_def = unicodedata.normalize("NFC", definition_vi or "").strip()
    if clean_def and clean_def[-1] not in ".!?":
        clean_def = f"{clean_def}."
    clean_ex = unicodedata.normalize("NFC", example_sentence_vi or "").strip()
    if clean_ex and clean_ex[-1] not in ".!?":
        clean_ex = f"{clean_ex}."
    parts = [f"Từ {clean_word}.", clean_def]
    if nuance_note_vi and nuance_note_vi.strip():
        clean_nuance = unicodedata.normalize("NFC", nuance_note_vi).strip()
        if clean_nuance[-1] not in ".!?":
            clean_nuance = f"{clean_nuance}."
        parts.append(clean_nuance)
    parts.append(f"Ví dụ: {clean_ex}")
    joined = " ".join(p for p in parts if p)
    joined = re.sub(r"[«»\"“”'‘’→+/*=<>{}\[\]|\\~^_`#@$%&]+", " ", joined)
    return re.sub(r"\s+", " ", joined).strip()[:480]


class WordExplainRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    word: str = Field(..., min_length=1, max_length=120)
    context_sentence: str | None = Field(default=None, max_length=320)
    grade_override: int | None = Field(default=None, ge=1, le=5)

    @field_validator("word")
    @classmethod
    def _validate_word(cls, value: str) -> str:
        display_word, _ = normalize_glossary_word(value)
        return display_word

    @field_validator("context_sentence")
    @classmethod
    def _validate_context(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = unicodedata.normalize("NFC", value).strip()
        cleaned = re.sub(r"\s+", " ", cleaned)
        return cleaned[:300] if cleaned else None


class WordExplainResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    word: str
    normalized_word: str
    grade_band: GradeBand
    part_of_speech_vi: str | None = None
    definition_vi: str
    example_sentence_vi: str
    nuance_note_vi: str | None = None
    spoken_tts_text: str
    source_provider: str
    cached: bool = False
    fallback_used: bool = False
    safety_checked: bool = True
    is_saved_in_notebook: bool = False
    notebook_item_id: UUID | None = None


class FavoriteWordCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    word: str = Field(..., min_length=1, max_length=120)
    definition_vi: str | None = Field(default=None, max_length=500)
    example_sentence_vi: str | None = Field(default=None, max_length=500)
    nuance_note_vi: str | None = Field(default=None, max_length=320)
    grade_band: GradeBand | None = None
    source_book_id: UUID | None = None
    source_page_id: UUID | None = None

    @field_validator("word")
    @classmethod
    def _validate_word(cls, value: str) -> str:
        display_word, _ = normalize_glossary_word(value)
        return display_word


class FavoriteWordRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    child_profile_id: UUID
    word: str
    normalized_word: str
    grade_band: GradeBand
    definition_vi: str
    example_sentence_vi: str
    nuance_note_vi: str | None = None
    spoken_tts_text: str
    source_book_id: UUID | None = None
    source_page_id: UUID | None = None
    visibility: NotebookVisibility = "PARENT_PRIVATE"
    times_used_in_games: int = 0
    already_saved: bool = False
    created_at: datetime
    updated_at: datetime


class VocabularyNotebookListResponse(BaseModel):
    child_id: UUID
    total: int
    storytelling_words: list[str] = Field(default_factory=list)
    items: list[FavoriteWordRead] = Field(default_factory=list)


class FavoriteWordDeleteResponse(BaseModel):
    deleted: bool = True
    item_id: UUID
