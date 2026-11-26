"""Passive readiness probe and post-commit wake webhook for hosted 0-cost OCR workers.

Designed specifically for Render Free (512 MB, NullPool) + Hugging Face Private Docker Spaces:
1. Passive `GET <worker>/health` (60s RAM cache, single-flight coalesced, zero DB locks)
   resets HF Spaces' 48h inactivity sleep timer without waking the worker's DB poll loop.
2. Post-commit `POST <worker>/wakeup` wakes a Quiet Standby worker in <1s only AFTER the
   `QUEUED` job transaction commits (never on rollback), with a 2.5s Hybrid GPU-First grace
   window when a local CUDA worker is online and idle for single-page scans.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import ipaddress
import logging
import os
import socket
import time
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.database.config import APP_ENVIRONMENT

logger = logging.getLogger(__name__)

DEFAULT_HEALTH_CACHE_TTL_SECONDS = 60.0
DEFAULT_HYBRID_GPU_GRACE_SECONDS = 2.5
DEFAULT_WAKE_COALESCE_SECONDS = 1.5
DEFAULT_STALE_QUEUED_MIN_AGE_SECONDS = 8.0
DEFAULT_STALE_QUEUED_NUDGE_COOLDOWN_SECONDS = 15.0
DEFAULT_ACTIVE_BURST_SUPPRESS_SECONDS = 45.0
DEFAULT_CRON_KEEPWARM_INTERVAL_SECONDS = 12 * 3600.0
DEFAULT_DNS_VALIDATION_TTL_SECONDS = 60.0

_HEALTH_CACHE: tuple[float, str, dict[str, Any] | None, bool] | None = None
_HEALTH_LOCKS: dict[int, asyncio.Lock] = {}
_LAST_WAKE_SENT: tuple[str, float] | None = None
_LAST_WAKE_ATTEMPT_AT: tuple[str, float] | None = None
_LAST_CRON_KEEPWARM_AT: float = 0.0
_DNS_SAFE_CACHE: dict[str, tuple[float, bool]] = {}
_WAKEUP_TASKS: set[asyncio.Task[Any]] = set()
_CUSTOM_TRANSPORT: httpx.AsyncBaseTransport | None = None


def set_remote_ocr_wakeup_transport_for_tests(
    transport: httpx.AsyncBaseTransport | None,
) -> None:
    """Inject an in-memory httpx AsyncBaseTransport for deterministic unit/stress tests."""
    global _CUSTOM_TRANSPORT
    _CUSTOM_TRANSPORT = transport


def clear_remote_ocr_wakeup_cache_for_tests() -> None:
    """Reset in-memory health/wakeup caches between tests."""
    global _HEALTH_CACHE, _LAST_WAKE_SENT, _LAST_WAKE_ATTEMPT_AT, _LAST_CRON_KEEPWARM_AT
    _HEALTH_CACHE = None
    _LAST_WAKE_SENT = None
    _LAST_WAKE_ATTEMPT_AT = None
    _LAST_CRON_KEEPWARM_AT = 0.0
    _DNS_SAFE_CACHE.clear()
    _HEALTH_LOCKS.clear()


def _loop_health_lock() -> asyncio.Lock:
    loop_id = id(asyncio.get_running_loop())
    lock = _HEALTH_LOCKS.get(loop_id)
    if lock is None:
        lock = asyncio.Lock()
        _HEALTH_LOCKS[loop_id] = lock
    return lock


def _is_production_env() -> bool:
    env = (os.getenv("APP_ENVIRONMENT") or APP_ENVIRONMENT or "").strip().lower()
    return env == "production" or (os.getenv("RENDER") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _is_disallowed_ip(ip_val: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip_val, ipaddress.IPv6Address) and ip_val.ipv4_mapped is not None:
        return _is_disallowed_ip(ip_val.ipv4_mapped)
    return bool(
        ip_val.is_private
        or ip_val.is_loopback
        or ip_val.is_link_local
        or ip_val.is_multicast
        or ip_val.is_reserved
        or ip_val.is_unspecified
    )


def get_configured_remote_ocr_worker_url() -> str | None:
    """Return validated base URL for the hosted OCR worker, or None if unconfigured."""
    raw = (
        os.getenv("VIREAD_OCR_REMOTE_WORKER_URL")
        or os.getenv("VIREAD_HF_OCR_SPACE_URL")
        or ""
    ).strip()
    if not raw:
        return None
    try:
        parsed = urlsplit(raw)
        _ = parsed.port
    except ValueError:
        logger.warning("Invalid VIREAD_OCR_REMOTE_WORKER_URL ignored.")
        return None

    scheme = (parsed.scheme or "").lower()
    if scheme not in ("https", "http"):
        return None
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None

    if _is_production_env():
        if scheme != "https":
            logger.warning("Refusing non-HTTPS VIREAD_OCR_REMOTE_WORKER_URL in production.")
            return None
        host_lower = parsed.hostname.lower().rstrip(".")
        if host_lower in {"localhost", "metadata.google.internal"} or host_lower.endswith(
            ".localhost"
        ):
            return None
        try:
            ip_val = ipaddress.ip_address(host_lower)
            if _is_disallowed_ip(ip_val):
                return None
        except ValueError:
            pass

    clean_path = parsed.path.rstrip("/")
    netloc = parsed.netloc
    return f"{scheme}://{netloc}{clean_path}"


async def _validate_production_target_dns(base_url: str) -> bool:
    """Block DNS rebinding / private IP resolution in production without touching test transports."""
    if not _is_production_env() or _CUSTOM_TRANSPORT is not None:
        return True
    parsed = urlsplit(base_url)
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        return False
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    cache_key = f"{host}:{port}"
    now_mono = time.monotonic()
    cached = _DNS_SAFE_CACHE.get(cache_key)
    if cached is not None and now_mono < cached[0]:
        return cached[1]
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            host, port, type=socket.SOCK_STREAM
        )
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        sockaddr = info[4]
        raw_ip = str(sockaddr[0]).split("%", 1)[0]
        try:
            ip_obj = ipaddress.ip_address(raw_ip)
        except ValueError:
            _DNS_SAFE_CACHE[cache_key] = (now_mono + 15.0, False)
            return False
        if _is_disallowed_ip(ip_obj):
            logger.warning("Blocked remote OCR worker URL resolving to non-public IP.")
            _DNS_SAFE_CACHE[cache_key] = (now_mono + 30.0, False)
            return False
    _DNS_SAFE_CACHE[cache_key] = (now_mono + DEFAULT_DNS_VALIDATION_TTL_SECONDS, True)
    return True


def is_remote_worker_wakeup_configured() -> bool:
    return get_configured_remote_ocr_worker_url() is not None


def _hf_space_bearer_headers() -> dict[str, str]:
    token = (
        os.getenv("VIREAD_HF_SPACE_TOKEN")
        or os.getenv("HF_READ_TOKEN")
        or ""
    ).strip()
    if token:
        return {"Authorization": f"Bearer {token}"}
    return {}


def _health_cache_ttl_seconds() -> float:
    raw = (os.getenv("VIREAD_OCR_REMOTE_HEALTH_CACHE_SECONDS") or "").strip()
    if raw:
        try:
            return max(5.0, min(600.0, float(raw)))
        except ValueError:
            pass
    return DEFAULT_HEALTH_CACHE_TTL_SECONDS


def _hybrid_gpu_grace_seconds() -> float:
    raw = (os.getenv("VIREAD_OCR_HYBRID_GPU_GRACE_SECONDS") or "").strip()
    if raw:
        try:
            return max(0.0, min(15.0, float(raw)))
        except ValueError:
            pass
    return DEFAULT_HYBRID_GPU_GRACE_SECONDS


def _normalize_remote_health_payload(payload: dict[str, Any]) -> dict[str, Any]:
    ready = bool(payload.get("ready", False))
    worker_status = str(
        payload.get("worker_status") or ("IDLE" if ready else "DEGRADED")
    ).upper()
    online = worker_status != "OFFLINE"
    model_obj = payload.get("model") if isinstance(payload.get("model"), dict) else {}
    raw_engines = payload.get("engines") if isinstance(payload.get("engines"), dict) else {}
    engine_summary: dict[str, dict[str, Any]] = {}
    for eng_id in ("paddleocr", "vietocr", "tesseract_vie"):
        info = raw_engines.get(eng_id)
        if isinstance(info, dict):
            engine_summary[eng_id] = {
                "status": str(info.get("status") or "UNKNOWN"),
                "detail_status": str(info.get("detail_status") or "unknown"),
                "installed": bool(info.get("installed", False)),
                "loaded": bool(info.get("loaded", False)),
                "inference_verified": bool(info.get("inference_verified", False)),
            }

    now_iso = datetime.now(timezone.utc).isoformat()
    return {
        "worker_id": str(payload.get("worker_id") or "hf-ocr-space")[:120],
        "hostname": "hf-space",
        "status": worker_status,
        "standby_mode": str(payload.get("standby_mode") or "quiet_standby")[:32],
        "online": online,
        "ready": ready and online,
        "last_heartbeat_at": now_iso,
        "age_seconds": 0.0,
        "active_job_count": max(0, int(payload.get("active_job_count") or 0)),
        "concurrency_limit": max(1, int(payload.get("concurrency_limit") or 1)),
        "model_profile": str(model_obj.get("profile") or "ORIGINAL")[:64],
        "model_sha256": str(model_obj.get("checkpoint_sha256") or "")[:64] or None,
        "app_version": str(payload.get("version") or "")[:64] or None,
        "git_sha": str(payload.get("git_sha") or "")[:64] or None,
        "engines": engine_summary,
    }


def peek_cached_remote_ocr_worker_health() -> tuple[bool, dict[str, Any] | None]:
    """Return `(cache_valid, cached_value)` without performing any network I/O."""
    base_url = get_configured_remote_ocr_worker_url()
    if not base_url or _HEALTH_CACHE is None:
        return False, None
    expires_at, cached_url, cached_val, _degraded = _HEALTH_CACHE
    if cached_url == base_url and time.monotonic() < expires_at:
        return True, (dict(cached_val) if cached_val is not None else None)
    return False, None


def peek_remote_ocr_probe_degraded() -> bool:
    """Return True when the most recent `/health` probe saw a waking/warming Space (5xx/timeout/ready=False)."""
    base_url = get_configured_remote_ocr_worker_url()
    if not base_url or _HEALTH_CACHE is None:
        return False
    _expires_at, cached_url, _cached_val, degraded = _HEALTH_CACHE
    return cached_url == base_url and bool(degraded)


async def probe_configured_remote_ocr_worker_health(
    *,
    force_refresh: bool = False,
    timeout_seconds: float = 4.0,
) -> dict[str, Any] | None:
    """Passively probe `<worker>/health` with a 60s RAM cache and zero DB permits held."""
    global _HEALTH_CACHE
    base_url = get_configured_remote_ocr_worker_url()
    if not base_url:
        return None

    if not force_refresh:
        valid, cached = peek_cached_remote_ocr_worker_health()
        if valid:
            return cached

    lock = _loop_health_lock()
    async with lock:
        if not force_refresh:
            valid, cached = peek_cached_remote_ocr_worker_health()
            if valid:
                return cached

        if not await _validate_production_target_dns(base_url):
            _HEALTH_CACHE = (time.monotonic() + 15.0, base_url, None, False)
            return None

        headers = {"Accept": "application/json", **_hf_space_bearer_headers()}
        ttl = _health_cache_ttl_seconds()
        parsed_snapshot: dict[str, Any] | None = None
        probe_degraded = False
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_seconds, connect=min(2.5, timeout_seconds)),
                follow_redirects=False,
                trust_env=False,
                transport=_CUSTOM_TRANSPORT,
            ) as client:
                resp = await client.get(f"{base_url}/health", headers=headers)
            if resp.status_code == 200:
                raw = resp.json()
                if isinstance(raw, dict):
                    parsed_snapshot = _normalize_remote_health_payload(raw)
                    probe_degraded = not bool(parsed_snapshot.get("ready"))
                else:
                    probe_degraded = True
            elif 300 <= resp.status_code < 400:
                logger.warning(
                    "Refusing HTTP %s redirect from VIREAD_OCR_REMOTE_WORKER_URL /health.",
                    resp.status_code,
                )
                probe_degraded = False
            elif resp.status_code in (401, 403, 404):
                probe_degraded = False
            else:
                # 502/503/504/429 (e.g. Hugging Face Space waking from 48h sleep)
                probe_degraded = True
        except Exception as exc:
            logger.debug("Passive remote OCR /health probe degraded: %s", type(exc).__name__)
            parsed_snapshot = None
            probe_degraded = True

        # Cache ready probes for full TTL (60s) and waking/negative probes briefly (10s)
        # so cold-booting Spaces transition to ready promptly without hammering HF.
        effective_ttl = (
            ttl
            if (parsed_snapshot is not None and parsed_snapshot.get("ready"))
            else min(10.0, ttl)
        )
        _HEALTH_CACHE = (
            time.monotonic() + effective_ttl,
            base_url,
            parsed_snapshot,
            probe_degraded,
        )
        return dict(parsed_snapshot) if parsed_snapshot is not None else None


async def send_remote_ocr_wakeup(
    *,
    reason: str = "job_enqueued",
    job_id: str | None = None,
    timeout_seconds: float = 8.0,
    bypass_coalesce: bool = False,
) -> bool:
    """Send authenticated `POST <worker>/wakeup` to wake Quiet Standby worker immediately."""
    global _LAST_WAKE_SENT, _LAST_WAKE_ATTEMPT_AT
    base_url = get_configured_remote_ocr_worker_url()
    if not base_url:
        return False
    worker_token = (os.getenv("VIREAD_OCR_WORKER_TOKEN") or "").strip()
    if len(worker_token) < 32:
        logger.debug("Skipping remote OCR /wakeup: VIREAD_OCR_WORKER_TOKEN not configured.")
        return False

    now_mono = time.monotonic()
    if (
        not bypass_coalesce
        and _LAST_WAKE_SENT is not None
        and _LAST_WAKE_SENT[0] == base_url
        and (now_mono - _LAST_WAKE_SENT[1]) < DEFAULT_WAKE_COALESCE_SECONDS
    ):
        return True

    if not await _validate_production_target_dns(base_url):
        return False

    _LAST_WAKE_ATTEMPT_AT = (base_url, now_mono)
    headers = {
        "Accept": "application/json",
        "X-ViRead-Ocr-Worker-Token": worker_token,
        **_hf_space_bearer_headers(),
    }
    body: dict[str, Any] = {"reason": str(reason)[:64]}
    if job_id:
        body["job_id"] = str(job_id)[:64]

    for attempt in range(2):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_seconds, connect=min(4.0, timeout_seconds)),
                follow_redirects=False,
                trust_env=False,
                transport=_CUSTOM_TRANSPORT,
            ) as client:
                resp = await client.post(f"{base_url}/wakeup", headers=headers, json=body)
            if resp.status_code == 200:
                _LAST_WAKE_SENT = (base_url, time.monotonic())
                return True
            if 300 <= resp.status_code < 400:
                logger.warning(
                    "Refusing HTTP %s redirect from VIREAD_OCR_REMOTE_WORKER_URL /wakeup.",
                    resp.status_code,
                )
                return False
            if resp.status_code in (401, 403, 404):
                logger.warning("Remote OCR /wakeup rejected with HTTP %s.", resp.status_code)
                return False
        except Exception as exc:
            logger.debug("Remote OCR /wakeup attempt %s error: %s", attempt + 1, type(exc).__name__)
        if attempt == 0:
            await asyncio.sleep(1.0)
    return False


async def _has_online_idle_cuda_worker() -> bool:
    """Check in a short read transaction whether an online, idle GPU worker is available."""
    from app.database.session import AsyncSessionLocal
    from app.models import OcrWorkerHeartbeat
    from app.services.ocr_inference_job_service import worker_heartbeat_ttl_seconds

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(seconds=worker_heartbeat_ttl_seconds())
    try:
        async with AsyncSessionLocal() as db:
            rows = list(
                (
                    await db.scalars(
                        select(OcrWorkerHeartbeat)
                        .where(OcrWorkerHeartbeat.LastHeartbeatAt >= cutoff)
                        .order_by(OcrWorkerHeartbeat.LastHeartbeatAt.desc())
                        .limit(10)
                    )
                ).all()
            )
    except Exception:
        return False

    for row in rows:
        status_upper = str(row.Status or "").upper()
        if status_upper != "IDLE" or int(row.ActiveJobCount or 0) > 0:
            continue
        stats = row.SystemStats if isinstance(row.SystemStats, dict) else {}
        if bool(stats.get("cuda_available")):
            return True
    return False


async def _is_job_still_queued(job_id: UUID) -> bool:
    from app.database.session import AsyncSessionLocal
    from app.models import OcrInferenceJob

    try:
        async with AsyncSessionLocal() as db:
            status_val = await db.scalar(
                select(OcrInferenceJob.Status).where(OcrInferenceJob.Id == job_id)
            )
        return status_val == "QUEUED"
    except Exception:
        return True


async def _dispatch_wakeup_with_hybrid_grace(
    job_ids: list[UUID],
    reason: str,
    *,
    session_factory_check_enabled: bool = True,
) -> bool:
    # Yield first so caller's db.commit() has completely released its DB concurrency permit.
    await asyncio.sleep(0)
    if not is_remote_worker_wakeup_configured():
        return False

    grace = _hybrid_gpu_grace_seconds()
    if (
        session_factory_check_enabled
        and len(job_ids) == 1
        and grace > 0.0
        and await _has_online_idle_cuda_worker()
    ):
        await asyncio.sleep(grace)
        if not await _is_job_still_queued(job_ids[0]):
            return False

    first_id = str(job_ids[0]) if job_ids else None
    return await send_remote_ocr_wakeup(reason=reason, job_id=first_id)


def trigger_ocr_wakeup_background(
    *,
    job_ids: list[UUID],
    reason: str = "job_enqueued",
    session_factory_check_enabled: bool = True,
) -> asyncio.Task[Any] | None:
    if not is_remote_worker_wakeup_configured():
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    task = loop.create_task(
        _dispatch_wakeup_with_hybrid_grace(
            list(job_ids),
            reason,
            session_factory_check_enabled=session_factory_check_enabled,
        ),
        name="remote_ocr_post_commit_wakeup",
    )
    _WAKEUP_TASKS.add(task)
    task.add_done_callback(_WAKEUP_TASKS.discard)
    return task


def schedule_post_commit_ocr_wakeup(
    db: Any,
    *,
    job_id: UUID,
    reason: str = "job_enqueued",
) -> None:
    """Register a post-commit hook on `db` so `/wakeup` fires only after COMMIT succeeds."""
    if not is_remote_worker_wakeup_configured():
        return

    sync_session = getattr(db, "sync_session", None)
    if isinstance(sync_session, Session):
        pending: list[UUID] = sync_session.info.setdefault("_pending_ocr_wake_jobs", [])
        if job_id not in pending:
            pending.append(job_id)
        sync_session.info["_pending_ocr_wake_reason"] = reason
        if sync_session.info.get("_ocr_wake_hook_registered"):
            return

        def _on_after_commit(sess: Session) -> None:
            committed_ids = list(sess.info.pop("_pending_ocr_wake_jobs", ()))
            wake_reason = str(sess.info.pop("_pending_ocr_wake_reason", reason))
            if committed_ids:
                trigger_ocr_wakeup_background(
                    job_ids=committed_ids,
                    reason=wake_reason,
                    session_factory_check_enabled=True,
                )

        def _on_after_rollback(sess: Session) -> None:
            sess.info.pop("_pending_ocr_wake_jobs", None)
            sess.info.pop("_pending_ocr_wake_reason", None)

        event.listen(sync_session, "after_commit", _on_after_commit)
        event.listen(sync_session, "after_rollback", _on_after_rollback)
        sync_session.info["_ocr_wake_hook_registered"] = True
        return

    # Support lightweight FakeAsyncSession test doubles that have async commit/rollback methods.
    commit_fn = getattr(db, "commit", None)
    rollback_fn = getattr(db, "rollback", None)
    if callable(commit_fn) and callable(rollback_fn):
        pending_fake: list[UUID] | None = getattr(db, "_pending_ocr_wake_jobs", None)
        if pending_fake is None:
            pending_fake = []
            setattr(db, "_pending_ocr_wake_jobs", pending_fake)
        if job_id not in pending_fake:
            pending_fake.append(job_id)
        setattr(db, "_pending_ocr_wake_reason", reason)

        if not getattr(db, "_ocr_wake_wrapped", False):
            orig_commit = commit_fn
            orig_rollback = rollback_fn

            async def _wrapped_commit(*args: Any, **kwargs: Any) -> Any:
                res = await orig_commit(*args, **kwargs)
                ids = list(getattr(db, "_pending_ocr_wake_jobs", ()))
                getattr(db, "_pending_ocr_wake_jobs", []).clear()
                wake_reason = str(getattr(db, "_pending_ocr_wake_reason", reason))
                if ids:
                    trigger_ocr_wakeup_background(
                        job_ids=ids,
                        reason=wake_reason,
                        session_factory_check_enabled=False,
                    )
                return res

            async def _wrapped_rollback(*args: Any, **kwargs: Any) -> Any:
                getattr(db, "_pending_ocr_wake_jobs", []).clear()
                return await orig_rollback(*args, **kwargs)

            setattr(db, "commit", _wrapped_commit)
            setattr(db, "rollback", _wrapped_rollback)
            setattr(db, "_ocr_wake_wrapped", True)


def maybe_nudge_ocr_wakeup_for_stale_queued_job(
    *,
    job_id: UUID | str | None,
    created_at: datetime | None,
    reason: str = "queued_poll_nudge",
    min_age_seconds: float = DEFAULT_STALE_QUEUED_MIN_AGE_SECONDS,
    retry_cooldown_seconds: float = DEFAULT_STALE_QUEUED_NUDGE_COOLDOWN_SECONDS,
    active_burst_suppress_seconds: float = DEFAULT_ACTIVE_BURST_SUPPRESS_SECONDS,
) -> asyncio.Task[Any] | None:
    """Self-heal cold-boot / transient-503 wakeups when an unclaimed QUEUED job is polled.

    Emits zero requests when no jobs are queued, when the job was just created
    (< min_age_seconds), when a 200 OK `/wakeup` was already confirmed within the
    worker's active burst window, or when a nudge was attempted within cooldown.
    """
    global _LAST_WAKE_ATTEMPT_AT
    base_url = get_configured_remote_ocr_worker_url()
    if not base_url:
        return None
    worker_token = (os.getenv("VIREAD_OCR_WORKER_TOKEN") or "").strip()
    if len(worker_token) < 32:
        return None

    if created_at is not None:
        created_utc = (
            created_at.replace(tzinfo=timezone.utc)
            if created_at.tzinfo is None
            else created_at.astimezone(timezone.utc)
        )
        age = (datetime.now(timezone.utc) - created_utc).total_seconds()
        if age < max(0.0, float(min_age_seconds)):
            return None

    now_mono = time.monotonic()
    if (
        _LAST_WAKE_SENT is not None
        and _LAST_WAKE_SENT[0] == base_url
        and (now_mono - _LAST_WAKE_SENT[1]) < max(5.0, float(active_burst_suppress_seconds))
    ):
        return None
    if (
        _LAST_WAKE_ATTEMPT_AT is not None
        and _LAST_WAKE_ATTEMPT_AT[0] == base_url
        and (now_mono - _LAST_WAKE_ATTEMPT_AT[1]) < max(2.0, float(retry_cooldown_seconds))
    ):
        return None

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None

    _LAST_WAKE_ATTEMPT_AT = (base_url, now_mono)
    task = loop.create_task(
        send_remote_ocr_wakeup(
            reason=reason,
            job_id=str(job_id) if job_id is not None else None,
            bypass_coalesce=True,
        ),
        name="remote_ocr_stale_queued_nudge",
    )
    _WAKEUP_TASKS.add(task)
    task.add_done_callback(_WAKEUP_TASKS.discard)
    return task


async def maybe_keep_warm_hf_space_from_cron(
    *,
    min_interval_seconds: float = DEFAULT_CRON_KEEPWARM_INTERVAL_SECONDS,
) -> bool:
    """Send at most one passive `/health` ping per 12h during `/internal/cron/dispatch`."""
    global _LAST_CRON_KEEPWARM_AT
    if not is_remote_worker_wakeup_configured():
        return False
    now_mono = time.monotonic()
    if (
        _LAST_CRON_KEEPWARM_AT > 0.0
        and (now_mono - _LAST_CRON_KEEPWARM_AT) < max(60.0, float(min_interval_seconds))
    ):
        return False
    snapshot = await probe_configured_remote_ocr_worker_health(force_refresh=True)
    if snapshot is not None:
        _LAST_CRON_KEEPWARM_AT = time.monotonic()
        return True
    return False


async def shutdown_remote_ocr_wakeup_tasks(*, timeout_seconds: float = 3.0) -> None:
    if not _WAKEUP_TASKS:
        return
    pending = [task for task in list(_WAKEUP_TASKS) if not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=timeout_seconds)
