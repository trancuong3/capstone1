"""Contracts for voice selection and word-timed sample reading."""

from pydantic import BaseModel, Field, field_validator, model_validator
import unicodedata

MAX_TIMED_WORDS = 800
MAX_TIMED_CHARACTERS = 5_000
MIN_SPEED = 0.7
MAX_SPEED = 1.2


class VoiceInfoRead(BaseModel):
    """Public, non-secret description of a voice available to the account."""

    voice_id: str
    name: str
    category: str | None = None
    gender: str | None = None
    accent: str | None = None
    age: str | None = None
    use_case: str | None = None
    description: str | None = None
    preview_url: str | None = None


class VoiceListRead(BaseModel):
    voices: list[VoiceInfoRead]
    default_voice_id: str


class TimedSpeechRequest(BaseModel):
    """Words of one page, in reading order. Timings are returned per word."""

    words: list[str] = Field(min_length=1, max_length=MAX_TIMED_WORDS)
    voice_id: str | None = Field(default=None, min_length=1, max_length=100)
    speed: float = Field(default=1.0, ge=MIN_SPEED, le=MAX_SPEED, allow_inf_nan=False)

    @field_validator("words")
    @classmethod
    def normalize_words(cls, value: list[str]) -> list[str]:
        words = [unicodedata.normalize("NFC", word.strip()) for word in value]
        if any(not word or len(word) > 80 or any(ch.isspace() for ch in word) for word in words):
            raise ValueError("each word must be a non-empty token without whitespace")
        return words

    @field_validator("voice_id")
    @classmethod
    def normalize_voice_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized or not normalized.replace("-", "").replace("_", "").isalnum():
            raise ValueError("voice_id is invalid")
        return normalized

    @model_validator(mode="after")
    def limit_total_size(self) -> "TimedSpeechRequest":
        if len(" ".join(self.words)) > MAX_TIMED_CHARACTERS:
            raise ValueError("text is too long")
        return self


class TimedWordRead(BaseModel):
    index: int = Field(ge=0)
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(ge=0, allow_inf_nan=False)


class TimedSpeechRead(BaseModel):
    audio_base64: str
    content_type: str
    duration_seconds: float = Field(gt=0, allow_inf_nan=False)
    words: list[TimedWordRead]
