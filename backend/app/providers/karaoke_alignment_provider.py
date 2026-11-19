"""Bounded, backend-light contracts for a singing aligner (not speech STT)."""
from typing import Literal, Protocol
from pydantic import BaseModel, ConfigDict, Field, StrictInt


class UnitEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    index: StrictInt = Field(ge=0, le=9999)
    unit_count: StrictInt = Field(default=1, ge=1, le=150)
    text: str = Field(min_length=1, max_length=300)
    start_ms: StrictInt | None = Field(default=None, ge=0, le=300000)
    end_ms: StrictInt | None = Field(default=None, ge=0, le=300000)
    acoustic_support: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    end_evidence: Literal["silence_boundary", "energy_valley", "ctc_delimiter", "unsupported"] = "unsupported"


class AlignmentEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    units: list[UnitEvidence] = Field(max_length=10000)
    recognized_text: str = Field(max_length=50000)
    model_revision: str = Field(min_length=1, max_length=160)
    boundary_version: str = Field(default="envelope-v1", min_length=1, max_length=80)
    duration_ms: StrictInt = Field(ge=1, le=300000)
    frames: StrictInt = Field(ge=1, le=15001)


class AlignmentProvider(Protocol):
    async def align(self, audio, texts, workspace, cancel) -> AlignmentEvidence: ...
