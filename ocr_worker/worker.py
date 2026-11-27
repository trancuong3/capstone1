from __future__ import annotations

import argparse
import gc
import hashlib
import logging
import os
import random
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
    is_scale_to_zero_enabled,
    set_windows_below_normal_priority,
)

logger = logging.getLogger("ocr_worker.worker")

DEFAULT_BACKEND_TIMEOUT_SECONDS = 75.0
DEFAULT_WAKE_BURST_SECONDS = 90.0
DEFAULT_DRAIN_STRAGGLER_SECONDS = 3.0
_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}


def _is_ocr_exception(exc: BaseException, class_name: str) -> bool:
    return any(cls.__name__ == class_name for cls in type(exc).__mro__)


def resolve_backend_timeout_seconds(explicit: float | None = None) -> float:
    if explicit is not None:
        return max(10.0, min(180.0, float(explicit)))
    raw = (os.getenv("VIREAD_OCR_BACKEND_TIMEOUT_SECONDS") or "").strip()
    if raw:
        try:
            return max(10.0, min(180.0, float(raw)))
        except ValueError:
            pass
    return DEFAULT_BACKEND_TIMEOUT_SECONDS


def is_quiet_standby_enabled() -> bool:
    """Enable zero-request Quiet Standby when idle on HF Spaces, scale-to-zero, or opted in."""
    raw = (os.getenv("VIREAD_OCR_QUIET_STANDBY") or "").strip().lower()
    if raw in _TRUTHY:
        return True
    if raw in _FALSY:
        return False
    if is_scale_to_zero_enabled():
        return True
    return bool(
        (os.getenv("SPACE_ID") or "").strip()
        or (os.getenv("SPACE_AUTHOR_NAME") or "").strip()
    )


def resolve_quiet_standby_keepalive_seconds(
    explicit_seconds: float | None = None,
) -> float:
    """Resolve optional keepalive heartbeat+claim interval (seconds) during Quiet Standby."""
    raw = (
        str(explicit_seconds).strip()
        if explicit_seconds is not None
        else (os.getenv("VIREAD_OCR_QUIET_STANDBY_KEEPALIVE_SECONDS") or "").strip()
    )
    if not raw:
        return 0.0
    try:
        parsed = float(raw)
    except ValueError:
        return 0.0
    if parsed <= 0.0:
        return 0.0
    return max(10.0, min(180.0, parsed))


def compute_adaptive_poll_delay(
    *,
    base_poll_seconds: float,
    idle_seconds: float,
    max_idle_poll_seconds: float = 15.0,
) -> float:
    """Back off gently during idle periods while staying snappy during active bursts."""
    base = max(0.05, float(base_poll_seconds))
    cap = max(base, float(max_idle_poll_seconds))
    if idle_seconds < 20.0:
        return base
    if idle_seconds < 50.0:
        return min(cap, max(base, 5.0))
    if idle_seconds >= 120.0:
        return cap
    return min(cap, max(base, 10.0))


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
        timeout_seconds: float | None = None,
        completion_retry_attempts: int = 5,
        completion_retry_base_delay: float = 1.5,
    ):
        self.backend_url = backend_url.rstrip("/")
        if not worker_token or len(worker_token.strip()) < 32:
            raise ValueError("VIREAD_OCR_WORKER_TOKEN must be at least 32 characters.")
        self._completion_retry_attempts = max(1, int(completion_retry_attempts))
        self._completion_retry_base_delay = max(0.0, float(completion_retry_base_delay))
        resolved_timeout = resolve_backend_timeout_seconds(timeout_seconds)
        self.timeout_seconds = resolved_timeout
        self._client = httpx.Client(
            base_url=self.backend_url,
            headers={"X-ViRead-Ocr-Worker-Token": worker_token.strip()},
            timeout=resolved_timeout,
            transport=transport,
        )
        # Never attach X-ViRead-Ocr-Worker-Token when downloading directly from signed storage URLs.
        self._storage_client = httpx.Client(
            timeout=max(resolved_timeout, 90.0),
            follow_redirects=True,
            transport=storage_transport,
        )

    def close(self) -> None:
        self._client.close()
        self._storage_client.close()

    def send_worker_heartbeat(
        self,
        payload: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"json": payload}
        if timeout_seconds is not None:
            kwargs["timeout"] = float(timeout_seconds)
        resp = self._client.post("/internal/ocr-jobs/worker-heartbeat", **kwargs)
        resp.raise_for_status()
        return dict(resp.json())

    def get_active_model(self) -> dict[str, Any]:
        retryable_statuses = {429, 500, 502, 503, 504}
        max_attempts = max(1, min(3, self._completion_retry_attempts))
        last_exc: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                resp = self._client.get("/internal/ocr-jobs/active-model")
                if resp.status_code in retryable_statuses and attempt < max_attempts:
                    delay = min(6.0, self._completion_retry_base_delay * (2 ** (attempt - 1)))
                    if delay > 0:
                        time.sleep(delay)
                    continue
                resp.raise_for_status()
                return dict(resp.json())
            except httpx.RequestError as exc:
                last_exc = exc
                if attempt >= max_attempts:
                    raise
                delay = min(6.0, self._completion_retry_base_delay * (2 ** (attempt - 1)))
                if delay > 0:
                    time.sleep(delay)
        assert last_exc is not None
        raise last_exc

    def download_direct_url(self, url: str) -> bytes | None:
        """Download shard/config directly from a signed Storage URL without worker auth headers."""
        resp = self._storage_client.get(url)
        if resp.status_code in (400, 401, 403, 404):
            return None
        resp.raise_for_status()
        return bytes(resp.content)

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

    def _post_idempotent_with_retry(
        self,
        path: str,
        payload: dict[str, Any],
    ) -> tuple[int, dict[str, Any]]:
        """Post idempotent job completion/failure with bounded jittered backoff on 5xx/429/network errors."""
        retryable_statuses = {429, 500, 502, 503, 504}
        last_exc: Exception | None = None
        for attempt in range(1, self._completion_retry_attempts + 1):
            try:
                resp = self._client.post(path, json=payload)
                if resp.status_code == 409:
                    return 409, dict(resp.json() if resp.content else {"detail": "conflict"})
                if resp.status_code in retryable_statuses and attempt < self._completion_retry_attempts:
                    delay = min(10.0, self._completion_retry_base_delay * (2 ** (attempt - 1)))
                    jitter = delay * random.uniform(0.8, 1.2)
                    logger.warning(
                        "Transient HTTP %s posting %s (attempt %s/%s); retrying in %.2fs",
                        resp.status_code,
                        path,
                        attempt,
                        self._completion_retry_attempts,
                        jitter,
                    )
                    if jitter > 0:
                        time.sleep(jitter)
                    continue
                resp.raise_for_status()
                return resp.status_code, dict(resp.json())
            except httpx.RequestError as exc:
                last_exc = exc
                if attempt >= self._completion_retry_attempts:
                    raise
                delay = min(10.0, self._completion_retry_base_delay * (2 ** (attempt - 1)))
                jitter = delay * random.uniform(0.8, 1.2)
                logger.warning(
                    "Transient network error posting %s (%s, attempt %s/%s); retrying in %.2fs",
                    path,
                    type(exc).__name__,
                    attempt,
                    self._completion_retry_attempts,
                    jitter,
                )
                if jitter > 0:
                    time.sleep(jitter)
        assert last_exc is not None
        raise last_exc

    def complete_job(self, job_id: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        return self._post_idempotent_with_retry(f"/internal/ocr-jobs/{job_id}/complete", payload)

    def fail_job(self, job_id: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        return self._post_idempotent_with_retry(f"/internal/ocr-jobs/{job_id}/fail", payload)


def ensure_active_model_resynced(
    client: BackendOcrClient,
    runtime: OcrRuntimeManager,
    *,
    job: dict[str, Any] | None = None,
    force: bool = False,
) -> bool:
    """Force-check and hot-reload the active VietOCR model on wakeup or model-SHA mismatch."""
    expected_model_sha = ""
    if isinstance(job, dict):
        expected_model_sha = str(
            job.get("expected_model_sha256")
            or job.get("active_model_sha256")
            or ""
        ).strip().lower()
    loaded_model_sha = str(getattr(runtime, "loaded_model_sha256", "") or "").strip().lower()
    sha_mismatch = len(expected_model_sha) == 64 and expected_model_sha != loaded_model_sha
    needs_resync = bool(force or runtime.needs_model_resync() or sha_mismatch)
    if not needs_resync:
        return False
    try:
        resynced = runtime.maybe_resync_active_model(
            manifest_fetcher=client.get_active_model,
            artifact_fetcher=client.download_model_artifact,
            direct_url_fetcher=client.download_direct_url,
            force=True,
        )
    except httpx.HTTPStatusError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            runtime.clear_model_resync_needed()
        raise
    runtime.clear_model_resync_needed()
    return resynced


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
        try:
            resynced = ensure_active_model_resynced(client, runtime, job=job, force=False)
            if resynced:
                try:
                    client.send_worker_heartbeat(runtime.heartbeat_payload())
                except Exception:
                    pass
        except Exception as exc:
            logger.warning(
                "Pre-job active-model resync failed for job %s (%s); continuing with loaded model.",
                job_id,
                type(exc).__name__,
            )

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
        gc.collect()


def _wait_for_wake_or_stop(
    stop_event: threading.Event,
    wake_event: threading.Event,
    timeout_seconds: float | None,
) -> bool:
    """Wait up to timeout_seconds for either stop_event or wake_event. Returns True if woken."""
    if stop_event.is_set():
        return False
    if wake_event.is_set():
        wake_event.clear()
        return True
    if timeout_seconds is None:
        while not stop_event.is_set():
            if wake_event.wait(timeout=0.5):
                wake_event.clear()
                return True
        return False
    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    while not stop_event.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        if wake_event.wait(timeout=min(0.25, remaining)):
            wake_event.clear()
            return True
    return False


def drain_queue_synchronously(
    client: BackendOcrClient,
    runtime: OcrRuntimeManager,
    *,
    lease_seconds: int = 120,
    heartbeat_seconds: float = 25.0,
    straggler_wait_seconds: float | None = None,
    stop_event: threading.Event | None = None,
) -> int:
    """Synchronously claim and process queued OCR jobs until empty (+ straggler check).

    Keeps the HTTP request open on serverless scale-to-zero platforms (ACA / Cloud Run)
    so CPU stays allocated throughout the batch and scales down cleanly after cooldown.
    """
    if straggler_wait_seconds is not None:
        resolved_straggler = max(0.0, min(15.0, float(straggler_wait_seconds)))
    else:
        try:
            resolved_straggler = max(
                0.0,
                min(
                    15.0,
                    float(
                        os.getenv(
                            "VIREAD_OCR_DRAIN_STRAGGLER_SECONDS",
                            str(DEFAULT_DRAIN_STRAGGLER_SECONDS),
                        )
                    ),
                ),
            )
        except ValueError:
            resolved_straggler = DEFAULT_DRAIN_STRAGGLER_SECONDS

    drained_jobs = 0
    checked_straggler = False
    hb_interval = min(max(5.0, heartbeat_seconds), max(10.0, lease_seconds / 4.0))

    try:
        with runtime.cycle_lock:
            if not runtime.is_ready():
                runtime.initialize_and_verify_engines(
                    manifest_fetcher=client.get_active_model,
                    artifact_fetcher=client.download_model_artifact,
                    direct_url_fetcher=client.download_direct_url,
                    run_smoke_inference=True,
                )
                runtime.clear_model_resync_needed()
            else:
                try:
                    ensure_active_model_resynced(client, runtime, force=True)
                except Exception as exc:
                    logger.warning(
                        "Wakeup active-model resync failed during drain (%s); continuing with loaded model.",
                        type(exc).__name__,
                    )
            try:
                client.send_worker_heartbeat(runtime.heartbeat_payload())
            except Exception:
                pass

        while stop_event is None or not stop_event.is_set():
            job: dict[str, Any] | None = None
            with runtime.cycle_lock:
                if not runtime.is_ready():
                    runtime.initialize_and_verify_engines(
                        manifest_fetcher=client.get_active_model,
                        artifact_fetcher=client.download_model_artifact,
                        direct_url_fetcher=client.download_direct_url,
                        run_smoke_inference=True,
                    )
                job = client.claim_next_job(runtime.worker_id, lease_seconds=lease_seconds)
                if job is not None:
                    try:
                        busy_hb = runtime.heartbeat_payload()
                        busy_hb["status"] = "BUSY"
                        busy_hb["active_job_id"] = str(job["job_id"])
                        busy_hb["active_job_count"] = 1
                        client.send_worker_heartbeat(busy_hb)
                    except Exception:
                        pass
                    process_claimed_job(
                        client,
                        runtime,
                        job,
                        lease_seconds=lease_seconds,
                        heartbeat_interval_seconds=hb_interval,
                    )
                    drained_jobs += 1
                    try:
                        idle_hb = runtime.heartbeat_payload()
                        if idle_hb.get("status") == "BUSY":
                            idle_hb["status"] = "IDLE"
                        idle_hb["active_job_id"] = None
                        idle_hb["active_job_count"] = 0
                        client.send_worker_heartbeat(idle_hb)
                    except Exception:
                        pass
                    checked_straggler = False
                    continue

            if runtime.consume_pending_redrain():
                checked_straggler = False
                continue

            if not checked_straggler and resolved_straggler > 0.0:
                checked_straggler = True
                if stop_event is not None:
                    _wait_for_wake_or_stop(stop_event, runtime.wake_event, resolved_straggler)
                else:
                    runtime.wake_event.wait(timeout=resolved_straggler)
                    runtime.wake_event.clear()
                continue
            break

        return drained_jobs
    finally:
        if is_scale_to_zero_enabled():
            runtime.clear_burst_window()
            if not runtime.is_draining():
                runtime.set_standby_mode("scale_to_zero")
        elif (
            is_quiet_standby_enabled()
            and not runtime.is_draining()
            and time.monotonic() >= runtime.burst_until_monotonic()
        ):
            runtime.set_standby_mode("quiet_standby")


def _run_claimed_job_cycle(
    client: BackendOcrClient,
    runtime: OcrRuntimeManager,
    job: dict[str, Any],
    *,
    lease_seconds: int,
    heartbeat_seconds: float,
    use_quiet_standby: bool,
    resolved_burst_seconds: float,
) -> float:
    """Execute one claimed OCR job with BUSY/IDLE heartbeats and burst renewal."""
    if use_quiet_standby:
        runtime.extend_burst_window(resolved_burst_seconds)
    last_hb = 0.0
    try:
        busy_hb = runtime.heartbeat_payload()
        busy_hb["status"] = "BUSY"
        busy_hb["active_job_id"] = str(job["job_id"])
        busy_hb["active_job_count"] = 1
        client.send_worker_heartbeat(busy_hb)
        last_hb = time.monotonic()
    except Exception:
        pass
    process_claimed_job(
        client,
        runtime,
        job,
        lease_seconds=lease_seconds,
        heartbeat_interval_seconds=min(
            max(5.0, heartbeat_seconds),
            max(10.0, lease_seconds / 4.0),
        ),
    )
    if use_quiet_standby:
        runtime.extend_burst_window(resolved_burst_seconds)
    try:
        idle_hb = runtime.heartbeat_payload()
        if idle_hb.get("status") == "BUSY":
            idle_hb["status"] = "IDLE"
        idle_hb["active_job_id"] = None
        idle_hb["active_job_count"] = 0
        client.send_worker_heartbeat(idle_hb)
        last_hb = time.monotonic()
    except Exception:
        pass
    return last_hb


def run_worker_forever(
    *,
    backend_url: str,
    worker_token: str,
    bind_host: str = "127.0.0.1",
    bind_port: int = 8020,
    poll_seconds: float = 2.0,
    heartbeat_seconds: float = 25.0,
    lease_seconds: int = 120,
    apply_priority: bool = True,
    quiet_standby: bool | None = None,
    wake_burst_seconds: float | None = None,
    quiet_standby_keepalive_seconds: float | None = None,
) -> None:
    if apply_priority:
        set_windows_below_normal_priority()

    runtime = OcrRuntimeManager()
    use_scale_to_zero = is_scale_to_zero_enabled()
    use_quiet_standby = (
        is_quiet_standby_enabled() if quiet_standby is None else bool(quiet_standby)
    )
    keepalive_seconds = (
        resolve_quiet_standby_keepalive_seconds(quiet_standby_keepalive_seconds)
        if use_quiet_standby and not use_scale_to_zero
        else 0.0
    )
    try:
        resolved_burst_seconds = (
            float(wake_burst_seconds)
            if wake_burst_seconds is not None
            else max(
                10.0,
                min(
                    600.0,
                    float(
                        os.getenv(
                            "VIREAD_OCR_WAKE_BURST_SECONDS",
                            str(DEFAULT_WAKE_BURST_SECONDS),
                        )
                    ),
                ),
            )
        )
    except ValueError:
        resolved_burst_seconds = DEFAULT_WAKE_BURST_SECONDS

    try:
        max_idle_poll_seconds = max(
            poll_seconds,
            min(60.0, float(os.getenv("VIREAD_OCR_MAX_IDLE_POLL_SECONDS", "15"))),
        )
    except ValueError:
        max_idle_poll_seconds = max(poll_seconds, 15.0)

    idle_standby_label = (
        "scale_to_zero"
        if use_scale_to_zero
        else ("quiet_standby" if use_quiet_standby else "active_polling")
    )
    runtime.set_standby_mode(idle_standby_label)

    stop_event = threading.Event()
    client: BackendOcrClient | None = (
        BackendOcrClient(backend_url, worker_token)
        if backend_url.strip() and len(worker_token.strip()) >= 32
        else None
    )

    def _drain_from_http(_reason: str) -> int:
        assert client is not None
        return drain_queue_synchronously(
            client,
            runtime,
            lease_seconds=lease_seconds,
            heartbeat_seconds=heartbeat_seconds,
            stop_event=stop_event,
        )

    app = build_worker_http_app(
        runtime,
        worker_token=worker_token,
        drain_runner=_drain_from_http if client is not None else None,
    )
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

    try:
        runtime.initialize_and_verify_engines(
            manifest_fetcher=client.get_active_model if client else None,
            artifact_fetcher=client.download_model_artifact if client else None,
            direct_url_fetcher=client.download_direct_url if client else None,
            run_smoke_inference=True,
        )
    except Exception as exc:
        logger.warning(
            "Initial OCR warmup/sync failed (%s); will keep /health degraded and retry.",
            type(exc).__name__,
        )

    def _handle_stop(_signum: int, _frame: Any) -> None:
        stop_event.set()
        runtime.wake_event.set()
        server.should_exit = True

    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGINT, _handle_stop)
        signal.signal(signal.SIGTERM, _handle_stop)

    if not runtime.is_draining():
        if use_scale_to_zero:
            runtime.set_standby_mode("scale_to_zero")
        elif use_quiet_standby:
            if client is not None:
                runtime.extend_burst_window(resolved_burst_seconds)
            else:
                runtime.set_standby_mode("quiet_standby")
        else:
            runtime.set_standby_mode("active_polling")

    logger.info(
        "ViRead Remote OCR Worker started (worker_id=%s, bind=http://%s:%s, cpu_threads=%s, connected=%s, quiet_standby=%s, scale_to_zero=%s)",
        runtime.worker_id,
        bind_host,
        bind_port,
        CPU_THREADS,
        bool(client),
        use_quiet_standby,
        use_scale_to_zero,
    )

    last_hb = 0.0
    last_activity_at = time.monotonic()
    last_model_check = time.monotonic()
    poll_error_streak = 0
    try:
        model_sync_seconds = max(
            30.0, float(os.getenv("VIREAD_OCR_MODEL_SYNC_SECONDS", "120"))
        )
    except ValueError:
        model_sync_seconds = 120.0

    warmup_recovery_attempts = 0
    try:
        if client is not None and not stop_event.is_set():
            try:
                startup_hb = runtime.heartbeat_payload()
                if runtime.is_ready():
                    startup_hb["status"] = "IDLE"
                client.send_worker_heartbeat(startup_hb, timeout_seconds=5.0)
                last_hb = time.monotonic()
            except Exception as exc:
                logger.warning("Startup worker heartbeat failed: %s", type(exc).__name__)
            if runtime.is_ready() and not stop_event.is_set():
                try:
                    drained_on_start = drain_queue_synchronously(
                        client,
                        runtime,
                        lease_seconds=lease_seconds,
                        heartbeat_seconds=heartbeat_seconds,
                        straggler_wait_seconds=0.0,
                        stop_event=stop_event,
                    )
                    last_hb = time.monotonic()
                    if drained_on_start > 0:
                        last_activity_at = time.monotonic()
                except Exception as exc:
                    logger.warning("Startup queue drain failed: %s", type(exc).__name__)

        while not stop_event.is_set():
            now = time.monotonic()

            if use_quiet_standby and now >= runtime.burst_until_monotonic():
                if (
                    client is not None
                    and not runtime.is_ready()
                    and not runtime.is_draining()
                    and warmup_recovery_attempts < 5
                ):
                    backoff = min(60.0, 15.0 * (2**warmup_recovery_attempts))
                    warmup_recovery_attempts += 1
                    _wait_for_wake_or_stop(stop_event, runtime.wake_event, backoff)
                    if stop_event.is_set():
                        break
                    runtime.extend_burst_window(20.0)
                    continue
                if not runtime.is_draining():
                    runtime.set_standby_mode(idle_standby_label)
                # Quiet Standby / Scale-to-Zero idle: 0 outbound HTTP requests unless keepalive is enabled.
                keepalive_wait = (
                    keepalive_seconds
                    if (client is not None and keepalive_seconds > 0.0)
                    else None
                )
                woken = _wait_for_wake_or_stop(stop_event, runtime.wake_event, keepalive_wait)
                if stop_event.is_set():
                    break
                if woken:
                    warmup_recovery_attempts = 0
                    last_activity_at = time.monotonic()
                    runtime.mark_model_resync_needed()
                elif keepalive_wait is not None and client is not None and not runtime.is_draining():
                    try:
                        with runtime.cycle_lock:
                            client.send_worker_heartbeat(runtime.heartbeat_payload())
                            last_hb = time.monotonic()
                            job = client.claim_next_job(
                                runtime.worker_id, lease_seconds=lease_seconds
                            )
                            if job is not None:
                                hb_at = _run_claimed_job_cycle(
                                    client,
                                    runtime,
                                    job,
                                    lease_seconds=lease_seconds,
                                    heartbeat_seconds=heartbeat_seconds,
                                    use_quiet_standby=use_quiet_standby,
                                    resolved_burst_seconds=resolved_burst_seconds,
                                )
                                if hb_at > 0.0:
                                    last_hb = hb_at
                                last_activity_at = time.monotonic()
                    except Exception as exc:
                        logger.warning(
                            "Quiet standby keepalive cycle failed: %s",
                            type(exc).__name__,
                        )
                continue

            if runtime.is_draining():
                _wait_for_wake_or_stop(stop_event, runtime.wake_event, 1.0)
                continue

            if client is not None and (now - last_hb) >= heartbeat_seconds:
                try:
                    client.send_worker_heartbeat(runtime.heartbeat_payload())
                    last_hb = time.monotonic()
                except Exception as exc:
                    logger.warning("Worker heartbeat failed: %s", type(exc).__name__)

            did_work = False
            had_poll_error = False
            if client is not None:
                try:
                    with runtime.cycle_lock:
                        if not runtime.is_ready():
                            runtime.initialize_and_verify_engines(
                                manifest_fetcher=client.get_active_model,
                                artifact_fetcher=client.download_model_artifact,
                                direct_url_fetcher=client.download_direct_url,
                                run_smoke_inference=True,
                            )
                            last_model_check = time.monotonic()
                            runtime.clear_model_resync_needed()
                        elif runtime.needs_model_resync() or (now - last_model_check) >= model_sync_seconds:
                            forced_resync = runtime.needs_model_resync()
                            resynced = runtime.maybe_resync_active_model(
                                manifest_fetcher=client.get_active_model,
                                artifact_fetcher=client.download_model_artifact,
                                direct_url_fetcher=client.download_direct_url,
                                force=forced_resync,
                            )
                            last_model_check = time.monotonic()
                            runtime.clear_model_resync_needed()
                            if resynced or forced_resync:
                                try:
                                    client.send_worker_heartbeat(runtime.heartbeat_payload())
                                    last_hb = time.monotonic()
                                except Exception:
                                    pass

                        job = client.claim_next_job(runtime.worker_id, lease_seconds=lease_seconds)
                        poll_error_streak = 0
                        if job is not None:
                            did_work = True
                            hb_at = _run_claimed_job_cycle(
                                client,
                                runtime,
                                job,
                                lease_seconds=lease_seconds,
                                heartbeat_seconds=heartbeat_seconds,
                                use_quiet_standby=use_quiet_standby,
                                resolved_burst_seconds=resolved_burst_seconds,
                            )
                            if hb_at > 0.0:
                                last_hb = hb_at
                            last_activity_at = time.monotonic()
                except Exception as exc:
                    had_poll_error = True
                    poll_error_streak += 1
                    logger.warning(
                        "Poll/claim cycle error (streak=%s): %s",
                        poll_error_streak,
                        type(exc).__name__,
                    )

            if did_work:
                continue

            idle_for = max(0.0, time.monotonic() - last_activity_at)
            adaptive_delay = compute_adaptive_poll_delay(
                base_poll_seconds=poll_seconds,
                idle_seconds=idle_for,
                max_idle_poll_seconds=max_idle_poll_seconds,
            )
            delay = (
                min(30.0, max(poll_seconds, 2.0) * (2 ** min(poll_error_streak - 1, 4)))
                if had_poll_error
                else adaptive_delay
            )
            if use_quiet_standby:
                remaining_burst = runtime.burst_until_monotonic() - time.monotonic()
                if remaining_burst <= 0:
                    continue
                delay = min(delay, remaining_burst)

            if _wait_for_wake_or_stop(stop_event, runtime.wake_event, delay):
                last_activity_at = time.monotonic()
    finally:
        server.should_exit = True
        if client is not None:
            try:
                off = runtime.heartbeat_payload()
                off["status"] = "OFFLINE"
                off["active_job_id"] = None
                off["active_job_count"] = 0
                client.send_worker_heartbeat(off, timeout_seconds=2.0)
            except Exception:
                pass
            client.close()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    default_port = int(
        (os.getenv("VIREAD_OCR_WORKER_PORT") or os.getenv("PORT") or "8020").strip()
    )
    parser = argparse.ArgumentParser(description="ViRead Remote OCR Worker")
    parser.add_argument("--host", default=os.getenv("VIREAD_OCR_WORKER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=default_port)
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
    parser.add_argument(
        "--quiet-standby",
        dest="quiet_standby",
        action="store_true",
        default=None,
        help="Enable quiet standby when idle",
    )
    parser.add_argument(
        "--no-quiet-standby",
        dest="quiet_standby",
        action="store_false",
        help="Disable quiet standby even if configured via environment",
    )
    parser.add_argument(
        "--quiet-standby-keepalive-seconds",
        type=float,
        default=None,
        help="Optional heartbeat+claim keepalive interval during quiet standby",
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
        quiet_standby=args.quiet_standby,
        quiet_standby_keepalive_seconds=args.quiet_standby_keepalive_seconds,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
