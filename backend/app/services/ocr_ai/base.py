from __future__ import annotations

from typing import Protocol

from app.services.admin_ocr_chunking import OcrTextChunk
from app.services.ocr_ai.schemas import ChunkCorrectionResult


class OcrCorrectionProvider(Protocol):
    """A provider can correct exactly one crop and may never write data."""

    name: str
    family: str

    async def correct_chunk(
        self,
        *,
        chunk: OcrTextChunk,
        image_bytes: bytes,
        image_mime_type: str,
    ) -> ChunkCorrectionResult:
        ...
