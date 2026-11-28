from __future__ import annotations

"""Integrity-checked, job-scoped checkpoint resume storage for Colab Enterprise."""

import hashlib
import json
import os
import re
import shutil
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

SCHEMA = "viread-colab-resume-v1"
MANIFEST_NAME = "resume-manifest.json"
BEST_RE = re.compile(r"^best-[a-f0-9]{64}\.pth$")
BENCHMARK_REPORT_RE = re.compile(r"^(pilot|production)-[a-f0-9]{64}(?:-[a-f0-9]{64})?(?:-benchmark)?\.json$")
JOB_ID_RE = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", re.I)
IDENTITY_FIELDS = (
    "training_job_id", "profile", "dataset_manifest_sha256", "parent_checkpoint_sha256",
    "config_sha256", "repository_commit",
    "locked_test_manifest_sha256", "locked_test_version_id",
)
LINEAGE_IDENTITY_FIELDS = tuple(f for f in IDENTITY_FIELDS if f != "repository_commit")
REQUIRED_IDENTITY_FIELDS = IDENTITY_FIELDS[:6]


def _lineage_identity(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return {field: value.get(field) for field in LINEAGE_IDENTITY_FIELDS}
FIXED_FILES = {
    "latest.pt", "candidate.pth", "candidate.json", "candidate.manifest.json",
    "locked-test-report.json",
}
_IGNORED_OS_FILES = frozenset({".DS_Store", "desktop.ini", "Thumbs.db"})


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe_name(name: str) -> bool:
    return (
        name == MANIFEST_NAME
        or name in FIXED_FILES
        or bool(BEST_RE.fullmatch(name))
        or bool(BENCHMARK_REPORT_RE.fullmatch(name))
    )


def _gcs_location(uri: str) -> tuple[str, str]:
    parsed = urlsplit(uri)
    if parsed.scheme != "gs" or not parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("resume state URI must be a gs:// bucket/prefix URI")
    prefix = parsed.path.strip("/")
    return parsed.netloc, prefix


class GCSJobStateStore:
    """Persist only resumable state for one immutable job; manifest commits each snapshot."""

    def __init__(self, uri: str, identity: dict[str, str], run_dir: str | Path,
                 *, client: Any | None = None):
        missing = [field for field in REQUIRED_IDENTITY_FIELDS if not identity.get(field)]
        if missing:
            raise ValueError("resume identity is incomplete: " + ", ".join(missing))
        if not JOB_ID_RE.fullmatch(identity["training_job_id"]):
            raise ValueError("resume state requires a canonical training job UUID")
        for field in ("dataset_manifest_sha256", "parent_checkpoint_sha256", "config_sha256"):
            if not re.fullmatch(r"[a-f0-9]{64}", identity[field].lower()):
                raise ValueError(f"resume identity {field} must be a SHA-256 digest")
        if not re.fullmatch(r"[a-f0-9]{40}", identity["repository_commit"].lower()):
            raise ValueError("resume identity repository_commit must be a pinned Git SHA")
        if identity["profile"] not in {"FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED"}:
            raise ValueError("resume state has an unsupported training profile")
        self.bucket_name, base_prefix = _gcs_location(uri)
        self.prefix = "/".join(part for part in (base_prefix, "jobs", identity["training_job_id"]) if part)
        self.identity = {key: str(identity.get(key) or "unregistered") for key in IDENTITY_FIELDS}
        self.run_dir = Path(run_dir)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        if client is None:
            from google.cloud import storage

            client = storage.Client()
        self.client = client
        self.bucket = client.bucket(self.bucket_name)
        self._lock = threading.RLock()
        self._uploaded: dict[str, tuple[int, int, str]] = {}

    def _blob_name(self, filename: str) -> str:
        if not _safe_name(filename):
            raise ValueError("unsafe resume state filename")
        return f"{self.prefix}/{filename}" if self.prefix else filename

    def _list(self) -> list[Any]:
        return list(self.client.list_blobs(self.bucket_name, prefix=f"{self.prefix}/"))

    def _read_manifest(self) -> tuple[Any | None, dict[str, Any] | None, list[Any]]:
        blobs = self._list()
        manifest_blob = next((blob for blob in blobs if blob.name == self._blob_name(MANIFEST_NAME)), None)
        if manifest_blob is None:
            if blobs:
                raise ValueError("uncommitted GCS resume objects exist without a manifest; refusing a fresh run")
            return None, None, blobs
        try:
            manifest = json.loads(manifest_blob.download_as_bytes())
        except Exception as exc:
            raise ValueError("GCS resume manifest cannot be read") from exc
        if (
            manifest.get("schema") != SCHEMA
            or _lineage_identity(manifest.get("identity")) != _lineage_identity(self.identity)
        ):
            raise ValueError("GCS resume manifest identity mismatch; refusing to mix training lineage")
        files = manifest.get("files")
        if not isinstance(files, dict):
            raise ValueError("GCS resume manifest files are invalid")
        for filename, record in files.items():
            if filename == MANIFEST_NAME or not _safe_name(filename) or not isinstance(record, dict):
                raise ValueError("GCS resume manifest contains an unsafe file record")
            if (not isinstance(record.get("bytes"), int) or record["bytes"] < 0
                    or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", "")))):
                raise ValueError("GCS resume manifest contains invalid size or checksum")
        return manifest_blob, manifest, blobs

    def restore(self) -> dict[str, str]:
        """Restore only committed files after validating the job identity, size, and checksum."""
        with self._lock:
            _, manifest, blobs = self._read_manifest()
            if manifest is None:
                return {}
            by_name = {blob.name: blob for blob in blobs}
            restored: dict[str, str] = {}
            for filename, record in manifest["files"].items():
                blob = by_name.get(self._blob_name(filename))
                if blob is None:
                    raise ValueError(f"GCS resume object is missing: {filename}")
                destination = self.run_dir / filename
                temporary = destination.with_name(destination.name + ".gcs-download")
                temporary.unlink(missing_ok=True)
                try:
                    blob.download_to_filename(str(temporary))
                    if temporary.stat().st_size != record["bytes"] or _sha256(temporary) != record["sha256"]:
                        raise ValueError(f"GCS resume object integrity check failed: {filename}")
                    temporary.replace(destination)
                finally:
                    temporary.unlink(missing_ok=True)
                if filename.endswith(".json"):
                    try:
                        json.loads(destination.read_text(encoding="utf-8"))
                    except Exception as exc:
                        destination.unlink(missing_ok=True)
                        raise ValueError(f"GCS resume JSON is invalid: {filename}") from exc
                self._uploaded[filename] = (destination.stat().st_mtime_ns,
                                            destination.stat().st_size, record["sha256"])
                restored[filename] = record["sha256"]
            return restored

    def _local_files(self) -> dict[str, Path]:
        selected = {}
        for path in self.run_dir.iterdir():
            if path.is_file() and path.name != MANIFEST_NAME and _safe_name(path.name):
                if path.name.endswith(".json"):
                    try:
                        json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                        # A partially written report/record is not a committed snapshot.
                        continue
                selected[path.name] = path
        return selected

    def sync(self) -> dict[str, str]:
        """Upload changed artifacts, publish the manifest last, and remove obsolete best weights."""
        with self._lock:
            manifest_blob, old_manifest, remote_blobs = self._read_manifest()
            remote_by_name = {blob.name: blob for blob in remote_blobs}
            manifest_remote = remote_by_name.get(self._blob_name(MANIFEST_NAME))
            local_files = self._local_files()
            if not local_files:
                return old_manifest.get("files", {}) if old_manifest else {}

            records: dict[str, dict[str, Any]] = {}
            for filename, path in sorted(local_files.items()):
                stat = path.stat()
                digest = _sha256(path)
                signature = (stat.st_mtime_ns, stat.st_size, digest)
                prior = old_manifest.get("files", {}).get(filename) if old_manifest else None
                if (prior and prior.get("bytes") == stat.st_size and prior.get("sha256") == digest
                        and self._uploaded.get(filename) == signature):
                    records[filename] = prior
                    continue
                blob = self.bucket.blob(self._blob_name(filename))
                existing = remote_by_name.get(blob.name)
                blob.upload_from_filename(
                    str(path), if_generation_match=0 if existing is None else int(existing.generation),
                )
                remote_by_name[blob.name] = blob
                records[filename] = {"bytes": stat.st_size, "sha256": digest}
                self._uploaded[filename] = signature

            manifest = {"schema": SCHEMA, "identity": self.identity, "files": records}
            temporary_manifest = self.run_dir / (MANIFEST_NAME + ".tmp")
            temporary_manifest.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")),
                                          encoding="utf-8")
            try:
                manifest_blob = self.bucket.blob(self._blob_name(MANIFEST_NAME))
                manifest_blob.upload_from_filename(
                    str(temporary_manifest),
                    if_generation_match=0 if manifest_remote is None else int(manifest_remote.generation),
                )
            finally:
                temporary_manifest.unlink(missing_ok=True)

            keep_names = {self._blob_name(name) for name in records}
            keep_names.add(self._blob_name(MANIFEST_NAME))
            for blob in remote_blobs:
                if blob.name not in keep_names:
                    blob.delete()
            return {name: record["sha256"] for name, record in records.items()}


class LocalDriveJobStateStore:
    """Zero-cost integrity-checked resume store on mounted Google Drive for Colab Free.

    Persists resumable state under ``<resume_root>/jobs/<training_job_id>/`` using
    atomic write-and-replace, manifest-last commits, strict lineage identity checks,
    SHA-256 verification on restore, and automatic pruning of obsolete best weights.
    """

    def __init__(
        self,
        resume_root: str | Path,
        identity: dict[str, str],
        run_dir: str | Path,
    ) -> None:
        missing = [field for field in REQUIRED_IDENTITY_FIELDS if not identity.get(field)]
        if missing:
            raise ValueError("resume identity is incomplete: " + ", ".join(missing))
        if not JOB_ID_RE.fullmatch(identity["training_job_id"]):
            raise ValueError("resume state requires a canonical training job UUID")
        for field in ("dataset_manifest_sha256", "parent_checkpoint_sha256", "config_sha256"):
            if not re.fullmatch(r"[a-f0-9]{64}", identity[field].lower()):
                raise ValueError(f"resume identity {field} must be a SHA-256 digest")
        commit_val = str(identity["repository_commit"]).lower()
        if commit_val != "local-unpinned" and not re.fullmatch(r"[a-f0-9]{40}", commit_val):
            raise ValueError("resume identity repository_commit must be a pinned Git SHA")
        if identity["profile"] not in {"FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED"}:
            raise ValueError("resume state has an unsupported training profile")

        self.resume_root = Path(resume_root)
        self.job_dir = self.resume_root / "jobs" / identity["training_job_id"]
        self.blobs_dir = self.job_dir / "blobs"
        self.job_dir.mkdir(parents=True, exist_ok=True)
        self.blobs_dir.mkdir(parents=True, exist_ok=True)
        self.identity = {key: str(identity.get(key) or "unregistered") for key in IDENTITY_FIELDS}
        self.run_dir = Path(run_dir)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._uploaded: dict[str, tuple[int, int, str]] = {}

    def _remote_files(self) -> dict[str, Path]:
        if not self.job_dir.is_dir():
            return {}
        return {
            path.name: path
            for path in self.job_dir.iterdir()
            if path.is_file()
            and not path.name.endswith(".tmp")
            and path.name not in _IGNORED_OS_FILES
        }

    def _read_manifest(self) -> tuple[dict[str, Any] | None, dict[str, Path]]:
        remote = self._remote_files()
        manifest_path = remote.get(MANIFEST_NAME)
        if manifest_path is None:
            if remote:
                raise ValueError(
                    "uncommitted Drive resume files exist without a manifest; refusing a fresh run"
                )
            return None, remote
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValueError("Drive resume manifest cannot be read") from exc
        if (
            manifest.get("schema") != SCHEMA
            or _lineage_identity(manifest.get("identity")) != _lineage_identity(self.identity)
        ):
            raise ValueError(
                "Drive resume manifest identity mismatch; refusing to mix training lineage"
            )
        files = manifest.get("files")
        if not isinstance(files, dict):
            raise ValueError("Drive resume manifest files are invalid")
        for filename, record in files.items():
            if filename == MANIFEST_NAME or not _safe_name(filename) or not isinstance(record, dict):
                raise ValueError("Drive resume manifest contains an unsafe file record")
            if (
                not isinstance(record.get("bytes"), int)
                or record["bytes"] < 0
                or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", "")))
            ):
                raise ValueError("Drive resume manifest contains invalid size or checksum")
        return manifest, remote

    def _resolve_blob_path(self, filename: str, record: dict[str, Any], remote: dict[str, Path]) -> Path | None:
        blob_sha = str(record.get("sha256", "")).lower()
        blob_ref = record.get("blob")
        if isinstance(blob_ref, str) and blob_ref == f"blobs/{blob_sha}":
            candidate = self.blobs_dir / blob_sha
            if candidate.is_file():
                return candidate
        return remote.get(filename)

    def restore(self) -> dict[str, str]:
        """Restore committed resume files from mounted Drive after verifying identity, size, and SHA-256."""
        with self._lock:
            manifest, remote = self._read_manifest()
            if manifest is None:
                return {}
            restored: dict[str, str] = {}
            for filename, record in manifest["files"].items():
                source = self._resolve_blob_path(filename, record, remote)
                if source is None or not source.is_file():
                    raise ValueError(f"Drive resume object is missing: {filename}")
                destination = self.run_dir / filename
                temporary = destination.with_name(destination.name + ".drive-restore")
                temporary.unlink(missing_ok=True)
                try:
                    shutil.copyfile(source, temporary)
                    if temporary.stat().st_size != record["bytes"] or _sha256(temporary) != record["sha256"]:
                        raise ValueError(f"Drive resume object integrity check failed: {filename}")
                    temporary.replace(destination)
                finally:
                    temporary.unlink(missing_ok=True)
                if filename.endswith(".json"):
                    try:
                        json.loads(destination.read_text(encoding="utf-8"))
                    except Exception as exc:
                        destination.unlink(missing_ok=True)
                        raise ValueError(f"Drive resume JSON is invalid: {filename}") from exc
                self._uploaded[filename] = (
                    destination.stat().st_mtime_ns,
                    destination.stat().st_size,
                    record["sha256"],
                )
                restored[filename] = record["sha256"]
            return restored

    def _local_files(self) -> dict[str, Path]:
        selected: dict[str, Path] = {}
        for path in self.run_dir.iterdir():
            if path.is_file() and path.name != MANIFEST_NAME and _safe_name(path.name):
                if path.name.endswith(".json"):
                    try:
                        json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                        continue
                selected[path.name] = path
        return selected

    def sync(self) -> dict[str, str]:
        """Persist immutable content-addressed blobs, atomically commit manifest last, then prune old blobs.

        Because each version is written under ``blobs/<sha256>`` instead of overwriting
        the previous committed file in place, a mid-sync Colab disconnect leaves the
        prior committed snapshot 100% intact and restorable.
        """
        with self._lock:
            old_manifest, remote_files = self._read_manifest()
            local_files = self._local_files()
            if not local_files:
                return (
                    {k: v["sha256"] for k, v in old_manifest.get("files", {}).items()}
                    if old_manifest
                    else {}
                )

            records: dict[str, dict[str, Any]] = {}
            keep_blobs: set[str] = set()
            for filename, path in sorted(local_files.items()):
                stat = path.stat()
                digest = _sha256(path)
                signature = (stat.st_mtime_ns, stat.st_size, digest)
                blob_target = self.blobs_dir / digest
                keep_blobs.add(digest)
                if not (blob_target.is_file() and blob_target.stat().st_size == stat.st_size):
                    tmp_target = self.blobs_dir / f"{digest}.{os.getpid()}.tmp"
                    try:
                        with path.open("rb") as src_fh, tmp_target.open("wb") as dst_fh:
                            shutil.copyfileobj(src_fh, dst_fh, length=1024 * 1024)
                            dst_fh.flush()
                            os.fsync(dst_fh.fileno())
                        if tmp_target.stat().st_size != stat.st_size or _sha256(tmp_target) != digest:
                            raise ValueError(f"Drive resume write verification failed: {filename}")
                        tmp_target.replace(blob_target)
                    finally:
                        tmp_target.unlink(missing_ok=True)
                records[filename] = {
                    "bytes": stat.st_size,
                    "sha256": digest,
                    "blob": f"blobs/{digest}",
                }
                self._uploaded[filename] = signature

            manifest = {"schema": SCHEMA, "identity": self.identity, "files": records}
            manifest_tmp = self.job_dir / f"{MANIFEST_NAME}.{os.getpid()}.tmp"
            manifest_dest = self.job_dir / MANIFEST_NAME
            try:
                encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
                with manifest_tmp.open("wb") as fh:
                    fh.write(encoded)
                    fh.flush()
                    os.fsync(fh.fileno())
                manifest_tmp.replace(manifest_dest)
            finally:
                manifest_tmp.unlink(missing_ok=True)

            # Prune unreferenced blobs and legacy top-level files only AFTER manifest commit.
            if self.blobs_dir.is_dir():
                for blob_path in self.blobs_dir.iterdir():
                    if blob_path.is_file() and blob_path.name not in keep_blobs:
                        blob_path.unlink(missing_ok=True)
            for filename, remote_path in remote_files.items():
                if filename != MANIFEST_NAME:
                    remote_path.unlink(missing_ok=True)
            return {name: record["sha256"] for name, record in records.items()}


_REMOTE_CHUNK_BYTES = 8 * 1024 * 1024  # Stay safely below Render / reverse-proxy upload limits


class RemoteBackendJobStateStore:
    """Cross-account Colab resume store proxied through ViRead Backend into the owner's Google Drive.

    Because every read and write goes through the authenticated ViRead worker API,
    switching Google Colab accounts (Account A -> Account B -> Account C) never
    mounts or writes to the secondary account's Drive: 100% of resume snapshots,
    datasets, checkpoints, and benchmarks stay inside the single owner Google Drive
    connected in ViRead Admin.
    """

    def __init__(
        self,
        worker: Any,
        identity: dict[str, str],
        run_dir: str | Path,
        *,
        api_prefix: str = "/books/admin/viread-training/worker",
        chunk_bytes: int = _REMOTE_CHUNK_BYTES,
    ) -> None:
        missing = [field for field in REQUIRED_IDENTITY_FIELDS if not identity.get(field)]
        if missing:
            raise ValueError("resume identity is incomplete: " + ", ".join(missing))
        if not JOB_ID_RE.fullmatch(identity["training_job_id"]):
            raise ValueError("resume state requires a canonical training job UUID")
        for field in ("dataset_manifest_sha256", "parent_checkpoint_sha256", "config_sha256"):
            if not re.fullmatch(r"[a-f0-9]{64}", identity[field].lower()):
                raise ValueError(f"resume identity {field} must be a SHA-256 digest")
        commit_val = str(identity["repository_commit"]).lower()
        if commit_val != "local-unpinned" and not re.fullmatch(r"[a-f0-9]{40}", commit_val):
            raise ValueError("resume identity repository_commit must be a pinned Git SHA")
        if identity["profile"] not in {"FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED"}:
            raise ValueError("resume state has an unsupported training profile")

        self.worker = worker
        self.api_prefix = api_prefix.rstrip("/")
        self.job_id = str(identity["training_job_id"]).lower()
        self.identity = {key: str(identity.get(key) or "unregistered") for key in IDENTITY_FIELDS}
        self.run_dir = Path(run_dir)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.chunk_bytes = max(64 * 1024, int(chunk_bytes))
        self._lock = threading.RLock()
        self._uploaded: dict[str, tuple[int, int, str]] = {}

    def _base_path(self) -> str:
        return f"{self.api_prefix}/jobs/{self.job_id}/resume-state"

    def _list_remote(self) -> dict[str, dict[str, Any]]:
        payload = self.worker.call(
            "GET",
            self._base_path(),
            params={"worker_id": self.worker.worker_id},
        )
        files = payload.get("files") if isinstance(payload, dict) else []
        out: dict[str, dict[str, Any]] = {}
        for item in files or []:
            if isinstance(item, dict) and item.get("name"):
                out[str(item["name"])] = item
        return out

    def _download_bytes(self, object_path: str) -> bytes:
        url = f"{self.worker.api_base}{self._base_path()}/{object_path}"
        stream_helper = getattr(self.worker, "_stream_http_download", None)
        if callable(stream_helper):
            temporary = self.run_dir / f".resume-dl-{os.getpid()}-{threading.get_ident()}.tmp"
            temporary.unlink(missing_ok=True)
            try:
                stream_helper(
                    lambda: self.worker.session.get(
                        url,
                        params={"worker_id": self.worker.worker_id},
                        stream=True,
                        timeout=300,
                    ),
                    temporary,
                    max_attempts=getattr(self.worker, "artifact_fetch_max_attempts", 5),
                    retry_base_seconds=getattr(self.worker, "artifact_fetch_retry_base_seconds", 1.0),
                )
                return temporary.read_bytes()
            finally:
                temporary.unlink(missing_ok=True)
        with self.worker.session.get(
            url,
            params={"worker_id": self.worker.worker_id},
            stream=True,
            timeout=300,
        ) as resp:
            resp.raise_for_status()
            buf = bytearray()
            for block in resp.iter_content(1024 * 1024):
                if block:
                    buf.extend(block)
        return bytes(buf)

    def _upload_bytes(self, object_path: str, data: bytes, expected_sha256: str) -> None:
        self.worker.call(
            "PUT",
            f"{self._base_path()}/{object_path}",
            data={"worker_id": self.worker.worker_id, "expected_sha256": expected_sha256},
            files={"file": (Path(object_path).name, data, "application/octet-stream")},
        )

    def _delete_remote(self, object_path: str) -> None:
        self.worker.call(
            "DELETE",
            f"{self._base_path()}/{object_path}",
            params={"worker_id": self.worker.worker_id},
        )

    def _read_manifest(self) -> tuple[dict[str, Any] | None, dict[str, dict[str, Any]]]:
        remote = self._list_remote()
        if MANIFEST_NAME not in remote:
            if any(not name.startswith("blobs/") for name in remote):
                raise ValueError(
                    "uncommitted remote Drive resume files exist without a manifest; refusing a fresh run"
                )
            return None, remote
        try:
            manifest = json.loads(self._download_bytes(MANIFEST_NAME).decode("utf-8"))
        except Exception as exc:
            raise ValueError("Remote Drive resume manifest cannot be read") from exc
        if (
            manifest.get("schema") != SCHEMA
            or _lineage_identity(manifest.get("identity")) != _lineage_identity(self.identity)
        ):
            raise ValueError(
                "Remote Drive resume manifest identity mismatch; refusing to mix training lineage"
            )
        files = manifest.get("files")
        if not isinstance(files, dict):
            raise ValueError("Remote Drive resume manifest files are invalid")
        for filename, record in files.items():
            if filename == MANIFEST_NAME or not _safe_name(filename) or not isinstance(record, dict):
                raise ValueError("Remote Drive resume manifest contains an unsafe file record")
            if (
                not isinstance(record.get("bytes"), int)
                or record["bytes"] < 0
                or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("sha256", "")))
            ):
                raise ValueError("Remote Drive resume manifest contains invalid size or checksum")
        return manifest, remote

    def restore(self) -> dict[str, str]:
        """Restore committed resume files from the owner's Google Drive via ViRead backend."""
        with self._lock:
            manifest, remote = self._read_manifest()
            if manifest is None:
                return {}
            restored: dict[str, str] = {}
            for filename, record in manifest["files"].items():
                destination = self.run_dir / filename
                temporary = destination.with_name(destination.name + ".remote-restore")
                temporary.unlink(missing_ok=True)
                try:
                    parts = record.get("parts")
                    with temporary.open("wb") as out_fh:
                        if isinstance(parts, list) and parts:
                            for part in parts:
                                part_name = str(part["name"])
                                if part_name not in remote:
                                    raise ValueError(f"Remote Drive resume part missing: {part_name}")
                                raw = self._download_bytes(part_name)
                                if (
                                    len(raw) != int(part["bytes"])
                                    or hashlib.sha256(raw).hexdigest() != str(part["sha256"])
                                ):
                                    raise ValueError(f"Remote Drive resume part integrity failed: {part_name}")
                                out_fh.write(raw)
                        else:
                            blob_name = str(record.get("blob") or filename)
                            if blob_name not in remote:
                                raise ValueError(f"Remote Drive resume object missing: {filename}")
                            out_fh.write(self._download_bytes(blob_name))
                    if temporary.stat().st_size != record["bytes"] or _sha256(temporary) != record["sha256"]:
                        raise ValueError(f"Remote Drive resume integrity check failed: {filename}")
                    temporary.replace(destination)
                finally:
                    temporary.unlink(missing_ok=True)
                if filename.endswith(".json"):
                    try:
                        json.loads(destination.read_text(encoding="utf-8"))
                    except Exception as exc:
                        destination.unlink(missing_ok=True)
                        raise ValueError(f"Remote Drive resume JSON is invalid: {filename}") from exc
                self._uploaded[filename] = (
                    destination.stat().st_mtime_ns,
                    destination.stat().st_size,
                    record["sha256"],
                )
                restored[filename] = record["sha256"]
            return restored

    def _local_files(self) -> dict[str, Path]:
        selected: dict[str, Path] = {}
        for path in self.run_dir.iterdir():
            if path.is_file() and path.name != MANIFEST_NAME and _safe_name(path.name):
                if path.name.endswith(".json"):
                    try:
                        json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                        continue
                selected[path.name] = path
        return selected

    def sync(self) -> dict[str, str]:
        """Upload content-addressed chunks via ViRead backend to owner's Drive, commit manifest last, then prune."""
        with self._lock:
            old_manifest, remote_files = self._read_manifest()
            local_files = self._local_files()
            if not local_files:
                return (
                    {k: v["sha256"] for k, v in old_manifest.get("files", {}).items()}
                    if old_manifest
                    else {}
                )

            records: dict[str, dict[str, Any]] = {}
            keep_remote: set[str] = {MANIFEST_NAME}
            for filename, path in sorted(local_files.items()):
                stat = path.stat()
                digest = _sha256(path)
                signature = (stat.st_mtime_ns, stat.st_size, digest)
                if stat.st_size <= self.chunk_bytes:
                    blob_name = f"blobs/{digest}"
                    keep_remote.add(blob_name)
                    existing = remote_files.get(blob_name)
                    if not (
                        existing
                        and int(existing.get("size_bytes") or 0) == stat.st_size
                        and str(existing.get("sha256") or "").lower() == digest
                    ):
                        self._upload_bytes(blob_name, path.read_bytes(), digest)
                    records[filename] = {
                        "bytes": stat.st_size,
                        "sha256": digest,
                        "blob": blob_name,
                    }
                else:
                    parts_meta: list[dict[str, Any]] = []
                    with path.open("rb") as src_fh:
                        part_idx = 0
                        while True:
                            chunk = src_fh.read(self.chunk_bytes)
                            if not chunk:
                                break
                            part_sha = hashlib.sha256(chunk).hexdigest()
                            part_name = f"blobs/{digest}.part{part_idx:04d}"
                            keep_remote.add(part_name)
                            existing = remote_files.get(part_name)
                            if not (
                                existing
                                and int(existing.get("size_bytes") or 0) == len(chunk)
                                and str(existing.get("sha256") or "").lower() == part_sha
                            ):
                                self._upload_bytes(part_name, chunk, part_sha)
                            parts_meta.append(
                                {"name": part_name, "bytes": len(chunk), "sha256": part_sha}
                            )
                            part_idx += 1
                    records[filename] = {
                        "bytes": stat.st_size,
                        "sha256": digest,
                        "parts": parts_meta,
                    }
                self._uploaded[filename] = signature

            manifest = {"schema": SCHEMA, "identity": self.identity, "files": records}
            encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
            manifest_sha = hashlib.sha256(encoded).hexdigest()
            self._upload_bytes(MANIFEST_NAME, encoded, manifest_sha)

            # Prune obsolete blobs/files ONLY after the new manifest has committed.
            for remote_name in list(remote_files.keys()):
                if remote_name not in keep_remote:
                    try:
                        self._delete_remote(remote_name)
                    except Exception:
                        pass
            return {name: record["sha256"] for name, record in records.items()}
