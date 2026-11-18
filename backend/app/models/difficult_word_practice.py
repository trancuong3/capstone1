from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class DifficultWordPracticeAttempt(Base):
    """Stores one child's isolated practice attempt for a difficult word.

    Kept strictly separate from readingcomparisonreports and initial reading
    assessments so practicing a word never mutates historical reading scores.
    """

    __tablename__ = "difficult_word_practice_attempts"
    __table_args__ = (
        CheckConstraint("attemptnumber >= 1", name="ck_difficult_word_practice_attempt_number"),
        CheckConstraint(
            "state IN ('STARTED', 'COMPLETED')",
            name="ck_difficult_word_practice_state",
        ),
        CheckConstraint(
            "assessmentstatus IS NULL OR assessmentstatus IN "
            "('CORRECT', 'INCORRECT', 'UNCERTAIN', 'NO_CLEAR_AUDIO', 'ENGINE_ERROR')",
            name="ck_difficult_word_practice_assessment_status",
        ),
        CheckConstraint(
            "recognitionsource IS NULL OR recognitionsource IN "
            "('SERVER_STT', 'SERVER_STT_KEYTERM', 'BROWSER_SPEECH', 'AUDIO_QUALITY_GATE', 'ENGINE_ERROR')",
            name="ck_difficult_word_practice_recognition_source",
        ),
        CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_difficult_word_practice_confidence",
        ),
        CheckConstraint(
            "audiodurationms IS NULL OR audiodurationms >= 0",
            name="ck_difficult_word_practice_audio_duration",
        ),
        UniqueConstraint(
            "childid",
            "normalizedword",
            "requestid",
            name="uq_difficult_word_practice_start_req",
        ),
        UniqueConstraint(
            "childid",
            "completionrequestid",
            name="uq_difficult_word_practice_complete_req",
        ),
        Index(
            "ix_difficult_word_practice_child_word_created",
            "childid",
            "normalizedword",
            "createdat",
        ),
        Index(
            "ix_difficult_word_practice_child_completed",
            "childid",
            "completedat",
        ),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column(
        "childid",
        UUID(as_uuid=True),
        ForeignKey("childprofiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    ParentId = Column(
        "parentid",
        UUID(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    NormalizedWord = Column("normalizedword", String(120), nullable=False)
    DisplayText = Column("displaytext", String(120), nullable=False)
    AttemptNumber = Column("attemptnumber", Integer, nullable=False)
    RequestId = Column("requestid", UUID(as_uuid=True), nullable=False)
    CompletionRequestId = Column("completionrequestid", UUID(as_uuid=True), nullable=True)
    State = Column("state", String(16), nullable=False, server_default=text("'STARTED'"))
    AssessmentStatus = Column("assessmentstatus", String(24), nullable=True)
    RecognitionSource = Column("recognitionsource", String(32), nullable=True)
    SpokenTranscript = Column("spokentranscript", String(160), nullable=True)
    Confidence = Column("confidence", Float, nullable=True)
    AudioDurationMs = Column("audiodurationms", Integer, nullable=True)
    AssessmentVersion = Column("assessmentversion", SmallInteger, nullable=False, server_default=text("1"))
    EvidenceWordIds = Column("evidencewordids", JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    BookId = Column(
        "bookid",
        UUID(as_uuid=True),
        ForeignKey("books.id", ondelete="SET NULL"),
        nullable=True,
    )
    SessionId = Column(
        "sessionid",
        UUID(as_uuid=True),
        ForeignKey("readingsessions.id", ondelete="SET NULL"),
        nullable=True,
    )
    PageId = Column(
        "pageid",
        UUID(as_uuid=True),
        ForeignKey("bookpages.id", ondelete="SET NULL"),
        nullable=True,
    )
    PageRevisionId = Column(
        "pagerevisionid",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    WordId = Column(
        "wordid",
        UUID(as_uuid=True),
        ForeignKey("pagerevisionwords.id", ondelete="SET NULL"),
        nullable=True,
    )
    StartedAt = Column("startedat", DateTime(timezone=True), nullable=False, server_default=func.now())
    CompletedAt = Column("completedat", DateTime(timezone=True), nullable=True)
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updatedat", DateTime(timezone=True), nullable=False, server_default=func.now())
