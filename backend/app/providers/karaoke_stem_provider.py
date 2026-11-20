"""Server-owned local stem artifacts, never arbitrary remote URLs."""
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class StemArtifacts:
    vocal: Path
    instrumental: Path
    model_version: str
    timeline_offset_ms: int
    duration_ms: int
    diagnostics: dict


class StemProvider(Protocol):
    async def separate(self, audio: Path, workspace: Path, cancel) -> StemArtifacts: ...
