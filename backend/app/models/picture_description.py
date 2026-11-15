from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
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


class PictureDescriptionSession(Base):
    """Stores a child's picture description learning session and AI prompt guide."""

    __tablename__ = "picturedescriptionsessions"
    __table_args__ = (
        CheckConstraint(
            "sourcetype IN ('BOOK_PAGE', 'CUSTOM_UPLOAD', 'SAMPLE')",
            name="ck_picturedescriptionsessions_sourcetype",
        ),
        CheckConstraint(
            "childgrade BETWEEN 1 AND 5",
            name="ck_picturedescriptionsessions_childgrade",
        ),
        CheckConstraint(
            "status IN ('ACTIVE', 'COMPLETED')",
            name="ck_picturedescriptionsessions_status",
        ),
        CheckConstraint(
            "beststars BETWEEN 0 AND 3",
            name="ck_picturedescriptionsessions_beststars",
        ),
        CheckConstraint(
            "bestscore BETWEEN 0 AND 10",
            name="ck_picturedescriptionsessions_bestscore",
        ),
        CheckConstraint(
            "attemptscount >= 0",
            name="ck_picturedescriptionsessions_attemptscount",
        ),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildProfileId = Column(
        "childprofileid",
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
    BookId = Column(
        "bookid",
        UUID(as_uuid=True),
        ForeignKey("books.id", ondelete="SET NULL"),
        nullable=True,
    )
    BookPageId = Column(
        "bookpageid",
        UUID(as_uuid=True),
        ForeignKey("bookpages.id", ondelete="SET NULL"),
        nullable=True,
    )
    SourceType = Column("sourcetype", String(24), nullable=False)
    SampleKey = Column("samplekey", String(64), nullable=True)
    # Relative storage object path (`books/...`, `picture-descriptions/...`) or `sample://...`.
    ImagePath = Column("imagepath", Text, nullable=False)
    ImageMimeType = Column("imagemimetype", String(32), nullable=False, server_default=text("'image/png'"))
    ChildGrade = Column("childgrade", SmallInteger, nullable=False)
    SceneTitle = Column("scenetitle", String(200), nullable=False)
    PromptPayload = Column("promptpayload", JSONB, nullable=False)
    Status = Column("status", String(16), nullable=False, server_default=text("'ACTIVE'"))
    BestStars = Column("beststars", SmallInteger, nullable=False, server_default=text("0"))
    BestScore = Column("bestscore", SmallInteger, nullable=False, server_default=text("0"))
    AttemptsCount = Column("attemptscount", Integer, nullable=False, server_default=text("0"))
    AiModelUsed = Column("aimodelused", String(64), nullable=True)
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
    UpdatedAt = Column("updatedat", DateTime(timezone=True), nullable=False, server_default=func.now())


class PictureDescriptionAttempt(Base):
    """Stores one child description submission and its multimodal Gemini evaluation."""

    __tablename__ = "picturedescriptionattempts"
    __table_args__ = (
        CheckConstraint(
            "attemptnumber >= 1",
            name="ck_picturedescriptionattempts_number",
        ),
        CheckConstraint(
            "inputmode IN ('VOICE', 'TEXT')",
            name="ck_picturedescriptionattempts_inputmode",
        ),
        CheckConstraint(
            "scoreoutof10 BETWEEN 0 AND 10",
            name="ck_picturedescriptionattempts_score",
        ),
        CheckConstraint(
            "stars BETWEEN 0 AND 3",
            name="ck_picturedescriptionattempts_stars",
        ),
        UniqueConstraint(
            "sessionid",
            "attemptnumber",
            name="uq_picturedescriptionattempts_session_number",
        ),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    SessionId = Column(
        "sessionid",
        UUID(as_uuid=True),
        ForeignKey("picturedescriptionsessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    AttemptNumber = Column("attemptnumber", Integer, nullable=False)
    InputMode = Column("inputmode", String(16), nullable=False)
    TranscriptText = Column("transcripttext", Text, nullable=False)
    ScoreOutOf10 = Column("scoreoutof10", SmallInteger, nullable=False)
    Stars = Column("stars", SmallInteger, nullable=False)
    FeedbackPayload = Column("feedbackpayload", JSONB, nullable=False)
    AiModelUsed = Column("aimodelused", String(64), nullable=True)
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
