from __future__ import annotations

"""Colab worker for queued ViRead VietOCR jobs.

Use ``run_next_job_once`` from an interactive Colab Free session. The persistent
polling entrypoint is retained for explicitly managed runtimes only.
"""

import hashlib
import json
import logging
import os
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

import requests

from .artifact_store import assemble_shards, shard_file
from .colab_state_store import LocalDriveJobStateStore, RemoteBackendJobStateStore
from .contracts import DatasetRow, ORIGINAL_CHECKPOINT_SHA256, canonical_sha256, sha256_file, write_jsonl

logger = logging.getLogger("viread.vietocr.colab_worker")
API_PREFIX = "/books/admin/viread-training/worker"


def verify_worker_source_lock(config: dict[str, Any]) -> None:
    """Fail closed unless this checkout matches the job's trainer/dependency pins."""
    expected_files = {
        "trainer_sha256": Path(__file__).with_name("train.py"),
        "requirements_sha256": Path(__file__).with_name("requirements.txt"),
        "colab_requirements_sha256": Path(__file__).with_name("requirements-colab.txt"),
    }
    mismatches: list[str] = []
    for key, path in expected_files.items():
        expected = config.get(key)
        actual = sha256_file(path) if path.is_file() else "MISSING"
        if not isinstance(expected, str) or actual != expected:
            exp_short = expected[:12] if isinstance(expected, str) else repr(expected)
            mismatches.append(f"{key}(expected={exp_short},actual={actual[:12]})")
    if mismatches:
        raise ValueError(
            f"WORKER_CODE_OR_DEPENDENCY_LOCK_MISMATCH: "
            f"commit={_current_repo_commit()[:12]} {'; '.join(mismatches)}"
        )


def _current_repo_commit() -> str:
    try:
        output = subprocess.check_output(
            ["git", "-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip().lower()
        if len(output) == 40 and all(ch in "0123456789abcdef" for ch in output):
            return output
    except Exception:
        pass
    return "local-unpinned"


def build_local_drive_state_store_factory(
    resume_root: str | Path,
    *,
    repository_commit: str | None = None,
) -> Callable[[dict[str, Any], Path], LocalDriveJobStateStore]:
    """Create a zero-cost mounted Google Drive state store factory for Colab Free."""
    root = Path(resume_root)
    commit_sha = repository_commit or _current_repo_commit()

    def _factory(job: dict[str, Any], run_dir: Path) -> LocalDriveJobStateStore:
        identity = {
            "training_job_id": str(job["id"]),
            "profile": str(job["profile"]),
            "dataset_manifest_sha256": str(job["manifest_sha256"]),
            "parent_checkpoint_sha256": str(job["parent_checkpoint_sha256"]),
            "config_sha256": str(job["config_sha256"]),
            "repository_commit": commit_sha,
            "locked_test_manifest_sha256": str(job.get("locked_test_manifest_sha256") or "unregistered"),
            "locked_test_version_id": str(job.get("locked_test_version_id") or "unregistered"),
        }
        return LocalDriveJobStateStore(root, identity, run_dir)

    return _factory


def build_remote_backend_state_store_factory(
    worker: Any,
    *,
    repository_commit: str | None = None,
) -> Callable[[dict[str, Any], Path], RemoteBackendJobStateStore]:
    """Create a cross-account resume state store proxied into the owner's Drive via ViRead backend."""
    commit_sha = repository_commit or _current_repo_commit()

    def _factory(job: dict[str, Any], run_dir: Path) -> RemoteBackendJobStateStore:
        identity = {
            "training_job_id": str(job["id"]),
            "profile": str(job["profile"]),
            "dataset_manifest_sha256": str(job["manifest_sha256"]),
            "parent_checkpoint_sha256": str(job["parent_checkpoint_sha256"]),
            "config_sha256": str(job["config_sha256"]),
            "repository_commit": commit_sha,
            "locked_test_manifest_sha256": str(job.get("locked_test_manifest_sha256") or "unregistered"),
            "locked_test_version_id": str(job.get("locked_test_version_id") or "unregistered"),
        }
        return RemoteBackendJobStateStore(worker, identity, run_dir, api_prefix=API_PREFIX)

    return _factory


class ColabWorker:
    ARTIFACT_FETCH_MAX_ATTEMPTS = 5
    ARTIFACT_FETCH_RETRY_BASE_SECONDS = 1.0
    RETRYABLE_HTTP_STATUSES = frozenset({408, 429, 500, 502, 503, 504})

    def __init__(
        self,
        api_base: str,
        token: str,
        work_root: str | Path,
        *,
        poll_seconds: int = 30,
        state_store_factory: Callable[[dict[str, Any], Path], Any] | None = None,
        drive_root: str | Path | None = None,
        resume_root: str | Path | None = None,
        use_remote_resume_store: bool = False,
    ):
        if not api_base.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            raise ValueError("VIREAD_API_BASE must use HTTPS outside localhost")
        if len(token) < 32:
            raise ValueError("VIREAD_TRAINING_WORKER_TOKEN must be at least 32 characters")
        self.api_base = api_base.rstrip("/")
        self.token = token
        self.work_root = Path(work_root)
        self.work_root.mkdir(parents=True, exist_ok=True)
        self.drive_root = Path(drive_root) if (drive_root is not None and str(drive_root).strip()) else None
        self.poll_seconds = max(5, poll_seconds)
        self.artifact_fetch_max_attempts = self.ARTIFACT_FETCH_MAX_ATTEMPTS
        self.artifact_fetch_retry_base_seconds = self.ARTIFACT_FETCH_RETRY_BASE_SECONDS
        has_resume_root = resume_root is not None and str(resume_root).strip() != ""
        if state_store_factory is None:
            if has_resume_root or self.drive_root is not None:
                effective_resume_root = Path(resume_root) if has_resume_root else (self.drive_root / "resume")
                state_store_factory = build_local_drive_state_store_factory(effective_resume_root)
            elif use_remote_resume_store:
                state_store_factory = build_remote_backend_state_store_factory(self)
        self.state_store_factory = state_store_factory
        self.worker_id = f"colab-{uuid.uuid4()}"
        self.runtime_data: dict[str, Any] = {}
        self.session = requests.Session()
        self.session.headers.update({"X-ViRead-Training-Worker": token})

    def call(self, method: str, path: str, **kwargs):
        response = self.session.request(method, self.api_base + path, timeout=300, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else {}

    def claim(self, training_job_id: str | None = None) -> dict[str, Any] | None:
        payload = {"worker_id": self.worker_id, "runtime": self.runtime_data}
        if training_job_id is not None:
            payload["training_job_id"] = training_job_id
        response = self.call("POST", f"{API_PREFIX}/claim", json=payload)
        return response.get("job")

    def report_status(self, status: str, reason_code: str | None = None) -> None:
        self.call("POST", f"{API_PREFIX}/status", json={
            "worker_id": self.worker_id, "status": status,
            "reason_code": reason_code, "runtime": self.runtime_data,
        })

    @staticmethod
    def available_ram_bytes() -> int:
        if os.name == "nt":
            import ctypes

            class _MemoryStatusEx(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            memory = _MemoryStatusEx()
            memory.dwLength = ctypes.sizeof(memory)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
                raise OSError("GlobalMemoryStatusEx failed")
            return int(memory.ullAvailPhys)
        available = int(os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"))
        for maximum_path, current_path in (
            (Path("/sys/fs/cgroup/memory.max"), Path("/sys/fs/cgroup/memory.current")),
            (Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
             Path("/sys/fs/cgroup/memory/memory.usage_in_bytes")),
        ):
            try:
                maximum = maximum_path.read_text(encoding="ascii").strip()
                if maximum.isdigit():
                    current = int(current_path.read_text(encoding="ascii").strip())
                    available = min(available, max(0, int(maximum) - current))
                    break
            except (OSError, ValueError):
                continue
        return available

    @staticmethod
    def assert_runtime_capacity(work_dir: Path) -> dict[str, Any]:
        import torch

        if not torch.cuda.is_available() or not getattr(torch.version, "cuda", None):
            raise RuntimeError("COLAB_CUDA_UNAVAILABLE")
        free_vram, total_vram = torch.cuda.mem_get_info(0)
        minimum_vram = int(os.getenv("VIETOCR_TRAINING_MIN_VRAM_MIB", "6144")) * 1024**2
        if free_vram < minimum_vram:
            raise RuntimeError("COLAB_INSUFFICIENT_VRAM")
        available_ram = ColabWorker.available_ram_bytes()
        # Free Colab T4 runtimes have limited host RAM after PyTorch imports.
        # Dataset images stream from local disk with dataloader workers disabled,
        # so 4 GiB available RAM is the safe minimum for this worker.
        minimum_ram_gb = int(os.getenv("VIETOCR_TRAINING_MIN_RAM_GB", "4"))
        minimum_ram = minimum_ram_gb * 1024**3
        if available_ram < minimum_ram:
            raise RuntimeError("COLAB_INSUFFICIENT_RAM")
        work_dir.mkdir(parents=True, exist_ok=True)
        free_disk = shutil.disk_usage(work_dir).free
        minimum_disk = int(os.getenv("VIETOCR_TRAINING_MIN_DISK_GB", "8")) * 1024**3
        if free_disk < minimum_disk:
            raise RuntimeError("COLAB_INSUFFICIENT_DISK")
        return {"device": torch.cuda.get_device_name(0), "cuda_version": torch.version.cuda,
                "vram_free_bytes": int(free_vram), "vram_total_bytes": int(total_vram),
                "ram_available_bytes": available_ram, "disk_free_bytes": free_disk,
                "torch_version": torch.__version__}

    def heartbeat_loop(self, job_id: str, stop: threading.Event, progress: dict[str, Any]) -> None:
        while not stop.wait(60):
            try:
                self.call("POST", f"{API_PREFIX}/jobs/{job_id}/heartbeat", json={
                    "worker_id": self.worker_id,
                    "stage": str(progress.get("stage", "working"))[:80],
                    "completed_steps": int(progress.get("completed_steps", 0)),
                    "total_steps": int(progress.get("total_steps", 0)),
                    "runtime": progress.get("runtime", self.runtime_data),
                })
            except Exception as exc:  # never log a request URL or secret-bearing headers
                logger.warning("Colab heartbeat unavailable (%s)", type(exc).__name__)

    def dataset(self, job_id: str, *, locked_test: bool = False) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        endpoint = "locked-test" if locked_test else "dataset"
        items: list[dict[str, Any]] = []
        offset = 0
        dataset = None
        while True:
            page = self.call("GET", f"{API_PREFIX}/jobs/{job_id}/{endpoint}", params={
                "worker_id": self.worker_id, "limit": 200, "offset": offset,
            })
            if page.get("dataset") is None:
                return None, []
            dataset = page["dataset"]
            items.extend(page.get("items", []))
            next_offset = page.get("next_offset")
            if next_offset is None:
                break
            offset = int(next_offset)
        return dataset, items

    @staticmethod
    def _parse_content_length(header_value: Any) -> int | None:
        raw = str(header_value or "").strip()
        if raw.isdigit():
            return int(raw)
        return None

    @classmethod
    def _stream_http_download(
        cls,
        getter: Callable[[], Any],
        destination: Path,
        expected_sha256: str | None = None,
        *,
        max_attempts: int | None = None,
        retry_base_seconds: float | None = None,
    ) -> None:
        expected = expected_sha256.lower() if expected_sha256 else None
        if destination.exists():
            if expected is None or sha256_file(destination) == expected:
                return
            raise ValueError("CACHED_OBJECT_HASH_MISMATCH")
        attempts = max(1, int(max_attempts if max_attempts is not None else cls.ARTIFACT_FETCH_MAX_ATTEMPTS))
        base_delay = max(
            0.0,
            float(
                retry_base_seconds
                if retry_base_seconds is not None
                else cls.ARTIFACT_FETCH_RETRY_BASE_SECONDS
            ),
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".download")
        for attempt in range(1, attempts + 1):
            temporary.unlink(missing_ok=True)
            digest = hashlib.sha256()
            bytes_received = 0
            retry_reason: str | None = None
            last_error: Exception | None = None
            try:
                with getter() as response:
                    response.raise_for_status()
                    headers = getattr(response, "headers", None)
                    expected_length = (
                        cls._parse_content_length(headers.get("Content-Length"))
                        if headers is not None and hasattr(headers, "get")
                        else None
                    )
                    with temporary.open("xb") as output:
                        for block in response.iter_content(1024 * 1024):
                            if block:
                                output.write(block)
                                digest.update(block)
                                bytes_received += len(block)
                actual_sha = digest.hexdigest()
                if expected_length is not None and bytes_received != expected_length:
                    last_error = requests.exceptions.ChunkedEncodingError(
                        f"Incomplete artifact response ({bytes_received}/{expected_length} bytes)"
                    )
                    retry_reason = f"truncated_content_length({bytes_received}/{expected_length})"
                elif expected and actual_sha != expected:
                    last_error = ValueError("DOWNLOADED_OBJECT_HASH_MISMATCH")
                    retry_reason = (
                        f"hash_mismatch(bytes={bytes_received},expected={expected[:12]},actual={actual_sha[:12]})"
                    )
                else:
                    temporary.replace(destination)
                    return
            except requests.HTTPError as exc:
                status_code = getattr(getattr(exc, "response", None), "status_code", None)
                if status_code is not None and status_code not in cls.RETRYABLE_HTTP_STATUSES:
                    raise
                last_error = exc
                retry_reason = f"http_{status_code or 'unknown'}"
            except requests.RequestException as exc:
                last_error = exc
                retry_reason = type(exc).__name__
            finally:
                temporary.unlink(missing_ok=True)

            assert last_error is not None
            if attempt >= attempts:
                raise last_error
            delay = base_delay * (2 ** (attempt - 1))
            logger.warning(
                "Artifact download attempt %d/%d failed (%s); retrying in %.1fs",
                attempt,
                attempts,
                retry_reason or type(last_error).__name__,
                delay,
            )
            time.sleep(delay)

    @staticmethod
    def download(url: str, destination: Path, expected_sha256: str | None = None) -> None:
        ColabWorker._stream_http_download(
            lambda: requests.get(url, stream=True, timeout=300),
            destination,
            expected_sha256,
        )

    def _fetch_artifact(
        self,
        url: str | None,
        destination: Path,
        expected_sha256: str | None = None,
        *,
        local_drive_candidates: list[Path] | None = None,
    ) -> None:
        """Download via authenticated backend proxy, external signed URL, or verified mounted Drive fast-path."""
        expected = expected_sha256.lower() if expected_sha256 else None
        if destination.exists():
            if expected is None or sha256_file(destination) == expected:
                return
            raise ValueError("CACHED_OBJECT_HASH_MISMATCH")

        if self.drive_root and local_drive_candidates and expected:
            for candidate in local_drive_candidates:
                try:
                    if candidate.is_file() and sha256_file(candidate) == expected:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        temporary = destination.with_suffix(destination.suffix + ".download")
                        temporary.unlink(missing_ok=True)
                        try:
                            shutil.copyfile(candidate, temporary)
                            if sha256_file(temporary) != expected:
                                raise ValueError("DOWNLOADED_OBJECT_HASH_MISMATCH")
                            temporary.replace(destination)
                        finally:
                            temporary.unlink(missing_ok=True)
                        return
                except OSError:
                    continue

        if not url:
            raise ValueError("ARTIFACT_DOWNLOAD_URL_MISSING")
        is_backend_proxy = url.startswith("/") or url.startswith(self.api_base + "/")
        if not is_backend_proxy:
            self.download(url, destination, expected)
            return

        resolved_url = self.api_base + url if url.startswith("/") else url
        self._stream_http_download(
            lambda: self.session.get(resolved_url, stream=True, timeout=300),
            destination,
            expected,
            max_attempts=self.artifact_fetch_max_attempts,
            retry_base_seconds=self.artifact_fetch_retry_base_seconds,
        )

    def materialize_dataset(self, job_id: str, dataset: dict[str, Any], items: list[dict[str, Any]],
                            run_dir: Path, *, locked_test: bool = False) -> tuple[Path, Path, Path]:
        prefix = "locked-test" if locked_test else "training"
        receipt_path = run_dir / f"{prefix}-receipt.json"
        receipt_url = dataset["manifest_url"]
        manifest_candidates: list[Path] = []
        if self.drive_root:
            v_sha = dataset["version_sha256"]
            if locked_test:
                manifest_candidates.append(self.drive_root / "locked-tests" / "manifests" / f"{v_sha}.json")
            else:
                manifest_candidates.append(self.drive_root / "datasets" / v_sha / "manifest.json")
        self._fetch_artifact(
            receipt_url,
            receipt_path,
            dataset["version_sha256"],
            local_drive_candidates=manifest_candidates,
        )
        image_root = run_dir / f"{prefix}-images"
        rows = []
        total_items = len(items)
        for idx, item in enumerate(items, start=1):
            image_path = image_root / item["image_sha256"]
            img_candidates: list[Path] = []
            if self.drive_root:
                img_sha = str(item["image_sha256"]).lower()
                if locked_test:
                    for cohort_sub in ("production", "pilot"):
                        for ext in ("png", "jpg", "webp"):
                            img_candidates.append(
                                self.drive_root / "locked-tests" / cohort_sub / img_sha[:2] / f"{img_sha}.{ext}"
                            )
            self._fetch_artifact(
                item.get("image_url"),
                image_path,
                item["image_sha256"],
                local_drive_candidates=img_candidates,
            )
            if idx % 25 == 0 or idx == total_items:
                print(f"Downloaded {prefix} images: {idx}/{total_items}", flush=True)
            if locked_test:
                rows.append({"sample_id": item.get("source_annotation_id") or item["sample_id"],
                             "group_id": item["group_id"], "reference": item["label"],
                             "image": image_path.as_posix(), "image_sha256": item["image_sha256"]})
            else:
                rows.append(DatasetRow(
                    image=image_path.as_posix(), label=item["label"], group_id=item["group_id"],
                    source_flow=item["source_flow"], split=item["split"],
                    image_sha256=item["image_sha256"], verified=item["source_flow"] == "FLOW1_VERIFIED",
                    annotation_id=item.get("source_annotation_id") or item["sample_id"],
                ))
        manifest_path = run_dir / f"{prefix}.jsonl"
        if locked_test:
            # The sealed receipt remains the benchmark manifest. The JSONL is only a trace of fetched rows.
            trace = run_dir / "locked-test-fetch.json"
            if not trace.exists():
                trace.write_text(json.dumps(rows, ensure_ascii=False, sort_keys=True), encoding="utf-8")
            return receipt_path, receipt_path, image_root
        if not manifest_path.exists():
            write_jsonl(manifest_path, rows)
        return manifest_path, receipt_path, image_root

    def materialize_parent(self, job: dict[str, Any], run_dir: Path) -> Path:
        artifact = job["active_model"]
        if artifact["checkpoint_sha256"] != job["parent_checkpoint_sha256"]:
            raise ValueError("PARENT_CHECKPOINT_HASH_MISMATCH")
        parent = run_dir / f"parent-{artifact['checkpoint_sha256']}.pth"
        if parent.exists():
            if sha256_file(parent) != artifact["checkpoint_sha256"]:
                raise ValueError("CACHED_PARENT_HASH_MISMATCH")
            return parent
        if artifact["profile"] == "ORIGINAL":
            self._fetch_artifact(artifact["source_url"], parent, artifact["checkpoint_sha256"])
        else:
            shard_root = run_dir / "parent-shards"
            shard_root.mkdir(parents=True, exist_ok=True)
            chunks = []
            for chunk in artifact["chunks"]:
                local = shard_root / f"part-{int(chunk['index']):04d}.bin"
                self._fetch_artifact(chunk["url"], local, chunk["sha256"])
                chunks.append({"index": int(chunk["index"]), "name": local.name,
                               "bytes": int(chunk["bytes"]), "sha256": chunk["sha256"]})
            assemble_shards({"schema": "viread-checkpoint-shards-v1", "filename": parent.name,
                             "bytes": sum(chunk["bytes"] for chunk in chunks),
                             "sha256": artifact["checkpoint_sha256"], "chunks": chunks}, shard_root, parent)
        if sha256_file(parent) != artifact["checkpoint_sha256"]:
            raise ValueError("PARENT_CHECKPOINT_HASH_MISMATCH")
        return parent

    def upload_candidate(self, job: dict[str, Any], candidate: dict[str, Any], run_dir: Path) -> tuple[str, str, Path]:
        job_id = str(job["id"])
        record = run_dir / "candidate.json"
        stable_candidate = run_dir / "candidate.pth"
        if not (record.exists() and stable_candidate.exists()):
            source = Path(candidate["candidate_path"])
            temporary = stable_candidate.with_suffix(".tmp")
            shutil.copyfile(source, temporary)
            temporary.replace(stable_candidate)
            candidate = {**candidate, "candidate_path": str(stable_candidate)}
            record.write_text(json.dumps(candidate, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        else:
            candidate = json.loads(record.read_text(encoding="utf-8"))
            candidate["candidate_path"] = str(stable_candidate)
        if sha256_file(stable_candidate) != candidate["checkpoint_sha256"]:
            raise ValueError("PERSISTED_CANDIDATE_HASH_MISMATCH")
        run_payload = {
            "profile": job["profile"], "dataset_version_id": job["dataset_version_id"],
            "parent_checkpoint_sha256": candidate["parent_checkpoint_sha256"],
            "manifest_sha256": candidate["manifest_sha256"], "config_sha256": candidate["config_sha256"],
            "architecture_sha256": candidate["architecture_sha256"],
            "vocabulary_sha256": candidate["vocabulary_sha256"],
        }
        run = self.call("POST", f"{API_PREFIX}/jobs/{job_id}/runs", params={"worker_id": self.worker_id},
                        json=run_payload)
        run_id = str(run["run_id"])
        job["run_id"] = run_id
        if run["status"] in {"CANDIDATE", "BENCHMARKED"}:
            if run.get("checkpoint_sha256") != candidate["checkpoint_sha256"]:
                raise ValueError("REGISTERED_CANDIDATE_HASH_MISMATCH")
            return run_id, run["status"], stable_candidate
        # Keep multipart bodies well below reverse-proxy request limits. The
        # storage API accepts larger objects, but Render may reject 40 MiB
        # multipart requests before FastAPI can read them.
        chunks_root = run_dir / "upload-shards-8mib"
        manifest_path = chunks_root / "shards.manifest.json"
        if manifest_path.exists():
            shard_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if shard_manifest["sha256"] != candidate["checkpoint_sha256"]:
                raise ValueError("CACHED_CANDIDATE_SHARDS_MISMATCH")
        else:
            shard_manifest = shard_file(stable_candidate, chunks_root, chunk_bytes=8 * 1024 * 1024)
        for chunk in shard_manifest["chunks"]:
            with (chunks_root / chunk["name"]).open("rb") as stream:
                self.call("POST", f"{API_PREFIX}/jobs/{job_id}/runs/{run_id}/chunks",
                          data={"worker_id": self.worker_id, "chunk_index": str(chunk["index"])},
                          files={"file": (chunk["name"], stream, "application/octet-stream")})
        self.call("POST", f"{API_PREFIX}/jobs/{job_id}/runs/{run_id}/complete",
                  params={"worker_id": self.worker_id}, json={
                      "profile": candidate["profile"],
                      "parent_checkpoint_sha256": candidate["parent_checkpoint_sha256"],
                      "manifest_sha256": candidate["manifest_sha256"],
                      "config_sha256": candidate["config_sha256"],
                      "architecture_sha256": candidate["architecture_sha256"],
                      "vocabulary_sha256": candidate["vocabulary_sha256"],
                      "checkpoint_sha256": candidate["checkpoint_sha256"],
                      "checkpoint_bytes": stable_candidate.stat().st_size,
                      "step": int(candidate["steps"]),
                  })
        return run_id, "CANDIDATE", stable_candidate

    def materialize_candidate_artifact(self, job_id: str, run_id: str, run_dir: Path) -> tuple[dict[str, Any], Path]:
        artifact = self.call("GET", f"{API_PREFIX}/jobs/{job_id}/runs/{run_id}/artifact",
                             params={"worker_id": self.worker_id})
        checkpoint_sha = str(artifact.get("checkpoint_sha256", ""))
        checkpoint_bytes = int(artifact.get("checkpoint_bytes") or 0)
        chunks = artifact.get("chunks")
        if len(checkpoint_sha) != 64 or checkpoint_bytes <= 0 or not isinstance(chunks, list) or not chunks:
            raise ValueError("CANDIDATE_ARTIFACT_MANIFEST_INVALID")
        destination = run_dir / f"candidate-{checkpoint_sha}.pth"
        if destination.is_file():
            if destination.stat().st_size == checkpoint_bytes and sha256_file(destination) == checkpoint_sha:
                return artifact, destination
            raise ValueError("CACHED_CANDIDATE_ARTIFACT_HASH_MISMATCH")
        shard_root = run_dir / f"candidate-shards-{checkpoint_sha}"
        shard_root.mkdir(parents=True, exist_ok=True)
        local_chunks = []
        for index, chunk in enumerate(chunks):
            if int(chunk.get("index", -1)) != index:
                raise ValueError("CANDIDATE_ARTIFACT_CHUNK_ORDER_INVALID")
            local = shard_root / f"part-{index:04d}.bin"
            shard_sha = str(chunk["sha256"]).lower()
            shard_candidates = (
                [self.drive_root / "checkpoints" / run_id / f"chunk-{index:04d}-{shard_sha[:12]}.part"]
                if self.drive_root
                else None
            )
            self._fetch_artifact(
                chunk.get("url"),
                local,
                shard_sha,
                local_drive_candidates=shard_candidates,
            )
            if local.stat().st_size != int(chunk.get("bytes", -1)):
                raise ValueError("CANDIDATE_ARTIFACT_CHUNK_SIZE_MISMATCH")
            local_chunks.append({"index": index, "name": local.name,
                                 "bytes": int(chunk["bytes"]), "sha256": chunk["sha256"]})
        assemble_shards({"schema": "viread-checkpoint-shards-v1", "filename": destination.name,
                         "bytes": checkpoint_bytes, "sha256": checkpoint_sha,
                         "chunks": local_chunks}, shard_root, destination)
        if destination.stat().st_size != checkpoint_bytes or sha256_file(destination) != checkpoint_sha:
            destination.unlink(missing_ok=True)
            raise ValueError("CANDIDATE_ARTIFACT_HASH_MISMATCH")
        return artifact, destination

    def process_benchmark_only_job(self, job: dict[str, Any], run_dir: Path,
                                   progress: dict[str, Any]) -> None:
        metadata = job.get("metadata") if isinstance(job.get("metadata"), dict) else {}
        evaluation_type = metadata.get("evaluation_type")
        if evaluation_type not in {"PILOT", "PRODUCTION"}:
            raise ValueError("BENCHMARK_ONLY_EVALUATION_TYPE_INVALID")
        run_id = str(job.get("run_id") or "")
        if not run_id:
            raise ValueError("BENCHMARK_ONLY_RUN_ID_MISSING")
        artifact, candidate = self.materialize_candidate_artifact(str(job["id"]), run_id, run_dir)
        if artifact.get("checkpoint_sha256") != metadata.get("candidate_checkpoint_sha256"):
            raise ValueError("BENCHMARK_ONLY_CANDIDATE_LINEAGE_MISMATCH")
        locked_data, locked_items = self.dataset(str(job["id"]), locked_test=True)
        if (not locked_data or locked_data.get("version_sha256") != job.get("locked_test_manifest_sha256")
                or str(locked_data.get("id")) != str(job.get("locked_test_version_id"))):
            raise ValueError("BENCHMARK_ONLY_COHORT_LINEAGE_MISMATCH")
        receipt, _, cache = self.materialize_dataset(str(job["id"]), locked_data, locked_items,
                                                      run_dir, locked_test=True)
        original = run_dir / f"original-{ORIGINAL_CHECKPOINT_SHA256}.pth"
        if not original.exists():
            from vietocr.tool.utils import download_weights
            downloaded = Path(download_weights("https://vocr.vn/data/vietocr/vgg_transformer.pth", quiet=True))
            if sha256_file(downloaded) != ORIGINAL_CHECKPOINT_SHA256:
                raise ValueError("ORIGINAL_CHECKPOINT_HASH_MISMATCH")
            shutil.copyfile(downloaded, original)
        if sha256_file(original) != ORIGINAL_CHECKPOINT_SHA256:
            raise ValueError("ORIGINAL_CHECKPOINT_HASH_MISMATCH")

        parent = active = None
        parent_hash = active_hash = None
        if evaluation_type == "PRODUCTION":
            parent = self.materialize_parent(job, run_dir)
            active = parent
            parent_hash = active_hash = str(job["parent_checkpoint_sha256"])
            baseline_profile = str((job.get("active_model") or {}).get("profile") or "ORIGINAL")
        else:
            baseline_profile = "ORIGINAL"
        report_path = run_dir / f"{evaluation_type.lower()}-{locked_data['version_sha256']}-benchmark.json"
        if report_path.is_file():
            report = json.loads(report_path.read_text(encoding="utf-8"))
        else:
            from .benchmark import run_locked_benchmark
            report = run_locked_benchmark(
                manifest_path=str(receipt), expected_manifest_sha256=locked_data["version_sha256"],
                original_checkpoint=str(original), candidate_checkpoint=str(candidate),
                candidate_profile=job["profile"], output_path=str(report_path), image_cache_dir=str(cache),
                parent_checkpoint=str(parent) if parent else None,
                active_checkpoint=str(active) if active else None,
                parent_profile=baseline_profile, active_profile=baseline_profile,
            )
        if (report.get("candidate_checkpoint_sha256") != artifact["checkpoint_sha256"]
                or report.get("locked_manifest_sha256") != locked_data["version_sha256"]
                or report.get("parent_checkpoint_sha256") != parent_hash
                or report.get("active_checkpoint_sha256") != active_hash):
            raise ValueError("BENCHMARK_ONLY_REPORT_LINEAGE_MISMATCH")
        progress.update({"stage": "registering_benchmark", "completed_steps": len(report["outputs"]),
                         "total_steps": len(report["outputs"])})
        registered_benchmark = self.call("POST", f"{API_PREFIX}/jobs/{job['id']}/benchmarks",
                  params={"worker_id": self.worker_id}, json={
                      "run_id": run_id,
                      "locked_test_version_id": job["locked_test_version_id"],
                      "locked_test_manifest_sha256": job["locked_test_manifest_sha256"],
                      "parent_checkpoint_sha256": parent_hash,
                      "active_checkpoint_sha256": active_hash,
                      "outputs": [{key: row[key] for key in (
                          "sample_id", "group_id", "original", "candidate", "parent", "active"
                      ) if row.get(key) is not None} for row in report["outputs"]],
                  })
        resolved_gate = (
            (registered_benchmark or {}).get("gate_status")
            or (report.get("quality_gate") or {}).get("status")
        )
        self.call("POST", f"{API_PREFIX}/jobs/{job['id']}/finish", json={
            "worker_id": self.worker_id, "run_id": run_id,
            "status": "BENCHMARKED" if resolved_gate == "V2_WIN"
                      and evaluation_type == "PRODUCTION" else "QUALITY_GATE_REJECTED",
            "runtime": self.runtime_data,
        })

    def process_job(self, job: dict[str, Any]) -> None:
        job_id = str(job["id"])
        run_dir = self.work_root / job_id
        run_dir.mkdir(parents=True, exist_ok=True)
        metadata = job.get("metadata") if isinstance(job.get("metadata"), dict) else {}
        is_benchmark_only = metadata.get("operation") == "BENCHMARK_ONLY"
        # BENCHMARK_ONLY evaluations reuse the training job_id with newly pinned
        # locked_test_version_id/manifest_sha256; never load or overwrite the
        # training job's resume manifest during a standalone evaluation pass.
        state_store = (
            self.state_store_factory(job, run_dir)
            if (self.state_store_factory and not is_benchmark_only)
            else None
        )
        if state_store is not None:
            state_store.restore()
        stop = threading.Event()
        progress: dict[str, Any] = {"stage": "downloading_dataset"}
        heartbeat = threading.Thread(target=self.heartbeat_loop, args=(job_id, stop, progress), daemon=True)
        heartbeat.start()
        try:
            runtime = self.assert_runtime_capacity(run_dir)
            self.runtime_data = runtime
            if is_benchmark_only:
                progress.update(stage="downloading_candidate_artifact", runtime=runtime)
                self.process_benchmark_only_job(job, run_dir, progress)
                return
            # Fail fast before downloading hundreds of dataset crops and the 150MB checkpoint.
            config = metadata.get("training_config") if isinstance(metadata.get("training_config"), dict) else {}
            verify_worker_source_lock(config)
            if canonical_sha256(config) != job.get("config_sha256"):
                raise ValueError("JOB_CONFIG_FINGERPRINT_MISMATCH")
            if (config.get("profile") != job.get("profile")
                    or int(config.get("steps", 0)) < 2
                    or int(config.get("batch_size", 0)) < 1
                    or int(config.get("freeze_epochs", 0)) < 1
                    or config.get("optimizer") != "AdamW"
                    or config.get("scheduler") != "CosineAnnealingLR"
                    or config.get("preprocessing") != "opencv-line-v1"):
                raise ValueError("JOB_TRAINING_PARAMETERS_MISMATCH")
            progress.update(stage="downloading_dataset", runtime=runtime)
            dataset, items = self.dataset(job_id)
            if not dataset or dataset["version_sha256"] != job["manifest_sha256"]:
                raise ValueError("JOB_DATASET_MANIFEST_MISMATCH")
            manifest, receipt, _ = self.materialize_dataset(job_id, dataset, items, run_dir)
            parent = self.materialize_parent(job, run_dir)
            progress.update(stage="training", completed_steps=0,
                            total_steps=int(config["steps"]))
            self.assert_runtime_capacity(run_dir)
            candidate_record = run_dir / "candidate.json"
            stable_candidate = run_dir / "candidate.pth"
            if job.get("run_id") and not (candidate_record.is_file() and stable_candidate.is_file()):
                raise ValueError("PERSISTED_CANDIDATE_REQUIRED_FOR_RUN_RECOVERY")
            if candidate_record.is_file() and stable_candidate.is_file():
                candidate = json.loads(candidate_record.read_text(encoding="utf-8"))
                if sha256_file(stable_candidate) != candidate.get("checkpoint_sha256"):
                    raise ValueError("PERSISTED_CANDIDATE_HASH_MISMATCH")
            else:
                from .train import run_training

                last_synced_step = [0]

                def persist_training_progress(completed: int, total: int) -> None:
                    progress.update({"stage": "training", "completed_steps": completed, "total_steps": total})
                    if state_store is not None and (
                        completed <= 0
                        or completed >= total
                        or completed - last_synced_step[0] >= 500
                    ):
                        state_store.sync()
                        last_synced_step[0] = completed

                candidate = run_training(
                    profile=job["profile"], manifest_path=str(manifest), output_dir=str(run_dir),
                    parent_checkpoint=str(parent), total_steps=int(config["steps"]),
                    dataset_receipt_path=str(receipt), dataset_version_sha256=job["manifest_sha256"],
                    batch_size=int(config["batch_size"]), seed=int(config["seed"]),
                    resume=(run_dir / "latest.pt").is_file(), freeze_epochs=int(config["freeze_epochs"]),
                    use_fp16=bool(config["fp16"]),
                    job_config_sha256=job["config_sha256"],
                    progress_callback=persist_training_progress,
                )
                temporary = stable_candidate.with_suffix(".tmp")
                shutil.copyfile(candidate["candidate_path"], temporary)
                temporary.replace(stable_candidate)
                candidate["candidate_path"] = str(stable_candidate)
                record_json = json.dumps(candidate, ensure_ascii=False, sort_keys=True)
                record_temporary = candidate_record.with_suffix(".json.tmp")
                record_temporary.write_text(record_json, encoding="utf-8")
                record_temporary.replace(candidate_record)
                stable_manifest = run_dir / "candidate.manifest.json"
                manifest_temporary = stable_manifest.with_suffix(".json.tmp")
                manifest_temporary.write_text(json.dumps(candidate, ensure_ascii=False, sort_keys=True, indent=2),
                                              encoding="utf-8")
                manifest_temporary.replace(stable_manifest)
            if candidate.get("config_sha256") != job.get("config_sha256"):
                raise ValueError("CANDIDATE_CONFIG_FINGERPRINT_MISMATCH")
            if state_store is not None:
                # Commit the finished candidate before registering its run in the database.
                state_store.sync()
            progress["stage"] = "uploading_candidate"
            run_id, run_status, stable_candidate = self.upload_candidate(job, candidate, run_dir)
            if run_status == "BENCHMARKED":
                registered_result = self.call(
                    "GET", f"{API_PREFIX}/jobs/{job_id}/runs/{run_id}/result",
                    params={"worker_id": self.worker_id},
                )
                self.call("POST", f"{API_PREFIX}/jobs/{job_id}/finish", json={
                    "worker_id": self.worker_id, "run_id": run_id,
                    "status": registered_result["job_status"],
                    "runtime": self.runtime_data,
                })
                return

            # Training is complete once the immutable candidate is registered.
            # A missing evaluation cohort must not turn the run into a failure.
            if not job.get("locked_test_version_id") or not job.get("locked_test_manifest_sha256"):
                self.call("POST", f"{API_PREFIX}/jobs/{job_id}/finish", json={
                    "worker_id": self.worker_id, "run_id": run_id, "status": "CANDIDATE",
                    "runtime": self.runtime_data,
                })
                return

            test_job = dict(job)
            test_job["locked_test_version_id"] = job.get("locked_test_version_id")
            test_job["locked_test_manifest_sha256"] = job.get("locked_test_manifest_sha256")
            locked_data, locked_items = self.dataset(job_id, locked_test=True)
            if not locked_data:
                self.call("POST", f"{API_PREFIX}/jobs/{job_id}/finish", json={
                    "worker_id": self.worker_id, "run_id": run_id, "status": "CANDIDATE",
                    "runtime": self.runtime_data,
                })
                return
            if not test_job["locked_test_version_id"]:
                test_job["locked_test_version_id"] = locked_data["id"]
                test_job["locked_test_manifest_sha256"] = locked_data["version_sha256"]
            if str(locked_data["id"]) != str(test_job["locked_test_version_id"]) or locked_data["version_sha256"] != test_job["locked_test_manifest_sha256"]:
                raise ValueError("LOCKED_TEST_VERSION_MISMATCH")
            locked_receipt, _, cache = self.materialize_dataset(job_id, locked_data, locked_items,
                                                                 run_dir, locked_test=True)
            progress["stage"] = "benchmarking"
            original = run_dir / f"original-{ORIGINAL_CHECKPOINT_SHA256}.pth"
            if not original.exists():
                from vietocr.tool.utils import download_weights
                downloaded = Path(download_weights("https://vocr.vn/data/vietocr/vgg_transformer.pth", quiet=True))
                if sha256_file(downloaded) != ORIGINAL_CHECKPOINT_SHA256:
                    raise ValueError("ORIGINAL_CHECKPOINT_HASH_MISMATCH")
                shutil.copyfile(downloaded, original)
            if sha256_file(original) != ORIGINAL_CHECKPOINT_SHA256:
                raise ValueError("ORIGINAL_CHECKPOINT_HASH_MISMATCH")
            report_path = run_dir / f"production-{test_job['locked_test_manifest_sha256']}-{job['parent_checkpoint_sha256']}.json"
            if report_path.exists():
                report = json.loads(report_path.read_text(encoding="utf-8"))
            else:
                from .benchmark import run_locked_benchmark
                report = run_locked_benchmark(
                    manifest_path=str(locked_receipt),
                    expected_manifest_sha256=test_job["locked_test_manifest_sha256"],
                    original_checkpoint=str(original), candidate_checkpoint=str(stable_candidate),
                    candidate_profile=job["profile"], output_path=str(report_path), image_cache_dir=str(cache),
                    parent_checkpoint=str(parent), active_checkpoint=str(parent),
                    parent_profile=str((job.get("active_model") or {}).get("profile") or "ORIGINAL"),
                    active_profile=str((job.get("active_model") or {}).get("profile") or "ORIGINAL"),
                )
            if (report["candidate_checkpoint_sha256"] != candidate["checkpoint_sha256"]
                    or report["locked_manifest_sha256"] != test_job["locked_test_manifest_sha256"]):
                raise ValueError("BENCHMARK_REPORT_HASH_MISMATCH")
            if state_store is not None:
                state_store.sync()
            registered_benchmark = self.call("POST", f"{API_PREFIX}/jobs/{job_id}/benchmarks",
                      params={"worker_id": self.worker_id}, json={
                          "run_id": run_id,
                          "locked_test_version_id": test_job["locked_test_version_id"],
                          "locked_test_manifest_sha256": test_job["locked_test_manifest_sha256"],
                          "parent_checkpoint_sha256": job["parent_checkpoint_sha256"],
                          "active_checkpoint_sha256": job["parent_checkpoint_sha256"],
                          "outputs": [{key: row[key] for key in (
                              "sample_id", "group_id", "original", "candidate", "parent", "active"
                          ) if row.get(key) is not None}
                                      for row in report["outputs"]],
                      })
            resolved_gate = (
                (registered_benchmark or {}).get("gate_status")
                or (report.get("quality_gate") or {}).get("status")
                or report.get("gate_status")
            )
            self.call("POST", f"{API_PREFIX}/jobs/{job_id}/finish", json={
                "worker_id": self.worker_id, "run_id": run_id,
                "status": "BENCHMARKED" if resolved_gate == "V2_WIN" else "QUALITY_GATE_REJECTED",
                "runtime": self.runtime_data,
            })
        finally:
            stop.set()
            heartbeat.join(timeout=2)
            if state_store is not None:
                try:
                    state_store.sync()
                except Exception as sync_exc:
                    logger.warning("Final resume state sync failed (%s)", type(sync_exc).__name__)

    def run_forever(self) -> None:
        logger.info("ViRead Colab worker started; worker id=%s", self.worker_id)
        while True:
            try:
                self.runtime_data = self.assert_runtime_capacity(self.work_root)
                self.report_status("READY")
                job = self.claim()
                if job:
                    logger.info("Claimed training job %s", job["id"])
                    try:
                        self.process_job(job)
                    except Exception as exc:
                        logger.error("Training job %s failed (%s)", job.get("id"), type(exc).__name__)
                        try:
                            self.call("POST", f"{API_PREFIX}/jobs/{job['id']}/finish", json={
                                "worker_id": self.worker_id, "run_id": job.get("run_id"),
                                "status": "FAILED", "error_code": type(exc).__name__.upper()[:64],
                                "runtime": self.runtime_data,
                            })
                        except Exception as finish_exc:
                            logger.error("Could not record job failure (%s)", type(finish_exc).__name__)
                    continue
            except RuntimeError as exc:
                reason = str(exc).upper()[:64]
                state = "WAITING_FOR_GPU" if any(
                    token in reason for token in ("CUDA", "GPU", "VRAM")
                ) else "WAITING_FOR_RESOURCES"
                try:
                    self.report_status(state, reason)
                except Exception as report_exc:
                    logger.error("Could not report Colab capacity (%s)", type(report_exc).__name__)
                logger.warning("Colab worker not ready (%s); queued jobs remain waiting", reason)
                time.sleep(self.poll_seconds)
                continue
            except Exception as exc:
                logger.error("Training queue poll failed (%s)", type(exc).__name__)
            time.sleep(self.poll_seconds)

    def run_job_once(self, training_job_id: str, *, expected_profile: str | None = None) -> bool:
        """Claim and finish exactly one already-dispatched Enterprise execution job."""
        self.runtime_data = self.assert_runtime_capacity(self.work_root)
        self.report_status("READY")
        job = self.claim(training_job_id)
        if not job:
            return False
        if expected_profile and job.get("profile") != expected_profile:
            error = "COLAB_PROFILE_MISMATCH"
            try:
                self.call("POST", f"{API_PREFIX}/jobs/{training_job_id}/finish", json={
                    "worker_id": self.worker_id, "run_id": job.get("run_id"),
                    "status": "FAILED", "error_code": error, "runtime": self.runtime_data,
                })
            finally:
                raise RuntimeError(error)
        try:
            self.process_job(job)
        except Exception as exc:
            try:
                self.call("POST", f"{API_PREFIX}/jobs/{training_job_id}/finish", json={
                    "worker_id": self.worker_id, "run_id": job.get("run_id"),
                    "status": "FAILED", "error_code": type(exc).__name__.upper()[:64],
                    "runtime": self.runtime_data,
                })
            except Exception as finish_exc:
                logger.error("Could not record Enterprise job failure (%s)", type(finish_exc).__name__)
            raise
        return True

    def run_next_job_once(self) -> bool:
        """Claim and process at most one ready job from an interactive Colab session.

        Unlike ``run_forever``, this method performs one queue request and exits, so
        a free browser runtime is not used as an unattended background poller.
        """
        try:
            self.runtime_data = self.assert_runtime_capacity(self.work_root)
        except RuntimeError as exc:
            reason = str(exc).upper()[:64]
            state = ("WAITING_FOR_GPU" if any(
                token in reason for token in ("CUDA", "GPU", "VRAM")
            ) else "WAITING_FOR_RESOURCES")
            try:
                self.report_status(state, reason)
            except Exception as report_exc:
                logger.error("Could not report Colab capacity (%s)", type(report_exc).__name__)
            raise

        self.report_status("READY")
        job = self.claim()
        if not job:
            return False

        job_id = str(job["id"])
        try:
            self.process_job(job)
        except Exception as exc:
            try:
                self.call("POST", f"{API_PREFIX}/jobs/{job_id}/finish", json={
                    "worker_id": self.worker_id, "run_id": job.get("run_id"),
                    "status": "FAILED", "error_code": type(exc).__name__.upper()[:64],
                    "runtime": self.runtime_data,
                })
            except Exception as finish_exc:
                logger.error("Could not record one-shot job failure (%s)", type(finish_exc).__name__)
            raise
        return True


def run_worker(
    api_base: str,
    token: str,
    work_root: str | Path,
    *,
    poll_seconds: int = 30,
    drive_root: str | Path | None = None,
    resume_root: str | Path | None = None,
    use_remote_resume_store: bool = False,
) -> None:
    ColabWorker(
        api_base,
        token,
        work_root,
        poll_seconds=poll_seconds,
        drive_root=drive_root,
        resume_root=resume_root,
        use_remote_resume_store=use_remote_resume_store,
    ).run_forever()


def run_next_job_once(
    api_base: str,
    token: str,
    work_root: str | Path,
    *,
    drive_root: str | Path | None = None,
    resume_root: str | Path | None = None,
    use_remote_resume_store: bool = False,
) -> bool:
    """Process no more than one ready job; intended for a user-started Colab cell."""
    return ColabWorker(
        api_base,
        token,
        work_root,
        drive_root=drive_root,
        resume_root=resume_root,
        use_remote_resume_store=use_remote_resume_store,
    ).run_next_job_once()
