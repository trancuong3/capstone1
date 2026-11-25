"""Deterministic public TTS audio URL resolution for verified public catalog pages.

Privacy invariant:
- ONLY `is_public_catalog=True` AND `is_verified=True` pages may ever receive a
  public `viread-catalog-tts` audio URL.
- Private parent books (`PARENT_PRIVATE` / `viread-private-books`) MUST ALWAYS
  return `None` here and stay strictly behind authenticated live/native TTS.
"""
from __future__ import annotations

import hashlib
import os
import re
import unicodedata
from typing import Any
from urllib.parse import quote

from app.database.config import SUPABASE_URL
from app.providers.local_voice_provider import DEFAULT_LOCAL_VOICE_ID

DEFAULT_CATALOG_TTS_BUCKET = "viread-catalog-tts"
_TRUTHY = {"1", "true", "yes", "on"}
_SAFE_VOICE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_SAFE_OBJ_PATH_RE = re.compile(r"^[A-Za-z0-9_./-]{3,256}\.mp3$")


def get_catalog_tts_bucket() -> str:
    return (
        os.getenv("SUPABASE_CATALOG_TTS_BUCKET") or DEFAULT_CATALOG_TTS_BUCKET
    ).strip() or DEFAULT_CATALOG_TTS_BUCKET


def get_catalog_tts_default_voice_id() -> str:
    raw = (
        os.getenv("VIREAD_CATALOG_TTS_DEFAULT_VOICE_ID") or DEFAULT_LOCAL_VOICE_ID
    ).strip()
    return raw if _SAFE_VOICE_RE.fullmatch(raw) else DEFAULT_LOCAL_VOICE_ID


def is_catalog_tts_public_enabled() -> bool:
    return (
        os.getenv("VIREAD_CATALOG_TTS_PUBLIC_ENABLED") or ""
    ).strip().lower() in _TRUTHY


def normalize_catalog_tts_text(text: str) -> str:
    """Normalize Vietnamese page text with NFC and single spaces before hashing."""
    return " ".join(unicodedata.normalize("NFC", str(text or "")).split()).strip()


def compute_catalog_tts_text_hash(text: str) -> str:
    normalized = normalize_catalog_tts_text(text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def build_catalog_tts_object_path(
    text: str,
    *,
    voice_id: str | None = None,
    speed: float = 1.0,
) -> str:
    eff_voice = (voice_id or get_catalog_tts_default_voice_id()).strip()
    if not _SAFE_VOICE_RE.fullmatch(eff_voice):
        eff_voice = DEFAULT_LOCAL_VOICE_ID
    clamped_speed = max(0.7, min(1.3, float(speed)))
    speed_slug = f"{clamped_speed:.1f}"
    text_sha = compute_catalog_tts_text_hash(text)
    return f"{eff_voice}/{speed_slug}/{text_sha}.mp3"


def build_public_catalog_tts_url(
    object_path: str,
    *,
    supabase_url: str | None = None,
    bucket_name: str | None = None,
) -> str | None:
    base = (supabase_url if supabase_url is not None else (os.getenv("SUPABASE_URL") or SUPABASE_URL or "")).strip().rstrip("/")
    if not base or not base.startswith(("https://", "http://")):
        return None
    clean_path = object_path.strip().lstrip("/")
    if not clean_path or ".." in clean_path.split("/") or not _SAFE_OBJ_PATH_RE.fullmatch(clean_path):
        return None
    bucket = (bucket_name or get_catalog_tts_bucket()).strip()
    if not bucket or "/" in bucket or "\\" in bucket:
        return None
    return (
        f"{base}/storage/v1/object/public/"
        f"{quote(bucket, safe='')}/{quote(clean_path, safe='/')}"
    )


def resolve_verified_catalog_tts_url(
    *,
    is_public_catalog: bool,
    is_verified: bool,
    text: str,
    processing_meta: dict[str, Any] | None = None,
    voice_id: str | None = None,
    speed: float = 1.0,
) -> str | None:
    """Resolve a deterministic public MP3 URL strictly for verified public catalog pages.

    Returns `None` unconditionally for private books, unverified revisions, or blank text.
    """
    if not is_public_catalog or not is_verified:
        return None
    normalized = normalize_catalog_tts_text(text)
    if not normalized:
        return None

    expected_sha = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    meta = processing_meta if isinstance(processing_meta, dict) else {}
    tts_meta = meta.get("catalog_tts")
    if isinstance(tts_meta, dict):
        recorded_sha = str(tts_meta.get("text_sha256") or "").strip().lower()
        if not recorded_sha or recorded_sha == expected_sha:
            recorded_path = tts_meta.get("object_path")
            if isinstance(recorded_path, str) and recorded_path.strip():
                resolved = build_public_catalog_tts_url(recorded_path)
                if resolved is not None:
                    return resolved

    if not is_catalog_tts_public_enabled():
        return None

    object_path = build_catalog_tts_object_path(
        normalized,
        voice_id=voice_id,
        speed=speed,
    )
    return build_public_catalog_tts_url(object_path)
