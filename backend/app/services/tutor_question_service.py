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
from app.services.tutor_questions.text_utils import normalize_text, tokenize

logger = logging.getLogger(__name__)

FINISHED_STATES = ("COMPLETED", "FINISHED")
_DIFFICULTY_TO_LEVEL = {"EASY": 1, "MEDIUM": 2, "HARD": 3}
_CHOICE_IDS = "ABCD"
_HINT_FUNCTION_WORDS = frozenset(
    "và là của có không cho các một những được trong với này đó khi thì mà đã sẽ rất cũng như "
    "ở đi ra vào lên xuống lại còn nhưng nên vì để từ cái chiếc "
    "bên trên dưới ngoài trước sau".split()
)


def _contains_token_sequence(haystack: list[str], needle: list[str]) -> bool:
    if not needle or len(needle) > len(haystack):
        return False
    span = len(needle)
    return any(
        haystack[idx : idx + span] == needle
        for idx in range(len(haystack) - span + 1)
    )


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

        page_ids = [pid for pid, _, _ in refs if pid is not None]
        extractions_by_page: dict[UUID, tuple[str | None, list[dict[str, Any]]]] = {}
        ext_fn = getattr(self.repository, "page_extractions_by_page_ids", None)
        if callable(ext_fn) and page_ids:
            try:
                extractions_by_page = await ext_fn(page_ids)
            except Exception:
                extractions_by_page = {}

        style_bible: dict[str, Any] | None = None
        bible_fn = getattr(self.repository, "book_style_bible_context", None)
        session_book_id = getattr(session, "BookId", None)
        if callable(bible_fn) and session_book_id is not None:
            try:
                style_bible = await bible_fn(session_book_id)
            except Exception:
                style_bible = None

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
            page_kind, blocks_list = extractions_by_page.get(page_id, (None, []))
            pages.append(
                SourcePage(
                    page_id=page_id,
                    revision_id=revision_id,
                    page_number=page_number if page_number is not None else index + 1,
                    text=text,
                    tokens=tokens,
                    page_kind=page_kind,
                    blocks=tuple(blocks_list),
                    style_bible=style_bible,
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
            response = TutorQuestionSetRead(
                session_id=session_id,
                total=len(existing),
                source=self._source_of(existing[0]),
                created=False,
            )
            await self.repository.release()
            return response
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
        if locked.State not in FINISHED_STATES:
            await self.repository.release()
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Reading session must be finished first"
            )
        existing = await self._tutor_questions(session_id)
        if existing:
            response = TutorQuestionSetRead(
                session_id=session_id,
                total=len(existing),
                source=self._source_of(existing[0]),
                created=False,
            )
            await self.repository.release()
            return response

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

    async def _build_story_hint(self, question: ComprehensionQuestion) -> str | None:
        """Derive a safe, non-spoiling clue from the story around SourceSpan."""

        tokens = await self.repository.revision_word_texts(question.PageRevisionId)
        if not tokens:
            revision = await self.repository.revision(question.PageRevisionId)
            text = (revision.VerifiedText or "").strip() if revision is not None else ""
            tokens = text.split()
        if not tokens:
            return None

        span = question.SourceSpan if isinstance(question.SourceSpan, dict) else {}
        try:
            raw_start = int(span.get("start_word_index", 0))
        except (TypeError, ValueError):
            raw_start = 0
        try:
            raw_end = int(span.get("end_word_index_exclusive", raw_start + 1))
        except (TypeError, ValueError):
            raw_end = raw_start + 1

        start = max(0, min(len(tokens), raw_start))
        end = max(start, min(len(tokens), raw_end))

        # Include up to 10 words of preceding context (snapping to sentence boundary)
        # and up to 6 words after the span so the child gets real story context.
        ctx_start = max(0, start - 10)
        for idx in range(start - 1, ctx_start - 1, -1):
            if tokens[idx].rstrip("\"'”’)»").endswith((".", "!", "?", "…")):
                ctx_start = idx + 1
                break
        if ctx_start >= start:
            ctx_start = max(0, start - 8)
            for idx in range(ctx_start, start):
                if idx > 0 and tokens[idx - 1].rstrip("\"'”’)»").endswith((".", "!", "?", "…")):
                    ctx_start = idx
                    break

        ctx_end = min(len(tokens), max(end, start + 1) + 6)
        for idx in range(end, ctx_end):
            if tokens[idx].rstrip("\"'”’)»").endswith((".", "!", "?", "…")):
                ctx_end = idx + 1
                break

        window_tokens = list(tokens[ctx_start:ctx_end])
        if not window_tokens:
            return None

        # Collect forbidden answer phrases and distinctive answer tokens so ExpectedAnswer
        # is never leaked verbatim or by an unmistakable proper noun/content word.
        answer_texts: list[str] = []
        if isinstance(question.ExpectedAnswer, str) and question.ExpectedAnswer.strip():
            answer_texts.append(question.ExpectedAnswer)
        if isinstance(question.AcceptedAnswers, list):
            answer_texts.extend(
                item for item in question.AcceptedAnswers if isinstance(item, str) and item.strip()
            )

        forbidden_phrases = [tokenize(item) for item in answer_texts if tokenize(item)]
        forbidden_single_tokens: set[str] = set()
        for phrase in forbidden_phrases:
            content_tokens = [tok for tok in phrase if tok not in _HINT_FUNCTION_WORDS]
            targets = content_tokens if content_tokens else phrase
            for tok in targets:
                if tok:
                    forbidden_single_tokens.add(tok)

        norm_window = [normalize_text(tok) for tok in window_tokens]
        masked = [False] * len(window_tokens)
        for phrase in forbidden_phrases:
            plen = len(phrase)
            if plen == 0 or plen > len(norm_window):
                continue
            for idx in range(len(norm_window) - plen + 1):
                if norm_window[idx : idx + plen] == phrase:
                    for offset in range(plen):
                        masked[idx + offset] = True
        for idx, tok in enumerate(norm_window):
            parts = tok.split()
            if any(part in forbidden_single_tokens for part in parts):
                masked[idx] = True

        redacted_parts: list[str] = []
        for idx, raw_tok in enumerate(window_tokens):
            if masked[idx]:
                if not redacted_parts or redacted_parts[-1] != "…":
                    redacted_parts.append("…")
            else:
                redacted_parts.append(raw_tok)

        real_words = [part for part in redacted_parts if part != "…" and normalize_text(part)]
        if len(real_words) < 2:
            return None

        excerpt = " ".join(redacted_parts).strip()

        # Final anti-leak verification on the excerpt only (never on the static clue frame)
        # using whole-token matching so single-character answers like "ô" do not collide with "cô".
        excerpt_tokens = tokenize(excerpt)
        excerpt_token_set = set(excerpt_tokens)
        for phrase in forbidden_phrases:
            if _contains_token_sequence(excerpt_tokens, phrase):
                return None
        if forbidden_single_tokens & excerpt_token_set:
            return None
        return f"Con nhớ lại chi tiết trong bài đọc: “{excerpt}” rồi chọn lại nhé!"

    async def submit_answer(
        self, session_id: UUID, question_id: UUID, actor_id: UUID, answer: str
    ) -> TutorAnswerResultRead:
        session = await self.repository.owned_session(session_id, actor_id)
        if session is None:
            raise self._not_found()
        question = await self.repository.question_for_update(session_id, question_id)
        if question is None or _stored_choices(question) is None:
            await self.repository.release()
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Question not found")

        previous = await self.repository.answers([question.Id])
        already_correct = next((item for item in previous if item.IsCorrect), None)
        if already_correct is not None:
            # Re-submitting or concurrent tap+STT after success must not create contradictory history.
            # Build response before release() expires ORM attributes on AsyncSession.
            response = TutorAnswerResultRead(
                answer_id=already_correct.Id,
                question_id=question.Id,
                submitted_answer=already_correct.Answer,
                is_correct=True,
                score=1.0,
                feedback_code="CORRECT",
                story_hint=None,
            )
            await self.repository.release()
            return response

        normalized_answer = normalize_text(answer)
        if previous and normalize_text(previous[-1].Answer) == normalized_answer:
            # Deduplicate concurrent tap+STT or network retries of the exact same attempt.
            latest = previous[-1]
            hint = None if latest.IsCorrect else await self._build_story_hint(question)
            response = TutorAnswerResultRead(
                answer_id=latest.Id,
                question_id=question.Id,
                submitted_answer=latest.Answer,
                is_correct=bool(latest.IsCorrect),
                score=float(latest.Score or 0.0),
                feedback_code="CORRECT" if latest.IsCorrect else "TRY_AGAIN",
                story_hint=hint,
            )
            await self.repository.release()
            return response

        accepted = {normalize_text(question.ExpectedAnswer)}
        if isinstance(question.AcceptedAnswers, list):
            accepted.update(
                normalize_text(item) for item in question.AcceptedAnswers if isinstance(item, str)
            )
        is_correct = normalized_answer in accepted
        question_id_val = question.Id
        question_type_val = getattr(question, "Type", None)
        child_id_val = getattr(session, "ChildId", None)
        story_hint = None if is_correct else await self._build_story_hint(question)

        record = ComprehensionAnswer(
            QuestionId=question_id_val,
            Answer=answer,
            IsCorrect=is_correct,
            Score=1.0 if is_correct else 0.0,
        )
        self.repository.add_answer(record)
        await self.repository.commit()
        await self.repository.refresh(record)
        from app.services.reading_skill_evidence import (
            emit_comprehension_skill_evidence,
        )

        await emit_comprehension_skill_evidence(
            self.repository,
            child_id=child_id_val,
            parent_id=actor_id,
            answer_id=getattr(record, "Id", None),
            question_type=question_type_val,
            is_correct=is_correct,
        )
        return TutorAnswerResultRead(
            answer_id=record.Id,
            question_id=question_id_val,
            submitted_answer=answer,
            is_correct=is_correct,
            score=1.0 if is_correct else 0.0,
            feedback_code="CORRECT" if is_correct else "TRY_AGAIN",
            story_hint=story_hint,
        )
