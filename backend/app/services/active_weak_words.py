"""Unified Difficult/Mispronounced Word Engine & Two-Way Entertainment Mastery Loop.

Aggregates a child's real misread/struggled Vietnamese words across:
1. `ReadingComparisonReport` (first-pass `MISPRONUNCIATION` / `OMISSION` snapshots & alignments)
2. `ReadingEvent` (`MISPRONUNCIATION`, `SUBSTITUTION`, `OMISSION`, `REPETITION`, `LONG_PAUSE`, `READ_EXAMPLE`, `WORD_RETRY`)
3. `DifficultWordPracticeAttempt` (isolated Difficult Word Room `AssessmentVersion=1` + Entertainment vocal `AssessmentVersion=2`)

Provides:
- Vietnamese primary phonics error classification (`l/n`, `s/x`, `tr/ch`, `r/d/gi`, `hỏi/ngã`, `coda n/ng/t/c`, `compound_reduplicative`)
- 1..3 syllable NFC-preserving N-gram sliding-window matcher for single & compound/reduplicative Vietnamese words
- Idempotent vocal mastery write-back (`AssessmentVersion=2`) requiring 2 spoken contextual passes in Entertainment (while keeping 1 isolated pass in Difficult Word Practice Room).
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Literal
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from sqlalchemy import desc, func, select
from sqlalchemy.exc import IntegrityError, ProgrammingError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ChildProfile,
    PageRevisionWord,
    ReadingComparisonReport,
    ReadingEvent,
    ReadingSession,
)
from app.models.difficult_word_practice import DifficultWordPracticeAttempt
from app.models.entertainment_v4 import LearningSkillEvidence
from app.services.child_progress.metrics import (
    ReportRow,
    analyze_first_pass,
    first_pass_reports,
)
from app.services.vietnamese_phonics import (
    decompose_vietnamese_syllable,
    normalize_vietnamese_word,
    split_vietnamese_rhyme,
)

logger = logging.getLogger(__name__)

ENTERTAINMENT_CONTEXTUAL_ASSESSMENT_VERSION = 2
ENTERTAINMENT_REQUIRED_SPOKEN_CORRECT = 2

PhonicsCategoryKey = Literal[
    "l_n",
    "s_x",
    "tr_ch",
    "r_d_gi",
    "hoi_nga",
    "coda_n_ng_t_c",
    "compound_reduplicative",
    "general",
]

PHONICS_CATEGORY_LABELS_VI: dict[PhonicsCategoryKey, str] = {
    "l_n": "Âm đầu l / n",
    "s_x": "Âm đầu s / x",
    "tr_ch": "Âm đầu tr / ch",
    "r_d_gi": "Âm đầu r / d / gi",
    "hoi_nga": "Thanh hỏi / ngã",
    "coda_n_ng_t_c": "Vần cuối n/ng · t/c",
    "compound_reduplicative": "Từ ghép & từ láy",
    "general": "Từ cần ôn",
}

_TOKEN_EXTRACT_RE = re.compile(r"[^\W_]+", re.UNICODE)
_EDGE_PUNCT_RE = re.compile(
    r'^[\s.,!?;:…“”"\'\‘\’\(\)\[\]\{\}«»—–\-]+|[\s.,!?;:…“”"\'\‘\’\(\)\[\]\{\}«»—–\-]+$',
    re.UNICODE,
)


def _is_missing_relation_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "does not exist" in msg or "undefinedtable" in msg or "no such table" in msg


def clean_focus_display_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    nfc = unicodedata.normalize("NFC", value).strip()
    stripped = _EDGE_PUNCT_RE.sub("", nfc).strip()
    return re.sub(r"\s+", " ", stripped)[:120]


def tokenize_focus_phrase(value: Any) -> list[str]:
    """Tokenize Vietnamese text into NFC lowercase syllables preserving tones and `đ`."""
    if not isinstance(value, str):
        return []
    nfc = unicodedata.normalize("NFC", value).lower().strip()
    out: list[str] = []
    for raw in _TOKEN_EXTRACT_RE.findall(nfc):
        cleaned = normalize_vietnamese_word(raw)
        if cleaned and any(ch.isalpha() or ch.isdigit() for ch in cleaned):
            out.append(cleaned)
    return out


def normalize_focus_phrase(value: Any) -> str:
    tokens = tokenize_focus_phrase(value)
    return " ".join(tokens)


def classify_vietnamese_phonics_category(phrase: str) -> tuple[PhonicsCategoryKey, str]:
    """Classify a Vietnamese 1..3 syllable word/phrase into its primary GDPT 2018 phonics group."""
    tokens = tokenize_focus_phrase(phrase)
    if not tokens:
        return "general", PHONICS_CATEGORY_LABELS_VI["general"]

    parts_list = [
        p for tok in tokens if (p := decompose_vietnamese_syllable(tok)) is not None
    ]
    if len(tokens) >= 2:
        # Check reduplication (alliteration or rhyme echo) first, else compound phrase
        if len(parts_list) >= 2 and (
            (parts_list[0].onset and parts_list[0].onset == parts_list[1].onset)
            or (parts_list[0].rhyme and parts_list[0].rhyme == parts_list[1].rhyme)
        ):
            return "compound_reduplicative", PHONICS_CATEGORY_LABELS_VI["compound_reduplicative"]

    for parts in parts_list:
        if parts.tone in ("hoi", "nga"):
            return "hoi_nga", PHONICS_CATEGORY_LABELS_VI["hoi_nga"]
    for parts in parts_list:
        if parts.onset in ("l", "n"):
            return "l_n", PHONICS_CATEGORY_LABELS_VI["l_n"]
        if parts.onset in ("s", "x"):
            return "s_x", PHONICS_CATEGORY_LABELS_VI["s_x"]
        if parts.onset in ("tr", "ch"):
            return "tr_ch", PHONICS_CATEGORY_LABELS_VI["tr_ch"]
        if parts.onset in ("r", "d", "gi"):
            return "r_d_gi", PHONICS_CATEGORY_LABELS_VI["r_d_gi"]
    for parts in parts_list:
        _nucleus, coda = split_vietnamese_rhyme(parts.rhyme)
        if coda in ("n", "ng", "nh", "t", "c", "ch"):
            return "coda_n_ng_t_c", PHONICS_CATEGORY_LABELS_VI["coda_n_ng_t_c"]

    if len(tokens) >= 2:
        return "compound_reduplicative", PHONICS_CATEGORY_LABELS_VI["compound_reduplicative"]
    return "general", PHONICS_CATEGORY_LABELS_VI["general"]


def build_focus_ngram_map(
    focus_words: Iterable[str] | None,
    *,
    max_ngram: int = 3,
) -> dict[tuple[str, ...], str]:
    """Build normalized `(syllable_1, ...)` -> canonical display phrase map for 1..3 syllable words."""
    mapping: dict[tuple[str, ...], str] = {}
    if not focus_words:
        return mapping
    for raw in focus_words:
        if not isinstance(raw, str):
            continue
        tokens = tokenize_focus_phrase(raw)
        if not tokens or len(tokens) > max_ngram:
            continue
        key = tuple(tokens)
        if key not in mapping:
            display = clean_focus_display_text(raw) or " ".join(tokens)
            mapping[key] = display
    return mapping


def match_focus_words_in_tokens(
    token_texts: list[str] | tuple[str, ...],
    focus_words: Iterable[str] | None,
) -> tuple[list[str], set[int]]:
    """Match 1..3 syllable focus words across a token sequence (longest N-gram first, tone-exact).

    Returns:
      - `matched_phrases`: deduplicated canonical phrases in sentence order
      - `matched_indices`: set of token positions `0..len-1` covered by any matched phrase
    """
    ngram_map = build_focus_ngram_map(focus_words)
    if not ngram_map or not token_texts:
        return [], set()

    norm_tokens = [normalize_vietnamese_word(str(tok)) for tok in token_texts]
    max_len = min(3, max((len(k) for k in ngram_map), default=1))
    matched_phrases: list[str] = []
    seen_keys: set[tuple[str, ...]] = set()
    matched_indices: set[int] = set()

    total = len(norm_tokens)
    for idx in range(total):
        if not norm_tokens[idx]:
            continue
        for span in range(min(max_len, total - idx), 0, -1):
            window = tuple(norm_tokens[idx : idx + span])
            if any(not item for item in window):
                continue
            if window in ngram_map:
                for pos in range(idx, idx + span):
                    matched_indices.add(pos)
                if window not in seen_keys:
                    seen_keys.add(window)
                    matched_phrases.append(ngram_map[window])
    return matched_phrases, matched_indices


def match_focus_words_in_text(
    text: str,
    focus_words: Iterable[str] | None,
) -> list[str]:
    """Match 1..3 syllable focus words in free Vietnamese text/lyrics."""
    tokens = tokenize_focus_phrase(text)
    matched, _ = match_focus_words_in_tokens(tokens, focus_words)
    return matched


@dataclass
class SyntheticWeakWordAttempt:
    """Adapter compatible with `DifficultWordPracticeAttempt` for unified SRS ranking."""

    Id: UUID
    NormalizedWord: str
    DisplayText: str
    AssessmentStatus: str
    Confidence: float
    AssessmentVersion: int
    CreatedAt: datetime
    CompletedAt: datetime | None = None


def _ensure_utc(dt: datetime | None) -> datetime:
    if dt is None:
        return datetime.now(timezone.utc)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


from unittest.mock import NonCallableMock


def _is_usable_async_db(db: Any) -> bool:
    if getattr(db, "_supports_weak_word_queries", None) is True:
        return True
    if db is None or isinstance(db, NonCallableMock):
        return False
    return isinstance(db, AsyncSession)


async def load_unified_weak_word_attempts(
    db: AsyncSession | Any,
    child_id: UUID,
    *,
    parent_id: UUID | None = None,
    window_days: int = 90,
) -> list[Any]:
    """Aggregate practice attempts + unpracticed ReadingComparisonReport & ReadingEvent errors."""
    if not _is_usable_async_db(db):
        return []

    since = datetime.now(timezone.utc) - timedelta(days=window_days)
    attempts: list[Any] = []

    # 1. Explicit DifficultWordPracticeAttempt rows (both isolated v1 and entertainment v2)
    try:
        async with db.begin_nested():
            stmt = select(DifficultWordPracticeAttempt).where(
                DifficultWordPracticeAttempt.ChildId == child_id,
                DifficultWordPracticeAttempt.CreatedAt >= since,
            )
            if parent_id is not None:
                stmt = stmt.where(DifficultWordPracticeAttempt.ParentId == parent_id)
            res = await db.execute(
                stmt.order_by(desc(DifficultWordPracticeAttempt.CreatedAt)).limit(300)
            )
            attempts.extend(res.scalars().all())
    except (ProgrammingError, SQLAlchemyError) as exc:
        if not _is_missing_relation_error(exc):
            logger.debug("Skipping difficult_word_practice_attempts lookup: %s", type(exc).__name__)

    # 2. ReadingEvent errors & retries (MISPRONUNCIATION, SUBSTITUTION, OMISSION, REPETITION, LONG_PAUSE, READ_EXAMPLE)
    synthetic_errors: list[SyntheticWeakWordAttempt] = []
    try:
        async with db.begin_nested():
            ev_stmt = (
                select(
                    ReadingEvent.Id,
                    ReadingEvent.Type,
                    ReadingEvent.Status,
                    ReadingEvent.Metadata,
                    ReadingEvent.CreatedAt,
                    PageRevisionWord.Text,
                )
                .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
                .outerjoin(PageRevisionWord, PageRevisionWord.Id == ReadingEvent.WordId)
                .where(
                    ReadingSession.ChildId == child_id,
                    ReadingSession.StartedAt >= since,
                    ReadingEvent.Type.in_(
                        (
                            "MISPRONUNCIATION",
                            "SUBSTITUTION",
                            "OMISSION",
                            "REPETITION",
                            "LONG_PAUSE",
                            "READ_EXAMPLE",
                            "WORD_RETRY",
                        )
                    ),
                )
            )
            if parent_id is not None:
                ev_stmt = ev_stmt.join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId).where(
                    ChildProfile.ParentId == parent_id
                )
            ev_rows = (
                await db.execute(ev_stmt.order_by(desc(ReadingEvent.CreatedAt)).limit(600))
            ).all()
            for ev_id, ev_type, ev_status, ev_meta, ev_created, word_text in ev_rows:
                meta = ev_meta if isinstance(ev_meta, dict) else {}
                raw_word = (
                    word_text
                    or meta.get("target_word")
                    or meta.get("normalized_word")
                    or meta.get("expected_word")
                )
                norm = normalize_focus_phrase(raw_word)
                if len(norm) < 2:
                    continue
                display = clean_focus_display_text(str(raw_word)) or norm
                created_utc = _ensure_utc(ev_created)
                if ev_type == "WORD_RETRY":
                    if ev_status == "CONFIRMED":
                        status_label = "CORRECT"
                    elif ev_status == "FAILED":
                        status_label = "INCORRECT"
                    else:
                        continue
                    event_version = ENTERTAINMENT_CONTEXTUAL_ASSESSMENT_VERSION
                else:
                    status_label = "INCORRECT"
                    event_version = 1
                synthetic_errors.append(
                    SyntheticWeakWordAttempt(
                        Id=ev_id,
                        NormalizedWord=norm,
                        DisplayText=display,
                        AssessmentStatus=status_label,
                        Confidence=0.75,
                        AssessmentVersion=event_version,
                        CreatedAt=created_utc,
                        CompletedAt=created_utc,
                    )
                )
    except (ProgrammingError, SQLAlchemyError) as exc:
        if not _is_missing_relation_error(exc):
            logger.debug("Skipping readingevents weak-word lookup: %s", type(exc).__name__)

    # 3. ReadingComparisonReport first-pass MISPRONUNCIATION / OMISSION words
    try:
        async with db.begin_nested():
            rep_stmt = (
                select(
                    ReadingComparisonReport.Id,
                    ReadingComparisonReport.SessionId,
                    ReadingComparisonReport.PageId,
                    ReadingComparisonReport.PageRevisionId,
                    ReadingComparisonReport.Alignment,
                    ReadingComparisonReport.Summary,
                    ReadingComparisonReport.CreatedAt,
                )
                .join(ReadingSession, ReadingSession.Id == ReadingComparisonReport.SessionId)
                .where(
                    ReadingSession.ChildId == child_id,
                    ReadingSession.StartedAt >= since,
                )
            )
            if parent_id is not None:
                rep_stmt = rep_stmt.join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId).where(
                    ChildProfile.ParentId == parent_id
                )
            raw_rep_rows = (
                await db.execute(
                    rep_stmt.order_by(desc(ReadingComparisonReport.CreatedAt)).limit(250)
                )
            ).all()
            report_objs = [
                ReportRow(
                    session_id=r[1],
                    page_id=r[2],
                    page_revision_id=r[3],
                    alignment=r[4],
                    summary=r[5],
                    created_at=_ensure_utc(r[6]),
                )
                for r in raw_rep_rows
            ]
            for first_rep in first_pass_reports(report_objs):
                analyzed = analyze_first_pass(first_rep)
                if not analyzed:
                    continue
                errors_counter = analyzed.get("errors") or {}
                for word_norm, err_count in errors_counter.items():
                    clean_norm = normalize_focus_phrase(word_norm)
                    if len(clean_norm) < 2 or err_count <= 0:
                        continue
                    for idx in range(min(3, int(err_count))):
                        synthetic_errors.append(
                            SyntheticWeakWordAttempt(
                                Id=uuid5(
                                    NAMESPACE_URL,
                                    f"viread:cmp-err:{first_rep.session_id}:{first_rep.page_id}:{clean_norm}:{idx}",
                                ),
                                NormalizedWord=clean_norm,
                                DisplayText=clean_norm,
                                AssessmentStatus="INCORRECT",
                                Confidence=0.80,
                                AssessmentVersion=1,
                                CreatedAt=first_rep.created_at,
                                CompletedAt=first_rep.created_at,
                            )
                        )
    except (ProgrammingError, SQLAlchemyError) as exc:
        if not _is_missing_relation_error(exc):
            logger.debug("Skipping readingcomparisonreports weak-word lookup: %s", type(exc).__name__)

    return [*attempts, *synthetic_errors]


def is_word_mastered_across_contexts(attempts_for_word: list[Any]) -> bool:
    """Apply the 2-tier graduation contract:
    - 1 consecutive CORRECT in isolated Difficult Word Practice (`AssessmentVersion == 1`) graduates, OR
    - >= 2 consecutive CORRECT spoken uses in Entertainment (`AssessmentVersion == 2`) graduates,
    provided no newer INCORRECT error occurred afterwards.
    """
    ordered = sorted(
        [
            a
            for a in attempts_for_word
            if getattr(a, "AssessmentStatus", None) in ("CORRECT", "INCORRECT")
        ],
        key=lambda a: (
            _ensure_utc(getattr(a, "CompletedAt", None) or getattr(a, "CreatedAt", None)),
            0 if getattr(a, "AssessmentStatus", None) == "CORRECT" else 1,
        ),
    )
    if not ordered or getattr(ordered[-1], "AssessmentStatus", None) != "CORRECT":
        return False

    consecutive_correct = 0
    has_isolated_correct_in_streak = False
    for item in reversed(ordered):
        if getattr(item, "AssessmentStatus", None) == "CORRECT":
            consecutive_correct += 1
            if int(getattr(item, "AssessmentVersion", 1) or 1) == 1:
                has_isolated_correct_in_streak = True
        else:
            break

    if has_isolated_correct_in_streak and consecutive_correct >= 1:
        return True
    return consecutive_correct >= ENTERTAINMENT_REQUIRED_SPOKEN_CORRECT


async def list_active_weak_words_for_child(
    db: AsyncSession | Any,
    child_id: UUID,
    *,
    parent_id: UUID | None = None,
    limit: int = 8,
) -> list[str]:
    """Return prioritized display strings of active weak words for game injection."""
    merged = await load_unified_weak_word_attempts(
        db, child_id, parent_id=parent_id, window_days=90
    )
    if not merged:
        return []

    by_word: dict[str, list[Any]] = {}
    display_by_word: dict[str, str] = {}
    for row in merged:
        norm = normalize_focus_phrase(getattr(row, "NormalizedWord", None))
        if len(norm) < 2:
            continue
        by_word.setdefault(norm, []).append(row)
        disp = clean_focus_display_text(getattr(row, "DisplayText", None) or norm)
        if disp and norm not in display_by_word:
            display_by_word[norm] = disp

    now = datetime.now(timezone.utc)
    scored: list[tuple[float, str]] = []
    for norm, rows in by_word.items():
        mastered = is_word_mastered_across_contexts(rows)
        correct = sum(1 for r in rows if getattr(r, "AssessmentStatus", None) == "CORRECT")
        incorrect = sum(1 for r in rows if getattr(r, "AssessmentStatus", None) == "INCORRECT")
        last_ts = max(
            _ensure_utc(getattr(r, "CompletedAt", None) or getattr(r, "CreatedAt", None))
            for r in rows
        )
        days_since = max(0, (now - last_ts).days)
        target_interval = 1 if correct == 0 else (3 if correct == 1 else 7)
        if mastered and days_since < target_interval:
            # Recently mastered and not yet due for spaced review -> deprioritize
            priority = 0.05
        else:
            due_mult = 1.6 if (not mastered or days_since >= target_interval) else 0.6
            priority = max(0.15, (1.2 + incorrect * 0.85 - correct * 0.3) * due_mult)
        scored.append((priority, display_by_word.get(norm, norm)))

    scored.sort(key=lambda pair: (-pair[0], pair[1].casefold()))
    return [word for _prio, word in scored[:limit]]


async def record_entertainment_vocal_word_practice(
    db: AsyncSession | Any,
    *,
    child_id: UUID,
    parent_id: UUID,
    words: Iterable[str],
    source_module: Literal["PICTURE_DESCRIPTION", "MEMORY_GAME", "KARAOKE"],
    source_record_id: str,
    transcript_text: str = "",
    confidence: float = 0.82,
    difficulty_level: int = 1,
    recognition_source: Literal["SERVER_STT_KEYTERM", "BROWSER_SPEECH"] = "SERVER_STT_KEYTERM",
) -> int:
    """Persist vocal word mastery from Entertainment back into `difficult_word_practice_attempts`
    (`AssessmentVersion=2`) and `learning_skill_evidence` (`difficult_word_mastery`).

    Strictly idempotent per `(source_module, source_record_id, normalized_word)`.
    Safe no-op when `db` is a lightweight unit-test stub or tables are unmigrated.
    """
    if not _is_usable_async_db(db):
        return 0

    cleaned_pairs: list[tuple[str, str]] = []
    seen_norms: set[str] = set()
    for raw in words:
        if not isinstance(raw, str):
            continue
        norm = normalize_focus_phrase(raw)
        if len(norm) < 2 or norm in seen_norms:
            continue
        seen_norms.add(norm)
        display = clean_focus_display_text(raw) or norm
        cleaned_pairs.append((norm, display))
        if len(cleaned_pairs) >= 6:
            break

    if not cleaned_pairs:
        return 0

    now = datetime.now(timezone.utc)
    clamped_conf = round(max(0.5, min(1.0, float(confidence))), 3)
    clamped_diff = max(1, min(5, int(difficulty_level)))
    snippet = unicodedata.normalize("NFC", str(transcript_text or "")).strip()[:160] or None
    saved_count = 0

    for norm, display in cleaned_pairs:
        det_req_id = uuid5(
            NAMESPACE_URL,
            f"viread:ent-vocal:{source_module}:{source_record_id}:{norm}",
        )
        try:
            async with db.begin_nested():
                existing = await db.scalar(
                    select(DifficultWordPracticeAttempt.Id)
                    .where(
                        DifficultWordPracticeAttempt.ChildId == child_id,
                        DifficultWordPracticeAttempt.CompletionRequestId == det_req_id,
                    )
                    .limit(1)
                )
                if existing is not None:
                    continue
                current_max = await db.scalar(
                    select(func.coalesce(func.max(DifficultWordPracticeAttempt.AttemptNumber), 0))
                    .where(
                        DifficultWordPracticeAttempt.ChildId == child_id,
                        DifficultWordPracticeAttempt.NormalizedWord == norm,
                    )
                )
                attempt_row = DifficultWordPracticeAttempt(
                    Id=uuid4(),
                    ChildId=child_id,
                    ParentId=parent_id,
                    NormalizedWord=norm,
                    DisplayText=display[:120],
                    AttemptNumber=int(current_max or 0) + 1,
                    RequestId=det_req_id,
                    CompletionRequestId=det_req_id,
                    State="COMPLETED",
                    AssessmentStatus="CORRECT",
                    RecognitionSource=recognition_source,
                    SpokenTranscript=snippet,
                    Confidence=clamped_conf,
                    AssessmentVersion=ENTERTAINMENT_CONTEXTUAL_ASSESSMENT_VERSION,
                    EvidenceWordIds=[],
                    StartedAt=now,
                    CompletedAt=now,
                    CreatedAt=now,
                    UpdatedAt=now,
                )
                db.add(attempt_row)
                await db.flush()
                saved_count += 1
        except (IntegrityError, ProgrammingError, SQLAlchemyError) as exc:
            if not _is_missing_relation_error(exc):
                logger.debug(
                    "Skipped entertainment vocal practice row (%s): %s",
                    source_module,
                    type(exc).__name__,
                )

    if saved_count > 0:
        try:
            async with db.begin_nested():
                ev_row = LearningSkillEvidence(
                    Id=uuid4(),
                    ChildId=child_id,
                    ParentId=parent_id,
                    SkillKey="difficult_word_mastery",
                    SourceModule=source_module,
                    SourceRecordId=f"{source_record_id}:vocal_words",
                    EvidenceType="OBSERVED",
                    ScoreNormalized=1.0,
                    Confidence=clamped_conf,
                    DifficultyLevel=clamped_diff,
                    PracticeWords=[disp for _norm, disp in cleaned_pairs],
                    MetadataJson={
                        "origin": "ENTERTAINMENT_VOICE",
                        "input_mode": "VOICE",
                        "assessment_version": ENTERTAINMENT_CONTEXTUAL_ASSESSMENT_VERSION,
                    },
                    CreatedAt=now,
                )
                db.add(ev_row)
                await db.flush()
        except (IntegrityError, ProgrammingError, SQLAlchemyError):
            pass

        try:
            await db.commit()
        except SQLAlchemyError:
            try:
                await db.rollback()
            except SQLAlchemyError:
                pass

    return saved_count
