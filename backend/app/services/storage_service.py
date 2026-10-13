from __future__ import annotations

import logging
import re
from urllib.parse import urlsplit

from fastapi import HTTPException, status

from app.database.config import SUPABASE_ADMIN_KEY, SUPABASE_STORAGE_BUCKET, SUPABASE_URL
from app.database.supabase_client import get_supabase_admin_client
from app.diagnostic_logging import log_diagnostic
from app.services.runtime_diagnostics import runtime_configuration_diagnostics

logger = logging.getLogger(__name__)
SIGNED_URL_TTL_SECONDS = 3600


class StorageUploadFailure(HTTPException):
    """Safe HTTP error plus whether an uncertain Storage write may need cleanup."""

    def __init__(self, detail: str, *, cleanup_may_be_needed: bool) -> None:
        super().__init__(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail)
        self.cleanup_may_be_needed = cleanup_may_be_needed


def _safe_numeric_status(exc: Exception) -> int | None:
    value = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if value is None:
        response = getattr(exc, "response", None)
        value = getattr(response, "status_code", None)
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        if isinstance(value, str):
            match = re.match(r"^\s*(\d{3})\b", value)
            if not match:
                return None
            parsed = int(match.group(1))
        else:
            return None
    return parsed if 100 <= parsed <= 599 else None


def _safe_error_code(exc: Exception) -> str | None:
    value = getattr(exc, "code", None)
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", value):
        return value
    return None


def _bucket_name() -> str:
    value = (SUPABASE_STORAGE_BUCKET or "").strip()
    if not value:
        diagnostics = runtime_configuration_diagnostics(include_ocr=False)
        log_diagnostic(
            logger,
            logging.WARNING,
            event="storage_configuration_missing",
            stage="storage_configuration",
            **diagnostics,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase Storage is not configured",
        )
    return value


def _storage_bucket():
    bucket_name = _bucket_name()
    if not SUPABASE_ADMIN_KEY:
        diagnostics = runtime_configuration_diagnostics(include_ocr=False)
        log_diagnostic(
            logger,
            logging.WARNING,
            event="storage_server_key_missing",
            stage="storage_configuration",
            **diagnostics,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server-side Supabase Storage credentials are not configured",
        )
    try:
        client = get_supabase_admin_client()
        if client is None:
            raise RuntimeError("server-side Supabase client initialization returned no client")
        return client.storage.from_(bucket_name)
    except HTTPException:
        raise
    except Exception as exc:
        diagnostics = runtime_configuration_diagnostics(include_ocr=False)
        log_diagnostic(
            logger,
            logging.ERROR,
            event="storage_client_initialization_failed",
            stage="storage_configuration",
            exception=exc,
            supabase_url_configured=diagnostics["supabase_url_configured"],
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase Storage client initialization failed; check the server configuration",
        ) from exc


def _upload_failure_detail(http_status: int | None, error_code: str | None) -> str:
    normalized_code = (error_code or "").lower()
    if http_status == 404 or normalized_code in {"bucketnotfound", "no_such_bucket"}:
        return "Supabase Storage bucket was not found; verify SUPABASE_STORAGE_BUCKET in the configured project"
    if http_status in {401, 403} or normalized_code in {"unauthorized", "accessdenied", "forbidden"}:
        return "Supabase Storage rejected the server credentials or upload permission"
    return "Could not save the image to Supabase Storage"


def upload_object(object_path: str, data: bytes, content_type: str) -> None:
    # Separate config/client initialization from the actual remote write. If this
    # fails, Storage was never asked to create an object and cleanup is pointless.
    bucket = _storage_bucket()
    try:
        bucket.upload(
            object_path,
            data,
            file_options={"content-type": content_type, "upsert": "false"},
        )
    except Exception as exc:
        http_status = _safe_numeric_status(exc)
        error_code = _safe_error_code(exc)
        # Definite 4xx rejection means the object was not accepted. Network
        # failures and 5xx may be ambiguous: the server may have stored the object
        # before the client observed a failure, so the caller should try cleanup.
        cleanup_may_be_needed = http_status is None or http_status >= 500 or http_status in {408, 425, 429}
        detail = _upload_failure_detail(http_status, error_code)
        log_diagnostic(
            logger,
            logging.ERROR,
            event="storage_upload_failed",
            stage="storage_upload",
            exception=exc,
            error_code=error_code,
            upstream_http_status=http_status,
            cleanup_may_be_needed=cleanup_may_be_needed,
            **runtime_configuration_diagnostics(include_ocr=False),
        )
        raise StorageUploadFailure(
            detail,
            cleanup_may_be_needed=cleanup_may_be_needed,
        ) from exc


def delete_object(object_path: str) -> None:
    try:
        _storage_bucket().remove([object_path])
        log_diagnostic(
            logger,
            logging.INFO,
            event="storage_cleanup_completed",
            stage="cleanup",
        )
    except Exception as exc:
        # Cleanup is best-effort. Log safe metadata and never replace the original failure.
        log_diagnostic(
            logger,
            logging.WARNING,
            event="storage_cleanup_failed",
            stage="cleanup",
            exception=exc,
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
        log_diagnostic(
            logger,
            logging.ERROR,
            event="storage_download_failed",
            stage="storage_download",
            exception=exc,
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
        log_diagnostic(
            logger,
            logging.ERROR,
            event="storage_signed_url_failed",
            stage="storage_preview",
            exception=exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not create an image preview URL",
        ) from exc
