from __future__ import annotations

import asyncio
import math
import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time as day_time, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from pydantic import TypeAdapter, ValidationError

from app.api.routes.reading import HistoryService
from app.models import ReadingEvent
from app.models.difficult_word_practice import DifficultWordPracticeAttempt
from app.providers.elevenlabs_voice_provider import (
    Transcription,
    VoiceProviderError,
)
from app.repositories.difficult_words_repository import DifficultWordsRepository
from app.schemas.difficult_words import (
    DifficultWordPracticeAttemptRead,
    DifficultWordPracticeCompleteRequest,
    DifficultWordPracticeHistoryItemRead,
    DifficultWordPracticeHistoryRead,
    DifficultWordPracticeStartRequest,
    DifficultWordProgressSummaryRead,
    PracticeAssessmentStatusLiteral,
    PracticeRecognitionSourceLiteral,
    PracticeStatusLiteral,
)
from app.schemas.system import DifficultWordRead, DifficultWordSourceRead
from app.services.child_progress.metrics import (
    ReportRow,
    VIETNAM_TZ,
    analyze_alignment,
    first_pass_reports,
)
from app.services.reading_assessment import initial_snapshot

DEFAULT_WINDOW_DAYS = 90
MAX_WINDOW_DAYS = 366
REQUIRED_CONSECUTIVE_CORRECT = 1
MAX_PRACTICE_AUDIO_BYTES = 5 * 1024 * 1024
ALLOWED_AUDIO_PREFIXES = ("audio/", "video/", "application/octet-stream")
ALLOWED_AUDIO_EXTENSIONS = (".webm", ".ogg", ".mp3", ".wav", ".m4a", ".aac", ".flac")
UNUSABLE_AUDIO_QUALITY_STATUSES = {
    "NO_AUDIO",
    "SILENCE",
    "AUDIO_TOO_SHORT",
    "INVALID_AUDIO",
}

_PUNCTUATION_STRIP_RE = re.compile(r"^[\W_]+|[\W_]+$", re.UNICODE)
_NON_SPEECH_TAG_RE = re.compile(
    r"\[[^\]]*\]|\((?:tiếng|âm\s*thanh|nhạc|ồn|cười|ho|thở|applause|laughter|music|noise)[^)]*\)",
    re.UNICODE | re.IGNORECASE,
)
_TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)
_WORD_HELP_RE = re.compile(
    r"(?:(?:cô|thầy) ơi )?(?:con|bé|em) (?:không|chưa) biết(?: đọc)?(?: từ này| chữ này)?(?: ạ)?"
)


def normalize_vietnamese_practice_word(value: Any) -> str:
    """Normalize a Vietnamese word/phrase to NFC lowercase while preserving tones and đ."""
    if not isinstance(value, str):
        return ""
    tokens = tokenize_vietnamese_practice_text(value)
    return " ".join(tokens)


def tokenize_vietnamese_practice_text(value: Any) -> list[str]:
    """Extract normalized Vietnamese word tokens preserving all tone diacritics and đ."""
    if not isinstance(value, str):
        return []
    without_annotations = _NON_SPEECH_TAG_RE.sub(" ", unicodedata.normalize("NFC", value))
    nfc = without_annotations.lower().strip()
    tokens: list[str] = []
    for raw in _TOKEN_RE.findall(nfc):
        cleaned = unicodedata.normalize("NFC", _PUNCTUATION_STRIP_RE.sub("", raw).strip())
        if cleaned and any(ch.isalpha() or ch.isdigit() for ch in cleaned):
            tokens.append(cleaned)
    return tokens


_DIGIT_WORDS = ("không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín")


def _short_word_tokens(value: str | None) -> list[str]:
    tokens = tokenize_vietnamese_practice_text(value)
    if len(tokens) == 1 and re.fullmatch(r"[0-9]", tokens[0]):
        return [_DIGIT_WORDS[int(tokens[0])]]
    return tokens


_ASSISTANT_BLEED_PHRASES = (
    "bé hãy đọc",
    "hãy đọc lại",
    "đọc lại từ",
    "chưa nghe rõ",
    "mình chưa nghe rõ",
    "con đọc lại",
    "con thử đọc cả cụm",
    "con hãy đọc cả cụm",
    "nghe lại rồi đọc",
    "một lần nhé",
    "chính xác rồi",
    "con giỏi lắm",
    "máy chưa nghe",
)


def is_assistant_prompt_bleed(
    actual_tokens: list[str],
    expected_tokens: list[str],
) -> bool:
    if len(actual_tokens) <= len(expected_tokens):
        return False
    joined = " ".join(actual_tokens)
    return any(phrase in joined for phrase in _ASSISTANT_BLEED_PHRASES)


def _contains_subslice(needle: list[str], haystack: list[str]) -> bool:
    span = len(needle)
    if span == 0 or span > len(haystack):
        return False
    return any(haystack[idx : idx + span] == needle for idx in range(len(haystack) - span + 1))


def is_word_help_request(transcript: str | None, target: str) -> bool:
    spoken = normalize_vietnamese_practice_word(transcript)
    expected = normalize_vietnamese_practice_word(target)
    return bool(_WORD_HELP_RE.fullmatch(spoken)) and not (expected + " ").startswith(spoken + " ")


def has_confusable_nasal_ending(target: str, transcript: str | None) -> bool:
    expected = tokenize_vietnamese_practice_text(target)
    actual = tokenize_vietnamese_practice_text(transcript)
    if len(expected) != 1 or len(actual) != 1 or expected == actual:
        return False
    coda = re.compile(r"(.+?)(ng|nh|m|n)")
    left = coda.fullmatch(expected[0])
    right = coda.fullmatch(actual[0])
    return bool(left and right and left.group(1) == right.group(1))


def classify_practice_transcript(
    expected_word: str,
    transcript: str | None,
    context_phrase: str | None = None,
) -> PracticeAssessmentStatusLiteral:
    """Classify a short practice transcript against a Vietnamese word or compound phrase."""
    expected_tokens = _short_word_tokens(expected_word)
    if not expected_tokens or len(expected_tokens) > 4:
        return "UNCERTAIN"

    actual_tokens = _short_word_tokens(transcript)
    if not actual_tokens:
        return "NO_CLEAR_AUDIO"

    if is_word_help_request(transcript, expected_word):
        return "UNCERTAIN"

    if is_assistant_prompt_bleed(actual_tokens, expected_tokens):
        return "UNCERTAIN"

    max_tokens = max(4, len(expected_tokens) + 3)
    collapsed_repeats = [
        tok for idx, tok in enumerate(actual_tokens) if idx == 0 or tok != actual_tokens[idx - 1]
    ]
    if len(actual_tokens) > max_tokens:
        if len(collapsed_repeats) <= max_tokens and set(collapsed_repeats) == set(expected_tokens):
            actual_tokens = collapsed_repeats
        elif context_phrase and 2 <= len(actual_tokens) <= 10:
            context_tokens = tokenize_vietnamese_practice_text(context_phrase)
            if _contains_subslice(expected_tokens, actual_tokens) and _contains_subslice(
                actual_tokens, context_tokens
            ):
                return "CORRECT"
            return "UNCERTAIN"
        else:
            return "UNCERTAIN"

    if _contains_subslice(expected_tokens, actual_tokens):
        return "CORRECT"

    return "INCORRECT"


def has_usable_practice_transcript(
    transcription: Transcription,
) -> bool:
    """Conservative transcript gate matching frontend recognition-evidence rules."""
    if not tokenize_vietnamese_practice_text(transcription.text):
        return False
    if transcription.language_code and transcription.language_code not in (
        "vi",
        "vie",
        "vi-VN",
    ):
        return False
    words = [w for w in transcription.words or [] if w.get("type") in (None, "word")]
    if transcription.words and not words:
        return False
    for word in words:
        logprob = word.get("logprob")
        if logprob is not None and (not math.isfinite(logprob) or logprob < -1.5):
            return False
    return True


def has_high_confidence_keyterm_result(transcription: Transcription) -> bool:
    words = [w for w in transcription.words or [] if w.get("type") in (None, "word")]
    if not words or not any(word.get("logprob") is not None for word in words):
        return False
    return all(
        word.get("logprob") is None
        or (math.isfinite(word["logprob"]) and word["logprob"] >= -0.5)
        for word in words
    )


def has_usable_browser_confidence(confidence: float | None) -> bool:
    if confidence is None or confidence == 0:
        return True
    return math.isfinite(confidence) and 0.5 <= confidence <= 1.0


def build_child_friendly_feedback(
    assessment_status: PracticeAssessmentStatusLiteral | None,
    practice_status: PracticeStatusLiteral,
    consecutive_correct_count: int,
) -> str | None:
    if assessment_status is None:
        return None
    if assessment_status == "CORRECT":
        if practice_status == "COMPLETED":
            return "Chính xác rồi! Con giỏi lắm!"
        remaining = max(1, REQUIRED_CONSECUTIVE_CORRECT - consecutive_correct_count)
        return (
            f"Giỏi lắm! Con đọc đúng từ này rồi! "
            f"Con hãy đọc đúng thêm {remaining} lần nữa để hoàn thành nhé!"
        )
    if assessment_status == "INCORRECT":
        return "Con thử nghe lại phát âm mẫu và đọc chậm rãi một lần nữa nhé!"
    if assessment_status == "NO_CLEAR_AUDIO":
        return "Máy chưa nghe rõ giọng của con. Con lại gần micro và thử lại nhé!"
    if assessment_status == "ENGINE_ERROR":
        return "Phần nhận diện giọng nói đang bận một chút. Con không bị tính sai đâu, mình thử lại sau nhé!"
    return "Máy chưa nghe thật chắc chắn. Con không bị tính sai đâu, mình thử đọc lại nhé!"


def _ensure_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def compute_word_practice_progress(
    normalized_word: str,
    attempts: list[DifficultWordPracticeAttempt],
    last_seen_at: datetime | None = None,
) -> DifficultWordProgressSummaryRead:
    """Compute evidence-based mastery state for one word from durable practice attempts."""
    completed = sorted(
        [a for a in attempts if a.State == "COMPLETED"],
        key=lambda a: (
            _ensure_utc(a.CompletedAt) or _ensure_utc(a.StartedAt) or datetime.min.replace(tzinfo=timezone.utc),
            a.AttemptNumber,
        ),
    )
    started_any = len(attempts) > 0

    correct_count = sum(1 for a in completed if a.AssessmentStatus == "CORRECT")
    incorrect_count = sum(1 for a in completed if a.AssessmentStatus == "INCORRECT")
    uncertain_count = sum(
        1
        for a in completed
        if a.AssessmentStatus in ("UNCERTAIN", "NO_CLEAR_AUDIO", "ENGINE_ERROR")
    )

    consecutive_correct = 0
    latest_unambiguous: str | None = None
    for attempt in completed:
        if attempt.AssessmentStatus == "CORRECT":
            consecutive_correct += 1
            latest_unambiguous = "CORRECT"
        elif attempt.AssessmentStatus == "INCORRECT":
            consecutive_correct = 0
            latest_unambiguous = "INCORRECT"
        # UNCERTAIN, NO_CLEAR_AUDIO, ENGINE_ERROR never reset or penalize streak.

    last_attempt = completed[-1] if completed else None
    last_practiced_at = (
        _ensure_utc(last_attempt.CompletedAt or last_attempt.StartedAt)
        if last_attempt is not None
        else None
    )
    last_practice_status = (
        last_attempt.AssessmentStatus if last_attempt is not None else None
    )

    seen_utc = _ensure_utc(last_seen_at)
    encountered_again_after_practice = bool(
        last_practiced_at is not None
        and seen_utc is not None
        and seen_utc > last_practiced_at
    )

    if not started_any:
        practice_status: PracticeStatusLiteral = "NOT_PRACTICED"
    elif (
        consecutive_correct >= REQUIRED_CONSECUTIVE_CORRECT
        and correct_count >= REQUIRED_CONSECUTIVE_CORRECT
        and latest_unambiguous == "CORRECT"
        and not encountered_again_after_practice
    ):
        practice_status = "COMPLETED"
    elif latest_unambiguous == "INCORRECT" or encountered_again_after_practice:
        practice_status = "NEEDS_MORE_PRACTICE"
    else:
        practice_status = "IN_PROGRESS"

    return DifficultWordProgressSummaryRead(
        normalized_word=normalized_word,
        practice_status=practice_status,
        practice_attempts_count=len(completed),
        practice_correct_count=correct_count,
        practice_incorrect_count=incorrect_count,
        practice_uncertain_count=uncertain_count,
        consecutive_correct_count=consecutive_correct,
        required_consecutive_correct=REQUIRED_CONSECUTIVE_CORRECT,
        last_practiced_at=last_practiced_at,
        last_practice_status=last_practice_status,
    )


@dataclass
class _PracticeRecordAdapter:
    """Uniform view over DifficultWordPracticeAttempt rows and ReadingEvent(WORD_RETRY) rows."""

    Id: UUID
    ChildId: UUID
    NormalizedWord: str
    DisplayText: str
    AttemptNumber: int
    State: str
    AssessmentStatus: str | None
    RecognitionSource: str | None
    SpokenTranscript: str | None
    Confidence: float | None
    AudioDurationMs: int | None
    AssessmentVersion: int
    EvidenceWordIds: list[Any]
    StartedAt: datetime
    CompletedAt: datetime | None
    CompletionRequestId: UUID | None = None
    BookId: UUID | None = None
    SessionId: UUID | None = None
    PageId: UUID | None = None
    PageRevisionId: UUID | None = None
    WordId: UUID | None = None


def _build_context_phrase(
    words_in_revision: list[Any] | None,
    *,
    word_id: UUID | None = None,
    word_index: int | None = None,
    fallback_text: str | None = None,
) -> str | None:
    """Extract a short +/- 3-word surrounding Vietnamese phrase from the verified page revision."""
    if not words_in_revision:
        return None
    target_idx: int | None = None
    if word_id is not None:
        for i, row in enumerate(words_in_revision):
            if getattr(row, "Id", None) == word_id:
                target_idx = i
                break
    if target_idx is None and word_index is not None:
        for i, row in enumerate(words_in_revision):
            if getattr(row, "WordIndex", None) == word_index:
                target_idx = i
                break
    if target_idx is None and fallback_text:
        target_norm = normalize_vietnamese_practice_word(fallback_text)
        if target_norm:
            for i, row in enumerate(words_in_revision):
                if normalize_vietnamese_practice_word(getattr(row, "Text", "")) == target_norm:
                    target_idx = i
                    break
    if target_idx is None:
        return None
    start = max(0, target_idx - 3)
    end = min(len(words_in_revision), target_idx + 4)
    tokens = [
        str(getattr(row, "Text", "")).strip()
        for row in words_in_revision[start:end]
        if str(getattr(row, "Text", "")).strip()
    ]
    if not tokens:
        return None
    phrase = " ".join(tokens)
    if start > 0:
        phrase = f"...{phrase}"
    if end < len(words_in_revision):
        phrase = f"{phrase}..."
    return phrase[:120]


@dataclass
class _WordAccumulator:
    normalized_word: str
    display_counter: Counter = field(default_factory=Counter)
    omission_count: int = 0
    mispronunciation_count: int = 0
    repetition_count: int = 0
    long_pause_count: int = 0
    read_example_count: int = 0
    session_ids: set[UUID] = field(default_factory=set)
    evidence_word_ids: set[UUID] = field(default_factory=set)
    last_seen_at: datetime | None = None
    sources_map: dict[tuple[UUID | None, UUID | None, UUID | None, UUID | None], DifficultWordSourceRead] = field(
        default_factory=dict
    )

    def observe(
        self,
        *,
        display_text: str,
        seen_at: datetime,
        session_id: UUID | None = None,
        word_id: UUID | None = None,
        book_id: UUID | None = None,
        book_title: str | None = None,
        book_author: str | None = None,
        min_grade: int | None = None,
        max_grade: int | None = None,
        page_id: UUID | None = None,
        page_revision_id: UUID | None = None,
        page_number: int | None = None,
        context_phrase: str | None = None,
    ) -> None:
        cleaned = unicodedata.normalize("NFC", display_text).strip()
        if cleaned:
            self.display_counter[cleaned] += 1
        seen_utc = _ensure_utc(seen_at)
        if seen_utc is not None and (
            self.last_seen_at is None or seen_utc > self.last_seen_at
        ):
            self.last_seen_at = seen_utc
        if session_id is not None:
            self.session_ids.add(session_id)
        if word_id is not None:
            self.evidence_word_ids.add(word_id)
        if session_id is not None or book_id is not None or page_id is not None:
            source_key = (book_id, session_id, page_id, word_id)
            seen_source_at = seen_utc or datetime.now(timezone.utc)
            existing = self.sources_map.get(source_key)
            if existing is None or seen_source_at >= existing.last_seen_at:
                self.sources_map[source_key] = DifficultWordSourceRead(
                    book_id=book_id,
                    book_title=book_title,
                    book_author=book_author,
                    min_grade=min_grade,
                    max_grade=max_grade,
                    book_cover_url=None,
                    session_id=session_id,
                    page_id=page_id,
                    page_revision_id=page_revision_id,
                    page_number=page_number,
                    word_id=word_id,
                    context_phrase=context_phrase or (existing.context_phrase if existing else None),
                    last_seen_at=seen_source_at,
                )

    def to_read(
        self,
        progress: DifficultWordProgressSummaryRead,
    ) -> DifficultWordRead:
        display_text = (
            self.display_counter.most_common(1)[0][0]
            if self.display_counter
            else self.normalized_word
        )
        difficulty_score = round(
            self.mispronunciation_count * 2.0
            + self.omission_count * 2.0
            + self.repetition_count * 1.5
            + self.long_pause_count * 1.0
            + self.read_example_count * 0.5,
            1,
        )
        encounter_count = (
            self.mispronunciation_count
            + self.omission_count
            + self.repetition_count
            + self.long_pause_count
        )
        sorted_sources = sorted(
            self.sources_map.values(),
            key=lambda s: _ensure_utc(s.last_seen_at) or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )[:5]
        return DifficultWordRead(
            normalized_word=self.normalized_word,
            display_text=display_text,
            difficulty_score=difficulty_score,
            omission_count=self.omission_count,
            repetition_count=self.repetition_count,
            long_pause_count=self.long_pause_count,
            read_example_count=self.read_example_count,
            session_count=len(self.session_ids),
            last_seen_at=self.last_seen_at or datetime.now(timezone.utc),
            evidence_word_ids=sorted(self.evidence_word_ids, key=str),
            mispronunciation_count=self.mispronunciation_count,
            encounter_count=encounter_count,
            practice_status=progress.practice_status,
            practice_attempts_count=progress.practice_attempts_count,
            practice_correct_count=progress.practice_correct_count,
            practice_incorrect_count=progress.practice_incorrect_count,
            practice_uncertain_count=progress.practice_uncertain_count,
            consecutive_correct_count=progress.consecutive_correct_count,
            last_practiced_at=progress.last_practiced_at,
            last_practice_status=progress.last_practice_status,
            sources=sorted_sources,
        )


def _priority_sort_key(item: DifficultWordRead) -> tuple:
    is_completed = 1 if item.practice_status == "COMPLETED" else 0
    effective_priority = item.difficulty_score - (0.5 * item.consecutive_correct_count)
    seen_ts = (_ensure_utc(item.last_seen_at) or datetime.min.replace(tzinfo=timezone.utc)).timestamp()
    return (
        is_completed,
        -effective_priority,
        -item.session_count,
        -seen_ts,
        item.normalized_word,
    )


class DifficultWordsService:
    """Aggregates real difficult words and manages child-safe word practice attempts."""

    def __init__(
        self,
        repository: DifficultWordsRepository,
        access: HistoryService,
        voice_provider: Any | None = None,
    ):
        self.repository = repository
        self.access = access
        if voice_provider is not None:
            self.voice_provider = voice_provider
        else:
            from app.api.routes.voice import get_voice_orchestrator

            self.voice_provider = get_voice_orchestrator()

    def _window_bounds(
        self,
        period_start: date | None,
        period_end: date | None,
    ) -> tuple[date, date, datetime, datetime]:
        if (period_start is None) != (period_end is None):
            raise HTTPException(status_code=422, detail="Invalid date window")
        today = datetime.now(VIETNAM_TZ).date()
        end = period_end or today
        start = period_start or (end - timedelta(days=DEFAULT_WINDOW_DAYS - 1))
        if end < start or (end - start).days > MAX_WINDOW_DAYS:
            raise HTTPException(status_code=422, detail="Invalid date window")
        since = datetime.combine(start, day_time.min, tzinfo=VIETNAM_TZ)
        until_exclusive = datetime.combine(
            end + timedelta(days=1), day_time.min, tzinfo=VIETNAM_TZ
        )
        return start, end, since, until_exclusive

    @staticmethod
    def _parse_uuid(value: Any) -> UUID | None:
        if isinstance(value, UUID):
            return value
        if isinstance(value, str):
            try:
                return UUID(value.strip())
            except ValueError:
                return None
        return None

    async def _load_merged_attempts(
        self,
        child_id: UUID,
        actor_id: UUID,
        *,
        normalized_word: str | None = None,
        word_text_by_id: dict[UUID, str] | None = None,
        book_by_session: dict[UUID, UUID] | None = None,
    ) -> tuple[bool, bool, list[Any]]:
        """Load practice attempts merged with ReadingEvent(WORD_RETRY) records without double-counting."""
        storage_ready = await self.repository.is_practice_storage_ready()
        practice_attempts = (
            await self.repository.list_practice_attempts(
                child_id, actor_id, normalized_word=normalized_word
            )
            if storage_ready
            else []
        )
        list_retry = getattr(self.repository, "list_retry_events_for_child", None)
        retry_events: list[ReadingEvent] = (
            await list_retry(child_id, actor_id) if callable(list_retry) else []
        )

        seen_req_keys: set[tuple[str, str]] = set()
        seen_approx_keys: set[tuple[str, str, int]] = set()
        for attempt in practice_attempts:
            if attempt.CompletionRequestId is not None:
                seen_req_keys.add((attempt.NormalizedWord, str(attempt.CompletionRequestId)))
            ts = _ensure_utc(attempt.CompletedAt or attempt.StartedAt)
            if attempt.State == "COMPLETED" and attempt.AssessmentStatus and ts is not None:
                seen_approx_keys.add(
                    (attempt.NormalizedWord, attempt.AssessmentStatus, int(ts.timestamp() // 5))
                )

        adapted_events: list[_PracticeRecordAdapter] = []
        valid_sources = {
            "SERVER_STT",
            "SERVER_STT_KEYTERM",
            "BROWSER_SPEECH",
            "AUDIO_QUALITY_GATE",
            "ENGINE_ERROR",
        }
        status_map = {
            "CONFIRMED": "CORRECT",
            "FAILED": "INCORRECT",
            "UNCERTAIN": "UNCERTAIN",
        }
        for event in retry_events:
            meta = event.Metadata if isinstance(event.Metadata, dict) else {}
            raw_word = (
                meta.get("normalized_word")
                or meta.get("target_word")
                or ((word_text_by_id or {}).get(event.WordId) if event.WordId else None)
            )
            norm = normalize_vietnamese_practice_word(raw_word)
            if not norm:
                continue
            if normalized_word is not None and norm != normalized_word:
                continue
            comp_req = meta.get("completion_request_id")
            if isinstance(comp_req, str) and (norm, comp_req) in seen_req_keys:
                continue

            raw_practice_status = meta.get("practice_assessment_status")
            if raw_practice_status in (
                "CORRECT",
                "INCORRECT",
                "UNCERTAIN",
                "NO_CLEAR_AUDIO",
                "ENGINE_ERROR",
            ):
                resolved_status = raw_practice_status
            else:
                resolved_status = status_map.get(event.Status)
            if resolved_status is None:
                continue

            created_utc = _ensure_utc(event.CreatedAt) or datetime.now(timezone.utc)
            if (
                meta.get("practice_origin") == "DIFFICULT_WORDS_REPORT"
                and (norm, resolved_status, int(created_utc.timestamp() // 5)) in seen_approx_keys
            ):
                continue

            rec_src = meta.get("recognition_source")
            if rec_src not in valid_sources:
                rec_src = "SERVER_STT"
            attempt_no = meta.get("retry_attempt")
            attempt_num = attempt_no if type(attempt_no) is int and attempt_no >= 1 else 1
            raw_display = meta.get("target_word") or ((word_text_by_id or {}).get(event.WordId) if event.WordId else None) or norm
            display_text = unicodedata.normalize("NFC", str(raw_display)).strip()[:120] or norm
            raw_recognized = meta.get("recognized_text")
            spoken_transcript = (
                unicodedata.normalize("NFC", raw_recognized).strip()[:160]
                if isinstance(raw_recognized, str) and raw_recognized.strip()
                else None
            )
            raw_dur = meta.get("audio_duration_ms")
            audio_dur = (
                raw_dur
                if type(raw_dur) is int and raw_dur >= 0
                else (event.EndMs if type(event.EndMs) is int and event.EndMs > 0 else None)
            )
            adapted_events.append(
                _PracticeRecordAdapter(
                    Id=event.Id,
                    ChildId=child_id,
                    NormalizedWord=norm,
                    DisplayText=display_text,
                    AttemptNumber=attempt_num,
                    State="COMPLETED",
                    AssessmentStatus=resolved_status,
                    RecognitionSource=rec_src,
                    SpokenTranscript=spoken_transcript,
                    Confidence=event.Confidence,
                    AudioDurationMs=audio_dur,
                    AssessmentVersion=1,
                    EvidenceWordIds=[event.WordId] if event.WordId else [],
                    StartedAt=created_utc,
                    CompletedAt=created_utc,
                    BookId=(book_by_session or {}).get(event.SessionId),
                    SessionId=event.SessionId,
                    PageId=event.PageId,
                    PageRevisionId=event.PageRevisionId,
                    WordId=event.WordId,
                )
            )

        merged: list[Any] = list(practice_attempts) + adapted_events
        effective_ready = storage_ready or bool(adapted_events)
        return storage_ready, effective_ready, merged

    async def list_difficult_words(
        self,
        child_id: UUID,
        actor_id: UUID,
        *,
        period_start: date | None = None,
        period_end: date | None = None,
        status_filter: PracticeStatusLiteral | None = None,
    ) -> list[DifficultWordRead]:
        await self.access.require_child(child_id, actor_id)
        start, end, since, until_exclusive = self._window_bounds(period_start, period_end)

        sessions = await self.repository.reading_sessions(
            child_id, actor_id, since, until_exclusive
        )
        raw_reports = await self.repository.comparison_reports(
            child_id, actor_id, since, until_exclusive
        )
        events = await self.repository.reading_events_with_words(
            child_id, actor_id, since, until_exclusive
        )
        saved_report = await self.repository.saved_progress_report(
            child_id, start, end, actor_id
        )

        session_by_id = {s.Id: s for s in sessions}
        book_by_session = {s.Id: s.BookId for s in sessions if getattr(s, "BookId", None) is not None}
        book_ids = list(set(book_by_session.values()))
        page_ids = [
            pid
            for pid in (
                *(r.PageId for r in raw_reports),
                *(e.PageId for e, _ in events),
            )
            if pid is not None
        ]
        revision_ids = [
            rid
            for rid in (
                *(r.PageRevisionId for r in raw_reports),
                *(e.PageRevisionId for e, _ in events),
            )
            if rid is not None
        ]
        books_fn = getattr(self.repository, "books_by_ids", None)
        books_by_id = await books_fn(book_ids) if callable(books_fn) and book_ids else {}
        pages_words_fn = getattr(self.repository, "pages_and_revision_words", None)
        pages_by_id, rev_words_by_rev = (
            await pages_words_fn(page_ids, revision_ids)
            if callable(pages_words_fn) and (page_ids or revision_ids)
            else ({}, {})
        )

        word_text_by_id: dict[UUID, str] = {}
        for rev_words in rev_words_by_rev.values():
            for rw in rev_words:
                if getattr(rw, "Id", None) and getattr(rw, "Text", None):
                    word_text_by_id[rw.Id] = rw.Text
        for event, page_word_text in events:
            if event.WordId and page_word_text:
                word_text_by_id.setdefault(event.WordId, page_word_text)

        _, _, practice_attempts = await self._load_merged_attempts(
            child_id,
            actor_id,
            word_text_by_id=word_text_by_id,
            book_by_session=book_by_session,
        )
        attempts_by_word: dict[str, list[Any]] = defaultdict(list)
        for attempt in practice_attempts:
            attempts_by_word[attempt.NormalizedWord].append(attempt)

        # Compatibility with saved ProgressReport contract when no live reading evidence exists.
        if not sessions and not raw_reports and not events and saved_report is not None:
            if not isinstance(saved_report.Summary, dict) or "difficult_words" not in saved_report.Summary:
                raise HTTPException(status_code=501, detail="Word evidence is not available yet")
            try:
                saved_words = TypeAdapter(list[DifficultWordRead]).validate_python(
                    saved_report.Summary["difficult_words"]
                )
            except (ValidationError, TypeError, ValueError):
                raise HTTPException(
                    status_code=501, detail="Report contract is not available yet"
                ) from None
            enriched: list[DifficultWordRead] = []
            for word in saved_words:
                norm = normalize_vietnamese_practice_word(word.normalized_word or word.display_text)
                if not norm:
                    continue
                progress = compute_word_practice_progress(
                    norm, attempts_by_word.get(norm, []), word.last_seen_at
                )
                enriched.append(
                    word.model_copy(
                        update={
                            "normalized_word": norm,
                            "practice_status": progress.practice_status,
                            "practice_attempts_count": progress.practice_attempts_count,
                            "practice_correct_count": progress.practice_correct_count,
                            "practice_incorrect_count": progress.practice_incorrect_count,
                            "practice_uncertain_count": progress.practice_uncertain_count,
                            "consecutive_correct_count": progress.consecutive_correct_count,
                            "last_practiced_at": progress.last_practiced_at,
                            "last_practice_status": progress.last_practice_status,
                        }
                    )
                )
            enriched.sort(key=_priority_sort_key)
            if status_filter is not None:
                enriched = [w for w in enriched if w.practice_status == status_filter]
            return enriched

        accumulators: dict[str, _WordAccumulator] = {}
        seen_event_keys: set[tuple[UUID, UUID | None, UUID | None, str, str]] = set()

        def acc_for(norm: str) -> _WordAccumulator:
            if norm not in accumulators:
                accumulators[norm] = _WordAccumulator(normalized_word=norm)
            return accumulators[norm]

        def source_meta_for(
            session_id: UUID | None,
            page_id: UUID | None,
            page_revision_id: UUID | None,
            *,
            word_id: UUID | None = None,
            word_index: int | None = None,
            fallback_text: str | None = None,
        ) -> dict[str, Any]:
            session_obj = session_by_id.get(session_id) if session_id else None
            book_id = getattr(session_obj, "BookId", None)
            book_obj = books_by_id.get(book_id) if book_id else None
            page_obj = pages_by_id.get(page_id) if page_id else None
            if book_id is None and page_obj is not None:
                book_id = getattr(page_obj, "BookId", None)
                book_obj = books_by_id.get(book_id) if book_id else None
            rev_words = rev_words_by_rev.get(page_revision_id) if page_revision_id else None
            context_phrase = _build_context_phrase(
                rev_words,
                word_id=word_id,
                word_index=word_index,
                fallback_text=fallback_text,
            )
            return {
                "book_id": book_id,
                "book_title": getattr(book_obj, "Title", None),
                "book_author": getattr(book_obj, "Author", None),
                "min_grade": getattr(book_obj, "MinGrade", None),
                "max_grade": getattr(book_obj, "MaxGrade", None),
                "page_id": page_id,
                "page_revision_id": page_revision_id,
                "page_number": getattr(page_obj, "PageNumber", None),
                "context_phrase": context_phrase,
            }

        # 1. Aggregate from immutable first-pass / earliest comparison reports per page.
        report_rows = [
            ReportRow(
                session_id=r.SessionId,
                created_at=r.CreatedAt,
                alignment=r.Alignment,
                summary=r.Summary,
                page_id=r.PageId,
                page_revision_id=r.PageRevisionId,
                transcript=r.Transcript,
            )
            for r in raw_reports
        ]
        for report in first_pass_reports(report_rows):
            snapshot = initial_snapshot(report.summary)
            if snapshot is not None:
                for entry in snapshot:
                    status_val = entry.get("status")
                    if status_val not in ("MISPRONUNCIATION", "OMISSION"):
                        continue
                    raw_text = str(entry.get("text", "")).strip()
                    norm = normalize_vietnamese_practice_word(raw_text)
                    if not norm:
                        continue
                    word_id = self._parse_uuid(entry.get("word_id"))
                    word_idx = entry.get("word_index") if type(entry.get("word_index")) is int else None
                    acc = acc_for(norm)
                    acc.observe(
                        display_text=raw_text,
                        seen_at=report.created_at,
                        session_id=report.session_id,
                        word_id=word_id,
                        **source_meta_for(
                            report.session_id,
                            report.page_id,
                            report.page_revision_id,
                            word_id=word_id,
                            word_index=word_idx,
                            fallback_text=raw_text,
                        ),
                    )
                    if status_val == "OMISSION":
                        acc.omission_count += 1
                        seen_event_keys.add(
                            (report.session_id, report.page_id, word_id, "OMISSION", norm)
                        )
                    else:
                        acc.mispronunciation_count += 1
                        seen_event_keys.add(
                            (report.session_id, report.page_id, word_id, "MISPRONUNCIATION", norm)
                        )
                continue

            alignment = analyze_alignment(report.alignment)
            if alignment is not None:
                # Re-scan raw alignment entries to distinguish SUBSTITUTE vs DELETE
                if isinstance(report.alignment, list):
                    attempted = [
                        item.get("book_index")
                        for item in report.alignment
                        if isinstance(item, dict)
                        and item.get("status") in ("MATCH", "SUBSTITUTE")
                        and isinstance(item.get("book_index"), int)
                    ]
                    last_idx = max(attempted) if attempted else -1
                    for item in report.alignment:
                        if not isinstance(item, dict):
                            continue
                        idx = item.get("book_index")
                        item_status = item.get("status")
                        if not isinstance(idx, int) or idx > last_idx:
                            continue
                        if item_status not in ("SUBSTITUTE", "DELETE"):
                            continue
                        raw_text = str(item.get("book_word", "")).strip()
                        norm = normalize_vietnamese_practice_word(raw_text)
                        if not norm:
                            continue
                        acc = acc_for(norm)
                        acc.observe(
                            display_text=raw_text,
                            seen_at=report.created_at,
                            session_id=report.session_id,
                            **source_meta_for(
                                report.session_id,
                                report.page_id,
                                report.page_revision_id,
                                word_index=idx,
                                fallback_text=raw_text,
                            ),
                        )
                        if item_status == "DELETE":
                            acc.omission_count += 1
                        else:
                            acc.mispronunciation_count += 1

        # 2. Aggregate reading events (repetitions, long pauses, read examples, or un-finalized misses).
        for event, page_word_text in events:
            if event.Status in ("IGNORED_BY_GATE", "DISMISSED"):
                continue
            raw_text = page_word_text
            if not raw_text and isinstance(event.Metadata, dict):
                candidate = event.Metadata.get("target_word")
                if isinstance(candidate, str):
                    raw_text = candidate
            norm = normalize_vietnamese_practice_word(raw_text)
            if not norm:
                continue

            normalized_type = (
                "MISPRONUNCIATION"
                if event.Type in ("MISPRONUNCIATION", "SUBSTITUTION")
                else event.Type
            )
            dedup_key = (
                event.SessionId,
                event.PageId,
                event.WordId,
                normalized_type,
                norm,
            )
            if normalized_type in ("OMISSION", "MISPRONUNCIATION") and dedup_key in seen_event_keys:
                continue
            seen_event_keys.add(dedup_key)

            acc = acc_for(norm)
            acc.observe(
                display_text=raw_text or norm,
                seen_at=event.CreatedAt,
                session_id=event.SessionId,
                word_id=event.WordId,
                **source_meta_for(
                    event.SessionId,
                    event.PageId,
                    event.PageRevisionId,
                    word_id=event.WordId,
                    fallback_text=raw_text or norm,
                ),
            )
            if normalized_type == "OMISSION":
                acc.omission_count += 1
            elif normalized_type == "MISPRONUNCIATION":
                acc.mispronunciation_count += 1
            elif normalized_type == "REPETITION":
                acc.repetition_count += 1
            elif normalized_type == "LONG_PAUSE":
                acc.long_pause_count += 1
            elif normalized_type == "READ_EXAMPLE":
                acc.read_example_count += 1

        # 3. Merge any valid words from a saved ProgressReport if present and missing.
        if (
            saved_report is not None
            and isinstance(saved_report.Summary, dict)
            and isinstance(saved_report.Summary.get("difficult_words"), list)
        ):
            try:
                saved_words = TypeAdapter(list[DifficultWordRead]).validate_python(
                    saved_report.Summary["difficult_words"]
                )
            except (ValidationError, TypeError, ValueError):
                saved_words = []
            for sw in saved_words:
                norm = normalize_vietnamese_practice_word(sw.normalized_word or sw.display_text)
                if norm and norm not in accumulators:
                    acc = acc_for(norm)
                    acc.observe(display_text=sw.display_text, seen_at=sw.last_seen_at)
                    acc.omission_count = sw.omission_count
                    acc.repetition_count = sw.repetition_count
                    acc.long_pause_count = sw.long_pause_count
                    acc.read_example_count = sw.read_example_count
                    acc.mispronunciation_count = sw.mispronunciation_count
                    acc.evidence_word_ids.update(sw.evidence_word_ids)

        results: list[DifficultWordRead] = []
        for norm, acc in accumulators.items():
            # Require at least one difficulty/example signal.
            if (
                acc.omission_count
                + acc.mispronunciation_count
                + acc.repetition_count
                + acc.long_pause_count
                + acc.read_example_count
            ) <= 0:
                continue
            progress = compute_word_practice_progress(
                norm, attempts_by_word.get(norm, []), acc.last_seen_at
            )
            results.append(acc.to_read(progress))

        results.sort(key=_priority_sort_key)
        if status_filter is not None:
            results = [w for w in results if w.practice_status == status_filter]
        return results

    async def _require_storage_ready(self) -> None:
        if not await self.repository.is_practice_storage_ready():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="DIFFICULT_WORD_PRACTICE_STORAGE_UNAVAILABLE",
            )

    async def _next_recommended_word(
        self,
        child_id: UUID,
        actor_id: UUID,
        current_normalized_word: str,
    ) -> str | None:
        words = await self.list_difficult_words(child_id, actor_id)
        incomplete = [
            w.normalized_word
            for w in words
            if w.normalized_word != current_normalized_word
            and w.practice_status != "COMPLETED"
        ]
        if incomplete:
            return incomplete[0]
        others = [
            w.normalized_word
            for w in words
            if w.normalized_word != current_normalized_word
        ]
        return others[0] if others else None

    def _to_attempt_read(
        self,
        attempt: Any,
        word_attempts: list[Any],
        next_recommended_word: str | None,
        *,
        persistence_backend: str | None = None,
        resolved_in_session: bool = False,
    ) -> DifficultWordPracticeAttemptRead:
        progress = compute_word_practice_progress(
            attempt.NormalizedWord, word_attempts
        )
        evidence_ids: list[UUID] = []
        if isinstance(attempt.EvidenceWordIds, list):
            for raw_id in attempt.EvidenceWordIds:
                parsed = self._parse_uuid(raw_id)
                if parsed is not None:
                    evidence_ids.append(parsed)
        return DifficultWordPracticeAttemptRead(
            attempt_id=attempt.Id,
            child_id=attempt.ChildId,
            normalized_word=attempt.NormalizedWord,
            display_text=attempt.DisplayText,
            attempt_number=attempt.AttemptNumber,
            state=attempt.State,
            assessment_status=attempt.AssessmentStatus,
            recognition_source=attempt.RecognitionSource,
            spoken_transcript=attempt.SpokenTranscript,
            confidence=attempt.Confidence,
            audio_duration_ms=attempt.AudioDurationMs,
            assessment_version=attempt.AssessmentVersion,
            evidence_word_ids=evidence_ids,
            book_id=getattr(attempt, "BookId", None),
            session_id=getattr(attempt, "SessionId", None),
            page_id=getattr(attempt, "PageId", None),
            page_revision_id=getattr(attempt, "PageRevisionId", None),
            word_id=getattr(attempt, "WordId", None),
            resolved_in_session=resolved_in_session,
            persistence_backend=persistence_backend,
            started_at=_ensure_utc(attempt.StartedAt) or datetime.now(timezone.utc),
            completed_at=_ensure_utc(attempt.CompletedAt),
            feedback_message=build_child_friendly_feedback(
                attempt.AssessmentStatus,
                progress.practice_status,
                progress.consecutive_correct_count,
            ),
            word_progress=progress,
            next_recommended_word=next_recommended_word,
            evidence_count_unchanged=True,
        )

    async def _evaluate_audio_payload(
        self,
        *,
        display_text: str,
        audio_bytes: bytes | None,
        filename: str,
        content_type: str | None,
        audio_quality_status: str | None = None,
        browser_transcript: str | None = None,
        browser_confidence: float | None = None,
        context_phrase: str | None = None,
    ) -> tuple[
        PracticeAssessmentStatusLiteral,
        PracticeRecognitionSourceLiteral,
        str | None,
        float | None,
    ]:
        clean_browser_text = (
            unicodedata.normalize("NFC", browser_transcript).strip()[:160]
            if isinstance(browser_transcript, str) and browser_transcript.strip()
            else None
        )
        valid_browser_conf = (
            browser_confidence
            if browser_confidence is not None
            and math.isfinite(browser_confidence)
            and 0.0 <= browser_confidence <= 1.0
            else None
        )
        browser_usable = bool(
            clean_browser_text and has_usable_browser_confidence(browser_confidence)
        )
        browser_status: PracticeAssessmentStatusLiteral | None = (
            classify_practice_transcript(
                display_text, clean_browser_text, context_phrase=context_phrase
            )
            if browser_usable
            else None
        )
        browser_disagrees = (
            browser_status == "INCORRECT"
            and valid_browser_conf is not None
            and valid_browser_conf >= 0.75
        )

        if audio_bytes is not None and len(audio_bytes) > 0:
            lower_name = (filename or "").lower()
            is_valid_prefix = bool(
                content_type and content_type.startswith(ALLOWED_AUDIO_PREFIXES)
            )
            is_valid_ext = any(lower_name.endswith(ext) for ext in ALLOWED_AUDIO_EXTENSIONS)
            if content_type and not (is_valid_prefix or is_valid_ext):
                raise HTTPException(
                    status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                    detail="UNSUPPORTED_AUDIO",
                )
            if len(audio_bytes) > MAX_PRACTICE_AUDIO_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail="AUDIO_TOO_LARGE",
                )
        elif not browser_usable or browser_status is None:
            if audio_bytes is not None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="EMPTY_AUDIO",
                )
            return ("NO_CLEAR_AUDIO", "AUDIO_QUALITY_GATE", None, None)

        if audio_bytes is None or len(audio_bytes) == 0:
            assert browser_status is not None
            return (
                browser_status,
                "BROWSER_SPEECH",
                clean_browser_text,
                valid_browser_conf,
            )

        effective_content_type = (
            content_type
            if content_type and content_type != "application/octet-stream"
            else "audio/webm"
        )

        exact_browser_read = (
            browser_status == "CORRECT"
            and valid_browser_conf is not None
            and valid_browser_conf >= 0.9
            and _short_word_tokens(clean_browser_text) == _short_word_tokens(display_text)
        )
        if audio_quality_status in UNUSABLE_AUDIO_QUALITY_STATUSES and not (
            exact_browser_read and audio_quality_status == "AUDIO_TOO_SHORT"
        ):
            return ("NO_CLEAR_AUDIO", "AUDIO_QUALITY_GATE", None, None)

        if browser_usable and is_word_help_request(clean_browser_text, display_text):
            return ("UNCERTAIN", "BROWSER_SPEECH", clean_browser_text, valid_browser_conf)

        if exact_browser_read:
            return ("CORRECT", "BROWSER_SPEECH", clean_browser_text, valid_browser_conf)

        resolved_status: PracticeAssessmentStatusLiteral
        resolved_source: PracticeRecognitionSourceLiteral = "SERVER_STT"
        spoken_transcript: str | None = None
        calibrated_confidence: float | None = None

        try:
            first_pass = await asyncio.wait_for(
                self.voice_provider.transcribe(
                    audio=audio_bytes,
                    filename=filename or "practice.webm",
                    content_type=effective_content_type,
                    language_code="vi",
                ),
                timeout=7,
            )
            first_text = unicodedata.normalize("NFC", first_pass.text).strip()[:160]
            spoken_transcript = first_text or None
            first_tokens = _short_word_tokens(first_text)
            target_tokens = _short_word_tokens(display_text)
            primary_matches = (
                bool(first_tokens)
                and first_tokens == target_tokens
                and first_pass.language_code in (None, "vi", "vie", "vi-VN")
                and (
                    not first_pass.words
                    or any(word.get("type") in (None, "word") for word in first_pass.words)
                )
                and not browser_disagrees
            )

            # Pure ambient/non-speech tag like "[tiếng đập]" must never be graded INCORRECT.
            if first_text and not first_tokens:
                first_status: PracticeAssessmentStatusLiteral = "NO_CLEAR_AUDIO"
            elif (
                primary_matches
                and browser_status == "CORRECT"
                and _short_word_tokens(clean_browser_text) == target_tokens
            ):
                # Two unprompted exact matches can corroborate a weak word score.
                first_status = "CORRECT"
            elif has_usable_practice_transcript(first_pass):
                if is_word_help_request(first_text, display_text):
                    return ("UNCERTAIN", "SERVER_STT", first_text, None)
                first_status = classify_practice_transcript(
                    display_text, first_text, context_phrase=context_phrase
                )
            else:
                first_status = "UNCERTAIN"

            resolved_status = first_status
            resolved_source = "SERVER_STT"

            if (
                (first_status == "CORRECT" and browser_disagrees)
                or (first_status == "INCORRECT" and browser_status == "CORRECT")
            ):
                return ("UNCERTAIN", "SERVER_STT", spoken_transcript, None)

            # Hints can transcribe the requested word even when nothing resembling
            # it was said. Require independent lexical evidence before using them.
            corroborated = browser_status == "CORRECT"
            should_retry_with_keyterm = (
                first_status == "UNCERTAIN" and (corroborated or primary_matches)
            )
            if should_retry_with_keyterm:
                try:
                    second_pass = await asyncio.wait_for(
                        self.voice_provider.transcribe(
                            audio=audio_bytes,
                            filename=filename or "practice.webm",
                            content_type=effective_content_type,
                            language_code="vi",
                            keyterms=[display_text],
                        ),
                        timeout=3,
                    )
                    second_text = unicodedata.normalize("NFC", second_pass.text).strip()[:160]
                    high_conf = has_high_confidence_keyterm_result(second_pass)
                    if has_usable_practice_transcript(second_pass) and (
                        corroborated or high_conf
                    ):
                        resolved_status = classify_practice_transcript(
                            display_text, second_text, context_phrase=context_phrase
                        )
                        resolved_source = "SERVER_STT_KEYTERM"
                        spoken_transcript = second_text or spoken_transcript
                except (VoiceProviderError, TimeoutError):
                    pass

            if resolved_status in ("UNCERTAIN", "NO_CLEAR_AUDIO") and browser_status == "CORRECT":
                # Live browser speech heard target word, while audio recording did not confirm cleanly.
                resolved_status = "UNCERTAIN"
        except (VoiceProviderError, TimeoutError):
            if browser_usable and browser_status is not None:
                resolved_status = browser_status
                resolved_source = "BROWSER_SPEECH"
                spoken_transcript = clean_browser_text
                calibrated_confidence = valid_browser_conf
            else:
                resolved_status = "ENGINE_ERROR"
                resolved_source = "ENGINE_ERROR"

        if resolved_status == "INCORRECT" and has_confusable_nasal_ending(display_text, spoken_transcript):
            corroborated = (
                resolved_source == "SERVER_STT"
                and browser_usable
                and valid_browser_conf is not None
                and valid_browser_conf >= 0.75
                and normalize_vietnamese_practice_word(clean_browser_text)
                == normalize_vietnamese_practice_word(spoken_transcript)
            )
            if not corroborated:
                resolved_status = "UNCERTAIN"

        return (resolved_status, resolved_source, spoken_transcript, calibrated_confidence)

    async def start_attempt(
        self,
        child_id: UUID,
        actor_id: UUID,
        payload: DifficultWordPracticeStartRequest,
    ) -> DifficultWordPracticeAttemptRead:
        await self.access.require_child(child_id, actor_id)
        await self._require_storage_ready()

        normalized_word = normalize_vietnamese_practice_word(payload.normalized_word)
        if not normalized_word:
            raise HTTPException(status_code=422, detail="INVALID_PRACTICE_WORD")
        display_text = unicodedata.normalize(
            "NFC", (payload.display_text or payload.normalized_word).strip()
        )[:120]
        if not display_text:
            display_text = normalized_word

        existing = await self.repository.find_practice_attempt_by_request(
            child_id, actor_id, normalized_word, payload.request_id
        )
        if existing is not None:
            word_attempts = await self.repository.list_practice_attempts(
                child_id, actor_id, normalized_word=normalized_word
            )
            next_word = await self._next_recommended_word(
                child_id, actor_id, normalized_word
            )
            return self._to_attempt_read(existing, word_attempts, next_word)

        attempt_number = await self.repository.next_attempt_number(
            child_id, normalized_word
        )
        now = datetime.now(timezone.utc)
        attempt = DifficultWordPracticeAttempt(
            ChildId=child_id,
            ParentId=actor_id,
            NormalizedWord=normalized_word,
            DisplayText=display_text,
            AttemptNumber=attempt_number,
            RequestId=payload.request_id,
            State="STARTED",
            AssessmentVersion=1,
            EvidenceWordIds=[str(item) for item in payload.evidence_word_ids],
            BookId=payload.book_id,
            SessionId=payload.session_id,
            PageId=payload.page_id,
            PageRevisionId=payload.page_revision_id,
            WordId=payload.word_id,
            StartedAt=now,
            CreatedAt=now,
            UpdatedAt=now,
        )
        created = await self.repository.create_practice_attempt(attempt)
        word_attempts = await self.repository.list_practice_attempts(
            child_id, actor_id, normalized_word=normalized_word
        )
        next_word = await self._next_recommended_word(
            child_id, actor_id, normalized_word
        )
        return self._to_attempt_read(created, word_attempts, next_word)

    async def complete_attempt(
        self,
        child_id: UUID,
        attempt_id: UUID,
        actor_id: UUID,
        payload: DifficultWordPracticeCompleteRequest,
    ) -> DifficultWordPracticeAttemptRead:
        await self.access.require_child(child_id, actor_id)
        await self._require_storage_ready()

        attempt = await self.repository.get_practice_attempt(child_id, attempt_id, actor_id)
        if attempt is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="DIFFICULT_WORD_ATTEMPT_NOT_FOUND",
            )

        if attempt.State == "COMPLETED":
            if attempt.CompletionRequestId == payload.completion_request_id:
                word_attempts = await self.repository.list_practice_attempts(
                    child_id, actor_id, normalized_word=attempt.NormalizedWord
                )
                next_word = await self._next_recommended_word(
                    child_id, actor_id, attempt.NormalizedWord
                )
                return self._to_attempt_read(attempt, word_attempts, next_word)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="DIFFICULT_WORD_ATTEMPT_ALREADY_COMPLETED",
            )

        transcript_clean = (
            unicodedata.normalize("NFC", payload.spoken_transcript).strip()[:160]
            if isinstance(payload.spoken_transcript, str)
            and payload.spoken_transcript.strip()
            else None
        )
        resolved_status = payload.assessment_status
        resolved_source = payload.recognition_source

        # Server-authoritative re-check when client provides a browser transcript.
        if resolved_source == "BROWSER_SPEECH":
            if not has_usable_browser_confidence(payload.confidence):
                resolved_status = "UNCERTAIN"
            elif transcript_clean is None:
                resolved_status = "NO_CLEAR_AUDIO"
            else:
                resolved_status = classify_practice_transcript(
                    attempt.DisplayText, transcript_clean
                )

        now = datetime.now(timezone.utc)
        attempt.CompletionRequestId = payload.completion_request_id
        attempt.State = "COMPLETED"
        attempt.AssessmentStatus = resolved_status
        attempt.RecognitionSource = resolved_source
        attempt.SpokenTranscript = transcript_clean
        attempt.Confidence = payload.confidence
        attempt.AudioDurationMs = payload.audio_duration_ms
        attempt.CompletedAt = now
        attempt.UpdatedAt = now

        saved = await self.repository.save_practice_attempt(attempt)
        word_attempts = await self.repository.list_practice_attempts(
            child_id, actor_id, normalized_word=saved.NormalizedWord
        )
        next_word = await self._next_recommended_word(
            child_id, actor_id, saved.NormalizedWord
        )
        return self._to_attempt_read(saved, word_attempts, next_word)

    async def evaluate_audio_attempt(
        self,
        child_id: UUID,
        attempt_id: UUID,
        actor_id: UUID,
        *,
        completion_request_id: UUID,
        audio_bytes: bytes,
        filename: str,
        content_type: str | None,
        audio_duration_ms: int | None = None,
        audio_quality_status: str | None = None,
        browser_transcript: str | None = None,
        browser_confidence: float | None = None,
    ) -> DifficultWordPracticeAttemptRead:
        await self.access.require_child(child_id, actor_id)
        await self._require_storage_ready()

        attempt = await self.repository.get_practice_attempt(child_id, attempt_id, actor_id)
        if attempt is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="DIFFICULT_WORD_ATTEMPT_NOT_FOUND",
            )

        if attempt.State == "COMPLETED":
            if attempt.CompletionRequestId == completion_request_id:
                word_attempts = await self.repository.list_practice_attempts(
                    child_id, actor_id, normalized_word=attempt.NormalizedWord
                )
                next_word = await self._next_recommended_word(
                    child_id, actor_id, attempt.NormalizedWord
                )
                return self._to_attempt_read(attempt, word_attempts, next_word)
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="DIFFICULT_WORD_ATTEMPT_ALREADY_COMPLETED",
            )

        if not audio_bytes and not (
            isinstance(browser_transcript, str) and browser_transcript.strip()
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="EMPTY_AUDIO",
            )

        (
            resolved_status,
            resolved_source,
            spoken_transcript,
            calibrated_confidence,
        ) = await self._evaluate_audio_payload(
            display_text=attempt.DisplayText,
            audio_bytes=audio_bytes,
            filename=filename,
            content_type=content_type,
            audio_quality_status=audio_quality_status,
            browser_transcript=browser_transcript,
            browser_confidence=browser_confidence,
        )

        now = datetime.now(timezone.utc)
        attempt.CompletionRequestId = completion_request_id
        attempt.State = "COMPLETED"
        attempt.AssessmentStatus = resolved_status
        attempt.RecognitionSource = resolved_source
        attempt.SpokenTranscript = spoken_transcript
        attempt.Confidence = calibrated_confidence
        attempt.AudioDurationMs = audio_duration_ms
        attempt.CompletedAt = now
        attempt.UpdatedAt = now

        saved = await self.repository.save_practice_attempt(attempt)
        word_attempts = await self.repository.list_practice_attempts(
            child_id, actor_id, normalized_word=saved.NormalizedWord
        )
        next_word = await self._next_recommended_word(
            child_id, actor_id, saved.NormalizedWord
        )
        return self._to_attempt_read(saved, word_attempts, next_word)

    async def evaluate_word_direct(
        self,
        child_id: UUID,
        actor_id: UUID,
        *,
        request_id: UUID,
        normalized_word: str,
        display_text: str | None = None,
        audio_bytes: bytes | None = None,
        filename: str = "practice.webm",
        content_type: str | None = None,
        audio_duration_ms: int | None = None,
        audio_quality_status: str | None = None,
        browser_transcript: str | None = None,
        browser_confidence: float | None = None,
        evidence_word_ids: list[UUID] | None = None,
        book_id: UUID | None = None,
        session_id: UUID | None = None,
        page_id: UUID | None = None,
        page_revision_id: UUID | None = None,
        word_id: UUID | None = None,
        context_phrase: str | None = None,
    ) -> DifficultWordPracticeAttemptRead:
        """Single-call audio evaluation + durable dual-store save without 503 crashes when legacy DB lacks the practice table."""
        await self.access.require_child(child_id, actor_id)

        norm = normalize_vietnamese_practice_word(normalized_word)
        if not norm:
            raise HTTPException(status_code=422, detail="INVALID_PRACTICE_WORD")
        clean_display = unicodedata.normalize(
            "NFC", (display_text or normalized_word).strip()
        )[:120] or norm

        await self.repository.lock_practice_request(child_id, request_id)
        storage_ready = await self.repository.is_practice_storage_ready()
        if storage_ready:
            existing = await self.repository.find_practice_attempt_by_request(
                child_id, actor_id, norm, request_id
            )
            if existing is not None and existing.State == "COMPLETED":
                _, _, word_attempts = await self._load_merged_attempts(
                    child_id, actor_id, normalized_word=norm
                )
                next_word = await self._next_recommended_word(child_id, actor_id, norm)
                return self._to_attempt_read(existing, word_attempts, next_word)

        find_retry = getattr(self.repository, "find_retry_event_by_request", None)
        if callable(find_retry):
            existing_event = await find_retry(child_id, actor_id, norm, request_id)
            if existing_event is not None:
                _, _, word_attempts = await self._load_merged_attempts(
                    child_id, actor_id, normalized_word=norm
                )
                matching = next(
                    (a for a in word_attempts if a.Id == existing_event.Id),
                    word_attempts[-1] if word_attempts else None,
                )
                if matching is not None:
                    next_word = await self._next_recommended_word(child_id, actor_id, norm)
                    return self._to_attempt_read(
                        matching,
                        word_attempts,
                        next_word,
                        persistence_backend="READING_EVENT",
                        resolved_in_session=matching.AssessmentStatus == "CORRECT",
                    )

        resolve_fn = getattr(self.repository, "resolve_retry_target", None)
        resolved_word_hint = word_id or (evidence_word_ids[0] if evidence_word_ids else None)
        retry_target = (
            await resolve_fn(
                child_id,
                actor_id,
                session_id=session_id,
                page_id=page_id,
                page_revision_id=page_revision_id,
                word_id=resolved_word_hint,
            )
            if callable(resolve_fn)
            else None
        )
        if not storage_ready and retry_target is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="DIFFICULT_WORD_PRACTICE_STORAGE_UNAVAILABLE",
            )

        (
            resolved_status,
            resolved_source,
            spoken_transcript,
            calibrated_confidence,
        ) = await self._evaluate_audio_payload(
            display_text=clean_display,
            audio_bytes=audio_bytes,
            filename=filename,
            content_type=content_type,
            audio_quality_status=audio_quality_status,
            browser_transcript=browser_transcript,
            browser_confidence=browser_confidence,
            context_phrase=context_phrase,
        )

        now = datetime.now(timezone.utc)
        saved_table_row: DifficultWordPracticeAttempt | None = None
        if storage_ready:
            attempt_number = await self.repository.next_attempt_number(child_id, norm)
            attempt = DifficultWordPracticeAttempt(
                ChildId=child_id,
                ParentId=actor_id,
                NormalizedWord=norm,
                DisplayText=clean_display,
                AttemptNumber=attempt_number,
                RequestId=request_id,
                CompletionRequestId=request_id,
                State="COMPLETED",
                AssessmentStatus=resolved_status,
                RecognitionSource=resolved_source,
                SpokenTranscript=spoken_transcript,
                Confidence=calibrated_confidence,
                AudioDurationMs=audio_duration_ms,
                AssessmentVersion=1,
                EvidenceWordIds=[str(item) for item in (evidence_word_ids or [])],
                BookId=book_id,
                SessionId=retry_target[0] if retry_target else session_id,
                PageId=retry_target[1] if retry_target else page_id,
                PageRevisionId=retry_target[2] if retry_target else page_revision_id,
                WordId=retry_target[3] if retry_target else resolved_word_hint,
                StartedAt=now,
                CompletedAt=now,
                CreatedAt=now,
                UpdatedAt=now,
            )
            saved_table_row = await self.repository.create_practice_attempt(attempt)

        saved_event_row: ReadingEvent | None = None
        create_event_fn = getattr(self.repository, "create_retry_event", None)
        stats_fn = getattr(self.repository, "existing_word_retry_stats", None)
        if retry_target is not None and callable(create_event_fn):
            target_session, target_page, target_rev, target_word = retry_target
            next_retry_no, prev_incorrect = (
                await stats_fn(target_session, target_page, target_rev, target_word)
                if callable(stats_fn)
                else (1, 0)
            )
            incorrect_count = min(3, prev_incorrect + (1 if resolved_status == "INCORRECT" else 0))
            event_status = (
                "CONFIRMED"
                if resolved_status == "CORRECT"
                else "FAILED"
                if resolved_status == "INCORRECT"
                else "UNCERTAIN"
            )
            resolution_status = (
                "SELF_CORRECTED"
                if resolved_status == "CORRECT"
                else "UNRESOLVED"
                if incorrect_count >= 3
                else "RETRYING"
            )
            event = ReadingEvent(
                SessionId=target_session,
                PageId=target_page,
                PageRevisionId=target_rev,
                WordId=target_word,
                Type="WORD_RETRY",
                StartMs=0,
                EndMs=min(32767, max(0, audio_duration_ms or 0)),
                Confidence=calibrated_confidence,
                Status=event_status,
                Metadata={
                    "retry_attempt": next_retry_no,
                    "incorrect_retry_count": incorrect_count,
                    "resolution_status": resolution_status,
                    "target_word": clean_display[:100],
                    "recognized_text": spoken_transcript[:200] if spoken_transcript else None,
                    "practice_origin": "DIFFICULT_WORDS_REPORT",
                    "practice_assessment_status": resolved_status,
                    "recognition_source": resolved_source,
                    "normalized_word": norm[:120],
                    "request_id": str(request_id),
                    "completion_request_id": str(request_id),
                    "audio_duration_ms": audio_duration_ms,
                },
                CreatedAt=now,
            )
            try:
                saved_event_row = await create_event_fn(event)
            except Exception:
                if saved_table_row is None:
                    raise

        _, _, word_attempts = await self._load_merged_attempts(
            child_id, actor_id, normalized_word=norm
        )
        next_word = await self._next_recommended_word(child_id, actor_id, norm)
        backend_label: str = (
            "PRACTICE_TABLE_AND_EVENT"
            if saved_table_row is not None and saved_event_row is not None
            else "PRACTICE_TABLE"
            if saved_table_row is not None
            else "READING_EVENT"
        )
        primary_record: Any = saved_table_row
        if primary_record is None:
            assert saved_event_row is not None
            primary_record = _PracticeRecordAdapter(
                Id=saved_event_row.Id,
                ChildId=child_id,
                NormalizedWord=norm,
                DisplayText=clean_display,
                AttemptNumber=int((saved_event_row.Metadata or {}).get("retry_attempt") or 1),
                State="COMPLETED",
                AssessmentStatus=resolved_status,
                RecognitionSource=resolved_source,
                SpokenTranscript=spoken_transcript,
                Confidence=calibrated_confidence,
                AudioDurationMs=audio_duration_ms,
                AssessmentVersion=1,
                EvidenceWordIds=evidence_word_ids or [],
                StartedAt=now,
                CompletedAt=now,
                BookId=book_id,
                SessionId=saved_event_row.SessionId,
                PageId=saved_event_row.PageId,
                PageRevisionId=saved_event_row.PageRevisionId,
                WordId=saved_event_row.WordId,
            )
        return self._to_attempt_read(
            primary_record,
            word_attempts,
            next_word,
            persistence_backend=backend_label,
            resolved_in_session=bool(saved_event_row is not None and resolved_status == "CORRECT"),
        )

    async def practice_history(
        self,
        child_id: UUID,
        actor_id: UUID,
        *,
        normalized_word: str | None = None,
        limit: int = 20,
    ) -> DifficultWordPracticeHistoryRead:
        await self.access.require_child(child_id, actor_id)
        norm_filter = (
            normalize_vietnamese_practice_word(normalized_word)
            if normalized_word is not None
            else None
        )
        _, effective_ready, rows = await self._load_merged_attempts(
            child_id, actor_id, normalized_word=norm_filter
        )
        rows.sort(
            key=lambda r: (
                _ensure_utc(r.CompletedAt or r.StartedAt)
                or datetime.min.replace(tzinfo=timezone.utc),
                r.AttemptNumber,
            ),
            reverse=True,
        )
        return DifficultWordPracticeHistoryRead(
            storage_ready=effective_ready,
            items=[
                DifficultWordPracticeHistoryItemRead(
                    attempt_id=row.Id,
                    normalized_word=row.NormalizedWord,
                    display_text=row.DisplayText,
                    attempt_number=row.AttemptNumber,
                    state=row.State,
                    assessment_status=row.AssessmentStatus,
                    recognition_source=row.RecognitionSource,
                    spoken_transcript=row.SpokenTranscript,
                    confidence=row.Confidence,
                    audio_duration_ms=row.AudioDurationMs,
                    assessment_version=row.AssessmentVersion,
                    started_at=_ensure_utc(row.StartedAt) or datetime.now(timezone.utc),
                    completed_at=_ensure_utc(row.CompletedAt),
                )
                for row in rows[:limit]
            ],
        )
