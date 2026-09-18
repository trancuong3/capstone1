from sqlalchemy import Column, String, Boolean, ForeignKey, DateTime, Date, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func
from app.database.session import Base

class ProgressReport(Base):
    __tablename__ = "ProgressReports"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ChildId = Column(UUID(as_uuid=True), ForeignKey("ChildProfiles.Id", ondelete="CASCADE"), nullable=False)
    PeriodStart = Column(Date, nullable=False)
    PeriodEnd = Column(Date, nullable=False)
    Summary = Column(JSONB, nullable=False)
    GeneratedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

class ConsentRecord(Base):
    __tablename__ = "ConsentRecords"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ParentId = Column(UUID(as_uuid=True), ForeignKey("Profiles.Id", ondelete="CASCADE"), nullable=False)
    ChildId = Column(UUID(as_uuid=True), ForeignKey("ChildProfiles.Id", ondelete="CASCADE"), nullable=False)
    Scope = Column(String, nullable=False)
    Granted = Column(Boolean, nullable=False)
    GrantedAt = Column(DateTime(timezone=True))
    RevokedAt = Column(DateTime(timezone=True))

class AuditLog(Base):
    __tablename__ = "AuditLogs"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ActorId = Column(UUID(as_uuid=True), ForeignKey("Profiles.Id"), nullable=False)
    Action = Column(String, nullable=False)
    ResourceType = Column(String, nullable=False)
    ResourceId = Column(UUID(as_uuid=True), nullable=False)
    RequestId = Column(String, nullable=False)
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    Metadata = Column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)