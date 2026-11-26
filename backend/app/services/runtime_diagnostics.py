"""Read-only, bounded runtime health checks; never start an OCR model.

"Installed" means package presence, not successful OCR inference. Tesseract is
probed independently and its Vietnamese language pack is explicitly checked.
No secret, model path or command line appears in the returned evidence.
"""
from __future__ import annotations

import importlib.util
import httpx
from urllib.parse import quote
import os
import shutil
import subprocess
import sys
import time
from functools import lru_cache
from typing import Any

from app.database.config import (
    SUPABASE_ADMIN_KEY,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_URL,
    supabase_admin_headers,
)
from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig
from app.services.worker_telemetry import get_worker_telemetry


def _package_installed(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def _health_item(
    item_id: str, label: str, status: str, detail_status: str, message: str,
) -> dict[str, str]:
    return {
        "id": item_id, "label": label, "status": status,
        "detail_status": detail_status, "safe_message": message,
    }


def derive_operational_state(
    *,
    status: str,
    detail_status: str | None = None,
    queue_depth: int | None = None,
    last_error: str | None = None,
    quota_exhausted: bool = False,
) -> str:
    """Map legacy health triad + detail/queue/quota telemetry to a 7-value operational_state."""
    if quota_exhausted or (last_error and "QUOTA" in str(last_error).upper()):
        return "Quota exhausted"
    if detail_status == "disabled":
        return "Offline"
    if status == "UNAVAILABLE":
        return "Offline"
    if status in {"HEALTHY", "DEGRADED"} and queue_depth is not None and queue_depth > 0 and not last_error:
        return "Queued"
    if detail_status == "unknown" and status == "DEGRADED":
        return "Unknown"
    if status == "DEGRADED":
        return "Degraded"
    if status == "HEALTHY":
        return "Healthy"
    return "Unknown"


def _ocr_engine_health(package: str, engine_name: str, status_name: str, label: str) -> dict[str, str]:
    installed = _package_installed(package)
    runtime = sys.modules.get("app.services.ocr_engine")
    engine = getattr(runtime, engine_name, None) if runtime is not None else None
    load_status = getattr(runtime, status_name, None) if runtime is not None else None
    prefix = "_paddle" if package == "paddleocr" else "_vietocr"
    init_error = getattr(runtime, f"{prefix}_initialization_error", None) if runtime is not None else None
    import_error = getattr(runtime, f"{prefix}_import_error", None) if runtime is not None else None
    if engine is not None and load_status == "success":
        return _health_item(package, label, "HEALTHY", "loaded",
                            "Engine đã khởi tạo; Health không chạy nhận diện ảnh.")
    if load_status in {"error", "not_installed"} or init_error is not None or import_error is not None:
        return _health_item(package, label, "UNAVAILABLE", "failed",
                            "Không thể khởi tạo engine OCR này.")
    if engine is not None:
        return _health_item(package, label, "DEGRADED", "initialized",
                            "Engine tồn tại nhưng chưa xác nhận trạng thái nạp.")
    if installed:
        return _health_item(package, label, "DEGRADED", "installed",
                            "Đã cài thư viện; chưa tải model OCR trong tiến trình.")
    return _health_item(package, label, "UNAVAILABLE", "failed",
                        "Thiếu thư viện OCR cần thiết.")


@lru_cache(maxsize=16)
def _cached_tesseract_languages(binary: str, time_bucket: int) -> tuple[bool, frozenset[str]]:
    """A low-cost subprocess check, cached for at most 30 seconds per binary."""
    del time_bucket
    try:
        result = subprocess.run(
            [binary, "--list-langs"], capture_output=True, text=True,
            timeout=2.0, check=False,
        )
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return False, frozenset()
    if result.returncode != 0:
        return False, frozenset()
    return True, frozenset(line.strip().lower() for line in
                           (result.stdout + "\n" + result.stderr).splitlines())


def _tesseract_health() -> tuple[dict[str, str], dict[str, str], bool, bool]:
    command = os.environ.get("TESSERACT_CMD", "tesseract").strip()
    binary = shutil.which(command) if command else None
    if binary is None:
        return (
            _health_item("tesseract", "Tesseract", "UNAVAILABLE", "failed",
                         "Không tìm thấy chương trình Tesseract."),
            _health_item("tesseract_vie", "Tesseract tiếng Việt", "UNAVAILABLE", "unknown",
                         "Chưa thể xác nhận dữ liệu tiếng Việt khi thiếu Tesseract."),
            False, False,
        )
    ok, languages = _cached_tesseract_languages(binary, int(time.monotonic() // 30))
    if not ok:
        return (
            _health_item("tesseract", "Tesseract", "UNAVAILABLE", "failed",
                         "Tesseract không phản hồi kiểm tra ngôn ngữ trong giới hạn thời gian."),
            _health_item("tesseract_vie", "Tesseract tiếng Việt", "DEGRADED", "unknown",
                         "Chưa xác minh được dữ liệu nhận diện tiếng Việt."),
            True, False,
        )
    return (
        _health_item("tesseract", "Tesseract", "HEALTHY", "healthy",
                     "Tesseract phản hồi kiểm tra danh sách ngôn ngữ."),
        _health_item(
            "tesseract_vie", "Tesseract tiếng Việt",
            "HEALTHY" if "vie" in languages else "UNAVAILABLE",
            "healthy" if "vie" in languages else "failed",
            "Đã xác nhận dữ liệu nhận diện tiếng Việt."
            if "vie" in languages else "Thiếu dữ liệu nhận diện tiếng Việt (vie).",
        ),
        True, "vie" in languages,
    )


def collect_ocr_health() -> list[dict[str, str]]:
    """Inspection only: no imports of torch/PaddleOCR/VietOCR or model inference."""
    paddle = _ocr_engine_health("paddleocr", "_paddle_engine",
                                "_paddle_initialization_status", "PaddleOCR")
    viet = _ocr_engine_health("vietocr", "_vietocr_engine",
                              "_vietocr_initialization_status", "VietOCR")
    tesseract, vietnamese, _, _ = _tesseract_health()
    return [paddle, viet, tesseract, vietnamese]


async def probe_storage_health() -> dict[str, str]:
    """A read-only HEAD of the configured bucket; no object listing or downloads."""
    if not (SUPABASE_URL and SUPABASE_STORAGE_BUCKET and SUPABASE_ADMIN_KEY):
        return _health_item(
            "storage", "Supabase Storage", "UNAVAILABLE", "failed",
            "Thiếu cấu hình kết nối Supabase Storage.",
        )
    try:
        url = (
            f"{SUPABASE_URL.rstrip('/')}/storage/v1/bucket/"
            f"{quote(SUPABASE_STORAGE_BUCKET, safe='')}"
        )
        headers = supabase_admin_headers(SUPABASE_ADMIN_KEY)
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(2.5, connect=1.5),
            follow_redirects=False, trust_env=False,
        ) as client:
            response = await client.head(url, headers=headers)
        if response.status_code == 200:
            return _health_item(
                "storage", "Supabase Storage", "HEALTHY", "healthy",
                "Storage phản hồi kiểm tra bucket (không đọc file).",
            )
        if response.status_code in {401, 403}:
            return _health_item(
                "storage", "Supabase Storage", "UNAVAILABLE", "failed",
                "Storage từ chối quyền kiểm tra bucket.",
            )
        if response.status_code == 404:
            return _health_item(
                "storage", "Supabase Storage", "UNAVAILABLE", "failed",
                "Không tìm thấy bucket Storage đã cấu hình.",
            )
        return _health_item(
            "storage", "Supabase Storage", "DEGRADED", "unknown",
            "Storage chưa phản hồi trạng thái bucket hợp lệ.",
        )
    except (httpx.HTTPError, TimeoutError, ValueError, OSError):
        return _health_item(
            "storage", "Supabase Storage", "DEGRADED", "unknown",
            "Chưa xác minh được kết nối Storage; vui lòng thử lại.",
        )


_WORKER_LABELS = {
    "viread_ocr_outbox": "OCR outbox worker",
    "viread_ocr_training": "OCR training worker",
    "book_quality": "Book quality worker",
    "admin_ai_workflow": "Admin AI workflow worker",
    "parent_book_submission": "Parent book submission worker",
    "active_model_registry": "Model registry worker",
    "local_trainer_process": "Local training process",
}


def _worker_state(worker: Any) -> str:
    if worker is None:
        return "disabled"
    try:
        if hasattr(worker, "is_alive"):
            return "running" if worker.is_alive() else "failed"
        if hasattr(worker, "returncode"):
            return "running" if worker.returncode is None else "failed"
        if hasattr(worker, "done"):
            if not worker.done():
                return "running"
            return "failed" if worker.cancelled() or worker.exception() is not None else "stopped"
    except Exception:
        return "unknown"
    return "unknown"


def collect_worker_health(workers: dict[str, Any]) -> list[dict[str, Any]]:
    results = []
    for key, label in _WORKER_LABELS.items():
        state = _worker_state(workers.get(key))
        tel = get_worker_telemetry(key)
        extra = {
            "last_success_at": tel.get("last_success_at"),
            "last_error": tel.get("last_error"),
            "oldest_pending_job_age_seconds": None,
            "queue_depth": None,
        }
        if state == "running":
            results.append({
                **_health_item(key, label, "HEALTHY", "healthy",
                               "Worker đang chạy trong tiến trình API."),
                **extra,
            })
        elif state == "disabled":
            results.append({
                **_health_item(key, label, "DEGRADED", "disabled",
                               "Worker không được khởi chạy trong tiến trình này."),
                **extra,
            })
        elif state == "unknown":
            results.append({
                **_health_item(key, label, "DEGRADED", "unknown",
                               "Chưa thể xác minh trạng thái worker."),
                **extra,
            })
        else:
            results.append({
                **_health_item(key, label, "UNAVAILABLE", "failed",
                               "Worker đã dừng hoặc gặp lỗi."),
                **extra,
            })
    return results


def _age_seconds(ts_val: Any, now: Any) -> float | None:
    from datetime import timezone

    if ts_val is None:
        return None
    if getattr(ts_val, "tzinfo", None) is None:
        ts_val = ts_val.replace(tzinfo=timezone.utc)
    return round(max(0.0, (now - ts_val).total_seconds()), 1)


async def collect_worker_queue_metrics(db: Any, *, now: Any | None = None) -> dict[str, dict[str, Any]]:
    """Read-only aggregate queue depth, oldest pending age, and last DB activity per worker."""
    from datetime import datetime, timezone
    from sqlalchemy import text

    ts = now or datetime.now(timezone.utc)
    metrics: dict[str, dict[str, Any]] = {}

    queries: dict[str, str] = {
        "ocr_worker": """
            SELECT
                COUNT(*) FILTER (WHERE status IN ('QUEUED','FAILED_RETRYABLE','CLAIMED','RUNNING'))::int AS queue_depth,
                MIN(created_at) FILTER (WHERE status IN ('QUEUED','FAILED_RETRYABLE','CLAIMED','RUNNING')) AS oldest_pending,
                MAX(completed_at) FILTER (WHERE status = 'SUCCEEDED') AS last_success
            FROM public.ocr_inference_jobs
        """,
        "parent_book_submission": """
            SELECT
                COUNT(*) FILTER (WHERE workflow_status = 'CHECKING')::int AS queue_depth,
                MIN(created_at) FILTER (WHERE workflow_status = 'CHECKING') AS oldest_pending,
                MAX(updated_at) FILTER (WHERE workflow_status IN ('PASSED_READY_TO_ADD','NEEDS_ADMIN_REVIEW','PENDING_ADMIN','ADDED_TO_BOOK')) AS last_success
            FROM public.parent_book_page_submissions
        """,
        "book_quality": """
            SELECT
                COUNT(*) FILTER (WHERE status IN ('QUEUED','RUNNING'))::int AS queue_depth,
                MIN(createdat) FILTER (WHERE status IN ('QUEUED','RUNNING')) AS oldest_pending,
                MAX(completedat) FILTER (WHERE status IN ('COMPLETED','PARTIAL')) AS last_success
            FROM public.bookqualityscanruns
        """,
        "admin_ai_workflow": """
            SELECT
                COUNT(*) FILTER (WHERE status IN ('QUEUED','RUNNING','RETRY'))::int AS queue_depth,
                MIN(createdat) FILTER (WHERE status IN ('QUEUED','RUNNING','RETRY')) AS oldest_pending,
                MAX(updatedat) FILTER (WHERE status IN ('READY_FOR_ADMIN_REVIEW','VERIFIED')) AS last_success
            FROM public.adminaiworkflows
        """,
        "viread_ocr_outbox": """
            SELECT
                COUNT(*) FILTER (WHERE status IN ('PENDING','RETRY','PROCESSING'))::int AS queue_depth,
                MIN(created_at) FILTER (WHERE status IN ('PENDING','RETRY','PROCESSING')) AS oldest_pending,
                MAX(updated_at) FILTER (WHERE status = 'DONE') AS last_success
            FROM public.viread_ocr_outbox
        """,
        "viread_ocr_training": """
            SELECT
                COUNT(*) FILTER (WHERE status IN ('LOCAL_RUNNING','COLAB_RUNNING','COLAB_SUBMITTING','COLAB_SUBMITTED','COLAB_EXECUTING','WAITING_FOR_COLAB_WORKER','FALLBACK_QUEUED_COLAB'))::int AS queue_depth,
                MIN(created_at) FILTER (WHERE status IN ('LOCAL_RUNNING','COLAB_RUNNING','COLAB_SUBMITTING','COLAB_SUBMITTED','COLAB_EXECUTING','WAITING_FOR_COLAB_WORKER','FALLBACK_QUEUED_COLAB')) AS oldest_pending,
                MAX(updated_at) FILTER (WHERE status = 'COMPLETED') AS last_success
            FROM public.viread_ocr_training_jobs
        """,
        "reading_reminder": """
            SELECT
                COUNT(*) FILTER (WHERE emailstatus IN ('PENDING','RETRY','SENDING'))::int AS queue_depth,
                MIN(scheduledfor) FILTER (WHERE emailstatus IN ('PENDING','RETRY','SENDING')) AS oldest_pending,
                MAX(emailsentat) FILTER (WHERE emailstatus = 'SENT') AS last_success
            FROM public.readingreminderoccurrences
        """,
        "reading_presence": """
            SELECT
                COUNT(*) FILTER (WHERE status IN ('PENDING','SENDING'))::int AS queue_depth,
                MIN(dueat) FILTER (WHERE status IN ('PENDING','SENDING')) AS oldest_pending,
                MAX(sentat) FILTER (WHERE status = 'SENT') AS last_success
            FROM public.readingpresencealerts
        """,
        "karaoke_processing": """
            SELECT
                COUNT(*) FILTER (WHERE status IN ('QUEUED','RUNNING'))::int AS queue_depth,
                MIN(created_at) FILTER (WHERE status IN ('QUEUED','RUNNING')) AS oldest_pending,
                MAX(finished_at) FILTER (WHERE status IN ('READY','NEEDS_REVIEW','APPLIED')) AS last_success
            FROM public.karaoke_processing_jobs
        """,
        "active_model_registry": """
            SELECT
                0::int AS queue_depth,
                NULL::timestamptz AS oldest_pending,
                MAX(updated_at) AS last_success
            FROM public.viread_ocr_active_model
        """,
    }

    for worker_key, sql in queries.items():
        try:
            async with db.begin_nested():
                row = (await db.execute(text(sql))).mappings().first()
            if row is not None:
                last_succ = row.get("last_success")
                if last_succ is not None and getattr(last_succ, "tzinfo", None) is None:
                    last_succ = last_succ.replace(tzinfo=timezone.utc)
                metrics[worker_key] = {
                    "queue_depth": int(row.get("queue_depth") or 0),
                    "oldest_pending_job_age_seconds": _age_seconds(row.get("oldest_pending"), ts),
                    "last_success_at": last_succ,
                    "last_error": None,
                }
        except Exception:
            continue
    return metrics


def runtime_configuration_diagnostics(*, include_ocr: bool = True) -> dict[str, bool | None]:
    """Compatibility booleans backed by independent, real low-cost checks.

    Does not expose URLs, bucket names, commands, checkpoint paths or keys.
    """
    ocr_available = None
    vietnamese_available = None
    tesseract_configured = None
    tesseract_executable = None
    if include_ocr:
        ocr_available = _package_installed("paddleocr") and _package_installed("vietocr")
        _, _, tesseract_executable, vietnamese_available = _tesseract_health()
        tesseract_configured = bool(os.environ.get("TESSERACT_CMD", "tesseract").strip())

    try:
        LocalOcrConfig.from_environment()
        local_ocr_config_valid = True
    except LocalCorrectionError:
        local_ocr_config_valid = False

    return {
        "supabase_url_configured": bool(SUPABASE_URL),
        "supabase_storage_bucket_configured": bool(SUPABASE_STORAGE_BUCKET),
        "server_side_key_configured": bool(SUPABASE_ADMIN_KEY),
        "local_ocr_config_valid": local_ocr_config_valid,
        "ocr_engine_available": ocr_available,
        "vietnamese_language_available": vietnamese_available,
        "tesseract_command_configured": tesseract_configured,
        "tesseract_executable_available": tesseract_executable,
    }


READY_OCR_DETAIL_STATUSES = frozenset({"loaded", "inference_verified", "healthy"})


def is_ocr_engine_ready_status(detail_status: object) -> bool:
    """Only loaded or inference-verified engines count as OCR ready (never 'installed')."""
    return str(detail_status or "").strip().lower() in READY_OCR_DETAIL_STATUSES


async def collect_remote_ocr_health() -> dict[str, Any]:
    """Collect remote Windows OCR worker heartbeats, engine states, and durable queue depth."""
    from datetime import datetime, timezone

    from app.database.session import AsyncSessionLocal
    from app.repositories.ocr_inference_job_repository import OcrInferenceJobRepository
    from app.services.ocr_inference_job_service import worker_heartbeat_ttl_seconds

    now = datetime.now(timezone.utc)
    ttl_seconds = worker_heartbeat_ttl_seconds()
    async with AsyncSessionLocal() as db:
        repo = OcrInferenceJobRepository(db)
        workers = await repo.list_worker_heartbeats(limit=10)
        queue = await repo.queue_depth_counts(now=now)

    serialized_workers: list[dict[str, Any]] = []
    latest_online_engines: dict[str, Any] = {}
    any_online_ready = False

    for worker in workers:
        hb_at = worker.LastHeartbeatAt
        if hb_at is not None and hb_at.tzinfo is None:
            hb_at = hb_at.replace(tzinfo=timezone.utc)
        age_seconds = round(max(0.0, (now - hb_at).total_seconds()), 1) if hb_at else None
        status_upper = str(worker.Status or "OFFLINE").upper()
        online = age_seconds is not None and age_seconds <= ttl_seconds and status_upper != "OFFLINE"

        raw_engines = dict(worker.Engines or {})
        engine_summary: dict[str, dict[str, Any]] = {}
        worker_has_ready_engine = False
        for eng_id in ("paddleocr", "vietocr", "tesseract_vie"):
            info = raw_engines.get(eng_id)
            if isinstance(info, dict):
                detail = str(info.get("detail_status") or "unknown")
                verified = bool(info.get("inference_verified", False))
                loaded = bool(info.get("loaded", False))
                engine_summary[eng_id] = {
                    "status": str(info.get("status") or "UNKNOWN"),
                    "detail_status": detail,
                    "installed": bool(info.get("installed", False)),
                    "loaded": loaded,
                    "inference_verified": verified,
                }
                if (is_ocr_engine_ready_status(detail) and (loaded or verified or detail == "healthy")) or verified:
                    worker_has_ready_engine = True

        worker_entry = {
            "worker_id": worker.WorkerId,
            "hostname": worker.Hostname,
            "status": status_upper,
            "online": online,
            "last_heartbeat_at": hb_at.isoformat() if hb_at else None,
            "age_seconds": age_seconds,
            "active_job_count": int(worker.ActiveJobCount or 0),
            "concurrency_limit": int(worker.ConcurrencyLimit or 1),
            "model_profile": worker.ModelProfile,
            "model_sha256": worker.ModelSha256,
            "app_version": worker.AppVersion,
            "git_sha": worker.GitSha,
            "engines": engine_summary,
        }
        serialized_workers.append(worker_entry)

        if online and status_upper in {"IDLE", "BUSY"} and worker_has_ready_engine:
            any_online_ready = True
            if not latest_online_engines:
                latest_online_engines = engine_summary
        elif online and not latest_online_engines and engine_summary:
            latest_online_engines = engine_summary

    # Outside the DB session: merge passive `<worker>/health` probe (60s RAM cache) so a
    # Hugging Face Space in Quiet Standby reports accurate readiness and resets HF's 48h timer.
    from app.services.remote_ocr_wakeup import (
        is_remote_worker_wakeup_configured,
        probe_configured_remote_ocr_worker_health,
    )

    if is_remote_worker_wakeup_configured():
        passive_probe = await probe_configured_remote_ocr_worker_health()
        if isinstance(passive_probe, dict) and passive_probe.get("online"):
            probe_wid = str(passive_probe.get("worker_id") or "hf-ocr-space")
            existing_idx = next(
                (
                    idx
                    for idx, item in enumerate(serialized_workers)
                    if item.get("worker_id") == probe_wid
                ),
                None,
            )
            if existing_idx is None:
                serialized_workers.insert(0, passive_probe)
            elif not serialized_workers[existing_idx].get("online"):
                serialized_workers[existing_idx] = passive_probe

            probe_engines = dict(passive_probe.get("engines") or {})
            if bool(passive_probe.get("ready")):
                any_online_ready = True
                if not latest_online_engines and probe_engines:
                    latest_online_engines = probe_engines
            elif not latest_online_engines and probe_engines:
                latest_online_engines = probe_engines

    return {
        "mode": "remote_worker",
        "ready": any_online_ready,
        "heartbeat_ttl_seconds": ttl_seconds,
        "engines": latest_online_engines,
        "workers": serialized_workers,
        "queue": queue,
    }
