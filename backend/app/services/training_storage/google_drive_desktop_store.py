from __future__ import annotations

from collections.abc import Callable, Iterator
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sqlite3
import string
import threading
import time
from typing import Any, BinaryIO
from uuid import uuid4

from app.services.training_storage.base import (
    ArtifactMetadata,
    DriveIntegrityError,
    DriveNotConnectedError,
    DriveNotFoundError,
    DrivePermissionError,
    DriveQuotaExceededError,
    StorageHealthStatus,
    StorageQuotaStatus,
    StoredArtifact,
    TrainingArtifactStore,
    TrainingStorageError,
)
from app.services.training_storage.google_drive_store import (
    DEFAULT_MIN_FREE_BUFFER_BYTES,
    DriveSelfTestResult,
    validate_resume_object_path,
)
from app.services.training_storage.references import (
    ALLOWED_DRIVE_CATEGORIES,
    DRIVE_ROOT_DISPLAY_PATH,
    DRIVE_ROOT_SEGMENTS,
    StorageProvider,
    format_gdrive_ref,
    parse_artifact_ref,
    validate_drive_file_id,
    validate_logical_path,
    validate_sha256,
)

logger = logging.getLogger(__name__)

DRIVE_DESKTOP_SYNC_SCOPE = "drive_desktop_sync"
_INDEX_DIR_NAME = ".viread_index"
_IMMUTABLE_CATEGORIES = frozenset(
    {"verified-samples", "datasets", "locked-tests", "checkpoints", "benchmarks", "audit"}
)
_MY_DRIVE_FOLDER_NAMES = ("My Drive", "Drive của tôi", "Mon Drive", "Mi unidad")


def _int_env(name: str, default: int, *, minimum: int = 0) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
    except ValueError:
        return default
    return max(minimum, parsed)


def _parse_protobuf_fields(buf: bytes) -> list[tuple[int, int, int | bytes]]:
    """Minimal read-only protobuf wire parser (varint + length-delimited) for DriveFS metadata."""
    fields: list[tuple[int, int, int | bytes]] = []
    i = 0
    n = len(buf)
    while i < n:
        tag = 0
        shift = 0
        while i < n:
            b = buf[i]
            i += 1
            tag |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
            if shift > 63:
                return fields
        field_no = tag >> 3
        wire_type = tag & 7
        if wire_type == 0:
            val = 0
            shift = 0
            while i < n:
                b = buf[i]
                i += 1
                val |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
                if shift > 63:
                    return fields
            fields.append((field_no, 0, val))
        elif wire_type == 2:
            length = 0
            shift = 0
            while i < n:
                b = buf[i]
                i += 1
                length |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
                if shift > 63:
                    return fields
            if length < 0 or i + length > n:
                return fields
            fields.append((field_no, 2, buf[i : i + length]))
            i += length
        elif wire_type == 1:
            if i + 8 > n:
                return fields
            i += 8
        elif wire_type == 5:
            if i + 4 > n:
                return fields
            i += 4
        else:
            break
    return fields


def _parse_driveway_account_blob(blob: bytes) -> dict[str, Any]:
    """Extract verified user email, display_name, and cloud quota bytes from DriveFS driveway_account."""
    result: dict[str, Any] = {}
    top = _parse_protobuf_fields(blob)
    account_bytes = next((v for f, w, v in top if f == 2 and w == 2 and isinstance(v, bytes)), None)
    if not account_bytes:
        return result
    acc_fields = _parse_protobuf_fields(account_bytes)
    # Field 1: user message (f3 = display_name, f8 = email)
    user_bytes = next((v for f, w, v in acc_fields if f == 1 and w == 2 and isinstance(v, bytes)), None)
    if user_bytes:
        for f, w, v in _parse_protobuf_fields(user_bytes):
            if w == 2 and isinstance(v, bytes):
                try:
                    txt = v.decode("utf-8").strip()
                except UnicodeDecodeError:
                    continue
                if f == 3 and txt:
                    result["display_name"] = txt
                elif f == 8 and "@" in txt and "." in txt and " " not in txt:
                    result["email"] = txt.lower()
    # Field 3 -> Field 1: quota message (f1/f7 = bytes_limit, f3/f9 = bytes_used, f8 = bytes_remaining)
    meta_bytes = next((v for f, w, v in acc_fields if f == 3 and w == 2 and isinstance(v, bytes)), None)
    if meta_bytes:
        quota_bytes = next(
            (v for f, w, v in _parse_protobuf_fields(meta_bytes) if f == 1 and w == 2 and isinstance(v, bytes)),
            None,
        )
        if quota_bytes:
            varints = {f: int(v) for f, w, v in _parse_protobuf_fields(quota_bytes) if w == 0 and isinstance(v, int)}
            limit_b = varints.get(1) or varints.get(7)
            used_b = varints.get(3) if 3 in varints else varints.get(9)
            rem_b = varints.get(8)
            if limit_b and limit_b > 0 and used_b is not None and used_b >= 0:
                # Sanity check: remaining + used should match limit (when remaining is present)
                if rem_b is None or abs((used_b + rem_b) - limit_b) <= max(1024 * 1024, int(limit_b * 0.02)):
                    result["quota_limit_bytes"] = int(limit_b)
                    result["quota_usage_bytes"] = int(used_b)
                    result["quota_available_bytes"] = (
                        int(rem_b) if rem_b is not None else max(0, int(limit_b) - int(used_b))
                    )
    return result


def _read_drivefs_account_profiles() -> list[dict[str, Any]]:
    """Read verified account email, display_name, and cloud quota from DriveFS metadata_sqlite_db."""
    local_app_data = (os.getenv("LOCALAPPDATA") or "").strip()
    if not local_app_data:
        return []
    drivefs_dir = Path(local_app_data) / "Google" / "DriveFS"
    if not drivefs_dir.is_dir():
        return []

    profiles: list[dict[str, Any]] = []
    for child in sorted(drivefs_dir.iterdir(), key=lambda p: p.name):
        if not child.is_dir() or not child.name.isdigit():
            continue
        meta_db = child / "metadata_sqlite_db"
        if not meta_db.is_file():
            continue
        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(f"file:{meta_db.as_posix()}?mode=ro", uri=True, timeout=1.0)
            conn.text_factory = bytes
            row = conn.execute(
                "SELECT value FROM properties WHERE property = ?",
                ("driveway_account",),
            ).fetchone()
            if row and isinstance(row[0], (bytes, bytearray)):
                parsed = _parse_driveway_account_blob(bytes(row[0]))
                if parsed:
                    profiles.append(parsed)
        except Exception:
            continue
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
    return profiles


def _read_drivefs_accounts() -> list[dict[str, str]]:
    """Read signed-in Google Drive for Desktop account metadata (read-only, best-effort)."""
    local_app_data = (os.getenv("LOCALAPPDATA") or "").strip()
    if not local_app_data:
        return []
    drivefs_dir = Path(local_app_data) / "Google" / "DriveFS"
    if not drivefs_dir.is_dir():
        return []

    accounts: list[dict[str, str]] = []
    seen: set[str] = set()

    for prof in _read_drivefs_account_profiles():
        email = str(prof.get("email") or "").strip().lower()
        if email and f"{email}|" not in seen:
            seen.add(f"{email}|")
            accounts.append({"email": email, "mount_path": "", "display_name": str(prof.get("display_name") or "")})

    # Google Drive for Desktop stores per-account preferences in root_preference_sqlite.db
    pref_db = drivefs_dir / "root_preference_sqlite.db"
    if pref_db.is_file():
        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(f"file:{pref_db.as_posix()}?mode=ro", uri=True, timeout=1.0)
            cur = conn.cursor()
            tables = {
                str(r[0])
                for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            }
            for table in ("account_preferences", "accounts", "mirror_roots", "preferences"):
                if table not in tables:
                    continue
                cols = [str(c[1]) for c in cur.execute(f"PRAGMA table_info({table})").fetchall()]
                rows = cur.execute(f"SELECT * FROM {table}").fetchall()
                for row in rows:
                    row_map = dict(zip(cols, row, strict=False))
                    email = ""
                    mount_path = ""
                    for k, v in row_map.items():
                        val = str(v or "").strip()
                        if "@" in val and "." in val and " " not in val and not email:
                            email = val.lower()
                        if ("mount" in k.lower() or "path" in k.lower() or "root" in k.lower()) and (
                            ":\\" in val or val.startswith("/")
                        ):
                            mount_path = val
                    if email or mount_path:
                        key = f"{email}|{mount_path}"
                        if key not in seen:
                            seen.add(key)
                            accounts.append({"email": email, "mount_path": mount_path})
        except Exception:
            pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
    return accounts


def detect_google_drive_desktop_mounts() -> list[dict[str, Any]]:
    """Detect mounted Google Drive for Desktop 'My Drive' / 'Drive của tôi' folders on Windows."""
    mounts: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    drivefs_accounts = _read_drivefs_accounts()
    primary_email = next((a["email"] for a in drivefs_accounts if a.get("email")), None)

    # 1. Explicit env override if configured
    env_root = (os.getenv("VIREAD_GDRIVE_DESKTOP_ROOT") or "").strip()
    if env_root:
        try:
            p = _validate_raw_desktop_path(env_root)
            if p.exists():
                resolved_flow2 = resolve_flow2_sync_root(p)
                key = str(resolved_flow2).lower()
                seen_paths.add(key)
                mounts.append(
                    {
                        "drive_root": str(p),
                        "flow2_root": str(resolved_flow2),
                        "account_email": primary_email,
                        "source": "env",
                    }
                )
        except (TrainingStorageError, OSError):
            logger.warning("Ignoring unsafe VIREAD_GDRIVE_DESKTOP_ROOT value")

    # 2. DriveFS recorded mount paths
    for acc in drivefs_accounts:
        mp = (acc.get("mount_path") or "").strip()
        if not mp:
            continue
        try:
            base = _validate_raw_desktop_path(mp)
            if not base.exists():
                continue
            candidate = _find_my_drive_child(base) or base
            flow2 = resolve_flow2_sync_root(candidate)
        except (TrainingStorageError, OSError):
            continue
        key = str(flow2).lower()
        if key not in seen_paths:
            seen_paths.add(key)
            mounts.append(
                {
                    "drive_root": str(candidate),
                    "flow2_root": str(flow2),
                    "account_email": acc.get("email") or primary_email,
                    "source": "drivefs",
                }
            )

    # 3. Scan Windows drive letters (G:..Z:, then D:..F:) for "My Drive" / "Drive của tôi"
    if os.name == "nt":
        letters = list("GHIJKLMNOPQRSTUVWXYZDEF")
        for letter in letters:
            root = Path(f"{letter}:\\")
            try:
                if not root.exists():
                    continue
                my_drive = _find_my_drive_child(root)
                if my_drive is None:
                    continue
                flow2 = resolve_flow2_sync_root(my_drive)
                key = str(flow2).lower()
                if key not in seen_paths:
                    seen_paths.add(key)
                    mounts.append(
                        {
                            "drive_root": str(my_drive),
                            "flow2_root": str(flow2),
                            "account_email": primary_email,
                            "source": "windows_mount",
                        }
                    )
            except (TrainingStorageError, OSError):
                continue
    return mounts


def _is_reparse_or_symlink(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
    except OSError:
        pass
    isjunction = getattr(os.path, "isjunction", None)
    if callable(isjunction):
        try:
            if isjunction(path):
                return True
        except OSError:
            pass
    return False


def _assert_no_symlink_components(path: Path) -> None:
    anchor = Path(path.anchor) if path.anchor else None
    cur = path
    while True:
        if anchor is not None and cur == anchor:
            break
        if _is_reparse_or_symlink(cur):
            raise TrainingStorageError(
                "Symbolic links and junctions are not permitted for Google Drive Desktop sync",
                code="DRIVE_DESKTOP_SYMLINK_FORBIDDEN",
                http_status=400,
            )
        parent = cur.parent
        if parent == cur:
            break
        cur = parent


def _validate_raw_desktop_path(raw_path: str | Path) -> Path:
    """Validate desktop sync path syntax before touching the filesystem (prevents UNC/SMB & traversal)."""
    raw_str = str(raw_path or "").strip().strip('"').strip("'")
    if not raw_str:
        raise TrainingStorageError(
            "Google Drive for Desktop folder path is required",
            code="DRIVE_DESKTOP_PATH_MISSING",
            http_status=400,
        )
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in raw_str):
        raise TrainingStorageError(
            "Google Drive for Desktop folder path contains invalid characters",
            code="DRIVE_DESKTOP_PATH_INVALID",
            http_status=400,
        )
    if raw_str.startswith(("\\\\", "//")) or raw_str.startswith(("\\?", "\\.", "/?", "/.")):
        raise TrainingStorageError(
            "Network and UNC paths are not allowed for Google Drive Desktop sync",
            code="DRIVE_DESKTOP_UNC_FORBIDDEN",
            http_status=400,
        )
    if "://" in raw_str:
        raise TrainingStorageError(
            "URL paths are not allowed for Google Drive Desktop sync",
            code="DRIVE_DESKTOP_PATH_INVALID",
            http_status=400,
        )
    if len(raw_str) == 2 and raw_str[1] == ":" and raw_str[0] in string.ascii_letters:
        raw_str = f"{raw_str}\\"
    if raw_str.startswith("\\"):
        raise TrainingStorageError(
            "Relative paths are not allowed for Google Drive Desktop sync",
            code="DRIVE_DESKTOP_PATH_INVALID",
            http_status=400,
        )
    if len(raw_str) >= 2 and raw_str[1] == ":" and raw_str[0] in string.ascii_letters:
        if len(raw_str) < 3 or raw_str[2] not in ("\\", "/"):
            raise TrainingStorageError(
                "Relative paths are not allowed for Google Drive Desktop sync",
                code="DRIVE_DESKTOP_PATH_INVALID",
                http_status=400,
            )
    p = Path(raw_str)
    if not p.is_absolute():
        raise TrainingStorageError(
            "Relative paths are not allowed for Google Drive Desktop sync",
            code="DRIVE_DESKTOP_PATH_INVALID",
            http_status=400,
        )
    if ".." in p.parts:
        raise TrainingStorageError(
            "Path traversal segments are not allowed for Google Drive Desktop sync",
            code="DRIVE_DESKTOP_PATH_INVALID",
            http_status=400,
        )
    _assert_no_symlink_components(p)
    return p


def get_allowed_drive_desktop_roots() -> list[Path]:
    """Parse pathsep-separated VIREAD_GDRIVE_DESKTOP_ALLOWED_ROOTS into safe resolved Paths."""
    raw = (os.getenv("VIREAD_GDRIVE_DESKTOP_ALLOWED_ROOTS") or "").strip()
    if not raw:
        return []
    roots: list[Path] = []
    for entry in raw.split(os.pathsep):
        cleaned = entry.strip().strip('"').strip("'")
        if not cleaned:
            continue
        try:
            p = _validate_raw_desktop_path(cleaned)
            roots.append(p.resolve())
        except (TrainingStorageError, OSError):
            logger.warning("Ignoring invalid VIREAD_GDRIVE_DESKTOP_ALLOWED_ROOTS entry")
            continue
    return roots


def _path_is_within_root(candidate: Path, root: Path) -> bool:
    try:
        candidate_norm = Path(os.path.normcase(str(candidate.resolve())))
        root_norm = Path(os.path.normcase(str(root.resolve())))
        return candidate_norm.is_relative_to(root_norm)
    except (OSError, ValueError):
        return False


def validate_flow2_sync_root_allowed(
    flow2_root: Path,
    *,
    detected_mounts: list[dict[str, Any]] | None = None,
) -> Path:
    """Require resolved flow2_root to stay inside a detected DriveFS mount or explicit env allowlist."""
    _assert_no_symlink_components(flow2_root)
    resolved = flow2_root.resolve()
    mounts = detected_mounts if detected_mounts is not None else detect_google_drive_desktop_mounts()
    allowed_roots: list[Path] = []
    for mount in mounts:
        for key in ("drive_root", "flow2_root"):
            raw_mount = str(mount.get(key) or "").strip()
            if not raw_mount:
                continue
            try:
                allowed_roots.append(_validate_raw_desktop_path(raw_mount).resolve())
            except (TrainingStorageError, OSError):
                continue
    allowed_roots.extend(get_allowed_drive_desktop_roots())
    if not any(_path_is_within_root(resolved, root) for root in allowed_roots):
        logger.warning(
            "Rejected Google Drive Desktop sync root outside detected mounts and allowlist: %s",
            resolved,
        )
        raise DrivePermissionError(
            "Google Drive for Desktop path must be inside a detected Google Drive mount or configured VIREAD_GDRIVE_DESKTOP_ALLOWED_ROOTS",
            code="DRIVE_DESKTOP_PATH_NOT_ALLOWED",
            http_status=403,
        )
    return resolved


def _find_my_drive_child(base: Path) -> Path | None:
    if base.name in _MY_DRIVE_FOLDER_NAMES and base.is_dir():
        return base
    for folder_name in _MY_DRIVE_FOLDER_NAMES:
        cand = base / folder_name
        try:
            if cand.is_dir():
                return cand
        except OSError:
            continue
    return None


def resolve_flow2_sync_root(raw_path: str | Path) -> Path:
    """Resolve user-supplied drive letter or My Drive path into .../ViRead/OCR-Training/Flow2-Admin-Verified."""
    p = _validate_raw_desktop_path(raw_path)
    # If pointing to drive root (e.g. G:\), automatically step into "My Drive" / "Drive của tôi"
    my_drive = _find_my_drive_child(p)
    if my_drive is not None and my_drive != p:
        _assert_no_symlink_components(my_drive)
        p = my_drive
    # If already ending with Flow2-Admin-Verified, keep as-is; otherwise append standard Flow 2 segments
    if p.name != DRIVE_ROOT_SEGMENTS[-1]:
        for seg in DRIVE_ROOT_SEGMENTS:
            p = p / seg
    _assert_no_symlink_components(p)
    return p


def drive_desktop_config_readiness() -> dict[str, Any]:
    enc_key = (os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY") or "").strip()
    required_email = (os.getenv("VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL") or "").strip().lower() or None
    detected = detect_google_drive_desktop_mounts()
    sanitized_mounts = [
        {
            "drive_root": "Google Drive Desktop",
            "flow2_root": DRIVE_ROOT_DISPLAY_PATH,
            "account_email": m.get("account_email"),
            "source": m.get("source"),
        }
        for m in detected
    ]
    return {
        "desktop_ready": len(enc_key) >= 32,
        "encryption_key_configured": len(enc_key) >= 32,
        "detected_mounts": sanitized_mounts,
        "default_mount_path": None,
        "required_account_email": required_email,
    }


def _make_desktop_file_id() -> str:
    return f"gdesk_{uuid4().hex}"


class GoogleDriveDesktopStore(TrainingArtifactStore):
    """Zero-card, Advanced-Protection-safe Google Drive store backed by Google Drive for Desktop sync mount."""

    provider = StorageProvider.GOOGLE_DRIVE

    def __init__(
        self,
        *,
        root_dir: str | Path,
        account_email: str | None = None,
        min_free_buffer_bytes: int | None = None,
        max_training_budget_bytes: int | None = None,
    ) -> None:
        self._raw_root_input = str(root_dir)
        validated_root = _validate_raw_desktop_path(root_dir)
        self._root_dir = validated_root.resolve()
        self._account_email = (account_email or "").strip().lower() or None
        self._min_free_buffer_bytes = (
            min_free_buffer_bytes
            if min_free_buffer_bytes is not None
            else _int_env("VIREAD_GDRIVE_MIN_FREE_BYTES", DEFAULT_MIN_FREE_BUFFER_BYTES, minimum=0)
        )
        env_budget = _int_env("VIREAD_GDRIVE_MAX_TRAINING_BYTES", 0, minimum=0)
        self._max_training_budget_bytes = (
            max_training_budget_bytes
            if max_training_budget_bytes is not None
            else (env_budget if env_budget > 0 else None)
        )
        self._root_folder_id = f"gdesk_root_{hashlib.sha256(str(self._root_dir).lower().encode('utf-8')).hexdigest()[:16]}"
        self._subfolder_ids: dict[str, str] = {}
        self._index_lock = threading.Lock()

    @property
    def root_dir(self) -> Path:
        return self._root_dir

    @property
    def root_folder_id(self) -> str:
        return self._root_folder_id

    @property
    def subfolder_ids(self) -> dict[str, str]:
        return dict(self._subfolder_ids)

    def _index_dir(self) -> Path:
        return self._root_dir / _INDEX_DIR_NAME

    def _index_path(self, file_id: str) -> Path:
        clean_id = validate_drive_file_id(file_id)
        return self._index_dir() / f"{clean_id}.json"

    def _immutable_key_index_path(self, logical_path: str, sha256_hex: str) -> Path:
        key_sha = hashlib.sha256(
            f"{logical_path}\0{sha256_hex.strip().lower()}".encode("utf-8")
        ).hexdigest()
        return self._index_dir() / "by_key" / key_sha[:2] / f"{key_sha}.json"

    def _assert_root_available(self) -> None:
        app_env = (os.getenv("APP_ENVIRONMENT") or "").strip().lower()
        is_render = (os.getenv("RENDER") or "").strip().lower() in {"1", "true", "yes", "on"}
        if app_env == "production" or is_render:
            raise DriveNotConnectedError(
                "Google Drive for Desktop local mount is disabled on production/cloud hosts; connect via Apps Script Bridge"
            )
        if os.name != "nt" and re.match(r"^[A-Za-z]:[\\/]", self._raw_root_input.strip()):
            raise DriveNotConnectedError(
                f"Google Drive for Desktop Windows mount ({self._raw_root_input}) is inaccessible on non-Windows host"
            )
        # Check the top-level mount anchor (e.g. G:\ or parent drive) exists before touching anything
        anchor = Path(self._root_dir.anchor) if self._root_dir.anchor else self._root_dir.parent
        if not anchor.exists():
            logger.warning("Google Drive Desktop mount anchor unavailable: %s", anchor)
            raise DriveNotConnectedError(
                "Google Drive for Desktop mount is offline; start Google Drive on the host"
            )

    def _delete_index_entries_for_logical_path(
        self,
        logical_path: str,
        *,
        exclude_file_id: str | None = None,
    ) -> int:
        idx_dir = self._index_dir()
        if not idx_dir.is_dir():
            return 0
        removed = 0
        for entry in idx_dir.glob("*.json"):
            try:
                rec = json.loads(entry.read_text(encoding="utf-8"))
            except Exception:
                continue
            if str(rec.get("logical_path") or "") != logical_path:
                continue
            file_id = str(rec.get("file_id") or "")
            if exclude_file_id and file_id == exclude_file_id:
                continue
            entry.unlink(missing_ok=True)
            removed += 1
        return removed

    def _resolve_target_path(self, logical_path: str) -> Path:
        clean = validate_logical_path(logical_path, require_known_category=True)
        target = (self._root_dir / Path(*clean.split("/"))).resolve()
        try:
            target.relative_to(self._root_dir)
        except ValueError as exc:
            raise ValueError("Logical path escapes Flow 2 Drive root directory") from exc
        return target

    def _write_json_atomic(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + f".{uuid4().hex[:8]}.tmp")
        try:
            tmp.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    def _read_index_entry(self, file_id: str) -> dict[str, Any]:
        idx_path = self._index_path(file_id)
        if not idx_path.is_file():
            raise DriveNotFoundError(f"Drive artifact index entry not found: {file_id}")
        try:
            data = json.loads(idx_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise DriveIntegrityError("Corrupted Drive Desktop index metadata") from exc
        if not isinstance(data, dict) or not data.get("logical_path"):
            raise DriveIntegrityError("Invalid Drive Desktop index metadata")
        return data

    def _prepare_upload_stream(
        self,
        data: bytes | Path | BinaryIO,
        *,
        expected_sha256: str | None,
        size_bytes: int | None,
    ) -> tuple[BinaryIO, bool, int, str]:
        expected = validate_sha256(expected_sha256, required=False)
        if isinstance(data, (bytes, bytearray, memoryview)):
            raw = bytes(data)
            actual_size = len(raw)
            actual_sha = hashlib.sha256(raw).hexdigest()
            stream: BinaryIO = io.BytesIO(raw)
            should_close = True
        elif isinstance(data, Path):
            stream = data.open("rb")
            should_close = True
            digest = hashlib.sha256()
            actual_size = 0
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                actual_size += len(chunk)
            actual_sha = digest.hexdigest()
            stream.seek(0)
        else:
            stream = data
            should_close = False
            if not stream.seekable():
                raise ValueError("Upload file stream must be seekable for integrity verification")
            start_pos = stream.tell()
            digest = hashlib.sha256()
            actual_size = 0
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                actual_size += len(chunk)
            actual_sha = digest.hexdigest()
            stream.seek(start_pos)

        if size_bytes is not None and size_bytes != actual_size:
            if should_close:
                stream.close()
            raise DriveIntegrityError(f"Upload byte length mismatch: expected {size_bytes}, got {actual_size}")
        if expected and actual_sha != expected:
            if should_close:
                stream.close()
            raise DriveIntegrityError(
                f"Upload SHA-256 mismatch before transfer: expected {expected[:12]}, got {actual_sha[:12]}"
            )
        return stream, should_close, actual_size, actual_sha

    def _matching_drivefs_profile(self) -> dict[str, Any] | None:
        profiles = _read_drivefs_account_profiles()
        if not profiles:
            return None
        if self._account_email:
            for prof in profiles:
                if str(prof.get("email") or "").lower() == self._account_email:
                    return prof
        return profiles[0] if len(profiles) == 1 else None

    def get_account_info(self) -> dict[str, str | None]:
        prof = self._matching_drivefs_profile()
        if prof:
            email = self._account_email or str(prof.get("email") or "").strip().lower() or None
            display_name = str(prof.get("display_name") or "").strip() or (email.split("@", 1)[0] if email else None)
            return {"email": email, "display_name": display_name}
        detected = _read_drivefs_accounts()
        detected_email = next((a["email"] for a in detected if a.get("email")), None)
        email = self._account_email or detected_email
        return {
            "email": email,
            "display_name": email.split("@", 1)[0] if email else None,
        }

    def ensure_directory_tree(self) -> tuple[str, dict[str, str]]:
        self._assert_root_available()
        try:
            self._root_dir.mkdir(parents=True, exist_ok=True)
            self._index_dir().mkdir(parents=True, exist_ok=True)
            subfolders: dict[str, str] = {}
            for cat in sorted(ALLOWED_DRIVE_CATEGORIES):
                sub = self._root_dir / cat
                sub.mkdir(parents=True, exist_ok=True)
                subfolders[cat] = f"gdesk_sub_{hashlib.sha256(f'{self._root_dir}:{cat}'.lower().encode('utf-8')).hexdigest()[:14]}"
            self._subfolder_ids = subfolders
            return self._root_folder_id, dict(subfolders)
        except OSError as exc:
            logger.warning(
                "Cannot create or write ViRead Flow 2 folders in Google Drive Desktop mount (%s): %s",
                self._root_dir,
                exc,
            )
            raise DrivePermissionError(
                "Cannot create or write ViRead Flow 2 folders in Google Drive Desktop mount",
                code="DRIVE_DESKTOP_WRITE_ERROR",
                http_status=503,
            ) from exc

    def quota_check(self, incoming_bytes: int = 0) -> StorageQuotaStatus:
        self._assert_root_available()
        probe_path = self._root_dir if self._root_dir.exists() else self._root_dir.parent
        while not probe_path.exists() and probe_path.parent != probe_path:
            probe_path = probe_path.parent
        try:
            local_usage = shutil.disk_usage(probe_path)
        except OSError as exc:
            logger.warning("Unable to read Google Drive Desktop quota at %s: %s", probe_path, exc)
            raise DriveNotConnectedError("Unable to read Google Drive Desktop storage quota") from exc

        local_free_bytes = max(0, int(local_usage.free))
        prof = self._matching_drivefs_profile()
        if prof and prof.get("quota_limit_bytes") is not None and prof.get("quota_usage_bytes") is not None:
            # Prefer REAL Google Drive cloud quota from DriveFS metadata_sqlite_db
            # (Windows Stream mode reports the local C:\ cache SSD size on G:\ instead of cloud quota).
            limit_bytes = int(prof["quota_limit_bytes"])
            usage_bytes = int(prof["quota_usage_bytes"])
            available_bytes = max(0, int(prof.get("quota_available_bytes") or (limit_bytes - usage_bytes)))
        else:
            limit_bytes = int(local_usage.total)
            usage_bytes = int(local_usage.used)
            available_bytes = local_free_bytes

        incoming = max(0, int(incoming_bytes))
        remaining_after = available_bytes - incoming
        local_remaining_after = local_free_bytes - incoming
        can_accept = True
        warning_level = "OK"
        detail: str | None = None

        if remaining_after < self._min_free_buffer_bytes:
            warning_level = "EXCEEDED"
            can_accept = False
            detail = (
                f"Upload would leave {max(0, remaining_after)} bytes free in Google Drive, "
                f"below required safety buffer {self._min_free_buffer_bytes} bytes"
            )
        elif local_remaining_after < self._min_free_buffer_bytes:
            warning_level = "EXCEEDED"
            can_accept = False
            detail = (
                f"Local Google Drive Desktop cache drive only has {max(0, local_remaining_after)} bytes free, "
                f"below required safety buffer {self._min_free_buffer_bytes} bytes"
            )
        else:
            ratio = usage_bytes / max(1, limit_bytes)
            if ratio >= 0.90 or remaining_after <= (self._min_free_buffer_bytes * 2):
                warning_level = "CRITICAL"
            elif ratio >= 0.75:
                warning_level = "WARNING"

        if (
            self._max_training_budget_bytes is not None
            and (usage_bytes + incoming) > self._max_training_budget_bytes
        ):
            warning_level = "EXCEEDED"
            can_accept = False
            detail = "Upload would exceed configured VIREAD_GDRIVE_MAX_TRAINING_BYTES budget"

        return StorageQuotaStatus(
            provider=StorageProvider.GOOGLE_DRIVE,
            limit_bytes=limit_bytes,
            usage_bytes=usage_bytes,
            usage_in_drive_bytes=usage_bytes,
            usage_in_trash_bytes=None,
            available_bytes=available_bytes,
            min_free_buffer_bytes=self._min_free_buffer_bytes,
            max_training_budget_bytes=self._max_training_budget_bytes,
            warning_level=warning_level,
            can_accept_upload=can_accept,
            detail=detail,
        )

    def _assert_quota_for_upload(self, incoming_bytes: int) -> StorageQuotaStatus:
        quota = self.quota_check(incoming_bytes=incoming_bytes)
        if not quota.can_accept_upload:
            raise DriveQuotaExceededError(
                quota.detail or "Google Drive free storage quota would be exceeded; upload halted safely",
                required_bytes=incoming_bytes + self._min_free_buffer_bytes,
                available_bytes=quota.available_bytes,
                limit_bytes=quota.limit_bytes,
                usage_bytes=quota.usage_bytes,
            )
        return quota

    def health_check(self) -> StorageHealthStatus:
        try:
            root_id, _ = self.ensure_directory_tree()
            # Probe write/delete permission with a tiny lockfile inside _selftest
            probe = self._root_dir / "_selftest" / f".health-{uuid4().hex[:8]}.tmp"
            probe.write_bytes(b"ok")
            probe.unlink(missing_ok=True)
            quota = self.quota_check(incoming_bytes=0)
            acc = self.get_account_info()
            return StorageHealthStatus(
                provider=StorageProvider.GOOGLE_DRIVE,
                healthy=True,
                status="CONNECTED",
                account_email=acc.get("email"),
                scope=DRIVE_DESKTOP_SYNC_SCOPE,
                root_folder_id=root_id,
                root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
                quota=quota,
                detail="Google Drive for Desktop synced folder verified",
            )
        except TrainingStorageError as exc:
            logger.warning(
                "Google Drive Desktop health check failed (%s) at %s: %s",
                exc.code,
                self._root_dir,
                exc,
            )
            return StorageHealthStatus(
                provider=StorageProvider.GOOGLE_DRIVE,
                healthy=False,
                status="ERROR",
                scope=DRIVE_DESKTOP_SYNC_SCOPE,
                root_folder_id=self._root_folder_id,
                root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
                error_code=exc.code,
                detail=str(exc),
            )
        except OSError as exc:
            logger.warning(
                "Google Drive Desktop health check I/O error at %s: %s",
                self._root_dir,
                exc,
            )
            return StorageHealthStatus(
                provider=StorageProvider.GOOGLE_DRIVE,
                healthy=False,
                status="ERROR",
                scope=DRIVE_DESKTOP_SYNC_SCOPE,
                root_folder_id=self._root_folder_id,
                root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
                error_code="DRIVE_DESKTOP_IO_ERROR",
                detail="Google Drive for Desktop synced folder is not accessible or writable",
            )

    def _find_existing_immutable_index(self, logical_path: str, sha256_hex: str) -> dict[str, Any] | None:
        idx_dir = self._index_dir()
        if not idx_dir.is_dir():
            return None
        norm_sha = sha256_hex.strip().lower()
        target = self._resolve_target_path(logical_path)
        key_path = self._immutable_key_index_path(logical_path, norm_sha)
        with self._index_lock:
            if key_path.is_file():
                try:
                    rec = json.loads(key_path.read_text(encoding="utf-8"))
                except Exception:
                    rec = None
                if (
                    isinstance(rec, dict)
                    and rec.get("logical_path") == logical_path
                    and str(rec.get("sha256") or "").lower() == norm_sha
                    and rec.get("file_id")
                    and target.is_file()
                ):
                    return rec
            for entry_file in sorted(idx_dir.glob("gdesk_*.json"), key=lambda p: p.name):
                try:
                    rec = json.loads(entry_file.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if (
                    isinstance(rec, dict)
                    and rec.get("logical_path") == logical_path
                    and str(rec.get("sha256") or "").lower() == norm_sha
                    and rec.get("file_id")
                ):
                    if target.is_file():
                        try:
                            self._write_json_atomic(key_path, rec)
                        except OSError:
                            pass
                        return rec
        return None

    def put(
        self,
        logical_path: str,
        data: bytes | Path | BinaryIO,
        *,
        content_type: str = "application/octet-stream",
        expected_sha256: str | None = None,
        metadata: dict[str, str] | None = None,
        size_bytes: int | None = None,
    ) -> StoredArtifact:
        clean_path = validate_logical_path(logical_path, require_known_category=True)
        self.ensure_directory_tree()
        stream, should_close, actual_size, actual_sha = self._prepare_upload_stream(
            data,
            expected_sha256=expected_sha256,
            size_bytes=size_bytes,
        )
        base_pos = stream.tell()
        try:
            self._assert_quota_for_upload(actual_size)
            category = clean_path.split("/", 1)[0]
            if category in _IMMUTABLE_CATEGORIES:
                existing = self._find_existing_immutable_index(clean_path, actual_sha)
                if existing and existing.get("file_id"):
                    existing_id = validate_drive_file_id(str(existing["file_id"]))
                    return StoredArtifact(
                        provider=StorageProvider.GOOGLE_DRIVE,
                        reference=format_gdrive_ref(existing_id),
                        logical_path=clean_path,
                        sha256=actual_sha,
                        size_bytes=actual_size,
                        content_type=content_type,
                        drive_file_id=existing_id,
                        deduplicated=True,
                        metadata=dict(metadata or {}),
                    )

            target = self._resolve_target_path(clean_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(f".{target.name}.{uuid4().hex[:8]}.tmp")
            try:
                stream.seek(base_pos)
                digest = hashlib.sha256()
                written = 0
                with tmp.open("wb") as out:
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        digest.update(chunk)
                        written += len(chunk)
                if written != actual_size or digest.hexdigest() != actual_sha:
                    raise DriveIntegrityError("Written file integrity mismatch on Google Drive Desktop mount")
                os.replace(tmp, target)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise

            file_id = _make_desktop_file_id()
            record = {
                "file_id": file_id,
                "logical_path": clean_path,
                "name": target.name,
                "sha256": actual_sha,
                "size_bytes": actual_size,
                "content_type": content_type,
                "metadata": dict(metadata or {}),
            }
            with self._index_lock:
                self._write_json_atomic(self._index_path(file_id), record)
                if category in _IMMUTABLE_CATEGORIES:
                    self._write_json_atomic(
                        self._immutable_key_index_path(clean_path, actual_sha),
                        record,
                    )
            return StoredArtifact(
                provider=StorageProvider.GOOGLE_DRIVE,
                reference=format_gdrive_ref(file_id),
                logical_path=clean_path,
                sha256=actual_sha,
                size_bytes=actual_size,
                content_type=content_type,
                drive_file_id=file_id,
                deduplicated=False,
                metadata=dict(metadata or {}),
            )
        finally:
            if should_close:
                stream.close()

    def get_metadata(self, reference: str) -> ArtifactMetadata:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleDriveDesktopStore only handles gdrive:// references")
        self._assert_root_available()
        rec = self._read_index_entry(parsed.drive_file_id)
        logical_path = str(rec["logical_path"])
        target = self._resolve_target_path(logical_path)
        if not target.is_file():
            raise DriveNotFoundError(f"Drive Desktop artifact file is missing on disk: {logical_path}")
        stat = target.stat()
        return ArtifactMetadata(
            provider=StorageProvider.GOOGLE_DRIVE,
            reference=format_gdrive_ref(parsed.drive_file_id),
            name=target.name,
            size_bytes=int(stat.st_size),
            sha256=str(rec.get("sha256") or "").strip().lower() or None,
            content_type=str(rec.get("content_type") or "application/octet-stream"),
            trashed=False,
            is_public=False,
            drive_file_id=parsed.drive_file_id,
            logical_path=logical_path,
            extra=dict(rec.get("metadata") or {}),
        )

    def exists(self, reference: str) -> bool:
        try:
            meta = self.get_metadata(reference)
            return not meta.trashed
        except DriveNotFoundError:
            return False

    def open_stream(
        self,
        reference: str,
        *,
        chunk_size: int = 1024 * 1024,
        expected_sha256: str | None = None,
        preloaded_meta: ArtifactMetadata | None = None,
    ) -> Iterator[bytes]:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleDriveDesktopStore only handles gdrive:// references")
        expected = validate_sha256(expected_sha256, required=False)
        meta = preloaded_meta if preloaded_meta is not None else self.get_metadata(reference)
        if not meta.logical_path:
            raise DriveNotFoundError("Drive Desktop artifact missing logical_path")
        target = self._resolve_target_path(meta.logical_path)
        if not target.is_file():
            raise DriveNotFoundError(f"Drive Desktop artifact missing: {meta.logical_path}")

        step = max(64 * 1024, int(chunk_size))

        def _iter_file() -> Iterator[bytes]:
            digest = hashlib.sha256()
            with target.open("rb") as handle:
                while True:
                    chunk = handle.read(step)
                    if not chunk:
                        break
                    digest.update(chunk)
                    yield chunk
            actual = digest.hexdigest()
            authoritative = expected or meta.sha256
            if authoritative and actual != authoritative.lower():
                raise DriveIntegrityError(
                    f"Streamed artifact SHA-256 mismatch: expected {authoritative[:12]}, got {actual[:12]}"
                )

        return _iter_file()

    def get(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
        max_bytes: int | None = None,
    ) -> bytes:
        meta = self.get_metadata(reference)
        if max_bytes is not None and meta.size_bytes is not None and meta.size_bytes > max_bytes:
            raise DriveIntegrityError(f"Artifact size {meta.size_bytes} exceeds max_bytes limit {max_bytes}")
        buf = bytearray()
        for chunk in self.open_stream(reference, expected_sha256=expected_sha256, preloaded_meta=meta):
            buf.extend(chunk)
            if max_bytes is not None and len(buf) > max_bytes:
                raise DriveIntegrityError(f"Artifact download exceeded max_bytes limit {max_bytes}")
        return bytes(buf)

    def delete_if_unreferenced(
        self,
        reference: str,
        *,
        is_referenced_check: Callable[[str], bool],
    ) -> bool:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleDriveDesktopStore only handles gdrive:// references")
        if is_referenced_check(parsed.raw):
            return False
        idx_path = self._index_path(parsed.drive_file_id)
        if not idx_path.is_file():
            return False
        logical_path = ""
        sha_hex = ""
        try:
            rec = json.loads(idx_path.read_text(encoding="utf-8"))
            if isinstance(rec, dict):
                logical_path = str(rec.get("logical_path") or "")
                sha_hex = str(rec.get("sha256") or "").strip().lower()
            if logical_path:
                target = self._resolve_target_path(logical_path)
                target.unlink(missing_ok=True)
        finally:
            with self._index_lock:
                idx_path.unlink(missing_ok=True)
                if logical_path and sha_hex:
                    try:
                        self._immutable_key_index_path(logical_path, sha_hex).unlink(missing_ok=True)
                    except OSError:
                        pass
        return True

    def self_test(self) -> DriveSelfTestResult:
        token = uuid4().hex[:12]
        logical_path = f"_selftest/selftest-{token}.txt"
        payload = f"viread-flow2-drive-desktop-selftest:{token}:{int(time.time())}".encode("utf-8")
        expected_sha = hashlib.sha256(payload).hexdigest()
        stored = self.put(
            logical_path,
            payload,
            content_type="text/plain",
            expected_sha256=expected_sha,
            metadata={"purpose": "selftest"},
        )
        downloaded = self.get(stored.reference, expected_sha256=expected_sha, max_bytes=64 * 1024)
        meta = self.get_metadata(stored.reference)
        deleted = self.delete_if_unreferenced(stored.reference, is_referenced_check=lambda _ref: False)
        quota = self.quota_check(incoming_bytes=0)
        ok = downloaded == payload and not meta.is_public and deleted
        return DriveSelfTestResult(
            ok=ok,
            logical_path=logical_path,
            drive_file_id=stored.drive_file_id,
            sha256=expected_sha,
            size_bytes=len(payload),
            deleted_after_test=deleted,
            is_private=not meta.is_public,
            quota=quota,
            detail="Upload, SHA-256 verification, private read-back, and cleanup succeeded"
            if ok
            else "Self-test completed with one or more failed assertions",
        )

    def _resume_file_id(self, logical_path: str) -> str:
        return f"gdesk_res_{hashlib.sha256(logical_path.encode('utf-8')).hexdigest()[:24]}"

    def list_resume_files(self, job_id: str) -> list[dict[str, Any]]:
        clean_job = str(job_id or "").strip().lower()
        validate_resume_object_path(clean_job, "resume-manifest.json")
        self._assert_root_available()
        job_dir = (self._root_dir / "resume" / "jobs" / clean_job).resolve()
        if not job_dir.is_dir():
            return []
        results: list[dict[str, Any]] = []
        for prefix, folder in (("", job_dir), ("blobs/", job_dir / "blobs")):
            if not folder.is_dir():
                continue
            for entry in sorted(folder.iterdir(), key=lambda p: p.name):
                if not entry.is_file() or entry.name.startswith(".") or entry.name.endswith(".tmp"):
                    continue
                rel_name = f"{prefix}{entry.name}"
                logical_path = f"resume/jobs/{clean_job}/{rel_name}"
                digest = hashlib.sha256()
                with entry.open("rb") as h:
                    while True:
                        buf = h.read(1024 * 1024)
                        if not buf:
                            break
                        digest.update(buf)
                results.append(
                    {
                        "name": rel_name,
                        "drive_file_id": self._resume_file_id(logical_path),
                        "size_bytes": int(entry.stat().st_size),
                        "sha256": digest.hexdigest(),
                    }
                )
        return results

    def put_resume_file(
        self,
        job_id: str,
        relative_path: str,
        data: bytes | Path | BinaryIO,
        *,
        content_type: str = "application/octet-stream",
        expected_sha256: str | None = None,
    ) -> StoredArtifact:
        logical_path = validate_resume_object_path(job_id, relative_path)
        stored = self.put(
            logical_path,
            data,
            content_type=content_type,
            expected_sha256=expected_sha256,
            metadata={"purpose": "colab_resume", "job_id": str(job_id).strip().lower()},
        )
        self._delete_index_entries_for_logical_path(
            logical_path,
            exclude_file_id=stored.drive_file_id,
        )
        return stored

    def open_resume_file_stream(
        self,
        job_id: str,
        relative_path: str,
        *,
        expected_sha256: str | None = None,
    ) -> tuple[ArtifactMetadata, Iterator[bytes]]:
        logical_path = validate_resume_object_path(job_id, relative_path)
        target = self._resolve_target_path(logical_path)
        if not target.is_file():
            raise DriveNotFoundError(f"Resume file not found on Google Drive Desktop: {relative_path}")
        expected = validate_sha256(expected_sha256, required=False)
        stat = target.stat()
        file_id = self._resume_file_id(logical_path)
        meta = ArtifactMetadata(
            provider=StorageProvider.GOOGLE_DRIVE,
            reference=format_gdrive_ref(file_id),
            name=target.name,
            size_bytes=int(stat.st_size),
            sha256=expected,
            content_type="application/json" if target.name.endswith(".json") else "application/octet-stream",
            trashed=False,
            is_public=False,
            drive_file_id=file_id,
            logical_path=logical_path,
        )

        def _iter_resume() -> Iterator[bytes]:
            digest = hashlib.sha256()
            with target.open("rb") as h:
                while True:
                    chunk = h.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    yield chunk
            if expected and digest.hexdigest() != expected:
                raise DriveIntegrityError("Resume artifact SHA-256 mismatch")

        return meta, _iter_resume()

    def delete_resume_file(self, job_id: str, relative_path: str) -> bool:
        logical_path = validate_resume_object_path(job_id, relative_path)
        target = self._resolve_target_path(logical_path)
        existed = target.is_file()
        target.unlink(missing_ok=True)
        removed_idx = self._delete_index_entries_for_logical_path(logical_path)
        return existed or removed_idx > 0
