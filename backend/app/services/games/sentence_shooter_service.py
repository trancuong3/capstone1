from __future__ import annotations

import random
import unicodedata
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
    LearningMode,
    SentenceShooterAbandonRead,
    SentenceShooterBookRead,
    SentenceShooterHintRead,
    SentenceShooterNextRoundRead,
    SentenceShooterPromptSlot,
    SentenceShooterResultRead,
    SentenceShooterRoundRead,
    SentenceShooterRoundToken,
    SentenceShooterSessionCreate,
    SentenceShooterSessionRead,
    SentenceShooterShotRead,
    resolve_shot_request_uuid,
)
from app.services.games.scoring import stars_for_round
from app.services.games.sentence_extraction import ExtractedSentence, extract_verified_sentences, normalize_token
from app.services.games.sentence_shuffling import shuffle_token_ids


DIFFICULTY_LENGTHS: dict[str, tuple[int, int]] = {
    "easy": (3, 5),
    "medium": (6, 9),
    "challenge": (10, 14),
}

DIFFICULTY_LEVEL_MAP: dict[str, int] = {
    "easy": 1,
    "medium": 3,
    "challenge": 5,
}

SKILL_KEY_BY_MODE: dict[LearningMode, str] = {
    "WORD_ORDER": "sentence_ordering",
    "FILL_BLANK": "sentence_cloze",
    "GRAMMAR_FOCUS": "grammar_awareness",
}

_FALLBACK_DISTRACTORS_VI: tuple[str, ...] = (
    "hoa",
    "mây",
    "nắng",
    "chim",
    "cây",
    "nhà",
    "trường",
    "bạn",
    "bút",
    "vở",
    "bóng",
    "mưa",
    "sông",
    "núi",
    "vui",
    "đẹp",
)

_VI_CONNECTORS: tuple[str, ...] = (
    "và",
    "nhưng",
    "vì",
    "nên",
    "nếu",
    "thì",
    "hoặc",
    "còn",
    "mà",
    "rồi",
    "khi",
    "để",
    "tuy",
    "nhờ",
    "với",
    "cùng",
    "cũng",
    "vẫn",
    "đang",
    "đã",
    "sẽ",
)

_VI_CONNECTOR_TIPS: dict[str, str] = {
    "đang": 'Từ "đang" cho biết hoạt động diễn ra ngay lúc nói.',
    "đã": 'Từ "đã" chỉ việc đã xảy ra trước đó trong câu kể.',
    "sẽ": 'Từ "sẽ" chỉ việc sắp diễn ra trong tương lai.',
    "và": 'Từ nối "và" giúp nối hai ý hoặc hoạt động cùng nhau thật mượt mà.',
    "cùng": 'Từ "cùng" diễn tả việc làm chung giữa các nhân vật.',
    "với": 'Từ "với" giúp nối nhân vật hoặc sự vật đi kèm trong câu.',
    "nhưng": 'Từ nối "nhưng" dùng để nối hai ý đối lập nhau trong câu.',
    "tuy": 'Từ nối "tuy" mở đầu vế câu nêu điều kiện trái ngược.',
    "mà": 'Từ nối "mà" giúp liên kết ý bất ngờ hoặc đối chiếu trong câu.',
    "vì": 'Từ nối "vì" dùng để giải thích nguyên nhân của sự việc.',
    "nên": 'Từ nối "nên" dùng để nêu kết quả của một nguyên nhân.',
    "nhờ": 'Từ "nhờ" nêu nguyên nhân tốt đẹp giúp đạt được kết quả.',
    "nếu": 'Từ nối "nếu" nêu điều kiện giả thiết trong câu.',
    "thì": 'Từ nối "thì" nối kết quả đi sau điều kiện trong câu.',
    "hoặc": 'Từ nối "hoặc" dùng khi chọn một trong các khả năng.',
    "rồi": 'Từ nối "rồi" chỉ thứ tự việc xảy ra tiếp theo.',
    "khi": 'Từ "khi" giúp xác định thời điểm diễn ra sự việc.',
    "để": 'Từ "để" dùng để nêu mục đích của một hành động.',
}

_VI_ACTION_WORDS: frozenset[str] = frozenset(
    {
        "đọc",
        "viết",
        "học",
        "chơi",
        "xem",
        "nghe",
        "nói",
        "hát",
        "vẽ",
        "chạy",
        "nhảy",
        "đi",
        "ăn",
        "uống",
        "ngủ",
        "cười",
        "bay",
        "bơi",
        "trồng",
        "tưới",
        "giúp",
        "tặng",
        "kể",
        "hỏi",
        "mở",
        "đóng",
        "tìm",
        "nhìn",
        "gọi",
        "thích",
        "yêu",
        "làm",
        "mang",
        "cầm",
        "đặt",
        "bắt",
        "quét",
        "rửa",
    }
)

_VI_NON_ACTION_DISTRACTORS: tuple[str, ...] = (
    "chiếc",
    "mây",
    "bàn",
    "ghế",
    "đèn",
    "lá",
    "hoa",
    "cửa",
)

_TERMINAL_PUNCT_TIPS: dict[str, str] = {
    "?": "Dấu chấm hỏi (?) đặt cuối câu dùng để hỏi điều bé muốn biết.",
    "!": "Dấu chấm than (!) đặt cuối câu thể hiện cảm xúc vui mừng hoặc ngạc nhiên.",
    ".": "Dấu chấm (.) đặt cuối câu kể để báo hiệu câu đã trọn ý.",
}


def _clean_display_word(raw: str) -> str:
    text = unicodedata.normalize("NFC", raw).strip()
    while text and unicodedata.category(text[0]).startswith(("P", "S")):
        text = text[1:]
    while text and unicodedata.category(text[-1]).startswith(("P", "S")):
        text = text[:-1]
    return text or raw.strip()


def _extract_round_meta(tokens_snapshot: Any) -> dict[str, Any]:
    if isinstance(tokens_snapshot, list):
        for item in tokens_snapshot:
            if isinstance(item, dict) and item.get("_v4_meta") is True:
                return item
    return {}


@dataclass
class _PageSource:
    book: Book
    page: BookPage
    revision: PageRevision
    words: list[PageRevisionWord]


@dataclass
class _PreparedRound:
    expected_ids: list[UUID]
    shuffled_ids: list[UUID]
    tokens_snapshot: list[dict[str, Any]]
    practiced_difficult_words: list[str]
    learning_mode: LearningMode


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

    @staticmethod
    def _matched_difficult_words(
        sentence: ExtractedSentence,
        focus_set: set[str],
    ) -> list[str]:
        if not focus_set:
            return []
        matched: list[str] = []
        seen: set[str] = set()
        for token in sentence.tokens:
            norm = normalize_token(token.text)
            if norm and norm in focus_set and norm not in seen:
                seen.add(norm)
                matched.append(_clean_display_word(token.text))
        return matched

    @classmethod
    def _select_prioritized_candidates(
        cls,
        candidates: list[tuple[_PageSource, ExtractedSentence]],
        total_rounds: int,
        focus_set: set[str],
        rng: random.SystemRandom,
        *,
        preferred_page_id: UUID | None = None,
    ) -> list[tuple[_PageSource, ExtractedSentence]]:
        if not focus_set and preferred_page_id is None:
            return rng.sample(candidates, total_rounds)

        buckets: dict[tuple[int, int], list[tuple[_PageSource, ExtractedSentence]]] = defaultdict(list)
        for item in candidates:
            page_boost = 1 if preferred_page_id is not None and item[0].page.Id == preferred_page_id else 0
            score = len(cls._matched_difficult_words(item[1], focus_set))
            buckets[(page_boost, score)].append(item)

        chosen: list[tuple[_PageSource, ExtractedSentence]] = []
        for bucket_key in sorted(buckets.keys(), reverse=True):
            group = list(buckets[bucket_key])
            rng.shuffle(group)
            needed = total_rounds - len(chosen)
            chosen.extend(group[:needed])
            if len(chosen) >= total_rounds:
                break
        return chosen

    @staticmethod
    def _pick_distractors(
        *,
        count: int,
        excluded_normalized: set[str],
        book_pool: list[str],
        fallback_pool: tuple[str, ...],
        rng: random.SystemRandom,
    ) -> list[tuple[UUID, str]]:
        chosen: list[tuple[UUID, str]] = []
        used = set(excluded_normalized)
        shuffled_book = list(book_pool)
        rng.shuffle(shuffled_book)
        shuffled_fallback = list(fallback_pool)
        rng.shuffle(shuffled_fallback)

        for word in [*shuffled_book, *shuffled_fallback]:
            clean = _clean_display_word(word)
            norm = normalize_token(clean)
            if not norm or norm in used:
                continue
            used.add(norm)
            chosen.append((uuid4(), clean))
            if len(chosen) >= count:
                break
        return chosen

    @classmethod
    def _prepare_round(
        cls,
        sentence: ExtractedSentence,
        *,
        learning_mode: LearningMode,
        difficulty: Difficulty,
        focus_set: set[str],
        book_word_pool: list[str],
        rng: random.SystemRandom,
    ) -> _PreparedRound:
        practiced = cls._matched_difficult_words(sentence, focus_set)
        if learning_mode == "WORD_ORDER":
            expected_ids = [token.token_id for token in sentence.tokens]
            shuffled_ids = shuffle_token_ids(expected_ids, rng=rng)
            tokens_snapshot: list[dict[str, Any]] = [
                {
                    "id": str(token.token_id),
                    "text": token.text,
                    "is_difficult_word": normalize_token(token.text) in focus_set,
                }
                for token in sentence.tokens
            ]
            tokens_snapshot.append(
                {
                    "_v4_meta": True,
                    "learning_mode": "WORD_ORDER",
                    "prompt_slots": [],
                    "practiced_difficult_words": practiced,
                    "grammar_tip": None,
                    "prompt_hint": None,
                }
            )
            return _PreparedRound(
                expected_ids=expected_ids,
                shuffled_ids=shuffled_ids,
                tokens_snapshot=tokens_snapshot,
                practiced_difficult_words=practiced,
                learning_mode="WORD_ORDER",
            )

        if learning_mode == "FILL_BLANK":
            blank_count = 1 if difficulty == "easy" or len(sentence.tokens) < 5 else 2
            scored_indices: list[tuple[int, int]] = []
            for idx, token in enumerate(sentence.tokens):
                norm = normalize_token(token.text)
                is_diff = 1 if norm in focus_set else 0
                is_non_first = 1 if idx > 0 else 0
                has_length = 1 if len(norm) >= 2 else 0
                scored_indices.append((is_diff * 10 + has_length * 3 + is_non_first, idx))
            scored_indices.sort(key=lambda pair: (-pair[0], pair[1]))
            blank_indices = sorted(idx for _, idx in scored_indices[:blank_count])
            blank_set = set(blank_indices)

            expected_tokens = [sentence.tokens[idx] for idx in blank_indices]
            expected_ids = [token.token_id for token in expected_tokens]
            excluded_norms = {normalize_token(token.text) for token in sentence.tokens}
            distractor_count = 3 if len(expected_ids) == 1 else 3
            distractors = cls._pick_distractors(
                count=distractor_count,
                excluded_normalized=excluded_norms,
                book_pool=book_word_pool,
                fallback_pool=_FALLBACK_DISTRACTORS_VI,
                rng=rng,
            )
            choice_ids = [*expected_ids, *(d_id for d_id, _ in distractors)]
            shuffled_ids = shuffle_token_ids(choice_ids, rng=rng)

            prompt_slots = [
                {
                    "position": idx,
                    "text": None if idx in blank_set else token.text,
                    "is_blank": idx in blank_set,
                    "is_difficult_word": normalize_token(token.text) in focus_set,
                }
                for idx, token in enumerate(sentence.tokens)
            ]
            answer_words = [_clean_display_word(token.text) for token in expected_tokens]
            if len(answer_words) == 1:
                grammar_tip = f'Từ "{answer_words[0]}" giúp câu có nghĩa trọn vẹn và tự nhiên hơn.'
                prompt_hint = "Đọc kỹ câu và bắn từ đúng vào chỗ trống nhé!"
            else:
                grammar_tip = (
                    f'Hai từ "{answer_words[0]}" và "{answer_words[1]}" giúp câu đầy đủ và rõ ý hơn.'
                )
                prompt_hint = "Bắn lần lượt các từ phù hợp vào từng chỗ trống nhé!"

            tokens_snapshot = [
                {"id": str(token.token_id), "text": token.text, "is_difficult_word": False}
                for token in expected_tokens
            ] + [
                {"id": str(d_id), "text": d_text, "is_difficult_word": False, "is_distractor": True}
                for d_id, d_text in distractors
            ]
            tokens_snapshot.append(
                {
                    "_v4_meta": True,
                    "learning_mode": "FILL_BLANK",
                    "prompt_slots": prompt_slots,
                    "practiced_difficult_words": practiced,
                    "grammar_tip": grammar_tip,
                    "prompt_hint": prompt_hint,
                }
            )
            return _PreparedRound(
                expected_ids=expected_ids,
                shuffled_ids=shuffled_ids,
                tokens_snapshot=tokens_snapshot,
                practiced_difficult_words=practiced,
                learning_mode="FILL_BLANK",
            )

        # GRAMMAR_FOCUS: focus on Vietnamese punctuation, connectors, or action words.
        last_idx = len(sentence.tokens) - 1
        last_text = sentence.tokens[last_idx].text
        last_punct = last_text[-1] if last_text and last_text[-1] in ".!?" else ""

        target_idx: int | None = None
        focus_kind = "structure"
        for idx, token in enumerate(sentence.tokens):
            norm = normalize_token(token.text)
            if norm in _VI_CONNECTORS:
                target_idx = idx
                focus_kind = "connector"
                break

        if last_punct in {"?", "!"}:
            target_idx = last_idx
            focus_kind = "punctuation"
        elif target_idx is None:
            for idx, token in enumerate(sentence.tokens):
                norm = normalize_token(token.text)
                if norm in _VI_ACTION_WORDS:
                    target_idx = idx
                    focus_kind = "action"
                    break
        if target_idx is None and last_punct == ".":
            target_idx = last_idx
            focus_kind = "punctuation"
        if target_idx is None:
            target_idx = min(len(sentence.tokens) - 1, max(1, len(sentence.tokens) // 2))
            focus_kind = "structure"

        target_token = sentence.tokens[target_idx]
        target_norm = normalize_token(target_token.text)
        target_clean = _clean_display_word(target_token.text)
        expected_ids = [target_token.token_id]

        distractors: list[tuple[UUID, str]] = []
        if focus_kind == "punctuation":
            base_word = target_token.text[:-1] if last_punct else target_token.text
            alt_marks = [mark for mark in ("?", "!", ",", ".") if mark != last_punct]
            for mark in alt_marks[:3]:
                distractors.append((uuid4(), f"{base_word}{mark}"))
            grammar_tip = _TERMINAL_PUNCT_TIPS.get(
                last_punct,
                "Dấu câu ở cuối câu giúp người đọc hiểu rõ sắc thái và ngắt nghỉ đúng.",
            )
            prompt_hint = "Chọn từ có dấu câu kết thúc phù hợp với ý nghĩa của câu nhé!"
        elif focus_kind == "connector":
            excluded = {normalize_token(t.text) for t in sentence.tokens} | {target_norm}
            connector_choices = tuple(c for c in _VI_CONNECTORS if c != target_norm)
            distractors = cls._pick_distractors(
                count=3,
                excluded_normalized=excluded,
                book_pool=[],
                fallback_pool=connector_choices,
                rng=rng,
            )
            grammar_tip = _VI_CONNECTOR_TIPS.get(
                target_norm,
                f'Từ nối "{target_clean}" giúp các ý trong câu liên kết mạch lạc và dễ hiểu hơn.',
            )
            prompt_hint = "Chọn từ nối hoặc từ chỉ thời gian phù hợp để ghép vào câu nhé!"
        elif focus_kind == "action":
            excluded = {normalize_token(t.text) for t in sentence.tokens} | {target_norm}
            distractors = cls._pick_distractors(
                count=3,
                excluded_normalized=excluded,
                book_pool=[],
                fallback_pool=_VI_NON_ACTION_DISTRACTORS,
                rng=rng,
            )
            grammar_tip = f'Từ "{target_clean}" là từ chỉ hoạt động giúp câu kể rõ nhân vật đang làm gì.'
            prompt_hint = "Chọn từ chỉ hoạt động phù hợp với câu nhé!"
        else:
            excluded = {normalize_token(t.text) for t in sentence.tokens} | {target_norm}
            distractors = cls._pick_distractors(
                count=3,
                excluded_normalized=excluded,
                book_pool=book_word_pool,
                fallback_pool=_FALLBACK_DISTRACTORS_VI,
                rng=rng,
            )
            grammar_tip = f'Từ "{target_clean}" đặt đúng vị trí giúp câu tiếng Việt tròn nghĩa và tự nhiên.'
            prompt_hint = "Chọn từ đúng ngữ pháp để hoàn thành câu nhé!"

        choice_ids = [*expected_ids, *(d_id for d_id, _ in distractors)]
        shuffled_ids = shuffle_token_ids(choice_ids, rng=rng)
        prompt_slots = [
            {
                "position": idx,
                "text": None if idx == target_idx else token.text,
                "is_blank": idx == target_idx,
                "is_difficult_word": normalize_token(token.text) in focus_set,
            }
            for idx, token in enumerate(sentence.tokens)
        ]
        tokens_snapshot = [
            {"id": str(target_token.token_id), "text": target_token.text, "is_difficult_word": False}
        ] + [
            {"id": str(d_id), "text": d_text, "is_difficult_word": False, "is_distractor": True}
            for d_id, d_text in distractors
        ]
        tokens_snapshot.append(
            {
                "_v4_meta": True,
                "learning_mode": "GRAMMAR_FOCUS",
                "prompt_slots": prompt_slots,
                "practiced_difficult_words": practiced,
                "grammar_tip": grammar_tip,
                "prompt_hint": prompt_hint,
            }
        )
        return _PreparedRound(
            expected_ids=expected_ids,
            shuffled_ids=shuffled_ids,
            tokens_snapshot=tokens_snapshot,
            practiced_difficult_words=practiced,
            learning_mode="GRAMMAR_FOCUS",
        )

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
        if hasattr(self.repository.verified_word_rows, "__code__") and (
            "parent_id" in self.repository.verified_word_rows.__code__.co_varnames
        ):
            rows = await self.repository.verified_word_rows(
                child_grade, payload.book_id, parent_id=actor_id
            )
        else:
            rows = await self.repository.verified_word_rows(child_grade, payload.book_id)
        sources = self._group_page_sources(rows)
        candidates = self._sentences(sources, payload.difficulty)
        if not candidates:
            if hasattr(self.repository.book_for_session, "__code__") and (
                "parent_id" in self.repository.book_for_session.__code__.co_varnames
            ):
                book = await self.repository.book_for_session(
                    payload.book_id, parent_id=actor_id
                )
            else:
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

        # Gather active difficult words safely (explicit payload + child practice history).
        repo_difficult_words: list[str] = []
        if hasattr(self.repository, "active_difficult_words"):
            repo_difficult_words = await self.repository.active_difficult_words(child_id)
        focus_set = {
            norm
            for raw in [*payload.focus_words, *repo_difficult_words]
            if (norm := normalize_token(str(raw)))
        }

        rng = random.SystemRandom()
        chosen = self._select_prioritized_candidates(
            candidates,
            payload.total_rounds,
            focus_set,
            rng,
            preferred_page_id=payload.book_page_id,
        )
        book_word_pool = [
            token.text
            for _, sentence in candidates
            for token in sentence.tokens
        ]

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
        session_practiced_words: list[str] = []
        seen_practiced: set[str] = set()
        for round_number, (source, sentence) in enumerate(chosen, start=1):
            prepared = self._prepare_round(
                sentence,
                learning_mode=payload.learning_mode,
                difficulty=payload.difficulty,
                focus_set=focus_set,
                book_word_pool=book_word_pool,
                rng=rng,
            )
            for word in prepared.practiced_difficult_words:
                norm = normalize_token(word)
                if norm and norm not in seen_practiced:
                    seen_practiced.add(norm)
                    session_practiced_words.append(word)
            game_rounds.append(
                GameRound(
                    Id=uuid4(),
                    GameSessionId=game_session_id,
                    RoundNumber=round_number,
                    BookPageId=source.page.Id,
                    PageRevisionId=source.revision.Id,
                    SentenceSnapshot=sentence.text,
                    TokensSnapshot=prepared.tokens_snapshot,
                    ExpectedTokenIds=[str(token_id) for token_id in prepared.expected_ids],
                    ShuffledTokenIds=[str(token_id) for token_id in prepared.shuffled_ids],
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
            learning_mode=payload.learning_mode,
            total_rounds=payload.total_rounds,
            completed_rounds=0,
            total_stars=0,
            practiced_difficult_words=session_practiced_words,
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
        snapshot = game_round.TokensSnapshot or []
        meta = _extract_round_meta(snapshot)
        tokens = {
            str(token["id"]): token
            for token in snapshot
            if isinstance(token, dict) and "id" in token
        }
        shuffled_ids = [str(token_id) for token_id in game_round.ShuffledTokenIds]
        expected_count = len(getattr(game_round, "ExpectedTokenIds", None) or [])
        learning_mode: LearningMode = meta.get("learning_mode", "WORD_ORDER")
        raw_slots = meta.get("prompt_slots") or []
        prompt_slots = [
            SentenceShooterPromptSlot.model_validate(slot)
            for slot in raw_slots
            if isinstance(slot, dict)
        ]
        practiced = [str(w) for w in (meta.get("practiced_difficult_words") or []) if str(w).strip()]
        return SentenceShooterRoundRead(
            round_id=game_round.Id,
            round_number=game_round.RoundNumber,
            token_count=expected_count if expected_count > 0 else len(shuffled_ids),
            tokens=[
                SentenceShooterRoundToken(
                    id=UUID(token_id),
                    text=str(tokens[token_id]["text"]),
                    is_difficult_word=bool(tokens[token_id].get("is_difficult_word", False)),
                )
                for token_id in shuffled_ids
                if token_id in tokens
            ],
            learning_mode=learning_mode,
            prompt_slots=prompt_slots,
            practiced_difficult_words=practiced,
            prompt_hint=meta.get("prompt_hint"),
        )

    async def shoot(
        self,
        actor_id: UUID,
        session_id: UUID,
        round_id: UUID,
        token_id: UUID,
        request_id: UUID | None,
        *,
        client_shot_id: str | None = None,
    ) -> SentenceShooterShotRead:
        dedupe_request_id = resolve_shot_request_uuid(request_id, client_shot_id)
        bundle = (
            await self.repository.load_shot_bundle(
                actor_id,
                session_id,
                round_id,
                dedupe_request_id,
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
            duplicate = await self.repository.attempt(session_id, dedupe_request_id)
            if duplicate is not None:
                return SentenceShooterShotRead.model_validate(duplicate.ResultSnapshot)
            if game_session.Status != "IN_PROGRESS":
                raise HTTPException(status_code=409, detail="SESSION_NOT_ACTIVE")

            game_round = await self.repository.game_round(session_id, round_id, lock=True)
            if game_round is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if game_round.Status != "IN_PROGRESS" or game_round.RoundNumber != game_session.CompletedRounds + 1:
                raise HTTPException(status_code=409, detail="ROUND_NOT_ACTIVE")

        round_meta = _extract_round_meta(game_round.TokensSnapshot)
        learning_mode: LearningMode = round_meta.get("learning_mode", "WORD_ORDER")
        practiced_words = [
            str(word)
            for word in (round_meta.get("practiced_difficult_words") or [])
            if str(word).strip()
        ]
        round_grammar_tip = round_meta.get("grammar_tip")

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
        evidence_entries: list[dict[str, Any]] = []
        if round_completed:
            game_round.Status = "COMPLETED"
            game_round.CompletedAt = datetime.now(timezone.utc)
            stars_awarded = stars_for_round(game_round.MistakeCount, game_round.HintCount)
            game_round.Stars = stars_awarded
            game_session.CompletedRounds += 1
            game_session.TotalStars += stars_awarded
            completed_sentence = game_round.SentenceSnapshot

            # Snapshot fields before commit for learning_skill_evidence persistence.
            total_attempts = max(1, game_round.CorrectCount + game_round.MistakeCount)
            raw_accuracy = game_round.CorrectCount / total_attempts
            hint_penalty = min(0.3, game_round.HintCount * 0.1)
            score_normalized = round(max(0.0, min(1.0, raw_accuracy - hint_penalty)), 4)
            confidence = 0.85 if game_round.HintCount == 0 else 0.7
            difficulty_level = DIFFICULTY_LEVEL_MAP.get(str(game_session.Difficulty), 1)
            evidence_meta = {
                "session_id": str(game_session.Id),
                "round_number": int(game_round.RoundNumber),
                "learning_mode": learning_mode,
                "mistakes": int(game_round.MistakeCount),
                "hints": int(game_round.HintCount),
                "stars": int(stars_awarded),
            }
            primary_skill = SKILL_KEY_BY_MODE.get(learning_mode, "sentence_ordering")
            evidence_entries.append(
                {
                    "child_id": game_session.ChildProfileId,
                    "parent_id": actor_id,
                    "skill_key": primary_skill,
                    "source_record_id": str(game_round.Id),
                    "evidence_type": "OBSERVED",
                    "score_normalized": score_normalized,
                    "confidence": confidence,
                    "difficulty_level": difficulty_level,
                    "practice_words": practiced_words,
                    "metadata_json": evidence_meta,
                }
            )
            if practiced_words:
                evidence_entries.append(
                    {
                        "child_id": game_session.ChildProfileId,
                        "parent_id": actor_id,
                        "skill_key": "difficult_word_mastery",
                        "source_record_id": str(game_round.Id),
                        "evidence_type": "OBSERVED",
                        "score_normalized": score_normalized,
                        "confidence": confidence,
                        "difficulty_level": difficulty_level,
                        "practice_words": practiced_words,
                        "metadata_json": evidence_meta,
                    }
                )

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

        authoritative_score = game_session.CorrectCount * 10 + game_session.TotalStars * 5
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
            "score": authoritative_score,
            "completed_sentence": completed_sentence,
            "next_round": next_round_payload,
            "message": message,
            "client_shot_id": client_shot_id,
            "learning_mode": learning_mode,
            "grammar_tip": round_grammar_tip if round_completed else None,
            "practiced_difficult_words": practiced_words if round_completed else [],
        }
        self.repository.add(
            GameAttempt(
                Id=uuid4(),
                GameSessionId=game_session.Id,
                GameRoundId=game_round.Id,
                RequestId=dedupe_request_id,
                TokenId=token_id,
                IsCorrect=is_correct,
                ResultSnapshot=result_snapshot,
            )
        )
        await self.repository.commit()
        if evidence_entries and hasattr(self.repository, "record_learning_evidence"):
            await self.repository.record_learning_evidence(evidence_entries)
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

        learning_mode: LearningMode = "WORD_ORDER"
        practiced_words: list[str] = []
        seen_words: set[str] = set()
        if hasattr(self.repository, "rounds"):
            try:
                session_rounds = await self.repository.rounds(game_session.Id)
                for rnd in session_rounds:
                    meta = _extract_round_meta(rnd.TokensSnapshot)
                    if meta.get("learning_mode") in ("WORD_ORDER", "FILL_BLANK", "GRAMMAR_FOCUS"):
                        learning_mode = meta["learning_mode"]
                    for word in meta.get("practiced_difficult_words") or []:
                        norm = normalize_token(str(word))
                        if norm and norm not in seen_words:
                            seen_words.add(norm)
                            practiced_words.append(str(word))
            except Exception:
                pass

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
            learning_mode=learning_mode,
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
            practiced_difficult_words=practiced_words,
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
