from sqlalchemy import (
    Column,
    String,
    Integer,
    Text,
    DateTime,
    ForeignKey,
    Index,
    text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func

from app.database.session import Base


class ReadingComparisonReport(Base):
    __tablename__ = "readingcomparisonreports"

    Id = Column(
        "id",
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )

    SessionId = Column(
        "sessionid",
        UUID(as_uuid=True),
        ForeignKey("readingsessions.id", ondelete="CASCADE"),
        nullable=False,
    )

    PageId = Column(
        "pageid",
        UUID(as_uuid=True),
        ForeignKey("bookpages.id", ondelete="RESTRICT"),
        nullable=False,
    )

    PageRevisionId = Column(
        "pagerevisionid",
        UUID(as_uuid=True),
        ForeignKey("pagerevisions.id", ondelete="RESTRICT"),
        nullable=False,
    )

    Transcript = Column("transcript", Text, nullable=False)

    Distance = Column("distance", Integer, nullable=False)

    Alignment = Column("alignment", JSONB, nullable=False)

    Summary = Column("summary", JSONB, nullable=False)

    CreatedAt = Column(
        "createdat",
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    __table_args__ = (
        Index("ix_readingcomparisonreports_sessionid", "sessionid"),
        Index("ix_readingcomparisonreports_pageid", "pageid"),
    )