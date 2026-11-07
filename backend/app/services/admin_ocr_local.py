from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import math
import os
import re
from dataclasses import dataclass, field
from io import BytesIO
from typing import Callable
from urllib.parse import urlsplit

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

from app.services.admin_ocr_chunking import (
    ChunkingConfig,
    ChunkingError,
    OcrTextChunk,
    chunk_ocr_text,
    reconstruct_ocr_text,
)


DEFAULT_MODEL = "qwen3-vl:4b-instruct-q4_K_M"
_MAX_IMAGE_BYTES = 12 * 1024 * 1024
_MAX_IMAGE_SIDE = 6000
_MAX_IMAGE_PIXELS = 36_000_000
_MAX_CROP_SIDE = 2048
_MAX_CROP_BYTES = 4 * 1024 * 1024


class LocalCorrectionError(RuntimeError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class LocalOcrConfig:
    base_url: str = "http://127.0.0.1:11434"
    model: str = DEFAULT_MODEL
    timeout_seconds: int = 180
    total_timeout_seconds: int = 7200
    num_ctx: int = 4096
    num_predict: int = 1024
    chunking: ChunkingConfig = field(default_factory=ChunkingConfig)

    @classmethod
    def from_environment(cls) -> "LocalOcrConfig":
        base_url = _validate_loopback_url(
            os.getenv("LOCAL_OCR_BASE_URL", "http://127.0.0.1:11434")
        )
        model = os.getenv("LOCAL_OCR_MODEL", DEFAULT_MODEL).strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}", model):
            raise LocalCorrectionError(500, "Cấu hình AI OCR cục bộ không hợp lệ.")
        try:
            chunking = ChunkingConfig.from_environment()
        except ChunkingError as exc:
            raise LocalCorrectionError(
                500, "Cấu hình AI OCR cục bộ chưa hợp lệ."
            ) from exc
        return cls(
            base_url=base_url,
            model=model,
            timeout_seconds=_read_int("LOCAL_OCR_TIMEOUT_SECONDS", 180, 1, 180),
            total_timeout_seconds=_read_int(
                "LOCAL_OCR_TOTAL_TIMEOUT_SECONDS", 7200, 1, 14400
            ),
            num_ctx=_read_int("LOCAL_OCR_NUM_CTX", 4096, 2048, 32768),
            num_predict=_read_int("LOCAL_OCR_NUM_PREDICT", 1024, 256, 8192),
            chunking=chunking,
        )


def _read_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise LocalCorrectionError(500, "Cấu hình AI OCR cục bộ không hợp lệ.") from exc
    if not minimum <= value <= maximum:
        raise LocalCorrectionError(500, "Cấu hình AI OCR cục bộ không hợp lệ.")
    return value


def _validate_loopback_url(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
        host = parsed.hostname
        port = parsed.port or 80
        loopback = ipaddress.ip_address(host).is_loopback if host else False
    except (ValueError, TypeError):
        loopback, parsed, port = False, None, 0
    if (
        parsed is None
        or parsed.scheme != "http"
        or not loopback
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise LocalCorrectionError(500, "AI OCR chỉ chấp nhận địa chỉ HTTP loopback trên máy chủ.")
    return value.strip().rstrip("/")


@dataclass(frozen=True)
class PreparedOcrImage:
    image: Image.Image


def _prepare_source_image(image_bytes: bytes) -> PreparedOcrImage:
    if not image_bytes or len(image_bytes) > _MAX_IMAGE_BYTES:
        raise LocalCorrectionError(502, "Ảnh nguồn vượt giới hạn hoặc không khả dụng cho AI OCR cục bộ.")
    try:
        with Image.open(BytesIO(image_bytes)) as opened:
            oriented = ImageOps.exif_transpose(opened)
            oriented.load()
            if (
                oriented.width < 1
                or oriented.height < 1
                or oriented.width > _MAX_IMAGE_SIDE
                or oriented.height > _MAX_IMAGE_SIDE
                or oriented.width * oriented.height > _MAX_IMAGE_PIXELS
            ):
                raise LocalCorrectionError(502, "Kích thước ảnh nguồn vượt giới hạn xử lý an toàn.")
            return PreparedOcrImage(oriented.convert("RGB"))
    except LocalCorrectionError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise LocalCorrectionError(502, "Không thể đọc ảnh nguồn để đối chiếu OCR cục bộ.") from exc


def _crop_chunk_image(
    prepared: PreparedOcrImage,
    boxes: list[tuple[float, float, float, float]],
) -> bytes:
    if not boxes:
        raise LocalCorrectionError(422, "Không có vùng OCR để đối chiếu.")
    width, height = prepared.image.size
    left, top, right, bottom = width, height, 0, 0
    heights: list[int] = []
    for x, y, box_width, box_height in boxes:
        left = min(left, math.floor(x * width))
        top = min(top, math.floor(y * height))
        right = max(right, math.ceil((x + box_width) * width))
        bottom = max(bottom, math.ceil((y + box_height) * height))
        heights.append(max(1, round(box_height * height)))
    padding = max(8, round(sorted(heights)[len(heights) // 2] * 0.7))
    crop = prepared.image.crop(
        (max(0, left - padding), max(0, top - padding),
         min(width, right + padding), min(height, bottom + padding))
    )
    crop.thumbnail((_MAX_CROP_SIDE, _MAX_CROP_SIDE), Image.Resampling.LANCZOS)
    output = BytesIO()
    crop.save(output, format="JPEG", quality=88, optimize=True)
    result = output.getvalue()
    if not result or len(result) > _MAX_CROP_BYTES:
        raise LocalCorrectionError(502, "Ảnh crop vượt giới hạn xử lý cho AI OCR cục bộ.")
    return result


def _response_schema(word_count: int) -> dict[str, object]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["chunk_id", "corrected_words"],
        "properties": {
            "chunk_id": {"type": "integer"},
            "corrected_words": {
                "type": "array", "minItems": word_count, "maxItems": word_count,
                "items": {"type": "string", "minLength": 1, "maxLength": 500},
            },
        },
    }


def _prompt(chunk: OcrTextChunk) -> str:
    source_words = [{"index": token.index, "text": token.text} for token in chunk.tokens]
    return (
        "Bạn là bộ sửa lỗi OCR tiếng Việt. Dùng ảnh vùng trang và ngữ cảnh để "
        "sửa lỗi nhận dạng từ hoặc dấu thanh. Không diễn đạt lại, không thêm, "
        "bỏ hay đổi thứ tự từ. Giữ nguyên dấu câu của từng từ. Chỉ sửa token "
        "khi ảnh và ngữ cảnh cho bằng chứng rõ ràng; nếu không chắc, giữ nguyên. "
        "Trả đúng JSON theo schema: corrected_words phải có đúng một token "
        "cho mỗi token nguồn, giữ đúng thứ tự ban đầu; không thêm, bỏ hoặc "
        "đổi thứ tự từ. Mỗi phần tử là một token không có khoảng trắng. "
        "Chỉ sửa chữ; backend sẽ giữ nguyên dấu câu gốc.\n"
        f"CHUNK_ID: {chunk.chunk_id}\n"
        f"PREVIOUS CONTEXT (read-only):\n{chunk.previous_context}\n"
        f"TARGET TEXT:\n{chunk.target_text}\n"
        f"NEXT CONTEXT (read-only):\n{chunk.next_context}\n"
        "SOURCE WORDS JSON:\n"
        f"{json.dumps(source_words, ensure_ascii=False, separators=(',', ':'))}"
    )


def _decode_chunk_response(payload: object, chunk: OcrTextChunk) -> tuple[str, ...]:
    try:
        if not isinstance(payload, dict) or "error" in payload:
            raise ValueError("provider response is not an object")
        message = payload.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise ValueError("provider returned no structured content")
        result = json.loads(content)
        if (
            not isinstance(result, dict)
            or set(result) != {"chunk_id", "corrected_words"}
            or isinstance(result["chunk_id"], bool)
            or result["chunk_id"] != chunk.chunk_id
            or not isinstance(result["corrected_words"], list)
            or len(result["corrected_words"]) != chunk.expected_word_count
        ):
            raise ValueError("provider returned an incomplete chunk")
        corrected: list[str] = []
        for item in result["corrected_words"]:
            if (
                not isinstance(item, str)
                or not item
                or len(item) > 500
                or any(character.isspace() for character in item)
            ):
                raise ValueError("provider returned a malformed word")
            corrected.append(item)
        return tuple(corrected)
    except (KeyError, TypeError, ValueError) as exc:
        raise LocalCorrectionError(
            502,
            "Model OCR cục bộ trả kết quả không đầy đủ hoặc sai cấu trúc; nội dung hiện tại được giữ nguyên.",
        ) from exc


class LocalOcrCorrector:
    def __init__(
        self, config: LocalOcrConfig, *,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.config = config
        self.transport = transport

    async def correct(
        self,
        text: str,
        image_bytes: bytes,
        word_boxes: list[tuple[float, float, float, float]],
        *,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> str:
        try:
            plan = chunk_ocr_text(text, self.config.chunking)
        except ChunkingError as exc:
            raise LocalCorrectionError(422, str(exc)) from exc
        if len(word_boxes) != len(plan.tokens):
            raise LocalCorrectionError(422, "Số lượng từ và vùng OCR không khớp; văn bản hiện tại được giữ nguyên.")
        prepared = await asyncio.to_thread(_prepare_source_image, image_bytes)

        async def run_chunks() -> str:
            corrected_by_chunk: dict[int, tuple[str, ...]] = {}
            async with httpx.AsyncClient(
                base_url=self.config.base_url + "/",
                timeout=httpx.Timeout(self.config.timeout_seconds),
                trust_env=False,
                follow_redirects=False,
                transport=self.transport,
            ) as client:
                for chunk in plan.chunks:
                    crop = await asyncio.to_thread(
                        _crop_chunk_image, prepared,
                        word_boxes[chunk.start_token_index:chunk.end_token_index],
                    )
                    request_payload = {
                        "model": self.config.model,
                        "stream": False,
                        "format": _response_schema(chunk.expected_word_count),
                        "messages": [{
                            "role": "user",
                            "content": _prompt(chunk),
                            "images": [base64.b64encode(crop).decode("ascii")],
                        }],
                        "options": {
                            "temperature": 0,
                            "num_ctx": self.config.num_ctx,
                            "num_predict": min(
                                self.config.num_predict,
                                max(256, 128 + chunk.expected_word_count * 16),
                            ),
                        },
                    }
                    try:
                        response = await client.post("api/chat", json=request_payload)
                    except httpx.TimeoutException as exc:
                        raise LocalCorrectionError(504, "AI OCR cục bộ hết thời gian xử lý; văn bản hiện tại được giữ nguyên.") from exc
                    except httpx.RequestError as exc:
                        raise LocalCorrectionError(503, "Không thể kết nối Ollama trên máy này; văn bản hiện tại được giữ nguyên.") from exc
                    if response.status_code != 200:
                        raise LocalCorrectionError(
                            503 if response.status_code in (400, 404) else 502,
                            "Ollama hoặc model OCR cục bộ chưa sẵn sàng; văn bản hiện tại được giữ nguyên.",
                        )
                    try:
                        payload = response.json()
                    except ValueError as exc:
                        raise LocalCorrectionError(502, "Ollama trả dữ liệu không hợp lệ; văn bản hiện tại được giữ nguyên.") from exc
                    corrected_by_chunk[chunk.chunk_id] = _decode_chunk_response(payload, chunk)
                    if on_progress is not None:
                        on_progress(len(corrected_by_chunk), len(plan.chunks))
            try:
                return reconstruct_ocr_text(plan, corrected_by_chunk)
            except ChunkingError as exc:
                raise LocalCorrectionError(502, "Kết quả OCR cục bộ không vượt qua kiểm tra an toàn; văn bản hiện tại được giữ nguyên.") from exc

        try:
            return await asyncio.wait_for(run_chunks(), timeout=self.config.total_timeout_seconds)
        except asyncio.TimeoutError as exc:
            raise LocalCorrectionError(504, "AI OCR cục bộ vượt quá thời gian xử lý tối đa; văn bản hiện tại được giữ nguyên.") from exc

    @classmethod
    async def probe(cls, config: LocalOcrConfig | None = None) -> tuple[str, str]:
        try:
            config = config or LocalOcrConfig.from_environment()
        except LocalCorrectionError:
            return "UNAVAILABLE", "Cấu hình AI OCR cục bộ chưa hợp lệ."
        try:
            async with httpx.AsyncClient(
                base_url=config.base_url + "/",
                timeout=httpx.Timeout(3.0),
                trust_env=False,
                follow_redirects=False,
            ) as client:
                response = await client.get("api/tags")
            if response.status_code != 200:
                return "UNAVAILABLE", "Ollama cục bộ chưa phản hồi."
            payload = response.json()
            models = payload.get("models") if isinstance(payload, dict) else None
            names = {
                item.get("name") for item in models
                if isinstance(item, dict) and isinstance(item.get("name"), str)
            } if isinstance(models, list) else set()
            if config.model not in names and config.model + ":latest" not in names:
                return (
                    "UNAVAILABLE",
                    f"Model AI OCR cục bộ chưa được cài đặt: {config.model}.",
                )
            return (
                "HEALTHY",
                f"Ollama và model AI OCR cục bộ đã sẵn sàng: {config.model}.",
            )
        except (httpx.HTTPError, ValueError, TypeError):
            return "UNAVAILABLE", "Không thể kết nối tới Ollama cục bộ."
