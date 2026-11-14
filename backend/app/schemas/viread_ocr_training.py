from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

HexSha256 = str


def _valid_sha(value: str) -> str:
    normalized = value.lower()
    if len(normalized) != 64 or any(char not in "0123456789abcdef" for char in normalized):
        raise ValueError("Expected a 64-character SHA-256 digest")
    return normalized


class TrainingRunCreate(BaseModel):
    profile: Literal[
        "FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED",
        # Legacy names remain accepted during rolling deployment and old-run resume.
        "FLOW1_VERIFIED", "FLOW2_EXTERNAL_TRDG",
    ]
    dataset_version_id: UUID
    parent_checkpoint_sha256: HexSha256
    manifest_sha256: HexSha256
    config_sha256: HexSha256
    architecture_sha256: HexSha256
    vocabulary_sha256: HexSha256

    @field_validator("parent_checkpoint_sha256", "manifest_sha256", "config_sha256", "architecture_sha256", "vocabulary_sha256")
    @classmethod
    def hashes_are_valid(cls, value: str) -> str:
        return _valid_sha(value)


class TrainingRunRead(BaseModel):
    run_id: UUID
    status: str
    profile: str
    parent_checkpoint_sha256: str
    manifest_sha256: str
    config_sha256: str
    architecture_sha256: str
    vocabulary_sha256: str


class TrainingRunComplete(BaseModel):
    profile: Literal[
        "FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED",
        "FLOW1_VERIFIED", "FLOW2_EXTERNAL_TRDG",
    ]
    parent_checkpoint_sha256: HexSha256
    manifest_sha256: HexSha256
    config_sha256: HexSha256
    architecture_sha256: HexSha256
    vocabulary_sha256: HexSha256
    checkpoint_sha256: HexSha256
    checkpoint_bytes: int = Field(gt=0)
    step: int = Field(gt=0)

    @field_validator("parent_checkpoint_sha256", "manifest_sha256", "config_sha256", "architecture_sha256", "vocabulary_sha256", "checkpoint_sha256")
    @classmethod
    def checkpoint_hash_valid(cls, value: str) -> str:
        return _valid_sha(value)


class BenchmarkOutput(BaseModel):
    sample_id: str = Field(min_length=1, max_length=160)
    group_id: str = Field(min_length=1, max_length=160)
    original: str = Field(max_length=5000)
    candidate: str = Field(max_length=5000)


class BenchmarkCreate(BaseModel):
    run_id: UUID
    locked_test_version_id: UUID
    locked_test_manifest_sha256: HexSha256
    outputs: list[BenchmarkOutput] = Field(min_length=1, max_length=10000)

    @field_validator("locked_test_manifest_sha256")
    @classmethod
    def locked_hash_valid(cls, value: str) -> str:
        return _valid_sha(value)


class DatasetSampleInput(BaseModel):
    source_flow: Literal["FLOW2_EXTERNAL", "FLOW2_TRDG", "LOCKED_TEST"] | None = None
    sample_id: str = Field(min_length=1, max_length=160)
    group_id: str = Field(min_length=1, max_length=160)
    split: Literal["train", "validation", "holdout", "locked_test"]
    image_storage_path: str = Field(min_length=1, max_length=1024)
    image_sha256: HexSha256
    label: str = Field(min_length=1, max_length=5000)
    verified: bool = False
    annotation_id: str | None = Field(default=None, max_length=160)
    source_page_id: UUID | None = None
    source_revision_id: UUID | None = None
    provenance: dict[str, Any] = Field(default_factory=dict)

    @field_validator("image_sha256")
    @classmethod
    def image_hash_valid(cls, value: str) -> str:
        return _valid_sha(value)


class DatasetImport(BaseModel):
    source_flow: Literal["FLOW2_EXTERNAL", "FLOW2_TRDG", "FLOW2_EXTERNAL_TRDG", "LOCKED_TEST"]
    # Flow 1 targets up to 50k TRDG rows plus real samples in one independent manifest.
    samples: list[DatasetSampleInput] = Field(min_length=1, max_length=60000)
    split_seed: str = Field(default="viread-vietocr-v2-split-v1", min_length=1, max_length=160)
    provenance: dict[str, Any] = Field(default_factory=dict)


class ModelDecisionRequest(BaseModel):
    action: Literal["APPROVE", "ROLLBACK"]
    run_id: UUID | None = None
    benchmark_id: UUID | None = None
    reason: str = Field(min_length=8, max_length=1000)


class TrainingWorkerClaim(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")
    runtime: dict[str, Any] = Field(default_factory=dict)
    training_job_id: UUID | None = None


class TrainingWorkerStatus(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")
    status: Literal["READY", "WAITING_FOR_GPU", "WAITING_FOR_RESOURCES"]
    reason_code: str | None = Field(default=None, max_length=64, pattern=r"^[A-Z0-9_]+$")
    runtime: dict[str, Any] = Field(default_factory=dict)


class TrainingWorkerHeartbeat(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")
    stage: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")
    completed_steps: int = Field(default=0, ge=0)
    total_steps: int = Field(default=0, ge=0)
    runtime: dict[str, Any] = Field(default_factory=dict)


class TrainingWorkerFinish(BaseModel):
    worker_id: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")
    run_id: UUID | None = None
    status: Literal["CANDIDATE", "BENCHMARKED", "QUALITY_GATE_REJECTED", "FAILED"]
    error_code: str | None = Field(default=None, max_length=64, pattern=r"^[A-Z0-9_]+$")
    runtime: dict[str, Any] = Field(default_factory=dict)
