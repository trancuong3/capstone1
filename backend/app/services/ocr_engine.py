from __future__ import annotations

import logging
import hashlib
import json
import math
from contextlib import nullcontext
import os
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
import re
import shutil
import sys
import tempfile
import threading
import time
import unicodedata
from weakref import WeakKeyDictionary
from typing import Any
import yaml
from app.services.word_box_geometry import build_geometry_evidence

from app.services.ocr_adjudication import (
    OCR_ADJUDICATION_RULE,
    adjudicate_word,
    replace_token_core,
)
from app.services.ocr_punctuation import canonical_punctuation, split_surface_token
from app.services.ocr_evidence import (
    HYBRID_OCR_EVIDENCE_CONTRACT,
    MAX_SELECTIVE_WORD_CROPS_PER_PAGE,
    OCR_PREPROCESSING_VERSION,
    crop_word_region,
    find_split_merge_candidates,
    token_alignment_cost,
)
from app.services.viread_vietocr_v2_preprocessing import preprocess_line_array

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ.setdefault("LMDB_FORCE_CPYTHON", "1")

# The Windows setup script keeps the pinned Vietnamese model inside this
# checkout instead of writing into Program Files. Tesseract expects the parent
# directory of `tessdata` here; preserve any explicit machine/user override.
_backend_root = Path(__file__).resolve().parents[2]
if (_backend_root / "tessdata" / "vie.traineddata").is_file():
    os.environ.setdefault("TESSDATA_PREFIX", str(_backend_root))

import PIL.Image

if not hasattr(PIL.Image, "ANTIALIAS"):
    PIL.Image.ANTIALIAS = PIL.Image.Resampling.LANCZOS

import cv2
import numpy as np
import requests
from PIL import Image
try:
    from app.database.config import SUPABASE_ADMIN_KEY, SUPABASE_URL, supabase_admin_headers
except ModuleNotFoundError:
    SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip() or None
    _supabase_secret_key = (os.getenv("SUPABASE_SECRET_KEY") or "").strip() or None
    _supabase_service_role_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip() or None
    SUPABASE_ADMIN_KEY = _supabase_secret_key or _supabase_service_role_key

    def _is_supabase_jwt_key(api_key: str | None) -> bool:
        """Return True only when the key looks like a legacy 3-part JWT rather than sb_secret_*."""
        clean = (api_key or "").strip()
        return clean.count(".") == 2 and not clean.startswith("sb_")

    def supabase_admin_headers(
        api_key: str | None = None,
        *,
        extra: dict[str, str] | None = None,
    ) -> dict[str, str]:
        """Build Supabase Storage/PostgREST headers without requiring app.database in Zero-DB workers."""
        key = ((api_key if api_key is not None else SUPABASE_ADMIN_KEY) or "").strip()
        headers: dict[str, str] = {"apikey": key}
        if _is_supabase_jwt_key(key):
            headers["Authorization"] = f"Bearer {key}"
        if extra:
            headers.update(extra)
        return headers

# Optional/worker-only OCR dependencies are imported lazily so light web deploys
# (`requirements-web.txt`) never crash with ModuleNotFoundError if ocr_engine is
# accidentally imported.
jiwer = None
try:
    import pytesseract
    from pytesseract import Output
except ImportError:
    pytesseract = None
    Output = None


def _ensure_jiwer():
    global jiwer
    if jiwer is None:
        try:
            import jiwer as _jiwer
            jiwer = _jiwer
        except ImportError:
            return None
    return jiwer


def _ensure_pytesseract():
    global pytesseract, Output
    if pytesseract is None:
        try:
            import pytesseract as _pytesseract
            from pytesseract import Output as _Output
            pytesseract = _pytesseract
            Output = _Output
        except ImportError:
            return None, None
    elif Output is None:
        Output = getattr(pytesseract, "Output", None)
    return pytesseract, Output


def _is_remote_ocr_mode_guard() -> bool:
    """Fail-closed in-process OCR guard (zero DB imports for standalone worker compatibility)."""
    if (os.getenv("VIREAD_OCR_WORKER_PROCESS") or "").strip().lower() in {"1", "true", "yes", "on"}:
        return False
    raw_mode = (os.getenv("VIREAD_OCR_MODE") or "").strip().lower()
    if raw_mode == "remote_worker":
        return True
    if raw_mode == "local_inprocess":
        return False
    app_env = (os.getenv("APP_ENVIRONMENT") or "").strip().lower()
    render_flag = (os.getenv("RENDER") or "").strip().lower()
    disable_heavy = (os.getenv("VIREAD_WEB_DISABLE_HEAVY_WORKERS") or "").strip().lower()
    return (
        app_env == "production"
        or render_flag in {"1", "true", "yes", "on"}
        or disable_heavy in {"1", "true", "yes", "on"}
    )


def _fallback_cer(reference: str, hypothesis: str) -> float:
    if not reference:
        return 0.0 if not hypothesis else 1.0
    prev = list(range(len(hypothesis) + 1))
    for i, rc in enumerate(reference, 1):
        curr = [i]
        for j, hc in enumerate(hypothesis, 1):
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + (rc != hc)))
        prev = curr
    return prev[-1] / len(reference)

# OCR runtimes are deliberately imported on the first OCR request. Importing
# PyTorch and PaddleOCR during FastAPI startup exceeded Render Free's 512 MiB
# memory limit before the API could bind its port.
torch = None
PaddleOCR = None
Cfg = None
Predictor = None
_paddle_import_status = "not_initialized"
_paddle_import_error: str | None = None
_vietocr_import_status = "not_initialized"
_vietocr_import_error: str | None = None
_ocr_dependencies_loaded = False

logger = logging.getLogger(__name__)



class OcrEngineUnavailable(RuntimeError):
    """Mô hình PaddleOCR hoặc VietOCR không khả dụng hoặc chưa được cấu hình."""


class OcrNoTextDetected(RuntimeError):
    """Hình ảnh hợp lệ nhưng hệ thống không phát hiện được chữ tiếng Việt khả dụng."""


from app.services.ocr_text_utils import (
    MAX_ALIGNMENT_CELLS,
    _token_surface,
    _tokens_with_source_indices,
    align_ocr_tokens,
    normalize_text_tokens,
    normalize_word,
    token_alignment_cost as _token_alignment_cost,
)


from unittest.mock import NonCallableMock

try:
    from app.services.ocr_executor import get_ocr_executor
except ModuleNotFoundError:
    from concurrent.futures import ThreadPoolExecutor

    _fallback_executor_lock = threading.Lock()
    _fallback_ocr_executor: ThreadPoolExecutor | None = None

    def get_ocr_executor() -> ThreadPoolExecutor:
        global _fallback_ocr_executor
        with _fallback_executor_lock:
            if _fallback_ocr_executor is None:
                _fallback_ocr_executor = ThreadPoolExecutor(
                    max_workers=1,
                    thread_name_prefix="viread-ocr",
                )
            return _fallback_ocr_executor

_paddle_engine: PaddleOCR | None = None
_vietocr_engine: Predictor | None = None
_engine_lock = threading.Lock()
# Model instances are shared by FastAPI threadpool workers. Initialization
# locking alone does not make inference methods safe for concurrent requests.
_paddle_inference_lock = threading.Lock()
_vietocr_inference_lock = threading.Lock()
_paddle_initialization_status = "not_initialized"
_vietocr_initialization_status = "not_initialized"
_paddle_initialization_error: str | None = None
_vietocr_initialization_error: str | None = None
_vietocr_active_checkpoint_sha: str | None = None
_vietocr_active_profile = "ORIGINAL"
_vietocr_active_config_sha: str | None = None
_vietocr_active_storage_path: str | None = None
# This is actual loaded Predictor identity -> verified local checkpoint, NOT
# merely the current database active-model pointer. Weak refs do not hold old
# 150 MB models alive after another worker swaps the active Predictor.
_vietocr_verified_runtime: WeakKeyDictionary[Any, dict[str, Any]] = WeakKeyDictionary()
_scan_runtime_context = threading.local()
_OCR_RUNTIME_PROVENANCE_VERSION = "vietocr_loaded_checkpoint_v1"
_active_model_info_cache: tuple[float, dict[str, Any] | None] = (0.0, None)
_active_model_retry_after: float = 0.0
_active_model_failure_count: int = 0
_ACTIVE_MODEL_CACHE_TTL_SECONDS = 300.0
_ACTIVE_MODEL_RETRY_BASE_SECONDS = 15.0
_ACTIVE_MODEL_RETRY_MAX_SECONDS = 300.0
_active_model_cache_lock = threading.Lock()
_V2_PREPROCESSING_PROFILES = frozenset({
    "FLOW1_EXTERNAL_TRDG",
    "FLOW2_ADMIN_VERIFIED",
    "FLOW1_VERIFIED",
    "FLOW2_EXTERNAL_TRDG",
})
_ORIGINAL_VIETOCR_SHA256 = "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"
_ORIGINAL_VOCAB_SHA256 = "b4ec9437ef82d952a65c101ea7ec6748a7168777c2d84cdb6a1bba7540bd163d"
_ORIGINAL_VOCAB_SIZE = 229
_SHA256_HEX_RE = re.compile(r"[0-9a-f]{64}")


def _verified_vietocr_instance(
    predictor: Any,
    *,
    model_profile: str,
    checkpoint_sha256: str,
    config_sha256: str | None,
) -> None:
    """Bind a VERIFIED on-disk checkpoint digest to the exact Predictor instance.

    Called only AFTER loading Predictor from the verified file. Never bind a
    requested registry hash or weights path directly to scan metadata.
    """
    try:
        _vietocr_verified_runtime[predictor] = {
            "model_profile": model_profile,
            "checkpoint_sha256": checkpoint_sha256,
            "config_sha256": config_sha256,
        }
    except TypeError:
        # A predictor with no weakref support can still recognize text, but its
        # runtime identity cannot be proved safely. Report unverified, not a
        # potentially misleading profile/SHA.
        logger.warning("Loaded VietOCR instance cannot be weak-referenced for provenance")


def _inference_model_profile(predictor: Any | None) -> str:
    """Select preprocessing from the inference instance, never a mutable global.

    An untracked engine (e.g. a synthetic test double) uses the Original
    preprocessing path and still gets NO verified checkpoint SHA in metadata.
    """
    if predictor is not None:
        try:
            proof = _vietocr_verified_runtime.get(predictor)
        except TypeError:
            proof = None
        if proof:
            return str(proof["model_profile"])
    return "ORIGINAL"


def _scan_vietocr_snapshot(
    predictor: Any | None,
    *,
    requested_profile: str | None = None,
    requested_sha: str | None = None,
    fallback_reason: str | None = None,
) -> dict[str, Any]:
    """Capture provenance of the predictor actually passed to inference.

    For historical/mocked/untracked Predictor instances the hash is unknown.
    Profile and SHA are never inferred from the active-model database row.
    """
    proof: dict[str, Any] | None = None
    if predictor is not None:
        try:
            proof = _vietocr_verified_runtime.get(predictor)
        except TypeError:
            pass
    if predictor is None:
        status = "unavailable"
    elif proof is None:
        status = "unverified"
    elif (
        requested_sha is not None
        and (proof["checkpoint_sha256"] != requested_sha
             or proof["model_profile"] != requested_profile)
    ):
        status = (
            "fallback_loaded" if proof["model_profile"] == "ORIGINAL"
            else "stale_loaded"
        )
    elif fallback_reason:
        status = "fallback_loaded"
    else:
        status = "loaded"
    if status in {"fallback_loaded", "stale_loaded"} and not fallback_reason:
        fallback_reason = "requested_checkpoint_not_loaded"
    return {
        "provenance_version": _OCR_RUNTIME_PROVENANCE_VERSION,
        "model_profile": proof["model_profile"] if proof else None,
        "checkpoint_sha256": proof["checkpoint_sha256"] if proof else None,
        "config_sha256": proof["config_sha256"] if proof else None,
        "model_load_status": status,
        "fallback_reason": fallback_reason,
        "engine_version": _package_version("vietocr"),
    }


def _resolve_predictor_device(predictor: Any | None) -> str:
    cfg = getattr(predictor, "config", None) if predictor is not None else None
    if isinstance(cfg, dict):
        raw_device = str(cfg.get("device") or "").strip().lower()
        if raw_device:
            return "cuda" if raw_device.startswith("cuda") else raw_device
    if torch is not None:
        try:
            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
    return "cpu"


def _attach_vietocr_provenance(
    result: dict[str, object],
    snapshot: dict[str, Any] | None,
    *,
    skipped_reason: str | None = None,
) -> dict[str, object]:
    """Persist an immutable scan-time snapshot, not mutable engine globals."""
    metadata = result.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    snapshot = snapshot or _scan_vietocr_snapshot(None)
    status = (metadata.get("engine_statuses") or {}).get("vietocr") if isinstance(
        metadata.get("engine_statuses"), dict
    ) else "not_run"
    if skipped_reason or metadata.get("engine") == "tesseract":
        snapshot = {
            **snapshot,
            "model_profile": None,
            "checkpoint_sha256": None,
            "config_sha256": None,
            "model_load_status": "not_run",
            "fallback_reason": skipped_reason or snapshot.get("fallback_reason") or "tesseract_fallback",
        }
        metadata.setdefault("runtime_device", "cpu")
    else:
        metadata.setdefault("runtime_device", _resolve_predictor_device(_vietocr_engine))
        if status == "error" and not snapshot.get("fallback_reason"):
            snapshot = {**snapshot, "fallback_reason": "vietocr_inference_error"}
        elif status == "no_result" and not snapshot.get("fallback_reason"):
            snapshot = {**snapshot, "fallback_reason": "vietocr_no_result"}
        elif (snapshot.get("model_load_status") == "unavailable"
              or status in {"not_installed", "not_initialized", "disabled"}):
            if not snapshot.get("fallback_reason"):
                snapshot = {**snapshot, "fallback_reason": "vietocr_unavailable"}
    metadata["vietocr_runtime_provenance"] = {
        **snapshot,
        "model_inference_status": status,
    }
    # Selected fields are duplicated for legacy scan consumers and Admin OCR
    # Diagnostics. None means not proven/not run; it MUST NOT be substituted
    # with the registry's requested SHA.
    for key in ("model_profile", "checkpoint_sha256", "model_load_status", "fallback_reason"):
        metadata[key] = snapshot.get(key)
    result["metadata"] = metadata
    return result


def _deep_merge_dict(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge_dict(base[key], value)
        else:
            base[key] = value
    return base



def _sha256_path(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def set_active_viread_model_cache(item: dict[str, Any] | None) -> None:
    """Immediately update the in-memory active model cache after an Admin decision."""
    global _active_model_info_cache, _active_model_retry_after, _active_model_failure_count
    with _active_model_cache_lock:
        _active_model_info_cache = (time.monotonic(), item)
        _active_model_failure_count = 0
        _active_model_retry_after = 0.0


def _active_viread_model() -> dict[str, Any] | None:
    """Return cached pointer; refresh on cold start or TTL expiry with backoff cooldown."""
    now = time.monotonic()
    with _active_model_cache_lock:
        ts, cached = _active_model_info_cache
        retry_after = _active_model_retry_after
    if ts > 0.0 and (now - ts) < _ACTIVE_MODEL_CACHE_TTL_SECONDS:
        return cached
    if now < retry_after:
        return cached
    return refresh_active_viread_model()


def _record_active_model_refresh_miss(now: float) -> dict[str, Any] | None:
    global _active_model_retry_after, _active_model_failure_count
    with _active_model_cache_lock:
        _active_model_failure_count += 1
        backoff = min(
            _ACTIVE_MODEL_RETRY_MAX_SECONDS,
            _ACTIVE_MODEL_RETRY_BASE_SECONDS * (2 ** min(_active_model_failure_count - 1, 6)),
        )
        _active_model_retry_after = now + backoff
        return _active_model_info_cache[1]


def refresh_active_viread_model() -> dict[str, Any] | None:
    """Refresh the private pointer with a short network timeout; retain last good value with cooldown backoff."""
    global _active_model_info_cache, _active_model_retry_after, _active_model_failure_count
    now = time.monotonic()
    if not SUPABASE_URL or not SUPABASE_ADMIN_KEY:
        return _record_active_model_refresh_miss(now)
    try:
        response = requests.get(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/viread_ocr_active_model",
            params={"select": "checkpoint_sha256,storage_path,profile", "singleton": "eq.true", "limit": "1"},
            headers=supabase_admin_headers(SUPABASE_ADMIN_KEY),
            timeout=(2, 3),
        )
        response.raise_for_status()
        rows = response.json()
        item = rows[0] if isinstance(rows, list) and rows else None
        if not isinstance(item, dict):
            return _record_active_model_refresh_miss(now)
        with _active_model_cache_lock:
            _active_model_info_cache = (now, item)
            _active_model_failure_count = 0
            _active_model_retry_after = 0.0
        return item
    except Exception as exc:
        logger.debug("VietOCR active model registry is unavailable: %s", type(exc).__name__)
        return _record_active_model_refresh_miss(now)


def run_active_viread_model_worker(stop_event: threading.Event, *, poll_seconds: int = 300) -> None:
    """Poll the registry calmly and only after OCR dependencies have been activated."""
    from app.services.worker_telemetry import record_worker_error, record_worker_success

    interval = max(30, int(os.getenv("VIREAD_ACTIVE_MODEL_POLL_SECONDS", str(poll_seconds))))
    while not stop_event.is_set():
        try:
            if _ocr_dependencies_loaded:
                refresh_active_viread_model()
            record_worker_success("active_model_registry")
        except Exception as exc:
            record_worker_error("active_model_registry", exc)
        stop_event.wait(interval)


def _v2_artifact_from_storage(active: dict[str, Any]) -> tuple[str, dict[str, Any] | None, str | None]:
    expected_sha = str(active.get("checkpoint_sha256", "")).strip().lower()
    manifest_path = active.get("storage_path")
    if not _SHA256_HEX_RE.fullmatch(expected_sha) or not isinstance(manifest_path, str) or not manifest_path:
        raise ValueError("active VietOCR V2 checkpoint pointer is invalid")
    from app.services import storage_service
    from app.services.training_storage.references import is_gdrive_ref
    from app.services.training_storage.router import get_runtime_artifact_router

    def _download_artifact(ref: str, *, expected_hash: str | None = None) -> bytes:
        if is_gdrive_ref(ref):
            return get_runtime_artifact_router().get(ref, expected_sha256=expected_hash)
        return storage_service.download_object(ref)

    manifest_bytes = _download_artifact(manifest_path)
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    if manifest.get("checkpoint_sha256") != expected_sha or not isinstance(manifest.get("chunks"), list):
        raise ValueError("active VietOCR V2 shard manifest does not match its database pointer")
    temp_root = Path(tempfile.gettempdir()).resolve()
    local_path = os.path.join(str(temp_root), f"viread-vietocr-v2-{expected_sha}.pth")
    if Path(local_path).resolve().parent != temp_root:
        raise ValueError("active VietOCR V2 checkpoint cache path is invalid")
    if not (os.path.isfile(local_path) and _sha256_path(local_path) == expected_sha):
        digest = hashlib.sha256()
        # Unique per-attempt scratch file: multiple Render workers may attempt
        # to download the same SHA concurrently. Atomic replace publishes only
        # a fully hash-verified checkpoint; no worker deletes another's temp.
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f"viread-vietocr-v2-{expected_sha}-",
                suffix=".assembling",
                dir=str(temp_root),
                delete=False,
            ) as output:
                temporary = output.name
                chunks = sorted(manifest["chunks"], key=lambda item: int(item["index"]))
                if [int(item["index"]) for item in chunks] != list(range(len(chunks))):
                    raise ValueError("VietOCR V2 checkpoint shards are incomplete")
                for item in chunks:
                    shard_ref = str(item["path"])
                    expected_bytes = int(item["bytes"])
                    expected_chunk_sha = str(item["sha256"]).strip().lower()
                    if not _SHA256_HEX_RE.fullmatch(expected_chunk_sha):
                        raise ValueError("VietOCR V2 checkpoint shard hash is invalid")
                    if is_gdrive_ref(shard_ref):
                        shard_digest = hashlib.sha256()
                        shard_len = 0
                        for block in get_runtime_artifact_router().open_stream(
                            shard_ref,
                            expected_sha256=expected_chunk_sha,
                        ):
                            output.write(block)
                            shard_digest.update(block)
                            digest.update(block)
                            shard_len += len(block)
                        if shard_len != expected_bytes or shard_digest.hexdigest() != expected_chunk_sha:
                            raise ValueError("VietOCR V2 checkpoint shard failed integrity verification")
                    else:
                        data = storage_service.download_object(shard_ref)
                        if len(data) != expected_bytes or hashlib.sha256(data).hexdigest() != expected_chunk_sha:
                            raise ValueError("VietOCR V2 checkpoint shard failed integrity verification")
                        output.write(data)
                        digest.update(data)
            if digest.hexdigest() != expected_sha:
                raise ValueError("assembled VietOCR V2 checkpoint hash mismatch")
            os.replace(temporary, local_path)
        finally:
            if temporary is not None and os.path.exists(temporary):
                os.unlink(temporary)

    custom_config: dict[str, Any] | None = None
    config_sha: str | None = None
    config_meta = manifest.get("config")
    if isinstance(config_meta, dict) and config_meta.get("storage_path"):
        cfg_path = config_meta["storage_path"]
        raw_cfg_sha = config_meta.get("sha256")
        cfg_expected_sha: str | None = None
        if raw_cfg_sha is not None:
            cfg_expected_sha = str(raw_cfg_sha).strip().lower()
            if not _SHA256_HEX_RE.fullmatch(cfg_expected_sha):
                raise ValueError("active VietOCR V2 config hash is invalid")
        cfg_bytes = _download_artifact(cfg_path, expected_hash=cfg_expected_sha)
        cfg_actual_sha = hashlib.sha256(cfg_bytes).hexdigest()
        if cfg_expected_sha and cfg_actual_sha != cfg_expected_sha:
            raise ValueError("active VietOCR V2 config hash mismatch")
        parsed = yaml.safe_load(cfg_bytes.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("active VietOCR V2 config must be a YAML mapping")
        custom_config = parsed
        config_sha = cfg_actual_sha
        local_cfg_path = os.path.join(str(temp_root), f"viread-vietocr-v2-{expected_sha}.yml")
        if Path(local_cfg_path).resolve().parent == temp_root:
            try:
                with open(local_cfg_path, "wb") as f:
                    f.write(cfg_bytes)
            except OSError:
                pass

    return local_path, custom_config, config_sha


def get_loaded_vietocr_runtime_status() -> dict[str, Any]:
    """Read-only snapshot of the actually loaded VietOCR model (never triggers model init)."""
    predictor = _vietocr_engine
    proof: dict[str, Any] | None = None
    if predictor is not None:
        try:
            proof = _vietocr_verified_runtime.get(predictor)
        except TypeError:
            proof = None
    loaded_profile = proof["model_profile"] if proof else (_vietocr_active_profile if predictor is not None else None)
    loaded_sha = proof["checkpoint_sha256"] if proof else _vietocr_active_checkpoint_sha
    loaded_cfg = proof["config_sha256"] if proof else _vietocr_active_config_sha
    return {
        "initialized": predictor is not None,
        "initialization_status": _vietocr_initialization_status,
        "initialization_error": _vietocr_initialization_error,
        "loaded_profile": loaded_profile,
        "loaded_checkpoint_sha256": loaded_sha,
        "loaded_config_sha256": loaded_cfg,
        "verified_runtime_proof": proof is not None,
    }


def _v2_checkpoint_from_storage(active: dict[str, Any]) -> str:
    local_path, _, _ = _v2_artifact_from_storage(active)
    return local_path


def evict_cached_viread_checkpoint(checkpoint_sha256: str) -> bool:
    """Safely unlink cached temp checkpoint weights and config from tempdir."""
    if not isinstance(checkpoint_sha256, str):
        return False
    sha = checkpoint_sha256.strip().lower()
    if not _SHA256_HEX_RE.fullmatch(sha):
        return False
    evicted = False
    temp_root = Path(tempfile.gettempdir()).resolve()
    for ext in (".pth", ".yml", ".yaml"):
        target = os.path.join(str(temp_root), f"viread-vietocr-v2-{sha}{ext}")
        if Path(target).resolve().parent != temp_root:
            continue
        if os.path.isfile(target):
            try:
                os.unlink(target)
                evicted = True
            except OSError as exc:
                logger.warning("Could not evict cached VietOCR file %s: %s", target, exc)
    return evicted


def _install_safe_vietocr_downloaders() -> None:
    """Serve vendored VietOCR YAML configs first and enforce finite HTTP timeouts on fallbacks."""
    try:
        import vietocr.tool.config as vietocr_cfg_mod
        import vietocr.tool.utils as vietocr_utils_mod
    except Exception:
        return
    if getattr(vietocr_cfg_mod, "_viread_safe_download_installed", False):
        return

    vendored_dir = Path(__file__).resolve().parents[3] / "ocr_worker" / "configs"

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
        cache_root = (os.environ.get("VIREAD_OCR_MODEL_CACHE_DIR") or "").strip()
        target_dir = cache_root if cache_root else tempfile.gettempdir()
        os.makedirs(target_dir, exist_ok=True)
        filename = str(uri).rstrip("/").split("/")[-1] or "vgg_transformer.pth"
        full_path = os.path.join(target_dir, filename)
        if os.path.isfile(full_path) and os.path.getsize(full_path) > 0:
            return full_path
        tmp_path = f"{full_path}.{os.getpid()}.downloading"
        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                with requests.get(uri, stream=True, timeout=(10, 120)) as resp:
                    resp.raise_for_status()
                    with open(tmp_path, "wb") as out:
                        for chunk in resp.iter_content(chunk_size=65536):
                            if chunk:
                                out.write(chunk)
                os.replace(tmp_path, full_path)
                return full_path
            except Exception as exc:
                last_exc = exc
                if os.path.exists(tmp_path):
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                if attempt < 2:
                    import time as _time
                    _time.sleep(1.5 * (attempt + 1))
        assert last_exc is not None
        raise last_exc

    vietocr_utils_mod.download_config = _safe_download_config
    vietocr_cfg_mod.download_config = _safe_download_config
    vietocr_utils_mod.download_weights = _safe_download_weights
    vietocr_cfg_mod._viread_safe_download_installed = True


def _find_cached_vietocr_weights() -> str | None:
    temp_dir = os.environ.get("TEMP", os.environ.get("TMP", tempfile.gettempdir()))
    explicit_cache_dir = (os.environ.get("VIREAD_OCR_MODEL_CACHE_DIR") or "").strip()
    candidates = [
        os.path.join(explicit_cache_dir, "vgg_transformer.pth") if explicit_cache_dir else "",
        os.path.join(temp_dir, "vgg_transformer.pth"),
        os.path.expanduser(r"~\AppData\Local\Temp\vgg_transformer.pth"),
        os.path.expanduser("~/.cache/vietocr/vgg_transformer.pth"),
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "weights", "vgg_transformer.pth")),
    ]
    for path in candidates:
        if path and os.path.isfile(path) and os.path.getsize(path) == 151_815_373:
            try:
                if _sha256_path(path) == _ORIGINAL_VIETOCR_SHA256:
                    return path
            except OSError:
                continue
    return None


def _get_ocr_engines() -> tuple[PaddleOCR, Predictor | None]:
    """Initialize PaddleOCR and VietOCR independently.

    PaddleOCR supplies page/line detection regions. VietOCR is an optional
    recognizer for those regions; its initialization failure must not disable
    a working PaddleOCR detector.
    """
    global _paddle_engine, _vietocr_engine
    global _paddle_initialization_status, _vietocr_initialization_status
    global _paddle_initialization_error, _vietocr_initialization_error
    global _vietocr_active_checkpoint_sha, _vietocr_active_profile, _vietocr_active_config_sha
    global _vietocr_active_storage_path
    global _ocr_dependencies_loaded, torch, PaddleOCR, Cfg, Predictor
    global _paddle_import_status, _paddle_import_error
    global _vietocr_import_status, _vietocr_import_error

    # Each scan receives a fresh context, including if _get_ocr_engines fails.
    _scan_runtime_context.provenance = None
    requested_profile: str | None = None
    requested_sha: str | None = None
    load_fallback_reason: str | None = None
    with _engine_lock:
        if not _ocr_dependencies_loaded:
            if torch is None:
                try:
                    import torch as torch_runtime
                    torch = torch_runtime
                except Exception as exc:
                    torch = None
                    try:
                        package_version("torch")
                    except PackageNotFoundError:
                        _vietocr_import_status = "not_installed"
                    else:
                        _vietocr_import_status = "not_initialized"
                    _vietocr_import_error = type(exc).__name__
            if PaddleOCR is None:
                os.environ.setdefault("LMDB_FORCE_CPYTHON", "1")
                if "lmdb.cffi" in sys.modules or (
                    "lmdb" in sys.modules and "lmdb.cpython" not in sys.modules
                ):
                    for _lmdb_mod in ("lmdb", "lmdb.cffi", "lmdb.cpython"):
                        sys.modules.pop(_lmdb_mod, None)
                try:
                    from paddleocr import PaddleOCR as paddle_runtime
                    PaddleOCR = paddle_runtime
                    _paddle_import_status = "success"
                    _paddle_import_error = None
                except Exception as exc:
                    PaddleOCR = None
                    try:
                        package_version("paddleocr")
                    except PackageNotFoundError:
                        _paddle_import_status = "not_installed"
                        _paddle_import_error = None
                    else:
                        _paddle_import_status = "not_initialized"
                        _paddle_import_error = type(exc).__name__
            elif _paddle_import_status not in ("success", "not_installed"):
                _paddle_import_status = "success"
                _paddle_import_error = None
            if Cfg is None or Predictor is None:
                try:
                    from vietocr.tool.config import Cfg as vietocr_config
                    from vietocr.tool.predictor import Predictor as vietocr_predictor
                    _install_safe_vietocr_downloaders()
                    Cfg, Predictor = vietocr_config, vietocr_predictor
                    _vietocr_import_status = "success"
                    _vietocr_import_error = None
                except Exception as exc:
                    Cfg = Predictor = None
                    try:
                        package_version("vietocr")
                    except PackageNotFoundError:
                        _vietocr_import_status = "not_installed"
                        _vietocr_import_error = None
                    else:
                        _vietocr_import_status = "not_initialized"
                        _vietocr_import_error = type(exc).__name__
            elif _vietocr_import_status not in ("success", "not_installed"):
                _vietocr_import_status = "success"
                _vietocr_import_error = None
            _ocr_dependencies_loaded = (
                _paddle_import_status in ("success", "not_installed")
                and _vietocr_import_status in ("success", "not_installed")
            )

        if _paddle_engine is None:
            if PaddleOCR is None:
                _paddle_initialization_status = _paddle_import_status
                _paddle_initialization_error = _paddle_import_error
            else:
                try:
                    _paddle_engine = PaddleOCR(
                        use_angle_cls=False,
                        lang="vi",
                        det_algorithm="DB",
                        det_limit_side_len=2048,
                        det_db_thresh=0.25,
                        det_db_box_thresh=0.18,
                        det_db_unclip_ratio=1.60,
                        det_db_score_mode="slow",
                        drop_score=0.0,
                        show_log=False,
                    )
                    _paddle_initialization_status = "success"
                    _paddle_initialization_error = None
                except Exception as exc:
                    _paddle_initialization_status = "not_initialized"
                    _paddle_initialization_error = type(exc).__name__
                    logger.warning("PaddleOCR initialization failed: %s", type(exc).__name__)

        active_model = _active_viread_model()
        active_profile = str((active_model or {}).get("profile", "ORIGINAL"))
        active_sha = str((active_model or {}).get("checkpoint_sha256", _ORIGINAL_VIETOCR_SHA256)).lower()
        requested_profile, requested_sha = active_profile, active_sha
        if active_profile == "ORIGINAL" and active_sha != _ORIGINAL_VIETOCR_SHA256:
            logger.error("VietOCR registry Original pointer failed baseline hash validation")
            active_model = None
            active_sha = _ORIGINAL_VIETOCR_SHA256
            load_fallback_reason = "invalid_original_registry_pointer"
        if active_profile not in {
            "ORIGINAL", "FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED",
            "FLOW1_VERIFIED", "FLOW2_EXTERNAL_TRDG",
        }:
            active_model = None
            active_profile = "ORIGINAL"
            active_sha = _ORIGINAL_VIETOCR_SHA256
            load_fallback_reason = "unsupported_model_profile"

        candidate_weights_path: str | None = None
        custom_config_dict: dict[str, Any] | None = None
        active_config_sha: str | None = None
        desired_storage_path = (active_model or {}).get("storage_path")
        already_loaded_matching = (
            _vietocr_engine is not None
            and active_sha == _vietocr_active_checkpoint_sha
            and active_profile == _vietocr_active_profile
            and desired_storage_path == _vietocr_active_storage_path
        )

        if active_model and active_profile != "ORIGINAL":
            if already_loaded_matching:
                active_config_sha = _vietocr_active_config_sha
            else:
                try:
                    candidate_weights_path, custom_config_dict, active_config_sha = _v2_artifact_from_storage(active_model)
                except Exception as exc:
                    logger.warning("Could not load fine-tuned VietOCR artifact: %s", type(exc).__name__)
                    load_fallback_reason = "checkpoint_unavailable_or_invalid"
                    active_model = None
                    active_profile = "ORIGINAL"
                    active_sha = _ORIGINAL_VIETOCR_SHA256
                    desired_storage_path = None
                    candidate_weights_path = None
                    custom_config_dict = None
                    active_config_sha = None

        if (_vietocr_engine is None or active_sha != _vietocr_active_checkpoint_sha
                or active_profile != _vietocr_active_profile
                or active_config_sha != _vietocr_active_config_sha):
            if Cfg is None or Predictor is None:
                _vietocr_initialization_status = _vietocr_import_status
                _vietocr_initialization_error = _vietocr_import_error
            else:
                try:
                    viet_config = Cfg.load_config_from_name("vgg_transformer")
                    if torch is None:
                        raise OcrEngineUnavailable("The VietOCR torch runtime is not installed")
                    target_device = "cuda" if torch.cuda.is_available() else "cpu"
                    viet_config["device"] = target_device
                    if isinstance(viet_config.get("cnn"), dict):
                        viet_config["cnn"]["pretrained"] = False

                    if active_model and active_profile != "ORIGINAL" and candidate_weights_path:
                        if custom_config_dict:
                            _deep_merge_dict(viet_config, custom_config_dict)
                            viet_config["device"] = target_device
                            if isinstance(viet_config.get("cnn"), dict):
                                viet_config["cnn"]["pretrained"] = False
                        viet_config["weights"] = candidate_weights_path
                    else:
                        lock_path = Path(__file__).resolve().parents[3] / "ai" / "vietocr_v2" / "original_artifact.json"
                        original_lock = json.loads(lock_path.read_text(encoding="utf-8"))
                        if package_version("vietocr") != original_lock["upstream"]["version"]:
                            raise ValueError("VietOCR package version differs from the locked Original runtime")
                        locked_architecture = original_lock["architecture"]
                        current_architecture = {
                            "backbone": viet_config.get("backbone"),
                            "cnn": {key: viet_config.get("cnn", {}).get(key) for key in ("ss", "ks", "hidden")},
                            "seq_modeling": viet_config.get("seq_modeling"),
                            "transformer": dict(viet_config.get("transformer", {})),
                            "input": {key: viet_config.get("dataset", {}).get(key) for key in ("image_height", "image_min_width", "image_max_width")},
                        }
                        if current_architecture != locked_architecture:
                            raise ValueError("VietOCR Original architecture differs from its locked config")
                        vocab = unicodedata.normalize("NFC", str(viet_config.get("vocab", "")))
                        vocab_sha = hashlib.sha256(json.dumps(vocab, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
                        if len(vocab) != _ORIGINAL_VOCAB_SIZE or vocab_sha != _ORIGINAL_VOCAB_SHA256:
                            raise ValueError("VietOCR Original vocabulary does not match the locked baseline")
                        cached_weight = _find_cached_vietocr_weights()
                        if cached_weight is None:
                            from vietocr.tool.utils import download_weights

                            cached_weight = download_weights(viet_config["weights"], quiet=True)
                        if _sha256_path(cached_weight) != _ORIGINAL_VIETOCR_SHA256:
                            raise ValueError("VietOCR Original checkpoint hash mismatch")
                        viet_config["weights"] = cached_weight

                    if target_device == "cpu":
                        env_threads = (
                            os.getenv("VIREAD_OCR_CPU_THREADS")
                            or os.getenv("OMP_NUM_THREADS")
                            or ""
                        ).strip()
                        cpu_count = os.cpu_count() or 1
                        default_threads = (
                            min(2, max(1, cpu_count))
                            if (os.getenv("RENDER") or cpu_count <= 2)
                            else min(4, max(1, cpu_count))
                        )
                        try:
                            desired_threads = (
                                max(1, min(8, int(env_threads)))
                                if env_threads
                                else default_threads
                            )
                        except ValueError:
                            desired_threads = default_threads
                        torch.set_num_threads(desired_threads)
                    # Final on-disk verification immediately precedes publication
                    # of this instance. All scans using it receive this digest,
                    # even if the registry changes in a concurrent request.
                    verified_checkpoint_sha = _sha256_path(viet_config["weights"])
                    if verified_checkpoint_sha != active_sha:
                        raise ValueError("Loaded VietOCR checkpoint hash differs from expected")
                    next_engine = Predictor(viet_config)
                    _verified_vietocr_instance(
                        next_engine,
                        model_profile=active_profile,
                        checkpoint_sha256=verified_checkpoint_sha,
                        config_sha256=active_config_sha,
                    )
                    _vietocr_engine = next_engine
                    _vietocr_active_checkpoint_sha = active_sha
                    _vietocr_active_profile = active_profile
                    _vietocr_active_config_sha = active_config_sha
                    _vietocr_active_storage_path = (
                        desired_storage_path if (active_model and active_profile != "ORIGINAL") else None
                    )
                    _vietocr_initialization_status = "success"
                    _vietocr_initialization_error = None
                except Exception as exc:
                    _vietocr_initialization_status = "not_initialized"
                    _vietocr_initialization_error = type(exc).__name__
                    load_fallback_reason = load_fallback_reason or "model_initialization_failed"
                    logger.warning("VietOCR initialization failed: %s", type(exc).__name__)

        _scan_runtime_context.provenance = _scan_vietocr_snapshot(
            _vietocr_engine,
            requested_profile=requested_profile,
            requested_sha=requested_sha,
            fallback_reason=load_fallback_reason,
        )

    if _paddle_engine is None:
        raise OcrEngineUnavailable(
            "PaddleOCR detector is unavailable "
            f"(status={_paddle_initialization_status}, "
            f"error={_paddle_initialization_error or 'none'})."
        )
    return _paddle_engine, _vietocr_engine

def warmup_ocr_engines() -> None:
    try:
        _get_ocr_engines()
    except Exception as exc:
        logger.warning(f"Preload OCR Engine thất bại: {exc}")




def strip_accents(text: str) -> str:
    text = unicodedata.normalize("NFD", text)
    text = re.sub(r"[\u0300-\u036f]", "", text)
    text = text.replace("đ", "d").replace("Đ", "D")
    return re.sub(r"[^a-zA-Z0-9\s]", "", text).lower().strip()


def clean_ocr_punctuation(text: str) -> str:
    text = re.sub(r'(^|\s)\?(?=[A-ZÀ-Ỹa-zà-ỹ])', r'\1"', text)
    text = re.sub(r'\.{2,3}3[\?\"]*', '...?"', text)
    return text.strip()


def _transfer_punctuation(viet_text: str, paddle_text: str) -> str:
    v_clean = viet_text.strip()
    p_clean = paddle_text.strip()
    if not v_clean or not p_clean:
        return v_clean

    trailing_punct_match = re.search(r"([,!?:;\"'…]+)$", p_clean)
    if trailing_punct_match and not re.search(r"[,!?:;\"'…]$", v_clean):
        v_clean = v_clean + trailing_punct_match.group(1)

    leading_punct_match = re.match(r"^([\"'“—–-]+)", p_clean)
    if leading_punct_match and not re.match(r"^[\"'“—–-]", v_clean):
        v_clean = leading_punct_match.group(1) + v_clean

    return v_clean


_VIETOCR_SPECIAL_TOKEN_RE = re.compile(r"<(?:pad|sos|eos|unk)>", re.IGNORECASE)


def _sanitize_vietocr_prediction(raw_text: str | None) -> tuple[str | None, bool]:
    """Strip seq2seq decoder control tokens (`<pad>`, `<sos>`, `<eos>`, `<unk>`) without altering normal text."""
    if not isinstance(raw_text, str):
        return None, False
    had_control_token = bool(_VIETOCR_SPECIAL_TOKEN_RE.search(raw_text))
    cleaned = _VIETOCR_SPECIAL_TOKEN_RE.sub("", raw_text)
    cleaned = re.sub(r"\s+", " ", unicodedata.normalize("NFC", cleaned)).strip()
    return (cleaned if cleaned else None), had_control_token


def is_vietocr_reliable(
    viet_text: str,
    paddle_text: str,
    paddle_conf: float = 0.90,
    max_cer: float = 0.40,
) -> bool:
    """Reject obvious empty/repetition/control-token outputs, not select OCR correctness.

    A True result means only that VietOCR can be shown as a provisional draft.
    It does not mean the candidate is better than PaddleOCR or that its words
    are correct. Diacritic-folded CER and line-level confidence are excluded.
    """
    del paddle_text, paddle_conf, max_cer
    if not isinstance(viet_text, str) or _VIETOCR_SPECIAL_TOKEN_RE.search(viet_text):
        return False
    candidate = unicodedata.normalize("NFC", viet_text).strip()
    if not candidate:
        return False
    words = candidate.split()
    if len(words) >= 3:
        for index in range(len(words) - 2):
            if words[index].casefold() == words[index + 1].casefold() == words[index + 2].casefold():
                return False
    return True


DUAL_ENGINE_EVIDENCE_CONTRACT = "dual_engine_agreement_v2"
PADDLE_LINE_SCORE_CONTRACT = "paddle_line_score_v1"


def _split_merge_operations_by_source_index(
    candidates: list[dict[str, object]],
    selected_engine: str,
    paddle_entries: list[tuple[int, str]],
    vietocr_entries: list[tuple[int, str]],
) -> dict[int, str]:
    """Map split/merge candidates back to original indexes of the selected engine.

    Candidate indexes are positions in filtered token arrays. Word evidence
    indexes refer to original whitespace tokens, so this mapping must pass
    through the engine's source-index entries. Invalid mappings are not guessed.
    """
    if selected_engine == "paddleocr":
        selected_key = "primary_indices"
        selected_entries = paddle_entries
    elif selected_engine == "vietocr":
        selected_key = "secondary_indices"
        selected_entries = vietocr_entries
    else:
        return {}

    operations_by_source_index: dict[int, set[str]] = {}
    for candidate in candidates:
        operation = candidate.get("operation")
        indexes = candidate.get(selected_key)
        if operation not in {"split", "merge"} or not isinstance(indexes, (list, tuple)) or not indexes:
            continue
        mapped_indexes: list[int] = []
        safe_mapping = True
        for compact_index in indexes:
            if (
                isinstance(compact_index, bool)
                or not isinstance(compact_index, int)
                or compact_index < 0
                or compact_index >= len(selected_entries)
            ):
                safe_mapping = False
                break
            source_index = selected_entries[compact_index][0]
            if isinstance(source_index, bool) or not isinstance(source_index, int) or source_index < 0:
                safe_mapping = False
                break
            mapped_indexes.append(source_index)
        if not safe_mapping:
            continue
        for source_index in mapped_indexes:
            operations_by_source_index.setdefault(source_index, set()).add(str(operation))

    return {
        source_index: next(iter(operations)) if len(operations) == 1 else "unresolved"
        for source_index, operations in operations_by_source_index.items()
    }


def _word_engine_evidence(
    recognized_word: str,
    other_engine_word: str | None,
) -> tuple[float | None, str]:
    recognized = _token_surface(recognized_word)
    other = _token_surface(other_engine_word or "")
    if not recognized or not other:
        return None, "needs_review"
    if recognized == other:
        return 1.0, "engine_agreement"
    try:
        _jiwer = _ensure_jiwer()
        cer_val = (
            float(_jiwer.cer(recognized.casefold(), other.casefold()))
            if _jiwer is not None
            else _fallback_cer(recognized.casefold(), other.casefold())
        )
        similarity = max(0.0, min(1.0, 1.0 - cer_val))
    except (TypeError, ValueError, ZeroDivisionError):
        similarity = None
    return (round(similarity, 4) if similarity is not None else None), "engine_disagreement"


def _word_ocr_evidence(
    recognized_word: str,
    other_engine_word: str | None,
    line_confidence: float | None = None,
) -> tuple[None, str, None]:
    """Compatibility wrapper: engine evidence never becomes word probability."""
    del line_confidence
    _, status = _word_engine_evidence(recognized_word, other_engine_word)
    return None, status, None


def _tesseract_review_status(_confidence: float | None) -> str:
    """A raw score from one engine cannot establish correctness."""
    return "needs_review"


def _order_quad_points(pts: np.ndarray) -> np.ndarray:
    pts = np.array(pts, dtype=np.float32)
    x_sorted = pts[np.argsort(pts[:, 0])]
    left_pts = x_sorted[:2]
    right_pts = x_sorted[2:]
    tl, bl = left_pts[np.argsort(left_pts[:, 1])]
    tr, br = right_pts[np.argsort(right_pts[:, 1])]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def _dewarp_strip_with_safe_border(
    rect_img: np.ndarray, v_curve: np.ndarray, strip_h: int
) -> np.ndarray:
    crop_h, crop_w = rect_img.shape[:2]
    strip_h = max(24, int(strip_h))
    u_grid = np.broadcast_to(
        np.arange(crop_w, dtype=np.float32)[None, :], (strip_h, crop_w)
    ).copy()
    v_offsets = (
        np.arange(strip_h, dtype=np.float32)[:, None] - (strip_h / 2.0)
    )
    v_grid = np.clip(v_curve[None, :] + v_offsets, 0.0, float(crop_h - 1)).astype(
        np.float32
    )

    dewarped = cv2.remap(
        rect_img,
        u_grid,
        v_grid,
        interpolation=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )

    pad_horiz = max(16, int(strip_h * 0.30))
    pad_vert = max(12, int(strip_h * 0.22))
    return cv2.copyMakeBorder(
        dewarped,
        top=pad_vert,
        bottom=pad_vert,
        left=pad_horiz,
        right=pad_horiz,
        borderType=cv2.BORDER_CONSTANT,
        value=[255, 255, 255],
    )


def _clamp_normalized_bbox(
    left: float,
    top: float,
    width: float,
    height: float,
    orig_width: int,
    orig_height: int,
) -> list[float] | None:
    if orig_width <= 0 or orig_height <= 0:
        return None
    if not all(
        isinstance(val, (int, float))
        and not isinstance(val, (bool, np.bool_))
        and math.isfinite(float(val))
        for val in (left, top, width, height)
    ):
        return None
    orig_w_f = float(orig_width)
    orig_h_f = float(orig_height)
    left_f = float(left)
    top_f = float(top)
    width_f = float(width)
    height_f = float(height)
    x0 = max(0.0, min(1.0, left_f / orig_w_f))
    y0 = max(0.0, min(1.0, top_f / orig_h_f))
    if left_f >= 0.0 and (left_f + width_f) <= orig_w_f:
        span_w = max(0.0, width_f / orig_w_f)
    else:
        x1 = max(0.0, min(1.0, (left_f + width_f) / orig_w_f))
        span_w = max(0.0, x1 - x0)
    if top_f >= 0.0 and (top_f + height_f) <= orig_h_f:
        span_h = max(0.0, height_f / orig_h_f)
    else:
        y1 = max(0.0, min(1.0, (top_f + height_f) / orig_h_f))
        span_h = max(0.0, y1 - y0)
    norm_x = max(0.0, min(0.9999, x0))
    norm_y = max(0.0, min(0.9999, y0))
    max_w = max(0.0001, 1.0 - norm_x)
    max_h = max(0.0001, 1.0 - norm_y)
    norm_w = max(0.0001, min(max_w, span_w))
    norm_h = max(0.0001, min(max_h, span_h))
    if norm_x + norm_w > 1.0:
        norm_w = max(0.0001, math.nextafter(1.0 - norm_x, 0.0))
    if norm_y + norm_h > 1.0:
        norm_h = max(0.0001, math.nextafter(1.0 - norm_y, 0.0))
    return [norm_x, norm_y, norm_w, norm_h]


def _extract_curved_lines_from_items(
    raw_items: list, image: np.ndarray
) -> list[dict[str, Any]]:
    if (
        not raw_items
        or image is None
        or getattr(image, "size", 0) == 0
        or getattr(image, "ndim", 0) < 2
    ):
        return []

    img_h, img_w = image.shape[:2]
    if img_h < 2 or img_w < 2:
        return []
    temp_items = []

    for raw in raw_items:
        if not raw or len(raw) == 0:
            continue
        try:
            pts = _order_quad_points(raw[0])
        except Exception:
            continue
        if pts.shape != (4, 2) or not np.all(np.isfinite(pts)):
            continue
        p_text = str(raw[1][0]) if (len(raw) > 1 and raw[1]) else ""
        try:
            raw_confidence = raw[1][1] if (len(raw) > 1 and raw[1]) else None
            p_conf = (
                float("nan")
                if raw_confidence is None or isinstance(raw_confidence, (bool, np.bool_))
                else float(raw_confidence)
            )
        except (TypeError, ValueError, OverflowError):
            p_conf = float("nan")

        raw_w = max(np.linalg.norm(pts[0] - pts[1]), np.linalg.norm(pts[2] - pts[3]))
        raw_h = max(np.linalg.norm(pts[0] - pts[3]), np.linalg.norm(pts[1] - pts[2]))

        if not (math.isfinite(float(raw_w)) and math.isfinite(float(raw_h))) or raw_w < 8 or raw_h < 8:
            continue

        vec_x = (pts[1] - pts[0]) / max(1.0, float(raw_w))
        vec_y = (pts[3] - pts[0]) / max(1.0, float(raw_h))
        pad_x = max(6.0, raw_h * 0.22)
        pad_y = max(4.0, raw_h * 0.20)

        padded_pts = pts.copy()
        padded_pts[0] -= vec_x * pad_x + vec_y * pad_y
        padded_pts[1] += vec_x * pad_x - vec_y * pad_y
        padded_pts[2] += vec_x * pad_x + vec_y * pad_y
        padded_pts[3] -= vec_x * pad_x - vec_y * pad_y

        padded_pts[:, 0] = np.clip(padded_pts[:, 0], 0, img_w - 1)
        padded_pts[:, 1] = np.clip(padded_pts[:, 1], 0, img_h - 1)
        if not np.all(np.isfinite(padded_pts)):
            continue

        crop_w = int(max(np.linalg.norm(padded_pts[0] - padded_pts[1]), np.linalg.norm(padded_pts[2] - padded_pts[3])))
        crop_h = int(max(np.linalg.norm(padded_pts[0] - padded_pts[3]), np.linalg.norm(padded_pts[1] - padded_pts[2])))
        if crop_w < 2 or crop_h < 2:
            continue
        px = padded_pts[:, 0]
        py = padded_pts[:, 1]
        poly_area = 0.5 * abs(float(np.dot(px, np.roll(py, -1)) - np.dot(py, np.roll(px, -1))))
        if not math.isfinite(poly_area) or poly_area < 1.0:
            continue

        temp_items.append((padded_pts, crop_w, crop_h, p_text, p_conf))

    if not temp_items:
        return []

    extracted: list[dict[str, Any]] = []

    for pts, crop_w, crop_h, p_text, p_conf in temp_items:
        pts_std = np.float32([[0, 0], [crop_w, 0], [crop_w, crop_h], [0, crop_h]])
        try:
            matrix = cv2.getPerspectiveTransform(pts.astype(np.float32), pts_std)
            if (
                matrix is None
                or matrix.shape != (3, 3)
                or not np.all(np.isfinite(matrix))
                or abs(float(np.linalg.det(matrix))) < 1e-12
            ):
                continue
            rect_img = cv2.warpPerspective(
                image,
                matrix,
                (crop_w, crop_h),
                borderMode=cv2.BORDER_REPLICATE,
                flags=cv2.INTER_CUBIC,
            )
            if (
                rect_img is None
                or getattr(rect_img, "size", 0) == 0
                or rect_img.shape[0] < 1
                or rect_img.shape[1] < 1
            ):
                continue

            # VietOCR scales every line to a fixed 32 px height. The quad is
            # already padded by ~20% of the text height, which keeps Vietnamese
            # marks inside the crop; stretching it further (the previous 1.3x
            # strip plus a white frame) only shrank the glyphs and made tone marks
            # such as hỏi/huyền indistinguishable. Measured on the ground-truth
            # fixtures: line word accuracy 90.5% -> 97.8%, CER 0.032 -> 0.015
            # (docs/ocr-color-benchmark.md).
            dewarped_img = cv2.copyMakeBorder(
                rect_img, 4, 4, 8, 8, cv2.BORDER_REPLICATE
            )
        except (cv2.error, ValueError, np.linalg.LinAlgError):
            continue

        tl, tr, br, bl = pts[0], pts[1], pts[2], pts[3]

        extracted.append({
            "quad": pts,
            "crop_w": crop_w,
            "crop_h": crop_h,
            "rect_img": rect_img,
            "band_h": float(crop_h),
            "dewarped_img": dewarped_img,
            "paddle_text": p_text,
            "paddle_conf": p_conf,
            "yc": float((tl[1] + tr[1] + br[1] + bl[1]) / 4.0),
            "xc": float((tl[0] + tr[0] + br[0] + bl[0]) / 4.0),
            "x0": float(min(tl[0], bl[0])),
        })

    return extracted


def sort_reading_order_adaptive(
    raw_items: list, img_width: int, image: np.ndarray
) -> tuple[list[dict[str, Any]], str]:
    items = _extract_curved_lines_from_items(raw_items, image)
    if not items:
        return [], "empty"

    # Cluster boxes whose vertical centers fall within a single visual line band
    # so skewed photos or split horizontal lines always read left-to-right.
    items.sort(key=lambda it: (it["yc"], it.get("x0", it.get("xc", 0.0))))
    heights = sorted(max(4.0, float(it.get("band_h", 12.0))) for it in items)
    median_h = heights[len(heights) // 2] if heights else 12.0
    bands: list[list[dict[str, Any]]] = []
    for item in items:
        placed = False
        if bands:
            current_band = bands[-1]
            band_yc = sum(float(member["yc"]) for member in current_band) / len(current_band)
            band_h = min(median_h, max(float(member.get("band_h", median_h)) for member in current_band))
            if abs(float(item["yc"]) - band_yc) <= max(4.0, 0.5 * band_h):
                current_band.append(item)
                placed = True
        if not placed:
            bands.append([item])

    ordered: list[dict[str, Any]] = []
    for band in bands:
        band.sort(key=lambda it: (it.get("x0", it.get("xc", 0.0)), it["yc"]))
        ordered.extend(band)
    return ordered, "single_column"


def _segment_words_by_ink(
    rect_img: np.ndarray, words: list[str], *, geometry: dict[str, Any] | None = None
) -> list[tuple[float, float, float, float]]:
    if geometry is not None:
        geometry["reliable"] = False
    num_words = len(words)
    if (
        num_words == 0
        or rect_img is None
        or getattr(rect_img, "size", 0) == 0
        or getattr(rect_img, "ndim", 0) < 2
    ):
        return []
    c_h, c_w = rect_img.shape[:2]
    if c_w < 8 or c_h < 6:
        return []

    # Segment glyphs, not the dark background surrounding light text.
    # Keep original coordinates: normalization changes intensity only.
    raw_gray = (
        rect_img
        if rect_img.ndim == 2
        else cv2.cvtColor(rect_img, cv2.COLOR_BGR2GRAY)
    )
    gray = _normalize_text_background(raw_gray)
    block_sz = max(11, (c_h | 1))
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block_sz, 10
    )

    binary[0:1, :] = 0
    binary[-1:, :] = 0
    binary[:, 0:1] = 0
    binary[:, -1:] = 0

    row_ink = np.where(np.sum(binary > 0, axis=1) >= 1)[0]
    if len(row_ink) > 0:
        line_y0 = max(0, int(row_ink[0]) - 3)
        line_y1 = min(c_h, int(row_ink[-1]) + 4)
    else:
        line_y0 = 0
        line_y1 = c_h

    norm_y0 = float(line_y0) / c_h
    norm_y1 = float(line_y1) / c_h

    v_proj = np.sum(binary[line_y0:line_y1, :] > 0, axis=0)
    has_ink = v_proj > 0
    ink_cols = np.where(has_ink)[0]

    if len(ink_cols) == 0:
        step = 1.0 / num_words
        return [(i * step, norm_y0, (i + 1) * step, norm_y1) for i in range(num_words)]

    first_ink = int(ink_cols[0])
    last_ink = int(ink_cols[-1])

    if num_words == 1:
        if geometry is not None:
            geometry["reliable"] = True
        return [(max(0.0, (first_ink - 3) / c_w), norm_y0, min(1.0, (last_ink + 4) / c_w), norm_y1)]

    best_segments = None
    best_diff = 999

    for k in range(3, min(28, max(6, int(c_h * 0.75)))):
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1))
        dilated = cv2.dilate(binary, kernel)

        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(dilated)
        comps = []
        for lbl in range(1, num_labels):
            area = stats[lbl, cv2.CC_STAT_AREA]
            w = stats[lbl, cv2.CC_STAT_WIDTH]
            h = stats[lbl, cv2.CC_STAT_HEIGHT]
            if area >= 8 and w >= 3 and h >= 4:
                comps.append([
                    stats[lbl, cv2.CC_STAT_LEFT],
                    stats[lbl, cv2.CC_STAT_WIDTH],
                    stats[lbl, cv2.CC_STAT_TOP],
                    stats[lbl, cv2.CC_STAT_HEIGHT],
                ])

        comps.sort(key=lambda c: c[0])

        merged_comps: list[list[int]] = []
        for comp in comps:
            if not merged_comps:
                merged_comps.append(list(comp))
            else:
                prev = merged_comps[-1]
                if comp[0] <= prev[0] + prev[1]:
                    new_r = max(prev[0] + prev[1], comp[0] + comp[1])
                    new_top = min(prev[2], comp[2])
                    new_bot = max(prev[2] + prev[3], comp[2] + comp[3])
                    prev[0] = min(prev[0], comp[0])
                    prev[1] = new_r - prev[0]
                    prev[2] = new_top
                    prev[3] = new_bot - new_top
                else:
                    merged_comps.append(list(comp))

        diff = abs(len(merged_comps) - num_words)
        if diff < best_diff:
            best_diff = diff
            best_segments = merged_comps
            if diff == 0:
                break

    if not best_segments:
        step = 1.0 / num_words
        return [(i * step, norm_y0, (i + 1) * step, norm_y1) for i in range(num_words)]

    # Equal-count connected glyph groups are evidence; forced splits/merges
    # and blank crops may retain positions for review, but never enable overlay.
    if geometry is not None:
        geometry["reliable"] = len(best_segments) == num_words

    while len(best_segments) > num_words:
        min_gap = 1e9
        min_idx = 0
        for i in range(len(best_segments) - 1):
            gap = best_segments[i + 1][0] - (best_segments[i][0] + best_segments[i][1])
            if gap < min_gap:
                min_gap = gap
                min_idx = i
        c1 = best_segments[min_idx]
        c2 = best_segments[min_idx + 1]
        new_r = max(c1[0] + c1[1], c2[0] + c2[1])
        new_top = min(c1[2], c2[2])
        new_bot = max(c1[2] + c1[3], c2[2] + c2[3])
        merged = [min(c1[0], c2[0]), new_r - min(c1[0], c2[0]), new_top, new_bot - new_top]
        best_segments = best_segments[:min_idx] + [merged] + best_segments[min_idx + 2:]

    while len(best_segments) < num_words:
        widest_idx = int(np.argmax([c[1] for c in best_segments]))
        c = best_segments[widest_idx]
        x_start = c[0]
        x_end = c[0] + c[1]
        mid_left = x_start + int(c[1] * 0.25)
        mid_right = x_start + int(c[1] * 0.75)
        if mid_left < mid_right and mid_left >= 0 and mid_right <= len(v_proj):
            split_pt = mid_left + int(np.argmin(v_proj[mid_left:mid_right]))
        else:
            split_pt = (x_start + x_end) // 2

        c_left = [x_start, max(2, split_pt - x_start), c[2], c[3]]
        c_right = [split_pt, max(2, x_end - split_pt), c[2], c[3]]
        best_segments = best_segments[:widest_idx] + [c_left, c_right] + best_segments[widest_idx + 1:]

    result_boxes: list[tuple[float, float, float, float]] = []
    for i, comp in enumerate(best_segments):
        x_start = max(0, min(c_w - 1, comp[0]))
        x_end = max(x_start + 1, min(c_w, comp[0] + comp[1]))

        sub_bin = binary[:, x_start:x_end]
        sub_cols = np.where(np.sum(sub_bin > 0, axis=0) > 0)[0]

        if len(sub_cols) > 0:
            real_x0 = x_start + int(sub_cols[0])
            real_x1 = x_start + int(sub_cols[-1]) + 1
        else:
            real_x0 = x_start
            real_x1 = x_end

        box_x0 = max(0.0, float(real_x0 - 3) / c_w)
        box_x1 = min(1.0, float(real_x1 + 3) / c_w)

        result_boxes.append((box_x0, norm_y0, box_x1, norm_y1))

    gap_norm = 2.0 / c_w
    for i in range(len(result_boxes) - 1):
        b1 = result_boxes[i]
        b2 = result_boxes[i + 1]
        if b1[2] >= b2[0]:
            mid = (b1[2] + b2[0]) / 2.0
            result_boxes[i] = (b1[0], b1[1], max(b1[0] + 0.002, mid - gap_norm / 2.0), b1[3])
            result_boxes[i + 1] = (min(b2[2] - 0.002, mid + gap_norm / 2.0), b2[1], b2[2], b2[3])

    return result_boxes


def _map_curved_word_boxes(
    words: list[str],
    item: dict[str, Any],
    orig_width: int,
    orig_height: int,
    *, geometry: dict[str, Any] | None = None,
) -> list[list[float]]:
    if not words or orig_width <= 0 or orig_height <= 0:
        return []

    rect_img = item["rect_img"]
    pts = item["quad"]
    tl, tr, br, bl = pts[0], pts[1], pts[2], pts[3]

    word_spans = _segment_words_by_ink(rect_img, words, geometry=geometry)
    if len(word_spans) != len(words):
        if geometry is not None:
            geometry["reliable"] = False
        step = 1.0 / len(words)
        word_spans = [(i * step, 0.0, (i + 1) * step, 1.0) for i in range(len(words))]
    boxes: list[list[float]] = []

    for rx0, ry0, rx1, ry1 in word_spans:
        pt_tl = (tl + rx0 * (tr - tl)) + ry0 * ((bl + rx0 * (br - bl)) - (tl + rx0 * (tr - tl)))
        pt_tr = (tl + rx1 * (tr - tl)) + ry0 * ((bl + rx1 * (br - bl)) - (tl + rx1 * (tr - tl)))
        pt_bl = (tl + rx0 * (tr - tl)) + ry1 * ((bl + rx0 * (br - bl)) - (tl + rx0 * (tr - tl)))
        pt_br = (tl + rx1 * (tr - tl)) + ry1 * ((bl + rx1 * (br - bl)) - (tl + rx1 * (tr - tl)))

        word_xmin = float(min(pt_tl[0], pt_tr[0], pt_bl[0], pt_br[0]))
        word_xmax = float(max(pt_tl[0], pt_tr[0], pt_bl[0], pt_br[0]))
        word_ymin = float(min(pt_tl[1], pt_tr[1], pt_bl[1], pt_br[1]))
        word_ymax = float(max(pt_tl[1], pt_tr[1], pt_bl[1], pt_br[1]))

        clamped = _clamp_normalized_bbox(
            word_xmin,
            word_ymin,
            word_xmax - word_xmin,
            word_ymax - word_ymin,
            orig_width,
            orig_height,
        )
        boxes.append(clamped or [0.0, 0.0, 0.0001, 0.0001])

    return boxes


def _resolve_tesseract_command() -> str | None:
    configured_binary = os.getenv("TESSERACT_CMD") or shutil.which("tesseract")
    if not configured_binary:
        install_directories = [
            os.getenv("ProgramFiles"),
            os.getenv("ProgramFiles(x86)"),
        ]
        configured_binary = next(
            (
                str(Path(directory) / "Tesseract-OCR" / "tesseract.exe")
                for directory in install_directories
                if directory
                and (Path(directory) / "Tesseract-OCR" / "tesseract.exe").is_file()
            ),
            None,
        )
    return configured_binary


def _extract_text_and_boxes_tesseract(image_bytes: bytes) -> dict[str, object]:
    """Fallback Tesseract cho môi trường CI headless không có GPU/PaddleOCR."""
    _pt, _output = _ensure_pytesseract()
    if _pt is None:
        raise OcrEngineUnavailable("pytesseract is not installed")
    configured_binary = _resolve_tesseract_command()
    if configured_binary:
        with _tesseract_config_lock:
            _pt.pytesseract.tesseract_cmd = configured_binary.strip('"\'')
        _ensure_tesseract_language_data()

    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None or getattr(image, "size", 0) == 0 or getattr(image, "ndim", 0) < 2:
        raise ValueError("Image decoding failed")
    orig_height, orig_width = image.shape[:2]
    if orig_width <= 0 or orig_height <= 0:
        raise ValueError("Image decoding failed")

    target_lang = os.getenv("TESSERACT_LANG", "vie")
    gray = _normalize_text_background(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    try:
        dict_output = getattr(_output, "DICT", "dict")
        result = _pt.image_to_data(
            otsu,
            lang=target_lang,
            config="--oem 1 --psm 6",
            output_type=dict_output,
        )
    except Exception as exc:
        raise OcrEngineUnavailable("Tesseract execution failed") from exc

    words: list[dict[str, object]] = []
    lines: dict[tuple[int, int, int], list[str]] = {}
    line_index_map: dict[tuple[int, int, int], int] = {}

    for index, raw_text in enumerate(result.get("text", [])):
        token = unicodedata.normalize("NFC", str(raw_text)).strip()
        if not token or not any(c.isalnum() for c in token):
            continue
        try:
            left = int(result["left"][index])
            top = int(result["top"][index])
            w = int(result["width"][index])
            h = int(result["height"][index])
            conf = float(result["conf"][index])
            block_num = max(0, int(result.get("block_num", [0] * (index + 1))[index]))
            par_num = max(0, int(result.get("par_num", [0] * (index + 1))[index]))
            line_num = max(0, int(result["line_num"][index]))
        except (KeyError, TypeError, ValueError, IndexError):
            continue

        normalized = normalize_word(token)
        if not normalized:
            continue

        clamped_bbox = _normalized_box((left, top, w, h), orig_width, orig_height)
        if clamped_bbox is None:
            continue

        line_key = (block_num, par_num, line_num)
        if line_key not in line_index_map:
            line_index_map[line_key] = len(line_index_map)
        seq_line_index = line_index_map[line_key]

        confidence = conf / 100.0 if (math.isfinite(conf) and 0 <= conf <= 100) else None
        words.append({
            "word_index": len(words),
            "line_index": seq_line_index,
            "text": token,
            "normalized_text": normalized,
            "bbox": clamped_bbox,
            "ocr_confidence": confidence,
            "ocr_score_source": "tesseract_raw_word_score_v1" if confidence is not None else None,
            "ocr_review_status": _tesseract_review_status(confidence),
            "ocr_evidence": {
                "contract": "tesseract_raw_word_score_v1",
                "engine_outputs": {"tesseract": token},
                "source_text": token,
                "selected_engine": "tesseract",
                "selection_reason": "dual_engine_unavailable_tesseract_fallback",
                "alignment": "single_engine",
                "engine_agreement_score": None,
                "calibrated_word_accuracy": None,
                "verification_source": None,
                "reference_text": None,
                "review_reason": "Chỉ có điểm thô từ một engine; Admin cần xác minh nội dung.",
            },
        })
        lines.setdefault(line_key, []).append(token)

    if not words:
        raise OcrNoTextDetected("Tesseract did not detect usable Vietnamese text")

    formatted_text = "\n".join(" ".join(lines[k]) for k in line_index_map)
    return {
        "text": formatted_text,
        "words": words,
        "metadata": {
            "engine": "tesseract",
            "word_box_geometry": build_geometry_evidence(words, orig_width, orig_height, reliable=True),
            "ocr_score_contract": "tesseract_raw_word_score_v1",
            "ocr_evidence_contract": "tesseract_raw_word_score_v1",
            "language": target_lang,
            "word_count": len(words),
            "line_count": len(lines),
        },
    }


def _package_version(distribution: str) -> str | None:
    try:
        return package_version(distribution)
    except PackageNotFoundError:
        return None


def _raw_recognition_score(value: Any) -> object:
    """Keep model output scores raw; never reinterpret them as accuracy."""
    if value is None:
        return None
    if torch is not None and torch.is_tensor(value):
        value = value.detach().cpu().tolist()
    elif isinstance(value, np.ndarray):
        value = value.tolist()
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if np.isfinite(number) else None
    if isinstance(value, (list, tuple)):
        safe = []
        for item in value[:128]:
            if isinstance(item, bool):
                safe.append(None)
            elif isinstance(item, (int, float)):
                number = float(item)
                safe.append(number if np.isfinite(number) else None)
            else:
                safe.append(None)
        return safe
    return None


def _recognize_uncertain_word_crops(
    image: np.ndarray,
    words: list[dict[str, object]],
    paddle_engine: Any,
    vietocr_engine: Any | None,
) -> dict[str, object]:
    """Re-recognize disputed words with already-loaded recognition models."""
    import time

    started = time.perf_counter()
    prepared: list[tuple[dict[str, object], np.ndarray, dict[str, Any]]] = []
    rejected_bbox = 0
    rejected_quality = 0
    capped = 0
    bbox_validated = 0
    for word in words:
        evidence = word.get("ocr_evidence")
        if not isinstance(evidence, dict):
            continue

        # Validate geometry and image signal even when the full-line engines agree.
        # Agreement is not correctness and must not hide a clipped/invalid word box.
        crop, quality = crop_word_region(image, word.get("bbox"))
        bbox_validated += 1
        evidence["bbox_quality"] = quality.get("bbox_quality")
        evidence["crop_quality"] = quality.get("crop_quality")

        # A crop is needed only while independent engines have not already
        # settled on the stored token at line level.
        line_decision = adjudicate_word(evidence)
        engine_agrees = (
            line_decision["status"] == "resolved"
            and line_decision["text"] == normalize_word(str(word.get("text", "")))
        )
        if engine_agrees and quality.get("bbox_quality") == "valid" and quality.get("crop_quality") == "usable":
            evidence["crop_evidence"] = {
                **quality,
                "status": "not_needed",
                "reason": "engines_agree_but_agreement_is_not_verification",
                "score_semantics": "raw_recognition_output_not_probability",
            }
            continue

        if crop is None:
            if quality.get("bbox_quality") != "valid":
                rejected_bbox += 1
            else:
                rejected_quality += 1
            evidence["crop_evidence"] = {
                **quality, "status": "skipped",
                "score_semantics": "raw_recognition_output_not_probability",
            }
            continue
        if quality.get("crop_quality") != "usable":
            rejected_quality += 1
            evidence["crop_evidence"] = {
                **quality, "status": "skipped",
                "score_semantics": "raw_recognition_output_not_probability",
            }
            continue
        if len(prepared) >= MAX_SELECTIVE_WORD_CROPS_PER_PAGE:
            capped += 1
            evidence["crop_evidence"] = {
                **quality,
                "status": "skipped",
                "reason": "per_page_selective_crop_limit_reached",
                "score_semantics": "raw_recognition_output_not_probability",
            }
            continue
        prepared.append((evidence, crop, quality))

    paddle_failures = 0
    vietocr_failures = 0
    inference_calls = 0
    for evidence, _crop, quality in prepared:
        evidence["crop_evidence"] = {
            **quality, "status": "pending",
            "score_semantics": "raw_recognition_output_not_probability",
        }

    if prepared:
        crops = [item[1] for item in prepared]
        try:
            # PaddleOCR 2.7.x exposes recognition-only OCR with det=False.
            with _paddle_inference_lock:
                paddle_results = paddle_engine.ocr(crops, det=False, rec=True, cls=False)
            inference_calls += 1
            for index, (evidence, _crop, _quality) in enumerate(prepared):
                page_result = (
                    paddle_results[index]
                    if isinstance(paddle_results, list) and index < len(paddle_results)
                    else None
                )
                recognition = (
                    page_result[0]
                    if isinstance(page_result, (list, tuple)) and page_result
                    else None
                )
                candidate = (
                    recognition[0]
                    if isinstance(recognition, (list, tuple)) and recognition
                    else None
                )
                score = (
                    recognition[1]
                    if isinstance(recognition, (list, tuple)) and len(recognition) > 1
                    else None
                )
                crop_evidence = evidence["crop_evidence"]
                crop_evidence["paddleocr_candidate"] = (
                    unicodedata.normalize("NFC", candidate).strip()
                    if isinstance(candidate, str) else None
                )
                crop_evidence["paddle_crop_recognition_score"] = _raw_recognition_score(score)
        except Exception as exc:
            paddle_failures += 1
            logger.warning("Selective PaddleOCR recognition failed: %s", type(exc).__name__)
            for evidence, _crop, _quality in prepared:
                evidence["crop_evidence"]["paddle_error"] = type(exc).__name__

        if vietocr_engine is None:
            for evidence, _crop, _quality in prepared:
                evidence["crop_evidence"]["vietocr_status"] = _vietocr_initialization_status
        else:
            try:
                vietocr_crops = crops
                if _inference_model_profile(vietocr_engine) in _V2_PREPROCESSING_PROFILES:
                    vietocr_crops = [preprocess_line_array(crop) for crop in crops]
                pil_crops = [
                    Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                    for crop in vietocr_crops
                ]
                predictor_config = getattr(vietocr_engine, "config", None)
                prediction_options = (
                    predictor_config.get("predictor")
                    if isinstance(predictor_config, dict)
                    else None
                )
                beam_search_enabled = (
                    isinstance(prediction_options, dict)
                    and prediction_options.get("beamsearch") is True
                )
                crop_evidence_decoding_mode = (
                    "beam_search" if beam_search_enabled else "standard_batch_or_predict"
                )
                with (torch.inference_mode() if torch is not None else nullcontext()), _vietocr_inference_lock:
                    can_batch = (
                        not beam_search_enabled
                        and callable(getattr(vietocr_engine, "predict_batch", None))
                    )
                    if can_batch:
                        try:
                            batch_result = vietocr_engine.predict_batch(
                                pil_crops, return_prob=True
                            )
                        except TypeError:
                            # The pinned Predictor supports this keyword, but wrappers
                            # and alternate builds may expose only the text-only form.
                            batch_result = vietocr_engine.predict_batch(pil_crops)
                        inference_calls += 1
                        if isinstance(batch_result, tuple) and len(batch_result) >= 2:
                            predictions, scores = batch_result[0], batch_result[1]
                        else:
                            predictions = (
                                list(batch_result)
                                if isinstance(batch_result, (list, tuple))
                                else [batch_result]
                            )
                            scores = [None] * len(pil_crops)
                    else:
                        # Predictor.predict honors the configured beam-search decoder.
                        # In that mode the library's own return_prob is None by design.
                        predictions, scores = [], []
                        for pil_crop in pil_crops:
                            try:
                                prediction = vietocr_engine.predict(
                                    pil_crop, return_prob=True
                                )
                            except TypeError:
                                prediction = vietocr_engine.predict(pil_crop)
                            if isinstance(prediction, tuple) and len(prediction) >= 2:
                                predictions.append(prediction[0])
                                scores.append(prediction[1])
                            else:
                                predictions.append(
                                    prediction if isinstance(prediction, str) else None
                                )
                                scores.append(None)
                            inference_calls += 1
                for index, (evidence, _crop, _quality) in enumerate(prepared):
                    prediction = predictions[index] if index < len(predictions) else None
                    score = scores[index] if index < len(scores) else None
                    crop_evidence = evidence["crop_evidence"]
                    sanitized_crop, had_ctrl = _sanitize_vietocr_prediction(prediction)
                    if had_ctrl:
                        crop_evidence["vietocr_candidate"] = None
                        crop_evidence["vietocr_control_token_filtered"] = True
                    else:
                        crop_evidence["vietocr_candidate"] = sanitized_crop
                    crop_evidence["vietocr_crop_recognition_score"] = _raw_recognition_score(score)
                    crop_evidence["vietocr_decoding_mode"] = crop_evidence_decoding_mode
                    crop_evidence["status"] = "completed"
            except Exception as exc:
                vietocr_failures += 1
                logger.warning("Selective VietOCR recognition failed: %s", type(exc).__name__)
                for evidence, _crop, _quality in prepared:
                    evidence["crop_evidence"]["status"] = "partial"
                    evidence["crop_evidence"]["vietocr_error"] = type(exc).__name__
    

    return {
        "bbox_validated": bbox_validated,
        "requested": len(prepared) + rejected_bbox + rejected_quality + capped,
        "recognized": len(prepared),
        "rejected_bbox": rejected_bbox,
        "rejected_crop_quality": rejected_quality,
        "skipped_by_page_limit": capped,
        "inference_calls": inference_calls,
        "paddle_failures": paddle_failures,
        "vietocr_failures": vietocr_failures,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        "max_crops_per_page": MAX_SELECTIVE_WORD_CROPS_PER_PAGE,
    }


_tesseract_language_data_checked = False
_tesseract_config_lock = threading.Lock()


def _ensure_tesseract_language_data() -> None:
    """Point Tesseract at the checkout's Vietnamese model when it cannot see it.

    Tesseract 4/5 read ``TESSDATA_PREFIX`` as the ``tessdata`` directory
    itself, older builds as its parent. Probe once instead of assuming.
    """
    global _tesseract_language_data_checked
    with _tesseract_config_lock:
        if _tesseract_language_data_checked:
            return
        try:
            language = os.getenv("TESSERACT_LANG", "vie").split("+")[0]
            local_data = _backend_root / "tessdata"
            if not (local_data / f"{language}.traineddata").is_file():
                return

            def language_available() -> bool:
                _pt, _ = _ensure_pytesseract()
                if _pt is None:
                    return False
                try:
                    return language in _pt.get_languages(config="")
                except Exception:
                    return False

            if language_available():
                return
            previous = os.environ.get("TESSDATA_PREFIX")
            for candidate in (str(local_data), str(_backend_root)):
                os.environ["TESSDATA_PREFIX"] = candidate
                if language_available():
                    return
            if previous is None:
                os.environ.pop("TESSDATA_PREFIX", None)
            else:
                os.environ["TESSDATA_PREFIX"] = previous
        finally:
            _tesseract_language_data_checked = True


def _configure_tesseract() -> bool:
    _pt, _ = _ensure_pytesseract()
    if _pt is None:
        return False
    configured_binary = _resolve_tesseract_command()
    if not configured_binary:
        return False
    with _tesseract_config_lock:
        _pt.pytesseract.tesseract_cmd = configured_binary.strip('"\'')
    _ensure_tesseract_language_data()
    return True


def _normalize_text_background(gray: np.ndarray) -> np.ndarray:
    """Dark text on an evenly lit light background, as Tesseract expects.

    Shadows and uneven lighting defeat Tesseract's own binarization. The
    background is estimated with a wide blur and divided out. Polarity comes
    from which Otsu class is the minority (the text), not from brightness, so
    a dim page is not mistaken for light-on-dark text.
    """
    threshold, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Otsu puts pixels equal to the threshold in its dark class as well.
    # Excluding equality misses the background of clean two-tone screenshots.
    if float(np.mean(gray <= threshold)) > 0.5:
        gray = cv2.bitwise_not(gray)
    background = cv2.GaussianBlur(gray, (0, 0), sigmaX=max(8.0, max(gray.shape) / 40.0))
    return cv2.divide(gray, background, scale=255)


def _same_base_letters(first: str, second: str) -> bool:
    """Same letters once marks and outer punctuation are ignored (geometry only)."""

    def base(value: str) -> str:
        decomposed = unicodedata.normalize("NFD", normalize_word(value))
        return "".join(
            character for character in decomposed
            if unicodedata.category(character) != "Mn"
        ).replace("đ", "d")

    first_base = base(first)
    return bool(first_base) and first_base == base(second)


def _normalized_box(
    pixel_box: tuple[int, int, int, int], width: int, height: int
) -> list[float] | None:
    """Pixel (left, top, width, height) -> normalized xywh inside the page."""
    left, top, box_width, box_height = pixel_box
    if box_width < 2 or box_height < 2 or width <= 0 or height <= 0:
        return None
    x0 = min(max(left / width, 0.0), 1.0)
    y0 = min(max(top / height, 0.0), 1.0)
    x1 = min(max((left + box_width) / width, 0.0), 1.0)
    y1 = min(max((top + box_height) / height, 0.0), 1.0)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return None
    return _clamp_normalized_bbox(left, top, box_width, box_height, width, height)


def _attach_tesseract_line_readings(
    image: np.ndarray,
    words: list[dict[str, object]],
) -> dict[str, object]:
    """Read the page once with Tesseract and pair its tokens with our words.

    Tesseract is the second Vietnamese-capable recognizer. Its lines are
    matched to pipeline lines by box overlap, then tokens are paired by the
    same order-preserving alignment used between PaddleOCR and VietOCR, so an
    approximate word box can never attach a token to the wrong word.
    """
    import time

    started = time.perf_counter()

    def finish(status: str, paired: int = 0, error: str | None = None) -> dict[str, object]:
        for word in words:
            evidence = word.get("ocr_evidence")
            if isinstance(evidence, dict):
                statuses = evidence.get("engine_statuses")
                evidence["engine_statuses"] = {
                    **(statuses if isinstance(statuses, dict) else {}),
                    "tesseract": status,
                }
                if error:
                    errors = evidence.get("engine_errors")
                    evidence["engine_errors"] = {
                        **(errors if isinstance(errors, dict) else {}),
                        "tesseract": error,
                    }
        return {
            "status": status,
            "paired_words": paired,
            "error": error,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        }

    if not _configure_tesseract():
        return finish("not_installed")
    _pt, _output = _ensure_pytesseract()
    if _pt is None:
        return finish("not_installed")
    height, width = image.shape[:2]
    try:
        gray = _normalize_text_background(
            cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
        )
        dict_output = getattr(_output, "DICT", "dict")
        data = _pt.image_to_data(
            gray,
            lang=os.getenv("TESSERACT_LANG", "vie"),
            config="--oem 1 --psm 3",
            output_type=dict_output,
            timeout=60,
        )
    except Exception as exc:
        logger.warning("Tesseract page reading failed: %s", type(exc).__name__)
        return finish("error", error=type(exc).__name__)

    tesseract_lines: dict[tuple[int, int, int], dict[str, Any]] = {}
    for index, raw_text in enumerate(data.get("text", [])):
        token = unicodedata.normalize("NFC", str(raw_text)).strip()
        if not token or not normalize_word(token):
            continue
        try:
            left, top = int(data["left"][index]), int(data["top"][index])
            box_width, box_height = int(data["width"][index]), int(data["height"][index])
            key = (
                int(data["block_num"][index]),
                int(data["par_num"][index]),
                int(data["line_num"][index]),
            )
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        line = tesseract_lines.setdefault(
            key, {"tokens": [], "box": [left, top, left + box_width, top + box_height]}
        )
        line["tokens"].append(token)
        line.setdefault("token_boxes", []).append((left, top, box_width, box_height))
        box = line["box"]
        box[0], box[1] = min(box[0], left), min(box[1], top)
        box[2], box[3] = max(box[2], left + box_width), max(box[3], top + box_height)
    if not tesseract_lines:
        return finish("no_result")

    pipeline_lines: dict[int, dict[str, Any]] = {}
    for word in words:
        try:
            x, y, box_width, box_height = (float(value) for value in word["bbox"])
        except (KeyError, TypeError, ValueError):
            continue
        line = pipeline_lines.setdefault(
            int(word["line_index"]),
            {"words": [], "box": [x * width, y * height, (x + box_width) * width, (y + box_height) * height]},
        )
        line["words"].append(word)
        box = line["box"]
        box[0], box[1] = min(box[0], x * width), min(box[1], y * height)
        box[2] = max(box[2], (x + box_width) * width)
        box[3] = max(box[3], (y + box_height) * height)

    def overlap(first: list[float], second: list[float]) -> float:
        inter_w = min(first[2], second[2]) - max(first[0], second[0])
        inter_h = min(first[3], second[3]) - max(first[1], second[1])
        if inter_w <= 0 or inter_h <= 0:
            return 0.0
        smaller = min(
            (first[2] - first[0]) * (first[3] - first[1]),
            (second[2] - second[0]) * (second[3] - second[1]),
        )
        return (inter_w * inter_h) / smaller if smaller > 0 else 0.0

    candidates = sorted(
        (
            (overlap(line["box"], tesseract_line["box"]), line_index, key)
            for line_index, line in pipeline_lines.items()
            for key, tesseract_line in tesseract_lines.items()
        ),
        reverse=True,
    )
    used_pipeline: set[int] = set()
    used_tesseract: set[tuple[int, int, int]] = set()
    paired = 0
    measured_boxes = 0
    for score, line_index, key in candidates:
        if score < 0.4:
            break
        if line_index in used_pipeline or key in used_tesseract:
            continue
        used_pipeline.add(line_index)
        used_tesseract.add(key)
        line_words = pipeline_lines[line_index]["words"]
        tesseract_tokens = tesseract_lines[key]["tokens"]
        for step in align_ocr_tokens(
            [str(word["text"]) for word in line_words], tesseract_tokens
        ):
            if step["operation"] not in {"match", "substitute"}:
                continue
            word = line_words[int(step["primary_index"])]
            evidence = word.get("ocr_evidence")
            if isinstance(evidence, dict) and isinstance(evidence.get("engine_outputs"), dict):
                tesseract_token = tesseract_tokens[int(step["secondary_index"])]
                evidence["engine_outputs"]["tesseract"] = tesseract_token
                paired += 1
                # The pipeline box is a proportional estimate inside the line
                # quad. Tesseract measured this word's glyphs directly, so
                # when both read the same letters its box replaces the
                # estimate (marks may differ; the letters locate the word).
                if _same_base_letters(str(word["text"]), tesseract_token):
                    measured = _normalized_box(
                        tesseract_lines[key]["token_boxes"][int(step["secondary_index"])],
                        width, height,
                    )
                    if measured is not None:
                        word["bbox_estimated"] = list(word["bbox"])
                        word["bbox"] = measured
                        word["bbox_source"] = "tesseract_word_box"
                        measured_boxes += 1
    stats = finish("success", paired)
    stats["measured_boxes"] = measured_boxes
    # Tesseract's own page reading, kept so each engine can be measured
    # against ground truth on its own (never used to color a word).
    stats["page_lines"] = [
        " ".join(tesseract_lines[key]["tokens"]) for key in sorted(tesseract_lines)
    ]
    return stats


def _recognize_crop_with_tesseract(crop: np.ndarray) -> tuple[str | None, str | None]:
    """Independent single-word reading of a padded crop; (candidate, error)."""
    if not _configure_tesseract():
        return None, "not_installed"
    _pt, _ = _ensure_pytesseract()
    if _pt is None:
        return None, "not_installed"
    try:
        gray = _normalize_text_background(
            cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
        )
        gray = cv2.copyMakeBorder(
            gray, 10, 10, 10, 10, cv2.BORDER_REPLICATE
        )
        text = _pt.image_to_string(
            gray,
            lang=os.getenv("TESSERACT_LANG", "vie"),
            config="--oem 1 --psm 8",
            timeout=8,
        )
    except Exception as exc:
        return None, type(exc).__name__
    candidate = unicodedata.normalize("NFC", str(text)).strip()
    return (candidate or None), None


def _adjudicate_disputed_words(
    image: np.ndarray,
    words: list[dict[str, object]],
) -> dict[str, object]:
    """Resolve words the engines did not already agree on at line level.

    Words settled at line level (crop status ``not_needed``) are left alone.
    For the rest, the padded crop is additionally read by Tesseract when the
    stored readings still do not identify one candidate. The selected text
    changes only when ``adjudicate_word`` finds a candidate backed by
    independent engines; every original engine output stays in the evidence.
    """
    import time
    from concurrent.futures import ThreadPoolExecutor

    started = time.perf_counter()
    considered = 0
    resolved = 0
    text_changed = 0
    tesseract_calls = 0
    try:
        max_tesseract_crops = max(
            0, min(MAX_SELECTIVE_WORD_CROPS_PER_PAGE, int(os.getenv("VIREAD_OCR_MAX_TESSERACT_CROPS", "8")))
        )
    except ValueError:
        max_tesseract_crops = 8

    # First pass: collect disputed words that need a single-word Tesseract crop reading
    # so subprocess calls run concurrently (max_workers=2) instead of serially stalling CPU jobs.
    pending_tess_jobs: list[tuple[dict[str, object], dict[str, Any], np.ndarray]] = []
    disputed_entries: list[tuple[dict[str, object], dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    for word in words:
        evidence = word.get("ocr_evidence")
        if not isinstance(evidence, dict):
            continue
        crop_evidence = evidence.get("crop_evidence")
        if not isinstance(crop_evidence, dict):
            continue
        if crop_evidence.get("status") == "not_needed":
            line_decision = adjudicate_word(evidence)
            crop_evidence["adjudication_rule"] = OCR_ADJUDICATION_RULE
            crop_evidence["adjudication_status"] = str(line_decision["status"])
            crop_evidence["adjudication_support"] = ",".join(line_decision.get("support") or [])
            if evidence.get("alignment") != "match":
                evidence["selection_reason"] = "adjudication_" + OCR_ADJUDICATION_RULE
                evidence["review_reason"] = (
                    "Không phải mọi engine đọc giống nhau, nhưng ít nhất hai engine độc lập "
                    "đọc cùng token này và không engine tiếng Việt nào phản bác. "
                    "Chưa đối chiếu reference."
                )
            continue
        considered += 1
        decision = adjudicate_word(evidence)
        disputed_entries.append((word, evidence, crop_evidence, decision))
        if (
            decision["status"] != "resolved"
            and crop_evidence.get("status") == "completed"
            and len(pending_tess_jobs) < max_tesseract_crops
        ):
            crop, quality = crop_word_region(image, word.get("bbox"))
            if crop is not None and quality.get("crop_quality") == "usable":
                pending_tess_jobs.append((word, crop_evidence, crop))

    if pending_tess_jobs:
        if len(pending_tess_jobs) == 1:
            _w, crop_ev, crop_img = pending_tess_jobs[0]
            candidate, error = _recognize_crop_with_tesseract(crop_img)
            tesseract_calls += 1
            crop_ev["tesseract_candidate"] = candidate
            if error is not None:
                crop_ev["tesseract_error"] = error
        else:
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [
                    (crop_ev, pool.submit(_recognize_crop_with_tesseract, crop_img))
                    for _w, crop_ev, crop_img in pending_tess_jobs
                ]
                for crop_ev, fut in futures:
                    candidate, error = fut.result()
                    tesseract_calls += 1
                    crop_ev["tesseract_candidate"] = candidate
                    if error is not None:
                        crop_ev["tesseract_error"] = error

    for word, evidence, crop_evidence, decision in disputed_entries:
        if "tesseract_candidate" in crop_evidence or "tesseract_error" in crop_evidence:
            decision = adjudicate_word(evidence)

        crop_evidence["adjudication_rule"] = OCR_ADJUDICATION_RULE
        crop_evidence["adjudication_status"] = str(decision["status"])
        crop_evidence["adjudication_support"] = ",".join(decision.get("support") or [])

        # 1) Which candidate to display. This is only a better provisional
        #    choice; it does not confirm the word.
        preferred = decision.get("preferred_text")
        current_text = str(word.get("text", ""))
        switched = False
        if isinstance(preferred, str) and normalize_word(current_text) != preferred:
            outputs = evidence.get("engine_outputs")
            surface = preferred
            selected_engine = evidence.get("selected_engine")
            # Prefer the cased surface of a supporting reading over the
            # lowercase comparison key.
            for reading, engine_name, field in (
                ("vietocr_line", "vietocr", None),
                ("tesseract_line", "tesseract", None),
                ("paddleocr_line", "paddleocr", None),
                ("vietocr_crop", "vietocr", "vietocr_candidate"),
                ("tesseract_crop", "tesseract", "tesseract_candidate"),
                ("paddleocr_crop", "paddleocr", "paddleocr_candidate"),
            ):
                if reading not in (decision.get("preferred_support") or []):
                    continue
                raw_value = (
                    outputs.get(engine_name) if field is None and isinstance(outputs, dict)
                    else crop_evidence.get(field) if field is not None
                    else None
                )
                if isinstance(raw_value, str) and normalize_word(raw_value) == preferred:
                    surface = raw_value
                    if field is None:
                        selected_engine = engine_name
                    break
            new_text = replace_token_core(current_text, surface)
            # Never store a token that differs from the chosen candidate.
            if normalize_word(new_text) == preferred:
                crop_evidence["text_before_adjudication"] = current_text
                word["text"] = new_text
                word["normalized_text"] = preferred
                evidence["selected_engine"] = selected_engine
                evidence["source_text"] = new_text
                evidence["selection_reason"] = "preferred_reading_" + OCR_ADJUDICATION_RULE
                evidence["review_reason"] = (
                    "Đã chọn candidate được nhiều lượt đọc của engine tiếng Việt ủng hộ hơn để "
                    "hiển thị. Đây chưa phải xác nhận; cần đối chiếu ảnh."
                )
                text_changed += 1
                switched = True

        # 2) Whether the displayed token is confirmed by independent engines.
        if (
            decision["status"] == "resolved"
            and decision["text"] == normalize_word(str(word.get("text", "")))
        ):
            resolved += 1
            crop_evidence["adjudicated_text"] = str(decision["text"])
            evidence["source_text"] = str(word["text"])
            evidence["selection_reason"] = "adjudication_" + OCR_ADJUDICATION_RULE
            evidence["review_reason"] = (
                "Không phải mọi engine đọc giống nhau, nhưng hai engine tiếng Việt độc lập "
                "đọc cùng token này và không lượt đọc nào của chúng khác dấu. "
                "Chưa đối chiếu reference."
            )
        elif not switched:
            crop_evidence["adjudication_status"] = (
                "unresolved" if decision["status"] == "resolved" else str(decision["status"])
            )

    return {
        "rule": OCR_ADJUDICATION_RULE,
        "considered": considered,
        "resolved": resolved,
        "text_changed": text_changed,
        "tesseract_calls": tesseract_calls,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
    }


def _reconcile_punctuation(words: list[dict[str, object]]) -> dict[str, object]:
    """Settle each word's leading/trailing punctuation by engine majority.

    An engine votes only for a word whose letters it read (marks ignored), so
    punctuation is never moved to a neighbouring word. A side changes only
    when at least two engines agree on it and no other reading ties; the
    lexical core is never touched and the previous surface is recorded.
    """
    from collections import Counter

    changed = 0
    disputed = 0
    for word in words:
        evidence = word.get("ocr_evidence")
        if not isinstance(evidence, dict):
            continue
        outputs = evidence.get("engine_outputs")
        statuses = evidence.get("engine_statuses")
        if not isinstance(outputs, dict) or not isinstance(statuses, dict):
            continue
        current = split_surface_token(str(word.get("text", "")))
        if not current.core:
            continue
        votes = []
        for engine in ("vietocr", "tesseract", "paddleocr"):
            value = outputs.get(engine)
            if statuses.get(engine) != "success" or not isinstance(value, str):
                continue
            parts = split_surface_token(value)
            if parts.core and _same_base_letters(parts.core, current.core):
                votes.append(parts)
        if len(votes) < 2:
            continue
        sides = {"leading": current.leading, "trailing": current.trailing}
        for side in ("leading", "trailing"):
            counts = Counter(canonical_punctuation(getattr(parts, side)) for parts in votes)
            if len(counts) > 1:
                disputed += 1
            (best, support), *rest = counts.most_common()
            if support < 2 or (rest and rest[0][1] == support):
                continue
            if best == canonical_punctuation(sides[side]):
                continue
            sides[side] = next(
                getattr(parts, side) for parts in votes
                if canonical_punctuation(getattr(parts, side)) == best
            )
        new_text = sides["leading"] + current.core + sides["trailing"]
        if new_text != current.surface:
            crop_evidence = evidence.get("crop_evidence")
            if isinstance(crop_evidence, dict):
                crop_evidence["punctuation_before_reconciliation"] = current.surface
            word["text"] = new_text
            if isinstance(evidence.get("source_text"), str):
                evidence["source_text"] = new_text
            changed += 1
    return {"changed_words": changed, "disputed_sides": disputed}


def _extract_text_and_boxes_dual_engine(
    image_bytes: bytes,
    paddle_engine: Any,
    vietocr_engine: Any | None,
) -> dict[str, object]:
    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Image decoding failed")

    orig_height, orig_width = image.shape[:2]
    if orig_width <= 0 or orig_height <= 0:
        raise ValueError("Image dimensions are invalid")

    scale_factor = 1.0
    max_dim = max(orig_width, orig_height)
    if max_dim < 1500:
        scale_factor = min(2.5, 1500.0 / max_dim)
        scaled_w = int(round(orig_width * scale_factor))
        scaled_h = int(round(orig_height * scale_factor))
        proc_image = cv2.resize(image, (scaled_w, scaled_h), interpolation=cv2.INTER_CUBIC)
    else:
        proc_image = image

    try:
        with _paddle_inference_lock:
            ocr_res = paddle_engine.ocr(proc_image, cls=False)
    except Exception as exc:
        raise OcrEngineUnavailable(f"PaddleOCR xử lý hình ảnh thất bại: {exc}") from exc

    raw_items = ocr_res[0] if (ocr_res and ocr_res[0] is not None) else []
    if not raw_items:
        raise OcrNoTextDetected("PaddleOCR không phát hiện được chữ trên hình ảnh")

    if scale_factor > 1.01:
        for item in raw_items:
            item[0] = np.array(item[0], dtype=np.float32) / scale_factor

    ordered_items, layout_type = sort_reading_order_adaptive(
        raw_items, img_width=orig_width, image=image
    )
    if not ordered_items:
        raise OcrNoTextDetected("Không có dòng chữ khả dụng sau khi xử lý bố cục")

    words_output: list[dict[str, object]] = []
    lines_output: list[str] = []
    # Per line: ("word", index into words_output) or ("mark", literal) so the
    # page text keeps punctuation-only tokens ("–", "...") that are not words.
    line_layouts: list[list[tuple[str, object]]] = []
    line_evidence: list[dict[str, object]] = []
    geometry_reliable = True

    prepared_items: list[dict[str, Any]] = []
    for item in ordered_items:
        paddle_text = item["paddle_text"]
        paddle_conf = item["paddle_conf"]
        dewarped_img = item["dewarped_img"]

        h_crop, w_crop = dewarped_img.shape[:2]
        if w_crop < 8 or h_crop < 8:
            continue

        if h_crop < 52:
            target_h = 56
            target_w = int(round(w_crop * (target_h / h_crop)))
            dewarped_img_scaled = cv2.resize(dewarped_img, (target_w, target_h), interpolation=cv2.INTER_CUBIC)
        else:
            dewarped_img_scaled = dewarped_img

        line_img_pil = Image.fromarray(cv2.cvtColor(dewarped_img_scaled, cv2.COLOR_BGR2RGB))
        prediction_image = line_img_pil
        if vietocr_engine is not None and _inference_model_profile(vietocr_engine) in _V2_PREPROCESSING_PROFILES:
            prediction_image = Image.fromarray(
                cv2.cvtColor(preprocess_line_array(dewarped_img_scaled), cv2.COLOR_BGR2RGB)
            )
        prepared_items.append({
            "item": item,
            "paddle_text": paddle_text,
            "paddle_conf": paddle_conf,
            "prediction_image": prediction_image,
            "viet_text": None,
            "viet_exc": None,
        })

    if vietocr_engine is not None and prepared_items:
        use_batch = False
        predict_batch_fn = getattr(vietocr_engine, "predict_batch", None)
        if (
            not isinstance(vietocr_engine, NonCallableMock)
            and len(prepared_items) > 1
            and callable(predict_batch_fn)
            and not isinstance(predict_batch_fn, NonCallableMock)
        ):
            config_obj = getattr(vietocr_engine, "config", None)
            predictor_cfg = (
                config_obj.get("predictor")
                if isinstance(config_obj, dict)
                else getattr(config_obj, "predictor", None)
            )
            beamsearch_enabled = (
                bool(predictor_cfg.get("beamsearch"))
                if isinstance(predictor_cfg, dict)
                else bool(getattr(predictor_cfg, "beamsearch", False))
            )
            use_batch = not beamsearch_enabled

        with (torch.inference_mode() if torch is not None else nullcontext()), _vietocr_inference_lock:
            if use_batch:
                for chunk_start in range(0, len(prepared_items), 16):
                    chunk = prepared_items[chunk_start : chunk_start + 16]
                    batch_imgs = [entry["prediction_image"] for entry in chunk]
                    batch_ok = False
                    try:
                        batch_out = predict_batch_fn(batch_imgs)
                        if (
                            isinstance(batch_out, (list, tuple))
                            and len(batch_out) == len(chunk)
                            and all(val is None or isinstance(val, str) for val in batch_out)
                        ):
                            for entry, val in zip(chunk, batch_out):
                                entry["viet_text"] = val
                            batch_ok = True
                    except Exception:
                        batch_ok = False
                    if not batch_ok:
                        for entry in chunk:
                            try:
                                entry["viet_text"] = vietocr_engine.predict(entry["prediction_image"])
                            except Exception as exc:
                                entry["viet_exc"] = exc
            else:
                for entry in prepared_items:
                    try:
                        entry["viet_text"] = vietocr_engine.predict(entry["prediction_image"])
                    except Exception as exc:
                        entry["viet_exc"] = exc

    for entry in prepared_items:
        item = entry["item"]
        paddle_text = entry["paddle_text"]
        paddle_conf = entry["paddle_conf"]
        chosen_text = paddle_text
        viet_text_candidate: str | None = None
        viet_text_used = False
        vietocr_status = _vietocr_initialization_status if vietocr_engine is None else "not_run"
        vietocr_error = _vietocr_initialization_error if vietocr_engine is None else None

        if vietocr_engine is not None:
            if entry["viet_exc"] is not None:
                vietocr_status = "error"
                vietocr_error = type(entry["viet_exc"]).__name__
                logger.warning("VietOCR line inference failed: %s", vietocr_error)
            else:
                viet_text = entry["viet_text"]
                if isinstance(viet_text, str) and viet_text.strip():
                    sanitized_line, had_ctrl = _sanitize_vietocr_prediction(viet_text)
                    viet_text_candidate = sanitized_line
                    if had_ctrl:
                        # A seq2seq control token (<pad>/<sos>/<eos>/<unk>) indicates a corrupted
                        # VietOCR decode (e.g. "ti<pad>f" for "TIFF"). Never let it override PaddleOCR.
                        vietocr_status = "control_token_filtered"
                        vietocr_error = "VIETOCR_CONTROL_TOKEN"
                    elif sanitized_line is not None:
                        vietocr_status = "success"
                        if is_vietocr_reliable(
                            sanitized_line, paddle_text, paddle_conf=paddle_conf, max_cer=0.40
                        ):
                            chosen_text = sanitized_line
                            viet_text_used = True
                    else:
                        vietocr_status = "no_result"
                else:
                    vietocr_status = "no_result"

        if viet_text_used:
            chosen_text = _transfer_punctuation(chosen_text, paddle_text)

        chosen_text = clean_ocr_punctuation(chosen_text)
        if not chosen_text:
            continue

        selected_entries = _tokens_with_source_indices(chosen_text)
        valid_words = [token for _source_index, token in selected_entries]
        selected_source_indices = [source_index for source_index, _token in selected_entries]
        if not valid_words:
            continue

        line_geometry: dict[str, Any] = {}
        line_boxes = _map_curved_word_boxes(valid_words, item, orig_width, orig_height, geometry=line_geometry)
        geometry_reliable = geometry_reliable and line_geometry.get("reliable") is True
        paddle_entries = _tokens_with_source_indices(paddle_text)
        vietocr_entries = _tokens_with_source_indices(viet_text_candidate or "")
        paddle_tokens = [token for _source_index, token in paddle_entries]
        vietocr_tokens = [token for _source_index, token in vietocr_entries]
        other_entries = paddle_entries if viet_text_used else vietocr_entries
        other_engine_tokens = [token for _source_index, token in other_entries]
        other_source_indices = [source_index for source_index, _token in other_entries]
        alignment = align_ocr_tokens(valid_words, other_engine_tokens)
        by_primary_index = {
            int(step["primary_index"]): step
            for step in alignment
            if step["primary_index"] is not None
        }
        selected_engine_name = "vietocr" if viet_text_used else "paddleocr"
        split_merge_candidates = find_split_merge_candidates(paddle_tokens, vietocr_tokens)
        split_merge_by_source_index = _split_merge_operations_by_source_index(
            split_merge_candidates,
            selected_engine_name,
            paddle_entries,
            vietocr_entries,
        )
        line_index = len(lines_output)
        valid_line_confidence = None
        try:
            if not isinstance(paddle_conf, bool):
                candidate_line_score = float(paddle_conf)
                if np.isfinite(candidate_line_score) and 0 <= candidate_line_score <= 1:
                    valid_line_confidence = candidate_line_score
        except (TypeError, ValueError, OverflowError):
            pass
        alignment_operations = []
        for step in alignment:
            primary_index = step["primary_index"]
            secondary_index = step["secondary_index"]
            primary_token = (
                valid_words[int(primary_index)] if primary_index is not None else None
            )
            secondary_token = (
                other_engine_tokens[int(secondary_index)]
                if secondary_index is not None
                else None
            )
            primary_source_index = (
                selected_source_indices[int(primary_index)]
                if primary_index is not None
                else None
            )
            secondary_source_index = (
                other_source_indices[int(secondary_index)]
                if secondary_index is not None
                else None
            )
            alignment_operations.append({
                "operation": step["operation"],
                "paddle_token": secondary_token if viet_text_used else primary_token,
                "vietocr_token": primary_token if viet_text_used else secondary_token,
                "selected_token_index": primary_source_index,
                "paddle_token_index": secondary_source_index if viet_text_used else primary_source_index,
                "vietocr_token_index": primary_source_index if viet_text_used else secondary_source_index,
            })
        line_engine_statuses = {
            "paddleocr": (
                "success"
                if isinstance(paddle_text, str) and paddle_text.strip()
                else "no_result"
            ),
            "vietocr": vietocr_status,
            "tesseract": "not_run",
        }
        line_evidence.append({
            "line_index": line_index,
            "paddle_output": paddle_text,
            "vietocr_output": viet_text_candidate,
            "engine_statuses": line_engine_statuses,
            "engine_errors": {"vietocr": vietocr_error} if vietocr_error else {},
            "paddle_line_confidence": valid_line_confidence,
            "paddle_line_score_contract": PADDLE_LINE_SCORE_CONTRACT,
            "vietocr_output_used": viet_text_used,
            "selection_reason": (
                "vietocr_nonempty_nonrepetitive_provisional"
                if viet_text_used
                else "paddle_provisional_fallback_or_vietocr_rejected"
            ),
            "alignment_operations": alignment_operations,
            "split_merge_candidates": split_merge_candidates,
        })

        for w_idx, raw_token in enumerate(valid_words):
            step = by_primary_index.get(w_idx)
            secondary_index = (
                int(step["secondary_index"])
                if step is not None and step["secondary_index"] is not None
                else None
            )
            matched_other_token = (
                other_engine_tokens[secondary_index]
                if secondary_index is not None
                else None
            )
            agreement, review_status = _word_engine_evidence(
                raw_token, matched_other_token
            )
            operation = str(step["operation"]) if step is not None else "unmatched"
            if operation == "delete":
                operation = "unmatched"

            selected_source_index = selected_source_indices[w_idx] if w_idx < len(selected_source_indices) else None
            secondary_source_index = (
                other_source_indices[secondary_index]
                if secondary_index is not None and secondary_index < len(other_source_indices)
                else None
            )
            split_merge_operation = (
                split_merge_by_source_index.get(selected_source_index)
                if selected_source_index is not None
                else None
            )
            paddle_token = raw_token if not viet_text_used else matched_other_token
            vietocr_token = raw_token if viet_text_used else matched_other_token
            paddle_source_index = secondary_source_index if viet_text_used else selected_source_index
            vietocr_source_index = selected_source_index if viet_text_used else secondary_source_index

            if split_merge_operation is not None:
                # A 1:N/N:1 candidate has no safe one-to-one token on the
                # opposite engine. Keep selected-token provenance only; the
                # complete group mapping remains in line_evidence.
                operation = split_merge_operation
                agreement = None
                review_status = "engine_disagreement"
                paddle_token = raw_token if selected_engine_name == "paddleocr" else None
                vietocr_token = raw_token if selected_engine_name == "vietocr" else None
                paddle_source_index = selected_source_index if selected_engine_name == "paddleocr" else None
                vietocr_source_index = selected_source_index if selected_engine_name == "vietocr" else None
                review_reason = (
                    "Phát hiện candidate split/merge giữa hai engine; không có ánh xạ một-một an toàn. "
                    "Đối chiếu nhóm token trong line evidence."
                )
            elif operation == "insert":
                review_reason = "Engine còn lại có thêm token; hệ thống không ghép theo vị trí."
            elif operation == "unmatched":
                review_reason = "Không tìm thấy từ tương ứng đáng tin cậy ở engine còn lại."
            elif operation == "match":
                review_reason = "Hai engine trả về cùng token; điều này chưa xác minh từ có đúng không."
            else:
                review_reason = "Hai token đã căn chỉnh khác nhau; bất đồng chưa cho biết token nào đúng."

            norm_token = normalize_word(raw_token)
            words_output.append({
                "word_index": len(words_output),
                "line_index": len(lines_output),
                "text": raw_token,
                "normalized_text": norm_token,
                "bbox": line_boxes[w_idx],
                "ocr_confidence": None,
                "ocr_review_status": review_status,
                "ocr_score_source": None,
                "ocr_evidence": {
                    "contract": HYBRID_OCR_EVIDENCE_CONTRACT,
                    "engine_outputs": {
                        "paddleocr": paddle_token,
                        "vietocr": vietocr_token,
                    },
                    "engine_statuses": line_engine_statuses,
                    "engine_errors": (
                        {"vietocr": vietocr_error}
                        if vietocr_error is not None
                        else {}
                    ),
                    "paddle_token_index": paddle_source_index,
                    "vietocr_token_index": vietocr_source_index,
                    "alignment": operation,
                    "engine_agreement_score": agreement,
                    "calibrated_word_accuracy": None,
                    "verification_source": None,
                    "reference_text": None,
                    "selected_engine": selected_engine_name,
                    "selection_reason": (
                        "vietocr_nonempty_nonrepetitive_provisional"
                        if viet_text_used
                        else "paddle_provisional_fallback_or_vietocr_rejected"
                    ),
                    "bbox_quality": "not_checked",
                    "crop_quality": None,
                    "crop_evidence": None,
                    "review_reason": review_reason,
                },
            })

        lines_output.append(" ".join(valid_words))
        layout: list[tuple[str, object]] = []
        first_word_index = len(words_output) - len(valid_words)
        word_position = 0
        for surface_token in unicodedata.normalize("NFC", chosen_text).split():
            if normalize_word(surface_token):
                layout.append(("word", first_word_index + word_position))
                word_position += 1
            else:
                layout.append(("mark", surface_token))
        line_layouts.append(layout)

    if not words_output:
        raise OcrNoTextDetected("Dual-Engine không trích xuất được từ ngữ hợp lệ")

    tesseract_stats = _attach_tesseract_line_readings(image, words_output)
    crop_stats = _recognize_uncertain_word_crops(
        image, words_output, paddle_engine, vietocr_engine
    )
    adjudication_stats = _adjudicate_disputed_words(image, words_output)
    punctuation_stats = _reconcile_punctuation(words_output)
    for word in words_output:
        bbox_source = word.pop("bbox_source", None)
        word.pop("bbox_estimated", None)
        evidence = word.get("ocr_evidence")
        if (
            isinstance(bbox_source, str)
            and isinstance(evidence, dict)
            and isinstance(evidence.get("crop_evidence"), dict)
        ):
            evidence["crop_evidence"]["bbox_source"] = bbox_source
    # The page text is rebuilt from the final word surfaces, in order, with
    # every punctuation-only token kept where the recognizer read it.
    lines_output = [
        " ".join(
            str(words_output[int(item)]["text"]) if kind == "word" else str(item)
            for kind, item in layout
        )
        for layout in line_layouts
    ]
    formatted_text = "\n".join(lines_output)

    debug_path = os.getenv("OCR_DEBUG_BOXES_PATH", "").strip()
    if debug_path:
        try:
            debug_vis = image.copy()
            for w in words_output:
                bx, by, bw, bh = w["bbox"]
                x1 = int(round(bx * orig_width))
                y1 = int(round(by * orig_height))
                x2 = int(round((bx + bw) * orig_width))
                y2 = int(round((by + bh) * orig_height))
                cv2.rectangle(debug_vis, (x1, y1), (x2, y2), (0, 255, 0), 1)
            cv2.imwrite(os.path.abspath(debug_path), debug_vis)
        except Exception:
            pass

    return {
        "text": formatted_text,
        "words": words_output,
        "metadata": {
            "engine": "paddleocr_vietocr_dual",
            "word_box_geometry": build_geometry_evidence(words_output, orig_width, orig_height, reliable=geometry_reliable),
            "engine_version": "PP-OCRv4 + VietOCR-vgg_transformer",
            "engine_versions": {
                "paddleocr": _package_version("paddleocr"),
                "vietocr": _package_version("vietocr"),
                "paddle_model": "PP-OCRv4",
                "vietocr_model": "vgg_transformer",
            },
            "preprocessing_version": OCR_PREPROCESSING_VERSION,
            "ocr_evidence_contract": HYBRID_OCR_EVIDENCE_CONTRACT,
            "ocr_score_contract": None,
            "language": "vi",
            "coordinate_space": "normalized_original_dimensions",
            "source_width": orig_width,
            "source_height": orig_height,
            "processed_width": orig_width,
            "processed_height": orig_height,
            "scale_factor": scale_factor,
            "word_count": len(words_output),
            "line_count": len(lines_output),
            "reading_layout": layout_type,
            "line_evidence": line_evidence,
            "engine_statuses": {
                "paddleocr": "success",
                "vietocr": (
                    "success"
                    if any(line.get("engine_statuses", {}).get("vietocr") == "success" for line in line_evidence)
                    else "error"
                    if any(line.get("engine_statuses", {}).get("vietocr") == "error" for line in line_evidence)
                    else _vietocr_initialization_status if vietocr_engine is None
                    else "no_result"
                ),
                "tesseract": str(tesseract_stats["status"]),
            },
            "tesseract_line_stats": tesseract_stats,
            "selective_crop_stats": crop_stats,
            "adjudication_stats": adjudication_stats,
            "punctuation_stats": punctuation_stats,
        },
    }


def _attach_engine_statuses(
    result: dict[str, object],
    statuses: dict[str, str],
    reasons: dict[str, str] | None = None,
) -> dict[str, object]:
    """Attach observed engine lifecycle states to a Tesseract fallback result."""
    metadata = result.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    metadata["engine_statuses"] = dict(statuses)
    if reasons:
        metadata["engine_status_reasons"] = dict(reasons)
    result["metadata"] = metadata
    raw_words = result.get("words")
    if isinstance(raw_words, list):
        for word in raw_words:
            if not isinstance(word, dict):
                continue
            evidence = word.get("ocr_evidence")
            if isinstance(evidence, dict):
                evidence["engine_statuses"] = dict(statuses)
                if reasons:
                    evidence["engine_errors"] = {
                        name: reason
                        for name, reason in reasons.items()
                        if name in {"paddleocr", "vietocr", "tesseract"}
                        and isinstance(reason, str)
                    }
    return result


def extract_text_and_boxes(image_bytes: bytes) -> dict[str, object]:
    """Run OCR with per-scan evidence of the verified Predictor actually used.

    Snapshot the per-thread result of _get_ocr_engines immediately, before
    another request can switch the globally cached Predictor. Never serialize
    registry pointers or the local checkpoint path to scan metadata.
    """
    if _is_remote_ocr_mode_guard():
        raise OcrEngineUnavailable(
            "In-process OCR is disabled in remote_worker mode; dispatch jobs to the remote OCR worker."
        )
    _scan_runtime_context.provenance = None
    try:
        paddle_engine, vietocr_engine = _get_ocr_engines()
    except OcrEngineUnavailable:
        fallback = _extract_text_and_boxes_tesseract(image_bytes)
        paddle_reason = (
            "Package paddleocr is not installed."
            if _paddle_initialization_status == "not_installed"
            else (
                "PaddleOCR import or model initialization failed "
                f"({_paddle_initialization_error or _paddle_initialization_status})."
            )
        )
        return _attach_vietocr_provenance(
            _attach_engine_statuses(
                fallback,
                {
                    "paddleocr": _paddle_initialization_status,
                    "vietocr": "not_run",
                    "tesseract": "success",
                },
                {
                    "paddleocr": paddle_reason,
                    "vietocr": "VietOCR recognition requires PaddleOCR line regions.",
                },
            ),
            None,
            skipped_reason="paddle_unavailable",
        )
    scan_snapshot = getattr(_scan_runtime_context, "provenance", None)
    _scan_runtime_context.provenance = None
    # If a test or external caller supplies an engine without the verified
    # loader, it must never inherit a hash from the previous scan.
    if not isinstance(scan_snapshot, dict):
        scan_snapshot = _scan_vietocr_snapshot(vietocr_engine)

    try:
        result = _extract_text_and_boxes_dual_engine(
            image_bytes, paddle_engine, vietocr_engine
        )
        return _attach_vietocr_provenance(result, scan_snapshot)
    except OcrNoTextDetected:
        fallback = _extract_text_and_boxes_tesseract(image_bytes)
        return _attach_vietocr_provenance(
            _attach_engine_statuses(
                fallback,
                {"paddleocr": "no_result", "vietocr": "not_run", "tesseract": "success"},
                {"vietocr": "PaddleOCR did not produce line regions for VietOCR."},
            ),
            scan_snapshot,
            skipped_reason="paddle_no_text",
        )
    except OcrEngineUnavailable:
        fallback = _extract_text_and_boxes_tesseract(image_bytes)
        return _attach_vietocr_provenance(
            _attach_engine_statuses(
                fallback,
                {"paddleocr": "error", "vietocr": "not_run", "tesseract": "success"},
                {"vietocr": "PaddleOCR failed before VietOCR received line regions."},
            ),
            scan_snapshot,
            skipped_reason="paddle_inference_error",
        )
    except Exception:
        # A post-initialization pipeline bug is not proof that either OCR engine
        # failed. Do not silently discard dual-engine evidence for Tesseract output.
        logger.exception(
            "Hybrid OCR processing failed after engine initialization; "
            "refusing to replace dual-engine processing with Tesseract fallback"
        )
        raise
