from __future__ import annotations

from dataclasses import dataclass, field
from uuid import UUID


class QuestionProviderError(RuntimeError):
    """A classified provider failure. It never carries a vendor response body."""

    def __init__(self, *, provider: str, code: str) -> None:
        super().__init__(code)
        self.provider = provider
        self.code = code


@dataclass(frozen=True)
class SourcePage:
    """Verified text the child actually read, with the page revision it came from."""

    page_id: UUID
    revision_id: UUID
    page_number: int
    text: str
    tokens: tuple[str, ...]


@dataclass(frozen=True)
class DraftQuestion:
    """A validated multiple-choice question that is grounded in a source page."""

    type: str  # FACTUAL | CLOZE | VOCABULARY
    prompt: str
    choices: tuple[str, ...]
    correct_index: int
    difficulty: str  # EASY | MEDIUM | HARD
    page_id: UUID
    revision_id: UUID
    start_word_index: int
    end_word_index_exclusive: int

    @property
    def correct_answer(self) -> str:
        return self.choices[self.correct_index]


@dataclass(frozen=True)
class GenerationResult:
    questions: list[DraftQuestion]
    source: str  # AI | RULE_BASED
    provider: str
    attempts: list[str] = field(default_factory=list)
