from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import re
from urllib.parse import urlsplit


class StorageProvider(str, Enum):
    GOOGLE_DRIVE = "google_drive"
    SUPABASE_LEGACY = "supabase_legacy"


GDRIVE_REF_PREFIX = "gdrive://"
VPACK_FILE_ID_PREFIX = "vpack--"
DRIVE_FILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,128}$")
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")
_SAFE_PATH_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]{1,180}$")

# Logical root segments under MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified/
DRIVE_ROOT_SEGMENTS = ("ViRead", "OCR-Training", "Flow2-Admin-Verified")
DRIVE_ROOT_DISPLAY_PATH = "MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified"
ALLOWED_DRIVE_CATEGORIES = frozenset(
    {
        "verified-samples",
        "datasets",
        "locked-tests",
        "checkpoints",
        "resume",
        "benchmarks",
        "audit",
        "_selftest",
    }
)


@dataclass(frozen=True)
class ArtifactRef:
    provider: StorageProvider
    raw: str
    drive_file_id: str | None = None
    legacy_path: str | None = None


def validate_drive_file_id(file_id: str) -> str:
    candidate = (file_id or "").strip()
    if candidate.startswith(VPACK_FILE_ID_PREFIX):
        if parse_vpack_drive_file_id(candidate) is None:
            raise ValueError("Invalid Google Drive vpack file ID format")
        return candidate
    if not DRIVE_FILE_ID_RE.fullmatch(candidate):
        raise ValueError("Invalid Google Drive file ID format")
    return candidate


def build_vpack_storage_ref(pack_file_id: str, member_sha256: str) -> str:
    clean_pack_id = validate_drive_file_id(pack_file_id)
    if clean_pack_id.startswith(VPACK_FILE_ID_PREFIX):
        raise ValueError("Pack file ID cannot itself be a virtual vpack reference")
    clean_sha = validate_sha256(member_sha256, required=True)
    assert clean_sha is not None
    return f"{GDRIVE_REF_PREFIX}{VPACK_FILE_ID_PREFIX}{clean_pack_id}--{clean_sha}"


def parse_vpack_drive_file_id(file_id: str) -> tuple[str, str] | None:
    if not isinstance(file_id, str):
        return None
    candidate = file_id.strip()
    if not candidate.startswith(VPACK_FILE_ID_PREFIX):
        return None
    suffix = candidate[len(VPACK_FILE_ID_PREFIX) :]
    if "--" not in suffix:
        return None
    pack_file_id, member_sha256 = suffix.rsplit("--", 1)
    if pack_file_id.startswith(VPACK_FILE_ID_PREFIX):
        return None
    try:
        clean_pack_id = validate_drive_file_id(pack_file_id)
    except ValueError:
        return None
    if not SHA256_HEX_RE.fullmatch(member_sha256):
        return None
    return clean_pack_id, member_sha256


def parse_vpack_ref(reference: str | None) -> tuple[str, str] | None:
    if not is_gdrive_ref(reference):
        return None
    assert reference is not None
    raw = reference.strip()
    return parse_vpack_drive_file_id(raw[len(GDRIVE_REF_PREFIX) :])


def format_gdrive_ref(file_id: str) -> str:
    return f"{GDRIVE_REF_PREFIX}{validate_drive_file_id(file_id)}"


def is_gdrive_ref(reference: str | None) -> bool:
    return isinstance(reference, str) and reference.strip().startswith(GDRIVE_REF_PREFIX)


def validate_sha256(digest: str | None, *, required: bool = False) -> str | None:
    if digest is None:
        if required:
            raise ValueError("SHA-256 digest is required")
        return None
    normalized = digest.strip().lower()
    if not SHA256_HEX_RE.fullmatch(normalized):
        raise ValueError("SHA-256 digest must be 64 lowercase hex characters")
    return normalized


def validate_logical_path(logical_path: str, *, require_known_category: bool = False) -> str:
    """Validate a clean relative logical path (no traversal, schemes, backslashes, or null bytes)."""
    raw = (logical_path or "").strip()
    if not raw or "\x00" in raw or "\\" in raw:
        raise ValueError("Logical storage path contains forbidden characters")
    if raw.startswith("/") or raw.endswith("/"):
        raise ValueError("Logical storage path must be relative without leading or trailing slash")
    if "://" in raw or raw.lower().startswith(("http:", "https:", "file:", "data:")):
        raise ValueError("Logical storage path must not be a URL")
    parts = raw.split("/")
    for part in parts:
        if part in {"", ".", ".."} or not _SAFE_PATH_SEGMENT_RE.fullmatch(part):
            raise ValueError("Logical storage path contains an invalid segment")
    if require_known_category and parts[0] not in ALLOWED_DRIVE_CATEGORIES:
        raise ValueError(f"Logical storage category must be one of {sorted(ALLOWED_DRIVE_CATEGORIES)}")
    return "/".join(parts)


def parse_artifact_ref(reference: str) -> ArtifactRef:
    """Parse a provider-explicit storage reference. Never guesses Drive IDs from relative paths."""
    raw = (reference or "").strip()
    if not raw:
        raise ValueError("Storage reference must not be empty")
    if "\x00" in raw or "\\" in raw:
        raise ValueError("Storage reference contains forbidden characters")
    if raw.startswith(GDRIVE_REF_PREFIX):
        file_id = validate_drive_file_id(raw[len(GDRIVE_REF_PREFIX) :])
        return ArtifactRef(
            provider=StorageProvider.GOOGLE_DRIVE,
            raw=f"{GDRIVE_REF_PREFIX}{file_id}",
            drive_file_id=file_id,
            legacy_path=None,
        )
    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc:
        raise ValueError("Public or external URLs are not valid training artifact references")
    clean_legacy = validate_logical_path(raw, require_known_category=False)
    return ArtifactRef(
        provider=StorageProvider.SUPABASE_LEGACY,
        raw=clean_legacy,
        drive_file_id=None,
        legacy_path=clean_legacy,
    )


def provider_for_reference(reference: str) -> StorageProvider:
    return parse_artifact_ref(reference).provider


def drive_file_id_from_reference(reference: str | None) -> str | None:
    if not reference or not is_gdrive_ref(reference):
        return None
    return parse_artifact_ref(reference).drive_file_id
