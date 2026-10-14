# file: backend/app/models/profile.py
from sqlalchemy import Column, String, SmallInteger, ForeignKey, DateTime, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database.session import Base


class Profile(Base):
    __tablename__ = "profiles"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    Role = Column("role", String, nullable=False)
    DisplayName = Column("displayname", String)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)
    Active = Column("active", SmallInteger, nullable=False, server_default=text("1"))

    children = relationship("ChildProfile", back_populates="parent", cascade="all, delete-orphan")


class ChildProfile(Base):
    __tablename__ = "childprofiles"

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    ParentId = Column("parentid", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    Alias = Column("alias", String, nullable=False)
    Grade = Column("grade", SmallInteger, nullable=False)
    Settings = Column("settings", JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)

    parent = relationship("Profile", back_populates="children")
