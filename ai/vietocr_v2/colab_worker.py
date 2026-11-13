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
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

import requests

from .artifact_store import assemble_shards, shard_file
from .contracts import DatasetRow, ORIGINAL_CHECKPOINT_SHA256, sha256_file, write_jsonl

logger = logging.getLogger("viread.vietocr.colab_worker")
API_PREFIX = "/books/admin/viread-training/worker"


def verify_worker_source_lock(config: dict[str, Any]) -> None:
    """Fail closed unless this checkout matches the job's trainer/dependency pins."""
    expected_files = {
        "trainer_sha256": Path(__file__).with_name("train.py"),
        "requirements_sha256": Path(__file__).with_name("requirements.txt"),
        "colab_requirements_sha256": Path(__file__).with_name("requirements-colab.txt"),
    }
    if any(
        not isinstance(config.get(key), str) or sha256_file(path) != config[key]
        for key, path in expected_files.items()
    ):
        raise ValueError("WORKER_CODE_OR_DEPENDENCY_LOCK_MISMATCH")


class ColabWorker:
    def __init__(self, api_base: str, token: str, work_root: str | Path, *, poll_seconds: int = 30,
                 state_store_factory: Callable[[dict[str, Any], Path], Any] | None = None):
        if not api_base.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            raise ValueError("VIREAD_API_BASE must use HTTPS outside localhost")
        if len(token) < 32:
            raise ValueError("VIREAD_TRAINING_WORKER_TOKEN must be at least 32 characters")
        self.api_base = api_base.rstrip("/")
        self.token = token
        self.work_root = Path(work_root)
        self.work_root.mkdir(parents=True, exist_ok=True)
        self.poll_seconds = max(5, poll_seconds)
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
            available_ram_gb = available_ram / 1024**3
            raise RuntimeError(
                f"COLAB_INSUFFICIENT_RAM:{available_ram_gb:.1f}GB_AVAILABLE_REQUIRED_{minimum_ram_gb}GB"
            )
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
    def download(url: str, destination: Path, expected_sha256: str | None = None) -> None:
        if destination.exists():
            if expected_sha256 is None or sha256_file(destination) == expected_sha256:
                return
            raise ValueError("CACHED_OBJECT_HASH_MISMATCH")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".download")
        digest = hashlib.sha256()
        try:
            with requests.get(url, stream=True, timeout=300) as response:
                response.raise_for_status()
                with temporary.open("xb") as output:
                    for block in response.iter_content(1024 * 1024):
                        if block:
                            output.write(block)
                            digest.update(block)
            if expected_sha256 and digest.hexdigest() != expected_sha256:
                raise ValueError("DOWNLOADED_OBJECT_HASH_MISMATCH")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)

    def materialize_dataset(self, job_id: str, dataset: dict[str, Any], items: list[dict[str, Any]],
                            run_dir: Path, *, locked_test: bool = False) -> tuple[Path, Path, Path]:
        prefix = "locked-test" if locked_test else "training"
        receipt_path = run_dir / f"{prefix}-receipt.json"
        receipt_url = dataset["manifest_url"]
        self.download(receipt_url, receipt_path, dataset["version_sha256"])
        image_root = run_dir / f"{prefix}-images"
        rows = []
        for item in items:
            image_path = image_root / item["image_sha256"]
            self.download(item["image_url"], image_path, item["image_sha256"])
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
            self.download(artifact["source_url"], parent, artifact["checkpoint_sha256"])
        else:
            shard_root = run_dir / "parent-shards"
            shard_root.mkdir(parents=True, exist_ok=True)
            chunks = []
            for chunk in artifact["chunks"]:
                local = shard_root / f"part-{int(chunk['index']):04d}.bin"
                self.download(chunk["url"], local, chunk["sha256"])
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
        if run["status"] in {"CANDIDATE", "BENCHMARKED"}:
            return run_id, run["status"], stable_candidate
        chunks_root = run_dir / "upload-shards"
        manifest_path = chunks_root / "shards.manifest.json"
        if manifest_path.exists():
            shard_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if shard_manifest["sha256"] != candidate["checkpoint_sha256"]:
                raise ValueError("CACHED_CANDIDATE_SHARDS_MISMATCH")
        else:
            shard_manifest = shard_file(stable_candidate, chunks_root)
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

    def process_job(self, job: dict[str, Any]) -> None:
        job_id = str(job["id"])
        run_dir = self.work_root / job_id
        run_dir.mkdir(parents=True, exist_ok=True)
        state_store = self.state_store_factory(job, run_dir) if self.state_store_factory else None
        if state_store is not None:
            state_store.restore()
        stop = threading.Event()
        progress: dict[str, Any] = {"stage": "downloading_dataset"}
        heartbeat = threading.Thread(target=self.heartbeat_loop, args=(job_id, stop, progress), daemon=True)
        heartbeat.start()
        try:
            runtime = self.assert_runtime_capacity(run_dir)
            self.runtime_data = runtime
            progress.update(stage="downloading_dataset", runtime=runtime)
            dataset, items = self.dataset(job_id)
            if not dataset or dataset["version_sha256"] != job["manifest_sha256"]:
                raise ValueError("JOB_DATASET_MANIFEST_MISMATCH")
            manifest, receipt, _ = self.materialize_dataset(job_id, dataset, items, run_dir)
            parent = self.materialize_parent(job, run_dir)
            progress.update(stage="training", completed_steps=0,
                            total_steps=int(job["metadata"]["training_config"]["steps"]))
            config = job["metadata"]["training_config"]
            verify_worker_source_lock(config)
            self.assert_runtime_capacity(run_dir)
            candidate_record = run_dir / "candidate.json"
            stable_candidate = run_dir / "candidate.pth"
            if candidate_record.is_file() and stable_candidate.is_file():
                candidate = json.loads(candidate_record.read_text(encoding="utf-8"))
                if sha256_file(stable_candidate) != candidate.get("checkpoint_sha256"):
                    raise ValueError("PERSISTED_CANDIDATE_HASH_MISMATCH")
            else:
                from .train import run_training

                def persist_training_progress(completed: int, total: int) -> None:
                    progress.update({"stage": "training", "completed_steps": completed, "total_steps": total})
                    if state_store is not None:
                        state_store.sync()

                candidate = run_training(
                    profile=job["profile"], manifest_path=str(manifest), output_dir=str(run_dir),
                    parent_checkpoint=str(parent), total_steps=int(config["steps"]),
                    dataset_receipt_path=str(receipt), dataset_version_sha256=job["manifest_sha256"],
                    batch_size=int(config["batch_size"]), seed=int(config["seed"]),
                    resume=(run_dir / "latest.pt").is_file(), freeze_epochs=int(config["freeze_epochs"]),
                    use_fp16=bool(config["fp16"]),
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
            report_path = run_dir / "locked-test-report.json"
            if report_path.exists():
                report = json.loads(report_path.read_text(encoding="utf-8"))
            else:
                from .benchmark import run_locked_benchmark
                report = run_locked_benchmark(
                    manifest_path=str(locked_receipt),
                    expected_manifest_sha256=test_job["locked_test_manifest_sha256"],
                    original_checkpoint=str(original), candidate_checkpoint=str(stable_candidate),
                    candidate_profile=job["profile"], output_path=str(report_path), image_cache_dir=str(cache),
                )
            if (report["candidate_checkpoint_sha256"] != candidate["checkpoint_sha256"]
                    or report["locked_manifest_sha256"] != test_job["locked_test_manifest_sha256"]):
                raise ValueError("BENCHMARK_REPORT_HASH_MISMATCH")
            if state_store is not None:
                state_store.sync()
            self.call("POST", f"{API_PREFIX}/jobs/{job_id}/benchmarks",
                      params={"worker_id": self.worker_id}, json={
                          "run_id": run_id,
                          "locked_test_version_id": test_job["locked_test_version_id"],
                          "locked_test_manifest_sha256": test_job["locked_test_manifest_sha256"],
                          "outputs": [{key: row[key] for key in ("sample_id", "group_id", "original", "candidate")}
                                      for row in report["outputs"]],
                      })
            self.call("POST", f"{API_PREFIX}/jobs/{job_id}/finish", json={
                "worker_id": self.worker_id, "run_id": run_id,
                "status": "BENCHMARKED" if report.get("gate_status") == "V2_WIN" else "QUALITY_GATE_REJECTED",
                "runtime": self.runtime_data,
            })
        finally:
            stop.set()
            heartbeat.join(timeout=2)
            if state_store is not None:
                state_store.sync()

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


def run_worker(api_base: str, token: str, work_root: str | Path, *, poll_seconds: int = 30) -> None:
    ColabWorker(api_base, token, work_root, poll_seconds=poll_seconds).run_forever()


def run_next_job_once(api_base: str, token: str, work_root: str | Path) -> bool:
    """Process no more than one ready job; intended for a user-started Colab cell."""
    return ColabWorker(api_base, token, work_root).run_next_job_once()
