"""ORM models for ViRead Intelligent Play & Learn V4.0 ecosystem."""

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class LearningSkillEvidence(Base):
    """Stores verifiable child skill evidence across reading and entertainment modules."""

    __tablename__ = "learning_skill_evidence"
    __table_args__ = (
        CheckConstraint(
            "source_module IN ('READING', 'DIFFICULT_WORD', 'PICTURE_DESCRIPTION', "
            "'SENTENCE_SHOOTER', 'KARAOKE', 'MEMORY_GAME')",
            name="ck_learning_skill_evidence_module",
        ),
        CheckConstraint(
            "evidence_type IN ('OBSERVED', 'ESTIMATED')",
            name="ck_learning_skill_evidence_type",
        ),
        CheckConstraint(
            "score_normalized >= 0 AND score_normalized <= 1",
            name="ck_learning_skill_evidence_score",
        ),
        CheckConstraint(
            "confidence >= 0 AND confidence <= 1",
            name="ck_learning_skill_evidence_confidence",
        ),
        CheckConstraint(
            "difficulty_level BETWEEN 1 AND 5",
            name="ck_learning_skill_evidence_difficulty",
        ),
        Index(
            "ix_learning_skill_evidence_child_skill_created",
            "child_id",
            "skill_key",
            "created_at",
        ),
        Index(
            "ix_learning_skill_evidence_child_module_created",
            "child_id",
            "source_module",
            "created_at",
        ),
        Index(
            "uq_learning_skill_evidence_dedupe",
            "child_id",
            "source_module",
            "source_record_id",
            "skill_key",
            unique=True,
            postgresql_where=text("source_record_id IS NOT NULL"),
        ),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column("child_id", UUID(as_uuid=True), ForeignKey("childprofiles.id", ondelete="CASCADE"), nullable=False)
    ParentId = Column("parent_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    SkillKey = Column("skill_key", String(64), nullable=False)
    SourceModule = Column("source_module", String(32), nullable=False)
    SourceRecordId = Column("source_record_id", String(64), nullable=True)
    EvidenceType = Column("evidence_type", String(16), nullable=False, server_default=text("'OBSERVED'"))
    ScoreNormalized = Column("score_normalized", Float, nullable=False)
    Confidence = Column("confidence", Float, nullable=False, server_default=text("0.7"))
    DifficultyLevel = Column("difficulty_level", SmallInteger, nullable=False, server_default=text("1"))
    PracticeWords = Column("practice_words", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    MetadataJson = Column("metadata_json", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    CreatedAt = Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())


class MemoryGameSession(Base):
    """Stores one child session of 'Bé nhớ được gì?' with verifiable deterministic SceneSpec."""

    __tablename__ = "memory_game_sessions"
    __table_args__ = (
        CheckConstraint("child_grade BETWEEN 1 AND 5", name="ck_memory_game_sessions_grade"),
        CheckConstraint("difficulty_level BETWEEN 1 AND 5", name="ck_memory_game_sessions_difficulty"),
        CheckConstraint(
            "timer_mode IN ('10S', '20S', '30S', '60S', '90S', '120S', 'UNLIMITED')",
            name="ck_memory_game_sessions_timer_mode",
        ),
        CheckConstraint(
            "timer_seconds IS NULL OR timer_seconds BETWEEN 10 AND 120",
            name="ck_memory_game_sessions_timer_seconds",
        ),
        CheckConstraint(
            "recall_mode IN ('FREE_RECALL', 'GUIDED_RECALL')",
            name="ck_memory_game_sessions_recall_mode",
        ),
        CheckConstraint(
            "status IN ('OBSERVING', 'RECALLING', 'CREATIVE', 'COMPLETED')",
            name="ck_memory_game_sessions_status",
        ),
        CheckConstraint("hints_used >= 0", name="ck_memory_game_sessions_hints"),
        CheckConstraint("peek_count >= 0", name="ck_memory_game_sessions_peeks"),
        CheckConstraint("best_factual_score BETWEEN 0 AND 100", name="ck_memory_game_sessions_factual"),
        CheckConstraint("best_creative_score BETWEEN 0 AND 100", name="ck_memory_game_sessions_creative"),
        CheckConstraint("stars BETWEEN 0 AND 3", name="ck_memory_game_sessions_stars"),
        CheckConstraint("attempts_count >= 0", name="ck_memory_game_sessions_attempts"),
        Index("ix_memory_game_sessions_child_created", "child_id", "created_at"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column("child_id", UUID(as_uuid=True), ForeignKey("childprofiles.id", ondelete="CASCADE"), nullable=False)
    ParentId = Column("parent_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    ChildGrade = Column("child_grade", SmallInteger, nullable=False)
    ThemeKey = Column("theme_key", String(48), nullable=False)
    DifficultyLevel = Column("difficulty_level", SmallInteger, nullable=False, server_default=text("1"))
    SceneSeed = Column("scene_seed", Integer, nullable=False)
    TimerMode = Column("timer_mode", String(16), nullable=False, server_default=text("'30S'"))
    TimerSeconds = Column("timer_seconds", Integer, nullable=True)
    RecallMode = Column("recall_mode", String(24), nullable=False, server_default=text("'FREE_RECALL'"))
    SceneSpec = Column("scene_spec", JSONB, nullable=False)
    Status = Column("status", String(16), nullable=False, server_default=text("'OBSERVING'"))
    HintsUsed = Column("hints_used", SmallInteger, nullable=False, server_default=text("0"))
    PeekCount = Column("peek_count", SmallInteger, nullable=False, server_default=text("0"))
    BestFactualScore = Column("best_factual_score", SmallInteger, nullable=False, server_default=text("0"))
    BestCreativeScore = Column("best_creative_score", SmallInteger, nullable=False, server_default=text("0"))
    Stars = Column("stars", SmallInteger, nullable=False, server_default=text("0"))
    AttemptsCount = Column("attempts_count", Integer, nullable=False, server_default=text("0"))
    CreatedAt = Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now())


class MemoryGameAttempt(Base):
    """Stores one recall or creative attempt within a Memory Game session."""

    __tablename__ = "memory_game_attempts"
    __table_args__ = (
        CheckConstraint("attempt_number >= 1", name="ck_memory_game_attempts_number"),
        CheckConstraint("stage IN ('RECALL', 'CREATIVE')", name="ck_memory_game_attempts_stage"),
        CheckConstraint("input_mode IN ('VOICE', 'TEXT')", name="ck_memory_game_attempts_input_mode"),
        CheckConstraint("factual_score BETWEEN 0 AND 100", name="ck_memory_game_attempts_factual"),
        CheckConstraint("creative_score BETWEEN 0 AND 100", name="ck_memory_game_attempts_creative"),
        CheckConstraint("stars BETWEEN 0 AND 3", name="ck_memory_game_attempts_stars"),
        UniqueConstraint("session_id", "attempt_number", name="uq_memory_game_attempts_session_number"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    SessionId = Column(
        "session_id",
        UUID(as_uuid=True),
        ForeignKey("memory_game_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    AttemptNumber = Column("attempt_number", Integer, nullable=False)
    Stage = Column("stage", String(24), nullable=False, server_default=text("'RECALL'"))
    InputMode = Column("input_mode", String(16), nullable=False, server_default=text("'TEXT'"))
    ResponseText = Column("response_text", Text, nullable=False)
    FactualScore = Column("factual_score", SmallInteger, nullable=False, server_default=text("0"))
    CreativeScore = Column("creative_score", SmallInteger, nullable=False, server_default=text("0"))
    Stars = Column("stars", SmallInteger, nullable=False, server_default=text("0"))
    EvaluationPayload = Column("evaluation_payload", JSONB, nullable=False)
    AiProvider = Column("ai_provider", String(64), nullable=True)
    CreatedAt = Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())


class KaraokePracticeSession(Base):
    """Stores compact musical karaoke practice summaries (never raw audio)."""

    __tablename__ = "karaoke_practice_sessions"
    __table_args__ = (
        CheckConstraint(
            "practice_mode IN ('FULL_SONG', 'SEGMENT', 'RHYTHM_TAP', 'LINE_PRACTICE')",
            name="ck_karaoke_practice_mode",
        ),
        CheckConstraint(
            "scoring_mode IN ('FULL_MUSICAL', 'RHYTHM_AND_LYRICS', 'LYRICS_ONLY', 'INSUFFICIENT_EVIDENCE')",
            name="ck_karaoke_practice_scoring_mode",
        ),
        CheckConstraint("playback_rate >= 0.5 AND playback_rate <= 1.5", name="ck_karaoke_practice_rate"),
        CheckConstraint(
            "overall_score IS NULL OR overall_score BETWEEN 0 AND 100",
            name="ck_karaoke_practice_overall",
        ),
        CheckConstraint(
            "rhythm_score IS NULL OR rhythm_score BETWEEN 0 AND 100",
            name="ck_karaoke_practice_rhythm",
        ),
        CheckConstraint(
            "pitch_score IS NULL OR pitch_score BETWEEN 0 AND 100",
            name="ck_karaoke_practice_pitch",
        ),
        CheckConstraint(
            "lyrics_score IS NULL OR lyrics_score BETWEEN 0 AND 100",
            name="ck_karaoke_practice_lyrics",
        ),
        CheckConstraint(
            "fluency_score IS NULL OR fluency_score BETWEEN 0 AND 100",
            name="ck_karaoke_practice_fluency",
        ),
        CheckConstraint("stars BETWEEN 0 AND 3", name="ck_karaoke_practice_stars"),
        CheckConstraint(
            "(segment_start_ms IS NULL AND segment_end_ms IS NULL) OR "
            "(segment_start_ms IS NOT NULL AND segment_end_ms IS NOT NULL AND "
            "segment_start_ms >= 0 AND segment_end_ms > segment_start_ms)",
            name="ck_karaoke_practice_segment",
        ),
        Index(
            "ix_karaoke_practice_sessions_child_song_created",
            "child_id",
            "song_id",
            "created_at",
        ),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column("child_id", UUID(as_uuid=True), ForeignKey("childprofiles.id", ondelete="CASCADE"), nullable=False)
    ParentId = Column("parent_id", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    SongId = Column("song_id", UUID(as_uuid=True), ForeignKey("karaoke_songs.id", ondelete="CASCADE"), nullable=False)
    SongVersionId = Column(
        "song_version_id",
        UUID(as_uuid=True),
        ForeignKey("karaoke_song_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    PracticeMode = Column("practice_mode", String(24), nullable=False, server_default=text("'FULL_SONG'"))
    ScoringMode = Column("scoring_mode", String(24), nullable=False, server_default=text("'INSUFFICIENT_EVIDENCE'"))
    PlaybackRate = Column("playback_rate", Float, nullable=False, server_default=text("1.0"))
    HeadphoneMode = Column("headphone_mode", Boolean, nullable=False, server_default=text("false"))
    OverallScore = Column("overall_score", SmallInteger, nullable=True)
    RhythmScore = Column("rhythm_score", SmallInteger, nullable=True)
    PitchScore = Column("pitch_score", SmallInteger, nullable=True)
    LyricsScore = Column("lyrics_score", SmallInteger, nullable=True)
    FluencyScore = Column("fluency_score", SmallInteger, nullable=True)
    Stars = Column("stars", SmallInteger, nullable=False, server_default=text("0"))
    SegmentStartMs = Column("segment_start_ms", Integer, nullable=True)
    SegmentEndMs = Column("segment_end_ms", Integer, nullable=True)
    ReportPayload = Column("report_payload", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    CreatedAt = Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())


class KaraokeMusicalProfile(Base):
    """Stores compact musical reference profile (BPM, beat grid, pitch contour) per song version."""

    __tablename__ = "karaoke_musical_profiles"
    __table_args__ = (
        CheckConstraint("bpm IS NULL OR (bpm >= 30 AND bpm <= 240)", name="ck_karaoke_musical_profiles_bpm"),
        CheckConstraint(
            "audio_type IN ('VOCAL_FULL', 'INSTRUMENTAL_ONLY', 'DUAL_TRACK', 'UNKNOWN')",
            name="ck_karaoke_musical_profiles_audio_type",
        ),
        CheckConstraint(
            "source_method IN ('ID3_LRC', 'AUDIO_DSP', 'WHISPER_DRAFT', 'MANUAL_TAP', 'LYRICS_TIMING')",
            name="ck_karaoke_musical_profiles_source_method",
        ),
    )

    SongVersionId = Column(
        "song_version_id",
        UUID(as_uuid=True),
        ForeignKey("karaoke_song_versions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    Bpm = Column("bpm", Float, nullable=True)
    AudioType = Column("audio_type", String(24), nullable=False, server_default=text("'UNKNOWN'"))
    HasPitchContour = Column("has_pitch_contour", Boolean, nullable=False, server_default=text("false"))
    HasBeatGrid = Column("has_beat_grid", Boolean, nullable=False, server_default=text("false"))
    SourceMethod = Column("source_method", String(32), nullable=False, server_default=text("'LYRICS_TIMING'"))
    ProfileJson = Column("profile_json", JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    UpdatedAt = Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now())
