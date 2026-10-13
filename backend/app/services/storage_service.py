from __future__ import annotations

from urllib.parse import urlsplit

from fastapi import HTTPException, status

from app.database.config import SUPABASE_URL
from app.database.supabase_client import get_supabase_admin_client

SIGNED_URL_TTL_SECONDS = 3600


def _bucket_name() -> str:
    import os
    value = (os.getenv("SUPABASE_STORAGE_BUCKET") or "").strip()
    if not value:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Supabase Storage is not configured")
    return value


def _storage_bucket():
    client = get_supabase_admin_client()
    if client is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Server-side Supabase Storage credentials are not configured")
    try:
        return client.storage.from_(_bucket_name())
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Supabase Storage is unavailable") from exc


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
        raise HTTPException(status_code=503, detail="Could not save the image to Supabase Storage") from exc


def delete_object(object_path: str) -> None:
    try:
        _storage_bucket().remove([object_path])
    except Exception:
        # Cleanup is best-effort. Never leak the Storage exception or its credentials.
        return


def download_object(object_path: str) -> bytes:
    if not object_path or object_path.startswith(("http://", "https://")):
        raise HTTPException(status_code=503, detail="The stored image is not a Storage object path")
    try:
        result = _storage_bucket().download(object_path)
        if not isinstance(result, (bytes, bytearray)) or not result:
            raise ValueError("empty Storage object")
        return bytes(result)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Could not read the image from Supabase Storage") from exc


def create_signed_image_url(image_path: str) -> str:
    if image_path.startswith(("https://", "http://")):
        parsed = urlsplit(image_path)
        if parsed.hostname and not parsed.username and not parsed.password:
            return image_path  # Legacy references remain readable; new writes store object paths.
        raise HTTPException(status_code=503, detail="Stored image reference is invalid")
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
        raise HTTPException(status_code=503, detail="Could not create an image preview URL") from exc
