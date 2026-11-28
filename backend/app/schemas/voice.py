"""Public request and response contracts for the voice endpoints."""

from __future__ import annotations

import unicodedata
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

VoiceProviderMode = Literal["local_only", "local_with_google_fallback"]
AudioFormatPreference = Literal["wav", "mp3", "ogg"]
TtsCacheScope = Literal["CATALOG", "PRIVATE", "COACHING"]


def _validate_safe_id(value: str | None, *, max_len: int = 100) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > max_len
        or not normalized.replace("-", "").replace("_", "").isalnum()
    ):
        raise ValueError("identifier is invalid")
    return normalized


class TextToSpeechRequest(BaseModel):
    """A short piece of text synthesized with a locked voice."""

    text: str = Field(min_length=1, max_length=2_500)
    voice_id: str | None = Field(default=None, min_length=1, max_length=100)
    speed: float = Field(default=1.0, ge=0.7, le=1.2, allow_inf_nan=False)
    word_sample: bool = False
    provider_mode: VoiceProviderMode = "local_only"
    allow_google_tts: bool = False
    session_id: str | None = Field(default=None, max_length=80)
    audio_format: AudioFormatPreference | None = None
    book_id: UUID | None = None
    page_id: UUID | None = None
    page_revision_id: UUID | None = None
    cache_scope: TtsCacheScope | None = None

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = unicodedata.normalize("NFC", value).strip()
        if not normalized:
            raise ValueError("text must not be blank")
        return normalized

    @field_validator("voice_id")
    @classmethod
    def normalize_voice_id(cls, value: str | None) -> str | None:
        return _validate_safe_id(value, max_len=100)

    @field_validator("session_id")
    @classmethod
    def normalize_session_id(cls, value: str | None) -> str | None:
        return _validate_safe_id(value, max_len=80)


class PhonicsStepInput(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    spoken_text: str = Field(min_length=1, max_length=240)
    pause_after_ms: int = Field(default=420, ge=80, le=2000)

    @field_validator("id")
    @classmethod
    def normalize_step_id(cls, value: str) -> str:
        validated = _validate_safe_id(value, max_len=64)
        if not validated:
            raise ValueError("step id is invalid")
        return validated

    @field_validator("spoken_text")
    @classmethod
    def normalize_spoken_text(cls, value: str) -> str:
        normalized = unicodedata.normalize("NFC", value).strip()
        if not normalized:
            raise ValueError("spoken_text must not be blank")
        return normalized


class PhonicsSpeechRequest(BaseModel):
    steps: list[PhonicsStepInput] = Field(min_length=1, max_length=12)
    voice_id: str | None = Field(default=None, min_length=1, max_length=100)
    speed: float = Field(default=1.0, ge=0.7, le=1.2, allow_inf_nan=False)
    provider_mode: VoiceProviderMode = "local_only"
    allow_google_tts: bool = False
    session_id: str | None = Field(default=None, max_length=80)
    audio_format: AudioFormatPreference | None = None
    book_id: UUID | None = None
    page_id: UUID | None = None
    page_revision_id: UUID | None = None
    cache_scope: TtsCacheScope | None = None

    @field_validator("voice_id")
    @classmethod
    def normalize_voice_id(cls, value: str | None) -> str | None:
        return _validate_safe_id(value, max_len=100)

    @field_validator("session_id")
    @classmethod
    def normalize_session_id(cls, value: str | None) -> str | None:
        return _validate_safe_id(value, max_len=80)


class PhonicsStepTimingRead(BaseModel):
    id: str
    index: int = Field(ge=0)
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(ge=0, allow_inf_nan=False)


class PhonicsSpeechRead(BaseModel):
    audio_base64: str
    content_type: str
    duration_seconds: float = Field(gt=0, allow_inf_nan=False)
    step_timings: list[PhonicsStepTimingRead]
    provider: str = "local"
    resolved_voice_id: str
    region: str = "north"
    model_version: str
    cached_speed: float | None = None


class SpeechWord(BaseModel):
    text: str
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    logprob: float | None = None


class SpeechToTextResponse(BaseModel):
    """The safe, provider-neutral part of a transcription result."""

    text: str
    language_code: str | None = None
    language_probability: float | None = None
    words: list[SpeechWord] | None = None


class SessionVoiceLockUpdateRequest(BaseModel):
    """Explicit parent-initiated session voice lock update while reading is paused."""

    session_id: str = Field(min_length=1, max_length=80)
    voice_id: str = Field(min_length=1, max_length=100)
    provider_mode: VoiceProviderMode = "local_only"
    allow_google_tts: bool = False

    @field_validator("session_id")
    @classmethod
    def normalize_session_id(cls, value: str) -> str:
        validated = _validate_safe_id(value, max_len=80)
        if not validated:
            raise ValueError("session_id is invalid")
        return validated

    @field_validator("voice_id")
    @classmethod
    def normalize_voice_id(cls, value: str) -> str:
        validated = _validate_safe_id(value, max_len=100)
        if not validated:
            raise ValueError("voice_id is invalid")
        return validated


class SessionVoiceLockRead(BaseModel):
    session_id: str
    voice_id: str
    provider: Literal["local", "google"]
    locked: bool = True


class PhonicsAnalyzeRequest(BaseModel):
    """Request AI-assisted Grade-1 Vietnamese phonics breakdown for a word/phrase."""

    text: str = Field(min_length=1, max_length=80)
    context_phrase: str | None = Field(default=None, max_length=160)

    @field_validator("text")
    @classmethod
    def normalize_word(cls, value: str) -> str:
        normalized = unicodedata.normalize("NFC", value).strip()
        if not normalized:
            raise ValueError("text must not be blank")
        return normalized

    @field_validator("context_phrase")
    @classmethod
    def normalize_context_phrase(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = unicodedata.normalize("NFC", value).strip()
        return normalized or None


class PhonicsAnalyzeOnsetRead(BaseModel):
    written: str
    spoken: str


class PhonicsAnalyzeRhymeRead(BaseModel):
    written: str
    untoned: str
    nucleus: str
    coda: str
    spoken: str


class PhonicsAnalyzeToneRead(BaseModel):
    key: Literal["ngang", "sac", "huyen", "hoi", "nga", "nang"]
    label: str
    spoken: str | None = None


class PhonicsAnalyzeStepRead(BaseModel):
    id: str
    index: int = Field(ge=0)
    kind: Literal[
        "rhyme_build",
        "onset_blend",
        "tone_blend",
        "whole_syllable",
        "context_phrase",
    ]
    display_text: str
    spoken_text: str
    highlight_part: Literal[
        "rhyme",
        "onset_and_rhyme",
        "tone_and_syllable",
        "whole_syllable",
        "context",
    ]
    highlight_start: int = Field(ge=0)
    highlight_end: int = Field(ge=0)
    pause_after_ms: int = Field(default=420, ge=150, le=1500)


class PhonicsAnalyzeResponse(BaseModel):
    supported: bool
    source: Literal["rules", "ai", "none"] = "none"
    raw_text: str
    clean_phrase: str
    syllables: list[str] = Field(default_factory=list)
    focus_syllable_index: int = 0
    focus_syllable: str = ""
    focus_range_start: int = 0
    focus_range_end: int = 0
    onset: PhonicsAnalyzeOnsetRead | None = None
    rhyme: PhonicsAnalyzeRhymeRead | None = None
    tone: PhonicsAnalyzeToneRead | None = None
    steps: list[PhonicsAnalyzeStepRead] = Field(default_factory=list)
    message: str = "Chưa có mẫu đánh vần"
    can_play_whole_word: bool = True
