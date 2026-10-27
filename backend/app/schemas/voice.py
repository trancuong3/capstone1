"""Public request and response contracts for the voice endpoints."""

from pydantic import BaseModel, Field, field_validator


class TextToSpeechRequest(BaseModel):
    """A short piece of text that can safely be sent to the TTS provider."""

    text: str = Field(min_length=1, max_length=2_500)
    # A voice id is not secret, but constraining it prevents malformed provider paths.
    voice_id: str | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("text must not be blank")
        return normalized

    @field_validator("voice_id")
    @classmethod
    def normalize_voice_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized or not normalized.replace("-", "").replace("_", "").isalnum():
            raise ValueError("voice_id is invalid")
        return normalized


class SpeechWord(BaseModel):
    text: str
    start: float = Field(ge=0)
    end: float = Field(ge=0)


class SpeechToTextResponse(BaseModel):
    """The safe, provider-neutral part of a transcription result."""

    text: str
    language_code: str | None = None
    language_probability: float | None = None
    words: list[SpeechWord] | None = None