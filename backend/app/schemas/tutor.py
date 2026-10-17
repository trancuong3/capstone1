"""Public contracts for contextual word explanations; no ORM or provider data."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class TutorExplainWordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page_revision_id: UUID
    word_id: UUID


class TutorExplanation(BaseModel):
    """The only fields a language-model response is allowed to supply."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    explanation: str = Field(min_length=1, max_length=600)
    reading_hint: str = Field(min_length=1, max_length=180)


class TutorExplainWordResponse(TutorExplanation):
    page_revision_id: UUID
    word_id: UUID
    word: str = Field(min_length=1, max_length=500)
