"""Feature #7: 7-Bed Vietnamese Phoneme Garden & Commemorative Book Stamps Service.

Privacy & Calm Pedagogy Guardrails:
- Strictly `PARENT_PRIVATE`: verifies `child_id` belongs to authenticated `parent_id`
  (`404` when child does not exist, `403` when owned by another household).
- Zero dark patterns: no virtual coins, no competitive leaderboards/rankings, and
  zero streak-loss punishment or wilting plants when a child takes days/weeks off.
- Every flower bed (`SEED -> SPROUT -> BUD -> BLOOM`) and commemorative book/milestone
  stamp progresses monotonically from genuine Vietnamese phonics practice and completed books.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import logging
from typing import Any
from unittest.mock import NonCallableMock
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException, status
from sqlalchemy import desc, select
from sqlalchemy.exc import ProgrammingError, SQLAlchemyError

from app.models import (
    Book,
    ChildProfile,
    PageRevisionWord,
    ReadingComparisonReport,
    ReadingEvent,
    ReadingSession,
)
from app.models.difficult_word_practice import DifficultWordPracticeAttempt
from app.schemas.phoneme_garden import (
    BedStage,
    BookStampMotif,
    BookStampRead,
    MilestoneStampRead,
    PhonemeBedRead,
    PhonemeGardenSummaryResponse,
    PhonicsBedKey,
    PlantSymbolKey,
)
from app.services.active_weak_words import (
    ENTERTAINMENT_CONTEXTUAL_ASSESSMENT_VERSION,
    PHONICS_CATEGORY_LABELS_VI,
    SyntheticWeakWordAttempt,
    classify_vietnamese_phonics_category,
    clean_focus_display_text,
    is_word_mastered_across_contexts,
    load_unified_weak_word_attempts,
    normalize_focus_phrase,
)
from app.services.child_progress.metrics import (
    FINISHED_STATES,
    ReportRow,
    analyze_first_pass,
    first_pass_reports,
)

logger = logging.getLogger(__name__)

# All-time history horizon so multi-day or multi-month breaks never drop progress.
_ALL_TIME_WINDOW_DAYS = 36500
_MAX_SAMPLE_WORDS_PER_BED = 12

_STAGE_INDEX: dict[BedStage, int] = {
    "SEED": 0,
    "SPROUT": 1,
    "BUD": 2,
    "BLOOM": 3,
}

_BOOK_STAMP_MOTIFS: tuple[BookStampMotif, ...] = (
    "LOTUS_SEAL",
    "BAMBOO_SCROLL",
    "STARLIGHT_LANTERN",
    "SUNRISE_KITE",
    "BANYAN_LEAF",
)


@dataclass(frozen=True)
class _BedSpec:
    key: PhonicsBedKey
    plant_name_vi: str
    plant_symbol: PlantSymbolKey


BED_SPECS: tuple[_BedSpec, ...] = (
    _BedSpec(key="l_n", plant_name_vi="Hoa Sen", plant_symbol="lotus"),
    _BedSpec(key="s_x", plant_name_vi="Hoa Mai", plant_symbol="apricot"),
    _BedSpec(key="tr_ch", plant_name_vi="Tre Xanh", plant_symbol="bamboo"),
    _BedSpec(key="r_d_gi", plant_name_vi="Hoa Hướng Dương", plant_symbol="sunflower"),
    _BedSpec(key="hoi_nga", plant_name_vi="Hoa Cúc", plant_symbol="chrysanthemum"),
    _BedSpec(key="coda_n_ng_t_c", plant_name_vi="Hoa Đào", plant_symbol="peach"),
    _BedSpec(
        key="compound_reduplicative",
        plant_name_vi="Hoa Phượng",
        plant_symbol="flamboyant",
    ),
)

_CALM_PEDAGOGY_NOTE_VI = (
    "Vườn chữ và sổ tem chỉ lớn dần theo từng tiếng bé đọc và từng cuốn sách hoàn thành — "
    "không có xu ảo, không xếp hạng thi đua và hoa không bao giờ héo khi bé nghỉ ngơi."
)


def _ensure_utc(dt: datetime | None) -> datetime:
    if dt is None:
        return datetime.now(timezone.utc)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _is_missing_relation_error(exc: BaseException) -> bool:
    for candidate in (exc, getattr(exc, "orig", None), getattr(exc, "__cause__", None)):
        if candidate is None:
            continue
        code = getattr(candidate, "sqlstate", None) or getattr(candidate, "pgcode", None)
        if code in ("42P01", "42703"):
            return True
        lowered = str(candidate).lower()
        if (
            "does not exist" in lowered
            or "undefinedtable" in lowered
            or "no such table" in lowered
        ):
            return True
    return False


def _is_usable_db(db: Any) -> bool:
    if db is None or isinstance(db, NonCallableMock):
        return False
    return hasattr(db, "execute") and hasattr(db, "scalar")


def compute_bed_stage(
    practiced_words_count: int,
    mastered_words_count: int,
) -> tuple[BedStage, BedStage | None, int]:
    """Compute monotonic 4-stage progression (`SEED -> SPROUT -> BUD -> BLOOM`).

    - `SEED` (0): 0 practiced words and 0 mastered words
    - `SPROUT` (1): >= 1 practiced word or 1 mastered word
    - `BUD` (2): 2 mastered words
    - `BLOOM` (3): >= 3 mastered words
    """
    if mastered_words_count >= 3:
        return "BLOOM", None, 0
    if mastered_words_count == 2:
        return "BUD", "BLOOM", 1
    if practiced_words_count >= 1 or mastered_words_count == 1:
        needed = max(1, 2 - mastered_words_count)
        return "SPROUT", "BUD", needed
    return "SEED", "SPROUT", 1


def _build_bed_encouragement(
    stage: BedStage,
    plant_name_vi: str,
    phonics_label_vi: str,
    mastered_count: int,
) -> str:
    if stage == "SEED":
        return (
            f"Luống {plant_name_vi} ({phonics_label_vi}) đang ủ hạt giống êm đềm — "
            "khi gặp nhóm âm này trong trang sách, luống cây sẽ bắt đầu nảy mầm."
        )
    if stage == "SPROUT":
        return (
            f"{plant_name_vi} đã nhú mầm non xanh mát! "
            "Mỗi lần đọc rõ thêm từ thuộc nhóm âm này sẽ giúp cây kết nụ."
        )
    if stage == "BUD":
        return (
            f"{plant_name_vi} đã kết nụ tròn xinh với {mastered_count} từ vững vàng — "
            "chỉ thêm 1 từ thành thạo nữa là hoa nở rộ!"
        )
    return (
        f"{plant_name_vi} đã nở hoa rực rỡ ({mastered_count} từ thành thạo) và sẽ luôn "
        "tươi thắm trong khu vườn riêng của con."
    )


def _sort_attempts_chronologically(attempts_for_word: list[Any]) -> list[Any]:
    return sorted(
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


def is_word_monotonically_mastered(attempts_for_word: list[Any]) -> bool:
    """Evaluate `is_word_mastered_across_contexts` monotonically across attempt history.

    Once a word genuinely graduates via `is_word_mastered_across_contexts` (either
    1 isolated Difficult Word Practice pass `AssessmentVersion=1` or >= 2 consecutive
    contextual passes `AssessmentVersion=2`), the child's garden bed never regresses
    or wilts across breaks or later exploratory reading.
    """
    ordered = _sort_attempts_chronologically(attempts_for_word)
    if not ordered:
        return False
    if is_word_mastered_across_contexts(ordered):
        return True
    for prefix_len in range(1, len(ordered)):
        if is_word_mastered_across_contexts(ordered[:prefix_len]):
            return True
    return False


def _extract_matched_words_from_alignment(alignment: Any) -> list[tuple[str, str]]:
    """Extract accurately read (`MATCH`) words from `ReadingComparisonReport.Alignment`."""
    items: list[Any] = []
    if isinstance(alignment, list):
        items = alignment
    elif isinstance(alignment, dict):
        for key in ("items", "tokens", "words", "alignment"):
            candidate = alignment.get(key)
            if isinstance(candidate, list):
                items = candidate
                break

    matched: list[tuple[str, str]] = []
    seen: set[str] = set()
    for token in items:
        if not isinstance(token, dict):
            continue
        op = str(
            token.get("op")
            or token.get("status")
            or token.get("type")
            or ""
        ).upper()
        if op not in ("MATCH", "CORRECT", "EQUAL"):
            continue
        raw_word = (
            token.get("expected")
            or token.get("reference")
            or token.get("target")
            or token.get("word")
            or token.get("text")
        )
        norm = normalize_focus_phrase(raw_word)
        if len(norm) < 2 or norm in seen:
            continue
        seen.add(norm)
        display = clean_focus_display_text(str(raw_word)) or norm
        matched.append((norm, display))
    return matched


class PhonemeGardenService:
    """Computes a child's 7-Bed Vietnamese Phoneme Garden & Commemorative Book Stamps."""

    def __init__(self, db: Any) -> None:
        self._db = db

    async def get_child_summary(
        self,
        parent_id: UUID,
        child_id: UUID,
    ) -> PhonemeGardenSummaryResponse:
        child_alias, child_grade = await self._verify_child_ownership(parent_id, child_id)
        sessions = await self._load_child_sessions(child_id)
        all_attempts = await self._load_all_phonics_attempts(
            parent_id=parent_id,
            child_id=child_id,
            sessions=sessions,
        )

        beds, total_practiced, total_mastered, bloomed_count = self._build_garden_beds(
            all_attempts
        )
        book_stamps, completed_sessions_count, first_bloom_hint_ts = (
            await self._build_book_stamps(parent_id, sessions)
        )
        milestone_stamps = self._build_milestone_stamps(
            sessions=sessions,
            completed_sessions_count=completed_sessions_count,
            bloomed_beds_count=bloomed_count,
            latest_mastery_ts=self._latest_mastery_timestamp(all_attempts) or first_bloom_hint_ts,
        )

        unlocked_milestones = sum(1 for item in milestone_stamps if item.unlocked)
        gentle_message_vi = self._compose_gentle_message(
            child_alias=child_alias,
            bloomed_beds_count=bloomed_count,
            total_mastered_words=total_mastered,
            total_completed_books=len(book_stamps),
        )

        await self._release_read_transaction()

        return PhonemeGardenSummaryResponse(
            visibility="PARENT_PRIVATE",
            child_id=child_id,
            child_alias=child_alias,
            child_grade=child_grade,
            beds=beds,
            book_stamps=book_stamps,
            milestone_stamps=milestone_stamps,
            bloomed_beds_count=bloomed_count,
            total_practiced_words=total_practiced,
            total_mastered_words=total_mastered,
            total_completed_books=len(book_stamps),
            total_completed_sessions=completed_sessions_count,
            unlocked_milestone_stamps_count=unlocked_milestones,
            gentle_message_vi=gentle_message_vi,
            calm_pedagogy_note_vi=_CALM_PEDAGOGY_NOTE_VI,
        )

    async def _verify_child_ownership(
        self,
        parent_id: UUID,
        child_id: UUID,
    ) -> tuple[str, int]:
        if not _is_usable_db(self._db):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )

        child = await self._db.scalar(
            select(ChildProfile).where(ChildProfile.Id == child_id)
        )
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        if child.ParentId != parent_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied",
            )

        alias = str(getattr(child, "Alias", "") or "Bé").strip() or "Bé"
        raw_grade = int(getattr(child, "Grade", 1) or 1)
        grade = max(1, min(5, raw_grade))
        return alias, grade

    async def _load_child_sessions(self, child_id: UUID) -> list[Any]:
        if not _is_usable_db(self._db):
            return []
        try:
            async with self._db.begin_nested():
                res = await self._db.execute(
                    select(ReadingSession)
                    .where(ReadingSession.ChildId == child_id)
                    .order_by(desc(ReadingSession.StartedAt))
                    .limit(1000)
                )
                return list(res.scalars().all())
        except (ProgrammingError, SQLAlchemyError) as exc:
            if not _is_missing_relation_error(exc):
                logger.debug("Skipping readingsessions lookup in phoneme garden: %s", type(exc).__name__)
            return []

    async def _load_all_phonics_attempts(
        self,
        *,
        parent_id: UUID,
        child_id: UUID,
        sessions: list[Any],
    ) -> list[Any]:
        """Aggregate all-time phonics practice & reading attempts without recency decay."""
        merged: list[Any] = []
        seen_ids: set[str] = set()

        def _append_unique(item: Any) -> None:
            raw_id = getattr(item, "Id", None)
            key = str(raw_id) if raw_id is not None else f"anon:{id(item)}"
            if key not in seen_ids:
                seen_ids.add(key)
                merged.append(item)

        # 1. Reuse active_weak_words unified loader across all-time horizon.
        unified = await load_unified_weak_word_attempts(
            self._db,
            child_id,
            parent_id=parent_id,
            window_days=_ALL_TIME_WINDOW_DAYS,
        )
        for row in unified:
            _append_unique(row)

        if not _is_usable_db(self._db):
            return merged

        # 2. Direct entity query on DifficultWordPracticeAttempt (supports both real DB & test fakes).
        try:
            async with self._db.begin_nested():
                stmt = (
                    select(DifficultWordPracticeAttempt)
                    .where(
                        DifficultWordPracticeAttempt.ChildId == child_id,
                        DifficultWordPracticeAttempt.ParentId == parent_id,
                    )
                    .order_by(desc(DifficultWordPracticeAttempt.CreatedAt))
                    .limit(1000)
                )
                for row in (await self._db.execute(stmt)).scalars().all():
                    _append_unique(row)
        except (ProgrammingError, SQLAlchemyError) as exc:
            if not _is_missing_relation_error(exc):
                logger.debug("Skipping direct practice attempts lookup: %s", type(exc).__name__)

        session_ids = [s.Id for s in sessions if getattr(s, "Id", None) is not None]
        if not session_ids:
            return merged

        # 3. Direct entity query on ReadingEvent for sessions belonging to this child.
        try:
            async with self._db.begin_nested():
                ev_rows = (
                    await self._db.execute(
                        select(ReadingEvent)
                        .where(ReadingEvent.SessionId.in_(session_ids))
                        .order_by(desc(ReadingEvent.CreatedAt))
                        .limit(1000)
                    )
                ).scalars().all()

            word_ids = [
                ev.WordId
                for ev in ev_rows
                if getattr(ev, "WordId", None) is not None
            ]
            word_text_by_id: dict[UUID, str] = {}
            if word_ids:
                try:
                    async with self._db.begin_nested():
                        word_rows = (
                            await self._db.execute(
                                select(PageRevisionWord).where(
                                    PageRevisionWord.Id.in_(word_ids)
                                )
                            )
                        ).scalars().all()
                        word_text_by_id = {
                            w.Id: str(w.Text)
                            for w in word_rows
                            if getattr(w, "Id", None) is not None and getattr(w, "Text", None)
                        }
                except (ProgrammingError, SQLAlchemyError):
                    word_text_by_id = {}

            for ev in ev_rows:
                ev_type = str(getattr(ev, "Type", "") or "")
                if ev_type not in (
                    "MISPRONUNCIATION",
                    "SUBSTITUTION",
                    "OMISSION",
                    "REPETITION",
                    "LONG_PAUSE",
                    "READ_EXAMPLE",
                    "WORD_RETRY",
                ):
                    continue
                meta = ev.Metadata if isinstance(getattr(ev, "Metadata", None), dict) else {}
                raw_word = (
                    word_text_by_id.get(ev.WordId)
                    or meta.get("target_word")
                    or meta.get("normalized_word")
                    or meta.get("expected_word")
                )
                norm = normalize_focus_phrase(raw_word)
                if len(norm) < 2:
                    continue
                display = clean_focus_display_text(str(raw_word)) or norm
                created_utc = _ensure_utc(getattr(ev, "CreatedAt", None))
                ev_status = str(getattr(ev, "Status", "") or "")
                if ev_type == "WORD_RETRY":
                    if ev_status == "CONFIRMED":
                        status_label = "CORRECT"
                    elif ev_status == "FAILED":
                        status_label = "INCORRECT"
                    else:
                        continue
                    version = ENTERTAINMENT_CONTEXTUAL_ASSESSMENT_VERSION
                else:
                    status_label = "INCORRECT"
                    version = 1

                _append_unique(
                    SyntheticWeakWordAttempt(
                        Id=ev.Id,
                        NormalizedWord=norm,
                        DisplayText=display,
                        AssessmentStatus=status_label,
                        Confidence=0.8,
                        AssessmentVersion=version,
                        CreatedAt=created_utc,
                        CompletedAt=created_utc,
                    )
                )
        except (ProgrammingError, SQLAlchemyError) as exc:
            if not _is_missing_relation_error(exc):
                logger.debug("Skipping readingevents garden lookup: %s", type(exc).__name__)

        # 4. ReadingComparisonReport first-pass errors + matched contextual reading tokens.
        try:
            async with self._db.begin_nested():
                rep_rows = (
                    await self._db.execute(
                        select(ReadingComparisonReport)
                        .where(ReadingComparisonReport.SessionId.in_(session_ids))
                        .order_by(desc(ReadingComparisonReport.CreatedAt))
                        .limit(500)
                    )
                ).scalars().all()

            report_objs = [
                ReportRow(
                    session_id=r.SessionId,
                    page_id=getattr(r, "PageId", None),
                    page_revision_id=getattr(r, "PageRevisionId", None),
                    alignment=getattr(r, "Alignment", None),
                    summary=getattr(r, "Summary", None),
                    created_at=_ensure_utc(getattr(r, "CreatedAt", None)),
                )
                for r in rep_rows
            ]
            seen_session_matches: set[tuple[str, str]] = set()
            for first_rep in first_pass_reports(report_objs):
                analyzed = analyze_first_pass(first_rep)
                if analyzed:
                    errors_counter = analyzed.get("errors") or {}
                    for word_norm, err_count in errors_counter.items():
                        clean_norm = normalize_focus_phrase(word_norm)
                        if len(clean_norm) < 2 or int(err_count or 0) <= 0:
                            continue
                        for idx in range(min(3, int(err_count))):
                            _append_unique(
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

                for match_norm, match_display in _extract_matched_words_from_alignment(
                    first_rep.alignment
                ):
                    sess_word_key = (str(first_rep.session_id), match_norm)
                    if sess_word_key in seen_session_matches:
                        continue
                    seen_session_matches.add(sess_word_key)
                    _append_unique(
                        SyntheticWeakWordAttempt(
                            Id=uuid5(
                                NAMESPACE_URL,
                                f"viread:cmp-match:{first_rep.session_id}:{match_norm}",
                            ),
                            NormalizedWord=match_norm,
                            DisplayText=match_display,
                            AssessmentStatus="CORRECT",
                            Confidence=0.85,
                            AssessmentVersion=ENTERTAINMENT_CONTEXTUAL_ASSESSMENT_VERSION,
                            CreatedAt=first_rep.created_at,
                            CompletedAt=first_rep.created_at,
                        )
                    )
        except (ProgrammingError, SQLAlchemyError) as exc:
            if not _is_missing_relation_error(exc):
                logger.debug("Skipping comparison reports garden lookup: %s", type(exc).__name__)

        return merged

    def _build_garden_beds(
        self,
        all_attempts: list[Any],
    ) -> tuple[list[PhonemeBedRead], int, int, int]:
        by_word: dict[str, list[Any]] = {}
        display_by_word: dict[str, str] = {}

        for row in all_attempts:
            norm = normalize_focus_phrase(getattr(row, "NormalizedWord", None))
            if len(norm) < 2:
                continue
            by_word.setdefault(norm, []).append(row)
            disp = clean_focus_display_text(getattr(row, "DisplayText", None) or norm)
            if disp and (norm not in display_by_word or disp != norm):
                display_by_word[norm] = disp

        practiced_by_bed: dict[PhonicsBedKey, list[str]] = {
            spec.key: [] for spec in BED_SPECS
        }
        mastered_by_bed: dict[PhonicsBedKey, list[str]] = {
            spec.key: [] for spec in BED_SPECS
        }

        for norm in sorted(by_word.keys()):
            category_key, _label = classify_vietnamese_phonics_category(norm)
            if category_key == "general" or category_key not in practiced_by_bed:
                continue
            display_word = display_by_word.get(norm, norm)
            practiced_by_bed[category_key].append(display_word)
            if is_word_monotonically_mastered(by_word[norm]):
                mastered_by_bed[category_key].append(display_word)

        beds: list[PhonemeBedRead] = []
        total_practiced = 0
        total_mastered = 0
        bloomed_count = 0

        for spec in BED_SPECS:
            practiced_list = practiced_by_bed[spec.key]
            mastered_list = mastered_by_bed[spec.key]
            practiced_count = len(practiced_list)
            mastered_count = len(mastered_list)
            total_practiced += practiced_count
            total_mastered += mastered_count

            stage, next_stage, words_to_next = compute_bed_stage(
                practiced_words_count=practiced_count,
                mastered_words_count=mastered_count,
            )
            if stage == "BLOOM":
                bloomed_count += 1

            phonics_label = PHONICS_CATEGORY_LABELS_VI[spec.key]
            beds.append(
                PhonemeBedRead(
                    bed_key=spec.key,
                    phonics_label_vi=phonics_label,
                    plant_name_vi=spec.plant_name_vi,
                    plant_symbol=spec.plant_symbol,
                    stage=stage,
                    stage_index=_STAGE_INDEX[stage],
                    practiced_words_count=practiced_count,
                    mastered_words_count=mastered_count,
                    mastered_words=mastered_list[:_MAX_SAMPLE_WORDS_PER_BED],
                    practiced_words=practiced_list[:_MAX_SAMPLE_WORDS_PER_BED],
                    next_stage=next_stage,
                    words_to_next_stage=words_to_next,
                    encouragement_vi=_build_bed_encouragement(
                        stage=stage,
                        plant_name_vi=spec.plant_name_vi,
                        phonics_label_vi=phonics_label,
                        mastered_count=mastered_count,
                    ),
                )
            )

        return beds, total_practiced, total_mastered, bloomed_count

    async def _build_book_stamps(
        self,
        parent_id: UUID,
        sessions: list[Any],
    ) -> tuple[list[BookStampRead], int, datetime | None]:
        finished_sessions = [
            s
            for s in sessions
            if str(getattr(s, "State", "") or "").upper() in FINISHED_STATES
            and getattr(s, "BookId", None) is not None
        ]
        completed_sessions_count = len(finished_sessions)
        if not finished_sessions:
            return [], 0, None

        # Group by distinct BookId (deduplicating repeat completions of the same book).
        by_book: dict[UUID, list[datetime]] = {}
        for sess in finished_sessions:
            book_id: UUID = sess.BookId
            completed_ts = _ensure_utc(
                getattr(sess, "EndedAt", None) or getattr(sess, "StartedAt", None)
            )
            by_book.setdefault(book_id, []).append(completed_ts)

        book_titles: dict[UUID, str] = {}
        if _is_usable_db(self._db):
            try:
                async with self._db.begin_nested():
                    book_rows = (
                        await self._db.execute(
                            select(Book).where(Book.Id.in_(list(by_book.keys())))
                        )
                    ).scalars().all()
                    for bk in book_rows:
                        if getattr(bk, "IsDeleted", False) is True:
                            continue
                        vis = str(getattr(bk, "VisibilityScope", "CATALOG") or "CATALOG")
                        owner_id = getattr(bk, "OwnerParentId", None)
                        if vis == "PARENT_PRIVATE" and owner_id != parent_id:
                            continue
                        title = str(
                            getattr(bk, "Title", None)
                            or getattr(bk, "Name", None)
                            or "Sách của bé"
                        ).strip()
                        book_titles[bk.Id] = title or "Sách của bé"
            except (ProgrammingError, SQLAlchemyError) as exc:
                if not _is_missing_relation_error(exc):
                    logger.debug("Skipping books title lookup: %s", type(exc).__name__)

        # Sort stamps by first completion timestamp (oldest -> newest journey order)
        ordered_books = sorted(
            by_book.items(),
            key=lambda pair: (min(pair[1]), str(pair[0])),
        )

        stamps: list[BookStampRead] = []
        for idx, (book_id, timestamps) in enumerate(ordered_books):
            first_completed_at = min(timestamps)
            motif = _BOOK_STAMP_MOTIFS[idx % len(_BOOK_STAMP_MOTIFS)]
            stamps.append(
                BookStampRead(
                    stamp_key=f"book-{book_id}",
                    book_id=book_id,
                    book_title=book_titles.get(book_id, "Cuốn sách bé đã đọc"),
                    completed_at=first_completed_at,
                    completed_sessions_count=len(timestamps),
                    motif=motif,
                )
            )

        latest_session_ts = max(ts for ts_list in by_book.values() for ts in ts_list)
        return stamps, completed_sessions_count, latest_session_ts

    def _build_milestone_stamps(
        self,
        *,
        sessions: list[Any],
        completed_sessions_count: int,
        bloomed_beds_count: int,
        latest_mastery_ts: datetime | None,
    ) -> list[MilestoneStampRead]:
        finished_timestamps = sorted(
            _ensure_utc(getattr(s, "EndedAt", None) or getattr(s, "StartedAt", None))
            for s in sessions
            if str(getattr(s, "State", "") or "").upper() in FINISHED_STATES
        )

        def _nth_session_ts(n: int) -> datetime | None:
            if len(finished_timestamps) >= n:
                return finished_timestamps[n - 1]
            return None

        return [
            MilestoneStampRead(
                stamp_key="first_session",
                category="CALM_CYCLE",
                title_vi="Buổi Đọc Đầu Tiên",
                description_vi="Kỷ niệm buổi đọc sách trọn vẹn đầu tiên của con — khởi đầu êm đềm.",
                unlocked=completed_sessions_count >= 1,
                progress_current=min(completed_sessions_count, 1),
                progress_target=1,
                unlocked_at=_nth_session_ts(1),
            ),
            MilestoneStampRead(
                stamp_key="five_sessions",
                category="CALM_CYCLE",
                title_vi="5 Buổi Đọc Tích Lũy",
                description_vi="Đủ 5 buổi đọc cộng dồn theo nhịp riêng — nghỉ vài ngày vẫn giữ nguyên.",
                unlocked=completed_sessions_count >= 5,
                progress_current=min(completed_sessions_count, 5),
                progress_target=5,
                unlocked_at=_nth_session_ts(5),
            ),
            MilestoneStampRead(
                stamp_key="ten_sessions",
                category="CALM_CYCLE",
                title_vi="10 Buổi Đọc Bền Bỉ",
                description_vi="Đủ 10 buổi đọc ấm áp cùng sách — hành trình tích lũy không áp lực.",
                unlocked=completed_sessions_count >= 10,
                progress_current=min(completed_sessions_count, 10),
                progress_target=10,
                unlocked_at=_nth_session_ts(10),
            ),
            MilestoneStampRead(
                stamp_key="first_mastered_bed",
                category="PHONEME_BLOOM",
                title_vi="Luống Hoa Âm Vị Đầu Tiên Nở Rộ",
                description_vi="Một nhóm âm vị tiếng Việt đã nở hoa rực rỡ nhờ con luyện đọc vững vàng.",
                unlocked=bloomed_beds_count >= 1,
                progress_current=min(bloomed_beds_count, 1),
                progress_target=1,
                unlocked_at=latest_mastery_ts if bloomed_beds_count >= 1 else None,
            ),
        ]

    @staticmethod
    def _latest_mastery_timestamp(all_attempts: list[Any]) -> datetime | None:
        correct_timestamps = [
            _ensure_utc(getattr(a, "CompletedAt", None) or getattr(a, "CreatedAt", None))
            for a in all_attempts
            if getattr(a, "AssessmentStatus", None) == "CORRECT"
        ]
        return max(correct_timestamps) if correct_timestamps else None

    @staticmethod
    def _compose_gentle_message(
        *,
        child_alias: str,
        bloomed_beds_count: int,
        total_mastered_words: int,
        total_completed_books: int,
    ) -> str:
        if bloomed_beds_count >= 3:
            return (
                f"Khu vườn của {child_alias} đã có {bloomed_beds_count}/7 luống hoa nở rộ "
                f"và {total_completed_books} tem sách kỷ niệm thật ấm áp!"
            )
        if bloomed_beds_count >= 1 or total_mastered_words >= 3:
            return (
                f"{child_alias} đã chăm tưới thành thạo {total_mastered_words} từ tiếng Việt — "
                "từng luống hoa cứ thế lớn dần theo nhịp riêng của con."
            )
        if total_completed_books >= 1 or total_mastered_words >= 1:
            return (
                f"Những mầm xanh đầu tiên trong vườn chữ của {child_alias} đã hé mở. "
                "Mỗi trang sách con đọc đều giúp khu vườn thêm tươi tốt!"
            )
        return (
            f"Chào mừng {child_alias} đến với Vườn Chữ Âm Vị! "
            "7 luống hoa tiếng Việt đang bình yên chờ con gieo mầm qua từng buổi đọc."
        )

    async def _release_read_transaction(self) -> None:
        rollback = getattr(self._db, "rollback", None)
        if callable(rollback):
            try:
                res = rollback()
                if hasattr(res, "__await__"):
                    await res
            except SQLAlchemyError:
                pass
