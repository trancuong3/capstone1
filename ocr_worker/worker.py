from __future__ import annotations

import argparse
import hashlib
import logging
import os
import signal
import sys
import threading
import time
from typing import Any

import httpx
import uvicorn

from ocr_worker.service import (
    CPU_THREADS,
    OcrRuntimeManager,
    build_worker_http_app,
    set_windows_below_normal_priority,
)

logger = logging.getLogger("ocr_worker.worker")


def _is_ocr_exception(exc: BaseException, class_name: str) -> bool:
    return any(cls.__name__ == class_name for cls in type(exc).__mro__)


class SourceImageDownloadError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = True):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class BackendOcrClient:
    """Outbound-only HTTPS client authenticated exclusively via X-ViRead-Ocr-Worker-Token."""

    def __init__(
        self,
        backend_url: str,
        worker_token: str,
        *,
        transport: httpx.BaseTransport | None = None,
        storage_transport: httpx.BaseTransport | None = None,
        timeout_seconds: float = 30.0,
    ):
        self.backend_url = backend_url.rstrip("/")
        if not worker_token or len(worker_token.strip()) < 32:
            raise ValueError("VIREAD_OCR_WORKER_TOKEN must be at least 32 characters.")
        self._client = httpx.Client(
            base_url=self.backend_url,
            headers={"X-ViRead-Ocr-Worker-Token": worker_token.strip()},
            timeout=timeout_seconds,
            transport=transport,
        )
        # Never attach X-ViRead-Ocr-Worker-Token when downloading directly from signed storage URLs.
        self._storage_client = httpx.Client(
            timeout=max(timeout_seconds, 60.0),
            follow_redirects=True,
            transport=storage_transport,
        )

    def close(self) -> None:
        self._client.close()
        self._storage_client.close()

    def send_worker_heartbeat(self, payload: dict[str, Any]) -> dict[str, Any]:
        resp = self._client.post("/internal/ocr-jobs/worker-heartbeat", json=payload)
        resp.raise_for_status()
        return dict(resp.json())

    def get_active_model(self) -> dict[str, Any]:
        resp = self._client.get("/internal/ocr-jobs/active-model")
        resp.raise_for_status()
        return dict(resp.json())

    def download_model_artifact(self, kind: str, shard_index: int | None = None) -> bytes:
        path = (
            "/internal/ocr-jobs/active-model/config"
            if kind == "config"
            else f"/internal/ocr-jobs/active-model/shard/{int(shard_index or 0)}"
        )
        resp = self._client.get(path, timeout=120.0)
        resp.raise_for_status()
        return bytes(resp.content)

    def claim_next_job(self, worker_id: str, *, lease_seconds: int = 120) -> dict[str, Any] | None:
        resp = self._client.post(
            "/internal/ocr-jobs/claim",
            json={"worker_id": worker_id, "lease_seconds": lease_seconds},
        )
        resp.raise_for_status()
        return (resp.json() or {}).get("job")

    def heartbeat_job(
        self,
        job_id: str,
        *,
        worker_id: str,
        fencing_token: int,
        lease_seconds: int = 120,
        phase: str | None = None,
    ) -> dict[str, Any]:
        resp = self._client.post(
            f"/internal/ocr-jobs/{job_id}/heartbeat",
            json={
                "worker_id": worker_id,
                "fencing_token": fencing_token,
                "lease_seconds": lease_seconds,
                "phase": phase,
            },
        )
        if resp.status_code == 409:
            return {"cancelled": True, "status": "CONFLICT"}
        resp.raise_for_status()
        return dict(resp.json())

    def refresh_source_url(
        self, job_id: str, *, worker_id: str, fencing_token: int
    ) -> dict[str, Any]:
        resp = self._client.post(
            f"/internal/ocr-jobs/{job_id}/refresh-source-url",
            json={"worker_id": worker_id, "fencing_token": fencing_token},
        )
        resp.raise_for_status()
        return dict(resp.json())

    def download_job_source(self, job: dict[str, Any], *, worker_id: str) -> bytes:
        job_id = str(job["job_id"])
        fencing_token = int(job["fencing_token"])
        expected_sha = str(job["image_sha256"]).lower()
        source_url = job.get("source_url")
        fallback_path = job.get("source_fallback_path")

        raw: bytes | None = None
        if isinstance(source_url, str) and source_url.strip():
            raw = self._fetch_signed_url_with_refresh(
                source_url.strip(),
                job_id=job_id,
                worker_id=worker_id,
                fencing_token=fencing_token,
            )

        if raw is None and isinstance(fallback_path, str) and fallback_path.strip():
            resp = self._client.get(fallback_path.strip())
            if resp.status_code == 409:
                raise SourceImageDownloadError(
                    "JOB_SUPERSEDED", "Source fetch rejected because lease is no longer active.", retryable=False
                )
            resp.raise_for_status()
            raw = bytes(resp.content)

        if raw is None:
            raise SourceImageDownloadError("SOURCE_URL_UNAVAILABLE", "No source image URL available.")

        actual_sha = hashlib.sha256(raw).hexdigest()
        if actual_sha != expected_sha:
            raise SourceImageDownloadError(
                "SOURCE_SHA256_MISMATCH",
                "Downloaded image checksum does not match job specification.",
                retryable=False,
            )
        return raw

    def _fetch_signed_url_with_refresh(
        self,
        initial_url: str,
        *,
        job_id: str,
        worker_id: str,
        fencing_token: int,
    ) -> bytes | None:
        resp = self._storage_client.get(initial_url)
        if resp.status_code in (400, 401, 403):
            refreshed = self.refresh_source_url(
                job_id, worker_id=worker_id, fencing_token=fencing_token
            )
            new_url = refreshed.get("source_url")
            if isinstance(new_url, str) and new_url.strip():
                resp = self._storage_client.get(new_url.strip())
            else:
                return None
        if resp.status_code == 404:
            raise SourceImageDownloadError("SOURCE_NOT_FOUND", "Signed source image missing.", retryable=True)
        resp.raise_for_status()
        return bytes(resp.content)

    def complete_job(self, job_id: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        resp = self._client.post(f"/internal/ocr-jobs/{job_id}/complete", json=payload)
        if resp.status_code == 409:
            return 409, dict(resp.json() if resp.content else {"detail": "conflict"})
        resp.raise_for_status()
        return resp.status_code, dict(resp.json())

    def fail_job(self, job_id: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        resp = self._client.post(f"/internal/ocr-jobs/{job_id}/fail", json=payload)
        if resp.status_code == 409:
            return 409, dict(resp.json() if resp.content else {"detail": "conflict"})
        resp.raise_for_status()
        return resp.status_code, dict(resp.json())


def process_claimed_job(
    client: BackendOcrClient,
    runtime: OcrRuntimeManager,
    job: dict[str, Any],
    *,
    lease_seconds: int = 120,
    heartbeat_interval_seconds: float = 25.0,
) -> dict[str, Any]:
    job_id = str(job["job_id"])
    job_kind = str(job["job_kind"])
    fencing_token = int(job["fencing_token"])
    expected_sha = str(job["image_sha256"]).lower()
    worker_id = runtime.worker_id

    stop_hb = threading.Event()
    abort_event = threading.Event()

    def _lease_heartbeat_loop() -> None:
        while not stop_hb.wait(heartbeat_interval_seconds):
            try:
                hb = client.heartbeat_job(
                    job_id,
                    worker_id=worker_id,
                    fencing_token=fencing_token,
                    lease_seconds=lease_seconds,
                    phase="ocr_running",
                )
                if hb.get("cancelled"):
                    abort_event.set()
                    return
            except Exception as exc:
                logger.warning("Lease heartbeat error on job %s: %s", job_id, type(exc).__name__)

    hb_thread = threading.Thread(
        target=_lease_heartbeat_loop,
        daemon=True,
        name=f"ocr_job_hb_{job_id[:8]}",
    )
    hb_thread.start()

    try:
        image_bytes = client.download_job_source(job, worker_id=worker_id)
        if abort_event.is_set():
            return {"outcome": "aborted_mid_job", "job_id": job_id}

        ocr_out = runtime.run_ocr_for_job(job_id, image_bytes)
        if abort_event.is_set():
            return {"outcome": "aborted_mid_job", "job_id": job_id}

        status_code, body = client.complete_job(
            job_id,
            {
                "worker_id": worker_id,
                "fencing_token": fencing_token,
                "source_sha256": expected_sha,
                "full_text": ocr_out["full_text"],
                "words": ocr_out["words"],
                "ocr_meta": ocr_out["ocr_meta"],
                "no_text_detected": False,
                "model_profile": ocr_out["model_profile"],
                "model_sha256": ocr_out["model_sha256"],
                "engine_diagnostics": ocr_out["engine_diagnostics"],
                "duration_ms": ocr_out["duration_ms"],
            },
        )
        return {"outcome": "conflict" if status_code == 409 else "completed", "job_id": job_id, "response": body}

    except SourceImageDownloadError as exc:
        if abort_event.is_set():
            return {"outcome": "aborted_mid_job", "job_id": job_id}
        status_code, body = client.fail_job(
            job_id,
            {
                "worker_id": worker_id,
                "fencing_token": fencing_token,
                "error_code": exc.code,
                "error_message": str(exc)[:300],
                "retryable": exc.retryable,
            },
        )
        return {"outcome": "failed", "error_code": exc.code, "status_code": status_code, "response": body}

    except Exception as exc:
        if abort_event.is_set():
            return {"outcome": "aborted_mid_job", "job_id": job_id}
        if _is_ocr_exception(exc, "OcrNoTextDetected"):
            if job_kind == "PARENT_BOOK_SUBMISSION":
                health = runtime.health_payload()
                status_code, body = client.complete_job(
                    job_id,
                    {
                        "worker_id": worker_id,
                        "fencing_token": fencing_token,
                        "source_sha256": expected_sha,
                        "full_text": "",
                        "words": [],
                        "ocr_meta": {"no_text_detected": True},
                        "no_text_detected": True,
                        "model_profile": health["model"]["profile"],
                        "model_sha256": health["model"]["checkpoint_sha256"],
                        "engine_diagnostics": {"engines": health["engines"]},
                        "duration_ms": 0,
                    },
                )
                return {"outcome": "completed_no_text", "status_code": status_code, "response": body}
            status_code, body = client.fail_job(
                job_id,
                {
                    "worker_id": worker_id,
                    "fencing_token": fencing_token,
                    "error_code": "NO_TEXT_DETECTED",
                    "error_message": "No usable text was detected on page.",
                    "retryable": False,
                },
            )
            return {"outcome": "failed_no_text", "status_code": status_code, "response": body}

        err_code = (
            "OCR_ENGINE_UNAVAILABLE"
            if _is_ocr_exception(exc, "OcrEngineUnavailable")
            else f"OCR_{type(exc).__name__}"[:64]
        )
        try:
            status_code, body = client.fail_job(
                job_id,
                {
                    "worker_id": worker_id,
                    "fencing_token": fencing_token,
                    "error_code": err_code,
                    "error_message": f"{type(exc).__name__}",
                    "retryable": True,
                    "engine_diagnostics": {"engines": runtime.engines_snapshot()},
                },
            )
        except Exception:
            status_code, body = 500, {}
        return {"outcome": "failed", "error_code": err_code, "status_code": status_code, "response": body}

    finally:
        stop_hb.set()
        hb_thread.join(timeout=2.0)


def run_worker_forever(
    *,
    backend_url: str,
    worker_token: str,
    bind_host: str = "127.0.0.1",
    bind_port: int = 8020,
    poll_seconds: float = 2.0,
    heartbeat_seconds: float = 15.0,
    lease_seconds: int = 120,
    apply_priority: bool = True,
) -> None:
    if apply_priority:
        set_windows_below_normal_priority()

    runtime = OcrRuntimeManager()
    app = build_worker_http_app(runtime)
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=bind_host,
            port=bind_port,
            log_level="warning",
            access_log=False,
        )
    )
    http_thread = threading.Thread(target=server.run, daemon=True, name="ocr_worker_http")
    http_thread.start()

    client: BackendOcrClient | None = (
        BackendOcrClient(backend_url, worker_token)
        if backend_url.strip() and len(worker_token.strip()) >= 32
        else None
    )

    try:
        runtime.initialize_and_verify_engines(
            manifest_fetcher=client.get_active_model if client else None,
            artifact_fetcher=client.download_model_artifact if client else None,
            run_smoke_inference=True,
        )
    except Exception as exc:
        logger.warning("Initial OCR warmup/sync failed (%s); will keep /health degraded and retry.", type(exc).__name__)

    stop_event = threading.Event()

    def _handle_stop(_signum: int, _frame: Any) -> None:
        stop_event.set()
        server.should_exit = True

    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)

    logger.info(
        "ViRead Remote OCR Worker started (worker_id=%s, bind=http://%s:%s, cpu_threads=%s, connected=%s)",
        runtime.worker_id,
        bind_host,
        bind_port,
        CPU_THREADS,
        bool(client),
    )

    last_hb = 0.0
    try:
        while not stop_event.is_set():
            now = time.monotonic()
            if client is not None and (now - last_hb) >= heartbeat_seconds:
                try:
                    client.send_worker_heartbeat(runtime.heartbeat_payload())
                    last_hb = now
                except Exception as exc:
                    logger.warning("Worker heartbeat failed: %s", type(exc).__name__)

            did_work = False
            if client is not None:
                try:
                    if not runtime.is_ready():
                        runtime.initialize_and_verify_engines(
                            manifest_fetcher=client.get_active_model,
                            artifact_fetcher=client.download_model_artifact,
                            run_smoke_inference=True,
                        )
                    job = client.claim_next_job(runtime.worker_id, lease_seconds=lease_seconds)
                    if job is not None:
                        did_work = True
                        process_claimed_job(
                            client,
                            runtime,
                            job,
                            lease_seconds=lease_seconds,
                            heartbeat_interval_seconds=max(10.0, lease_seconds / 4.0),
                        )
                        try:
                            client.send_worker_heartbeat(runtime.heartbeat_payload())
                            last_hb = time.monotonic()
                        except Exception:
                            pass
                except Exception as exc:
                    logger.warning("Poll/claim cycle error: %s", type(exc).__name__)

            if did_work:
                continue
            stop_event.wait(poll_seconds)
    finally:
        server.should_exit = True
        if client is not None:
            try:
                off = runtime.heartbeat_payload()
                off["status"] = "OFFLINE"
                client.send_worker_heartbeat(off)
            except Exception:
                pass
            client.close()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    parser = argparse.ArgumentParser(description="ViRead Remote OCR Worker")
    parser.add_argument("--host", default=os.getenv("VIREAD_OCR_WORKER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("VIREAD_OCR_WORKER_PORT", "8020")))
    parser.add_argument(
        "--backend-url",
        default=os.getenv("VIREAD_OCR_BACKEND_URL", ""),
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=float(os.getenv("VIREAD_OCR_POLL_SECONDS", "2.0")),
    )
    parser.add_argument(
        "--no-priority",
        action="store_true",
        help="Do not alter process priority class",
    )
    args = parser.parse_args(argv)
    token = os.getenv("VIREAD_OCR_WORKER_TOKEN", "")
    run_worker_forever(
        backend_url=args.backend_url,
        worker_token=token,
        bind_host=args.host,
        bind_port=args.port,
        poll_seconds=args.poll_seconds,
        apply_priority=not args.no_priority,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
