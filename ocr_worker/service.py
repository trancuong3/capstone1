from __future__ import annotations

import asyncio
import ctypes
import gc
import hashlib
import hmac
import importlib.util
import io
import logging
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any, Callable
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
import yaml
from fastapi import Body, FastAPI, Header, HTTPException, Query, status
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel, Field

from ocr_worker import __version__

logger = logging.getLogger("ocr_worker.service")

EXPECTED_FLOW1_TRDG_SHA256 = (
    "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6"
)
ORIGINAL_VIETOCR_SHA256 = (
    "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"
)
DEFAULT_PREBAKED_MODEL_DIR = "/home/user/viread-models"
_TRUTHY_VALUES = {"1", "true", "yes", "on"}
_VERIFIED_FILE_SHA256_CACHE: dict[tuple[str, int, int], str] = {}
_VERIFIED_FILE_SHA256_LOCK = threading.Lock()


def is_scale_to_zero_enabled() -> bool:
    """Return True when the OCR worker runs in serverless scale-to-zero mode (ACA / Cloud Run)."""
    return (os.getenv("VIREAD_OCR_SCALE_TO_ZERO") or "").strip().lower() in _TRUTHY_VALUES


def should_skip_startup_smoke(*, prebaked_hit: bool) -> bool:
    """Skip cold-boot synthetic OCR smoke only when opted in AND pre-baked SHA-256 matched."""
    if not prebaked_hit:
        return False
    return (os.getenv("VIREAD_OCR_SKIP_STARTUP_SMOKE") or "").strip().lower() in _TRUTHY_VALUES

BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
IDLE_PRIORITY_CLASS = 0x00000040
NORMAL_PRIORITY_CLASS = 0x00000020
ABOVE_NORMAL_PRIORITY_CLASS = 0x00008000
HIGH_PRIORITY_CLASS = 0x00000080


def configure_cpu_thread_caps() -> int:
    """Apply conservative CPU BLAS/OpenMP thread caps before importing ML runtimes."""
    raw = (os.getenv("VIREAD_OCR_CPU_THREADS") or "2").strip()
    try:
        threads = max(1, min(4, int(raw)))
    except ValueError:
        threads = 2
    for key in (
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "BLIS_NUM_THREADS",
        "FLAGS_omp_num_threads",
    ):
        os.environ.setdefault(key, str(threads))
    return threads


CPU_THREADS = configure_cpu_thread_caps()


def _kernel32_handle():
    kernel32 = ctypes.windll.kernel32
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.SetPriorityClass.restype = ctypes.c_int
    kernel32.GetPriorityClass.argtypes = [ctypes.c_void_p]
    kernel32.GetPriorityClass.restype = ctypes.c_uint32
    return kernel32, kernel32.GetCurrentProcess()


def set_windows_below_normal_priority() -> dict[str, Any]:
    """Ensure the OCR worker runs at BelowNormal priority so Voice Worker preempts it."""
    if sys.platform != "win32":
        return {"supported": False, "priority_class": "unsupported"}
    try:
        kernel32, handle = _kernel32_handle()
        ok = bool(kernel32.SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS))
        actual = int(kernel32.GetPriorityClass(handle))
        return {
            "supported": True,
            "applied": ok,
            "priority_class": _decode_win_priority(actual),
        }
    except Exception as exc:
        return {"supported": True, "applied": False, "error": type(exc).__name__}


def get_windows_priority_name() -> str:
    if sys.platform != "win32":
        return "posix"
    try:
        kernel32, handle = _kernel32_handle()
        actual = int(kernel32.GetPriorityClass(handle))
        return _decode_win_priority(actual)
    except Exception:
        return "unknown"


def _decode_win_priority(val: int) -> str:
    mapping = {
        IDLE_PRIORITY_CLASS: "Idle",
        BELOW_NORMAL_PRIORITY_CLASS: "BelowNormal",
        NORMAL_PRIORITY_CLASS: "Normal",
        ABOVE_NORMAL_PRIORITY_CLASS: "AboveNormal",
        HIGH_PRIORITY_CLASS: "High",
    }
    return mapping.get(val, hex(val))


def ensure_backend_on_sys_path() -> Path:
    repo_root = Path(__file__).resolve().parents[1]
    backend_dir = repo_root / "backend"
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))
    return backend_dir


def resolve_model_cache_dir() -> Path:
    """Resolve writable directory for verified VietOCR checkpoints and configs."""
    explicit = (os.getenv("VIREAD_OCR_MODEL_CACHE_DIR") or "").strip()
    if explicit:
        candidate = Path(explicit)
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            if os.access(candidate, os.W_OK):
                return candidate
        except OSError as exc:
            logger.warning(
                "Could not initialize VIREAD_OCR_MODEL_CACHE_DIR (%s); falling back to tempdir.",
                type(exc).__name__,
            )
    tmp_models = Path(tempfile.gettempdir()) / "viread-models"
    try:
        tmp_models.mkdir(parents=True, exist_ok=True)
        if os.access(tmp_models, os.W_OK):
            return tmp_models
    except OSError:
        pass
    return Path(tempfile.gettempdir())


def candidate_prebaked_model_dirs() -> list[Path]:
    """Ordered directories searched for pre-baked or previously synced checkpoints."""
    dirs: list[Path] = []
    for raw_dir in (
        os.getenv("VIREAD_OCR_PREBAKED_MODEL_DIR") or DEFAULT_PREBAKED_MODEL_DIR,
        str(resolve_model_cache_dir()),
        os.getenv("VIREAD_OCR_MODEL_CACHE_DIR") or "",
        tempfile.gettempdir(),
    ):
        clean = str(raw_dir).strip()
        if not clean:
            continue
        p = Path(clean)
        if p not in dirs and p.is_dir():
            dirs.append(p)
    return dirs


def _resolve_cdn_artifact_url(
    raw_url: str | None,
    *,
    expected_sha: str,
    suffix: str,
) -> str | None:
    clean = (raw_url or "").strip()
    if not clean:
        return None
    expanded = clean.replace("{sha256}", expected_sha)
    parsed = urlsplit(expanded)
    if (parsed.scheme or "").lower() not in ("https", "http") or not parsed.hostname:
        return None
    path_lower = (parsed.path or "").lower()
    basename = os.path.basename(path_lower)
    embedded_sha = re.search(r"([0-9a-f]{64})", basename)
    if embedded_sha and embedded_sha.group(1) != expected_sha.lower():
        # Pinned CDN URL targets a different checkpoint SHA (e.g. after a Flow 2 promotion);
        # skip cleanly so worker falls back to active-model shards.
        return None
    if path_lower.endswith(".pth") or path_lower.endswith(".yml"):
        if suffix == ".yml" and path_lower.endswith(".pth"):
            prefix_len = len(parsed.path) - 4
            rebuilt_path = parsed.path[:prefix_len] + ".yml"
            query_part = f"?{parsed.query}" if parsed.query else ""
            return f"{parsed.scheme}://{parsed.netloc}{rebuilt_path}{query_part}"
        if path_lower.endswith(suffix):
            return expanded
        return None
    base_clean = expanded.rstrip("/")
    return f"{base_clean}/viread-vietocr-v2-{expected_sha}{suffix}"


def _cdn_request_headers(url: str) -> dict[str, str]:
    """Attach optional HF read token ONLY to Hugging Face hosts; never leak worker token."""
    headers: dict[str, str] = {}
    hf_token = (
        os.getenv("VIREAD_HF_MODEL_TOKEN")
        or os.getenv("HF_READ_TOKEN")
        or ""
    ).strip()
    if not hf_token:
        return headers
    host = (urlsplit(url).hostname or "").lower().rstrip(".")
    if host == "huggingface.co" or host.endswith(".huggingface.co") or host.endswith(".hf.co"):
        headers["Authorization"] = f"Bearer {hf_token}"
    return headers


def _download_verified_cdn_file(
    url: str,
    *,
    expected_sha: str | None,
    dst_dir: Path,
    dst_filename: str,
    transport: httpx.BaseTransport | None = None,
) -> tuple[Path | None, bool]:
    """Download an artifact from CDN, verifying SHA-256 on the fly before atomic rename.

    Returns `(final_path, sha_mismatch_detected)`.
    """
    dst_path = dst_dir / dst_filename
    tmp_path = dst_dir / f"{dst_filename}.{uuid4().hex[:8]}.cdn.tmp"
    headers = _cdn_request_headers(url)
    try:
        with httpx.Client(
            timeout=httpx.Timeout(180.0, connect=15.0),
            follow_redirects=True,
            trust_env=False,
            transport=transport,
        ) as client:
            with client.stream("GET", url, headers=headers) as resp:
                if resp.status_code != 200:
                    return None, False
                digest = hashlib.sha256()
                with tmp_path.open("wb") as out:
                    for chunk in resp.iter_bytes(chunk_size=262144):
                        if chunk:
                            digest.update(chunk)
                            out.write(chunk)
        actual_sha = digest.hexdigest()
        if expected_sha and actual_sha != expected_sha.lower():
            logger.warning("Rejected CDN OCR artifact (%s): SHA-256 mismatch.", dst_filename)
            tmp_path.unlink(missing_ok=True)
            return None, True
        os.replace(tmp_path, dst_path)
        return dst_path, False
    except Exception as exc:
        logger.warning("CDN OCR artifact fetch skipped (%s): %s", dst_filename, type(exc).__name__)
        return None, False
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


def install_vietocr_safe_config_loader() -> None:
    """Ensure VietOCR loads vendored YAML configs first and never hangs on vocr.vn."""
    try:
        import requests
        import vietocr.tool.config as vietocr_cfg_mod
        import vietocr.tool.utils as vietocr_utils_mod
    except Exception:
        return
    if getattr(vietocr_cfg_mod, "_viread_worker_safe_cfg_installed", False):
        return

    vendored_dir = Path(__file__).resolve().parent / "configs"

    def _safe_download_config(config_id: str) -> dict[str, Any]:
        clean_name = os.path.basename(str(config_id or "").strip())
        local_candidate = vendored_dir / clean_name
        if clean_name and local_candidate.is_file():
            loaded = yaml.safe_load(local_candidate.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                return loaded
        urls = (
            f"https://vocr.vn/data/vietocr/config/{config_id}",
            f"https://raw.githubusercontent.com/pbcquoc/vietocr/master/config/{config_id}",
        )
        last_exc: Exception | None = None
        for url in urls:
            try:
                resp = requests.get(url, timeout=(5, 15))
                resp.raise_for_status()
                loaded = yaml.safe_load(resp.text)
                if isinstance(loaded, dict):
                    return loaded
            except Exception as exc:
                last_exc = exc
        if last_exc is not None:
            raise last_exc
        raise RuntimeError(f"Unable to load VietOCR config: {config_id}")

    def _safe_download_weights(
        uri: str, cached: str | None = None, md5: str | None = None, quiet: bool = False
    ) -> str:
        del cached, md5, quiet
        if not str(uri).startswith(("http://", "https://")):
            return uri
        cache_dir = resolve_model_cache_dir()
        filename = str(uri).rstrip("/").split("/")[-1] or "vgg_transformer.pth"
        full_path = cache_dir / filename
        if full_path.is_file() and full_path.stat().st_size > 0:
            return str(full_path)
        tmp_path = cache_dir / f"{filename}.{uuid4().hex[:8]}.downloading"
        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                with requests.get(uri, stream=True, timeout=(10, 120)) as resp:
                    resp.raise_for_status()
                    with tmp_path.open("wb") as out:
                        for chunk in resp.iter_content(chunk_size=65536):
                            if chunk:
                                out.write(chunk)
                os.replace(tmp_path, full_path)
                return str(full_path)
            except Exception as exc:
                last_exc = exc
                if tmp_path.exists():
                    tmp_path.unlink(missing_ok=True)
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
        assert last_exc is not None
        raise last_exc

    vietocr_utils_mod.download_config = _safe_download_config
    vietocr_cfg_mod.download_config = _safe_download_config
    vietocr_utils_mod.download_weights = _safe_download_weights
    vietocr_cfg_mod._viread_worker_safe_cfg_installed = True


def install_zero_db_config_shim() -> None:
    """Prevent ocr_engine from loading DB/Supabase secrets in the standalone worker."""
    ensure_backend_on_sys_path()
    for scrub_key in (
        "DATABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SECRET_KEY",
        "SUPABASE_KEY",
    ):
        os.environ.pop(scrub_key, None)

    def _is_supabase_jwt_key(api_key: str | None) -> bool:
        clean = (api_key or "").strip()
        return clean.count(".") == 2 and not clean.startswith("sb_")

    def _make_admin_headers(cfg_mod: Any):
        def _supabase_admin_headers(
            api_key: str | None = None,
            *,
            extra: dict[str, str] | None = None,
        ) -> dict[str, str]:
            key = (
                (api_key if api_key is not None else getattr(cfg_mod, "SUPABASE_ADMIN_KEY", None))
                or ""
            ).strip()
            headers: dict[str, str] = {"apikey": key}
            if _is_supabase_jwt_key(key):
                headers["Authorization"] = f"Bearer {key}"
            if extra:
                headers.update(extra)
            return headers

        return _supabase_admin_headers

    existing_cfg = sys.modules.get("app.database.config")
    if existing_cfg is not None:
        if not hasattr(existing_cfg, "is_supabase_jwt_key"):
            existing_cfg.is_supabase_jwt_key = _is_supabase_jwt_key  # type: ignore[attr-defined]
        if not hasattr(existing_cfg, "supabase_admin_headers"):
            existing_cfg.supabase_admin_headers = _make_admin_headers(existing_cfg)  # type: ignore[attr-defined]
        return

    if "app" not in sys.modules:
        app_pkg = ModuleType("app")
        app_pkg.__path__ = [str(ensure_backend_on_sys_path() / "app")]
        sys.modules["app"] = app_pkg
    if "app.database" not in sys.modules:
        db_pkg = ModuleType("app.database")
        db_pkg.__path__ = [str(ensure_backend_on_sys_path() / "app" / "database")]
        sys.modules["app.database"] = db_pkg

    cfg = ModuleType("app.database.config")
    cfg.APP_ENVIRONMENT = os.getenv("APP_ENVIRONMENT", "worker").strip() or "worker"
    cfg.SUPABASE_URL = None
    cfg.SUPABASE_SECRET_KEY = None
    cfg.SUPABASE_SERVICE_ROLE_KEY = None
    cfg.SUPABASE_ADMIN_KEY = None
    cfg.SUPABASE_KEY = None
    cfg.SUPABASE_STORAGE_BUCKET = None
    cfg.SUPABASE_AVATAR_BUCKET = None
    cfg.SUPABASE_PRIVATE_BOOKS_BUCKET = None
    cfg.DATABASE_URL = None
    cfg.is_supabase_jwt_key = _is_supabase_jwt_key
    cfg.supabase_admin_headers = _make_admin_headers(cfg)
    sys.modules["app.database.config"] = cfg


def import_ml_modules_safe_order() -> tuple[Any, Any]:
    """Import torch strictly BEFORE paddle on Windows to prevent WinError 127 DLL load failure."""
    configure_cpu_thread_caps()
    import torch

    try:
        torch.set_num_threads(CPU_THREADS)
    except Exception:
        pass
    try:
        torch.set_num_interop_threads(1)
    except Exception:
        pass

    import paddle

    return torch, paddle


def get_system_memory_stats() -> dict[str, Any]:
    stats: dict[str, Any] = {
        "ram_total_mb": None,
        "ram_available_mb": None,
        "vram_total_mb": None,
        "vram_free_mb": None,
        "cuda_available": False,
        "cpu_threads": CPU_THREADS,
        "process_priority": get_windows_priority_name(),
        "pid": os.getpid(),
    }
    if sys.platform == "win32":
        try:
            class _MEMORYSTATUSEX(ctypes.Structure):
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

            mem = _MEMORYSTATUSEX()
            mem.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(mem)):
                stats["ram_total_mb"] = round(mem.ullTotalPhys / (1024 * 1024), 1)
                stats["ram_available_mb"] = round(mem.ullAvailPhys / (1024 * 1024), 1)
        except Exception:
            pass
    else:
        try:
            meminfo: dict[str, int] = {}
            for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) >= 2:
                    meminfo[parts[0].rstrip(":")] = int(parts[1])
            if "MemTotal" in meminfo:
                stats["ram_total_mb"] = round(meminfo["MemTotal"] / 1024.0, 1)
            if "MemAvailable" in meminfo:
                stats["ram_available_mb"] = round(meminfo["MemAvailable"] / 1024.0, 1)
        except Exception:
            pass

    torch_mod = sys.modules.get("torch")
    if torch_mod is not None:
        try:
            cuda_ok = bool(torch_mod.cuda.is_available())
            stats["cuda_available"] = cuda_ok
            if cuda_ok:
                free_b, total_b = torch_mod.cuda.mem_get_info(0)
                stats["vram_free_mb"] = round(free_b / (1024 * 1024), 1)
                stats["vram_total_mb"] = round(total_b / (1024 * 1024), 1)
        except Exception:
            pass
    return stats


def resolve_git_sha() -> str:
    explicit = (os.getenv("VIREAD_GIT_SHA") or os.getenv("GIT_SHA") or "").strip()
    if explicit:
        return explicit[:16]
    try:
        repo_root = Path(__file__).resolve().parents[1]
        out = subprocess.check_output(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=str(repo_root),
            stderr=subprocess.DEVNULL,
            timeout=2.0,
        )
        return out.decode("utf-8").strip() or "unknown"
    except Exception:
        return "unknown"


def _sha256_file(path: Path) -> str:
    st = path.stat()
    cache_key = (str(path.resolve()), int(st.st_size), int(st.st_mtime_ns))
    with _VERIFIED_FILE_SHA256_LOCK:
        cached = _VERIFIED_FILE_SHA256_CACHE.get(cache_key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    hex_digest = digest.hexdigest()
    with _VERIFIED_FILE_SHA256_LOCK:
        if len(_VERIFIED_FILE_SHA256_CACHE) >= 32:
            _VERIFIED_FILE_SHA256_CACHE.clear()
        _VERIFIED_FILE_SHA256_CACHE[cache_key] = hex_digest
    return hex_digest


def _find_smoke_font(size: int = 30) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    candidates = [
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size=size)
            except Exception:
                continue
    return ImageFont.load_default()


def build_smoke_test_image_bytes(text: str = "Xin chào Việt Nam") -> bytes:
    img = Image.new("RGB", (520, 120), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    font = _find_smoke_font(34)
    draw.text((28, 36), text, fill=(10, 10, 10), font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@dataclass
class EngineState:
    installed: bool = False
    loaded: bool = False
    inference_verified: bool = False
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        if self.error:
            detail_status = "unavailable"
            status = "UNAVAILABLE"
        elif self.inference_verified:
            detail_status = "inference_verified"
            status = "HEALTHY"
        elif self.loaded:
            detail_status = "loaded"
            status = "DEGRADED"
        elif self.installed:
            detail_status = "installed"
            status = "DEGRADED"
        else:
            detail_status = "not_installed"
            status = "UNAVAILABLE"
        return {
            "status": status,
            "detail_status": detail_status,
            "installed": self.installed,
            "loaded": self.loaded,
            "inference_verified": self.inference_verified,
            "error": self.error,
        }


@dataclass
class OcrRuntimeManager:
    """Thread-safe concurrency=1 OCR runtime wrapper around existing 3-engine ocr_engine.py."""

    worker_id: str = field(
        default_factory=lambda: (
            (os.getenv("VIREAD_OCR_WORKER_ID") or "").strip()
            or f"win-ocr-{re.sub(r'[^a-z0-9._-]+', '-', socket.gethostname().lower()).strip('-') or 'local'}"[:120]
        )
    )
    app_version: str = field(
        default_factory=lambda: (os.getenv("VIREAD_APP_VERSION") or __version__).strip() or __version__
    )
    git_sha: str = field(default_factory=resolve_git_sha)

    def __post_init__(self) -> None:
        self._cycle_lock = threading.Lock()
        self._inference_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._wake_event = threading.Event()
        self._draining: bool = False
        self._pending_redrain: bool = False
        self._burst_until_monotonic: float = 0.0
        self._standby_mode: str = "active_polling"
        self._wakeup_count: int = 0
        self._last_wakeup_reason: str | None = None
        self._active_job_id: str | None = None
        self._active_job_count: int = 0
        self._last_error: str | None = None
        self._model_profile: str = "ORIGINAL"
        self._model_sha256: str = ORIGINAL_VIETOCR_SHA256
        self._torch_version: str | None = None
        self._paddle_version: str | None = None
        self._cdn_transport: httpx.BaseTransport | None = None
        self._engines: dict[str, EngineState] = {
            "paddleocr": EngineState(),
            "vietocr": EngineState(),
            "tesseract_vie": EngineState(),
        }
        self._ocr_engine_mod: Any | None = None
        self.probe_installed()

    @property
    def wake_event(self) -> threading.Event:
        return self._wake_event

    @property
    def cycle_lock(self) -> threading.Lock:
        return self._cycle_lock

    def is_draining(self) -> bool:
        with self._state_lock:
            return self._draining

    def try_begin_drain_or_mark_pending(self, *, reason: str) -> tuple[bool, int, str]:
        """Atomically acquire single-flight drain ownership or mark a pending redrain."""
        with self._state_lock:
            self._wakeup_count += 1
            self._last_wakeup_reason = str(reason)[:64]
            wake_count = self._wakeup_count
            if self._draining:
                self._pending_redrain = True
                mode = self._standby_mode
                acquired = False
            else:
                self._draining = True
                self._pending_redrain = False
                self._standby_mode = "draining"
                mode = self._standby_mode
                acquired = True
        if not acquired:
            self._wake_event.set()
        return acquired, wake_count, mode

    def finish_drain_or_continue(self, *, idle_mode: str) -> tuple[bool, str]:
        """Atomically either consume a pending redrain or release drain ownership."""
        with self._state_lock:
            if self._pending_redrain:
                self._pending_redrain = False
                self._standby_mode = "draining"
                return True, self._standby_mode
            self._draining = False
            self._standby_mode = idle_mode
            return False, self._standby_mode

    def abort_drain(self, *, idle_mode: str) -> None:
        with self._state_lock:
            self._draining = False
            self._pending_redrain = False
            self._standby_mode = idle_mode

    def mark_pending_redrain(self) -> None:
        with self._state_lock:
            self._pending_redrain = True
        self._wake_event.set()

    def consume_pending_redrain(self) -> bool:
        with self._state_lock:
            was_set = self._pending_redrain
            self._pending_redrain = False
            return was_set

    def clear_burst_window(self) -> None:
        with self._state_lock:
            self._burst_until_monotonic = 0.0

    def set_standby_mode(self, mode: str) -> None:
        with self._state_lock:
            self._standby_mode = mode

    def burst_until_monotonic(self) -> float:
        with self._state_lock:
            return self._burst_until_monotonic

    def extend_burst_window(self, burst_seconds: float) -> float:
        bounded = max(5.0, min(600.0, float(burst_seconds)))
        target = time.monotonic() + bounded
        with self._state_lock:
            if target > self._burst_until_monotonic:
                self._burst_until_monotonic = target
            if self._standby_mode == "quiet_standby":
                self._standby_mode = "burst_awake"
            return self._burst_until_monotonic

    def trigger_wakeup(
        self,
        *,
        burst_seconds: float | None = None,
        reason: str | None = None,
    ) -> dict[str, Any]:
        default_burst = 90.0
        try:
            default_burst = max(
                10.0, min(600.0, float(os.getenv("VIREAD_OCR_WAKE_BURST_SECONDS", "90")))
            )
        except ValueError:
            default_burst = 90.0
        effective_burst = (
            max(10.0, min(600.0, float(burst_seconds)))
            if burst_seconds is not None
            else default_burst
        )
        now = time.monotonic()
        with self._state_lock:
            self._burst_until_monotonic = max(
                self._burst_until_monotonic, now + effective_burst
            )
            self._standby_mode = "burst_awake"
            self._wakeup_count += 1
            if reason:
                self._last_wakeup_reason = str(reason)[:64]
            wake_count = self._wakeup_count
            mode = self._standby_mode
        self._wake_event.set()
        return {
            "ok": True,
            "woken": True,
            "worker_id": self.worker_id,
            "standby_mode": mode,
            "burst_seconds": effective_burst,
            "wakeup_count": wake_count,
        }

    def probe_installed(self) -> dict[str, dict[str, Any]]:
        paddle_ok = (
            importlib.util.find_spec("paddleocr") is not None
            and importlib.util.find_spec("paddle") is not None
        )
        viet_ok = (
            importlib.util.find_spec("vietocr") is not None
            and importlib.util.find_spec("torch") is not None
        )
        tess_ok = False
        tess_binary = shutil.which("tesseract") or (
            r"C:\Program Files\Tesseract-OCR\tesseract.exe"
            if os.path.isfile(r"C:\Program Files\Tesseract-OCR\tesseract.exe")
            else None
        )
        if tess_binary and importlib.util.find_spec("pytesseract") is not None:
            try:
                proc = subprocess.run(
                    [tess_binary, "--list-langs"],
                    capture_output=True,
                    text=True,
                    timeout=3.0,
                    check=False,
                )
                langs = {line.strip() for line in proc.stdout.splitlines()[1:] if line.strip()}
                tess_ok = "vie" in langs
            except Exception:
                tess_ok = False

        with self._state_lock:
            self._engines["paddleocr"].installed = paddle_ok
            self._engines["vietocr"].installed = viet_ok
            self._engines["tesseract_vie"].installed = tess_ok
            return self.engines_snapshot()

    def engines_snapshot(self) -> dict[str, dict[str, Any]]:
        return {name: state.to_dict() for name, state in self._engines.items()}

    def is_ready(self) -> bool:
        with self._state_lock:
            paddle_st = self._engines["paddleocr"]
            viet_st = self._engines["vietocr"]
            return bool(
                (paddle_st.loaded or paddle_st.inference_verified)
                and (viet_st.loaded or viet_st.inference_verified)
            )

    def sync_active_model(
        self,
        manifest_fetcher: Callable[[], dict[str, Any]] | None = None,
        artifact_fetcher: Callable[[str, int | None], bytes] | None = None,
        direct_url_fetcher: Callable[[str], bytes | None] | None = None,
    ) -> dict[str, Any]:
        """Fetch active VietOCR checkpoint via signed Storage URLs or backend HTTP endpoints (zero DB/Supabase keys)."""
        install_zero_db_config_shim()
        manifest: dict[str, Any] = {}
        if manifest_fetcher is not None:
            manifest = manifest_fetcher() or {}

        profile = str(
            manifest.get("profile")
            or os.getenv("VIREAD_OCR_WORKER_MODEL_PROFILE")
            or "ORIGINAL"
        )
        checkpoint_sha = str(
            manifest.get("checkpoint_sha256")
            or os.getenv("VIREAD_OCR_WORKER_MODEL_SHA256")
            or ORIGINAL_VIETOCR_SHA256
        ).lower()
        storage_path = manifest.get("storage_path")

        cache_dir = resolve_model_cache_dir()
        local_pth = cache_dir / f"viread-vietocr-v2-{checkpoint_sha}.pth"
        local_yml = cache_dir / f"viread-vietocr-v2-{checkpoint_sha}.yml"
        prebaked_hit = False
        for candidate_dir in candidate_prebaked_model_dirs():
            alt_pth = candidate_dir / f"viread-vietocr-v2-{checkpoint_sha}.pth"
            if alt_pth.is_file() and _sha256_file(alt_pth) == checkpoint_sha:
                local_pth = alt_pth
                prebaked_hit = True
                alt_yml = candidate_dir / f"viread-vietocr-v2-{checkpoint_sha}.yml"
                if alt_yml.is_file():
                    local_yml = alt_yml
                break

        if checkpoint_sha != ORIGINAL_VIETOCR_SHA256 and len(checkpoint_sha) == 64:
            pth_valid = prebaked_hit or (
                local_pth.is_file() and _sha256_file(local_pth) == checkpoint_sha
            )
            cdn_mismatch_seen = False

            # 1. Zero-Supabase-egress CDN fetch (HF Model Repo or GitHub Release) BEFORE shard download.
            if not pth_valid:
                cdn_pth_url = _resolve_cdn_artifact_url(
                    os.getenv("VIREAD_OCR_CHECKPOINT_CDN_URL"),
                    expected_sha=checkpoint_sha,
                    suffix=".pth",
                )
                if cdn_pth_url:
                    fetched_pth, sha_mismatch = _download_verified_cdn_file(
                        cdn_pth_url,
                        expected_sha=checkpoint_sha,
                        dst_dir=cache_dir,
                        dst_filename=f"viread-vietocr-v2-{checkpoint_sha}.pth",
                        transport=self._cdn_transport,
                    )
                    cdn_mismatch_seen = sha_mismatch
                    if fetched_pth is not None:
                        local_pth = fetched_pth
                        pth_valid = True

            # 2. Fallback to signed Storage shards / backend shard endpoint (Flow 2 hot-reload compatible).
            if not pth_valid and (artifact_fetcher is not None or direct_url_fetcher is not None):
                shards = manifest.get("shards") or []
                if shards:
                    local_pth = cache_dir / f"viread-vietocr-v2-{checkpoint_sha}.pth"
                    tmp_pth = cache_dir / f"viread-vietocr-v2-{checkpoint_sha}.{uuid4().hex[:8]}.tmp"
                    try:
                        with tmp_pth.open("wb") as out:
                            for idx in range(len(shards)):
                                shard_meta = shards[idx] if isinstance(shards[idx], dict) else {}
                                chunk: bytes | None = None
                                signed_url = shard_meta.get("signed_url")
                                if (
                                    direct_url_fetcher is not None
                                    and isinstance(signed_url, str)
                                    and signed_url.startswith(("https://", "http://"))
                                ):
                                    try:
                                        chunk = direct_url_fetcher(signed_url)
                                    except Exception:
                                        chunk = None
                                if chunk is None:
                                    if artifact_fetcher is None:
                                        raise ValueError(f"Shard {idx} unavailable from direct URL or backend")
                                    chunk = artifact_fetcher("shard", idx)
                                expected_chunk_sha = str(shard_meta.get("sha256") or "").lower()
                                if expected_chunk_sha and hashlib.sha256(chunk).hexdigest() != expected_chunk_sha:
                                    raise ValueError(f"Shard {idx} checksum mismatch")
                                out.write(chunk)
                        if _sha256_file(tmp_pth) != checkpoint_sha:
                            raise ValueError("Assembled VietOCR checkpoint SHA-256 mismatch")
                        os.replace(tmp_pth, local_pth)
                        pth_valid = True
                    finally:
                        if tmp_pth.exists():
                            tmp_pth.unlink(missing_ok=True)

            if not pth_valid and cdn_mismatch_seen:
                raise ValueError(
                    "VietOCR checkpoint SHA-256 mismatch from VIREAD_OCR_CHECKPOINT_CDN_URL"
                )

            if manifest.get("has_custom_config"):
                cfg_sha = str(manifest.get("config_sha256") or "").lower()
                yml_valid = local_yml.is_file() and (not cfg_sha or _sha256_file(local_yml) == cfg_sha)
                if not yml_valid:
                    cdn_yml_url = _resolve_cdn_artifact_url(
                        os.getenv("VIREAD_OCR_CONFIG_CDN_URL")
                        or os.getenv("VIREAD_OCR_CHECKPOINT_CDN_URL"),
                        expected_sha=checkpoint_sha,
                        suffix=".yml",
                    )
                    if cdn_yml_url:
                        fetched_yml, _ = _download_verified_cdn_file(
                            cdn_yml_url,
                            expected_sha=cfg_sha or None,
                            dst_dir=cache_dir,
                            dst_filename=f"viread-vietocr-v2-{checkpoint_sha}.yml",
                            transport=self._cdn_transport,
                        )
                        if fetched_yml is not None:
                            local_yml = fetched_yml
                            yml_valid = True

                if not yml_valid and (
                    artifact_fetcher is not None or direct_url_fetcher is not None
                ):
                    local_yml = cache_dir / f"viread-vietocr-v2-{checkpoint_sha}.yml"
                    cfg_bytes: bytes | None = None
                    cfg_signed_url = manifest.get("config_signed_url")
                    if (
                        direct_url_fetcher is not None
                        and isinstance(cfg_signed_url, str)
                        and cfg_signed_url.startswith(("https://", "http://"))
                    ):
                        try:
                            cfg_bytes = direct_url_fetcher(cfg_signed_url)
                        except Exception:
                            cfg_bytes = None
                    if cfg_bytes is None:
                        if artifact_fetcher is None:
                            raise ValueError("VietOCR config YAML unavailable")
                        cfg_bytes = artifact_fetcher("config", None)
                    if cfg_sha and hashlib.sha256(cfg_bytes).hexdigest() != cfg_sha:
                        raise ValueError("VietOCR config YAML SHA-256 mismatch")
                    tmp_yml = cache_dir / f"viread-vietocr-v2-{checkpoint_sha}.{uuid4().hex[:8]}.yml.tmp"
                    try:
                        tmp_yml.write_bytes(cfg_bytes)
                        os.replace(tmp_yml, local_yml)
                    finally:
                        if tmp_yml.exists():
                            tmp_yml.unlink(missing_ok=True)

        self._model_profile = profile
        self._model_sha256 = checkpoint_sha
        return {
            "profile": profile,
            "checkpoint_sha256": checkpoint_sha,
            "storage_path": storage_path,
            "local_pth_exists": local_pth.is_file(),
            "local_yml_exists": local_yml.is_file(),
            "prebaked_hit": prebaked_hit,
        }

    def _install_local_artifact_resolver(self, ocr_engine: Any) -> None:
        """Resolve synced cache checkpoints directly without importing Supabase storage keys."""
        if getattr(ocr_engine, "_viread_worker_patched_resolver", False):
            return
        original_resolver = ocr_engine._v2_artifact_from_storage

        def _worker_v2_artifact_resolver(active: dict[str, Any]) -> tuple[str, dict[str, Any] | None, str | None]:
            expected_sha = str(active.get("checkpoint_sha256", "")).lower()
            for candidate_dir in candidate_prebaked_model_dirs():
                local_pth = candidate_dir / f"viread-vietocr-v2-{expected_sha}.pth"
                local_yml = candidate_dir / f"viread-vietocr-v2-{expected_sha}.yml"
                if len(expected_sha) == 64 and local_pth.is_file() and _sha256_file(local_pth) == expected_sha:
                    cfg_dict: dict[str, Any] | None = None
                    cfg_sha: str | None = None
                    if local_yml.is_file():
                        yml_bytes = local_yml.read_bytes()
                        cfg_sha = hashlib.sha256(yml_bytes).hexdigest()
                        loaded_cfg = yaml.safe_load(yml_bytes.decode("utf-8"))
                        if isinstance(loaded_cfg, dict):
                            cfg_dict = loaded_cfg
                    return str(local_pth), cfg_dict, cfg_sha
            return original_resolver(active)

        ocr_engine._v2_artifact_from_storage = _worker_v2_artifact_resolver
        ocr_engine._viread_worker_patched_resolver = True

    def initialize_and_verify_engines(
        self,
        *,
        manifest_fetcher: Callable[[], dict[str, Any]] | None = None,
        artifact_fetcher: Callable[[str, int | None], bytes] | None = None,
        direct_url_fetcher: Callable[[str], bytes | None] | None = None,
        run_smoke_inference: bool = True,
        force_reinit: bool = False,
    ) -> dict[str, Any]:
        """Load torch -> paddle -> ocr_engine, sync checkpoint, and verify real inference."""
        os.environ["VIREAD_OCR_WORKER_PROCESS"] = "1"
        with self._inference_lock:
            if not force_reinit and self.is_ready() and self._ocr_engine_mod is not None:
                return self.health_payload()
            self.probe_installed()
            sync_info = self.sync_active_model(
                manifest_fetcher=manifest_fetcher,
                artifact_fetcher=artifact_fetcher,
                direct_url_fetcher=direct_url_fetcher,
            )
            install_zero_db_config_shim()
            torch_mod, paddle_mod = import_ml_modules_safe_order()
            install_vietocr_safe_config_loader()
            self._torch_version = getattr(torch_mod, "__version__", None)
            self._paddle_version = getattr(paddle_mod, "__version__", None)

            from app.services import ocr_engine

            self._ocr_engine_mod = ocr_engine
            self._install_local_artifact_resolver(ocr_engine)
            ocr_engine.set_active_viread_model_cache(
                {
                    "profile": sync_info["profile"],
                    "checkpoint_sha256": sync_info["checkpoint_sha256"],
                    "storage_path": sync_info.get("storage_path")
                    or (
                        f"worker-cache/viread-vietocr-v2-{sync_info['checkpoint_sha256']}.pth"
                        if sync_info["checkpoint_sha256"] != ORIGINAL_VIETOCR_SHA256
                        else None
                    ),
                }
            )

            warmup_result = ocr_engine.warmup_ocr_engines()
            warmup_map = warmup_result if isinstance(warmup_result, dict) else {}
            # Re-apply thread cap because ocr_engine CPU init raises torch threads toward 8.
            try:
                torch_mod.set_num_threads(CPU_THREADS)
            except Exception:
                pass
            runtime_status = ocr_engine.get_loaded_vietocr_runtime_status()
            if not isinstance(runtime_status, dict):
                runtime_status = {}
            loaded_sha = str(
                runtime_status.get("loaded_checkpoint_sha256")
                or runtime_status.get("active_model_sha256")
                or sync_info["checkpoint_sha256"]
            ).lower()
            loaded_profile = str(
                runtime_status.get("loaded_profile")
                or runtime_status.get("active_model_profile")
                or sync_info["profile"]
            )

            with self._state_lock:
                self._model_profile = loaded_profile
                self._model_sha256 = loaded_sha
                self._engines["paddleocr"].loaded = (
                    getattr(ocr_engine, "_paddle_engine", None) is not None
                    or warmup_map.get("paddleocr") == "loaded"
                )
                self._engines["vietocr"].loaded = (
                    getattr(ocr_engine, "_vietocr_engine", None) is not None
                    or warmup_map.get("vietocr") == "loaded"
                )
                self._engines["tesseract_vie"].loaded = self._engines["tesseract_vie"].installed

            prebaked_matched = bool(
                sync_info.get("prebaked_hit") and loaded_sha == sync_info["checkpoint_sha256"]
            )
            if run_smoke_inference and not should_skip_startup_smoke(
                prebaked_hit=prebaked_matched
            ):
                self._run_smoke_verification(ocr_engine)

            return self.health_payload()

    def maybe_resync_active_model(
        self,
        *,
        manifest_fetcher: Callable[[], dict[str, Any]],
        artifact_fetcher: Callable[[str, int | None], bytes],
        direct_url_fetcher: Callable[[str], bytes | None] | None = None,
    ) -> bool:
        """Check backend active VietOCR pointer and hot-reload when Admin promotes/rolls back."""
        manifest = manifest_fetcher() or {}
        desired_profile = str(manifest.get("profile") or "ORIGINAL")
        desired_sha = str(
            manifest.get("checkpoint_sha256") or ORIGINAL_VIETOCR_SHA256
        ).lower()
        with self._state_lock:
            current_profile = self._model_profile
            current_sha = self._model_sha256
        if desired_sha == current_sha and desired_profile == current_profile:
            return False

        logger.info(
            "Active VietOCR pointer changed (%s/%s -> %s/%s); resyncing worker checkpoint.",
            current_profile,
            current_sha[:12],
            desired_profile,
            desired_sha[:12],
        )
        os.environ["VIREAD_OCR_WORKER_PROCESS"] = "1"
        with self._inference_lock:
            sync_info = self.sync_active_model(
                manifest_fetcher=lambda: manifest,
                artifact_fetcher=artifact_fetcher,
                direct_url_fetcher=direct_url_fetcher,
            )
            if self._ocr_engine_mod is None:
                return True
            ocr_engine = self._ocr_engine_mod
            self._install_local_artifact_resolver(ocr_engine)
            ocr_engine.set_active_viread_model_cache(
                {
                    "profile": sync_info["profile"],
                    "checkpoint_sha256": sync_info["checkpoint_sha256"],
                    "storage_path": sync_info.get("storage_path")
                    or (
                        f"worker-cache/viread-vietocr-v2-{sync_info['checkpoint_sha256']}.pth"
                        if sync_info["checkpoint_sha256"] != ORIGINAL_VIETOCR_SHA256
                        else None
                    ),
                }
            )
            warmup_result = ocr_engine.warmup_ocr_engines()
            warmup_map = warmup_result if isinstance(warmup_result, dict) else {}
            runtime_status = ocr_engine.get_loaded_vietocr_runtime_status()
            if not isinstance(runtime_status, dict):
                runtime_status = {}
            loaded_sha = str(
                runtime_status.get("loaded_checkpoint_sha256")
                or runtime_status.get("active_model_sha256")
                or sync_info["checkpoint_sha256"]
            ).lower()
            loaded_profile = str(
                runtime_status.get("loaded_profile")
                or runtime_status.get("active_model_profile")
                or sync_info["profile"]
            )
            with self._state_lock:
                self._model_profile = loaded_profile
                self._model_sha256 = loaded_sha
                self._engines["paddleocr"].loaded = (
                    getattr(ocr_engine, "_paddle_engine", None) is not None
                    or warmup_map.get("paddleocr") == "loaded"
                )
                self._engines["vietocr"].loaded = (
                    getattr(ocr_engine, "_vietocr_engine", None) is not None
                    or warmup_map.get("vietocr") == "loaded"
                )
        return True

    def _run_smoke_verification(self, ocr_engine: Any) -> None:
        smoke_bytes = build_smoke_test_image_bytes("Xin chào Việt Nam")
        try:
            result = ocr_engine.extract_text_and_boxes(smoke_bytes)
            statuses = (result.get("metadata") or {}).get("engine_statuses") or {}
            with self._state_lock:
                self._engines["paddleocr"].inference_verified = (
                    statuses.get("paddleocr") == "success"
                )
                self._engines["vietocr"].inference_verified = (
                    statuses.get("vietocr") == "success"
                )
                tess_status = statuses.get("tesseract") == "success"
                if not tess_status and self._engines["tesseract_vie"].installed:
                    tess_status = self._verify_tesseract_smoke(smoke_bytes)
                self._engines["tesseract_vie"].inference_verified = tess_status
                self._last_error = None
        except Exception as exc:
            self._last_error = type(exc).__name__
            logger.warning("Startup OCR smoke verification failed: %s", type(exc).__name__)

    @staticmethod
    def _verify_tesseract_smoke(image_bytes: bytes) -> bool:
        try:
            import pytesseract

            with Image.open(io.BytesIO(image_bytes)) as img:
                txt = pytesseract.image_to_string(img, lang="vie")
            return bool(txt and txt.strip())
        except Exception:
            return False

    @contextmanager
    def _active_job_scope(self, job_id: str | None):
        with self._inference_lock:
            with self._state_lock:
                self._active_job_id = job_id
                self._active_job_count = 1
            try:
                yield
            finally:
                with self._state_lock:
                    self._active_job_id = None
                    self._active_job_count = 0

    def run_ocr_for_job(self, job_id: str, image_bytes: bytes) -> dict[str, Any]:
        """Run all 3 engines sequentially with concurrency=1."""
        os.environ["VIREAD_OCR_WORKER_PROCESS"] = "1"
        if self._ocr_engine_mod is None:
            self.initialize_and_verify_engines(run_smoke_inference=False)
        assert self._ocr_engine_mod is not None
        ocr_engine = self._ocr_engine_mod

        started = time.perf_counter()
        torch_mod = sys.modules.get("torch")
        if torch_mod is not None:
            try:
                torch_mod.set_num_threads(CPU_THREADS)
            except Exception:
                pass
        with self._active_job_scope(job_id):
            try:
                result = ocr_engine.extract_text_and_boxes(image_bytes)
            finally:
                gc.collect()
                if torch_mod is not None:
                    try:
                        if torch_mod.cuda.is_available():
                            torch_mod.cuda.empty_cache()
                    except Exception:
                        pass
        duration_ms = int((time.perf_counter() - started) * 1000)

        meta = dict(result.get("metadata") or {})
        statuses = dict(meta.get("engine_statuses") or {})
        detected_device = str(meta.get("runtime_device") or "").strip().lower()
        if not detected_device:
            viet_cfg = getattr(getattr(ocr_engine, "_vietocr_engine", None), "config", None)
            if isinstance(viet_cfg, dict) and viet_cfg.get("device"):
                raw_dev = str(viet_cfg.get("device")).strip().lower()
                detected_device = "cuda" if raw_dev.startswith("cuda") else raw_dev
        if not detected_device and torch_mod is not None:
            try:
                detected_device = "cuda" if torch_mod.cuda.is_available() else "cpu"
            except Exception:
                detected_device = "cpu"
        meta["runtime_device"] = detected_device or "cpu"
        provenance = (
            meta.get("vietocr_runtime_provenance")
            if isinstance(meta.get("vietocr_runtime_provenance"), dict)
            else {}
        )
        resolved_profile = str(
            meta.get("model_profile")
            or provenance.get("model_profile")
            or meta.get("vietocr_profile")
            or self._model_profile
        )
        resolved_sha = str(
            meta.get("checkpoint_sha256")
            or provenance.get("checkpoint_sha256")
            or meta.get("vietocr_sha256")
            or self._model_sha256
        ).lower()
        with self._state_lock:
            if statuses.get("paddleocr") == "success":
                self._engines["paddleocr"].inference_verified = True
            if statuses.get("vietocr") == "success":
                self._engines["vietocr"].inference_verified = True
            if statuses.get("tesseract") == "success":
                self._engines["tesseract_vie"].inference_verified = True
            self._last_error = None

        return {
            "full_text": str(result.get("text") or ""),
            "words": list(result.get("words") or []),
            "ocr_meta": meta,
            "model_profile": resolved_profile,
            "model_sha256": resolved_sha,
            "engine_diagnostics": {
                "engine_statuses": statuses,
                "engines": self.engines_snapshot(),
            },
            "duration_ms": duration_ms,
        }

    def health_payload(self) -> dict[str, Any]:
        ready = self.is_ready()
        with self._state_lock:
            engines = self.engines_snapshot()
            active_id = self._active_job_id
            active_count = self._active_job_count
            profile = self._model_profile
            sha = self._model_sha256
            last_error = self._last_error
            standby_mode = self._standby_mode
            wakeup_count = self._wakeup_count
        sys_stats = get_system_memory_stats()
        worker_status = "BUSY" if active_count > 0 else ("IDLE" if ready else "DEGRADED")
        return {
            "status": "ok" if ready else "degraded",
            "worker_status": worker_status,
            "standby_mode": standby_mode,
            "wakeup_count": wakeup_count,
            "worker_id": self.worker_id,
            "ready": ready,
            "active_job_count": active_count,
            "active_job_id": active_id,
            "concurrency_limit": 1,
            "model": {
                "profile": profile,
                "checkpoint_sha256": sha,
                "expected_flow1_trdg_sha256": EXPECTED_FLOW1_TRDG_SHA256,
                "matches_flow1_trdg": sha == EXPECTED_FLOW1_TRDG_SHA256,
            },
            "engines": engines,
            "system": sys_stats,
            "version": self.app_version,
            "git_sha": self.git_sha,
            "last_error": last_error,
        }

    def version_payload(self) -> dict[str, Any]:
        return {
            "app_version": self.app_version,
            "git_sha": self.git_sha,
            "worker_id": self.worker_id,
            "model_profile": self._model_profile,
            "checkpoint_sha256": self._model_sha256,
            "python_version": platform.python_version(),
            "torch_version": self._torch_version,
            "paddle_version": self._paddle_version,
            "cpu_threads": CPU_THREADS,
            "process_priority": get_windows_priority_name(),
        }

    def heartbeat_payload(self) -> dict[str, Any]:
        health = self.health_payload()
        return {
            "worker_id": self.worker_id,
            "hostname": socket.gethostname(),
            "app_version": self.app_version,
            "git_sha": self.git_sha,
            "status": health["worker_status"] if self._ocr_engine_mod is not None else "STARTING",
            "active_job_id": health["active_job_id"],
            "active_job_count": health["active_job_count"],
            "concurrency_limit": 1,
            "model_profile": health["model"]["profile"],
            "model_sha256": health["model"]["checkpoint_sha256"],
            "engines": health["engines"],
            "system_stats": health["system"],
            "last_error": health["last_error"],
        }


class WorkerWakeupRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=64)
    job_id: str | None = Field(default=None, max_length=64)
    burst_seconds: float | None = Field(default=None, ge=10.0, le=600.0)


def _verify_worker_token_constant_time(
    provided_header: str | None, *, explicit_expected: str | None = None
) -> None:
    expected = (
        explicit_expected
        if explicit_expected is not None
        else (os.getenv("VIREAD_OCR_WORKER_TOKEN") or "")
    ).strip()
    if len(expected) < 32:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OCR worker token is not configured.",
        )
    provided = (provided_header or "").strip()
    if not provided:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-ViRead-Ocr-Worker-Token header.",
        )
    expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    provided_digest = hashlib.sha256(provided.encode("utf-8")).digest()
    if not hmac.compare_digest(expected_digest, provided_digest):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid OCR worker token.",
        )


def build_worker_http_app(
    runtime: OcrRuntimeManager,
    *,
    worker_token: str | None = None,
    drain_runner: Callable[[str], int] | None = None,
) -> FastAPI:
    app = FastAPI(title="ViRead Local OCR Worker", version=runtime.app_version)

    @app.get("/health")
    def health() -> dict[str, Any]:
        # Passive readiness probe: resets HF Spaces 48h timer without waking DB poll loop.
        return runtime.health_payload()

    @app.get("/version")
    def version() -> dict[str, Any]:
        return runtime.version_payload()

    @app.post("/wakeup")
    async def wakeup(
        drain: bool | None = Query(default=None),
        payload: WorkerWakeupRequest | None = Body(default=None),
        x_viread_ocr_worker_token: str | None = Header(
            default=None, alias="X-ViRead-Ocr-Worker-Token"
        ),
    ) -> dict[str, Any]:
        _verify_worker_token_constant_time(
            x_viread_ocr_worker_token, explicit_expected=worker_token
        )
        reason_val = payload.reason if payload and payload.reason else "webhook"
        burst_val = payload.burst_seconds if payload else None
        effective_drain = is_scale_to_zero_enabled() if drain is None else bool(drain)
        if not effective_drain:
            return runtime.trigger_wakeup(
                burst_seconds=burst_val,
                reason=reason_val,
            )

        acquired, wake_count, mode = runtime.try_begin_drain_or_mark_pending(
            reason=reason_val
        )
        if not acquired:
            return {
                "ok": True,
                "woken": True,
                "drained": False,
                "already_draining": True,
                "drained_jobs": 0,
                "worker_id": runtime.worker_id,
                "standby_mode": mode,
                "wakeup_count": wake_count,
            }

        idle_mode = "scale_to_zero" if is_scale_to_zero_enabled() else "quiet_standby"
        if drain_runner is None:
            runtime.abort_drain(idle_mode=idle_mode)
            return {
                "ok": True,
                "woken": True,
                "drained": True,
                "already_draining": False,
                "drained_jobs": 0,
                "worker_id": runtime.worker_id,
                "standby_mode": idle_mode,
                "wakeup_count": wake_count,
            }

        drained_total = 0
        try:
            while True:
                drained_total += int(await asyncio.to_thread(drain_runner, reason_val))
                should_continue, mode = runtime.finish_drain_or_continue(idle_mode=idle_mode)
                if not should_continue:
                    break
        except BaseException as exc:
            runtime.abort_drain(idle_mode=idle_mode)
            if isinstance(exc, Exception):
                logger.warning("Synchronous /wakeup drain error: %s", type(exc).__name__)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="OCR worker synchronous drain cycle failed.",
                ) from None
            raise

        return {
            "ok": True,
            "woken": True,
            "drained": True,
            "already_draining": False,
            "drained_jobs": drained_total,
            "worker_id": runtime.worker_id,
            "standby_mode": mode,
            "wakeup_count": wake_count,
        }

    return app
