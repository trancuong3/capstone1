from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status

from app.models import ComprehensionAnswer, ComprehensionQuestion
from app.repositories.tutor_question_repository import TutorQuestionRepository
from app.schemas.tutor_question import (
    TutorAnswerResultRead,
    TutorChoiceRead,
    TutorNextQuestionRead,
    TutorQuestionRead,
    TutorQuestionSetRead,
    TutorSourceSpanRead,
)
from app.services.tutor_questions import SourcePage, TutorQuestionGenerator
from app.services.tutor_questions.config import TutorQuestionConfig
from app.services.tutor_questions.text_utils import normalize_text

logger = logging.getLogger(__name__)

FINISHED_STATES = ("COMPLETED", "FINISHED")
_DIFFICULTY_TO_LEVEL = {"EASY": 1, "MEDIUM": 2, "HARD": 3}
_CHOICE_IDS = "ABCD"


def _stored_choices(question: ComprehensionQuestion) -> list[str] | None:
    """Choices live in the SourceSpan JSON; rows from older flows have none."""

    span = question.SourceSpan
    choices = span.get("choices") if isinstance(span, dict) else None
    if (
        isinstance(choices, list)
        and 2 <= len(choices) <= len(_CHOICE_IDS)
        and all(isinstance(choice, str) and choice for choice in choices)
    ):
        return choices
    return None


class TutorQuestionService:
    """Business rules for AI-generated comprehension questions.

    Router -> TutorQuestionService -> TutorQuestionRepository -> ORM -> PostgreSQL.
    """

    def __init__(
        self,
        repository: TutorQuestionRepository,
        generator: TutorQuestionGenerator | None = None,
        config: TutorQuestionConfig | None = None,
    ) -> None:
        self.repository = repository
        self.config = config or TutorQuestionConfig.from_environment()
        self.generator = generator or TutorQuestionGenerator(self.config)

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _not_found() -> HTTPException:
        # The same response for a missing session and another parent's session.
        return HTTPException(status.HTTP_404_NOT_FOUND, "Reading session not found")

    async def _tutor_questions(self, session_id: UUID) -> list[ComprehensionQuestion]:
        rows = await self.repository.questions(session_id)
        return [row for row in rows if _stored_choices(row) is not None]

    async def _source_pages(self, session: Any) -> list[SourcePage]:
        rows = await self.repository.session_page_rows(session.Id)
        chosen = [row for row in rows if row.Status in ("COMPLETED", "IN_PROGRESS")] or rows
        refs: list[tuple[UUID, UUID, int | None]] = [
            (row.PageId, row.PageRevisionId, row.PageNumber) for row in chosen
        ]
        if not refs and session.SelectedPageId and session.SelectedPageRevisionId:
            refs.append(
                (
                    session.SelectedPageId,
                    session.SelectedPageRevisionId,
                    await self.repository.page_number(session.SelectedPageId),
                )
            )

        pages: list[SourcePage] = []
        for index, (page_id, revision_id, page_number) in enumerate(refs):
            revision = await self.repository.revision(revision_id)
            if revision is None:
                continue
            words = await self.repository.revision_word_texts(revision_id)
            text = (revision.VerifiedText or " ".join(words)).strip()
            tokens = tuple(words) if words else tuple(text.split())
            if not tokens:
                continue
            pages.append(
                SourcePage(
                    page_id=page_id,
                    revision_id=revision_id,
                    page_number=page_number if page_number is not None else index + 1,
                    text=text,
                    tokens=tokens,
                )
            )
        return pages

    @staticmethod
    def _to_read(question: ComprehensionQuestion, answered: bool) -> TutorQuestionRead:
        span = question.SourceSpan if isinstance(question.SourceSpan, dict) else {}
        start = int(span.get("start_word_index", 0))
        end = max(int(span.get("end_word_index_exclusive", start + 1)), start + 1)
        return TutorQuestionRead(
            id=question.Id,
            type=question.Type,
            prompt=question.Prompt,
            page_revision_id=question.PageRevisionId,
            source_span=TutorSourceSpanRead(
                start_word_index=start,
                end_word_index_exclusive=end,
                sentence_index=None,
            ),
            difficulty=_DIFFICULTY_TO_LEVEL.get(str(question.Difficulty).upper(), 1),
            answered=answered,
        )

    # ------------------------------------------------------------------ use cases
    async def generate_for_session(
        self, session_id: UUID, actor_id: UUID
    ) -> TutorQuestionSetRead:
        """Create questions once after a session is finished (idempotent)."""

        session = await self.repository.owned_session(session_id, actor_id)
        if session is None:
            raise self._not_found()
        if session.State not in FINISHED_STATES:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Reading session must be finished first"
            )

        existing = await self._tutor_questions(session_id)
        if existing:
            await self.repository.release()
            return TutorQuestionSetRead(
                session_id=session_id,
                total=len(existing),
                source=self._source_of(existing[0]),
                created=False,
            )
        if not self.config.enabled:
            await self.repository.release()
            return TutorQuestionSetRead(
                session_id=session_id, total=0, source=None, created=False
            )

        pages = await self._source_pages(session)
        # Release the read transaction before the slow network call.
        await self.repository.release()
        result = await self.generator.generate(pages, seed=str(session_id))
        if not result.questions:
            return TutorQuestionSetRead(
                session_id=session_id, total=0, source=None, created=False
            )

        # Re-check under a row lock: a concurrent request may have won the race.
        locked = await self.repository.owned_session_for_update(session_id, actor_id)
        if locked is None:
            raise self._not_found()
        existing = await self._tutor_questions(session_id)
        if existing:
            await self.repository.release()
            return TutorQuestionSetRead(
                session_id=session_id,
                total=len(existing),
                source=self._source_of(existing[0]),
                created=False,
            )

        base = datetime.now(timezone.utc)
        rows: list[ComprehensionQuestion] = []
        for index, draft in enumerate(result.questions):
            rows.append(
                ComprehensionQuestion(
                    SessionId=session_id,
                    PageId=draft.page_id,
                    PageRevisionId=draft.revision_id,
                    Type=draft.type,
                    Prompt=draft.prompt,
                    ExpectedAnswer=draft.correct_answer,
                    AcceptedAnswers=[normalize_text(draft.correct_answer)],
                    SourceSpan={
                        "start_word_index": draft.start_word_index,
                        "end_word_index_exclusive": draft.end_word_index_exclusive,
                        "sentence_index": None,
                        "choices": list(draft.choices),
                        "generation": {"source": result.source, "provider": result.provider},
                    },
                    Difficulty=draft.difficulty,
                    # Explicit, increasing timestamps keep the question order stable.
                    CreatedAt=base + timedelta(microseconds=index),
                )
            )
        self.repository.add_questions(rows)
        await self.repository.commit()
        return TutorQuestionSetRead(
            session_id=session_id, total=len(rows), source=result.source, created=True
        )

    @staticmethod
    def _source_of(question: ComprehensionQuestion) -> str | None:
        span = question.SourceSpan if isinstance(question.SourceSpan, dict) else {}
        generation = span.get("generation")
        source = generation.get("source") if isinstance(generation, dict) else None
        return source if source in ("AI", "RULE_BASED") else None

    async def next_question(self, session_id: UUID, actor_id: UUID) -> TutorNextQuestionRead:
        session = await self.repository.owned_session(session_id, actor_id)
        if session is None:
            raise self._not_found()

        questions = await self._tutor_questions(session_id)
        answers = await self.repository.answers([q.Id for q in questions])
        correct_ids = {answer.QuestionId for answer in answers if answer.IsCorrect}
        answered_ids = {answer.QuestionId for answer in answers}
        total = len(questions)

        for index, question in enumerate(questions):
            if question.Id in correct_ids:
                continue
            choices = _stored_choices(question) or []
            return TutorNextQuestionRead(
                question=self._to_read(question, question.Id in answered_ids),
                choices=[
                    TutorChoiceRead(id=_CHOICE_IDS[i], label=text, value=text)
                    for i, text in enumerate(choices)
                ],
                progress_label=f"Câu {index + 1}/{total}",
                position=index + 1,
                total=total,
                completed=False,
            )
        return TutorNextQuestionRead(
            question=None,
            choices=[],
            progress_label=f"Hoàn thành {total}/{total}" if total else "",
            position=total,
            total=total,
            completed=True,
        )

    async def submit_answer(
        self, session_id: UUID, question_id: UUID, actor_id: UUID, answer: str
    ) -> TutorAnswerResultRead:
        session = await self.repository.owned_session(session_id, actor_id)
        if session is None:
            raise self._not_found()
        question = await self.repository.question(session_id, question_id)
        if question is None or _stored_choices(question) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Question not found")

        previous = await self.repository.answers([question.Id])
        already_correct = next((item for item in previous if item.IsCorrect), None)
        if already_correct is not None:
            # Re-submitting after success must not create contradictory history.
            return TutorAnswerResultRead(
                answer_id=already_correct.Id,
                question_id=question.Id,
                submitted_answer=already_correct.Answer,
                is_correct=True,
                score=1.0,
                feedback_code="CORRECT",
            )

        accepted = {normalize_text(question.ExpectedAnswer)}
        if isinstance(question.AcceptedAnswers, list):
            accepted.update(
                normalize_text(item) for item in question.AcceptedAnswers if isinstance(item, str)
            )
        is_correct = normalize_text(answer) in accepted

        record = ComprehensionAnswer(
            QuestionId=question.Id,
            Answer=answer,
            IsCorrect=is_correct,
            Score=1.0 if is_correct else 0.0,
        )
        self.repository.add_answer(record)
        await self.repository.commit()
        await self.repository.refresh(record)
        return TutorAnswerResultRead(
            answer_id=record.Id,
            question_id=question.Id,
            submitted_answer=answer,
            is_correct=is_correct,
            score=1.0 if is_correct else 0.0,
            feedback_code="CORRECT" if is_correct else "TRY_AGAIN",
        )
