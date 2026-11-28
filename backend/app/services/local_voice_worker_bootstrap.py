"""Auto-start and self-heal helper for the isolated Windows Local Voice Worker.

Ensures that starting the FastAPI backend directly in local Windows development
(e.g. `uvicorn app.sever:app --reload` or `start-dev.ps1`) automatically brings
up the loopback voice worker (`127.0.0.1:8010`) via the idempotent
`scripts/windows/Start-ViReadVoiceWorker.ps1` launcher when provisioned.

Never runs in tests, on Render/production, on non-Windows hosts, or when
`VIREAD_LOCAL_VOICE_WORKER_AUTOSTART=false` / `VIREAD_DISABLE_VOICE_AUTOSTART=true`.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, urlsplit

import httpx

from app.database.config import APP_ENVIRONMENT, REPOSITORY_ROOT, WORKSPACE_ROOT

logger = logging.getLogger("viread.local_voice_bootstrap")

DEFAULT_LOCAL_VOICE_WORKER_URL = "http://127.0.0.1:8010"
_FAILURE_COOLDOWN_SECONDS = 30.0
_HEALTH_TIMEOUT_SECONDS = 1.5
_STARTUP_TIMEOUT_SECONDS = 90

_autostart_armed = False
_bootstrap_lock: asyncio.Lock | None = None
_bootstrap_lock_loop: asyncio.AbstractEventLoop | None = None
_last_failed_attempt_monotonic: float | None = None


def arm_local_voice_worker_autostart(armed: bool = True) -> None:
    """Arm on-demand recovery only for real backend server lifecycles (never unit tests)."""
    global _autostart_armed
    _autostart_armed = armed


def is_local_voice_worker_autostart_armed() -> bool:
    return _autostart_armed


def reset_local_voice_worker_bootstrap_state() -> None:
    """Reset module state for isolated unit tests."""
    global _autostart_armed, _bootstrap_lock, _bootstrap_lock_loop, _last_failed_attempt_monotonic
    _autostart_armed = False
    _bootstrap_lock = None
    _bootstrap_lock_loop = None
    _last_failed_attempt_monotonic = None


def _get_lock() -> asyncio.Lock:
    global _bootstrap_lock, _bootstrap_lock_loop
    loop = asyncio.get_running_loop()
    if _bootstrap_lock is None or _bootstrap_lock_loop is not loop:
        _bootstrap_lock = asyncio.Lock()
        _bootstrap_lock_loop = loop
    return _bootstrap_lock


def _resolve_base_url(base_url: str | None = None) -> str:
    raw = (
        base_url
        if base_url is not None
        else os.getenv("VIREAD_LOCAL_VOICE_WORKER_URL", DEFAULT_LOCAL_VOICE_WORKER_URL)
    )
    return raw.strip().rstrip("/") or DEFAULT_LOCAL_VOICE_WORKER_URL


def _resolve_worker_token() -> str:
    return (
        os.getenv("VIREAD_VOICE_WORKER_TOKEN")
        or os.getenv("VIREAD_LOCAL_VOICE_WORKER_TOKEN")
        or ""
    ).strip()


def _resolve_voice_runtime_dir() -> Path:
    raw = (os.getenv("VIREAD_VOICE_RUNTIME_DIR") or "").strip()
    if raw:
        return Path(raw)
    return WORKSPACE_ROOT / "tools" / "voice-runtime"


def _resolve_start_script_path() -> Path:
    return REPOSITORY_ROOT / "scripts" / "windows" / "Start-ViReadVoiceWorker.ps1"


def _is_truthy_render_env(raw: str | None) -> bool:
    if raw is None:
        return False
    return raw.strip().lower() not in {"", "0", "false", "no", "off"}


def _is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    cleaned = host.strip().lower().strip("[]").rstrip(".")
    if not cleaned:
        return False
    if cleaned == "localhost" or cleaned.endswith(".localhost"):
        return True
    try:
        ip = ipaddress.ip_address(cleaned)
    except ValueError:
        return False
    return bool(
        ip.is_loopback
        or ip.is_unspecified
        or (ip.ipv4_mapped is not None and ip.ipv4_mapped.is_loopback)
    )


def _is_loopback_url(url: str | None) -> bool:
    if not url or not url.strip():
        return False
    try:
        parsed = urlsplit(url.strip())
    except ValueError:
        return False
    return _is_loopback_host(parsed.hostname)


def _is_production_or_render() -> bool:
    if _is_truthy_render_env(os.getenv("RENDER")):
        return True
    app_env = (os.getenv("APP_ENVIRONMENT") or APP_ENVIRONMENT or "").strip().lower()
    return app_env == "production"


def parse_loopback_worker_endpoint(base_url: str) -> tuple[str, int] | None:
    """Return `(bind_host, port)` if `base_url` is a local loopback HTTP endpoint."""
    parsed = urlparse(base_url)
    if parsed.scheme != "http":
        return None
    hostname = (parsed.hostname or "").strip().lower()
    if hostname not in {"127.0.0.1", "localhost"}:
        return None
    try:
        port = parsed.port or 80
    except ValueError:
        return None
    if not 1 <= port <= 65535:
        return None
    bind_host = "127.0.0.1" if hostname == "localhost" else hostname
    return bind_host, port


def should_autostart_local_voice_worker(
    *,
    base_url: str | None = None,
    platform_name: str | None = None,
    app_environment: str | None = None,
    render_env: str | None = None,
    autostart_env: str | None = None,
    runtime_dir: Path | None = None,
    start_script_path: Path | None = None,
) -> tuple[bool, str]:
    """Check whether auto-starting the Windows local voice worker is allowed and provisioned."""
    eff_platform = sys.platform if platform_name is None else platform_name
    if eff_platform != "win32":
        return False, "non_windows_host"

    eff_env = (APP_ENVIRONMENT if app_environment is None else app_environment).strip().lower()
    if eff_env in {"test", "production"}:
        return False, f"app_environment_{eff_env}"

    eff_render = os.getenv("RENDER", "") if render_env is None else render_env
    if _is_truthy_render_env(eff_render):
        return False, "render_environment"

    if autostart_env is None:
        disable_flag = os.getenv("VIREAD_DISABLE_VOICE_AUTOSTART", "").strip().lower()
        if disable_flag in {"1", "true", "yes", "on"}:
            return False, "autostart_disabled"
        eff_autostart = os.getenv("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "true")
    else:
        eff_autostart = autostart_env
    if eff_autostart.strip().lower() in {"0", "false", "no", "off"}:
        return False, "autostart_disabled"

    if app_environment is None and os.getenv("APP_ENVIRONMENT", "").strip().lower() in {"test", "production"}:
        return False, f"app_environment_{os.getenv('APP_ENVIRONMENT', '').strip().lower()}"

    resolved_url = _resolve_base_url(base_url)
    if parse_loopback_worker_endpoint(resolved_url) is None:
        return False, "non_loopback_worker_url"

    eff_script = _resolve_start_script_path() if start_script_path is None else start_script_path
    if not eff_script.is_file():
        return False, "start_script_missing"

    eff_runtime = _resolve_voice_runtime_dir() if runtime_dir is None else runtime_dir
    python_exe = eff_runtime / ".venv" / "Scripts" / "python.exe"
    if not python_exe.is_file():
        return False, "voice_runtime_not_provisioned"

    return True, "eligible"


async def _is_worker_healthy(base_url: str) -> bool:
    if not base_url or (_is_production_or_render() and _is_loopback_url(base_url)):
        return False
    worker_token = _resolve_worker_token()
    headers = (
        {
            "Authorization": f"Bearer {worker_token}",
            "X-ViRead-Voice-Token": worker_token,
        }
        if worker_token
        else None
    )
    try:
        async with httpx.AsyncClient(
            timeout=_HEALTH_TIMEOUT_SECONDS, trust_env=False
        ) as client:
            resp = await client.get(f"{base_url}/health", headers=headers)
        if resp.status_code != 200:
            return False
        payload = resp.json()
        if not isinstance(payload, dict) or payload.get("status") != "ok":
            return False
        if bool(payload.get("auth_required")) and not worker_token:
            return False
        return True
    except Exception:
        return False


def _terminate_bootstrap_process(proc: object) -> None:
    """Terminate an unfinished PowerShell bootstrap launcher cleanly on stop/timeout."""
    poll = getattr(proc, "poll", None)
    if callable(poll):
        try:
            if poll() is not None:
                return
        except Exception:
            pass
    terminate = getattr(proc, "terminate", None)
    if callable(terminate):
        try:
            terminate()
        except Exception:
            pass
    wait = getattr(proc, "wait", None)
    if callable(wait):
        try:
            wait(timeout=2.0)
            return
        except Exception:
            pass
    kill = getattr(proc, "kill", None)
    if callable(kill):
        try:
            kill()
        except Exception:
            pass


async def ensure_local_voice_worker_running(
    *,
    base_url: str | None = None,
    stop_event: asyncio.Event | None = None,
    force: bool = False,
) -> bool:
    """Ensure the local loopback voice worker is healthy; start it via PowerShell if needed."""
    global _last_failed_attempt_monotonic

    resolved_url = _resolve_base_url(base_url)
    # Check autostart eligibility BEFORE dialing /health so non-Windows/Render/disabled
    # deployments never burn 1.5s probing unreachable loopback on startup.
    eligible, reason = should_autostart_local_voice_worker(base_url=resolved_url)
    if not eligible:
        logger.debug(
            "Local voice worker auto-start skipped (reason=%s url=%s)",
            reason,
            resolved_url,
        )
        return False

    if await _is_worker_healthy(resolved_url):
        return True

    lock = _get_lock()
    async with lock:
        if stop_event is not None and stop_event.is_set():
            return False
        if await _is_worker_healthy(resolved_url):
            return True

        now = time.monotonic()
        if (
            not force
            and _last_failed_attempt_monotonic is not None
            and (now - _last_failed_attempt_monotonic) < _FAILURE_COOLDOWN_SECONDS
        ):
            return False

        endpoint = parse_loopback_worker_endpoint(resolved_url)
        if endpoint is None:
            return False
        bind_host, port = endpoint
        runtime_dir = _resolve_voice_runtime_dir()
        start_script = _resolve_start_script_path()

        logger.info(
            "Local voice worker unreachable on %s; starting via Start-ViReadVoiceWorker.ps1...",
            resolved_url,
        )
        creationflags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
        cmd = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(start_script),
            "-VoiceRuntimeDir",
            str(runtime_dir),
            "-BindHost",
            bind_host,
            "-Port",
            str(port),
            "-StartupTimeoutSeconds",
            str(_STARTUP_TIMEOUT_SECONDS),
            "-ReplaceIncompatibleWorker",
        ]

        # Never attach stdout/stderr pipes here: on Windows, detached child workers
        # started by Start-ViReadVoiceWorker.ps1 can inherit pipe handles and block
        # subprocess exit/uvicorn --reload indefinitely. Logs go to voice-runtime/logs.
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(start_script.parent),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                creationflags=creationflags,
            )
        except Exception as exc:
            _last_failed_attempt_monotonic = time.monotonic()
            logger.warning(
                "Failed to launch Start-ViReadVoiceWorker.ps1 (%s)",
                type(exc).__name__,
            )
            return False

        deadline = time.monotonic() + _STARTUP_TIMEOUT_SECONDS + 5
        try:
            while time.monotonic() < deadline:
                if stop_event is not None and stop_event.is_set():
                    _terminate_bootstrap_process(proc)
                    return False
                if await _is_worker_healthy(resolved_url):
                    _last_failed_attempt_monotonic = None
                    logger.info("Local voice worker is ready on %s", resolved_url)
                    return True
                exit_code = proc.poll()
                if exit_code is not None:
                    if exit_code == 0 and await _is_worker_healthy(resolved_url):
                        _last_failed_attempt_monotonic = None
                        logger.info("Local voice worker is ready on %s", resolved_url)
                        return True
                    _last_failed_attempt_monotonic = time.monotonic()
                    logger.warning(
                        "Local voice worker startup exited early (exit_code=%s). Check %s",
                        exit_code,
                        runtime_dir / "logs" / "voice-worker.stderr.log",
                    )
                    return False
                if stop_event is not None:
                    try:
                        await asyncio.wait_for(stop_event.wait(), timeout=0.5)
                        _terminate_bootstrap_process(proc)
                        return False
                    except TimeoutError:
                        pass
                else:
                    await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            _terminate_bootstrap_process(proc)
            raise

        _terminate_bootstrap_process(proc)
        _last_failed_attempt_monotonic = time.monotonic()
        logger.warning(
            "Timed out waiting for local voice worker readiness on %s. Check %s",
            resolved_url,
            runtime_dir / "logs" / "voice-worker.stderr.log",
        )
        return False
