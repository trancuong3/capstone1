from __future__ import annotations

import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException

from app.models import Book, BookPage, GameAttempt, GameRound, GameSession, PageRevision, PageRevisionWord
from app.repositories.sentence_shooter_repository import SentenceShooterRepository
from app.schemas.sentence_shooter import (
    Difficulty,
    SentenceShooterAbandonRead,
    SentenceShooterBookRead,
    SentenceShooterHintRead,
    SentenceShooterNextRoundRead,
    SentenceShooterResultRead,
    SentenceShooterRoundRead,
    SentenceShooterRoundToken,
    SentenceShooterSessionCreate,
    SentenceShooterSessionRead,
    SentenceShooterShotRead,
)
from app.services.games.scoring import stars_for_round
from app.services.games.sentence_extraction import ExtractedSentence, extract_verified_sentences, normalize_token
from app.services.games.sentence_shuffling import shuffle_token_ids


DIFFICULTY_LENGTHS: dict[str, tuple[int, int]] = {
    "easy": (3, 5),
    "medium": (6, 9),
    "challenge": (10, 14),
}


@dataclass
class _PageSource:
    book: Book
    page: BookPage
    revision: PageRevision
    words: list[PageRevisionWord]


class SentenceShooterService:
    def __init__(self, repository: SentenceShooterRepository):
        self.repository = repository

    async def _require_parent(self, actor_id: UUID) -> None:
        if await self.repository.profile_role(actor_id) != "parent":
            raise HTTPException(status_code=403, detail="Parent access required")

    async def _owned_child(self, actor_id: UUID, child_id: UUID):
        child = await self.repository.child_owned_by(child_id, actor_id)
        if child is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        return child

    @staticmethod
    def _group_page_sources(
        rows: list[tuple[Book, BookPage, PageRevision, PageRevisionWord]],
    ) -> list[_PageSource]:
        groups: dict[tuple[UUID, UUID, UUID], _PageSource] = {}
        for book, page, revision, word in rows:
            key = (book.Id, page.Id, revision.Id)
            source = groups.get(key)
            if source is None:
                source = _PageSource(book=book, page=page, revision=revision, words=[])
                groups[key] = source
            source.words.append(word)
        return list(groups.values())

    @staticmethod
    def _book_read(book: Book, available_rounds: int) -> SentenceShooterBookRead:
        return SentenceShooterBookRead(
            id=book.Id,
            name=book.Name,
            title=book.Title,
            author=book.Author,
            min_grade=book.MinGrade,
            max_grade=book.MaxGrade,
            available_rounds=available_rounds,
        )

    def _sentences(
        self,
        sources: list[_PageSource],
        difficulty: Difficulty,
    ) -> list[tuple[_PageSource, ExtractedSentence]]:
        minimum, maximum = DIFFICULTY_LENGTHS[difficulty]
        candidates: list[tuple[_PageSource, ExtractedSentence]] = []
        seen_sentences: set[tuple[str, ...]] = set()
        for source in sources:
            sentences = extract_verified_sentences(
                source.revision.VerifiedText,
                source.words,
                min_tokens=minimum,
                max_tokens=maximum,
            )
            for sentence in sentences:
                key = tuple(normalize_token(token.text) for token in sentence.tokens)
                if key in seen_sentences:
                    continue
                seen_sentences.add(key)
                candidates.append((source, sentence))
        return candidates

    async def list_books(
        self,
        actor_id: UUID,
        child_id: UUID,
        difficulty: Difficulty,
        total_rounds: int = 3,
    ) -> list[SentenceShooterBookRead]:
        await self._require_parent(actor_id)
        child = await self._owned_child(actor_id, child_id)
        if not 1 <= total_rounds <= 5:
            raise HTTPException(status_code=422, detail="Invalid round count")

        rows = await self.repository.verified_word_rows(child.Grade)
        sources = self._group_page_sources(rows)
        by_book: dict[UUID, tuple[Book, int]] = {}
        seen_by_book: dict[UUID, set[tuple[str, ...]]] = defaultdict(set)
        for source in sources:
            book_id = source.book.Id
            count = by_book.get(book_id, (source.book, 0))[1]
            for _, sentence in self._sentences([source], difficulty):
                key = tuple(normalize_token(token.text) for token in sentence.tokens)
                if key in seen_by_book[book_id]:
                    continue
                seen_by_book[book_id].add(key)
                count += 1
            by_book[book_id] = (source.book, count)

        result = [
            self._book_read(book, count)
            for book, count in by_book.values()
            if count >= total_rounds
        ]
        return sorted(result, key=lambda item: (item.title.casefold(), str(item.id)))

    async def create_session(
        self,
        actor_id: UUID,
        payload: SentenceShooterSessionCreate,
    ) -> SentenceShooterSessionRead:
        await self._require_parent(actor_id)
        child = await self._owned_child(actor_id, payload.child_id)
        # Keep these values across verified_word_rows(), which ends its read
        # transaction with rollback and would expire ORM instances.
        child_id = child.Id
        child_grade = child.Grade
        rows = await self.repository.verified_word_rows(child_grade, payload.book_id)
        sources = self._group_page_sources(rows)
        candidates = self._sentences(sources, payload.difficulty)
        if not candidates:
            book = await self.repository.book_for_session(payload.book_id)
            if (
                book is None
                or book.LifecycleStatus != "ACTIVE"
                or not book.MinGrade <= child_grade <= book.MaxGrade
            ):
                raise HTTPException(status_code=404, detail="Resource not found")
            raise HTTPException(status_code=409, detail="INSUFFICIENT_CONTENT")
        book = candidates[0][0].book
        if book.Id != payload.book_id or book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=404, detail="Resource not found")
        if not book.MinGrade <= child_grade <= book.MaxGrade:
            raise HTTPException(status_code=404, detail="Resource not found")
        if len(candidates) < payload.total_rounds:
            raise HTTPException(status_code=409, detail="INSUFFICIENT_CONTENT")

        chosen = random.SystemRandom().sample(candidates, payload.total_rounds)
        game_session_id = uuid4()
        game_session = GameSession(
            Id=game_session_id,
            ChildProfileId=child_id,
            BookId=book.Id,
            Difficulty=payload.difficulty,
            TotalRounds=payload.total_rounds,
            CompletedRounds=0,
            CorrectCount=0,
            MistakeCount=0,
            HintCount=0,
            TotalStars=0,
            Status="IN_PROGRESS",
            StartedAt=datetime.now(timezone.utc),
        )
        game_rounds: list[GameRound] = []
        for round_number, (source, sentence) in enumerate(chosen, start=1):
            expected_ids = [token.token_id for token in sentence.tokens]
            shuffled_ids = shuffle_token_ids(expected_ids)
            tokens_snapshot = [
                {"id": str(token.token_id), "text": token.text}
                for token in sentence.tokens
            ]
            game_rounds.append(
                GameRound(
                    Id=uuid4(),
                    GameSessionId=game_session_id,
                    RoundNumber=round_number,
                    BookPageId=source.page.Id,
                    PageRevisionId=source.revision.Id,
                    SentenceSnapshot=sentence.text,
                    TokensSnapshot=tokens_snapshot,
                    ExpectedTokenIds=[str(token_id) for token_id in expected_ids],
                    ShuffledTokenIds=[str(token_id) for token_id in shuffled_ids],
                    NextExpectedPosition=0,
                    CorrectCount=0,
                    MistakeCount=0,
                    HintCount=0,
                    Stars=0,
                    Status="IN_PROGRESS",
                )
            )

        response = SentenceShooterSessionRead(
            session_id=game_session_id,
            book=self._book_read(book, len(candidates)),
            difficulty=payload.difficulty,
            total_rounds=payload.total_rounds,
            completed_rounds=0,
            total_stars=0,
            round=self._public_round(game_rounds[0]),
        )
       # 1. Insert GameSession trước
        self.repository.add(game_session)
        await self.repository.flush()

        # 2. Sau khi GameSession đã được INSERT,
        #    mới thêm các GameRound tham chiếu đến nó
        self.repository.add_all(game_rounds)

        # 3. Commit toàn bộ transaction
        await self.repository.commit()
        return response

    @staticmethod
    def _public_round(game_round: GameRound) -> SentenceShooterRoundRead:
        tokens = {str(token["id"]): token for token in game_round.TokensSnapshot}
        shuffled_ids = [str(token_id) for token_id in game_round.ShuffledTokenIds]
        return SentenceShooterRoundRead(
            round_id=game_round.Id,
            round_number=game_round.RoundNumber,
            token_count=len(shuffled_ids),
            tokens=[
                SentenceShooterRoundToken(
                    id=UUID(token_id),
                    text=str(tokens[token_id]["text"]),
                )
                for token_id in shuffled_ids
                if token_id in tokens
            ],
        )

    async def shoot(
        self,
        actor_id: UUID,
        session_id: UUID,
        round_id: UUID,
        token_id: UUID,
        request_id: UUID,
    ) -> SentenceShooterShotRead:
        bundle = (
            await self.repository.load_shot_bundle(
                actor_id,
                session_id,
                round_id,
                request_id,
            )
            if hasattr(self.repository, "load_shot_bundle")
            else None
        )
        if bundle is not None:
            game_session, game_round, duplicate_snapshot = bundle
            if duplicate_snapshot is not None:
                await self.repository.rollback()
                return SentenceShooterShotRead.model_validate(duplicate_snapshot)
            if game_session.Status != "IN_PROGRESS":
                raise HTTPException(status_code=409, detail="SESSION_NOT_ACTIVE")
            if game_round.Status != "IN_PROGRESS" or game_round.RoundNumber != game_session.CompletedRounds + 1:
                raise HTTPException(status_code=409, detail="ROUND_NOT_ACTIVE")
        else:
            await self._require_parent(actor_id)
            game_session = await self.repository.session_for_parent(
                session_id,
                actor_id,
                lock=True,
            )
            if game_session is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            duplicate = await self.repository.attempt(session_id, request_id)
            if duplicate is not None:
                return SentenceShooterShotRead.model_validate(duplicate.ResultSnapshot)
            if game_session.Status != "IN_PROGRESS":
                raise HTTPException(status_code=409, detail="SESSION_NOT_ACTIVE")

            game_round = await self.repository.game_round(session_id, round_id, lock=True)
            if game_round is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if game_round.Status != "IN_PROGRESS" or game_round.RoundNumber != game_session.CompletedRounds + 1:
                raise HTTPException(status_code=409, detail="ROUND_NOT_ACTIVE")

        shuffled_ids = {str(value) for value in game_round.ShuffledTokenIds}
        expected_ids = [str(value) for value in game_round.ExpectedTokenIds]
        selected_id = str(token_id)
        if selected_id not in shuffled_ids:
            raise HTTPException(status_code=422, detail="TOKEN_NOT_IN_SESSION")
        if selected_id in expected_ids[: game_round.NextExpectedPosition]:
            raise HTTPException(status_code=409, detail="TOKEN_ALREADY_USED")

        target_pos = game_round.NextExpectedPosition
        expected_id_at_pos = expected_ids[target_pos]
        is_correct = selected_id == expected_id_at_pos
        if not is_correct:
            token_text_by_id = {
                str(item["id"]): str(item.get("text") or "").strip().casefold()
                for item in (game_round.TokensSnapshot or [])
                if isinstance(item, dict) and "id" in item
            }
            selected_text = token_text_by_id.get(selected_id, "")
            expected_text = token_text_by_id.get(expected_id_at_pos, "")
            if (
                selected_text
                and selected_text == expected_text
                and selected_id in expected_ids[target_pos + 1 :]
            ):
                swap_idx = expected_ids.index(selected_id, target_pos + 1)
                expected_ids[target_pos], expected_ids[swap_idx] = (
                    expected_ids[swap_idx],
                    expected_ids[target_pos],
                )
                game_round.ExpectedTokenIds = list(expected_ids)
                is_correct = True
        if is_correct:
            game_round.NextExpectedPosition += 1
            game_round.CorrectCount += 1
            game_session.CorrectCount += 1
        else:
            game_round.MistakeCount += 1
            game_session.MistakeCount += 1

        round_completed = game_round.NextExpectedPosition == len(expected_ids)
        stars_awarded = 0
        completed_sentence = None
        next_round_payload: dict[str, Any] | None = None
        if round_completed:
            game_round.Status = "COMPLETED"
            game_round.CompletedAt = datetime.now(timezone.utc)
            stars_awarded = stars_for_round(game_round.MistakeCount, game_round.HintCount)
            game_round.Stars = stars_awarded
            game_session.CompletedRounds += 1
            game_session.TotalStars += stars_awarded
            completed_sentence = game_round.SentenceSnapshot
            if game_session.CompletedRounds == game_session.TotalRounds:
                game_session.Status = "COMPLETED"
                game_session.CompletedAt = datetime.now(timezone.utc)
            else:
                upcoming = None
                if hasattr(self.repository, "next_round_for_number"):
                    upcoming = await self.repository.next_round_for_number(
                        game_session.Id,
                        game_session.CompletedRounds + 1,
                    )
                if upcoming is None:
                    rounds = await self.repository.rounds(game_session.Id)
                    upcoming = next(
                        (
                            candidate
                            for candidate in rounds
                            if candidate.RoundNumber == game_session.CompletedRounds + 1
                            and candidate.Status == "IN_PROGRESS"
                        ),
                        None,
                    )
                if upcoming is not None:
                    next_round_payload = self._public_round(upcoming).model_dump(mode="json")

        if round_completed:
            message = "Hoàn thành câu! Tuyệt lắm!"
        elif is_correct:
            message = "Hay lắm! Tiếp tục nhé!"
        else:
            message = "Thử lại nhé! Bé làm được mà!"

        result_snapshot: dict[str, Any] = {
            "is_correct": is_correct,
            "correct_count": game_round.CorrectCount,
            "token_count": len(expected_ids),
            "mistakes_total": game_session.MistakeCount,
            "completed_rounds": game_session.CompletedRounds,
            "total_stars": game_session.TotalStars,
            "round_completed": round_completed,
            "session_completed": game_session.Status == "COMPLETED",
            "next_expected_position": game_round.NextExpectedPosition,
            "stars_awarded": stars_awarded,
            "completed_sentence": completed_sentence,
            "next_round": next_round_payload,
            "message": message,
        }
        self.repository.add(
            GameAttempt(
                Id=uuid4(),
                GameSessionId=game_session.Id,
                GameRoundId=game_round.Id,
                RequestId=request_id,
                TokenId=token_id,
                IsCorrect=is_correct,
                ResultSnapshot=result_snapshot,
            )
        )
        await self.repository.commit()
        return SentenceShooterShotRead.model_validate(result_snapshot)

    async def hint(
        self,
        actor_id: UUID,
        session_id: UUID,
        round_id: UUID,
    ) -> SentenceShooterHintRead:
        await self._require_parent(actor_id)
        game_session = await self.repository.session_for_parent(session_id, actor_id, lock=True)
        if game_session is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if game_session.Status != "IN_PROGRESS":
            raise HTTPException(status_code=409, detail="SESSION_NOT_ACTIVE")
        game_round = await self.repository.game_round(session_id, round_id, lock=True)
        if (
            game_round is None
            or game_round.Status != "IN_PROGRESS"
            or game_round.RoundNumber != game_session.CompletedRounds + 1
        ):
            raise HTTPException(status_code=409, detail="ROUND_NOT_ACTIVE")
        expected_ids = [str(value) for value in game_round.ExpectedTokenIds]
        target_token_id = UUID(expected_ids[game_round.NextExpectedPosition])
        game_round.HintCount += 1
        game_session.HintCount += 1
        hint_count = game_session.HintCount
        await self.repository.commit()
        return SentenceShooterHintRead(
            target_token_id=target_token_id,
            hint_count=hint_count,
            message="Gợi ý đã làm sáng một từ phù hợp. Bé thử bắn từ đó nhé!",
        )

    async def next_round(
        self,
        actor_id: UUID,
        session_id: UUID,
        completed_round_id: UUID,
    ) -> SentenceShooterNextRoundRead:
        await self._require_parent(actor_id)
        game_session = await self.repository.session_for_parent(session_id, actor_id, lock=False)
        if game_session is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if game_session.Status != "IN_PROGRESS":
            raise HTTPException(status_code=409, detail="SESSION_NOT_ACTIVE")
        completed_round = await self.repository.game_round(
            session_id,
            completed_round_id,
            lock=False,
        )
        if (
            completed_round is None
            or completed_round.Status != "COMPLETED"
            or completed_round.RoundNumber != game_session.CompletedRounds
        ):
            raise HTTPException(status_code=409, detail="ROUND_NOT_COMPLETE")
        rounds = await self.repository.rounds(session_id)
        upcoming = next(
            (
                game_round
                for game_round in rounds
                if game_round.RoundNumber == game_session.CompletedRounds + 1
                and game_round.Status == "IN_PROGRESS"
            ),
            None,
        )
        if upcoming is None:
            raise HTTPException(status_code=409, detail="NO_NEXT_ROUND")
        return SentenceShooterNextRoundRead(
            session_id=game_session.Id,
            completed_rounds=game_session.CompletedRounds,
            total_rounds=game_session.TotalRounds,
            total_stars=game_session.TotalStars,
            round=self._public_round(upcoming),
        )

    async def result(self, actor_id: UUID, session_id: UUID) -> SentenceShooterResultRead:
        bundle = (
            await self.repository.load_result_bundle(actor_id, session_id)
            if hasattr(self.repository, "load_result_bundle")
            else None
        )
        if bundle is not None:
            game_session, book = bundle
        else:
            await self._require_parent(actor_id)
            game_session = await self.repository.session_for_parent(session_id, actor_id)
            if game_session is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            book = await self.repository.book(game_session.BookId)
            if book is None:
                raise HTTPException(status_code=404, detail="Resource not found")
        now = datetime.now(timezone.utc)
        started_at = game_session.StartedAt
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        ended_at = game_session.CompletedAt or now
        if ended_at.tzinfo is None:
            ended_at = ended_at.replace(tzinfo=timezone.utc)
        duration_seconds = max(0, int((ended_at - started_at).total_seconds()))
        return SentenceShooterResultRead(
            session_id=game_session.Id,
            book=self._book_read(book, max(1, game_session.TotalRounds)),
            difficulty=game_session.Difficulty,
            status=game_session.Status,
            total_rounds=game_session.TotalRounds,
            completed_rounds=game_session.CompletedRounds,
            correct_count=game_session.CorrectCount,
            mistakes_total=game_session.MistakeCount,
            hint_count=game_session.HintCount,
            total_stars=game_session.TotalStars,
            duration_seconds=duration_seconds,
            started_at=game_session.StartedAt,
            completed_at=game_session.CompletedAt,
        )

    async def abandon(
        self,
        actor_id: UUID,
        session_id: UUID,
    ) -> SentenceShooterAbandonRead:
        await self._require_parent(actor_id)
        game_session = await self.repository.session_for_parent(session_id, actor_id, lock=True)
        if game_session is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if game_session.Status == "COMPLETED":
            raise HTTPException(status_code=409, detail="SESSION_ALREADY_COMPLETED")
        if game_session.Status == "ABANDONED":
            return SentenceShooterAbandonRead(
                session_id=game_session.Id,
                status="ABANDONED",
            )
        session_id_value = game_session.Id
        game_session.Status = "ABANDONED"
        game_session.CompletedAt = datetime.now(timezone.utc)
        await self.repository.commit()
        return SentenceShooterAbandonRead(
            session_id=session_id_value,
            status="ABANDONED",
        )
