from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Sequence
from urllib.parse import quote, urlsplit

import requests
from fastapi import HTTPException, status

from app.database.config import (
    APP_ENVIRONMENT,
    SUPABASE_ADMIN_KEY,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_URL,
    supabase_admin_headers,
)
from app.database.supabase_client import get_supabase_admin_client
from app.diagnostic_logging import log_diagnostic
from app.services.runtime_diagnostics import runtime_configuration_diagnostics

logger = logging.getLogger(__name__)
SIGNED_URL_TTL_SECONDS = 3600
SIGNED_URL_CACHE_TTL_SECONDS = 1200.0  # 20 minutes (< 60m signed TTL)
SIGNED_URL_CACHE_MAX_ENTRIES = 2048

_signed_url_cache_lock = threading.Lock()
_signed_url_cache: "OrderedDict[tuple[str, str, int], tuple[float, str]]" = OrderedDict()


def clear_signed_url_cache() -> None:
    """Reset bounded in-memory signed URL cache (used by tests)."""
    with _signed_url_cache_lock:
        _signed_url_cache.clear()


def invalidate_signed_url_cache(
    object_path: str,
    *,
    bucket_name: str | None = None,
) -> None:
    """Evict cached signed URLs for a mutated or deleted Storage object."""
    bucket_key = (bucket_name or SUPABASE_STORAGE_BUCKET or "").strip()
    with _signed_url_cache_lock:
        keys = [
            key
            for key in _signed_url_cache
            if key[1] == object_path and (not bucket_key or key[0] == bucket_key)
        ]
        for key in keys:
            _signed_url_cache.pop(key, None)


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


def _bucket_name(bucket_name: str | None = None) -> str:
    value = (bucket_name or SUPABASE_STORAGE_BUCKET or "").strip()
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


def _storage_bucket(bucket_name: str | None = None):
    bucket_name = _bucket_name(bucket_name)
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


def _local_storage_path(object_path: str, bucket_name: str | None = None) -> Path | None:
    """Isolated local filesystem storage for test/local runs only (never production)."""
    if APP_ENVIRONMENT == "production":
        return None
    raw_root = (os.getenv("VIREAD_LOCAL_STORAGE_DIR") or "").strip()
    if not raw_root:
        return None
    normalized_bucket = (bucket_name or SUPABASE_STORAGE_BUCKET or "default").strip()
    if not normalized_bucket or "/" in normalized_bucket or "\\" in normalized_bucket or ".." in normalized_bucket:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase Storage is not configured",
        )
    if not object_path or object_path.startswith(("/", "\\", "http://", "https://")) or ".." in object_path.split("/"):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The stored image is not a Storage object path",
        )
    base = (Path(raw_root).resolve() / normalized_bucket).resolve()
    target = (base / object_path).resolve()
    if not target.is_relative_to(base):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The stored image is not a Storage object path",
        )
    return target


def upload_object(
    object_path: str,
    data: bytes,
    content_type: str,
    *,
    bucket_name: str | None = None,
    upsert: bool = False,
) -> None:
    local_target = _local_storage_path(object_path, bucket_name)
    if local_target is not None:
        local_target.parent.mkdir(parents=True, exist_ok=True)
        if not upsert and local_target.exists():
            raise StorageUploadFailure(
                "Could not save the image to Supabase Storage",
                cleanup_may_be_needed=False,
            )
        local_target.write_bytes(data)
        return
    # Separate config/client initialization from the actual remote write. If this
    # fails, Storage was never asked to create an object and cleanup is pointless.
    bucket = _storage_bucket() if bucket_name is None else _storage_bucket(bucket_name)
    try:
        bucket.upload(
            object_path,
            data,
            file_options={"content-type": content_type, "upsert": "true" if upsert else "false"},
        )
        invalidate_signed_url_cache(object_path, bucket_name=bucket_name)
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
            include_traceback=cleanup_may_be_needed,
            **runtime_configuration_diagnostics(include_ocr=False),
        )
        raise StorageUploadFailure(
            detail,
            cleanup_may_be_needed=cleanup_may_be_needed,
        ) from exc


def delete_object(object_path: str, *, bucket_name: str | None = None) -> None:
    try:
        local_target = _local_storage_path(object_path, bucket_name)
        if local_target is not None:
            if local_target.is_file():
                local_target.unlink()
            return
        bucket = _storage_bucket() if bucket_name is None else _storage_bucket(bucket_name)
        bucket.remove([object_path])
        invalidate_signed_url_cache(object_path, bucket_name=bucket_name)
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


def download_object(object_path: str, *, bucket_name: str | None = None) -> bytes:
    if not object_path or object_path.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The stored image is not a Storage object path",
        )
    local_target = _local_storage_path(object_path, bucket_name)
    if local_target is not None:
        if not local_target.is_file():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Could not read the image from Supabase Storage",
            ) from FileNotFoundError(object_path)
        data = local_target.read_bytes()
        if not data:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Could not read the image from Supabase Storage",
            )
        return data
    try:
        bucket = _storage_bucket() if bucket_name is None else _storage_bucket(bucket_name)
        result = bucket.download(object_path)
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


def hash_storage_object(object_path: str, aggregate_digest: object | None = None) -> tuple[str, int]:
    """Hash a private Storage object without buffering the full object in memory.

    ``aggregate_digest`` may be a hashlib digest updated with the same streamed
    bytes, allowing callers to verify both each shard and the assembled file.
    """
    if not object_path or object_path.startswith(("/", "http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The stored checkpoint is not a Storage object path",
        )
    bucket_name = _bucket_name()
    if not SUPABASE_URL or not SUPABASE_ADMIN_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server-side Supabase Storage credentials are not configured",
        )

    url = (
        f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/authenticated/"
        f"{quote(bucket_name, safe='')}/{quote(object_path, safe='/')}"
    )
    headers = supabase_admin_headers(SUPABASE_ADMIN_KEY)
    digest = hashlib.sha256()
    total_bytes = 0
    try:
        with requests.get(url, headers=headers, stream=True, timeout=(10, 120)) as response:
            response.raise_for_status()
            for block in response.iter_content(chunk_size=1024 * 1024):
                if not block:
                    continue
                digest.update(block)
                if aggregate_digest is not None:
                    aggregate_digest.update(block)
                total_bytes += len(block)
        if total_bytes <= 0:
            raise ValueError("empty Storage object")
        return digest.hexdigest(), total_bytes
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
            detail="Could not verify the checkpoint in Supabase Storage",
        ) from exc


_SIGN_BATCH_SIZE = 50


def _validate_image_reference(image_path: str | None) -> tuple[bool, str]:
    """Return `(is_external_url, clean_reference)` or raise 503 for invalid paths."""
    if not isinstance(image_path, str) or not image_path.strip():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stored image reference is invalid",
        )
    if image_path.startswith(("https://", "http://")):
        try:
            parsed = urlsplit(image_path)
            parsed.port  # Validate malformed port values without exposing the URL.
            if parsed.hostname and not parsed.username and not parsed.password:
                return True, image_path  # Legacy references remain readable; new writes store object paths.
        except ValueError:
            pass
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stored image reference is invalid",
        )
    return False, image_path


def _normalize_signed_url(signed: object) -> str:
    if not isinstance(signed, str) or not signed:
        raise ValueError("Storage did not return a signed URL")
    if signed.startswith(("https://", "http://")):
        return signed
    if not SUPABASE_URL:
        raise ValueError("Supabase URL is not configured")
    if signed.startswith("/storage/v1/"):
        return f"{SUPABASE_URL.rstrip('/')}{signed}"
    return f"{SUPABASE_URL.rstrip('/')}/storage/v1{signed if signed.startswith('/') else '/' + signed}"


def is_local_storage_enabled() -> bool:
    """Return True when local disk storage is enabled outside production."""
    return APP_ENVIRONMENT != "production" and bool((os.getenv("VIREAD_LOCAL_STORAGE_DIR") or "").strip())


def create_signed_image_url(
    image_path: str | None,
    *,
    bucket_name: str | None = None,
    ttl_seconds: int | None = None,
) -> str:
    is_external, validated = _validate_image_reference(image_path)
    if is_external:
        return validated
    effective_ttl = max(30, int(ttl_seconds if ttl_seconds is not None else SIGNED_URL_TTL_SECONDS))
    try:
        bucket = _storage_bucket() if bucket_name is None else _storage_bucket(bucket_name)
        result = bucket.create_signed_url(validated, effective_ttl)
        signed = result.get("signedURL") or result.get("signedUrl") or result.get("signed_url")
        return _normalize_signed_url(signed)
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


def create_signed_image_urls(
    image_paths: Sequence[str | None],
    *,
    bucket_name: str | None = None,
    max_workers: int = 8,
    ttl_seconds: int | None = None,
) -> list[str]:
    """Batch-sign Storage image paths in order, avoiding N sequential HTTP round-trips."""
    if not image_paths:
        return []

    effective_ttl = max(30, int(ttl_seconds if ttl_seconds is not None else SIGNED_URL_TTL_SECONDS))
    validated_refs = [_validate_image_reference(path) for path in image_paths]
    unique_relative_paths = list(
        dict.fromkeys(ref for is_ext, ref in validated_refs if not is_ext)
    )
    if not unique_relative_paths:
        return [ref for _, ref in validated_refs]

    try:
        bucket = _storage_bucket() if bucket_name is None else _storage_bucket(bucket_name)
        signed_by_path: dict[str, str] = {}

        def _sign_single(path: str) -> tuple[str, str]:
            result = bucket.create_signed_url(path, effective_ttl)
            signed = (
                result.get("signedURL")
                or result.get("signedUrl")
                or result.get("signed_url")
            )
            return path, _normalize_signed_url(signed)

        def _sign_chunk(chunk: list[str]) -> dict[str, str]:
            chunk_map: dict[str, str] = {}
            batch_fn = getattr(bucket, "create_signed_urls", None)
            if callable(batch_fn):
                try:
                    batch_res = batch_fn(chunk, effective_ttl)
                    if isinstance(batch_res, list):
                        for idx, item in enumerate(batch_res):
                            if not isinstance(item, dict) or item.get("error"):
                                continue
                            item_path = item.get("path")
                            if not isinstance(item_path, str) or not item_path:
                                if len(batch_res) == len(chunk):
                                    item_path = chunk[idx]
                                else:
                                    continue
                            raw_signed = (
                                item.get("signedURL")
                                or item.get("signedUrl")
                                or item.get("signed_url")
                            )
                            if isinstance(raw_signed, str) and raw_signed:
                                chunk_map[item_path] = _normalize_signed_url(raw_signed)
                except (AttributeError, NotImplementedError, TypeError):
                    pass

            missing = [path for path in chunk if path not in chunk_map]
            if missing:
                if len(missing) == 1:
                    p, u = _sign_single(missing[0])
                    chunk_map[p] = u
                else:
                    workers = max(1, min(max_workers, len(missing)))
                    with ThreadPoolExecutor(max_workers=workers) as executor:
                        for p, u in executor.map(_sign_single, missing):
                            chunk_map[p] = u
            return chunk_map

        chunks = [
            unique_relative_paths[i : i + _SIGN_BATCH_SIZE]
            for i in range(0, len(unique_relative_paths), _SIGN_BATCH_SIZE)
        ]
        if len(chunks) == 1:
            signed_by_path.update(_sign_chunk(chunks[0]))
        else:
            chunk_workers = max(1, min(4, len(chunks)))
            with ThreadPoolExecutor(max_workers=chunk_workers) as executor:
                for chunk_result in executor.map(_sign_chunk, chunks):
                    signed_by_path.update(chunk_result)

        return [
            ref if is_ext else signed_by_path[ref]
            for is_ext, ref in validated_refs
        ]
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


def create_cached_signed_image_urls(
    image_paths: Sequence[str | None],
    *,
    bucket_name: str | None = None,
    max_workers: int = 8,
    ttl_seconds: int | None = None,
    cache_ttl_seconds: float = SIGNED_URL_CACHE_TTL_SECONDS,
) -> list[str]:
    """Batch-sign Storage paths with a bounded 20-minute server in-memory TTL cache."""
    if not image_paths:
        return []

    effective_ttl = max(
        30, int(ttl_seconds if ttl_seconds is not None else SIGNED_URL_TTL_SECONDS)
    )
    effective_cache_ttl = max(
        0.0, min(float(cache_ttl_seconds), max(0.0, effective_ttl - 60.0))
    )
    bucket_key = (bucket_name or SUPABASE_STORAGE_BUCKET or "").strip()
    validated_refs = [_validate_image_reference(path) for path in image_paths]

    now = time.monotonic()
    resolved_by_path: dict[str, str] = {}
    missing_paths: list[str] = []

    if effective_cache_ttl > 0.0:
        with _signed_url_cache_lock:
            for is_ext, ref in validated_refs:
                if is_ext or ref in resolved_by_path:
                    continue
                cache_key = (bucket_key, ref, effective_ttl)
                cached = _signed_url_cache.get(cache_key)
                if cached is not None:
                    expires_at, signed_url = cached
                    if expires_at > now:
                        _signed_url_cache.move_to_end(cache_key)
                        resolved_by_path[ref] = signed_url
                        continue
                    _signed_url_cache.pop(cache_key, None)
                if ref not in missing_paths:
                    missing_paths.append(ref)
    else:
        missing_paths = list(
            dict.fromkeys(ref for is_ext, ref in validated_refs if not is_ext)
        )

    if missing_paths:
        freshly_signed = create_signed_image_urls(
            missing_paths,
            bucket_name=bucket_name,
            max_workers=max_workers,
            ttl_seconds=effective_ttl,
        )
        expires_at = time.monotonic() + effective_cache_ttl
        with _signed_url_cache_lock:
            for path, signed_url in zip(missing_paths, freshly_signed):
                resolved_by_path[path] = signed_url
                if effective_cache_ttl > 0.0:
                    cache_key = (bucket_key, path, effective_ttl)
                    _signed_url_cache[cache_key] = (expires_at, signed_url)
                    _signed_url_cache.move_to_end(cache_key)
            while len(_signed_url_cache) > SIGNED_URL_CACHE_MAX_ENTRIES:
                _signed_url_cache.popitem(last=False)

    return [
        ref if is_ext else resolved_by_path[ref]
        for is_ext, ref in validated_refs
    ]
