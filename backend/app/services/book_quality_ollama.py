from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig

logger = logging.getLogger(__name__)


class OllamaTextFinding(BaseModel):
    model_config = ConfigDict(extra="forbid")
    excerpt: str = Field(min_length=1, max_length=300)
    issue_type: Literal[
        "SPELLING_SUSPECTED",
        "OCR_SUSPECTED",
        "PUNCTUATION_SUSPECTED",
        "SENTENCE_ANOMALY",
    ]
    severity: Literal["LOW", "MEDIUM", "HIGH"]
    explanation: str = Field(min_length=1, max_length=1000)
    suggested_correction: str | None = Field(default=None, max_length=500)
    confidence: float | None = Field(default=None, ge=0, le=1)


class OllamaTextResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    findings: list[OllamaTextFinding] = Field(max_length=20)


@dataclass(frozen=True)
class OllamaFindingEvidence:
    issue_type: str
    severity: str
    excerpt: str
    excerpt_start: int
    excerpt_end: int
    explanation: str
    suggested_correction: str | None
    confidence: float | None
    model_name: str


@dataclass(frozen=True)
class OllamaAnalysisResult:
    findings: tuple[OllamaFindingEvidence, ...]
    model_name: str
    rejected_excerpt_count: int


def _text_chunks(
    value: str,
    *,
    maximum: int,
    overlap: int,
    max_bytes: int = 3072,
    max_words: int = 512,
) -> list[tuple[int, int]]:
    """Chunk source text while enforcing UTF-8 byte and word limits."""
    if not value:
        return []
    if maximum <= overlap or overlap < 0 or max_bytes < 1 or max_words < 1:
        raise ValueError("Invalid local AI text chunking configuration")
    chunks: list[tuple[int, int]] = []
    start = 0
    while start < len(value):
        end = min(len(value), start + maximum)
        if end < len(value):
            lower = start + maximum // 2
            boundaries = [
                value.rfind("\\n", lower, end),
                value.rfind("。", lower, end),
                value.rfind(".", lower, end),
                value.rfind("!", lower, end),
                value.rfind("?", lower, end),
            ]
            boundary = max(boundaries)
            if boundary > start:
                end = boundary + 1
        while (
            end > start
            and (
                len(value[start:end].encode("utf-8")) > max_bytes
                or len(value[start:end].split()) > max_words
            )
        ):
            whitespace = max(
                value.rfind(" ", start + 1, end),
                value.rfind("\\n", start + 1, end),
                value.rfind("\\t", start + 1, end),
            )
            end = whitespace if whitespace > start else end - 1
        if end <= start:
            raise ValueError("Configured chunk limits cannot advance through the source")
        if len(value[start:end].encode("utf-8")) > max_bytes:
            raise ValueError("Text chunk exceeds the configured byte ceiling")
        chunks.append((start, end))
        if end >= len(value):
            break
        next_start = max(start + 1, end - overlap)
        search_end = min(end, next_start + overlap)
        boundaries = [
            value.find(" ", next_start, search_end),
            value.find("\\n", next_start, search_end),
        ]
        valid_boundaries = [item for item in boundaries if item >= 0]
        if valid_boundaries:
            next_start = min(valid_boundaries) + 1
        if next_start <= start:
            raise ValueError("Text chunker did not advance")
        start = next_start
    return chunks


def _json_schema() -> dict[str, object]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["findings"],
        "properties": {
            "findings": {
                "type": "array",
                "maxItems": 20,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["excerpt", "issue_type", "severity", "explanation"],
                    "properties": {
                        "excerpt": {"type": "string", "minLength": 1, "maxLength": 300},
                        "issue_type": {
                            "type": "string",
                            "enum": [
                                "SPELLING_SUSPECTED",
                                "OCR_SUSPECTED",
                                "PUNCTUATION_SUSPECTED",
                                "SENTENCE_ANOMALY",
                            ],
                        },
                        "severity": {
                            "type": "string",
                            "enum": ["LOW", "MEDIUM", "HIGH"],
                        },
                        "explanation": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 1000,
                        },
                        "suggested_correction": {
                            "type": ["string", "null"],
                            "maxLength": 500,
                        },
                        "confidence": {
                            "type": ["number", "null"],
                            "minimum": 0,
                            "maximum": 1,
                        },
                    },
                },
            },
        },
    }


def _prompt(chunk: str, page_number: int) -> str:
    return (
        "Bạn là công cụ rà soát chất lượng văn bản tiếng Việt của sách thiếu nhi. "
        "Chỉ đưa ra cảnh báo để con người xem xét, tuyệt đối không viết lại toàn đoạn. "
        "Không đánh dấu tên riêng, tên nhân vật, phương ngữ, từ tượng thanh, lời thoại "
        "hoặc cách diễn đạt nghệ thuật chỉ vì chúng hiếm gặp. Không suy đoán từ bị thiếu "
        "nếu không có bằng chứng trong đoạn. Hãy tìm dấu hiệu chính tả, OCR, dấu câu "
        "hoặc cấu trúc câu bất thường có thể chỉ ra cụ thể bằng một trích đoạn liên tục. "
        "Mọi excerpt phải được sao chép nguyên văn, liên tục và chính xác từ SOURCE TEXT; "
        "không dùng dấu ba chấm và không diễn giải excerpt. Nếu không chắc, bỏ qua. "
        "Không được tự động sửa VerifiedText. Trả duy nhất JSON phù hợp schema, tối đa "
        "20 findings. Đây là phân tích văn bản, KHÔNG phải kiểm tra ảnh trang sách. "
        f"PAGE NUMBER: {page_number}\\nSOURCE TEXT:\\n{chunk}"
    )


def _unique_excerpt_position(source: str, excerpt: str) -> int | None:
    """Return an offset only when the exact excerpt has one source occurrence."""
    if not excerpt:
        return None
    first = source.find(excerpt)
    if first < 0 or source.find(excerpt, first + 1) >= 0:
        return None
    return first


def _decode_model_response(payload: object) -> OllamaTextResponse:
    if not isinstance(payload, dict):
        raise LocalCorrectionError(502, "Ollama trả về dữ liệu không đúng cấu trúc.")
    message = payload.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise LocalCorrectionError(502, "Ollama trả về phản hồi rỗng hoặc không hợp lệ.")
    try:
        return OllamaTextResponse.model_validate(json.loads(content))
    except (json.JSONDecodeError, ValidationError) as error:
        raise LocalCorrectionError(502, "Ollama trả về JSON không đúng schema.") from error


async def analyse_with_ollama(
    value: str,
    page_number: int,
) -> OllamaAnalysisResult:
    """Text-only review. It never inspects a page image or edits published content."""
    config = LocalOcrConfig.from_environment()
    if len(value.encode("utf-8")) > config.chunking.max_document_bytes:
        raise LocalCorrectionError(
            422, "Văn bản trang vượt giới hạn rà soát AI cục bộ."
        )
    maximum_chars = max(64, min(700, config.chunking.max_bytes // 4))
    overlap_chars = min(40, maximum_chars // 6)
    try:
        ranges = _text_chunks(
            value,
            maximum=maximum_chars,
            overlap=overlap_chars,
            max_bytes=config.chunking.max_bytes,
            max_words=config.chunking.max_words,
        )
        if len(ranges) > config.chunking.max_chunks:
            raise ValueError("Text exceeds the configured local AI chunk count.")
    except ValueError as error:
        raise LocalCorrectionError(500, "Cấu hình chia đoạn AI cục bộ không hợp lệ.") from error
    if not ranges:
        return OllamaAnalysisResult((), config.model, 0)

    timeout = httpx.Timeout(
        config.timeout_seconds,
        connect=min(10.0, float(config.timeout_seconds)),
    )
    findings: dict[tuple[int, int, str], OllamaFindingEvidence] = {}
    rejected = 0
    try:
        async with asyncio.timeout(config.total_timeout_seconds):
            async with httpx.AsyncClient(timeout=timeout) as client:
                for start, end in ranges:
                    chunk = value[start:end]
                    response = await client.post(
                        f"{config.base_url}/api/chat",
                        json={
                            "model": config.model,
                            "stream": False,
                            "format": _json_schema(),
                            "messages": [
                                {
                                    "role": "system",
                                    "content": "Return valid JSON only. Preserve source evidence exactly.",
                                },
                                {
                                    "role": "user",
                                    "content": _prompt(chunk, page_number),
                                },
                            ],
                            "options": {
                                "temperature": 0,
                                "num_ctx": config.num_ctx,
                                "num_predict": min(config.num_predict, 1024),
                            },
                        },
                    )
                    if response.status_code == 404:
                        raise LocalCorrectionError(
                            503,
                            "Model Ollama chưa được cài đặt hoặc không khả dụng.",
                        )
                    response.raise_for_status()
                    try:
                        payload = response.json()
                    except ValueError as error:
                        raise LocalCorrectionError(
                            502, "Ollama trả về dữ liệu không phải JSON."
                        ) from error
                    parsed = _decode_model_response(payload)
                    for item in parsed.findings:
                        position = _unique_excerpt_position(chunk, item.excerpt)
                        if position is None:
                            # Without an unambiguous source occurrence, do not
                            # guess which repeated phrase the model intended.
                            rejected += 1
                            continue
                        absolute_start = start + position
                        absolute_end = absolute_start + len(item.excerpt)
                        key = (absolute_start, absolute_end, item.issue_type)
                        if key in findings:
                            continue
                        findings[key] = OllamaFindingEvidence(
                            issue_type=item.issue_type,
                            severity=item.severity,
                            excerpt=item.excerpt,
                            excerpt_start=absolute_start,
                            excerpt_end=absolute_end,
                            explanation=item.explanation,
                            suggested_correction=item.suggested_correction,
                            confidence=item.confidence,
                            model_name=config.model,
                        )
    except LocalCorrectionError:
        raise
    except TimeoutError as error:
        raise LocalCorrectionError(
            503, "Ollama rà soát toàn bộ văn bản đã hết thời gian chờ."
        ) from error
    except httpx.TimeoutException as error:
        raise LocalCorrectionError(
            503, "Ollama rà soát nội dung đã hết thời gian chờ."
        ) from error
    except httpx.HTTPStatusError as error:
        logger.warning(
            "Ollama content review returned HTTP %s",
            error.response.status_code,
        )
        raise LocalCorrectionError(
            503, "Ollama không thể xử lý yêu cầu rà soát nội dung."
        ) from error
    except httpx.RequestError as error:
        raise LocalCorrectionError(
            503, "Không thể kết nối Ollama để rà soát nội dung."
        ) from error

    return OllamaAnalysisResult(
        findings=tuple(
            sorted(
                findings.values(),
                key=lambda item: (
                    item.excerpt_start,
                    item.excerpt_end,
                    item.issue_type,
                ),
            )
        ),
        model_name=config.model,
        rejected_excerpt_count=rejected,
    )
