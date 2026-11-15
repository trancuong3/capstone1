"""Strict karaoke input contracts and explicitly whitelisted public responses."""
import unicodedata
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator, model_validator

MAX_AUDIO_BYTES = 20 * 1024 * 1024
MAX_COVER_BYTES = 2 * 1024 * 1024
MAX_DURATION_MS = 300_000


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


def clean_text(value: str) -> str:
    value = unicodedata.normalize("NFC", value).strip()
    if any(unicodedata.category(char) == "Cc" for char in value):
        raise ValueError("Control characters are not supported")
    return value


class LyricLine(Contract):
    id: UUID
    text: str = Field(min_length=1, max_length=300)
    start_ms: StrictInt | None = Field(default=None, ge=0, le=MAX_DURATION_MS)
    end_ms: StrictInt | None = Field(default=None, ge=0, le=MAX_DURATION_MS)

    @field_validator("text")
    @classmethod
    def text_not_blank(cls, value):
        value = clean_text(value)
        if not value:
            raise ValueError("Lyric text is required")
        return value


class Lyrics(Contract):
    format_version: Literal[1] = 1
    lines: list[LyricLine] = Field(default_factory=list, max_length=300)

    @field_validator("format_version", mode="before")
    @classmethod
    def exact_version(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError("Unsupported lyric format version")
        return value

    @model_validator(mode="after")
    def unique_and_bounded(self):
        if len({line.id for line in self.lines}) != len(self.lines):
            raise ValueError("Duplicate lyric line ID")
        if sum(len(line.text) for line in self.lines) > 50_000:
            raise ValueError("Lyrics are too long")
        return self


class Metadata(Contract):
    title: str = Field(default="", max_length=200)
    author: str = Field(default="", max_length=200)
    min_grade: StrictInt = Field(default=1, ge=1, le=5)
    max_grade: StrictInt = Field(default=5, ge=1, le=5)
    source_note: str = Field(default="", max_length=1000)
    usage_note: str = Field(default="", max_length=1000)

    @field_validator("title", "author", "source_note", "usage_note")
    @classmethod
    def normalize(cls, value):
        return clean_text(value)

    @model_validator(mode="after")
    def grade_range(self):
        if self.min_grade > self.max_grade:
            raise ValueError("Invalid grade range")
        return self


class SongCreate(Metadata):
    pass


class RevisionRequest(Contract):
    expected_revision: StrictInt = Field(ge=1)


class DraftRequest(RevisionRequest):
    draft_version_id: UUID


class DraftWrite(Metadata, DraftRequest):
    lyrics: Lyrics = Field(default_factory=Lyrics)


class VisibilityRequest(RevisionRequest):
    visible: StrictBool


class VersionRead(Metadata):
    id: UUID
    version_no: int
    state: Literal["DRAFT", "PUBLISHED", "SUPERSEDED"]
    has_audio: bool
    has_cover: bool
    duration_ms: int | None
    audio_size_bytes: int | None
    lyrics: Lyrics
    created_at: datetime
    updated_at: datetime
    published_at: datetime | None


class AdminDetail(Contract):
    song_id: UUID
    status: Literal["DRAFT", "PUBLISHED", "HIDDEN"]
    revision: int
    draft: VersionRead | None
    published: VersionRead | None
    created_at: datetime
    updated_at: datetime


class AdminSongSummary(Contract):
    song_id: UUID
    status: Literal["DRAFT", "PUBLISHED", "HIDDEN"]
    revision: int
    title: str
    author: str
    min_grade: int
    max_grade: int
    duration_ms: int | None
    draft_version_id: UUID | None
    published_version_id: UUID | None
    has_audio: bool
    has_cover: bool
    created_at: datetime
    updated_at: datetime


class AdminList(Contract):
    items: list[AdminSongSummary]
    total: int
    limit: int
    offset: int


IssueCode = Literal[
    "TITLE_REQUIRED", "SOURCE_REQUIRED", "USAGE_REQUIRED", "AUDIO_REQUIRED",
    "LYRICS_REQUIRED", "TIMING_REQUIRED", "TIMING_INVALID", "TIMING_OVERLAP",
    "TIMING_OUT_OF_RANGE", "TIMING_AUDIO_MISMATCH", "MEDIA_UNAVAILABLE",
    "CONTENT_INVALID",
]


class ValidationIssue(Contract):
    code: IssueCode
    field: str
    line_id: UUID | None = None


class ValidationRead(Contract):
    valid: bool
    revision: int
    draft_version_id: UUID
    issues: list[ValidationIssue]


class SongCard(Contract):
    song_id: UUID
    version_id: UUID
    title: str
    author: str
    min_grade: int
    max_grade: int
    duration_ms: int
    cover_url: str | None


class SongList(Contract):
    items: list[SongCard]
    total: int
    limit: int
    offset: int


class DraftPreview(Contract):
    song_id: UUID
    version_id: UUID
    revision: int
    title: str
    author: str
    duration_ms: int
    audio_url: str
    audio_url_expires_at: datetime
    cover_url: str | None
    lyrics: Lyrics


class TimedLine(LyricLine):
    start_ms: StrictInt = Field(ge=0, le=MAX_DURATION_MS)
    end_ms: StrictInt = Field(ge=0, le=MAX_DURATION_MS)


class TimedLyrics(Lyrics):
    lines: list[TimedLine] = Field(min_length=1, max_length=300)


class Playback(Contract):
    song_id: UUID
    version_id: UUID
    title: str
    author: str
    duration_ms: int
    audio_url: str
    audio_url_expires_at: datetime
    cover_url: str | None
    lyrics: TimedLyrics
