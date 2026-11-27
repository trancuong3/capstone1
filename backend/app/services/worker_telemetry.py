"""Lightweight in-process and DB-persisted worker liveness & error telemetry (zero ML imports)."""
from __future__ import annotations

import asyncio
import inspect
import logging
import threading
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_TELEMETRY: dict[str, dict[str, Any]] = {}


def _safe_error_label(exc_or_code: BaseException | str) -> str:
    if isinstance(exc_or_code, BaseException):
        label = getattr(exc_or_code, "code", None) or type(exc_or_code).__name__
    else:
        label = str(exc_or_code)
    cleaned = "".join(
        ch if (ch.isalnum() or ch in {"_", "-", "."}) else "_"
        for ch in str(label).strip()
    )
    return (cleaned or "UNKNOWN_ERROR")[:64]


def _safe_token(value: str, *, default: str, max_len: int = 64) -> str:
    cleaned = "".join(
        ch if (ch.isalnum() or ch in {"_", "-", "."}) else "_"
        for ch in str(value or "").strip()
    )
    return (cleaned or default)[:max_len]


def _format_utc_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            dt = parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat()
        except ValueError:
            return raw
    return str(value)


def _is_sqlite_session(db: Any) -> bool:
    for candidate in (db, getattr(db, "sync_session", None)):
        if candidate is None:
            continue
        bind = getattr(candidate, "bind", None)
        if bind is None:
            get_bind = getattr(candidate, "get_bind", None)
            if callable(get_bind):
                try:
                    bind = get_bind()
                except Exception:
                    bind = None
        dialect = getattr(bind, "dialect", None)
        name = getattr(dialect, "name", None)
        if isinstance(name, str) and name.lower() == "sqlite":
            return True
    return False


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _safe_rollback(db: Any) -> None:
    rollback_fn = getattr(db, "rollback", None)
    if callable(rollback_fn):
        try:
            await _maybe_await(rollback_fn())
        except Exception:
            pass


def record_worker_success(worker_id: str, *, at: datetime | None = None) -> None:
    now = at or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    with _LOCK:
        entry = _TELEMETRY.setdefault(worker_id, {})
        entry["last_success_at"] = now
        entry["last_error"] = None


def record_worker_error(
    worker_id: str, exc_or_code: BaseException | str, *, at: datetime | None = None
) -> None:
    now = at or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    label = _safe_error_label(exc_or_code)
    with _LOCK:
        entry = _TELEMETRY.setdefault(worker_id, {})
        entry["last_error"] = label
        entry["last_error_at"] = now


def get_worker_telemetry(worker_id: str) -> dict[str, Any]:
    with _LOCK:
        entry = _TELEMETRY.get(worker_id)
        if not entry:
            return {"last_success_at": None, "last_error": None}
        return {
            "last_success_at": entry.get("last_success_at"),
            "last_error": entry.get("last_error"),
        }


def clear_worker_telemetry() -> None:
    with _LOCK:
        _TELEMETRY.clear()


def _upsert_heartbeat_sql(table_name: str) -> str:
    return f"""
        INSERT INTO {table_name} (
            worker_key,
            execution_mode,
            last_run_at,
            last_success_at,
            last_error_at,
            last_error_code,
            last_items_processed,
            last_source,
            updated_at
        )
        VALUES (
            :worker_key,
            :execution_mode,
            :last_run_at,
            :last_success_at,
            :last_error_at,
            :last_error_code,
            :last_items_processed,
            :last_source,
            :updated_at
        )
        ON CONFLICT (worker_key) DO UPDATE SET
            execution_mode = EXCLUDED.execution_mode,
            last_run_at = EXCLUDED.last_run_at,
            last_success_at = COALESCE(
                EXCLUDED.last_success_at,
                system_worker_heartbeats.last_success_at
            ),
            last_error_at = COALESCE(
                EXCLUDED.last_error_at,
                system_worker_heartbeats.last_error_at
            ),
            last_error_code = EXCLUDED.last_error_code,
            last_items_processed = EXCLUDED.last_items_processed,
            last_source = EXCLUDED.last_source,
            updated_at = EXCLUDED.updated_at
    """


async def persist_worker_heartbeat(
    db: AsyncSession,
    worker_id: str,
    *,
    execution_mode: str,
    ok: bool,
    items_processed: int = 0,
    source: str = "cron",
    error_code: str | None = None,
) -> None:
    """Persist a worker's execution heartbeat to `system_worker_heartbeats` (fail-safe no-op)."""
    if db is None:
        return
    execute_fn = getattr(db, "execute", None)
    if not callable(execute_fn):
        return

    now = datetime.now(timezone.utc)
    safe_worker_key = _safe_token(worker_id, default="unknown_worker")
    safe_mode = _safe_token(execution_mode, default="cron_scheduled")
    safe_source = _safe_token(source, default="cron")
    safe_items = max(0, int(items_processed or 0))
    safe_err = None if ok else _safe_error_label(error_code or "UNKNOWN_ERROR")

    is_sqlite = _is_sqlite_session(db)
    tables = (
        ("system_worker_heartbeats",)
        if is_sqlite
        else ("public.system_worker_heartbeats", "system_worker_heartbeats")
    )

    for table_name in tables:
        use_iso_params = is_sqlite or table_name == "system_worker_heartbeats"
        ts_val: Any = now.isoformat() if use_iso_params else now
        params = {
            "worker_key": safe_worker_key,
            "execution_mode": safe_mode,
            "last_run_at": ts_val,
            "last_success_at": ts_val if ok else None,
            "last_error_at": None if ok else ts_val,
            "last_error_code": safe_err,
            "last_items_processed": safe_items,
            "last_source": safe_source,
            "updated_at": ts_val,
        }
        try:
            res = execute_fn(text(_upsert_heartbeat_sql(table_name)), params)
            if inspect.isawaitable(res):
                await res
            commit_fn = getattr(db, "commit", None)
            if callable(commit_fn):
                await _maybe_await(commit_fn())
            return
        except asyncio.CancelledError:
            raise
        except Exception:
            await _safe_rollback(db)
            continue


async def read_persisted_worker_heartbeats(
    db: AsyncSession,
) -> dict[str, dict[str, Any]]:
    """Read all persisted worker heartbeats in 1 SELECT (fail-safe `{}` if table absent)."""
    if db is None:
        return {}
    execute_fn = getattr(db, "execute", None)
    if not callable(execute_fn):
        return {}

    is_sqlite = _is_sqlite_session(db)
    tables = (
        ("system_worker_heartbeats",)
        if is_sqlite
        else ("public.system_worker_heartbeats", "system_worker_heartbeats")
    )

    for table_name in tables:
        try:
            raw_res = execute_fn(
                text(
                    f"""
                    SELECT
                        worker_key,
                        execution_mode,
                        last_run_at,
                        last_success_at,
                        last_error_at,
                        last_error_code,
                        last_items_processed,
                        last_source,
                        updated_at
                    FROM {table_name}
                    """
                )
            )
            if not inspect.isawaitable(raw_res):
                return {}
            result = await raw_res
            rows = result.mappings().all()
            heartbeats: dict[str, dict[str, Any]] = {}
            for row in rows:
                key = str(row.get("worker_key") or "").strip()
                if not key:
                    continue
                heartbeats[key] = {
                    "execution_mode": str(row.get("execution_mode") or ""),
                    "last_run_at": _format_utc_iso(row.get("last_run_at")),
                    "last_success_at": _format_utc_iso(row.get("last_success_at")),
                    "last_error_at": _format_utc_iso(row.get("last_error_at")),
                    "last_error_code": (
                        str(row["last_error_code"])
                        if row.get("last_error_code") is not None
                        else None
                    ),
                    "last_items_processed": int(row.get("last_items_processed") or 0),
                    "last_source": (
                        str(row["last_source"])
                        if row.get("last_source") is not None
                        else None
                    ),
                    "updated_at": _format_utc_iso(row.get("updated_at")),
                }
            return heartbeats
        except asyncio.CancelledError:
            raise
        except Exception:
            await _safe_rollback(db)
            continue
    return {}


async def persist_worker_heartbeat_with_factory(
    session_factory: Any,
    worker_id: str,
    *,
    execution_mode: str,
    ok: bool,
    items_processed: int = 0,
    source: str = "cron",
    error_code: str | None = None,
    timeout_seconds: float = 2.0,
) -> None:
    """Best-effort bounded helper opening a short-lived session to persist a heartbeat."""
    if not callable(session_factory):
        return

    async def _write() -> None:
        async with session_factory() as hb_db:
            exec_attr = getattr(hb_db, "execute", None)
            if not callable(exec_attr) or not inspect.iscoroutinefunction(exec_attr):
                # Avoid failing or leaving unawaited coroutines on bare MagicMock sessions
                return
            await persist_worker_heartbeat(
                hb_db,
                worker_id,
                execution_mode=execution_mode,
                ok=ok,
                items_processed=items_processed,
                source=source,
                error_code=error_code,
            )

    try:
        await asyncio.wait_for(_write(), timeout=max(0.2, float(timeout_seconds)))
    except asyncio.CancelledError:
        raise
    except Exception:
        return
