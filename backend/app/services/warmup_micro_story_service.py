"""Lazy Spaced-Repetition Warm-Up Micro-Story Service (Wave 1 Feature #2).

Weaves a child's top due spaced-repetition difficult words (1d -> 3d -> 7d cadence from
`compute_spaced_difficult_words`, falling back to `readingcomparisonreports` + `WORD_RETRY`
via `child_progress.metrics`) into a safe, Grade-appropriate 2-3 sentence Vietnamese micro-story.

Operational & safety guardrails:
- Generated lazily on `/reading-preparation` open (never inside `cron_dispatch_service.py`'s 50s budget).
- Releases PostgreSQL read transaction (`await db.rollback()`) BEFORE any external LLM/safety/TTS call.
- Validates every story deterministically (length <= 280 chars, target-word inclusion, PII/URL/unsafe-term blocklist)
  and optionally via `ChildSafetyOrchestrator` (`ocr_ai/child_safety.py`) when cloud safety is configured.
- Caches per `(child_id, local_date, words_signature)` in `public.child_warmup_stories` with graceful
  `to_regclass` / `42P01` fallback to a bounded 256-entry in-memory LRU if deployed pre-migration.
"""

from __future__ import annotations

from collections import OrderedDict
from datetime import date, datetime, time as day_time, timedelta
import hashlib
import json
import logging
import re
from typing import Any
import unicodedata
from uuid import UUID

import httpx
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.family_pedagogy import ChildWarmupStory
from app.repositories.adaptive_learning_repository import AdaptiveLearningRepository
from app.repositories.child_progress_repository import ChildProgressRepository
from app.schemas.adaptive_learning import WarmupMicroStoryRead
from app.services.adaptive_learning_service import compute_spaced_difficult_words
from app.services.child_progress.metrics import (
    VIETNAM_TZ,
    compute_window,
    top_difficult_words,
)
from app.services.ocr_ai.child_safety import ChildSafetyError, ChildSafetyOrchestrator
from app.services.ocr_ai.config import OcrConfigurationError, OcrCorrectionConfig
from app.services.tutor_questions.config import TutorQuestionConfig

logger = logging.getLogger(__name__)

_MEMORY_STORY_CACHE_MAX = 256
_MEMORY_STORY_CACHE: "OrderedDict[tuple[str, str, str], dict[str, Any]]" = OrderedDict()

_UNSAFE_STORY_PATTERN = re.compile(
    r"(https?://|www\.|@\w+|\b\d{6,}\b|"
    r"ma\s+quỷ|kinh\s+dị|máu\s+me|giết|đánh\s+đập|chết\s+chóc|vũ\s+khí|"
    r"rượu\s+bia|thuốc\s+lá|cờ\s+bạc|bạo\s+lực|tự\s+tử|ngu\s+ngốc)",
    re.IGNORECASE | re.UNICODE,
)

_GRADE_STARTER_WORDS: dict[int, list[str]] = {
    1: ["tia nắng", "cánh cò"],
    2: ["giọt sương", "hàng tre"],
    3: ["cánh đồng", "tiếng sáo"],
    4: ["chân trời", "ước mơ"],
    5: ["hành trình", "tri thức"],
}


def _memory_cache_get(key: tuple[str, str, str]) -> dict[str, Any] | None:
    hit = _MEMORY_STORY_CACHE.get(key)
    if hit is not None:
        _MEMORY_STORY_CACHE.move_to_end(key)
    return dict(hit) if hit is not None else None


def _memory_cache_put(key: tuple[str, str, str], payload: dict[str, Any]) -> None:
    _MEMORY_STORY_CACHE[key] = dict(payload)
    _MEMORY_STORY_CACHE.move_to_end(key)
    while len(_MEMORY_STORY_CACHE) > _MEMORY_STORY_CACHE_MAX:
        _MEMORY_STORY_CACHE.popitem(last=False)


def clear_warmup_story_memory_cache() -> None:
    _MEMORY_STORY_CACHE.clear()


def _words_signature(grade: int, words: list[str]) -> str:
    canonical = "|".join(
        unicodedata.normalize("NFC", w.strip().lower()) for w in words if w.strip()
    )
    raw = f"g{grade}:{canonical}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def build_rule_based_micro_story(
    *,
    grade: int,
    child_alias: str,
    target_words: list[str],
) -> tuple[str, list[str]]:
    clean_words = [unicodedata.normalize("NFC", w.strip()) for w in target_words if w.strip()][:3]
    alias = unicodedata.normalize("NFC", (child_alias or "bé").strip()) or "bé"

    if not clean_words:
        clean_words = list(_GRADE_STARTER_WORDS.get(max(1, min(5, grade)), ["tia nắng", "trang sách"]))

    if len(clean_words) == 1:
        w1 = clean_words[0]
        sentences = [
            f"Buổi sáng trong lành, {alias} mở trang sách mới và bắt gặp từ “{w1}”.",
            f"Đọc chậm rãi và rõ ràng tiếng “{w1}”, {alias} thấy câu chuyện hiện lên thật sinh động.",
        ]
    elif len(clean_words) == 2:
        w1, w2 = clean_words[0], clean_words[1]
        sentences = [
            f"Trên đường đến góc học tập, {alias} vui vẻ nhẩm lại hai từ quen thuộc là “{w1}” và “{w2}”.",
            f"Khi ghép “{w1}” cùng “{w2}” vào câu ngắn, giọng đọc của {alias} vang lên thật ấm áp.",
        ]
    else:
        w1, w2, w3 = clean_words[0], clean_words[1], clean_words[2]
        sentences = [
            f"Hôm nay {alias} khám phá khu vườn chữ cái có “{w1}” và “{w2}” dưới nắng sớm.",
            f"Nhờ đọc rõ thêm từ “{w3}”, câu chuyện nhỏ bỗng trở nên trọn vẹn và rộn ràng hơn.",
        ]

    title_vi = "Truyện ngắn khởi động trước giờ đọc"
    return title_vi, sentences


def validate_micro_story_candidate(
    *,
    title_vi: str,
    sentences: list[str],
    target_words: list[str],
) -> tuple[str, list[str]] | None:
    clean_title = unicodedata.normalize("NFC", str(title_vi or "")).strip()[:110]
    if not clean_title:
        clean_title = "Truyện ngắn khởi động trước giờ đọc"

    clean_sentences = [
        re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(s or "")).strip())
        for s in sentences
        if isinstance(s, str) and str(s).strip()
    ]
    if not (2 <= len(clean_sentences) <= 3):
        return None
    if any(len(s) < 12 or len(s) > 150 for s in clean_sentences):
        return None

    joined = " ".join(clean_sentences)
    if len(joined) > 280:
        return None
    if _UNSAFE_STORY_PATTERN.search(joined) or _UNSAFE_STORY_PATTERN.search(clean_title):
        return None

    lowered = joined.lower()
    for word in target_words[:3]:
        norm_w = unicodedata.normalize("NFC", word.strip().lower())
        if norm_w and norm_w not in lowered:
            return None

    return clean_title, clean_sentences


class WarmupMicroStoryService:
    """Synthesizes and caches safe 2-3 sentence warm-up micro-stories per child & day."""

    def __init__(
        self,
        db: AsyncSession,
        *,
        tutor_config: TutorQuestionConfig | None = None,
        ocr_config: OcrCorrectionConfig | None = None,
        now_fn: Any = None,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.db = db
        self.adaptive_repo = AdaptiveLearningRepository(db)
        self.progress_repo = ChildProgressRepository(db)
        self.tutor_config = tutor_config or TutorQuestionConfig.from_environment()
        self.ocr_config = ocr_config or OcrCorrectionConfig.from_environment()
        self._now = now_fn or (lambda: datetime.now(VIETNAM_TZ))
        self._transport = http_transport

    async def _is_story_table_ready(self) -> bool:
        try:
            reg = await self.db.scalar(
                select(text("to_regclass('public.child_warmup_stories')"))
            )
            return reg is not None
        except SQLAlchemyError:
            return False

    async def _collect_due_words(
        self,
        child_id: UUID,
        today: date,
    ) -> tuple[list[str], bool]:
        word_attempts = await self.adaptive_repo.list_difficult_word_attempts(
            child_id, window_days=90
        )
        spaced = compute_spaced_difficult_words(word_attempts, limit=4)
        chosen: list[str] = []
        seen: set[str] = set()
        for item in spaced:
            norm = unicodedata.normalize("NFC", item.display_text.strip())
            key = norm.lower()
            if norm and key not in seen:
                seen.add(key)
                chosen.append(norm)
            if len(chosen) >= 3:
                break

        if len(chosen) < 2:
            since_dt = datetime.combine(
                today - timedelta(days=59), day_time.min, tzinfo=VIETNAM_TZ
            )
            sessions = await self.progress_repo.sessions(child_id, since_dt)
            reports = await self.progress_repo.reports(child_id, since_dt)
            retries = await self.progress_repo.word_retries(child_id, since_dt)
            answers = await self.progress_repo.answers(child_id, since_dt)
            window = compute_window(
                start=today - timedelta(days=59),
                end=today,
                sessions=sessions,
                reports=reports,
                retries=retries,
                answers=answers,
            )
            for stat in top_difficult_words(window, limit=4):
                w = unicodedata.normalize("NFC", str(stat.get("word") or "").strip())
                key = w.lower()
                if w and key not in seen:
                    seen.add(key)
                    chosen.append(w)
                if len(chosen) >= 3:
                    break

        if chosen:
            return chosen[:3], True
        return [], False

    async def _load_cached_story(
        self,
        child_id: UUID,
        today: date,
        signature: str,
    ) -> ChildWarmupStory | None:
        if not await self._is_story_table_ready():
            return None
        try:
            async with self.db.begin_nested():
                result = await self.db.execute(
                    select(ChildWarmupStory).where(
                        ChildWarmupStory.ChildId == child_id,
                        ChildWarmupStory.LocalDate == today,
                        ChildWarmupStory.WordsSignature == signature,
                    )
                )
                return result.scalar_one_or_none()
        except SQLAlchemyError:
            return None

    async def _generate_with_ai(
        self,
        *,
        grade: int,
        child_alias: str,
        target_words: list[str],
    ) -> tuple[str, list[str]] | None:
        api_key = (self.tutor_config.gemini_api_key or "").strip()
        if not api_key:
            return None

        words_joined = ", ".join(f'"{w}"' for w in target_words)
        system_prompt = (
            "Bạn là giáo viên tiểu học Việt Nam dịu dàng. Hãy viết một mẩu truyện khởi động "
            "2 đến 3 câu ngắn gọn, trong sáng, tích cực, phù hợp học sinh lớp "
            f"{grade}, bắt buộc chứa nguyên văn các từ: {words_joined}. "
            "Tổng độ dài dưới 240 ký tự. Trả về JSON dạng "
            '{"title_vi": "...", "sentences": ["Câu 1.", "Câu 2."]}.'
        )
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.tutor_config.gemini_model}:generateContent"
        )
        payload = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "text": (
                                f"Tên gọi thân mật của bé: {child_alias}. "
                                f"Từ cần lồng ghép tự nhiên: {words_joined}."
                            )
                        }
                    ],
                }
            ],
            "generationConfig": {
                "temperature": 0.4,
                "responseMimeType": "application/json",
            },
        }
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(min(8.0, float(self.tutor_config.timeout_seconds))),
                trust_env=False,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                resp = await client.post(
                    url,
                    headers={"x-goog-api-key": api_key},
                    json=payload,
                )
            if resp.status_code != 200:
                return None
            body = resp.json()
            candidates = body.get("candidates") or []
            parts = (
                candidates[0].get("content", {}).get("parts", [])
                if candidates and isinstance(candidates[0], dict)
                else []
            )
            raw_text = parts[0].get("text", "") if parts and isinstance(parts[0], dict) else ""
            parsed = json.loads(raw_text)
            if not isinstance(parsed, dict):
                return None
            validated = validate_micro_story_candidate(
                title_vi=str(parsed.get("title_vi") or ""),
                sentences=list(parsed.get("sentences") or []),
                target_words=target_words,
            )
            if validated is None:
                return None

            # Optional secondary cloud child-safety verification when enabled in env.
            if self.ocr_config.cloud_correction_enabled and (
                self.ocr_config.gemini_api_key or self.ocr_config.groq_api_key
            ):
                try:
                    safety = await ChildSafetyOrchestrator(self.ocr_config).analyze(
                        " ".join(validated[1])
                    )
                    if safety.get("suitability") != "SUITABLE":
                        return None
                except (OcrConfigurationError, ChildSafetyError, Exception):
                    # Deterministic safety check already passed above.
                    pass

            return validated
        except Exception as exc:
            logger.debug("Warm-up micro-story AI generation fell back to deterministic template: %s", exc)
            return None

    async def get_or_create_warmup_story(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        refresh: bool = False,
    ) -> WarmupMicroStoryRead:
        from fastapi import HTTPException, status

        child = await self.adaptive_repo.get_owned_child(child_id, parent_id)
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )

        child_grade = int(getattr(child, "Grade", 1) or 1)
        child_alias = str(getattr(child, "Alias", "bé") or "bé")
        today = self._now().astimezone(VIETNAM_TZ).date()

        due_words, has_due_words = await self._collect_due_words(child_id, today)
        effective_words = (
            due_words
            if due_words
            else list(_GRADE_STARTER_WORDS.get(max(1, min(5, child_grade)), ["tia nắng", "cánh cò"]))
        )
        signature = _words_signature(child_grade, effective_words)
        mem_key = (str(child_id), today.isoformat(), signature)

        if not refresh:
            cached_row = await self._load_cached_story(child_id, today, signature)
            if cached_row is not None:
                sentences = [
                    str(s) for s in (cached_row.SentencesJson or []) if isinstance(s, str)
                ]
                await self.db.rollback()
                return WarmupMicroStoryRead(
                    child_id=child_id,
                    local_date=today,
                    has_due_words=has_due_words,
                    target_words=[
                        str(w) for w in (cached_row.TargetWords or effective_words) if isinstance(w, str)
                    ],
                    title_vi=cached_row.TitleVi,
                    sentences=sentences,
                    full_text=" ".join(sentences),
                    source="AI" if cached_row.Source == "AI" else "RULE_BASED",
                    cached=True,
                )

            mem_hit = _memory_cache_get(mem_key)
            if mem_hit is not None:
                await self.db.rollback()
                return WarmupMicroStoryRead(
                    child_id=child_id,
                    local_date=today,
                    has_due_words=has_due_words,
                    target_words=list(mem_hit["target_words"]),
                    title_vi=mem_hit["title_vi"],
                    sentences=list(mem_hit["sentences"]),
                    full_text=" ".join(mem_hit["sentences"]),
                    source=mem_hit["source"],
                    cached=True,
                )

        # Release Supavisor read transaction BEFORE calling any external LLM/safety HTTP endpoint.
        await self.db.rollback()

        source_label = "RULE_BASED"
        generated = (
            await self._generate_with_ai(
                grade=child_grade,
                child_alias=child_alias,
                target_words=effective_words,
            )
            if has_due_words
            else None
        )
        if generated is not None:
            title_vi, sentences = generated
            source_label = "AI"
        else:
            title_vi, sentences = build_rule_based_micro_story(
                grade=child_grade,
                child_alias=child_alias,
                target_words=effective_words,
            )

        _memory_cache_put(
            mem_key,
            {
                "target_words": effective_words,
                "title_vi": title_vi,
                "sentences": sentences,
                "source": source_label,
            },
        )

        if await self._is_story_table_ready():
            try:
                async with self.db.begin_nested():
                    existing = await self._load_cached_story(child_id, today, signature)
                    if existing is not None:
                        existing.TitleVi = title_vi
                        existing.SentencesJson = sentences
                        existing.TargetWords = effective_words
                        existing.Source = source_label
                        await self.db.flush()
                    else:
                        row = ChildWarmupStory(
                            ChildId=child_id,
                            ParentId=parent_id,
                            LocalDate=today,
                            WordsSignature=signature,
                            TargetWords=effective_words,
                            TitleVi=title_vi,
                            SentencesJson=sentences,
                            Source=source_label,
                            TtsPrewarmed=False,
                        )
                        self.db.add(row)
                        await self.db.flush()
                await self.db.commit()
            except (IntegrityError, SQLAlchemyError):
                await self.db.rollback()

        return WarmupMicroStoryRead(
            child_id=child_id,
            local_date=today,
            has_due_words=has_due_words,
            target_words=effective_words,
            title_vi=title_vi,
            sentences=sentences,
            full_text=" ".join(sentences),
            source=source_label,  # type: ignore[arg-type]
            cached=False,
        )
