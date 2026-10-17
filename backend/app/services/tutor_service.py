"""Authorize and build verified context before any tutor provider is called."""

import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from fastapi import HTTPException
from pydantic import ValidationError

from app.diagnostic_logging import log_diagnostic
from app.models import PageRevisionWord
from app.providers.gemini_tutor_provider import GeminiTutorProvider, TutorProviderError
from app.repositories.tutor_repository import TutorRepository
from app.schemas.tutor import (
    TutorExplanation,
    TutorExplainWordRequest,
    TutorExplainWordResponse,
)


MAX_CONTEXT_CHARACTERS = 4_000
MAX_WORD_CHARACTERS = 500
TUTOR_SESSION_STATES = frozenset({"IN_PROGRESS", "PAGE_READY", "LISTENING", "PAUSED"})
logger = logging.getLogger(__name__)


class TutorProvider(Protocol):
    async def explain_word(
        self,
        *,
        word: str,
        context_text: str,
        grade: int,
        word_start: int,
        word_end: int,
    ) -> TutorExplanation: ...


@dataclass(frozen=True)
class TutorWordContext:
    """Internal context, not a public response or an instruction to the model.

    Word offsets identify the selected occurrence inside context_text, including
    on short pages with repeated words. IDs stay server-side.
    """

    page_revision_id: UUID
    word_id: UUID
    word: str
    context_text: str
    grade: int
    word_start: int
    word_end: int


def _normalized_word(value: str) -> str:
    """Match the existing OCR token rules without importing its image engine."""

    value = unicodedata.normalize("NFC", value).strip().lower()
    while value and unicodedata.category(value[0]).startswith(("P", "S")):
        if value[0] in {"'", "-"}:
            break
        value = value[1:]
    while value and unicodedata.category(value[-1]).startswith(("P", "S")):
        if value[-1] in {"'", "-"}:
            break
        value = value[:-1]
    return re.sub(r"\s+", " ", value).strip()


class TutorService:
    def __init__(
        self, repository: TutorRepository, provider: TutorProvider | None = None
    ):
        self.repository = repository
        self.provider = provider

    async def explain_word(
        self,
        actor_id: UUID,
        session_id: UUID,
        payload: TutorExplainWordRequest,
    ) -> TutorExplainWordResponse:
        # Validate ownership and persisted context before even creating a provider.
        context = await self.get_word_context(actor_id, session_id, payload)
        provider = self.provider if self.provider is not None else GeminiTutorProvider()
        try:
            generated = await provider.explain_word(
                word=context.word,
                context_text=context.context_text,
                grade=context.grade,
                word_start=context.word_start,
                word_end=context.word_end,
            )
            explanation = TutorExplanation.model_validate(generated)
        except (TutorProviderError, ValidationError) as error:
            status_code = (
                error.status_code if isinstance(error, TutorProviderError) else 502
            )
            log_diagnostic(
                logger,
                logging.WARNING,
                event="tutor_explanation_unavailable",
                stage="tutor_generation",
                exception=error,
            )
            raise HTTPException(
                status_code=status_code,
                detail="Tutor is temporarily unavailable",
                headers={"Cache-Control": "no-store"},
            ) from None

        # IDs and displayed word always come from the authorized DB context.
        # No events, grades, scores or session state are written by this operation.
        return TutorExplainWordResponse(
            page_revision_id=context.page_revision_id,
            word_id=context.word_id,
            word=context.word,
            explanation=explanation.explanation,
            reading_hint=explanation.reading_hint,
        )

    @staticmethod
    def _content_unavailable() -> HTTPException:
        # Keep corrupted, stale and unverified content behind one public error.
        return HTTPException(status_code=409, detail="Tutor content is not ready")

    async def get_word_context(
        self,
        actor_id: UUID,
        session_id: UUID,
        payload: TutorExplainWordRequest,
    ) -> TutorWordContext:
        profile = await self.repository.profile(actor_id)
        if profile is None or profile.Role != "parent" or profile.Active != 1:
            raise HTTPException(status_code=403, detail="Parent access required")

        owned = await self.repository.owned_session(session_id, actor_id)
        if owned is None:
            raise HTTPException(status_code=404, detail="Reading session not found")
        session, child = owned.session, owned.child
        if child.ParentId != actor_id or child.Id != session.ChildId:
            raise HTTPException(status_code=404, detail="Reading session not found")

        if (
            session.State not in TUTOR_SESSION_STATES
            or session.EndedAt is not None
            or session.SelectedPageId is None
            or session.SelectedPageRevisionId != payload.page_revision_id
        ):
            raise self._content_unavailable()
        if type(child.Grade) is not int or child.Grade not in range(1, 6):
            raise self._content_unavailable()

        content = await self.repository.page_revision(
            session.BookId, session.SelectedPageId, payload.page_revision_id
        )
        if content is None:
            raise self._content_unavailable()
        book, page, revision = content.book, content.page, content.revision
        if (
            book.LifecycleStatus != "ACTIVE"
            or page.LifecycleStatus != "ACTIVE"
            or revision.VerificationStatus != "VERIFIED"
        ):
            raise self._content_unavailable()

        # Use the revision bound to the session even if Admin has since verified
        # a newer revision. The repository joins scope it to this book and page.
        text = unicodedata.normalize("NFC", revision.VerifiedText or "").strip()
        if not text:
            raise self._content_unavailable()
        words = await self.repository.revision_words(revision.Id)
        selected = next((word for word in words if word.Id == payload.word_id), None)
        if selected is None:
            raise self._content_unavailable()

        context_text, word_start, word_end = self._aligned_context(text, words, selected)
        return TutorWordContext(
            page_revision_id=revision.Id,
            word_id=selected.Id,
            word=unicodedata.normalize("NFC", selected.Text).strip(),
            context_text=context_text,
            grade=child.Grade,
            word_start=word_start,
            word_end=word_end,
        )

    def _aligned_context(
        self,
        text: str,
        words: list[PageRevisionWord],
        selected: PageRevisionWord,
    ) -> tuple[str, int, int]:
        # Align by WordIndex, not text.find(): the same word may occur several
        # times, with different meanings. Preserve accents and punctuation.
        tokens = [
            match for match in re.finditer(r"\S+", text) if _normalized_word(match[0])
        ]
        if len(tokens) != len(words):
            raise self._content_unavailable()
        for index, (token, word) in enumerate(zip(tokens, words)):
            if (
                word.WordIndex != index
                or not isinstance(word.Text, str)
                or not word.Text.strip()
                or len(word.Text.strip()) > MAX_WORD_CHARACTERS
                or _normalized_word(token[0]) != _normalized_word(word.Text)
            ):
                raise self._content_unavailable()

        target = tokens[selected.WordIndex]
        if len(text) <= MAX_CONTEXT_CHARACTERS:
            return text, target.start(), target.end()

        remaining = MAX_CONTEXT_CHARACTERS - (target.end() - target.start())
        start = max(
            0,
            min(target.start() - remaining // 2, len(text) - MAX_CONTEXT_CHARACTERS),
        )
        end = start + MAX_CONTEXT_CHARACTERS
        # Keep only whole tokens inside the window, always including the actual
        # selected occurrence. Do not truncate a long page from its beginning.
        window = [
            token for token in tokens if token.start() >= start and token.end() <= end
        ]
        if not window or target not in window:
            raise self._content_unavailable()
        offset = window[0].start()
        return (
            text[offset:window[-1].end()],
            target.start() - offset,
            target.end() - offset,
        )
