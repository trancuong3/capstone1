from __future__ import annotations

from dataclasses import dataclass

from app.services.admin_ocr_chunking import OcrTextChunk


@dataclass(frozen=True)
class ChunkCorrectionResult:
    """The only result shape that may enter OCR reconstruction."""

    chunk_id: int
    corrected_words: tuple[str, ...]
    uncertain_word_indices: tuple[int, ...]


@dataclass(frozen=True)
class OcrChunkInput:
    chunk: OcrTextChunk
    image_bytes: bytes
    image_mime_type: str
