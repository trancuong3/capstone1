"""ORM models for Feature #6: Contextual Kids Glossary & PARENT_PRIVATE Vocabulary Notebook."""

from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.database.session import Base


class WordGlossaryCache(Base):
    """Grade-banded child-safe Vietnamese glossary cache (contains zero household PII)."""

    __tablename__ = "word_glossary_cache"
    __table_args__ = (
        CheckConstraint(
            "grade_band IN ('GRADE_1_2', 'GRADE_3_5')",
            name="ck_word_glossary_cache_grade_band",
        ),
        CheckConstraint(
            "safety_suitability IN ('SUITABLE', 'SUITABLE_WITH_GUIDANCE')",
            name="ck_word_glossary_cache_safety",
        ),
        UniqueConstraint(
            "normalized_word",
            "grade_band",
            name="uq_word_glossary_cache_word_band",
        ),
        Index("ix_word_glossary_cache_lookup", "normalized_word", "grade_band"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    NormalizedWord = Column("normalized_word", String(120), nullable=False)
    DisplayWord = Column("display_word", String(120), nullable=False)
    GradeBand = Column("grade_band", String(16), nullable=False)
    PartOfSpeechVi = Column("part_of_speech_vi", String(48), nullable=True)
    DefinitionVi = Column("definition_vi", Text, nullable=False)
    ExampleSentenceVi = Column("example_sentence_vi", Text, nullable=False)
    NuanceNoteVi = Column("nuance_note_vi", Text, nullable=True)
    SourceProvider = Column("source_provider", String(64), nullable=False, server_default=text("'FALLBACK'"))
    SafetySuitability = Column("safety_suitability", String(32), nullable=False, server_default=text("'SUITABLE'"))
    CreatedAt = Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now())


class ChildFavoriteWord(Base):
    """Strictly PARENT_PRIVATE saved vocabulary entry ('Sổ Từ Hay') owned by a child profile."""

    __tablename__ = "child_favorite_words"
    __table_args__ = (
        CheckConstraint(
            "grade_band IN ('GRADE_1_2', 'GRADE_3_5')",
            name="ck_child_favorite_words_grade_band",
        ),
        CheckConstraint(
            "visibility = 'PARENT_PRIVATE'",
            name="ck_child_favorite_words_visibility",
        ),
        CheckConstraint(
            "times_used_in_games >= 0",
            name="ck_child_favorite_words_times_used",
        ),
        UniqueConstraint(
            "child_profile_id",
            "normalized_word",
            name="uq_child_favorite_words_child_norm",
        ),
        Index(
            "ix_child_favorite_words_child_created",
            "child_profile_id",
            "created_at",
        ),
        Index("ix_child_favorite_words_parent_id", "parent_id"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildProfileId = Column(
        "child_profile_id",
        UUID(as_uuid=True),
        ForeignKey("childprofiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    ParentId = Column(
        "parent_id",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    Word = Column("word", String(120), nullable=False)
    NormalizedWord = Column("normalized_word", String(120), nullable=False)
    GradeBand = Column("grade_band", String(16), nullable=False, server_default=text("'GRADE_1_2'"))
    DefinitionVi = Column("definition_vi", Text, nullable=False)
    ExampleSentenceVi = Column("example_sentence_vi", Text, nullable=False)
    NuanceNoteVi = Column("nuance_note_vi", Text, nullable=True)
    SourceBookId = Column(
        "source_book_id",
        UUID(as_uuid=True),
        ForeignKey("books.id", ondelete="SET NULL"),
        nullable=True,
    )
    SourcePageId = Column(
        "source_page_id",
        UUID(as_uuid=True),
        ForeignKey("bookpages.id", ondelete="SET NULL"),
        nullable=True,
    )
    Visibility = Column("visibility", String(24), nullable=False, server_default=text("'PARENT_PRIVATE'"))
    TimesUsedInGames = Column("times_used_in_games", Integer, nullable=False, server_default=text("0"))
    CreatedAt = Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now())
