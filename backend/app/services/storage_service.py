from __future__ import annotations

import logging
import os
import re
from urllib.parse import urlsplit

from fastapi import HTTPException, status

from app.database.config import SUPABASE_URL
from app.database.supabase_client import get_supabase_admin_client

logger = logging.getLogger(__name__)
SIGNED_URL_TTL_SECONDS = 3600


def _safe_numeric_status(exc: Exception) -> int | None:
    value = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if 100 <= parsed <= 599 else None


def _safe_error_code(exc: Exception) -> str | None:
    value = getattr(exc, "code", None)
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,40}", value):
        return value
    return None


def _bucket_name() -> str:
    value = (os.getenv("SUPABASE_STORAGE_BUCKET") or "").strip()
    if not value:
        logger.warning("Supabase Storage configuration missing: SUPABASE_STORAGE_BUCKET is empty")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase Storage is not configured",
        )
    return value


def _storage_bucket():
    bucket_name = _bucket_name()
    try:
        client = get_supabase_admin_client()
        if client is None:
            logger.warning(
                "Supabase Storage configuration missing: no server-side key is configured"
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Server-side Supabase Storage credentials are not configured",
            )
        return client.storage.from_(bucket_name)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Supabase Storage client initialization failed (exception_type=%s, status_code=%s)",
            type(exc).__name__,
            _safe_numeric_status(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase Storage client initialization failed; check the server configuration",
        ) from exc


def upload_object(object_path: str, data: bytes, content_type: str) -> None:
    try:
        _storage_bucket().upload(
            object_path,
            data,
            file_options={"content-type": content_type, "upsert": "false"},
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Supabase Storage upload failed (exception_type=%s, status_code=%s, error_code=%s)",
            type(exc).__name__,
            _safe_numeric_status(exc),
            _safe_error_code(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not save the image to Supabase Storage",
        ) from exc


def delete_object(object_path: str) -> None:
    try:
        _storage_bucket().remove([object_path])
    except Exception as exc:
        # Cleanup is best-effort. Log only safe metadata and never replace the original failure.
        logger.warning(
            "Supabase Storage cleanup failed (exception_type=%s, status_code=%s)",
            type(exc).__name__,
            _safe_numeric_status(exc),
        )
        return


def download_object(object_path: str) -> bytes:
    if not object_path or object_path.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The stored image is not a Storage object path",
        )
    try:
        result = _storage_bucket().download(object_path)
        if not isinstance(result, (bytes, bytearray)) or not result:
            raise ValueError("empty Storage object")
        return bytes(result)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Supabase Storage download failed (exception_type=%s, status_code=%s, error_code=%s)",
            type(exc).__name__,
            _safe_numeric_status(exc),
            _safe_error_code(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not read the image from Supabase Storage",
        ) from exc


def create_signed_image_url(image_path: str | None) -> str:
    if not isinstance(image_path, str) or not image_path.strip():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Stored image reference is invalid")
    if image_path.startswith(("https://", "http://")):
        try:
            parsed = urlsplit(image_path)
            parsed.port  # Validate malformed port values without exposing the URL.
            if parsed.hostname and not parsed.username and not parsed.password:
                return image_path  # Legacy references remain readable; new writes store object paths.
        except ValueError:
            pass
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Stored image reference is invalid")
    try:
        result = _storage_bucket().create_signed_url(image_path, SIGNED_URL_TTL_SECONDS)
        signed = result.get("signedURL") or result.get("signedUrl") or result.get("signed_url")
        if not isinstance(signed, str) or not signed:
            raise ValueError("Storage did not return a signed URL")
        if signed.startswith(("https://", "http://")):
            return signed
        if not SUPABASE_URL:
            raise ValueError("Supabase URL is not configured")
        if signed.startswith("/storage/v1/"):
            return f"{SUPABASE_URL.rstrip('/')}{signed}"
        return f"{SUPABASE_URL.rstrip('/')}/storage/v1{signed if signed.startswith('/') else '/' + signed}"
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "Supabase signed URL creation failed (exception_type=%s, status_code=%s, error_code=%s)",
            type(exc).__name__,
            _safe_numeric_status(exc),
            _safe_error_code(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not create an image preview URL",
        ) from exc
