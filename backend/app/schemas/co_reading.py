"""Pydantic schemas for Feature #2: Co-Reading Role-Play & Parent Storyteller Voice."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
import unicodedata
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

TurnRole = Literal["NARRATOR", "CHARACTER_A", "CHARACTER_B"]
TurnOwner = Literal["AI_OR_PARENT", "CHILD"]
AudioFormat = Literal["webm", "ogg", "wav", "mp3", "m4a", "aac"]
AlignmentSource = Literal["ctc_forced", "acoustic_envelope", "syllable_duration"]

DEFAULT_CHILD_TURN_PROMPT_VI = "Đến lượt con đọc câu tiếp theo nhé!"


class DialogueTurn(BaseModel):
    """A single ordered turn in a co-reading role-play / turn-taking script."""

    model_config = ConfigDict(from_attributes=True)

    index: int = Field(..., ge=0)
    role: TurnRole
    speaker_label: str
    text: str
    words: list[str] = Field(default_factory=list)
    voice_id: str
    voice_name: str
    is_character_dialogue: bool = False
    turn_owner: TurnOwner
    coaching_prompt_vi: str | None = None
    coaching_voice_id: str


class ParseScriptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_text: str | None = Field(default=None, max_length=8000)
    book_id: UUID | None = None
    page_id: UUID | None = None
    teacher_voice_id: str | None = Field(default=None, max_length=80)

    @field_validator("page_text")
    @classmethod
    def _clean_page_text(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = unicodedata.normalize("NFC", v).strip()
        return cleaned if cleaned else None

    @model_validator(mode="after")
    def _require_text_or_page(self) -> ParseScriptRequest:
        if not self.page_text and self.page_id is None:
            raise ValueError("Either page_text or page_id is required")
        return self


class ParseScriptResponse(BaseModel):
    child_id: UUID
    book_id: UUID | None = None
    page_id: UUID | None = None
    total_turns: int
    turns: list[DialogueTurn]
    has_dialogue: bool
    narrator_voice_id: str
    coaching_voice_id: str
    character_voices: dict[str, str]
    has_parent_narration: bool = False


class WordTiming(BaseModel):
    word: str
    start_ms: int = Field(..., ge=0)
    end_ms: int = Field(..., ge=0)


class NarrationUploadResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    parent_id: UUID
    book_id: UUID
    page_id: UUID
    audio_format: AudioFormat
    content_type: str
    file_size_bytes: int
    duration_ms: int
    alignment_source: AlignmentSource = "syllable_duration"
    word_timings: list[WordTiming]
    audio_endpoint: str
    visibility: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    created_at: datetime
    updated_at: datetime


class NarrationMetaResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    parent_id: UUID
    book_id: UUID
    page_id: UUID
    audio_format: AudioFormat
    content_type: str
    file_size_bytes: int
    duration_ms: int
    alignment_source: AlignmentSource = "syllable_duration"
    word_timings: list[WordTiming]
    audio_endpoint: str
    visibility: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    created_at: datetime
    updated_at: datetime


class NarrationDeleteResponse(BaseModel):
    deleted: bool = True
    narration_id: UUID


class PostcardCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., min_length=1, max_length=240)
    passage_text: str = Field(..., min_length=1, max_length=2000)
    source_book_id: UUID | None = None
    source_page_id: UUID | None = None
    emoji_badge: str = Field(default="🌟", max_length=16)

    @field_validator("title", "passage_text")
    @classmethod
    def _strip_field(cls, v: str) -> str:
        cleaned = unicodedata.normalize("NFC", v).strip()
        if not cleaned:
            raise ValueError("Field must not be blank")
        return cleaned


class PostcardRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    parent_id: UUID
    child_id: UUID
    title: str
    passage_text: str
    source_book_id: UUID | None = None
    source_page_id: UUID | None = None
    has_audio_clip: bool = False
    audio_format: AudioFormat | None = None
    audio_size_bytes: int | None = None
    audio_endpoint: str | None = None
    emoji_badge: str = "🌟"
    visibility: Literal["PARENT_PRIVATE"] = "PARENT_PRIVATE"
    created_at: datetime
    updated_at: datetime


class PostcardListResponse(BaseModel):
    child_id: UUID
    total: int
    items: list[PostcardRead] = Field(default_factory=list)


class PostcardDeleteResponse(BaseModel):
    deleted: bool = True
    postcard_id: UUID
