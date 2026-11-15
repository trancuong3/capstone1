from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.database.session import Base


class GameSession(Base):
    __tablename__ = "gamesessions"
    __table_args__ = (
        CheckConstraint(
            "difficulty IN ('easy', 'medium', 'challenge')",
            name="ck_gamesessions_difficulty",
        ),
        CheckConstraint(
            "status IN ('IN_PROGRESS', 'COMPLETED', 'ABANDONED')",
            name="ck_gamesessions_status",
        ),
        CheckConstraint("totalrounds BETWEEN 1 AND 5", name="ck_gamesessions_rounds"),
        CheckConstraint("completedrounds >= 0", name="ck_gamesessions_completed_rounds"),
        CheckConstraint("correctcount >= 0", name="ck_gamesessions_correct_count"),
        CheckConstraint("mistakecount >= 0", name="ck_gamesessions_mistake_count"),
        CheckConstraint("hintcount >= 0", name="ck_gamesessions_hint_count"),
        CheckConstraint("totalstars >= 0", name="ck_gamesessions_total_stars"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildProfileId = Column(
        "childprofileid",
        UUID(as_uuid=True),
        ForeignKey("childprofiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    BookId = Column(
        "bookid",
        UUID(as_uuid=True),
        ForeignKey("books.id", ondelete="RESTRICT"),
        nullable=False,
    )
    Difficulty = Column("difficulty", String(16), nullable=False)
    TotalRounds = Column("totalrounds", SmallInteger, nullable=False)
    CompletedRounds = Column("completedrounds", SmallInteger, nullable=False, server_default=text("0"))
    CorrectCount = Column("correctcount", Integer, nullable=False, server_default=text("0"))
    MistakeCount = Column("mistakecount", Integer, nullable=False, server_default=text("0"))
    HintCount = Column("hintcount", Integer, nullable=False, server_default=text("0"))
    TotalStars = Column("totalstars", SmallInteger, nullable=False, server_default=text("0"))
    Status = Column("status", String(16), nullable=False, server_default=text("'IN_PROGRESS'"))
    StartedAt = Column("startedat", DateTime(timezone=True), nullable=False, server_default=func.now())
    CompletedAt = Column("completedat", DateTime(timezone=True))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())


class GameRound(Base):
    __tablename__ = "gamerounds"
    __table_args__ = (
        UniqueConstraint("gamesessionid", "roundnumber", name="uq_gamerounds_session_number"),
        CheckConstraint("roundnumber BETWEEN 1 AND 5", name="ck_gamerounds_number"),
        CheckConstraint("nextexpectedposition >= 0", name="ck_gamerounds_position"),
        CheckConstraint("correctcount >= 0", name="ck_gamerounds_correct_count"),
        CheckConstraint("mistakecount >= 0", name="ck_gamerounds_mistake_count"),
        CheckConstraint("hintcount >= 0", name="ck_gamerounds_hint_count"),
        CheckConstraint("stars BETWEEN 0 AND 3", name="ck_gamerounds_stars"),
        CheckConstraint("status IN ('IN_PROGRESS', 'COMPLETED')", name="ck_gamerounds_status"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    GameSessionId = Column(
        "gamesessionid",
        UUID(as_uuid=True),
        ForeignKey("gamesessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    RoundNumber = Column("roundnumber", SmallInteger, nullable=False)
    BookPageId = Column(
        "bookpageid",
        UUID(as_uuid=True),
        ForeignKey("bookpages.id", ondelete="SET NULL"),
    )
    PageRevisionId = Column(
        "pagerevisionid",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="SET NULL"),
    )
    SentenceSnapshot = Column("sentencesnapshot", String, nullable=False)
    TokensSnapshot = Column("tokenssnapshot", JSONB, nullable=False)
    ExpectedTokenIds = Column("expectedtokenids", JSONB, nullable=False)
    ShuffledTokenIds = Column("shuffledtokenids", JSONB, nullable=False)
    NextExpectedPosition = Column("nextexpectedposition", SmallInteger, nullable=False, server_default=text("0"))
    CorrectCount = Column("correctcount", SmallInteger, nullable=False, server_default=text("0"))
    MistakeCount = Column("mistakecount", SmallInteger, nullable=False, server_default=text("0"))
    HintCount = Column("hintcount", SmallInteger, nullable=False, server_default=text("0"))
    Stars = Column("stars", SmallInteger, nullable=False, server_default=text("0"))
    Status = Column("status", String(16), nullable=False, server_default=text("'IN_PROGRESS'"))
    CompletedAt = Column("completedat", DateTime(timezone=True))
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())


class GameAttempt(Base):
    __tablename__ = "gameattempts"
    __table_args__ = (
        UniqueConstraint("gamesessionid", "requestid", name="uq_gameattempts_session_request"),
    )

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    GameSessionId = Column(
        "gamesessionid",
        UUID(as_uuid=True),
        ForeignKey("gamesessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    GameRoundId = Column(
        "gameroundid",
        UUID(as_uuid=True),
        ForeignKey("gamerounds.id", ondelete="CASCADE"),
        nullable=False,
    )
    RequestId = Column("requestid", UUID(as_uuid=True), nullable=False)
    TokenId = Column("tokenid", UUID(as_uuid=True), nullable=False)
    IsCorrect = Column("iscorrect", Boolean, nullable=False)
    ResultSnapshot = Column("resultsnapshot", JSONB, nullable=False)
    CreatedAt = Column("createdat", DateTime(timezone=True), nullable=False, server_default=func.now())
