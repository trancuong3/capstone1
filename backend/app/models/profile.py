from sqlalchemy import Column, String, SmallInteger, ForeignKey, DateTime, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database.session import Base

class Profile(Base):
    __tablename__ = "Profiles"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    Role = Column(String, nullable=False)
    DisplayName = Column(String)
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    
    children = relationship("ChildProfile", back_populates="parent", cascade="all, delete-orphan")

class ChildProfile(Base):
    __tablename__ = "ChildProfiles"
    Id = Column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ParentId = Column(UUID(as_uuid=True), ForeignKey("Profiles.Id", ondelete="CASCADE"), nullable=False)
    Alias = Column(String, nullable=False)
    Grade = Column(SmallInteger, nullable=False)
    Settings = Column(JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    CreatedAt = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    
    parent = relationship("Profile", back_populates="children")