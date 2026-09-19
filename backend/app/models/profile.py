# file: backend/app/models/profile.py
from sqlalchemy import Column, String, SmallInteger, ForeignKey, DateTime, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database.session import Base

class Profile(Base):
    __tablename__ = "profiles" # Sửa thành chữ thường khớp 100% với Supabase

    # Cấu trúc: TênBiếnPython = Column("tên_cột_dưới_db", KiểuDữLiệu, ...)
    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    Role = Column("role", String, nullable=False)
    DisplayName = Column("displayname", String)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)
    
    children = relationship("ChildProfile", back_populates="parent", cascade="all, delete-orphan")


class ChildProfile(Base):
    __tablename__ = "childprofiles" # Khớp với bảng childprofiles trên DB

    Id = Column("id", UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    # Chú ý khóa ngoại cũng phải trỏ đến đúng bảng viết thường "profiles.id"
    ParentId = Column("parentid", UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False)
    Alias = Column("alias", String, nullable=False)
    Grade = Column("grade", SmallInteger, nullable=False)
    Settings = Column("settings", JSONB, server_default=text("'{}'::jsonb"), nullable=False)
    CreatedAt = Column("createdat", DateTime(timezone=True), server_default=func.now(), nullable=False)
    
    parent = relationship("Profile", back_populates="children")