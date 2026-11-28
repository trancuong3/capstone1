"""Service for Feature #3: Regional Phonetic Profile & Dual-Score Alignment.

Implements:
- Profile GET/PUT via `ChildProfile.Settings["phonetic_profile"]`
- Regional equivalence rules for `NORTH_TOLERANT`, `CENTRAL_TOLERANT`, and `SOUTH_TOLERANT`
  using Vietnamese syllable decomposition (`vietnamese_phonics.py` + `active_weak_words.py`)
- Dual-score alignment evaluation (`strict_sgk_accuracy` vs `regional_tolerant_accuracy` side-by-side)
- 30-second "Tai Thính Miệng Xinh" Ear-Before-Voice minimal-pair drill reusing
  `build_contrastive_vietnamese_keyterms()` and child's active weak phonics categories.
"""

from __future__ import annotations

from datetime import datetime, timezone
import logging
from typing import Any
import unicodedata
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, ProgrammingError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.models import ChildProfile
from app.models.entertainment_v4 import LearningSkillEvidence
from app.schemas.regional_phonetics import (
    VALID_PHONETIC_PROFILES,
    AlignmentEvaluateRequest,
    AlignmentEvaluateResponse,
    EarTrainer30sResponse,
    EarTrainerCompleteRequest,
    EarTrainerCompleteResponse,
    MinimalPairRound,
    PhoneticProfile,
    RegionalPhoneticProfileResponse,
    RegionalPhoneticProfileUpdate,
    RegionalVariantMatch,
)
from app.services.active_weak_words import (
    PHONICS_CATEGORY_LABELS_VI,
    _is_usable_async_db,
    classify_vietnamese_phonics_category,
    list_active_weak_words_for_child,
    tokenize_focus_phrase,
)
from app.services.text_alignment import normalize_text
from app.services.vietnamese_phonics import (
    decompose_vietnamese_syllable,
    normalize_vietnamese_word,
    split_vietnamese_rhyme,
)
from app.services.voice_orchestrator import build_contrastive_vietnamese_keyterms

logger = logging.getLogger(__name__)

PHONETIC_PROFILE_SETTINGS_KEY = "phonetic_profile"

# ─── Curated minimal-pair bank (target, distractor, phonics_category) ────────
_MINIMAL_PAIR_BANK: tuple[tuple[str, str, str], ...] = (
    ("lúa", "núa", "l_n"),
    ("mát", "mác", "coda_n_ng_t_c"),
    ("cũ", "củ", "hoi_nga"),
    ("sẻ", "xẻ", "s_x"),
    ("trăng", "chăng", "tr_ch"),
    ("rừng", "dừng", "r_d_gi"),
    ("bán", "báng", "coda_n_ng_t_c"),
    ("ngã", "ngả", "hoi_nga"),
    ("nắng", "lắng", "l_n"),
    ("sạch", "xạch", "s_x"),
    ("trẻ", "chẻ", "tr_ch"),
    ("giỏi", "dỏi", "r_d_gi"),
    ("bột", "bộc", "coda_n_ng_t_c"),
    ("tin", "tinh", "coda_n_ng_t_c"),
)

_PROFILE_DEFAULT_CATEGORIES: dict[PhoneticProfile, tuple[str, ...]] = {
    "STRICT_SGK": ("l_n", "coda_n_ng_t_c", "hoi_nga", "s_x"),
    "NORTH_TOLERANT": ("l_n", "s_x", "tr_ch", "r_d_gi"),
    "CENTRAL_TOLERANT": ("hoi_nga", "coda_n_ng_t_c"),
    "SOUTH_TOLERANT": ("hoi_nga", "coda_n_ng_t_c", "r_d_gi"),
}

# ─── Regional equivalence sets ───────────────────────────────────────────────

_NORTH_ONSET_EQUIV: tuple[frozenset[str], ...] = (
    frozenset({"l", "n"}),
    frozenset({"s", "x"}),
    frozenset({"tr", "ch"}),
    frozenset({"r", "d", "gi"}),
)

_CENTRAL_TONE_EQUIV: tuple[frozenset[str], ...] = (
    frozenset({"hoi", "nga"}),
    frozenset({"sac", "nang"}),  # Zipformer int8 Central checked/rising-heavy ambiguity
)
_CENTRAL_CODA_EQUIV: tuple[frozenset[str], ...] = (
    frozenset({"n", "ng"}),
    frozenset({"t", "c"}),
)

_SOUTH_ONSET_EQUIV: tuple[frozenset[str], ...] = (
    frozenset({"v", "d", "gi"}),
)
_SOUTH_TONE_EQUIV: tuple[frozenset[str], ...] = (
    frozenset({"hoi", "nga"}),
)
_SOUTH_CODA_EQUIV: tuple[frozenset[str], ...] = (
    frozenset({"n", "ng"}),
    frozenset({"t", "c"}),
    frozenset({"n", "nh"}),
)

_ORTHOGRAPHIC_ONSET_CANONICAL: dict[str, str] = {
    "k": "c",
    "gh": "g",
    "ngh": "ng",
}

_VOWEL_CHARS = frozenset("aăâeêioôơuưy")


def coerce_phonetic_profile(raw: Any) -> PhoneticProfile:
    if isinstance(raw, str) and raw in VALID_PHONETIC_PROFILES:
        return raw  # type: ignore[return-value]
    return "STRICT_SGK"


def _in_equiv_class(
    val_a: str,
    val_b: str,
    equiv_classes: tuple[frozenset[str], ...],
) -> bool:
    if not val_a or not val_b or val_a == val_b:
        return False
    return any(val_a in cls and val_b in cls for cls in equiv_classes)


def _canonical_onset(onset: str) -> str:
    return _ORTHOGRAPHIC_ONSET_CANONICAL.get(onset, onset)


def _canonical_rhyme_and_parts(onset: str, rhyme: str) -> tuple[str, str, str]:
    """Resolve underlying Vietnamese rhyme, nucleus, and coda for accurate skeleton comparison."""
    resolved = rhyme
    if onset == "gi":
        if rhyme in {"êng", "êt", "êc", "êu", "êm", "ên"}:
            resolved = f"i{rhyme}"
        elif rhyme and rhyme[0] not in _VOWEL_CHARS:
            # e.g. "gìn" -> onset="gi", rhyme="n" -> underlying rhyme "in"
            resolved = f"i{rhyme}"
    elif onset == "qu" and rhyme in {"ynh", "yt", "ych"}:
        resolved = f"u{rhyme}"

    if resolved == "y":
        resolved = "i"

    nucleus, coda = split_vietnamese_rhyme(resolved)
    if nucleus == "y":
        nucleus = "i"
    elif nucleus == "yê":
        nucleus = "iê"
    canonical_rhyme = f"{nucleus}{coda}"
    return canonical_rhyme, nucleus, coda


def is_regional_phonetic_variant(
    ref_word: str,
    spk_word: str,
    profile: PhoneticProfile,
) -> tuple[bool, str | None]:
    """Check whether `spk_word` is a tolerated regional pronunciation variant of `ref_word`.

    Returns `(False, None)` when exact-matched, under `STRICT_SGK`, or an unrelated error.
    """
    norm_ref = normalize_vietnamese_word(ref_word)
    norm_spk = normalize_vietnamese_word(spk_word)
    if not norm_ref or not norm_spk or norm_ref == norm_spk or profile == "STRICT_SGK":
        return False, None

    ref_parts = decompose_vietnamese_syllable(norm_ref)
    spk_parts = decompose_vietnamese_syllable(norm_spk)
    if ref_parts is None or spk_parts is None:
        return False, None

    ref_rhyme, ref_nuc, ref_coda = _canonical_rhyme_and_parts(ref_parts.onset, ref_parts.rhyme)
    spk_rhyme, spk_nuc, spk_coda = _canonical_rhyme_and_parts(spk_parts.onset, spk_parts.rhyme)
    ref_onset_canon = _canonical_onset(ref_parts.onset)
    spk_onset_canon = _canonical_onset(spk_parts.onset)

    if profile == "NORTH_TOLERANT":
        # Onset equivalences l<->n, s<->x, tr<->ch, r<->d<->gi when rhyme & tone match
        if ref_rhyme == spk_rhyme and ref_parts.tone == spk_parts.tone:
            if _in_equiv_class(ref_parts.onset, spk_parts.onset, _NORTH_ONSET_EQUIV):
                pair = "_".join(sorted((ref_parts.onset, spk_parts.onset)))
                return True, f"NORTH:onset_{pair}"
        return False, None

    if profile == "CENTRAL_TOLERANT":
        # Onset & nucleus must match; coda equal-or-equiv AND tone equal-or-equiv
        if ref_onset_canon != spk_onset_canon or ref_nuc != spk_nuc:
            return False, None
        coda_same = ref_coda == spk_coda
        coda_equiv = _in_equiv_class(ref_coda, spk_coda, _CENTRAL_CODA_EQUIV)
        tone_same = ref_parts.tone == spk_parts.tone
        tone_equiv = _in_equiv_class(ref_parts.tone, spk_parts.tone, _CENTRAL_TONE_EQUIV)

        if not (coda_same or coda_equiv) or not (tone_same or tone_equiv):
            return False, None
        if tone_equiv and coda_same:
            pair = "_".join(sorted((ref_parts.tone, spk_parts.tone)))
            return True, f"CENTRAL:tone_{pair}"
        if coda_equiv and tone_same:
            pair = "_".join(sorted((ref_coda, spk_coda)))
            return True, f"CENTRAL:coda_{pair}"
        if tone_equiv and coda_equiv:
            return True, "CENTRAL:tone_coda_combined"
        return False, None

    if profile == "SOUTH_TOLERANT":
        # Onset v<->d(/gi), tone hoi<->nga, coda n<->ng, t<->c, n<->nh when skeleton matches
        if ref_nuc != spk_nuc:
            return False, None
        onset_same = ref_onset_canon == spk_onset_canon
        onset_equiv = _in_equiv_class(ref_parts.onset, spk_parts.onset, _SOUTH_ONSET_EQUIV)
        coda_same = ref_coda == spk_coda
        coda_equiv = _in_equiv_class(ref_coda, spk_coda, _SOUTH_CODA_EQUIV)
        tone_same = ref_parts.tone == spk_parts.tone
        tone_equiv = _in_equiv_class(ref_parts.tone, spk_parts.tone, _SOUTH_TONE_EQUIV)

        if not (onset_same or onset_equiv):
            return False, None
        if not (coda_same or coda_equiv):
            return False, None
        if not (tone_same or tone_equiv):
            return False, None

        reasons: list[str] = []
        if onset_equiv:
            reasons.append(f"onset_{'_'.join(sorted((ref_parts.onset, spk_parts.onset)))}")
        if tone_equiv:
            reasons.append(f"tone_{'_'.join(sorted((ref_parts.tone, spk_parts.tone)))}")
        if coda_equiv:
            reasons.append(f"coda_{'_'.join(sorted((ref_coda, spk_coda)))}")
        if reasons:
            return True, f"SOUTH:{'+'.join(reasons)}"
        return False, None

    return False, None


def _normalize_tokens(text: str) -> list[str]:
    """Tokenize Vietnamese text using `text_alignment.normalize_text` + word hygiene."""
    out: list[str] = []
    for tok in normalize_text(unicodedata.normalize("NFC", str(text or ""))):
        cleaned = normalize_vietnamese_word(tok)
        if cleaned:
            out.append(cleaned)
    return out


def evaluate_dual_score_alignment(
    reference_text: str,
    spoken_text: str,
    profile: PhoneticProfile = "STRICT_SGK",
) -> AlignmentEvaluateResponse:
    """Align `reference_text` vs `spoken_text` and compute BOTH strict SGK & regional accuracy.

    Uses scaled-integer DP (`exact=0`, `regional_variant=1`, `unrelated_sub=4`, `del=4`, `ins=4`)
    so regional variants anchor cleanly to their reference syllable even around omissions/insertions,
    while true omissions and unrelated substitutions are always surfaced in `true_error_words`.
    """
    safe_profile = coerce_phonetic_profile(profile)
    ref_tokens = _normalize_tokens(reference_text)
    spk_tokens = _normalize_tokens(spoken_text)

    n = len(ref_tokens)
    m = len(spk_tokens)
    if n == 0:
        return AlignmentEvaluateResponse(
            phonetic_profile=safe_profile,
            strict_sgk_accuracy=1.0,
            regional_tolerant_accuracy=1.0,
            total_reference_words=0,
            regional_variant_matches=[],
            true_error_words=[],
        )

    del_cost = 4
    ins_cost = 4
    sub_costs = [[0] * m for _ in range(n)]
    variant_rules: list[list[str | None]] = [[None] * m for _ in range(n)]

    for i in range(n):
        rw = ref_tokens[i]
        for j in range(m):
            sw = spk_tokens[j]
            if rw == sw:
                sub_costs[i][j] = 0
            else:
                is_reg, rule = is_regional_phonetic_variant(rw, sw, safe_profile)
                if is_reg and rule:
                    sub_costs[i][j] = 1
                    variant_rules[i][j] = rule
                else:
                    sub_costs[i][j] = 4

    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i * del_cost
    for j in range(1, m + 1):
        dp[0][j] = j * ins_cost

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            dp[i][j] = min(
                dp[i - 1][j] + del_cost,
                dp[i][j - 1] + ins_cost,
                dp[i - 1][j - 1] + sub_costs[i - 1][j - 1],
            )

    # Backtrack: exact/regional/substitute diagonal -> insert -> delete
    i, j = n, m
    aligned_steps: list[tuple[int, str, str | None, str | None]] = []
    while i > 0 or j > 0:
        if i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + sub_costs[i - 1][j - 1]:
            aligned_steps.append(
                (i - 1, ref_tokens[i - 1], spk_tokens[j - 1], variant_rules[i - 1][j - 1])
            )
            i -= 1
            j -= 1
        elif j > 0 and dp[i][j] == dp[i][j - 1] + ins_cost:
            j -= 1
        else:
            aligned_steps.append((i - 1, ref_tokens[i - 1], None, None))
            i -= 1

    aligned_steps.reverse()

    strict_correct = 0
    regional_correct = 0
    regional_matches: list[RegionalVariantMatch] = []
    true_errors: list[str] = []

    for book_idx, ref_w, spk_w, rule in aligned_steps:
        if spk_w is None:
            true_errors.append(ref_w)
        elif ref_w == spk_w:
            strict_correct += 1
            regional_correct += 1
        elif rule is not None:
            regional_correct += 1
            regional_matches.append(
                RegionalVariantMatch(
                    reference_word=ref_w,
                    spoken_word=spk_w,
                    variant_rule=rule,
                    book_index=book_idx,
                )
            )
        else:
            true_errors.append(ref_w)

    strict_acc = round(strict_correct / n, 4)
    regional_acc = round(regional_correct / n, 4)

    return AlignmentEvaluateResponse(
        phonetic_profile=safe_profile,
        strict_sgk_accuracy=strict_acc,
        regional_tolerant_accuracy=regional_acc,
        total_reference_words=n,
        regional_variant_matches=regional_matches,
        true_error_words=true_errors,
    )


# ─── Service class ────────────────────────────────────────────────────────────


class RegionalPhoneticService:
    """Business logic for Feature #3 regional phonetics & 30s ear-before-voice routes."""

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def _get_child(self, parent_id: UUID, child_id: UUID) -> ChildProfile:
        """Fetch ChildProfile with strict PARENT_PRIVATE ownership check (404 / 403)."""
        row: ChildProfile | None = await self._db.scalar(
            select(ChildProfile).where(ChildProfile.Id == child_id).limit(1)
        )
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found.",
            )
        if row.ParentId != parent_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied to this child profile.",
            )
        return row

    async def _release_read_tx(self) -> None:
        try:
            await self._db.rollback()
        except Exception:
            pass

    # ── Profile ───────────────────────────────────────────────────────────────

    async def get_profile(
        self, parent_id: UUID, child_id: UUID
    ) -> RegionalPhoneticProfileResponse:
        child = await self._get_child(parent_id, child_id)
        settings: dict[str, Any] = (
            dict(child.Settings) if isinstance(child.Settings, dict) else {}
        )
        profile = coerce_phonetic_profile(settings.get(PHONETIC_PROFILE_SETTINGS_KEY))
        await self._release_read_tx()
        return RegionalPhoneticProfileResponse(
            child_id=child_id,
            phonetic_profile=profile,
        )

    async def update_profile(
        self,
        parent_id: UUID,
        child_id: UUID,
        payload: RegionalPhoneticProfileUpdate,
    ) -> RegionalPhoneticProfileResponse:
        child = await self._get_child(parent_id, child_id)
        settings: dict[str, Any] = (
            dict(child.Settings) if isinstance(child.Settings, dict) else {}
        )
        settings[PHONETIC_PROFILE_SETTINGS_KEY] = payload.phonetic_profile
        child.Settings = settings
        try:
            flag_modified(child, "Settings")
        except Exception:
            pass
        try:
            await self._db.commit()
        except Exception:
            await self._release_read_tx()
            raise
        return RegionalPhoneticProfileResponse(
            child_id=child_id,
            phonetic_profile=payload.phonetic_profile,
        )

    # ── Alignment evaluation ──────────────────────────────────────────────────

    async def evaluate_alignment(
        self,
        parent_id: UUID,
        child_id: UUID,
        payload: AlignmentEvaluateRequest,
    ) -> AlignmentEvaluateResponse:
        child = await self._get_child(parent_id, child_id)
        settings: dict[str, Any] = (
            dict(child.Settings) if isinstance(child.Settings, dict) else {}
        )
        saved_profile = coerce_phonetic_profile(settings.get(PHONETIC_PROFILE_SETTINGS_KEY))
        await self._release_read_tx()

        effective_profile = payload.phonetic_profile_override or saved_profile
        return evaluate_dual_score_alignment(
            payload.reference_text,
            payload.spoken_text,
            effective_profile,
        )

    # ── 30s Ear Trainer ───────────────────────────────────────────────────────

    async def get_ear_trainer(
        self, parent_id: UUID, child_id: UUID
    ) -> EarTrainer30sResponse:
        child = await self._get_child(parent_id, child_id)
        settings: dict[str, Any] = (
            dict(child.Settings) if isinstance(child.Settings, dict) else {}
        )
        profile = coerce_phonetic_profile(settings.get(PHONETIC_PROFILE_SETTINGS_KEY))

        weak_words = await list_active_weak_words_for_child(
            self._db, child_id, parent_id=parent_id, limit=8
        )
        await self._release_read_tx()

        weak_categories: list[str] = []

        def _add_weak_cat(cat_key: str) -> None:
            if cat_key != "general" and cat_key not in weak_categories:
                weak_categories.append(cat_key)

        for word in weak_words:
            primary_cat, _label = classify_vietnamese_phonics_category(word)
            _add_weak_cat(primary_cat)
            for syl in tokenize_focus_phrase(word):
                parts = decompose_vietnamese_syllable(syl)
                if parts is None:
                    continue
                if parts.onset in ("l", "n"):
                    _add_weak_cat("l_n")
                elif parts.onset in ("s", "x"):
                    _add_weak_cat("s_x")
                elif parts.onset in ("tr", "ch"):
                    _add_weak_cat("tr_ch")
                elif parts.onset in ("r", "d", "gi"):
                    _add_weak_cat("r_d_gi")
                if parts.tone in ("hoi", "nga"):
                    _add_weak_cat("hoi_nga")
                _nuc, coda = split_vietnamese_rhyme(parts.rhyme)
                if coda in ("n", "ng", "nh", "t", "c", "ch"):
                    _add_weak_cat("coda_n_ng_t_c")

        priority_categories: list[str] = list(weak_categories)
        for cat in _PROFILE_DEFAULT_CATEGORIES.get(profile, ()):
            if cat not in priority_categories:
                priority_categories.append(cat)

        # Rank pairs: 1) matching child's weak categories in order, 2) profile defaults, 3) rest of bank
        selected_pairs: list[tuple[str, str, str]] = []
        seen_targets: set[str] = set()

        for cat in priority_categories:
            for pair in _MINIMAL_PAIR_BANK:
                if len(selected_pairs) >= 3:
                    break
                if pair[2] == cat and pair[0] not in seen_targets:
                    selected_pairs.append(pair)
                    seen_targets.add(pair[0])
                    break  # Spread across distinct categories first
            if len(selected_pairs) >= 3:
                break

        for pair in _MINIMAL_PAIR_BANK:
            if len(selected_pairs) >= 3:
                break
            if pair[0] not in seen_targets:
                selected_pairs.append(pair)
                seen_targets.add(pair[0])

        weak_kts = build_contrastive_vietnamese_keyterms(weak_words[:4], max_items=8)
        rounds: list[MinimalPairRound] = []

        for idx, (target, distractor, cat) in enumerate(selected_pairs[:3]):
            options = [target, distractor] if idx % 2 == 0 else [distractor, target]
            pair_kts = build_contrastive_vietnamese_keyterms(
                [target, distractor, *weak_kts[:2]],
                max_items=8,
            )
            cat_label = PHONICS_CATEGORY_LABELS_VI.get(cat, "Từ cần ôn")  # type: ignore[arg-type]
            rounds.append(
                MinimalPairRound(
                    round_index=idx,
                    target_word=target,
                    distractor_word=distractor,
                    options=options,
                    tts_text=f"Từ {target}.",
                    contrastive_keyterms=pair_kts,
                    phonics_category=cat,
                    phonics_category_label_vi=cat_label,
                )
            )

        return EarTrainer30sResponse(
            child_id=child_id,
            phonetic_profile=profile,
            rounds=rounds,
            total_rounds=len(rounds),
            duration_seconds=30,
            focus_weak_categories=weak_categories,
        )

    async def complete_ear_trainer(
        self,
        parent_id: UUID,
        child_id: UUID,
        payload: EarTrainerCompleteRequest,
    ) -> EarTrainerCompleteResponse:
        child = await self._get_child(parent_id, child_id)
        settings: dict[str, Any] = (
            dict(child.Settings) if isinstance(child.Settings, dict) else {}
        )
        profile = coerce_phonetic_profile(settings.get(PHONETIC_PROFILE_SETTINGS_KEY))

        attempted = max(1, payload.rounds_attempted)
        correct = min(max(0, payload.rounds_correct), attempted)
        accuracy = round(correct / attempted, 4)
        completion_mode = "VOICE_ECHO" if payload.phase_b_spoken else "CALM_TAP"
        xp = correct * 10 + (5 if payload.phase_b_spoken else 0)

        cleaned_words = [
            unicodedata.normalize("NFC", w).strip()[:40]
            for w in payload.practiced_words
            if isinstance(w, str) and w.strip()
        ][:6]

        if _is_usable_async_db(self._db):
            now = datetime.now(timezone.utc)
            try:
                async with self._db.begin_nested():
                    ev_row = LearningSkillEvidence(
                        Id=uuid4(),
                        ChildId=child_id,
                        ParentId=parent_id,
                        SkillKey="regional_ear_discrimination",
                        SourceModule="DIFFICULT_WORD",
                        SourceRecordId=f"ear30s:{uuid4()}",
                        EvidenceType="OBSERVED",
                        ScoreNormalized=accuracy,
                        Confidence=0.9 if payload.phase_b_spoken else 0.85,
                        DifficultyLevel=1,
                        PracticeWords=cleaned_words,
                        MetadataJson={
                            "origin": "TAI_THINH_EAR_TRAINER_30S",
                            "phonetic_profile": profile,
                            "completion_mode": completion_mode,
                            "rounds_attempted": attempted,
                            "rounds_correct": correct,
                        },
                        CreatedAt=now,
                    )
                    self._db.add(ev_row)
                    await self._db.flush()
                await self._db.commit()
            except (IntegrityError, ProgrammingError, SQLAlchemyError):
                await self._release_read_tx()
        else:
            await self._release_read_tx()

        if accuracy >= 1.0:
            msg_vi = "Xuất sắc! Tai thính miệng xinh — bé phân biệt chuẩn cả 3 cặp âm!"
            msg_en = "Wonderful! Sharp ear — you matched all 3 minimal pairs!"
        elif accuracy >= 0.6:
            msg_vi = "Rất giỏi! Đôi tai của bé đang nghe tinh hơn mỗi ngày!"
            msg_en = "Great job! Your listening ear is getting sharper every day!"
        else:
            msg_vi = "Êm dịu lắm! Nghe chậm rãi từng cặp âm sẽ giúp bé tự tin hơn nhé!"
            msg_en = "Gentle progress! Listening calmly to minimal pairs builds confidence!"

        return EarTrainerCompleteResponse(
            child_id=child_id,
            phonetic_profile=profile,
            rounds_attempted=attempted,
            rounds_correct=correct,
            accuracy=accuracy,
            phase_b_spoken=payload.phase_b_spoken,
            completion_mode=completion_mode,
            xp_earned=xp,
            message_vi=msg_vi,
            message_en=msg_en,
        )
