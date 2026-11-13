from __future__ import annotations

"""Integrity-checked, job-scoped checkpoint resume storage for Colab Enterprise."""

import hashlib
import json
import os
import re
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

SCHEMA = "viread-colab-resume-v1"
MANIFEST_NAME = "resume-manifest.json"
BEST_RE = re.compile(r"^best-[a-f0-9]{64}\.pth$")
JOB_ID_RE = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", re.I)
IDENTITY_FIELDS = (
    "training_job_id", "profile", "dataset_manifest_sha256", "parent_checkpoint_sha256",
    "config_sha256", "repository_commit",
    "locked_test_manifest_sha256", "locked_test_version_id",
)
REQUIRED_IDENTITY_FIELDS = IDENTITY_FIELDS[:6]
FIXED_FILES = {
    "latest.pt", "candidate.pth", "candidate.json", "candidate.manifest.json",
    "locked-test-report.json",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe_name(name: str) -> bool:
    return name == MANIFEST_NAME or name in FIXED_FILES or bool(BEST_RE.fullmatch(name))


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
        if manifest.get("schema") != SCHEMA or manifest.get("identity") != self.identity:
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
