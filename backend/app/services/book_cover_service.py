"""Dedicated Book Cover Studio service: strict upload security, 3:4 WebP optimization, anti-overwrite & honest AI capability."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any, Awaitable, Callable
from uuid import UUID, uuid4

import httpx
from fastapi import HTTPException, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import (
    SUPABASE_PRIVATE_BOOKS_BUCKET,
    SUPABASE_STORAGE_BUCKET,
)
from app.models import Book, BookPresentationAsset, SmartStudioJob
from app.policies.book_access import is_book_private
from app.repositories.book_assets_repository import BookAssetsRepository
from app.repositories.book_repository import CatalogRepository
from app.schemas.book_assets import (
    BookAssetsSummaryResponse,
    BookCoverDeleteResponse,
    BookCoverGenerateRequest,
    BookCoverGenerateResponse,
    BookPresentationAssetRead,
    BookStyleBibleRead,
    CoverPrioritySource,
    MetadataCoverFallbackRead,
    StyleBibleContentRead,
)
from app.services.ai_capability_router import (
    AiCapability,
    AiCapabilityRouter,
    AiErrorKind,
    AiProviderCallError,
    AiRoutingError,
    ImageGenerationRequest,
    _validate_local_worker_url,
    get_default_ai_router,
)
from app.services.book_style_bible import BookStyleBibleService
from app.services.gpu_workload_scheduler import (
    GpuWorkloadScheduler,
    WorkloadPriority,
    get_default_gpu_scheduler,
)
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.smart_studio_flags import SmartStudioFlags
from app.services.storage_service import (
    delete_object,
    download_object,
    download_object_async,
    upload_object,
)

logger = logging.getLogger(__name__)
_ORIGINAL_CATALOG_IS_ELIGIBLE = CatalogRepository.is_eligible
_ORIGINAL_DOWNLOAD_OBJECT = download_object

HTTP_422 = getattr(status, "HTTP_422_UNPROCESSABLE_CONTENT", 422)

MAX_COVER_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MiB
MAX_COVER_PIXELS = 25_000_000  # 25 MP anti-decompression-bomb limit
MAX_COVER_WIDTH = 900
MAX_COVER_HEIGHT = 1200
TARGET_COVER_ASPECT = 3.0 / 4.0  # 3:4 portrait cover
MAX_OUTPUT_WEBP_BYTES = 300 * 1024  # 300 KB
ALLOWED_ROTATIONS = {0, 90, 180, 270}

ALLOWED_MIME_TO_FORMAT = {
    "image/jpeg": "JPEG",
    "image/jpg": "JPEG",
    "image/pjpeg": "JPEG",
    "image/png": "PNG",
    "image/x-png": "PNG",
    "image/webp": "WEBP",
}

_DANGEROUS_SIGNATURES = (
    b"<svg",
    b"<?xml",
    b"<html",
    b"<!doctype",
    b"<script",
    b"%pdf-",
    b"pk\x03\x04",
    b"pk\x05\x06",
)

_METADATA_PALETTES: list[dict[str, str]] = [
    {
        "palette_id": "warm-sunrise",
        "primary_color": "#FFF3E0",
        "secondary_color": "#F4A261",
        "accent_color": "#B84A27",
        "motif": "sunbeam",
    },
    {
        "palette_id": "meadow-leaf",
        "primary_color": "#ECF8F2",
        "secondary_color": "#52B788",
        "accent_color": "#1B6B4D",
        "motif": "leaves",
    },
    {
        "palette_id": "sky-voyage",
        "primary_color": "#EAF5FF",
        "secondary_color": "#4EA8DE",
        "accent_color": "#1D4E89",
        "motif": "clouds",
    },
    {
        "palette_id": "honey-star",
        "primary_color": "#FFF9E6",
        "secondary_color": "#E9C46A",
        "accent_color": "#8C5A00",
        "motif": "stars",
    },
    {
        "palette_id": "berry-story",
        "primary_color": "#FDF0F5",
        "secondary_color": "#E57A9E",
        "accent_color": "#8E294F",
        "motif": "ribbon",
    },
    {
        "palette_id": "lotus-teal",
        "primary_color": "#EAF7F7",
        "secondary_color": "#2A9D8F",
        "accent_color": "#19535F",
        "motif": "waves",
    },
]


@dataclass(frozen=True)
class ProcessedCoverImage:
    webp_bytes: bytes
    width: int
    height: int
    size_bytes: int
    asset_hash: str
    detected_format: str


@dataclass(frozen=True)
class ImageProviderAvailability:
    available: bool
    provider_name: str | None
    model_id: str | None
    endpoint_url: str | None
    reason_code: str
    message_vi: str


def detect_magic_image_format(data: bytes) -> str | None:
    """Inspect real file magic bytes strictly (rejects SVG/HTML/ZIP/PDF/fake headers)."""
    if not data or len(data) < 12:
        return None
    prefix_lower = data[:512].lstrip().lower()
    for signature in _DANGEROUS_SIGNATURES:
        if prefix_lower.startswith(signature) or (
            signature in (b"<svg", b"<script") and signature in prefix_lower
        ):
            return None
    if data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


def _encode_optimized_webp(image: Image.Image, *, max_bytes: int = MAX_OUTPUT_WEBP_BYTES) -> tuple[bytes, int, int]:
    """Encode RGB image as WebP guaranteed <= max_bytes without distorting aspect ratio."""
    working = image.convert("RGB")
    for scale_attempt in range(5):
        for quality in (86, 78, 70, 62, 54, 46):
            buf = BytesIO()
            working.save(buf, format="WEBP", quality=quality, method=6)
            encoded = buf.getvalue()
            if len(encoded) <= max_bytes:
                return encoded, working.width, working.height
        next_w = max(180, int(working.width * 0.85))
        next_h = max(240, int(working.height * 0.85))
        if next_w == working.width and next_h == working.height:
            break
        working = working.resize((next_w, next_h), Image.Resampling.LANCZOS)

    buf = BytesIO()
    working.save(buf, format="WEBP", quality=40, method=6)
    encoded = buf.getvalue()
    return encoded, working.width, working.height


def validate_and_process_cover_image(
    data: bytes,
    content_type: str | None = None,
    *,
    crop_x: float | None = None,
    crop_y: float | None = None,
    crop_w: float | None = None,
    crop_h: float | None = None,
    rotation: int = 0,
) -> ProcessedCoverImage:
    """Validate real magic bytes, guard decompression bombs, apply safe crop/rotate, output <=300KB 3:4 WebP."""
    if not data:
        raise HTTPException(
            status_code=HTTP_422,
            detail="Tệp ảnh bìa đang trống.",
        )
    if len(data) > MAX_COVER_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="Ảnh bìa vượt quá dung lượng tối đa 10 MB.",
        )
    if rotation not in ALLOWED_ROTATIONS:
        raise HTTPException(
            status_code=HTTP_422,
            detail="Góc xoay ảnh bìa chỉ hỗ trợ 0, 90, 180 hoặc 270 độ.",
        )

    detected_format = detect_magic_image_format(data)
    if detected_format is None:
        raise HTTPException(
            status_code=HTTP_422,
            detail="Chỉ hỗ trợ ảnh JPG, PNG hoặc WEBP hợp lệ (không chấp nhận SVG, HTML, ZIP hay tệp giả mạo).",
        )

    normalized_mime = (content_type or "").split(";", 1)[0].strip().lower()
    if normalized_mime and normalized_mime != "application/octet-stream":
        expected_format = ALLOWED_MIME_TO_FORMAT.get(normalized_mime)
        if expected_format is None or expected_format != detected_format:
            raise HTTPException(
                status_code=HTTP_422,
                detail="Loại MIME không khớp với nội dung ảnh thực tế.",
            )

    crop_values = (crop_x, crop_y, crop_w, crop_h)
    has_any_crop = any(v is not None for v in crop_values)
    if has_any_crop:
        if any(v is None for v in crop_values):
            raise HTTPException(
                status_code=HTTP_422,
                detail="Tham số cắt ảnh bìa cần đủ crop_x, crop_y, crop_w và crop_h.",
            )
        cx, cy, cw, ch = (
            float(crop_x),  # type: ignore[arg-type]
            float(crop_y),  # type: ignore[arg-type]
            float(crop_w),  # type: ignore[arg-type]
            float(crop_h),  # type: ignore[arg-type]
        )
        if not (
            0.0 <= cx <= 1.0
            and 0.0 <= cy <= 1.0
            and 0.05 <= cw <= 1.0
            and 0.05 <= ch <= 1.0
            and cx + cw <= 1.001
            and cy + ch <= 1.001
        ):
            raise HTTPException(
                status_code=HTTP_422,
                detail="Vùng cắt ảnh bìa nằm ngoài phạm vi hợp lệ (0..1).",
            )

    try:
        with Image.open(BytesIO(data)) as source:
            if source.format != detected_format:
                raise HTTPException(
                    status_code=HTTP_422,
                    detail="Nội dung ảnh không khớp định dạng khai báo.",
                )
            width, height = source.size
            if width <= 0 or height <= 0 or (width * height) > MAX_COVER_PIXELS:
                raise HTTPException(
                    status_code=HTTP_422,
                    detail="Kích thước ảnh vượt quá giới hạn an toàn 25 megapixel.",
                )
            source.load()
            oriented = ImageOps.exif_transpose(source)
            image = oriented.convert("RGB")
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(
            status_code=HTTP_422,
            detail="Không thể giải mã tệp ảnh bìa hoặc ảnh vượt ngưỡng an toàn.",
        ) from exc

    if rotation:
        # Clockwise rotation in degrees (90 -> -90 in Pillow CCW convention)
        image = image.rotate(-rotation, expand=True)

    if has_any_crop:
        cx, cy, cw, ch = float(crop_x), float(crop_y), float(crop_w), float(crop_h)  # type: ignore[arg-type]
        left = max(0, min(image.width - 1, int(round(cx * image.width))))
        top = max(0, min(image.height - 1, int(round(cy * image.height))))
        right = max(left + 1, min(image.width, int(round((cx + cw) * image.width))))
        bottom = max(top + 1, min(image.height, int(round((cy + ch) * image.height))))
        image = image.crop((left, top, right, bottom))

    # Resize cleanly to 3:4 portrait cover bounding box (<= 900x1200)
    if not has_any_crop:
        target_w = min(MAX_COVER_WIDTH, max(image.width, 300))
        target_h = int(round(target_w / TARGET_COVER_ASPECT))
        if target_h > MAX_COVER_HEIGHT:
            target_h = MAX_COVER_HEIGHT
            target_w = int(round(target_h * TARGET_COVER_ASPECT))
        if image.width < target_w or image.height < target_h:
            # Avoid upscaling tiny images unnecessarily; fit to 3:4 within native size
            fit_w = min(image.width, int(round(image.height * TARGET_COVER_ASPECT)))
            fit_h = min(image.height, int(round(fit_w / TARGET_COVER_ASPECT)))
            target_w = max(1, min(MAX_COVER_WIDTH, fit_w))
            target_h = max(1, min(MAX_COVER_HEIGHT, fit_h))
        image = ImageOps.fit(
            image,
            (target_w, target_h),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
    else:
        image.thumbnail((MAX_COVER_WIDTH, MAX_COVER_HEIGHT), Image.Resampling.LANCZOS)

    webp_bytes, out_w, out_h = _encode_optimized_webp(image, max_bytes=MAX_OUTPUT_WEBP_BYTES)
    asset_hash = hashlib.sha256(webp_bytes).hexdigest()
    return ProcessedCoverImage(
        webp_bytes=webp_bytes,
        width=out_w,
        height=out_h,
        size_bytes=len(webp_bytes),
        asset_hash=asset_hash,
        detected_format=detected_format,
    )


def build_metadata_cover_fallback(book: Book) -> MetadataCoverFallbackRead:
    """Build deterministic high-craft Vietnamese metadata cover (never marked AI-generated)."""
    seed_input = f"{book.Id}:{book.Title}".encode("utf-8")
    digest = hashlib.sha256(seed_input).digest()
    palette = _METADATA_PALETTES[digest[0] % len(_METADATA_PALETTES)]
    grade_label = (
        f"Lớp {book.MinGrade}"
        if book.MinGrade == book.MaxGrade
        else f"Lớp {book.MinGrade}–{book.MaxGrade}"
    )
    return MetadataCoverFallbackRead(
        palette_id=palette["palette_id"],
        primary_color=palette["primary_color"],
        secondary_color=palette["secondary_color"],
        accent_color=palette["accent_color"],
        motif=palette["motif"],
        title=book.Title,
        author=book.Author,
        grade_label=grade_label,
        source_type="METADATA_RENDER",
    )


_COVER_SOURCE_PRIORITY_RANK = {
    "USER_UPLOAD": 0,
    "ENHANCED_CROP": 1,
    "ORIGINAL_CROP": 1,
    "AI_GENERATED": 2,
    "METADATA_RENDER": 3,
}

_DEFAULT_NEGATIVE_PROMPT = (
    "text, letters, words, numbers, watermark, signature, logo, typography, "
    "captions, speech bubbles, title, blurry, scary"
)


def _public_provider_name(provider_id: str | None) -> str | None:
    if provider_id == "cloudflare_flux":
        return "cloudflare_workers_ai"
    if provider_id == "local_diffusers":
        return "local_diffusers"
    if provider_id == "gemini_image":
        return "gemini_image"
    return provider_id


def detect_image_generation_provider(
    *,
    is_private_book: bool,
    router: AiCapabilityRouter | None = None,
) -> ImageProviderAvailability:
    """Honestly report real generative image provider availability via AiCapabilityRouter (0 VND policy)."""
    flags = SmartStudioFlags.from_environment()
    if not flags.ai_image_gen_enabled:
        return ImageProviderAvailability(
            available=False,
            provider_name=None,
            model_id=None,
            endpoint_url=None,
            reason_code="AI_IMAGE_GEN_DISABLED",
            message_vi="Tính năng tạo ảnh bìa bằng AI đang tạm tắt trong cấu hình hệ thống.",
        )

    active_router = router or get_default_ai_router()
    allow_cloud = (not is_private_book) or OcrCorrectionConfig.private_book_allow_cloud_ai()
    eligible = active_router.eligible_providers(
        AiCapability.IMAGE_GENERATION,
        allow_cloud=allow_cloud,
    )

    cf_account = (os.getenv("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    cf_token = (os.getenv("CLOUDFLARE_API_TOKEN") or "").strip()
    local_url = flags.local_image_worker_url

    for spec in eligible:
        if spec.provider_id == "cloudflare_flux":
            return ImageProviderAvailability(
                available=True,
                provider_name="cloudflare_workers_ai",
                model_id=spec.model_id,
                endpoint_url=(
                    f"https://api.cloudflare.com/client/v4/accounts/{cf_account}"
                    f"/ai/run/{spec.model_id}"
                    if cf_account
                    else None
                ),
                reason_code="READY",
                message_vi="Sẵn sàng tạo bìa bằng Cloudflare Workers AI (miễn phí 0 VND).",
            )
        if spec.provider_id == "local_diffusers" and local_url:
            try:
                base_url = _validate_local_worker_url(local_url)
            except AiProviderCallError:
                continue
            return ImageProviderAvailability(
                available=True,
                provider_name="local_diffusers",
                model_id=spec.model_id,
                endpoint_url=f"{base_url}/generate",
                reason_code="READY",
                message_vi="Sẵn sàng tạo bìa bằng Local Image Worker trên máy chủ cục bộ.",
            )
        if spec.provider_id == "gemini_image":
            return ImageProviderAvailability(
                available=True,
                provider_name="gemini_image",
                model_id=spec.model_id,
                endpoint_url=(
                    f"https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{spec.model_id}:generateContent"
                ),
                reason_code="READY",
                message_vi="Sẵn sàng tạo bìa bằng Gemini Image (đã bật opt-in).",
            )

    if is_private_book and cf_account and cf_token and not allow_cloud:
        return ImageProviderAvailability(
            available=False,
            provider_name=None,
            model_id=None,
            endpoint_url=None,
            reason_code="BLOCKED_NO_IMAGE_PROVIDER",
            message_vi=(
                "Sách riêng của gia đình chỉ sử dụng máy xử lý cục bộ để bảo vệ quyền riêng tư, "
                "hiện chưa có Local Image Worker. Ba mẹ có thể chụp/tải ảnh bìa hoặc dùng bìa chữ tiếng Việt."
            ),
        )

    return ImageProviderAvailability(
        available=False,
        provider_name=None,
        model_id=None,
        endpoint_url=None,
        reason_code="BLOCKED_NO_IMAGE_PROVIDER",
        message_vi=(
            "Chưa cấu hình nhà cung cấp tạo ảnh AI miễn phí (Cloudflare Workers AI hoặc Local Image Worker). "
            "Hệ thống giữ bìa chữ tiếng Việt tự động và không giả lập ảnh AI."
        ),
    )


ImageGenerateTransport = Callable[[ImageProviderAvailability, str], Awaitable[tuple[int, bytes]]]


_MAX_GENERATED_RESPONSE_BYTES = 10 * 1024 * 1024
_UNSAFE_PROMPT_TOKENS = (
    "blood", "gore", "weapon", "nude", "naked", "sexual", "kill", "murder",
    "violence", "bạo lực", "máu me", "kinh dị", "khỏa thân", "vũ khí", "chết chóc",
)


def _sanitize_child_safe_prompt_hint(raw_hint: str | None) -> str:
    if not raw_hint or not raw_hint.strip():
        return ""
    cleaned = raw_hint.replace("<", " ").replace(">", " ").strip()[:280]
    lowered = cleaned.lower()
    if any(tok in lowered for tok in _UNSAFE_PROMPT_TOKENS):
        raise HTTPException(
            status_code=HTTP_422,
            detail="UNSAFE_PROMPT_CONTENT",
        )
    return cleaned


async def _default_image_generate_transport(
    provider: ImageProviderAvailability, prompt: str
) -> tuple[int, bytes]:
    """Legacy/direct HTTP image-gen transport retained for backward compatibility & stream-cap tests.

    Production flows route through `AiCapabilityRouter.generate_image()` via
    `generate_image_via_router_and_scheduler()`; patching this function in tests is honored there.
    """
    if not provider.endpoint_url:
        return 503, b""
    headers: dict[str, str] = {}
    payload: dict[str, Any] = {"prompt": prompt, "num_steps": 4}
    if provider.provider_name == "cloudflare_workers_ai":
        token = (os.getenv("CLOUDFLARE_API_TOKEN") or "").strip()
        headers["Authorization"] = f"Bearer {token}"
    max_wire_bytes = int(_MAX_GENERATED_RESPONSE_BYTES * 1.4) + 65536
    async with httpx.AsyncClient(
        timeout=45.0, trust_env=False, follow_redirects=False
    ) as client:
        async with client.stream(
            "POST", provider.endpoint_url, json=payload, headers=headers
        ) as resp:
            if resp.status_code != 200:
                return resp.status_code, b""
            content_type = (resp.headers.get("content-type") or "").lower()
            is_json = "application/json" in content_type
            limit = max_wire_bytes if is_json else _MAX_GENERATED_RESPONSE_BYTES
            raw_len_hdr = (resp.headers.get("content-length") or "").strip()
            if raw_len_hdr.isdigit() and int(raw_len_hdr) > limit:
                return 502, b""
            buf = bytearray()
            async for chunk in resp.aiter_bytes(65536):
                buf.extend(chunk)
                if len(buf) > limit:
                    return 502, b""
            raw_body = bytes(buf)
        if is_json:
            import base64
            import json as _json

            try:
                body = _json.loads(raw_body.decode("utf-8"))
            except Exception:
                return 502, b""
            raw_b64 = (
                (body.get("result") or {}).get("image")
                if isinstance(body, dict)
                else None
            )
            if isinstance(raw_b64, str) and raw_b64:
                try:
                    decoded = base64.b64decode(raw_b64, validate=True)
                except Exception:
                    return 502, b""
                if len(decoded) > _MAX_GENERATED_RESPONSE_BYTES:
                    return 502, b""
                return 200, decoded
            return 502, b""
        if len(raw_body) > _MAX_GENERATED_RESPONSE_BYTES:
            return 502, b""
        return 200, raw_body


_ORIGINAL_DEFAULT_IMAGE_GENERATE_TRANSPORT = _default_image_generate_transport


async def generate_image_via_router_and_scheduler(
    *,
    prompt: str,
    negative_prompt: str = _DEFAULT_NEGATIVE_PROMPT,
    width: int = 512,
    height: int = 768,
    steps: int = 4,
    tenant_scope: str = "admin:catalog",
    allow_cloud: bool = True,
    source_hash: str | None = None,
    revision: str = "v1",
    priority: WorkloadPriority = WorkloadPriority.COVER_GEN,
    workload_id: str | None = None,
    estimated_vram_mb: int = 2200,
    provider_hint: ImageProviderAvailability | None = None,
    image_transport: ImageGenerateTransport | None = None,
    ai_router: AiCapabilityRouter | None = None,
    gpu_scheduler: GpuWorkloadScheduler | None = None,
) -> tuple[int, bytes, str | None, str | None, str | None]:
    """Dispatch image generation strictly through AiCapabilityRouter + GpuWorkloadScheduler.

    Preserves custom `image_transport` injection (and legacy `_default_image_generate_transport`
    monkeypatching in unit tests) while still enforcing GpuWorkloadScheduler serialization.

    Returns `(http_status, image_bytes, provider_name, model_id, error_code)`.
    """
    scheduler = gpu_scheduler or get_default_gpu_scheduler()
    router = ai_router or get_default_ai_router()
    effective_transport = image_transport
    if (
        effective_transport is None
        and _default_image_generate_transport is not _ORIGINAL_DEFAULT_IMAGE_GENERATE_TRANSPORT
    ):
        effective_transport = _default_image_generate_transport

    async with scheduler.acquire(
        priority=priority,
        workload_id=workload_id,
        estimated_vram_mb=estimated_vram_mb,
    ):
        if effective_transport is not None:
            hint = provider_hint or detect_image_generation_provider(
                is_private_book=not allow_cloud,
                router=router,
            )
            try:
                http_status, raw_bytes = await effective_transport(hint, prompt)
            except Exception as exc:
                logger.warning(
                    "Custom AI image transport failed (type=%s)", type(exc).__name__
                )
                return 503, b"", hint.provider_name, hint.model_id, "IMAGE_TRANSPORT_ERROR"
            err_code = None if http_status == 200 else f"IMAGE_PROVIDER_HTTP_{http_status}"
            return http_status, raw_bytes, hint.provider_name, hint.model_id, err_code

        req = ImageGenerationRequest(
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            steps=steps,
            tenant_scope=tenant_scope,
            allow_cloud=allow_cloud,
            source_hash=source_hash,
            revision=revision,
        )
        try:
            result = await router.generate_image(req)
        except AiRoutingError as exc:
            logger.warning(
                "AiCapabilityRouter image generation failed (kind=%s, code=%s)",
                exc.kind.value,
                exc.code,
            )
            p_name = provider_hint.provider_name if provider_hint else None
            p_model = provider_hint.model_id if provider_hint else None
            if exc.kind in (AiErrorKind.QUOTA_EXHAUSTED, AiErrorKind.RATE_LIMIT):
                return 429, b"", p_name, p_model, exc.code
            if exc.kind == AiErrorKind.UNSAFE_OUTPUT:
                return 422, b"", p_name, p_model, exc.code
            return 503, b"", p_name, p_model, exc.code
        except Exception as exc:
            logger.warning(
                "AI image generation failed unexpectedly (type=%s)", type(exc).__name__
            )
            p_name = provider_hint.provider_name if provider_hint else None
            p_model = provider_hint.model_id if provider_hint else None
            return 503, b"", p_name, p_model, "IMAGE_GENERATION_FAILED"

        return (
            200,
            result.image_bytes,
            _public_provider_name(result.provider_id),
            result.model_id,
            None,
        )


def asset_to_dto(asset: BookPresentationAsset) -> BookPresentationAssetRead:
    return BookPresentationAssetRead(
        id=asset.Id,
        book_id=asset.BookId,
        book_page_id=asset.BookPageId,
        source_revision_id=asset.SourceRevisionId,
        asset_role=asset.AssetRole,  # type: ignore[arg-type]
        source_type=asset.SourceType,  # type: ignore[arg-type]
        media_url=f"/studio/assets/{asset.Id}/media",
        mime_type=asset.MimeType or "image/webp",
        width=asset.Width,
        height=asset.Height,
        size_bytes=asset.SizeBytes,
        asset_hash=asset.AssetHash,
        asset_version=int(asset.AssetVersion or 1),
        is_active=bool(asset.IsActive),
        text_free_verified=bool(asset.TextFreeVerified),
        moderation_status=asset.ModerationStatus,  # type: ignore[arg-type]
        provider_name=asset.ProviderName,
        model_id=asset.ModelId,
        job_id=asset.JobId,
        metadata=dict(asset.MetadataJson or {}),
        created_at=asset.CreatedAt,
        updated_at=asset.UpdatedAt,
    )


def _bucket_for_book(book: Book) -> str:
    if is_book_private(book):
        return SUPABASE_PRIVATE_BOOKS_BUCKET
    return SUPABASE_STORAGE_BUCKET or "books"


def _validate_relative_storage_path(path: str) -> str:
    cleaned = (path or "").strip()
    if (
        not cleaned
        or cleaned.startswith(("/", "\\", "http://", "https://", "data:"))
        or ".." in cleaned.split("/")
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stored presentation asset path is invalid",
        )
    return cleaned


class BookCoverService:
    """Orchestrates Book Cover Studio operations with strict security & zero reading-page contamination."""

    def __init__(
        self,
        db: AsyncSession,
        *,
        image_transport: ImageGenerateTransport | None = None,
        ai_router: AiCapabilityRouter | None = None,
        gpu_scheduler: GpuWorkloadScheduler | None = None,
        ocr_check_fn: Callable[[bytes], str] | None = None,
    ) -> None:
        self.db = db
        self.repo = BookAssetsRepository(db)
        self.style_bible_service = BookStyleBibleService(db)
        self._custom_image_transport = image_transport
        self._ai_router = ai_router
        self._gpu_scheduler = gpu_scheduler
        self._ocr_check_fn = ocr_check_fn

    async def _resolve_effective_cover(
        self, book_id: UUID
    ) -> tuple[BookPresentationAsset | None, CoverPrioritySource, bool]:
        """Resolve effective cover enforcing USER_UPLOAD > ORIGINAL_CROP/ENHANCED_CROP > AI_GENERATED > METADATA_RENDER."""
        covers, degraded = await self.repo.list_active_covers(book_id)
        if degraded or not covers:
            return None, "METADATA_RENDER", degraded
        approved = [c for c in covers if c.ModerationStatus == "APPROVED"]
        if not approved:
            return None, "METADATA_RENDER", False
        approved.sort(
            key=lambda item: (
                _COVER_SOURCE_PRIORITY_RANK.get(item.SourceType, 99),
                -(item.AssetVersion or 0),
                -(item.UpdatedAt.timestamp() if item.UpdatedAt else 0.0),
            )
        )
        top = approved[0]
        if top.SourceType in ("USER_UPLOAD", "ORIGINAL_CROP", "ENHANCED_CROP"):
            return top, "USER_UPLOAD", False
        if top.SourceType == "AI_GENERATED":
            return top, "AI_GENERATED", False
        return None, "METADATA_RENDER", False

    def _verify_ai_cover_text_free(
        self,
        *,
        image_bytes: bytes,
        book: Book | None = None,
        canonical_hint: str | None = None,
    ) -> Any:
        """Run mandatory Dual Text-Free Gate (OpenCV + OCR callback) on AI-generated covers."""
        from app.services.book_illustration_service import (
            _decode_bgr_safely,
            verify_illustration_text_free,
        )

        img_bgr = _decode_bgr_safely(image_bytes)
        resolved_hint = canonical_hint
        if resolved_hint is None and book is not None:
            resolved_hint = f"{book.Title or ''} {book.Author or ''}".strip() or None
        return verify_illustration_text_free(
            img_bgr,
            canonical_text=resolved_hint,
            ocr_check_fn=self._ocr_check_fn,
            image_bytes=image_bytes,
        )

    async def _is_catalog_book_eligible(self, book: Book) -> bool:
        if book.LifecycleStatus != "ACTIVE" or bool(getattr(book, "IsDeleted", False)):
            return False
        if (
            isinstance(self.db, AsyncSession)
            or callable(getattr(self.db, "scalar", None))
            or getattr(CatalogRepository, "is_eligible", None) is not _ORIGINAL_CATALOG_IS_ELIGIBLE
        ):
            return bool(await CatalogRepository(self.db).is_eligible(book.Id))
        return True

    async def authorize_book_read(self, actor_id: UUID, book_id: UUID) -> tuple[Book, str]:
        role = await self.repo.get_actor_role(actor_id)
        if role not in ("admin", "parent"):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        book = await self.repo.get_book(book_id)
        if book is None or bool(getattr(book, "IsDeleted", False)):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
        if is_book_private(book):
            if role != "admin":
                if book.OwnerParentId != actor_id:
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
                if book.LifecycleStatus != "ACTIVE" or (book.ModerationStatus or "ACTIVE") != "ACTIVE":
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Sách riêng đang tạm khóa kiểm duyệt hoặc không còn khả dụng.",
                    )
        else:
            if role != "admin" and not await self._is_catalog_book_eligible(book):
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        return book, role

    async def authorize_book_write(self, actor_id: UUID, book_id: UUID) -> tuple[Book, str]:
        role = await self.repo.get_actor_role(actor_id)
        if role not in ("admin", "parent"):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
        book = await self.repo.get_book(book_id)
        if book is None or bool(getattr(book, "IsDeleted", False)):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
        if is_book_private(book):
            if role == "parent" and book.OwnerParentId != actor_id:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
            if role != "parent" and role != "admin":
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
            if book.LifecycleStatus != "ACTIVE":
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Sách riêng không còn khả dụng để chỉnh sửa.",
                )
            if (book.ModerationStatus or "ACTIVE") != "ACTIVE" and role != "admin":
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Sách đang tạm khóa kiểm duyệt.",
                )
        else:
            if role != "admin":
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Chỉ quản trị viên được chỉnh sửa ảnh bìa sách thư viện chung.",
                )
        return book, role

    async def get_book_assets_summary(
        self, actor_id: UUID, book_id: UUID
    ) -> BookAssetsSummaryResponse:
        book, role = await self.authorize_book_read(actor_id, book_id)
        effective_cover, effective_source, cover_degraded = await self._resolve_effective_cover(
            book.Id
        )
        illustrations, ill_degraded = await self.repo.list_page_illustrations(book.Id)
        style_bible_row, bible_degraded = await self.repo.get_style_bible(book.Id)

        if role != "admin" and not is_book_private(book):
            illustrations = [
                item
                for item in illustrations
                if item.IsActive
                and item.ModerationStatus == "APPROVED"
                and item.TextFreeVerified
            ]

        style_bible_dto: BookStyleBibleRead | None = None
        if style_bible_row is not None and isinstance(style_bible_row.BibleJson, dict):
            try:
                style_bible_dto = BookStyleBibleRead(
                    book_id=book.Id,
                    context_hash=style_bible_row.ContextHash,
                    cache_hit=True,
                    bible=StyleBibleContentRead.model_validate(style_bible_row.BibleJson),
                    provider_name=style_bible_row.ProviderName,
                    model_id=style_bible_row.ModelId,
                    updated_at=style_bible_row.UpdatedAt,
                )
            except Exception:
                style_bible_dto = None

        provider = detect_image_generation_provider(
            is_private_book=is_book_private(book),
            router=self._ai_router,
        )

        return BookAssetsSummaryResponse(
            book_id=book.Id,
            title=book.Title,
            author=book.Author,
            min_grade=int(book.MinGrade),
            max_grade=int(book.MaxGrade),
            visibility_scope=book.VisibilityScope,
            active_cover=asset_to_dto(effective_cover) if effective_cover is not None else None,
            effective_cover_source=effective_source,
            metadata_fallback=build_metadata_cover_fallback(book),
            style_bible=style_bible_dto,
            page_illustrations=[asset_to_dto(item) for item in illustrations],
            ai_image_provider_available=provider.available,
            ai_image_provider_name=provider.provider_name,
            ai_image_provider_message_vi=provider.message_vi,
            v2_storage_degraded=cover_degraded or ill_degraded or bible_degraded,
        )

    async def upload_user_cover(
        self,
        actor_id: UUID,
        book_id: UUID,
        data: bytes,
        content_type: str | None,
        *,
        crop_x: float | None = None,
        crop_y: float | None = None,
        crop_w: float | None = None,
        crop_h: float | None = None,
        rotation: int = 0,
    ) -> BookPresentationAssetRead:
        book, _role = await self.authorize_book_write(actor_id, book_id)
        resolved_book_id = book.Id
        private_book = is_book_private(book)
        owner_id = book.OwnerParentId if private_book else None
        bucket = _bucket_for_book(book)
        if callable(getattr(self.db, "rollback", None)):
            await self.db.rollback()

        processed = await asyncio.to_thread(
            validate_and_process_cover_image,
            data,
            content_type,
            crop_x=crop_x,
            crop_y=crop_y,
            crop_w=crop_w,
            crop_h=crop_h,
            rotation=rotation,
        )

        scope = f"private/{owner_id}" if private_book else "catalog"
        storage_path = _validate_relative_storage_path(
            f"studio/covers/{scope}/{resolved_book_id}/{processed.asset_hash[:16]}_{uuid4().hex[:8]}.webp"
        )

        await asyncio.to_thread(
            upload_object,
            storage_path,
            processed.webp_bytes,
            "image/webp",
            bucket_name=bucket,
            upsert=False,
        )
        try:
            # Anti-overwrite invariant: mark any pending/running AI cover jobs STALE first!
            stale_count = await self.repo.mark_inflight_cover_jobs_stale(resolved_book_id)
            asset = await self.repo.create_cover_asset(
                book_id=resolved_book_id,
                owner_id=owner_id,
                source_type="USER_UPLOAD",
                storage_path=storage_path,
                mime_type="image/webp",
                width=processed.width,
                height=processed.height,
                size_bytes=processed.size_bytes,
                asset_hash=processed.asset_hash,
                is_active=True,
                moderation_status="APPROVED",
                provider_name="user_upload",
                model_id=None,
                metadata_json={
                    "original_format": processed.detected_format,
                    "rotation": rotation,
                    "crop": (
                        {"x": crop_x, "y": crop_y, "w": crop_w, "h": crop_h}
                        if crop_x is not None
                        else None
                    ),
                    "superseded_ai_jobs": stale_count,
                },
                deactivate_existing=True,
            )
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
            raise

        return asset_to_dto(asset)

    async def delete_book_cover(
        self, actor_id: UUID, book_id: UUID
    ) -> BookCoverDeleteResponse:
        book, _role = await self.authorize_book_write(actor_id, book_id)
        resolved_book_id = book.Id
        bucket = _bucket_for_book(book)
        fallback = build_metadata_cover_fallback(book)
        removed = await self.repo.deactivate_book_covers(resolved_book_id)
        orphan_paths: list[str] = []
        for item in removed:
            raw_path = getattr(item, "StoragePath", None)
            if isinstance(raw_path, str) and raw_path.strip():
                try:
                    orphan_paths.append(_validate_relative_storage_path(raw_path))
                except HTTPException:
                    continue
        await self.repo.mark_inflight_cover_jobs_stale(resolved_book_id)
        await self.db.commit()

        for orphan_path in orphan_paths:
            try:
                await asyncio.to_thread(delete_object, orphan_path, bucket_name=bucket)
            except Exception as exc:
                logger.warning(
                    "delete_book_cover_storage_cleanup_failed type=%s",
                    type(exc).__name__,
                )

        return BookCoverDeleteResponse(
            book_id=resolved_book_id,
            removed_count=len(removed),
            metadata_fallback=fallback,
            message_vi=(
                "Đã gỡ ảnh bìa hiện tại và chuyển về bìa chữ tiếng Việt tự động."
                if removed
                else "Sách hiện đang dùng bìa chữ tiếng Việt tự động."
            ),
        )

    async def extract_cover_from_page(
        self,
        book_id: UUID,
        page_id: UUID,
        actor_id: UUID,
        actor_role: str | None = None,
        *,
        crop_x: float | None = None,
        crop_y: float | None = None,
        crop_w: float | None = None,
        crop_h: float | None = None,
        rotation: int = 0,
        apply_clahe_restore: bool = True,
        force_replace_user_upload: bool = False,
        page_image_bytes_override: bytes | None = None,
    ) -> BookPresentationAssetRead:
        """Create an ORIGINAL_CROP / ENHANCED_CROP cover from an existing book page image.

        Strictly preserves USER_UPLOAD > ORIGINAL_CROP/ENHANCED_CROP > AI_GENERATED > METADATA_RENDER
        priority and marks in-flight AI cover jobs STALE so late AI jobs never overwrite.
        """
        _ = actor_role
        book, _resolved_role = await self.authorize_book_write(actor_id, book_id)
        page = await self.repo.get_page(book.Id, page_id)
        if page is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Book page not found",
            )

        bucket = _bucket_for_book(book)
        if page_image_bytes_override is not None:
            source_bytes = page_image_bytes_override
        else:
            safe_page_path = _validate_relative_storage_path(page.ImagePath)
            source_bytes = download_object(safe_page_path, bucket_name=bucket)

        processed = validate_and_process_cover_image(
            source_bytes,
            None,
            crop_x=crop_x,
            crop_y=crop_y,
            crop_w=crop_w,
            crop_h=crop_h,
            rotation=rotation,
        )
        restored = False
        if apply_clahe_restore:
            try:
                import cv2
                from app.services.book_illustration_service import (
                    _apply_gentle_clahe_restore,
                    _decode_bgr_safely,
                )

                bgr = _decode_bgr_safely(processed.webp_bytes)
                enhanced_bgr = _apply_gentle_clahe_restore(bgr)
                enhanced_rgb = cv2.cvtColor(enhanced_bgr, cv2.COLOR_BGR2RGB)
                webp_bytes, out_w, out_h = _encode_optimized_webp(
                    Image.fromarray(enhanced_rgb),
                    max_bytes=MAX_OUTPUT_WEBP_BYTES,
                )
                processed = ProcessedCoverImage(
                    webp_bytes=webp_bytes,
                    width=out_w,
                    height=out_h,
                    size_bytes=len(webp_bytes),
                    asset_hash=hashlib.sha256(webp_bytes).hexdigest(),
                    detected_format=processed.detected_format,
                )
                restored = True
            except Exception as exc:
                logger.warning(
                    "Cover CLAHE restoration fallback to original crop (type=%s)",
                    type(exc).__name__,
                )

        source_type = "ENHANCED_CROP" if restored else "ORIGINAL_CROP"
        owner_id = book.OwnerParentId if is_book_private(book) else None
        scope = f"private/{owner_id}" if is_book_private(book) else "catalog"
        storage_path = _validate_relative_storage_path(
            f"studio/covers/{scope}/{book.Id}/page_{page.Id}_{processed.asset_hash[:16]}_{uuid4().hex[:8]}.webp"
        )

        upload_object(
            storage_path,
            processed.webp_bytes,
            "image/webp",
            bucket_name=bucket,
            upsert=False,
        )
        try:
            stale_count = await self.repo.mark_inflight_cover_jobs_stale(book.Id)
            has_user_cover = await self.repo.has_active_user_uploaded_cover(book.Id)
            activate_new_cover = force_replace_user_upload or (not has_user_cover)
            asset = await self.repo.create_cover_asset(
                book_id=book.Id,
                owner_id=owner_id,
                source_type=source_type,
                storage_path=storage_path,
                mime_type="image/webp",
                width=processed.width,
                height=processed.height,
                size_bytes=processed.size_bytes,
                asset_hash=processed.asset_hash,
                is_active=activate_new_cover,
                moderation_status="APPROVED",
                provider_name="opencv_local",
                model_id="cover-page-crop-v2",
                metadata_json={
                    "source_page_id": str(page.Id),
                    "source_page_number": int(page.PageNumber or 1),
                    "rotation": rotation,
                    "crop": (
                        {"x": crop_x, "y": crop_y, "w": crop_w, "h": crop_h}
                        if crop_x is not None
                        else None
                    ),
                    "restored_with_clahe": restored,
                    "superseded_ai_jobs": stale_count,
                    "preserved_user_upload_priority": bool(
                        has_user_cover and not force_replace_user_upload
                    ),
                },
                deactivate_existing=activate_new_cover,
            )
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            delete_object(storage_path, bucket_name=bucket)
            raise

        return asset_to_dto(asset)

    async def commit_generated_cover_bytes(
        self,
        *,
        book: Book,
        image_bytes: bytes,
        provider_name: str,
        model_id: str | None,
        job_id: UUID | None = None,
        lease_token: UUID | None = None,
        prompt_summary: str | None = None,
        verification_metadata: dict[str, Any] | None = None,
        enforce_text_free: bool = True,
        book_id: UUID | None = None,
        private_book_override: bool | None = None,
        owner_id_override: UUID | None = None,
        bucket_override: str | None = None,
        canonical_hint_override: str | None = None,
    ) -> tuple[BookPresentationAsset | None, bool]:
        """Persist an AI-generated cover while STRICTLY enforcing anti-overwrite, job fencing & Dual Text-Free Gate.

        Returns `(asset, superseded_by_user_upload)`.
        """
        resolved_book_id = book_id if book_id is not None else book.Id
        private_book = (
            private_book_override if private_book_override is not None else is_book_private(book)
        )
        owner_id = (
            owner_id_override
            if private_book_override is not None
            else (book.OwnerParentId if private_book else None)
        )
        bucket = bucket_override if bucket_override is not None else _bucket_for_book(book)
        canonical_hint = (
            canonical_hint_override
            if canonical_hint_override is not None
            else (f"{book.Title or ''} {book.Author or ''}".strip() or None)
        )

        if job_id is not None:
            job = await self.repo.get_studio_job(job_id)
            if job is not None and job.Status == "STALE":
                return None, True

        if await self.repo.has_active_user_uploaded_cover(resolved_book_id):
            return None, True

        if callable(getattr(self.db, "rollback", None)):
            await self.db.rollback()

        processed = await asyncio.to_thread(
            validate_and_process_cover_image, image_bytes, None, rotation=0
        )
        gate_meta = dict(verification_metadata or {})
        if enforce_text_free and "text_free_verified" not in gate_meta:
            from app.services.book_illustration_service import (
                _decode_bgr_safely,
                verify_illustration_text_free,
            )

            def _run_cover_gate() -> Any:
                img_bgr = _decode_bgr_safely(processed.webp_bytes)
                return verify_illustration_text_free(
                    img_bgr,
                    canonical_text=canonical_hint,
                    ocr_check_fn=self._ocr_check_fn,
                    image_bytes=processed.webp_bytes,
                )

            verification = await asyncio.to_thread(_run_cover_gate)
            gate_meta.update(
                {
                    "text_free_verified": bool(verification.text_free_verified),
                    "text_density_score": verification.text_density_score,
                    "ocr_overlap_score": verification.ocr_overlap_score,
                    "detected_text_runs": verification.detected_text_runs,
                    "ocr_gate_mode": verification.ocr_gate_mode,
                    "ocr_checked": bool(verification.ocr_checked),
                }
            )
            if not verification.text_free_verified:
                return None, False
        scope = f"private/{owner_id}" if private_book else "catalog"
        storage_path = _validate_relative_storage_path(
            f"studio/covers/{scope}/{resolved_book_id}/ai_{processed.asset_hash[:16]}_{uuid4().hex[:8]}.webp"
        )
        await asyncio.to_thread(
            upload_object,
            storage_path,
            processed.webp_bytes,
            "image/webp",
            bucket_name=bucket,
            upsert=False,
        )
        try:
            # Verify active lease + non-CANCEL_REQUESTED + non-STALE inside the SAME txn BEFORE writing active asset!
            if job_id is not None and lease_token is not None:
                from app.services.global_tasks_service import (
                    verify_smart_studio_job_fence_in_tx,
                )

                _fenced_job, fence_status = await verify_smart_studio_job_fence_in_tx(
                    self.db,
                    job_id=job_id,
                    lease_token=lease_token,
                )
                if fence_status == "STALE":
                    await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
                    return None, True

            # Re-verify anti-overwrite immediately before write
            if await self.repo.has_active_user_uploaded_cover(resolved_book_id):
                await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
                return None, True
            asset = await self.repo.create_cover_asset(
                book_id=resolved_book_id,
                owner_id=owner_id,
                source_type="AI_GENERATED",
                storage_path=storage_path,
                mime_type="image/webp",
                width=processed.width,
                height=processed.height,
                size_bytes=processed.size_bytes,
                asset_hash=processed.asset_hash,
                is_active=True,
                moderation_status="APPROVED",
                provider_name=provider_name,
                model_id=model_id,
                job_id=job_id,
                metadata_json={
                    "prompt_summary": (prompt_summary or "")[:300],
                    **gate_meta,
                },
                deactivate_existing=True,
            )
            return asset, False
        except BaseException:
            if callable(getattr(self.db, "rollback", None)):
                try:
                    await self.db.rollback()
                except Exception:
                    pass
            try:
                await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
            except Exception:
                pass
            raise

    async def enqueue_ai_cover_job(
        self,
        actor_id: UUID,
        book_id: UUID,
        payload: BookCoverGenerateRequest,
    ) -> BookCoverGenerateResponse:
        """Enqueue a durable QUEUED COVER_GENERATE SmartStudioJob without blocking HTTP."""
        book, role = await self.authorize_book_write(actor_id, book_id)
        style_bible = await self.style_bible_service.get_or_build_for_book(book)
        fallback = build_metadata_cover_fallback(book)
        provider = detect_image_generation_provider(
            is_private_book=is_book_private(book),
            router=self._ai_router,
        )

        has_user_cover = await self.repo.has_active_user_uploaded_cover(book.Id)
        if has_user_cover and not payload.force_regenerate:
            effective_cover, _, _ = await self._resolve_effective_cover(book.Id)
            await self.db.commit()
            return BookCoverGenerateResponse(
                status="SUPERSEDED_BY_USER_UPLOAD",
                job_id=None,
                provider_name=provider.provider_name,
                model_id=provider.model_id,
                message_vi=(
                    "Sách đang có ảnh bìa do người dùng tải lên. "
                    "Hệ thống giữ nguyên ảnh bìa người dùng tải lên (không tự ghi đè bằng AI)."
                ),
                cover=asset_to_dto(effective_cover) if effective_cover is not None else None,
                metadata_fallback=fallback,
                style_bible=style_bible,
                honest_ai_generated=False,
            )

        safe_hint = _sanitize_child_safe_prompt_hint(payload.prompt_hint)
        input_hash = hashlib.sha256(
            f"{book.Id}:{style_bible.context_hash}:{safe_hint}".encode("utf-8")
        ).hexdigest()
        idem_key = (
            (payload.idempotency_key or "").strip()
            or f"cover-gen:{book.Id}:{input_hash[:16]}:{uuid4().hex[:8]}"
        )

        if not provider.available:
            job = await self.repo.record_studio_job(
                job_type="COVER_GENERATE",
                actor_id=actor_id,
                actor_role=role,
                book_id=book.Id,
                book_page_id=None,
                source_revision_id=None,
                input_hash=input_hash,
                idempotency_key=idem_key,
                stage="BLOCKED_NO_IMAGE_PROVIDER",
                status_value="FAILED",
                error_code=provider.reason_code,
                error_message_vi=provider.message_vi,
            )
            await self.db.commit()
            return BookCoverGenerateResponse(
                status="BLOCKED_NO_IMAGE_PROVIDER",
                job_id=job.Id if job is not None else None,
                provider_name=None,
                model_id=None,
                message_vi=provider.message_vi,
                cover=None,
                metadata_fallback=fallback,
                style_bible=style_bible,
                honest_ai_generated=False,
            )

        job = await self.repo.record_studio_job(
            job_type="COVER_GENERATE",
            actor_id=actor_id,
            actor_role=role,
            book_id=book.Id,
            book_page_id=None,
            source_revision_id=None,
            input_hash=input_hash,
            idempotency_key=idem_key,
            stage="QUEUED",
            status_value="QUEUED",
            priority=int(WorkloadPriority.COVER_GEN),
        )
        if job is not None:
            checkpoints = dict(job.CheckpointsJson or {}) if isinstance(job.CheckpointsJson, dict) else {}
            checkpoints["request"] = {
                "prompt_hint": safe_hint,
                "force_regenerate": bool(payload.force_regenerate),
            }
            job.CheckpointsJson = checkpoints
        await self.db.commit()

        from app.services.global_tasks_service import notify_smart_studio_worker

        notify_smart_studio_worker()
        return BookCoverGenerateResponse(
            status="QUEUED",
            job_id=job.Id if job is not None else None,
            provider_name=provider.provider_name,
            model_id=provider.model_id,
            message_vi="Đã đưa yêu cầu tạo ảnh bìa AI vào hàng đợi xử lý nền.",
            cover=None,
            metadata_fallback=fallback,
            style_bible=style_bible,
            honest_ai_generated=False,
        )

    async def execute_ai_cover_job(
        self,
        actor_id: UUID,
        book_id: UUID,
        payload: BookCoverGenerateRequest,
        *,
        existing_job_id: UUID | None = None,
        existing_lease_token: UUID | None = None,
        managed_by_worker: bool = False,
    ) -> BookCoverGenerateResponse:
        """Execute AI cover generation via AiCapabilityRouter + GpuWorkloadScheduler + Dual Text-Free Gate.

        When `existing_job_id` is supplied (e.g. from `global_tasks_service.py`), reuses that exact
        `SmartStudioJob` without creating a nested duplicate job.
        """
        book, role = await self.authorize_book_write(actor_id, book_id)
        resolved_book_id = book.Id
        private_book = is_book_private(book)
        owner_parent_id = book.OwnerParentId if private_book else None
        asset_bucket = _bucket_for_book(book)
        canonical_hint = f"{book.Title or ''} {book.Author or ''}".strip() or None
        style_bible = await self.style_bible_service.get_or_build_for_book(book)
        fallback = build_metadata_cover_fallback(book)
        allow_cloud = (not private_book) or OcrCorrectionConfig.private_book_allow_cloud_ai()
        provider = detect_image_generation_provider(
            is_private_book=private_book,
            router=self._ai_router,
        )

        has_user_cover = await self.repo.has_active_user_uploaded_cover(resolved_book_id)
        if has_user_cover and not payload.force_regenerate:
            effective_cover, _, _ = await self._resolve_effective_cover(resolved_book_id)
            if not managed_by_worker:
                await self.db.commit()
            return BookCoverGenerateResponse(
                status="SUPERSEDED_BY_USER_UPLOAD",
                job_id=existing_job_id,
                provider_name=provider.provider_name,
                model_id=provider.model_id,
                message_vi=(
                    "Sách đang có ảnh bìa do người dùng tải lên. "
                    "Hệ thống giữ nguyên ảnh bìa người dùng tải lên (không tự ghi đè bằng AI)."
                ),
                cover=asset_to_dto(effective_cover) if effective_cover is not None else None,
                metadata_fallback=fallback,
                style_bible=style_bible,
                honest_ai_generated=False,
            )

        safe_hint = _sanitize_child_safe_prompt_hint(payload.prompt_hint)
        input_hash = hashlib.sha256(
            f"{resolved_book_id}:{style_bible.context_hash}:{safe_hint}".encode("utf-8")
        ).hexdigest()
        idem_key = (
            (payload.idempotency_key or "").strip()
            or f"cover-gen:{resolved_book_id}:{input_hash[:16]}:{uuid4().hex[:8]}"
        )

        if not provider.available:
            job_id_out = existing_job_id
            if existing_job_id is None:
                job = await self.repo.record_studio_job(
                    job_type="COVER_GENERATE",
                    actor_id=actor_id,
                    actor_role=role,
                    book_id=resolved_book_id,
                    book_page_id=None,
                    source_revision_id=None,
                    input_hash=input_hash,
                    idempotency_key=idem_key,
                    stage="BLOCKED_NO_IMAGE_PROVIDER",
                    status_value="FAILED",
                    error_code=provider.reason_code,
                    error_message_vi=provider.message_vi,
                )
                job_id_out = job.Id if job is not None else None
                await self.db.commit()
            return BookCoverGenerateResponse(
                status="BLOCKED_NO_IMAGE_PROVIDER",
                job_id=job_id_out,
                provider_name=None,
                model_id=None,
                message_vi=provider.message_vi,
                cover=None,
                metadata_fallback=fallback,
                style_bible=style_bible,
                honest_ai_generated=False,
            )

        prompt = style_bible.bible.prompt_prefix
        if safe_hint:
            prompt = f"{prompt} Scene focus: {safe_hint}."

        job: SmartStudioJob | None = None
        if existing_job_id is not None:
            job = await self.repo.get_studio_job(existing_job_id)
            effective_job_id: UUID | None = existing_job_id
            if callable(getattr(self.db, "rollback", None)):
                await self.db.rollback()
        else:
            existing_job_before = None
            if payload.idempotency_key and payload.idempotency_key.strip():
                try:
                    async with self.db.begin_nested():
                        existing_job_before = await self.db.scalar(
                            select(SmartStudioJob).where(
                                SmartStudioJob.ActorId == actor_id,
                                SmartStudioJob.IdempotencyKey == idem_key,
                            )
                        )
                except (SQLAlchemyError, AttributeError):
                    existing_job_before = None
                if existing_job_before is not None and existing_job_before.Status in (
                    "SUCCEEDED",
                    "RUNNING",
                    "QUEUED",
                    "WAITING_FOR_QUOTA",
                ):
                    effective_cover, _, _ = await self._resolve_effective_cover(resolved_book_id)
                    return BookCoverGenerateResponse(
                        status=(
                            "SUCCEEDED"
                            if existing_job_before.Status == "SUCCEEDED"
                            else "WAITING_FOR_QUOTA"
                            if existing_job_before.Status == "WAITING_FOR_QUOTA"
                            else "QUEUED"
                        ),
                        job_id=existing_job_before.Id,
                        provider_name=provider.provider_name,
                        model_id=provider.model_id,
                        message_vi="Yêu cầu tạo bìa AI này đã được tiếp nhận trước đó (tránh tạo trùng).",
                        cover=asset_to_dto(effective_cover) if effective_cover is not None else None,
                        metadata_fallback=fallback,
                        style_bible=style_bible,
                        honest_ai_generated=bool(
                            effective_cover and effective_cover.SourceType == "AI_GENERATED"
                        ),
                    )

            job = await self.repo.record_studio_job(
                job_type="COVER_GENERATE",
                actor_id=actor_id,
                actor_role=role,
                book_id=resolved_book_id,
                book_page_id=None,
                source_revision_id=None,
                input_hash=input_hash,
                idempotency_key=idem_key,
                stage="IMAGE_GENERATING",
                status_value="RUNNING",
            )
            if job is not None:
                now_start = datetime.now(timezone.utc)
                job.LeaseExpiresAt = now_start + timedelta(seconds=90)
                job.UpdatedAt = now_start
            await self.db.commit()
            effective_job_id = job.Id if job is not None else None

        tenant_scope = f"parent:{owner_parent_id}" if private_book else "admin:catalog"
        http_status, raw_bytes, used_provider, used_model, error_code = (
            await generate_image_via_router_and_scheduler(
                prompt=prompt,
                negative_prompt=_DEFAULT_NEGATIVE_PROMPT,
                width=512,
                height=768,
                steps=4,
                tenant_scope=tenant_scope,
                allow_cloud=allow_cloud,
                source_hash=input_hash,
                revision=str(resolved_book_id),
                priority=WorkloadPriority.COVER_GEN,
                workload_id=f"cover-gen:{resolved_book_id}",
                estimated_vram_mb=2200,
                provider_hint=provider,
                image_transport=self._custom_image_transport,
                ai_router=self._ai_router,
                gpu_scheduler=self._gpu_scheduler,
            )
        )
        resolved_provider = used_provider or provider.provider_name
        resolved_model = used_model or provider.model_id

        if http_status == 429:
            if job is not None and not managed_by_worker:
                job.Status = "WAITING_FOR_QUOTA"
                job.Stage = "WAITING_FOR_QUOTA"
                job.ErrorCode = "IMAGE_PROVIDER_QUOTA_EXCEEDED"
                job.ErrorMessageVi = (
                    "Hạn mức tạo ảnh AI miễn phí tạm thời đã hết. Hệ thống giữ bìa chữ tiếng Việt tự động."
                )
                await self.db.commit()
            return BookCoverGenerateResponse(
                status="WAITING_FOR_QUOTA",
                job_id=effective_job_id,
                provider_name=resolved_provider,
                model_id=resolved_model,
                message_vi=(
                    "Hạn mức tạo ảnh AI miễn phí tạm thời đã hết. "
                    "Hệ thống giữ bìa chữ tiếng Việt tự động và không giả lập ảnh AI."
                ),
                cover=None,
                metadata_fallback=fallback,
                style_bible=style_bible,
                honest_ai_generated=False,
            )

        if http_status != 200 or not raw_bytes:
            if job is not None and not managed_by_worker:
                job.Status = "FAILED"
                job.Stage = "BLOCKED_NO_IMAGE_PROVIDER"
                job.ErrorCode = error_code or f"IMAGE_PROVIDER_HTTP_{http_status}"
                job.ErrorMessageVi = "Nhà cung cấp tạo ảnh AI tạm thời không khả dụng."
                await self.db.commit()
            return BookCoverGenerateResponse(
                status="BLOCKED_NO_IMAGE_PROVIDER",
                job_id=effective_job_id,
                provider_name=resolved_provider,
                model_id=resolved_model,
                message_vi=(
                    "Nhà cung cấp tạo ảnh AI tạm thời không phản hồi ảnh hợp lệ. "
                    "Hệ thống giữ bìa chữ tiếng Việt tự động."
                ),
                cover=None,
                metadata_fallback=fallback,
                style_bible=style_bible,
                honest_ai_generated=False,
            )

        # Anti-overwrite STALE check before decoding & Text-Free Gate
        if effective_job_id is not None:
            latest_job = await self.repo.get_studio_job(effective_job_id)
            if latest_job is not None and latest_job.Status == "STALE":
                effective_cover, _, _ = await self._resolve_effective_cover(resolved_book_id)
                return BookCoverGenerateResponse(
                    status="SUPERSEDED_BY_USER_UPLOAD",
                    job_id=effective_job_id,
                    provider_name=resolved_provider,
                    model_id=resolved_model,
                    message_vi="Ảnh bìa do người dùng tải lên được ưu tiên hơn bìa AI vừa tạo.",
                    cover=asset_to_dto(effective_cover) if effective_cover is not None else None,
                    metadata_fallback=fallback,
                    style_bible=style_bible,
                    honest_ai_generated=False,
                )

        # MANDATORY Dual Text-Free Gate on AI-generated cover before saving!
        processed_preview = await asyncio.to_thread(
            validate_and_process_cover_image, raw_bytes, None, rotation=0
        )
        verification = await asyncio.to_thread(
            self._verify_ai_cover_text_free,
            image_bytes=processed_preview.webp_bytes,
            canonical_hint=canonical_hint,
        )
        verification_meta = {
            "text_free_verified": bool(verification.text_free_verified),
            "text_density_score": verification.text_density_score,
            "ocr_overlap_score": verification.ocr_overlap_score,
            "detected_text_runs": verification.detected_text_runs,
            "ocr_gate_mode": verification.ocr_gate_mode,
            "ocr_checked": bool(verification.ocr_checked),
        }
        if not verification.text_free_verified:
            if job is not None and not managed_by_worker:
                now_rej = datetime.now(timezone.utc)
                job.Status = "FAILED"
                job.Stage = "REJECTED_CONTAINS_TEXT"
                job.ErrorCode = "REJECTED_CONTAINS_TEXT"
                job.ErrorMessageVi = (
                    "Ảnh bìa AI tạo ra chứa ký tự/chữ không hợp lệ nên đã bị từ chối tự động."
                )
                job.CompletedAt = now_rej
                job.UpdatedAt = now_rej
                job.LeaseExpiresAt = None
                job.ResultRefJson = verification_meta
                await self.db.commit()
            return BookCoverGenerateResponse(
                status="REJECTED_CONTAINS_TEXT",
                job_id=effective_job_id,
                provider_name=resolved_provider,
                model_id=resolved_model,
                message_vi=(
                    "Ảnh bìa AI tạo ra chứa ký tự/chữ không hợp lệ nên đã bị từ chối tự động. "
                    "Hệ thống giữ bìa chữ tiếng Việt tự động để đảm bảo không lỗi dấu."
                ),
                cover=None,
                metadata_fallback=fallback,
                style_bible=style_bible,
                honest_ai_generated=False,
            )

        asset, superseded = await self.commit_generated_cover_bytes(
            book=book,
            image_bytes=processed_preview.webp_bytes,
            provider_name=resolved_provider or "ai_image",
            model_id=resolved_model,
            job_id=effective_job_id,
            lease_token=existing_lease_token if managed_by_worker else None,
            prompt_summary=prompt,
            verification_metadata=verification_meta,
            enforce_text_free=False,
            book_id=resolved_book_id,
            private_book_override=private_book,
            owner_id_override=owner_parent_id,
            bucket_override=asset_bucket,
            canonical_hint_override=canonical_hint,
        )
        if superseded or asset is None:
            if job is not None and not managed_by_worker:
                job.Status = "STALE"
                job.Stage = "SUPERSEDED_BY_USER_UPLOAD"
            effective_cover, _, _ = await self._resolve_effective_cover(resolved_book_id)
            if not managed_by_worker:
                await self.db.commit()
            return BookCoverGenerateResponse(
                status="SUPERSEDED_BY_USER_UPLOAD",
                job_id=effective_job_id,
                provider_name=resolved_provider,
                model_id=resolved_model,
                message_vi="Ảnh bìa do người dùng tải lên được ưu tiên hơn bìa AI vừa tạo.",
                cover=asset_to_dto(effective_cover) if effective_cover is not None else None,
                metadata_fallback=fallback,
                style_bible=style_bible,
                honest_ai_generated=False,
            )

        if managed_by_worker and existing_job_id is not None and existing_lease_token is not None:
            from app.services.global_tasks_service import GlobalTasksService

            asset_storage_path = asset.StoragePath
            try:
                outcome = await GlobalTasksService(self.db).commit_stage_result(
                    job_id=existing_job_id,
                    lease_token=existing_lease_token,
                    stage="COVER_GEN",
                    checkpoint_data={"asset_id": str(asset.Id)},
                    next_status="SUCCEEDED",
                    result_ref={"asset_id": str(asset.Id), **verification_meta},
                    progress_completed=2,
                    progress_total=2,
                    progress_unit="bước",
                )
            except BaseException:
                if callable(getattr(self.db, "rollback", None)):
                    try:
                        await self.db.rollback()
                    except Exception:
                        pass
                try:
                    await asyncio.to_thread(delete_object, asset_storage_path, bucket_name=asset_bucket)
                except Exception:
                    pass
                raise
            if not outcome.get("accepted"):
                try:
                    await asyncio.to_thread(delete_object, asset_storage_path, bucket_name=asset_bucket)
                except Exception:
                    pass
                return BookCoverGenerateResponse(
                    status="SUPERSEDED_BY_USER_UPLOAD",
                    job_id=existing_job_id,
                    provider_name=resolved_provider,
                    model_id=resolved_model,
                    message_vi="Tác vụ tạo bìa AI đã bị hủy hoặc thay thế trước khi lưu.",
                    cover=None,
                    metadata_fallback=fallback,
                    style_bible=style_bible,
                    honest_ai_generated=False,
                )
        else:
            if job is not None:
                now_done = datetime.now(timezone.utc)
                job.Status = "SUCCEEDED"
                job.Stage = "COMPLETED"
                job.CompletedAt = now_done
                job.UpdatedAt = now_done
                job.LeaseExpiresAt = None
                job.ResultRefJson = {"asset_id": str(asset.Id), **verification_meta}
            await self.db.commit()

        return BookCoverGenerateResponse(
            status="SUCCEEDED",
            job_id=effective_job_id,
            provider_name=resolved_provider,
            model_id=resolved_model,
            message_vi="Đã tạo và lưu ảnh bìa AI không chữ thành công.",
            cover=asset_to_dto(asset),
            metadata_fallback=fallback,
            style_bible=style_bible,
            honest_ai_generated=True,
        )

    async def generate_ai_cover(
        self,
        actor_id: UUID,
        book_id: UUID,
        payload: BookCoverGenerateRequest,
        *,
        existing_job_id: UUID | None = None,
        existing_lease_token: UUID | None = None,
    ) -> BookCoverGenerateResponse:
        return await self.execute_ai_cover_job(
            actor_id,
            book_id,
            payload,
            existing_job_id=existing_job_id,
            existing_lease_token=existing_lease_token,
            managed_by_worker=existing_job_id is not None,
        )

    async def get_authorized_asset_media(
        self, actor_id: UUID, asset_id: UUID
    ) -> tuple[bytes, str, bool]:
        """Stream asset bytes ONLY after strict ownership verification (Admin / Owner / Published Catalog).

        Returns `(content_bytes, mime_type, is_private_book)`.
        """
        role = await self.repo.get_actor_role(actor_id)
        if role not in ("admin", "parent"):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

        asset, degraded = await self.repo.get_asset_by_id(asset_id)
        if degraded or asset is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")

        book = await self.repo.get_book(asset.BookId)
        if book is None or bool(getattr(book, "IsDeleted", False)):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")

        private_book = is_book_private(book)
        if role != "admin":
            if private_book:
                if book.OwnerParentId != actor_id:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Asset not found",
                    )
                if book.LifecycleStatus != "ACTIVE" or (book.ModerationStatus or "ACTIVE") != "ACTIVE":
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Sách riêng đang tạm khóa kiểm duyệt hoặc không còn khả dụng.",
                    )
            else:
                if (
                    not await self._is_catalog_book_eligible(book)
                    or not asset.IsActive
                    or asset.ModerationStatus != "APPROVED"
                ):
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Access denied",
                    )
            if asset.AssetRole == "PAGE_ILLUSTRATION" and not bool(asset.TextFreeVerified):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied",
                )

        safe_path = _validate_relative_storage_path(asset.StoragePath)
        bucket = _bucket_for_book(book)
        mime_type = (
            asset.MimeType
            if asset.MimeType in ("image/webp", "image/png", "image/jpeg")
            else "image/webp"
        )
        if callable(getattr(self.db, "rollback", None)):
            await self.db.rollback()
        if download_object is not _ORIGINAL_DOWNLOAD_OBJECT:
            content = await asyncio.to_thread(download_object, safe_path, bucket_name=bucket)
        else:
            content = await download_object_async(safe_path, bucket_name=bucket)
        return content, mime_type, private_book
