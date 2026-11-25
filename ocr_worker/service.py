from __future__ import annotations

import ctypes
import hashlib
import importlib.util
import io
import logging
import os
import platform
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
from uuid import uuid4

from fastapi import FastAPI
from PIL import Image, ImageDraw, ImageFont

from ocr_worker import __version__

logger = logging.getLogger("ocr_worker.service")

EXPECTED_FLOW1_TRDG_SHA256 = (
    "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6"
)
ORIGINAL_VIETOCR_SHA256 = (
    "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"
)

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

    if "app.database.config" in sys.modules:
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
    cfg.SUPABASE_ADMIN_KEY = None
    cfg.SUPABASE_KEY = None
    cfg.SUPABASE_STORAGE_BUCKET = None
    cfg.SUPABASE_PRIVATE_BOOKS_BUCKET = None
    cfg.DATABASE_URL = None
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
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
            os.getenv("VIREAD_OCR_WORKER_ID")
            or f"win-ocr-{socket.gethostname().lower()}-{uuid4().hex[:6]}"
        )
    )
    app_version: str = field(
        default_factory=lambda: (os.getenv("VIREAD_APP_VERSION") or __version__).strip() or __version__
    )
    git_sha: str = field(default_factory=resolve_git_sha)

    def __post_init__(self) -> None:
        self._inference_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._active_job_id: str | None = None
        self._active_job_count: int = 0
        self._last_error: str | None = None
        self._model_profile: str = "ORIGINAL"
        self._model_sha256: str = ORIGINAL_VIETOCR_SHA256
        self._torch_version: str | None = None
        self._paddle_version: str | None = None
        self._engines: dict[str, EngineState] = {
            "paddleocr": EngineState(),
            "vietocr": EngineState(),
            "tesseract_vie": EngineState(),
        }
        self._ocr_engine_mod: Any | None = None
        self.probe_installed()

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
    ) -> dict[str, Any]:
        """Fetch active VietOCR checkpoint via backend HTTP endpoints (zero DB/Supabase keys)."""
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

        # Fallback: if backend active pointer isn't updated yet or offline mode configured with
        # local verified Flow1 TRDG cache matching EXPECTED_FLOW1_TRDG_SHA256, allow env override only.
        temp_dir = Path(tempfile.gettempdir())
        local_pth = temp_dir / f"viread-vietocr-v2-{checkpoint_sha}.pth"
        local_yml = temp_dir / f"viread-vietocr-v2-{checkpoint_sha}.yml"

        if checkpoint_sha != ORIGINAL_VIETOCR_SHA256 and len(checkpoint_sha) == 64:
            pth_valid = local_pth.is_file() and _sha256_file(local_pth) == checkpoint_sha
            if not pth_valid and artifact_fetcher is not None:
                shards = manifest.get("shards") or []
                if shards:
                    tmp_pth = temp_dir / f"viread-vietocr-v2-{checkpoint_sha}.{uuid4().hex[:8]}.tmp"
                    try:
                        with tmp_pth.open("wb") as out:
                            for idx in range(len(shards)):
                                chunk = artifact_fetcher("shard", idx)
                                expected_chunk_sha = str((shards[idx] or {}).get("sha256") or "").lower()
                                if expected_chunk_sha and hashlib.sha256(chunk).hexdigest() != expected_chunk_sha:
                                    raise ValueError(f"Shard {idx} checksum mismatch")
                                out.write(chunk)
                        if _sha256_file(tmp_pth) != checkpoint_sha:
                            raise ValueError("Assembled VietOCR checkpoint SHA-256 mismatch")
                        os.replace(tmp_pth, local_pth)
                    finally:
                        if tmp_pth.exists():
                            tmp_pth.unlink(missing_ok=True)
            if manifest.get("has_custom_config") and artifact_fetcher is not None:
                cfg_sha = str(manifest.get("config_sha256") or "").lower()
                yml_valid = local_yml.is_file() and (not cfg_sha or _sha256_file(local_yml) == cfg_sha)
                if not yml_valid:
                    cfg_bytes = artifact_fetcher("config", None)
                    if cfg_sha and hashlib.sha256(cfg_bytes).hexdigest() != cfg_sha:
                        raise ValueError("VietOCR config YAML SHA-256 mismatch")
                    tmp_yml = temp_dir / f"viread-vietocr-v2-{checkpoint_sha}.{uuid4().hex[:8]}.yml.tmp"
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
        }

    def _install_local_artifact_resolver(self, ocr_engine: Any) -> None:
        """Resolve synced %TEMP% checkpoints directly without importing Supabase storage keys."""
        if getattr(ocr_engine, "_viread_worker_patched_resolver", False):
            return
        original_resolver = ocr_engine._v2_artifact_from_storage
        import yaml

        def _worker_v2_artifact_resolver(active: dict[str, Any]) -> tuple[str, dict[str, Any] | None, str | None]:
            expected_sha = str(active.get("checkpoint_sha256", "")).lower()
            temp_dir = Path(tempfile.gettempdir())
            local_pth = temp_dir / f"viread-vietocr-v2-{expected_sha}.pth"
            local_yml = temp_dir / f"viread-vietocr-v2-{expected_sha}.yml"
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
        run_smoke_inference: bool = True,
    ) -> dict[str, Any]:
        """Load torch -> paddle -> ocr_engine, sync checkpoint, and verify real inference."""
        with self._inference_lock:
            self.probe_installed()
            sync_info = self.sync_active_model(
                manifest_fetcher=manifest_fetcher,
                artifact_fetcher=artifact_fetcher,
            )
            install_zero_db_config_shim()
            torch_mod, paddle_mod = import_ml_modules_safe_order()
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
            # Re-apply thread cap because ocr_engine CPU init raises torch threads toward 8.
            try:
                torch_mod.set_num_threads(CPU_THREADS)
            except Exception:
                pass
            runtime_status = ocr_engine.get_loaded_vietocr_runtime_status()
            loaded_sha = str(
                runtime_status.get("active_model_sha256") or sync_info["checkpoint_sha256"]
            ).lower()
            loaded_profile = str(
                runtime_status.get("active_model_profile") or sync_info["profile"]
            )

            with self._state_lock:
                self._model_profile = loaded_profile
                self._model_sha256 = loaded_sha
                self._engines["paddleocr"].loaded = (
                    getattr(ocr_engine, "_paddle_engine", None) is not None
                    or warmup_result.get("paddleocr") == "loaded"
                )
                self._engines["vietocr"].loaded = (
                    getattr(ocr_engine, "_vietocr_engine", None) is not None
                    or warmup_result.get("vietocr") == "loaded"
                )
                self._engines["tesseract_vie"].loaded = self._engines["tesseract_vie"].installed

            if run_smoke_inference:
                self._run_smoke_verification(ocr_engine)

            return self.health_payload()

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
            result = ocr_engine.extract_text_and_boxes(image_bytes)
        duration_ms = int((time.perf_counter() - started) * 1000)

        meta = dict(result.get("metadata") or {})
        statuses = dict(meta.get("engine_statuses") or {})
        meta["runtime_device"] = str(meta.get("runtime_device") or "cpu")
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
            "model_profile": str(meta.get("vietocr_profile") or self._model_profile),
            "model_sha256": str(meta.get("vietocr_sha256") or self._model_sha256).lower(),
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
        sys_stats = get_system_memory_stats()
        worker_status = "BUSY" if active_count > 0 else ("IDLE" if ready else "DEGRADED")
        return {
            "status": "ok" if ready else "degraded",
            "worker_status": worker_status,
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


def build_worker_http_app(runtime: OcrRuntimeManager) -> FastAPI:
    app = FastAPI(title="ViRead Local OCR Worker", version=runtime.app_version)

    @app.get("/health")
    def health() -> dict[str, Any]:
        return runtime.health_payload()

    @app.get("/version")
    def version() -> dict[str, Any]:
        return runtime.version_payload()

    return app
