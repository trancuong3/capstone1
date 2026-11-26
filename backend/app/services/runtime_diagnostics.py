"""Read-only, bounded runtime health checks; never start an OCR model.

"Installed" means package presence, not successful OCR inference. Tesseract is
probed independently and its Vietnamese language pack is explicitly checked.
No secret, model path or command line appears in the returned evidence.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import httpx
from urllib.parse import quote
import os
import shutil
import subprocess
import sys
import time
import weakref
from functools import lru_cache
from typing import Any

from app.database.config import (
    SUPABASE_ADMIN_KEY,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_URL,
    supabase_admin_headers,
)
from app.services import worker_telemetry
from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig
from app.services.worker_telemetry import get_worker_telemetry

_REAL_HTTPX_ASYNC_CLIENT = httpx.AsyncClient
_STORAGE_HTTP_CLIENTS: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, httpx.AsyncClient
] = weakref.WeakKeyDictionary()
_STORAGE_HEALTH_CACHE_TTL_SECONDS = 15.0
_STORAGE_HEALTH_CACHE: tuple[float, tuple[str, str, str], dict[str, str]] | None = None


def clear_storage_health_cache() -> None:
    """Clear the 15s RAM TTL cache for Storage health probes (for tests or manual refresh)."""
    global _STORAGE_HEALTH_CACHE
    _STORAGE_HEALTH_CACHE = None


def _get_pooled_storage_http_client() -> httpx.AsyncClient | None:
    """Return a loop-bound pooled httpx.AsyncClient unless httpx.AsyncClient is monkeypatched."""
    if httpx.AsyncClient is not _REAL_HTTPX_ASYNC_CLIENT:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    client = _STORAGE_HTTP_CLIENTS.get(loop)
    if client is None or getattr(client, "is_closed", False):
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(2.5, connect=1.5),
            follow_redirects=False,
            trust_env=False,
            limits=httpx.Limits(
                max_connections=8,
                max_keepalive_connections=4,
                keepalive_expiry=30.0,
            ),
        )
        _STORAGE_HTTP_CLIENTS[loop] = client
    return client


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
    """Map health triad + detail/queue/quota telemetry to the canonical 10-value operational_state."""
    if quota_exhausted or (last_error and "QUOTA" in str(last_error).upper()):
        return "Quota exhausted"
    if detail_status == "disabled":
        return "Offline"
    if detail_status == "local_only":
        return "Local only"
    if detail_status == "remote_delegated":
        return "Standby"
    if detail_status == "standby":
        if status == "UNAVAILABLE":
            return "Offline"
        if queue_depth is not None and queue_depth > 0 and not last_error:
            return "Queued"
        return "Standby"
    if status == "UNAVAILABLE":
        return "Offline"
    if status in {"HEALTHY", "DEGRADED"} and queue_depth is not None and queue_depth > 0 and not last_error:
        return "Queued"
    if detail_status == "scheduled" and status == "HEALTHY":
        return "Scheduled"
    if detail_status in {"cached", "client_side", "cloud_ready"} and status == "HEALTHY":
        return "Healthy"
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


async def probe_storage_health(*, bypass_cache: bool = False) -> dict[str, str]:
    """A read-only HEAD of the configured bucket with loop-pooled HTTP client and 15s RAM TTL cache."""
    global _STORAGE_HEALTH_CACHE
    core_meta = {
        "service_group": "core",
        "execution_mode": "always_on",
        "criticality": "core",
    }
    if not (SUPABASE_URL and SUPABASE_STORAGE_BUCKET and SUPABASE_ADMIN_KEY):
        return {
            **_health_item(
                "storage", "Supabase Storage", "UNAVAILABLE", "failed",
                "Thiếu cấu hình kết nối Supabase Storage.",
            ),
            **core_meta,
        }

    key_digest = hashlib.sha256(str(SUPABASE_ADMIN_KEY).encode("utf-8")).hexdigest()[:16]
    cache_key = (str(SUPABASE_URL).rstrip("/"), str(SUPABASE_STORAGE_BUCKET), key_digest)
    now_mono = time.monotonic()
    if not bypass_cache and _STORAGE_HEALTH_CACHE is not None:
        expires_at, cached_key, cached_item = _STORAGE_HEALTH_CACHE
        if cached_key == cache_key and now_mono < expires_at:
            return dict(cached_item)

    try:
        url = (
            f"{SUPABASE_URL.rstrip('/')}/storage/v1/bucket/"
            f"{quote(SUPABASE_STORAGE_BUCKET, safe='')}"
        )
        headers = supabase_admin_headers(SUPABASE_ADMIN_KEY)
        pooled = _get_pooled_storage_http_client()
        if pooled is not None:
            response = await pooled.head(url, headers=headers)
        else:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(2.5, connect=1.5),
                follow_redirects=False, trust_env=False,
            ) as client:
                response = await client.head(url, headers=headers)
        if response.status_code == 200:
            item = {
                **_health_item(
                    "storage", "Supabase Storage", "HEALTHY", "healthy",
                    "Storage phản hồi kiểm tra bucket (không đọc file).",
                ),
                **core_meta,
            }
        elif response.status_code in {401, 403}:
            item = {
                **_health_item(
                    "storage", "Supabase Storage", "UNAVAILABLE", "failed",
                    "Storage từ chối quyền kiểm tra bucket.",
                ),
                **core_meta,
            }
        elif response.status_code == 404:
            item = {
                **_health_item(
                    "storage", "Supabase Storage", "UNAVAILABLE", "failed",
                    "Không tìm thấy bucket Storage đã cấu hình.",
                ),
                **core_meta,
            }
        else:
            item = {
                **_health_item(
                    "storage", "Supabase Storage", "DEGRADED", "unknown",
                    "Storage chưa phản hồi trạng thái bucket hợp lệ.",
                ),
                **core_meta,
            }
    except (httpx.HTTPError, TimeoutError, ValueError, OSError):
        item = {
            **_health_item(
                "storage", "Supabase Storage", "DEGRADED", "unknown",
                "Chưa xác minh được kết nối Storage; vui lòng thử lại.",
            ),
            **core_meta,
        }

    _STORAGE_HEALTH_CACHE = (
        time.monotonic() + _STORAGE_HEALTH_CACHE_TTL_SECONDS,
        cache_key,
        dict(item),
    )
    return item


_WORKER_LABELS = {
    "viread_ocr_outbox": "OCR outbox worker",
    "viread_ocr_training": "OCR training worker",
    "book_quality": "Book quality worker",
    "admin_ai_workflow": "Admin AI workflow worker",
    "parent_book_submission": "Parent book submission worker",
    "parent_email_dispatcher": "Parent email dispatcher worker",
    "active_model_registry": "Model registry worker",
    "local_trainer_process": "Local training process",
}


def collect_email_delivery_health() -> dict[str, str]:
    """Read-only check of parent email provider configuration (never leaks secrets)."""
    from app.database import config as settings
    from app.providers.parent_email_transport import (
        active_email_provider,
        is_public_app_url,
    )

    provider = active_email_provider()
    if provider == "unconfigured":
        return _health_item(
            "parent_email_delivery",
            "Gửi email phụ huynh",
            "UNAVAILABLE",
            "disabled",
            "Chưa cấu hình RESEND_API_KEY hoặc SMTP_* để tự động gửi email cho phụ huynh.",
        )
    if provider != "mail_sink" and not SUPABASE_ADMIN_KEY:
        return _health_item(
            "parent_email_delivery",
            "Gửi email phụ huynh",
            "DEGRADED",
            "failed",
            "Đã cấu hình gửi mail nhưng thiếu SUPABASE_SECRET_KEY để tra cứu email xác minh.",
        )
    if (
        settings.APP_ENVIRONMENT == "production"
        and not is_public_app_url(settings.PARENT_EMAIL_APP_URL)
    ):
        return _health_item(
            "parent_email_delivery",
            "Gửi email phụ huynh",
            "DEGRADED",
            "unknown",
            f"Đã cấu hình nhà cung cấp ({provider}) nhưng PARENT_EMAIL_APP_URL chưa phải URL HTTPS công khai.",
        )
    return _health_item(
        "parent_email_delivery",
        "Gửi email phụ huynh",
        "HEALTHY",
        "healthy",
        f"Dịch vụ gửi email phụ huynh sẵn sàng ({provider}).",
    )


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


def _normalize_utc_timestamp(ts_val: Any) -> Any:
    from datetime import datetime, timezone

    if ts_val is None:
        return None
    if isinstance(ts_val, str):
        cleaned = ts_val.strip()
        if not cleaned:
            return None
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        try:
            ts_val = datetime.fromisoformat(cleaned)
        except ValueError:
            return None
    if isinstance(ts_val, datetime) and ts_val.tzinfo is None:
        return ts_val.replace(tzinfo=timezone.utc)
    return ts_val


def _age_seconds(ts_val: Any, now: Any) -> float | None:
    normalized = _normalize_utc_timestamp(ts_val)
    if normalized is None:
        return None
    return round(max(0.0, (now - normalized).total_seconds()), 1)


_NON_OCR_WORKER_QUEUE_BRANCHES: tuple[tuple[str, str], ...] = (
    (
        "parent_book_submission",
        """
        SELECT
            'parent_book_submission'::text AS worker_key,
            COALESCE(COUNT(*) FILTER (WHERE workflow_status = 'CHECKING'), 0)::int AS queue_depth,
            MIN(created_at) FILTER (WHERE workflow_status = 'CHECKING')::timestamptz AS oldest_pending,
            MAX(updated_at) FILTER (WHERE workflow_status IN ('PASSED_READY_TO_ADD','NEEDS_ADMIN_REVIEW','PENDING_ADMIN','ADDED_TO_BOOK'))::timestamptz AS last_success
        FROM public.parent_book_page_submissions
        """,
    ),
    (
        "book_quality",
        """
        SELECT
            'book_quality'::text AS worker_key,
            COALESCE(COUNT(*) FILTER (WHERE status IN ('QUEUED','RUNNING')), 0)::int AS queue_depth,
            MIN(createdat) FILTER (WHERE status IN ('QUEUED','RUNNING'))::timestamptz AS oldest_pending,
            MAX(completedat) FILTER (WHERE status IN ('COMPLETED','PARTIAL'))::timestamptz AS last_success
        FROM public.bookqualityscanruns
        """,
    ),
    (
        "admin_ai_workflow",
        """
        SELECT
            'admin_ai_workflow'::text AS worker_key,
            COALESCE(COUNT(*) FILTER (WHERE status IN ('QUEUED','RUNNING','RETRY')), 0)::int AS queue_depth,
            MIN(createdat) FILTER (WHERE status IN ('QUEUED','RUNNING','RETRY'))::timestamptz AS oldest_pending,
            MAX(updatedat) FILTER (WHERE status IN ('READY_FOR_ADMIN_REVIEW','VERIFIED'))::timestamptz AS last_success
        FROM public.adminaiworkflows
        """,
    ),
    (
        "viread_ocr_outbox",
        """
        SELECT
            'viread_ocr_outbox'::text AS worker_key,
            COALESCE(COUNT(*) FILTER (WHERE status IN ('PENDING','RETRY','PROCESSING')), 0)::int AS queue_depth,
            MIN(created_at) FILTER (WHERE status IN ('PENDING','RETRY','PROCESSING'))::timestamptz AS oldest_pending,
            MAX(updated_at) FILTER (WHERE status = 'DONE')::timestamptz AS last_success
        FROM public.viread_ocr_outbox
        """,
    ),
    (
        "viread_ocr_training",
        """
        SELECT
            'viread_ocr_training'::text AS worker_key,
            COALESCE(COUNT(*) FILTER (WHERE status IN ('LOCAL_RUNNING','COLAB_RUNNING','COLAB_SUBMITTING','COLAB_SUBMITTED','COLAB_EXECUTING','WAITING_FOR_COLAB_WORKER','FALLBACK_QUEUED_COLAB')), 0)::int AS queue_depth,
            MIN(created_at) FILTER (WHERE status IN ('LOCAL_RUNNING','COLAB_RUNNING','COLAB_SUBMITTING','COLAB_SUBMITTED','COLAB_EXECUTING','WAITING_FOR_COLAB_WORKER','FALLBACK_QUEUED_COLAB'))::timestamptz AS oldest_pending,
            MAX(updated_at) FILTER (WHERE status = 'COMPLETED')::timestamptz AS last_success
        FROM public.viread_ocr_training_jobs
        """,
    ),
    (
        "reading_reminder",
        """
        SELECT
            'reading_reminder'::text AS worker_key,
            COALESCE(COUNT(*) FILTER (WHERE emailstatus IN ('PENDING','RETRY','SENDING')), 0)::int AS queue_depth,
            MIN(scheduledfor) FILTER (WHERE emailstatus IN ('PENDING','RETRY','SENDING'))::timestamptz AS oldest_pending,
            MAX(emailsentat) FILTER (WHERE emailstatus = 'SENT')::timestamptz AS last_success
        FROM public.readingreminderoccurrences
        """,
    ),
    (
        "reading_presence",
        """
        SELECT
            'reading_presence'::text AS worker_key,
            COALESCE(COUNT(*) FILTER (WHERE status IN ('PENDING','SENDING')), 0)::int AS queue_depth,
            MIN(dueat) FILTER (WHERE status IN ('PENDING','SENDING'))::timestamptz AS oldest_pending,
            MAX(sentat) FILTER (WHERE status = 'SENT')::timestamptz AS last_success
        FROM public.readingpresencealerts
        """,
    ),
    (
        "karaoke_processing",
        """
        SELECT
            'karaoke_processing'::text AS worker_key,
            COALESCE(COUNT(*) FILTER (WHERE status IN ('QUEUED','RUNNING')), 0)::int AS queue_depth,
            MIN(created_at) FILTER (WHERE status IN ('QUEUED','RUNNING'))::timestamptz AS oldest_pending,
            MAX(finished_at) FILTER (WHERE status IN ('READY','NEEDS_REVIEW','APPLIED'))::timestamptz AS last_success
        FROM public.karaoke_processing_jobs
        """,
    ),
    (
        "active_model_registry",
        """
        SELECT
            'active_model_registry'::text AS worker_key,
            0::int AS queue_depth,
            NULL::timestamptz AS oldest_pending,
            MAX(updated_at)::timestamptz AS last_success
        FROM public.viread_ocr_active_model
        """,
    ),
)

_OCR_WORKER_QUEUE_BRANCH: tuple[str, str] = (
    "ocr_worker",
    """
    SELECT
        'ocr_worker'::text AS worker_key,
        COALESCE(COUNT(*) FILTER (WHERE status IN ('QUEUED','FAILED_RETRYABLE','CLAIMED','RUNNING')), 0)::int AS queue_depth,
        MIN(created_at) FILTER (WHERE status IN ('QUEUED','FAILED_RETRYABLE','CLAIMED','RUNNING'))::timestamptz AS oldest_pending,
        MAX(completed_at) FILTER (WHERE status = 'SUCCEEDED')::timestamptz AS last_success
    FROM public.ocr_inference_jobs
    """,
)


def _sqlite_portable_sql(sql: str) -> str:
    return (
        sql.replace("public.", "")
        .replace("::text", "")
        .replace("::int", "")
        .replace("::timestamptz", "")
    )


def _row_to_metric(row: Any, ts: Any) -> dict[str, Any]:
    return {
        "queue_depth": int(row.get("queue_depth") or 0),
        "oldest_pending_job_age_seconds": _age_seconds(row.get("oldest_pending"), ts),
        "last_success_at": _normalize_utc_timestamp(row.get("last_success")),
        "last_error": None,
    }


async def _execute_worker_queue_metrics_on_session(
    session: Any,
    *,
    ts: Any,
    include_ocr_worker: bool,
    timeout: float,
) -> dict[str, dict[str, Any]]:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession

    branches = (
        (_OCR_WORKER_QUEUE_BRANCH, *_NON_OCR_WORKER_QUEUE_BRANCHES)
        if include_ocr_worker
        else _NON_OCR_WORKER_QUEUE_BRANCHES
    )
    is_real_session = isinstance(session, AsyncSession)
    is_sqlite = False
    if is_real_session:
        bind = getattr(session, "bind", None)
        dialect_name = getattr(getattr(bind, "dialect", None), "name", "")
        is_sqlite = str(dialect_name).lower() == "sqlite"
        if not session.in_transaction() and not is_sqlite:
            await session.connection(execution_options={"isolation_level": "AUTOCOMMIT"})

    union_sql = "\nUNION ALL\n".join(
        _sqlite_portable_sql(sql) if is_sqlite else sql for _k, sql in branches
    )

    metrics: dict[str, dict[str, Any]] = {}
    try:
        rows = (
            await asyncio.wait_for(session.execute(text(union_sql)), timeout=timeout)
        ).mappings().all()
        for row in rows:
            wkey = str(row.get("worker_key") or "").strip()
            if wkey:
                metrics[wkey] = _row_to_metric(row, ts)
        return metrics
    except asyncio.CancelledError:
        raise
    except Exception:
        # Fallback for minimal SQLite test DBs that omit one or more tables.
        if is_real_session and session.in_transaction():
            try:
                await session.rollback()
            except Exception:
                pass

    for worker_key, sql in branches:
        candidate_sql = _sqlite_portable_sql(sql) if is_sqlite else sql
        try:
            if is_real_session and session.in_transaction():
                async with session.begin_nested():
                    row = (
                        await asyncio.wait_for(
                            session.execute(text(candidate_sql)), timeout=min(2.0, timeout)
                        )
                    ).mappings().first()
            else:
                row = (
                    await asyncio.wait_for(
                        session.execute(text(candidate_sql)), timeout=min(2.0, timeout)
                    )
                ).mappings().first()
            if row is not None:
                metrics[worker_key] = _row_to_metric(row, ts)
        except asyncio.CancelledError:
            raise
        except Exception:
            if not is_sqlite:
                # Retry portable SQL once in case a fake/mock SQLite session wasn't detected via bind.dialect.
                try:
                    row = (
                        await asyncio.wait_for(
                            session.execute(text(_sqlite_portable_sql(sql))),
                            timeout=min(2.0, timeout),
                        )
                    ).mappings().first()
                    if row is not None:
                        metrics[worker_key] = _row_to_metric(row, ts)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    continue
            continue
    return metrics


async def collect_worker_queue_metrics(
    db: Any = None,
    *,
    now: Any | None = None,
    include_ocr_worker: bool = False,
    timeout: float = 5.0,
) -> dict[str, dict[str, Any]]:
    """Read-only aggregate queue depth, oldest pending age, and last DB activity via 1-RTT UNION ALL."""
    from datetime import datetime, timezone

    ts = now or datetime.now(timezone.utc)
    if db is None:
        from app.database.session import AsyncSessionLocal

        async with AsyncSessionLocal() as session:
            return await _execute_worker_queue_metrics_on_session(
                session,
                ts=ts,
                include_ocr_worker=include_ocr_worker,
                timeout=timeout,
            )
    return await _execute_worker_queue_metrics_on_session(
        db,
        ts=ts,
        include_ocr_worker=include_ocr_worker,
        timeout=timeout,
    )


async def collect_persisted_worker_heartbeats(
    db: Any = None,
    *,
    timeout: float = 3.0,
) -> dict[str, dict[str, Any]]:
    """Safely read persisted worker heartbeats on an AUTOCOMMIT session (fail-safe {})."""
    reader = getattr(worker_telemetry, "read_persisted_worker_heartbeats", None)
    if not callable(reader):
        return {}
    try:
        from sqlalchemy.ext.asyncio import AsyncSession

        if db is None:
            from app.database.session import AsyncSessionLocal

            async with AsyncSessionLocal() as session:
                if isinstance(session, AsyncSession) and not session.in_transaction():
                    await session.connection(execution_options={"isolation_level": "AUTOCOMMIT"})
                result = await asyncio.wait_for(reader(session), timeout=timeout)
                return dict(result) if isinstance(result, dict) else {}

        if isinstance(db, AsyncSession) and not db.in_transaction():
            bind = getattr(db, "bind", None)
            dialect_name = str(getattr(getattr(bind, "dialect", None), "name", "")).lower()
            if dialect_name != "sqlite":
                await db.connection(execution_options={"isolation_level": "AUTOCOMMIT"})
        result = await asyncio.wait_for(reader(db), timeout=timeout)
        return dict(result) if isinstance(result, dict) else {}
    except asyncio.CancelledError:
        raise
    except Exception:
        return {}


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
    from sqlalchemy.ext.asyncio import AsyncSession

    now = datetime.now(timezone.utc)
    ttl_seconds = worker_heartbeat_ttl_seconds()
    async with AsyncSessionLocal() as db:
        if isinstance(db, AsyncSession):
            # Read-only health queries skip BEGIN/ROLLBACK round-trips over cross-region pooler.
            await db.connection(execution_options={"isolation_level": "AUTOCOMMIT"})
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
        peek_remote_ocr_probe_degraded,
        probe_configured_remote_ocr_worker_health,
    )

    remote_probe_degraded = False
    wakeup_configured = is_remote_worker_wakeup_configured()
    if wakeup_configured:
        passive_probe = await probe_configured_remote_ocr_worker_health()
        if isinstance(passive_probe, dict) and passive_probe.get("online"):
            is_synthetic_scale_to_zero = passive_probe.get("standby_mode") == "scale_to_zero"
            has_live_db_worker = any(bool(item.get("online")) for item in serialized_workers)
            probe_wid = str(passive_probe.get("worker_id") or "hf-ocr-space")
            existing_idx = next(
                (
                    idx
                    for idx, item in enumerate(serialized_workers)
                    if item.get("worker_id") == probe_wid
                ),
                None,
            )
            if not (is_synthetic_scale_to_zero and has_live_db_worker):
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
        if not any_online_ready and peek_remote_ocr_probe_degraded():
            remote_probe_degraded = True

    out: dict[str, Any] = {
        "mode": "remote_worker",
        "ready": any_online_ready,
        "wakeup_configured": wakeup_configured,
        "heartbeat_ttl_seconds": ttl_seconds,
        "engines": latest_online_engines,
        "workers": serialized_workers,
        "queue": queue,
    }
    if remote_probe_degraded:
        out["probe_degraded"] = True
    return out
