from sqlalchemy import Column, String, ForeignKey, DateTime, Date, Boolean, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func
from app.database.session import Base

class ProgressReport(Base):
    __tablename__ = "progressreports"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column("childid", UUID(as_uuid=True), ForeignKey("childprofiles.id", ondelete="CASCADE"), nullable=False)
    PeriodStart = Column("periodstart", Date, nullable=False)
    PeriodEnd = Column("periodend", Date, nullable=False)
    Summary = Column("summary", JSONB, nullable=False)
    GeneratedAt = Column("generatedat", DateTime(timezone=True), server_default=func.now(), nullable=False)


class ConsentRecord(Base):
    __tablename__ = "consentrecords"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ParentId = Column("parentid", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    ChildId = Column("childid", UUID(as_uuid=True), ForeignKey("childprofiles.id", ondelete="CASCADE"), nullable=False)
    Scope = Column("scope", String, nullable=False)
    Granted = Column("granted", Boolean, nullable=False)
    GrantedAt = Column("grantedat", DateTime(timezone=True))
    RevokedAt = Column("revokedat", DateTime(timezone=True))


class AuditLog(Base):
    __tablename__ = "auditlogs"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ActorId = Column("actorid", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"))
    Action = Column("action", String, nullable=False)
    ResourceType = Column("resourcetype", String, nullable=False)
    ResourceId = Column("resourceid", UUID(as_uuid=True))
    Metadata = Column("metadata", JSONB, server_default=text("'{}'::jsonb"))
    RequestId = Column("requestid", String, nullable=False)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)