#!/usr/bin/env python3
"""ViRead real hardware/AI benchmark: 3-engine OCR proof, Ollama A/B, and Voice contention.

Runs strictly against local/staging processes and produces aggregate-only JSON and
Markdown artifacts. Never prints or writes private dataset text, ground truth,
image paths, or environment secrets.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import ctypes
import hashlib
import json
import math
import os
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen


def _parse_pre_args(argv: list[str]) -> argparse.Namespace:
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--cpu-threads", type=int, default=None)
    pre.add_argument("--env-file", type=Path, default=None)
    ns, _ = pre.parse_known_args(argv)
    return ns


def _load_env_file_quiet(env_path: Path | None) -> None:
    if env_path is None:
        return
    resolved = env_path.expanduser().resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Env file not found: {resolved}")
    try:
        from dotenv import dotenv_values
        values = dotenv_values(resolved)
    except ImportError:
        values = {}
        for line in resolved.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, val = stripped.split("=", 1)
            values[key.strip()] = val.strip().strip('"').strip("'")
    for key, value in values.items():
        if value is not None and not (os.getenv(key) or "").strip():
            os.environ[key] = value


def _apply_thread_env(cpu_threads: int | None) -> None:
    if cpu_threads is None:
        return
    cap = str(max(1, int(cpu_threads)))
    for var in (
        "OMP_NUM_THREADS",
        "OMP_THREAD_LIMIT",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "VIREAD_OCR_CPU_THREADS",
    ):
        os.environ[var] = cap


# Apply env/thread caps and import torch BEFORE paddle (Windows shm.dll requirement).
_PRE_ARGS = _parse_pre_args(sys.argv[1:])
_apply_thread_env(_PRE_ARGS.cpu_threads)
_load_env_file_quiet(_PRE_ARGS.env_file)

import torch  # noqa: E402  (MUST precede paddle/ocr_engine imports on Windows)
import cv2  # noqa: E402
import httpx  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPO_ROOT / "backend"
BACKEND_SCRIPTS = BACKEND_ROOT / "scripts"
for _p in (str(BACKEND_ROOT), str(BACKEND_SCRIPTS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ocr_benchmark_metrics as bm  # noqa: E402
from ocr_bbox_integrity import inspect_word_boxes  # noqa: E402
from ocr_word_error_diagnostics import analyze_word_errors  # noqa: E402
from app.services import ocr_engine  # noqa: E402
from app.services.admin_ocr_chunking import ChunkingConfig, chunk_ocr_text, reconstruct_ocr_text  # noqa: E402
from app.services.admin_ocr_local import (  # noqa: E402
    LocalOcrConfig,
    _crop_chunk_image,
    _prepare_source_image,
)
from app.services.ocr_ai.exceptions import OcrProviderError  # noqa: E402
from app.services.ocr_ai.prompts import (  # noqa: E402
    SYSTEM_PROMPT,
    chunk_prompt,
    json_output_contract,
    response_json_schema,
)
from app.services.ocr_ai.validators import decode_and_validate_content  # noqa: E402
from app.services.viread_vietocr_v2_preprocessing import preprocess_line_array  # noqa: E402

EXPECTED_VIETOCR_PROFILE = "FLOW1_EXTERNAL_TRDG"
EXPECTED_VIETOCR_SHA = "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6"
VOICE_BASE_URL = "http://127.0.0.1:8010"
OLLAMA_BASE_URL = "http://127.0.0.1:11434"
OLLAMA_ISOLATED_PORT = 11435
VOICE_CACHE_DIR = Path(r"F:\c1\tools\voice-runtime\tts-cache")
MAX_IMAGE_BYTES = 12 * 1024 * 1024

_PRIORITY_CLASSES = {
    "Idle": 0x00000040,
    "BelowNormal": 0x00004000,
    "Normal": 0x00000020,
    "AboveNormal": 0x00008000,
    "High": 0x00000080,
}
_PRIORITY_NAMES = {v: k for k, v in _PRIORITY_CLASSES.items()}


@dataclass(frozen=True)
class EvalCase:
    case_index: int
    image_path: Path
    condition: str
    source_type: str
    truth_norm: str
    truth_lines: tuple[str, ...]


def _normalize_text(value: str) -> str:
    return unicodedata.normalize("NFC", " ".join(value.split()))


def _normalize_line(value: str) -> str:
    return unicodedata.normalize("NFC", " ".join(value.split()))


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    idx = max(0, math.ceil(q * len(ordered)) - 1)
    return round(float(ordered[idx]), 2)


def _edit_distance(left: list[str] | str, right: list[str] | str) -> int:
    if len(left) < len(right):
        left, right = right, left
    prev = list(range(len(right) + 1))
    for i, a in enumerate(left, start=1):
        curr = [i]
        for j, b in enumerate(right, start=1):
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + (a != b)))
        prev = curr
    return prev[-1]


def load_eval_cases(dataset_path: Path) -> list[EvalCase]:
    manifest = dataset_path.expanduser().resolve()
    root = manifest.parent
    cases: list[EvalCase] = []
    for idx, line in enumerate(manifest.read_text(encoding="utf-8-sig").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        rel = Path(str(row["image"]))
        img = rel.resolve() if rel.is_absolute() else (root / rel).resolve()
        if not img.is_file() or img.stat().st_size > MAX_IMAGE_BYTES:
            raise FileNotFoundError(f"Invalid image at dataset entry #{idx}")
        raw_gt = str(row["ground_truth"])
        truth_lines = tuple(
            norm for ln in raw_gt.splitlines() if (norm := _normalize_line(ln))
        )
        truth_norm = _normalize_text(raw_gt)
        if not truth_norm:
            raise ValueError(f"Empty ground_truth at dataset entry #{idx}")
        cases.append(
            EvalCase(
                case_index=len(cases) + 1,
                image_path=img,
                condition=str(row.get("condition", "unspecified")),
                source_type=str(row.get("source_type", "unspecified")),
                truth_norm=truth_norm,
                truth_lines=truth_lines,
            )
        )
    if not cases:
        raise ValueError("Dataset contains no cases")
    return cases


def _get_ram_stats() -> dict[str, float]:
    class MEMORYSTATUSEX(ctypes.Structure):
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

    m = MEMORYSTATUSEX()
    m.dwLength = ctypes.sizeof(m)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    total = m.ullTotalPhys / (1024 * 1024)
    avail = m.ullAvailPhys / (1024 * 1024)
    return {
        "total_mib": round(total, 1),
        "avail_mib": round(avail, 1),
        "used_mib": round(total - avail, 1),
        "load_pct": float(m.dwMemoryLoad),
    }


def _get_gpu_stats() -> dict[str, float | None]:
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=memory.used,memory.free,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            timeout=5,
        ).strip()
        first = out.splitlines()[0].split(",")
        return {
            "vram_used_mib": float(first[0].strip()),
            "vram_free_mib": float(first[1].strip()),
            "vram_total_mib": float(first[2].strip()),
            "gpu_util_pct": float(first[3].strip()),
        }
    except Exception:
        return {
            "vram_used_mib": None,
            "vram_free_mib": None,
            "vram_total_mib": None,
            "gpu_util_pct": None,
        }


class ResourceSampler:
    """Background RAM/VRAM peak monitor using 250ms polling."""

    def __init__(self, interval_s: float = 0.25) -> None:
        self.interval_s = interval_s
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.ram_avail_samples: list[float] = []
        self.ram_used_samples: list[float] = []
        self.ram_load_samples: list[float] = []
        self.vram_used_samples: list[float] = []
        self.gpu_util_samples: list[float] = []

    def _run(self) -> None:
        while not self._stop.is_set():
            ram = _get_ram_stats()
            gpu = _get_gpu_stats()
            self.ram_avail_samples.append(ram["avail_mib"])
            self.ram_used_samples.append(ram["used_mib"])
            self.ram_load_samples.append(ram["load_pct"])
            if gpu["vram_used_mib"] is not None:
                self.vram_used_samples.append(float(gpu["vram_used_mib"]))
            if gpu["gpu_util_pct"] is not None:
                self.gpu_util_samples.append(float(gpu["gpu_util_pct"]))
            self._stop.wait(self.interval_s)

    def __enter__(self) -> "ResourceSampler":
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def summary(self) -> dict[str, Any]:
        return {
            "min_ram_avail_mib": round(min(self.ram_avail_samples), 1) if self.ram_avail_samples else None,
            "peak_ram_used_mib": round(max(self.ram_used_samples), 1) if self.ram_used_samples else None,
            "peak_ram_load_pct": round(max(self.ram_load_samples), 1) if self.ram_load_samples else None,
            "peak_vram_used_mib": round(max(self.vram_used_samples), 1) if self.vram_used_samples else None,
            "peak_gpu_util_pct": round(max(self.gpu_util_samples), 1) if self.gpu_util_samples else None,
        }


def _get_process_priority(pid: int) -> str | None:
    if os.name != "nt":
        return None
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        cls = ctypes.windll.kernel32.GetPriorityClass(handle)
        return _PRIORITY_NAMES.get(cls, f"0x{cls:x}")
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _set_process_priority(pid: int, name: str) -> bool:
    if os.name != "nt" or name not in _PRIORITY_CLASSES:
        return False
    PROCESS_SET_INFORMATION = 0x0200
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(
        PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, False, pid
    )
    if not handle:
        return False
    try:
        ok = bool(ctypes.windll.kernel32.SetPriorityClass(handle, _PRIORITY_CLASSES[name]))
        return ok
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _find_listening_pid(port: int) -> int | None:
    try:
        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess",
            ],
            text=True,
            timeout=5,
        ).strip()
        return int(out) if out else None
    except Exception:
        return None


def _evaluate_reading_order(gt_lines: tuple[str, ...], ocr_text: str) -> dict[str, Any]:
    ocr_lines = [norm for ln in ocr_text.splitlines() if (norm := _normalize_line(ln))]
    matched_gt_indices: list[int] = []
    used_gt: set[int] = set()
    for o_line in ocr_lines:
        best_idx = None
        best_sim = 0.0
        for g_idx, g_line in enumerate(gt_lines):
            if g_idx in used_gt:
                continue
            denom = max(1, len(g_line), len(o_line))
            sim = 1.0 - (_edit_distance(list(g_line), list(o_line)) / denom)
            if sim > best_sim:
                best_sim = sim
                best_idx = g_idx
        if best_idx is not None and best_sim >= 0.45:
            used_gt.add(best_idx)
            matched_gt_indices.append(best_idx)
    inversions = 0
    for i in range(len(matched_gt_indices)):
        for j in range(i + 1, len(matched_gt_indices)):
            if matched_gt_indices[i] > matched_gt_indices[j]:
                inversions += 1
    return {
        "gt_line_count": len(gt_lines),
        "ocr_line_count": len(ocr_lines),
        "line_count_exact": len(ocr_lines) == len(gt_lines),
        "matched_lines": len(matched_gt_indices),
        "order_inversions": inversions,
        "strict_order_ok": (
            inversions == 0 and len(matched_gt_indices) == len(gt_lines) and len(ocr_lines) == len(gt_lines)
        ),
    }


def _strict_bbox_check(words: object) -> dict[str, Any]:
    report = inspect_word_boxes(words)
    strict_unit_violations = 0
    if isinstance(words, list):
        for w in words:
            if not isinstance(w, dict):
                continue
            bbox = w.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            x, y, bw, bh = [float(v) for v in bbox]
            if x < 0.0 or y < 0.0 or bw <= 0.0 or bh <= 0.0 or (x + bw) > 1.0 or (y + bh) > 1.0:
                strict_unit_violations += 1
    report["strict_unit_violations"] = strict_unit_violations
    return report


def _pool_engine_metrics(
    page_metrics: list[dict[str, object]],
    latencies_ms: list[float],
    order_results: list[dict[str, Any]],
    bbox_reports: list[dict[str, Any]],
    chars_wrong: int,
    chars_total: int,
    words_wrong: int,
    words_total: int,
    exact_pages: int,
    diacritic_errs_total: int,
) -> dict[str, Any]:
    merged = bm.merge_text_metrics(page_metrics)
    exact_w, total_w = merged["exact_word"]
    diac_w, total_diac_w = merged["diacritic_word"]
    tone_ok, tone_tot = merged["tone"]
    vq_ok, vq_tot = merged["vowel_quality"]
    d_ok, d_tot = merged["d_stroke"]
    return {
        "pages": len(page_metrics),
        "exact_page_matches": exact_pages,
        "micro_cer": round(chars_wrong / chars_total, 6) if chars_total else None,
        "micro_wer": round(words_wrong / words_total, 6) if words_total else None,
        "mean_cer": round(float(merged["mean_cer"]), 6) if merged["mean_cer"] is not None else None,
        "mean_wer": round(float(merged["mean_wer"]), 6) if merged["mean_wer"] is not None else None,
        "exact_word_accuracy": f"{exact_w}/{total_w} ({100.0 * exact_w / max(1, total_w):.2f}%)",
        "diacritic_word_accuracy": f"{diac_w}/{total_diac_w} ({100.0 * diac_w / max(1, total_diac_w):.2f}%)",
        "diacritic_error_count": diacritic_errs_total,
        "tone_accuracy": f"{tone_ok}/{tone_tot} ({100.0 * tone_ok / max(1, tone_tot):.2f}%)",
        "vowel_quality_accuracy": f"{vq_ok}/{vq_tot} ({100.0 * vq_ok / max(1, vq_tot):.2f}%)",
        "d_stroke_accuracy": f"{d_ok}/{d_tot} ({100.0 * d_ok / max(1, d_tot):.2f}%)",
        "reading_order": {
            "line_count_exact_pages": sum(1 for r in order_results if r["line_count_exact"]),
            "strict_order_ok_pages": sum(1 for r in order_results if r["strict_order_ok"]),
            "total_inversions": sum(int(r["order_inversions"]) for r in order_results),
            "total_gt_lines": sum(int(r["gt_line_count"]) for r in order_results),
            "total_ocr_lines": sum(int(r["ocr_line_count"]) for r in order_results),
        },
        "bbox_integrity": {
            "reported_words": sum(int(r["reported_words"]) for r in bbox_reports),
            "valid_boxes": sum(int(r["valid_boxes"]) for r in bbox_reports),
            "invalid_boxes": sum(int(r["invalid_boxes"]) for r in bbox_reports),
            "strict_unit_violations": sum(int(r["strict_unit_violations"]) for r in bbox_reports),
        } if bbox_reports else None,
        "timing_ms": {
            "mean": round(statistics.mean(latencies_ms), 2) if latencies_ms else None,
            "p50": _percentile(latencies_ms, 0.50),
            "p95": _percentile(latencies_ms, 0.95),
            "max": round(max(latencies_ms), 2) if latencies_ms else None,
            "total": round(sum(latencies_ms), 2) if latencies_ms else None,
        },
    }


def _count_diacritic_substitutions(gt_norm: str, pred_norm: str) -> int:
    diag = analyze_word_errors(gt_norm, pred_norm)
    if diag.get("status") != "complete":
        return 0
    return sum(1 for err in diag.get("errors", []) if err.get("kind") == "diacritic_or_d_stroke")


def run_cold_cache_probe(dataset_path: Path, probe_index: int = 0) -> dict[str, Any]:
    cases = load_eval_cases(dataset_path)
    case = cases[probe_index]
    temp_dir = Path(tempfile.gettempdir())
    evicted = ocr_engine.evict_cached_viread_checkpoint(EXPECTED_VIETOCR_SHA)
    pth_path = temp_dir / f"viread-vietocr-v2-{EXPECTED_VIETOCR_SHA}.pth"
    yml_path = temp_dir / f"viread-vietocr-v2-{EXPECTED_VIETOCR_SHA}.yml"
    pre_absent = (not pth_path.exists()) and (not yml_path.exists())

    img_bytes = case.image_path.read_bytes()
    t0 = time.perf_counter()
    output = ocr_engine.extract_text_and_boxes(img_bytes)
    elapsed_ms = (time.perf_counter() - t0) * 1000

    post_pth_exists = pth_path.is_file()
    post_yml_exists = yml_path.is_file()
    reassembled_sha = ocr_engine._sha256_path(str(pth_path)) if post_pth_exists else None
    meta = output.get("metadata") if isinstance(output, dict) else {}
    prov = meta.get("vietocr_runtime_provenance") if isinstance(meta, dict) else {}
    statuses = meta.get("engine_statuses") if isinstance(meta, dict) else {}
    norm_text = _normalize_text(str(output.get("text", "")))
    return {
        "evicted_existing_cache": evicted,
        "cache_absent_before_run": pre_absent,
        "cold_init_plus_page_ms": round(elapsed_ms, 2),
        "cache_pth_recovered": post_pth_exists,
        "cache_yml_recovered": post_yml_exists,
        "reassembled_pth_sha256_matches": reassembled_sha == EXPECTED_VIETOCR_SHA,
        "model_profile": prov.get("model_profile") if isinstance(prov, dict) else None,
        "checkpoint_sha256": prov.get("checkpoint_sha256") if isinstance(prov, dict) else None,
        "model_load_status": prov.get("model_load_status") if isinstance(prov, dict) else None,
        "model_inference_status": prov.get("model_inference_status") if isinstance(prov, dict) else None,
        "fallback_reason": prov.get("fallback_reason") if isinstance(prov, dict) else None,
        "engine_statuses": statuses,
        "text_sha256": _sha256_bytes(norm_text.encode("utf-8")),
    }


def _reapply_torch_cap_if_set(cpu_threads: int | None) -> None:
    if cpu_threads is not None:
        torch.set_num_threads(max(1, int(cpu_threads)))


def run_ocr_section(
    dataset_path: Path,
    *,
    env_file: Path | None,
    cpu_threads: int | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    cases = load_eval_cases(dataset_path)

    # Check Tesseract binary & language data
    tess_cmd = ocr_engine._resolve_tesseract_command()
    tess_configured = ocr_engine._configure_tesseract()
    tess_version = None
    tess_langs: list[str] = []
    if tess_cmd:
        try:
            ver_out = subprocess.check_output([tess_cmd, "--version"], text=True, timeout=5)
            tess_version = ver_out.splitlines()[0].strip() if ver_out else None
        except Exception:
            pass
    if tess_configured:
        try:
            import pytesseract
            tess_langs = sorted(pytesseract.get_languages(config=""))
        except Exception:
            pass

    init_t0 = time.perf_counter()
    paddle_engine, vietocr_engine = ocr_engine._get_ocr_engines()
    _reapply_torch_cap_if_set(cpu_threads)
    init_ms = (time.perf_counter() - init_t0) * 1000
    viet_status = ocr_engine.get_loaded_vietocr_runtime_status()

    # Warmup 1 page before measuring steady-state latencies
    _ = ocr_engine.extract_text_and_boxes(cases[0].image_path.read_bytes())

    def _run_paddle_and_lines(img_bytes: bytes) -> tuple[str, list[dict[str, Any]], float]:
        arr = np.frombuffer(img_bytes, dtype=np.uint8)
        image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        orig_h, orig_w = image.shape[:2]
        scale = 1.0
        max_dim = max(orig_w, orig_h)
        if max_dim < 1500:
            scale = min(2.5, 1500.0 / max_dim)
            proc = cv2.resize(image, (int(round(orig_w * scale)), int(round(orig_h * scale))), interpolation=cv2.INTER_CUBIC)
        else:
            proc = image
        t0 = time.perf_counter()
        ocr_res = paddle_engine.ocr(proc, cls=False)
        raw_items = ocr_res[0] if (ocr_res and ocr_res[0] is not None) else []
        if scale > 1.01:
            for item in raw_items:
                item[0] = np.array(item[0], dtype=np.float32) / scale
        ordered_items, _layout = ocr_engine.sort_reading_order_adaptive(
            raw_items, img_width=orig_w, image=image
        )
        lines = [
            ocr_engine.clean_ocr_punctuation(str(item["paddle_text"]))
            for item in ordered_items
            if str(item["paddle_text"]).strip()
        ]
        elapsed = (time.perf_counter() - t0) * 1000
        return "\n".join(lines), ordered_items, elapsed

    def _run_vietocr_on_lines(ordered_items: list[dict[str, Any]]) -> tuple[str, float]:
        profile = ocr_engine._inference_model_profile(vietocr_engine)
        t0 = time.perf_counter()
        lines: list[str] = []
        for item in ordered_items:
            dewarped = item["dewarped_img"]
            h_crop, w_crop = dewarped.shape[:2]
            if w_crop < 8 or h_crop < 8:
                continue
            if h_crop < 52:
                target_h = 56
                target_w = int(round(w_crop * (target_h / h_crop)))
                scaled = cv2.resize(dewarped, (target_w, target_h), interpolation=cv2.INTER_CUBIC)
            else:
                scaled = dewarped
            with torch.inference_mode():
                if profile in {"FLOW1_EXTERNAL_TRDG", "FLOW2_ADMIN_VERIFIED"}:
                    pred_img = Image.fromarray(
                        cv2.cvtColor(preprocess_line_array(scaled), cv2.COLOR_BGR2RGB)
                    )
                else:
                    pred_img = Image.fromarray(cv2.cvtColor(scaled, cv2.COLOR_BGR2RGB))
                txt = vietocr_engine.predict(pred_img)
            if isinstance(txt, str) and txt.strip():
                lines.append(unicodedata.normalize("NFC", txt).strip())
        elapsed = (time.perf_counter() - t0) * 1000
        return "\n".join(lines), elapsed

    arms_data: dict[str, dict[str, Any]] = {
        name: {
            "page_metrics": [],
            "latencies": [],
            "order_results": [],
            "bbox_reports": [],
            "chars_wrong": 0,
            "chars_total": 0,
            "words_wrong": 0,
            "words_total": 0,
            "exact_pages": 0,
            "diacritic_errs": 0,
        }
        for name in ("paddleocr_alone", "vietocr_alone", "tesseract_vie_alone", "combined_pipeline")
    }

    combined_outputs_for_ollama: list[dict[str, Any]] = []
    combined_by_condition: dict[str, dict[str, Any]] = {}
    provenance_all_ok = True
    engines_all_ok = True
    page0_combined_sha = None

    def _record_arm(arm: str, case: EvalCase, raw_text: str, ms: float, words_obj: object | None = None) -> None:
        bucket = arms_data[arm]
        pred_norm = _normalize_text(raw_text)
        gt_norm = case.truth_norm
        bucket["page_metrics"].append(bm.text_metrics(gt_norm.split(), pred_norm.split()))
        bucket["latencies"].append(ms)
        bucket["order_results"].append(_evaluate_reading_order(case.truth_lines, raw_text))
        if words_obj is not None:
            bucket["bbox_reports"].append(_strict_bbox_check(words_obj))
        bucket["chars_wrong"] += _edit_distance(list(pred_norm), list(gt_norm))
        bucket["chars_total"] += len(gt_norm)
        bucket["words_wrong"] += _edit_distance(pred_norm.split(), gt_norm.split())
        bucket["words_total"] += len(gt_norm.split())
        bucket["exact_pages"] += int(pred_norm == gt_norm)
        bucket["diacritic_errs"] += _count_diacritic_substitutions(gt_norm, pred_norm)

    for case in cases:
        img_bytes = case.image_path.read_bytes()

        # 1. PaddleOCR alone + line regions
        p_text, ordered_items, p_ms = _run_paddle_and_lines(img_bytes)
        _record_arm("paddleocr_alone", case, p_text, p_ms)

        # 2. VietOCR alone (recognizing the PaddleOCR-detected line crops)
        v_text, v_ms = _run_vietocr_on_lines(ordered_items)
        _record_arm("vietocr_alone", case, v_text, v_ms)

        # 3. Tesseract vie alone
        t0 = time.perf_counter()
        t_out = ocr_engine._extract_text_and_boxes_tesseract(img_bytes)
        t_ms = (time.perf_counter() - t0) * 1000
        _record_arm("tesseract_vie_alone", case, str(t_out["text"]), t_ms, t_out.get("words"))

        # 4. Combined 3-engine extract_text_and_boxes pipeline
        t0 = time.perf_counter()
        c_out = ocr_engine.extract_text_and_boxes(img_bytes)
        c_ms = (time.perf_counter() - t0) * 1000
        c_text = str(c_out["text"])
        if case.case_index == 1:
            page0_combined_sha = _sha256_bytes(_normalize_text(c_text).encode("utf-8"))
        _record_arm("combined_pipeline", case, c_text, c_ms, c_out.get("words"))

        meta = c_out.get("metadata") if isinstance(c_out, dict) else {}
        statuses = meta.get("engine_statuses") if isinstance(meta, dict) else {}
        prov = meta.get("vietocr_runtime_provenance") if isinstance(meta, dict) else {}
        if not isinstance(statuses, dict) or any(statuses.get(k) != "success" for k in ("paddleocr", "vietocr", "tesseract")):
            engines_all_ok = False
        if (
            not isinstance(prov, dict)
            or prov.get("model_profile") != EXPECTED_VIETOCR_PROFILE
            or prov.get("checkpoint_sha256") != EXPECTED_VIETOCR_SHA
            or prov.get("model_load_status") != "loaded"
            or prov.get("model_inference_status") != "success"
            or prov.get("fallback_reason") is not None
        ):
            provenance_all_ok = False

        pred_norm = _normalize_text(c_text)
        cond_b = combined_by_condition.setdefault(
            case.condition,
            {"cases": 0, "char_edits": 0, "ref_chars": 0, "word_edits": 0, "ref_words": 0, "diacritic_errors": 0, "ms": []},
        )
        cond_b["cases"] += 1
        cond_b["char_edits"] += _edit_distance(list(pred_norm), list(case.truth_norm))
        cond_b["ref_chars"] += len(case.truth_norm)
        cond_b["word_edits"] += _edit_distance(pred_norm.split(), case.truth_norm.split())
        cond_b["ref_words"] += len(case.truth_norm.split())
        cond_b["diacritic_errors"] += _count_diacritic_substitutions(case.truth_norm, pred_norm)
        cond_b["ms"].append(round(c_ms, 2))

        word_boxes = [tuple(float(v) for v in w["bbox"]) for w in c_out["words"]]
        combined_outputs_for_ollama.append(
            {
                "case": case,
                "image_bytes": img_bytes,
                "ocr_text": unicodedata.normalize("NFC", c_text),
                "word_boxes": word_boxes,
                "ocr_ms": c_ms,
                "metadata": meta,
            }
        )

    # Cold cache probe in an isolated fresh subprocess
    cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--dataset",
        str(dataset_path),
        "--section",
        "cold-cache-probe",
        "--probe-image-index",
        "0",
    ]
    if env_file is not None:
        cmd.extend(["--env-file", str(env_file)])
    if cpu_threads is not None:
        cmd.extend(["--cpu-threads", str(cpu_threads)])
    probe_proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, check=False)
    if probe_proc.returncode == 0:
        cold_probe = json.loads(probe_proc.stdout)
        cold_probe["matches_warm_page0_output"] = cold_probe.get("text_sha256") == page0_combined_sha
    else:
        cold_probe = {
            "error": "cold_cache_probe_failed",
            "returncode": probe_proc.returncode,
            "stderr_tail": probe_proc.stderr[-500:] if probe_proc.stderr else "",
        }

    pooled = {
        name: _pool_engine_metrics(
            d["page_metrics"],
            d["latencies"],
            d["order_results"],
            d["bbox_reports"],
            d["chars_wrong"],
            d["chars_total"],
            d["words_wrong"],
            d["words_total"],
            d["exact_pages"],
            d["diacritic_errs"],
        )
        for name, d in arms_data.items()
    }
    pooled["vietocr_alone"]["note"] = "Latency measures VietOCR recognition+preprocessing only on PaddleOCR-detected dewarped lines."

    ocr_report = {
        "runtime": {
            "python_version": sys.version.split()[0],
            "torch_version": torch.__version__,
            "torch_cuda_available": torch.cuda.is_available(),
            "torch_num_threads": torch.get_num_threads(),
            "paddle_version": package_version("paddlepaddle"),
            "paddleocr_version": package_version("paddleocr"),
            "vietocr_version": package_version("vietocr"),
            "pytesseract_version": package_version("pytesseract"),
            "tesseract_cmd_found": bool(tess_cmd),
            "tesseract_version": tess_version,
            "tesseract_vie_available": "vie" in tess_langs,
            "cold_engine_init_ms": round(init_ms, 2),
            "vietocr_runtime_status": {
                "initialized": viet_status.get("initialized"),
                "loaded_profile": viet_status.get("loaded_profile"),
                "loaded_checkpoint_sha256": viet_status.get("loaded_checkpoint_sha256"),
                "verified_runtime_proof": viet_status.get("verified_runtime_proof"),
            },
            "all_pages_3_engines_success": engines_all_ok,
            "all_pages_vietocr_provenance_verified": provenance_all_ok,
        },
        "engines": pooled,
        "combined_by_condition": {
            cond: {
                "cases": b["cases"],
                "cer": round(b["char_edits"] / max(1, b["ref_chars"]), 6),
                "wer": round(b["word_edits"] / max(1, b["ref_words"]), 6),
                "diacritic_errors": b["diacritic_errors"],
                "ms": b["ms"],
            }
            for cond, b in sorted(combined_by_condition.items())
        },
        "cold_cache_recovery": cold_probe,
    }
    return ocr_report, combined_outputs_for_ollama


def _ollama_unload(base_url: str, model: str) -> None:
    try:
        httpx.post(
            f"{base_url}/api/chat",
            json={"model": model, "keep_alive": 0, "messages": []},
            timeout=30.0,
            trust_env=False,
        )
    except Exception:
        pass


def _ollama_ps(base_url: str) -> list[dict[str, Any]]:
    try:
        r = httpx.get(f"{base_url}/api/ps", timeout=10.0, trust_env=False)
        return r.json().get("models", []) if r.status_code == 200 else []
    except Exception:
        return []


def _wait_ollama_unloaded(base_url: str) -> None:
    for m in list(_ollama_ps(base_url)):
        name = m.get("name") or m.get("model")
        if name:
            _ollama_unload(base_url, str(name))
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        if not _ollama_ps(base_url):
            return
        time.sleep(0.3)


def _check_upstream_ollama_release() -> dict[str, Any]:
    try:
        req = Request(
            "https://api.github.com/repos/ollama/ollama/releases/latest",
            headers={"User-Agent": "ViRead-Benchmark"},
        )
        with urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {
            "checked": True,
            "latest_tag": data.get("tag_name"),
            "published_at": data.get("published_at"),
            "prerelease": data.get("prerelease"),
        }
    except (URLError, OSError, ValueError) as exc:
        return {"checked": False, "error": type(exc).__name__}


def _start_isolated_ollama(port: int, num_parallel: int = 1, keep_alive: str = "2m") -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env["OLLAMA_HOST"] = f"127.0.0.1:{port}"
    env["OLLAMA_NUM_PARALLEL"] = str(num_parallel)
    env["OLLAMA_KEEP_ALIVE"] = keep_alive
    env["OLLAMA_MAX_LOADED_MODELS"] = "1"
    ollama_exe = str(Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe")
    if not Path(ollama_exe).is_file():
        ollama_exe = "ollama"
    proc = subprocess.Popen(
        [ollama_exe, "serve"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"http://127.0.0.1:{port}/api/version", timeout=2.0, trust_env=False)
            if r.status_code == 200:
                return proc
        except Exception:
            pass
        time.sleep(0.25)
    proc.terminate()
    raise RuntimeError(f"Isolated Ollama failed to listen on port {port}")


def _voice_headers() -> dict[str, str]:
    tok = (os.getenv("VIREAD_VOICE_WORKER_TOKEN") or "").strip()
    return {"X-ViRead-Voice-Token": tok} if tok else {}


def _build_stt_probe_clips(n_clips: int = 10) -> list[tuple[str, bytes]]:
    phrases = [
        "Bé An đang đọc sách tiếng Việt.",
        "Hôm nay trời nắng đẹp, chim hót trên cành.",
        "Mẹ chuẩn bị bánh mì và sữa cho bữa sáng.",
        "Đàn cá bơi lội tung tăng dưới dòng sông xanh.",
        "Chú mèo nhỏ nằm ngủ ngoan dưới gốc cây.",
        "Những bông hoa nở rực rỡ trong khu vườn nhỏ.",
        "Hai chị em cùng thả diều trên cánh đồng.",
        "Trăng rằm sáng tỏ giữa bầu trời đêm nay.",
        "Bà kể chuyện cổ tích cho cháu nghe mỗi tối.",
        "Cả nhà quây quần bên mâm cơm ấm cúng.",
    ]
    clips: list[tuple[str, bytes]] = []
    with httpx.Client(base_url=VOICE_BASE_URL, timeout=30.0, trust_env=False, headers=_voice_headers()) as client:
        for i in range(n_clips):
            text = phrases[i % len(phrases)]
            r = client.post(
                "/tts",
                json={"text": text, "voice_id": "local_north_truc_ly", "speed": 1.0},
            )
            r.raise_for_status()
            clips.append((text, r.content))
    return clips


def _snapshot_voice_cache() -> set[str]:
    if not VOICE_CACHE_DIR.is_dir():
        return set()
    return {p.name for p in VOICE_CACHE_DIR.iterdir() if p.is_file()}


def _cleanup_new_voice_cache(before: set[str]) -> int:
    if not VOICE_CACHE_DIR.is_dir():
        return 0
    removed = 0
    for p in VOICE_CACHE_DIR.iterdir():
        if p.is_file() and p.name not in before:
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    return removed


async def _concurrent_voice_load_loop(
    stop_event: asyncio.Event,
    stt_clips: list[tuple[str, bytes]],
    run_tag: str,
) -> dict[str, Any]:
    tts_ms: list[float] = []
    timed_ms: list[float] = []
    stt_ms: list[float] = []
    failures = 0
    turn = 0
    num_words_vi = [
        "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín", "mười",
        "mười một", "mười hai", "mười ba", "mười bốn", "mười lăm",
    ]
    async with httpx.AsyncClient(
        base_url=VOICE_BASE_URL,
        timeout=httpx.Timeout(20.0, connect=5.0),
        trust_env=False,
        headers=_voice_headers(),
    ) as client:
        while not stop_event.is_set():
            word_num = num_words_vi[turn % len(num_words_vi)]
            cycle = turn // len(num_words_vi)
            try:
                # Alternate TTS, timed-TTS, and STT sequentially like an active child reader
                t0 = time.perf_counter()
                r1 = await client.post(
                    "/tts",
                    json={
                        "text": f"Chú thỏ nhỏ đọc trang {word_num} lần {num_words_vi[cycle % len(num_words_vi)]}.",
                        "voice_id": "local_north_truc_ly",
                        "speed": 1.0,
                    },
                )
                dt1 = (time.perf_counter() - t0) * 1000
                if r1.status_code == 200:
                    tts_ms.append(dt1)
                else:
                    failures += 1

                if stop_event.is_set():
                    break

                t0 = time.perf_counter()
                r2 = await client.post(
                    "/tts/timed",
                    json={
                        "text": f"Chim non hót vang bài {word_num} lượt {num_words_vi[(cycle + 1) % len(num_words_vi)]}.",
                        "voice_id": "local_north_truc_ly",
                        "speed": 1.0,
                    },
                )
                dt2 = (time.perf_counter() - t0) * 1000
                if r2.status_code == 200:
                    timed_ms.append(dt2)
                else:
                    failures += 1

                if stop_event.is_set():
                    break

                _, clip = stt_clips[turn % len(stt_clips)]
                t0 = time.perf_counter()
                r3 = await client.post(
                    "/stt",
                    files={"audio_file": ("clip.wav", clip, "audio/wav")},
                    data={"language": "vi"},
                )
                dt3 = (time.perf_counter() - t0) * 1000
                if r3.status_code == 200:
                    stt_ms.append(dt3)
                else:
                    failures += 1
            except Exception:
                failures += 1
            turn += 1
            await asyncio.sleep(0.1)
    return {
        "run_tag": run_tag,
        "tts_turns": len(tts_ms),
        "tts_p50_ms": _percentile(tts_ms, 0.50),
        "tts_p95_ms": _percentile(tts_ms, 0.95),
        "timed_turns": len(timed_ms),
        "timed_p50_ms": _percentile(timed_ms, 0.50),
        "timed_p95_ms": _percentile(timed_ms, 0.95),
        "stt_turns": len(stt_ms),
        "stt_p50_ms": _percentile(stt_ms, 0.50),
        "stt_p95_ms": _percentile(stt_ms, 0.95),
        "failures": failures,
    }


def _score_word_diffs(source_text: str, result_text: str, gt_text: str) -> dict[str, int]:
    """Compare source -> result against ground truth without folding diacritics."""
    src_tokens = bm.attach_punctuation(_normalize_text(source_text).split())
    res_tokens = bm.attach_punctuation(_normalize_text(result_text).split())
    gt_tokens = bm.attach_punctuation(_normalize_text(gt_text).split())

    def _map_to_gt(ocr_list: list[dict[str, object]]) -> dict[int, str]:
        mapping: dict[int, str] = {}
        for step in bm.align_words(gt_tokens, ocr_list):
            p = step["primary_index"]
            s = step["secondary_index"]
            if p is not None and s is not None:
                mapping[int(p)] = str(ocr_list[int(s)]["key"])
        return mapping

    src_map = _map_to_gt(src_tokens)
    res_map = _map_to_gt(res_tokens)
    attempted = 0
    tp_fixes = 0
    harmful = 0
    neutral_changes = 0
    for gt_idx, gt_item in enumerate(gt_tokens):
        gt_key = str(gt_item["key"])
        src_key = src_map.get(gt_idx)
        res_key = res_map.get(gt_idx)
        if src_key is None or res_key is None:
            continue
        if res_key != src_key:
            attempted += 1
            if src_key != gt_key and res_key == gt_key:
                tp_fixes += 1
            elif src_key == gt_key and res_key != gt_key:
                harmful += 1
            else:
                # Both wrong: check if CER improved or worsened
                d_before = _edit_distance(src_key, gt_key)
                d_after = _edit_distance(res_key, gt_key)
                if d_after < d_before:
                    tp_fixes += 1
                elif d_after > d_before:
                    harmful += 1
                else:
                    neutral_changes += 1
    return {
        "attempted_changes": attempted,
        "true_positive_fixes": tp_fixes,
        "harmful_changes": harmful,
        "neutral_changes": neutral_changes,
    }


async def _run_ollama_arm(
    *,
    arm_name: str,
    base_url: str,
    model: str,
    num_ctx: int,
    num_predict: int,
    keep_alive: int | str,
    prepared_cases: list[dict[str, Any]],
    stt_clips: list[tuple[str, bytes]],
    max_pages: int | None = None,
    timeout_s: int = 180,
) -> dict[str, Any]:
    _wait_ollama_unloaded(base_url)
    subset = prepared_cases[:max_pages] if max_pages else prepared_cases
    chunk_cfg = ChunkingConfig.from_environment()

    page_ms: list[float] = []
    cold_load_wall_ms: float | None = None
    ollama_load_durations_ms: list[float] = []
    prompt_eval_counts: list[int] = []
    decode_tps_list: list[float] = []
    json_fallback_calls = 0

    total_chunks = 0
    valid_json_chunks = 0
    schema_or_net_errors = 0
    ok_pages = 0
    failed_pages = 0

    chars_wrong = chars_total = words_wrong = words_total = 0
    base_chars_wrong = base_words_wrong = 0
    diac_errs = base_diac_errs = 0
    dropped_lines_vs_gt = dropped_lines_vs_src = 0
    tp_fixes = harmful = attempted = neutral = 0
    ps_snapshots: list[dict[str, Any]] = []

    stop_voice = asyncio.Event()
    voice_task: asyncio.Task[dict[str, Any]] | None = None
    if stt_clips:
        voice_task = asyncio.create_task(
            _concurrent_voice_load_loop(stop_voice, stt_clips, arm_name)
        )

    with ResourceSampler(0.25) as sampler:
        async with httpx.AsyncClient(
            base_url=base_url.rstrip("/") + "/",
            timeout=httpx.Timeout(float(timeout_s), connect=10.0),
            trust_env=False,
            follow_redirects=False,
        ) as client:
            for idx, item in enumerate(subset):
                case: EvalCase = item["case"]
                source_text: str = item["ocr_text"]
                word_boxes: list[tuple[float, float, float, float]] = item["word_boxes"]
                plan = chunk_ocr_text(
                    source_text,
                    chunk_cfg,
                    word_normalizer=ocr_engine.normalize_word,
                )
                prepared_img = await asyncio.to_thread(_prepare_source_image, item["image_bytes"])

                p_start = time.perf_counter()
                corrected_by_chunk: dict[int, tuple[str, ...]] = {}
                page_failed = False

                for chunk in plan.chunks:
                    total_chunks += 1
                    crop = await asyncio.to_thread(
                        _crop_chunk_image,
                        prepared_img,
                        word_boxes[chunk.start_token_index : chunk.end_token_index],
                    )
                    img_b64 = base64.b64encode(crop).decode("ascii")

                    def _payload(use_json_fb: bool) -> dict[str, object]:
                        prompt_text = f"{SYSTEM_PROMPT}\n\n{chunk_prompt(chunk)}"
                        if use_json_fb:
                            prompt_text = f"{prompt_text}{json_output_contract(chunk)}"
                        return {
                            "model": model,
                            "stream": False,
                            "think": False,
                            "keep_alive": keep_alive,
                            "format": "json" if use_json_fb else response_json_schema(chunk.expected_word_count),
                            "messages": [
                                {"role": "user", "content": prompt_text, "images": [img_b64]}
                            ],
                            "options": {
                                "temperature": 0,
                                "num_ctx": num_ctx,
                                "num_predict": min(
                                    num_predict,
                                    max(256, 128 + chunk.expected_word_count * 16),
                                ),
                            },
                        }

                    try:
                        resp = await client.post("api/chat", json=_payload(False))
                        if resp.status_code in (400, 422):
                            json_fallback_calls += 1
                            resp = await client.post("api/chat", json=_payload(True))
                        if resp.status_code != 200:
                            raise OcrProviderError(provider="ollama", code="HTTP_ERR", status_code=resp.status_code)
                        data = resp.json()
                        if "load_duration" in data:
                            ollama_load_durations_ms.append(data["load_duration"] / 1e6)
                        if "prompt_eval_count" in data:
                            prompt_eval_counts.append(int(data["prompt_eval_count"]))
                        if data.get("eval_count") and data.get("eval_duration"):
                            tps = float(data["eval_count"]) / (float(data["eval_duration"]) / 1e9)
                            decode_tps_list.append(tps)
                        content = (data.get("message") or {}).get("content")
                        decoded = decode_and_validate_content(content, chunk=chunk, provider="ollama")
                        valid_json_chunks += 1
                        corrected_by_chunk[chunk.chunk_id] = decoded.corrected_words
                    except Exception:
                        schema_or_net_errors += 1
                        page_failed = True
                        break

                elapsed = (time.perf_counter() - p_start) * 1000
                if idx == 0:
                    cold_load_wall_ms = elapsed
                    ps_now = _ollama_ps(base_url)
                    if ps_now:
                        ps_snapshots.extend(ps_now)
                page_ms.append(elapsed)

                gt_norm = case.truth_norm
                src_norm = _normalize_text(source_text)
                chars_total += len(gt_norm)
                words_total += len(gt_norm.split())
                base_chars_wrong += _edit_distance(list(src_norm), list(gt_norm))
                base_words_wrong += _edit_distance(src_norm.split(), gt_norm.split())
                base_diac_errs += _count_diacritic_substitutions(gt_norm, src_norm)

                if not page_failed:
                    try:
                        reconstructed = reconstruct_ocr_text(plan, corrected_by_chunk)
                    except Exception:
                        page_failed = True
                if page_failed:
                    failed_pages += 1
                    # Record fallback to source text for fail-closed comparison
                    res_text = source_text
                else:
                    ok_pages += 1
                    res_text = reconstructed

                res_norm = _normalize_text(res_text)
                chars_wrong += _edit_distance(list(res_norm), list(gt_norm))
                words_wrong += _edit_distance(res_norm.split(), gt_norm.split())
                diac_errs += _count_diacritic_substitutions(gt_norm, res_norm)

                gt_lc = len(case.truth_lines)
                src_lc = len([ln for ln in source_text.splitlines() if ln.strip()])
                res_lc = len([ln for ln in res_text.splitlines() if ln.strip()])
                dropped_lines_vs_gt += max(0, gt_lc - res_lc)
                dropped_lines_vs_src += max(0, src_lc - res_lc)

                diffs = _score_word_diffs(source_text, res_text, case.truth_norm)
                attempted += diffs["attempted_changes"]
                tp_fixes += diffs["true_positive_fixes"]
                harmful += diffs["harmful_changes"]
                neutral += diffs["neutral_changes"]

                if idx == len(subset) - 1 and not ps_snapshots:
                    ps_snapshots.extend(_ollama_ps(base_url))
                print(
                    f"[ollama-arm:{arm_name}] page {idx + 1}/{len(subset)} "
                    f"ms={elapsed:.1f} failed={page_failed}",
                    file=sys.stderr,
                    flush=True,
                )

    stop_voice.set()
    voice_stats = await voice_task if voice_task is not None else None
    res_summary = sampler.summary()

    warm_ms = page_ms[1:] if len(page_ms) > 1 else page_ms
    ps_entry = ps_snapshots[0] if ps_snapshots else {}
    size_b = ps_entry.get("size")
    vram_b = ps_entry.get("size_vram")
    offload_pct = round(100.0 * float(vram_b) / float(size_b), 1) if size_b and vram_b is not None else None

    return {
        "arm": arm_name,
        "model": model,
        "num_ctx": num_ctx,
        "num_predict": num_predict,
        "keep_alive": str(keep_alive),
        "pages_tested": len(subset),
        "ok_pages": ok_pages,
        "failed_pages": failed_pages,
        "cold_first_page_ms": round(cold_load_wall_ms, 2) if cold_load_wall_ms is not None else None,
        "ollama_first_load_duration_ms": round(ollama_load_durations_ms[0], 2) if ollama_load_durations_ms else None,
        "warm_p50_page_ms": _percentile(warm_ms, 0.50),
        "warm_p95_page_ms": _percentile(warm_ms, 0.95),
        "warm_mean_page_ms": round(statistics.mean(warm_ms), 2) if warm_ms else None,
        "total_wall_ms": round(sum(page_ms), 2),
        "valid_json_rate": round(valid_json_chunks / max(1, total_chunks), 4),
        "valid_chunks": valid_json_chunks,
        "total_chunks": total_chunks,
        "json_fallback_calls": json_fallback_calls,
        "baseline_ocr_cer": round(base_chars_wrong / max(1, chars_total), 6),
        "after_ollama_cer": round(chars_wrong / max(1, chars_total), 6),
        "baseline_ocr_wer": round(base_words_wrong / max(1, words_total), 6),
        "after_ollama_wer": round(words_wrong / max(1, words_total), 6),
        "baseline_diacritic_errors": base_diac_errs,
        "after_diacritic_errors": diac_errs,
        "dropped_lines_vs_gt": dropped_lines_vs_gt,
        "dropped_lines_vs_ocr": dropped_lines_vs_src,
        "attempted_word_changes": attempted,
        "true_positive_fixes": tp_fixes,
        "harmful_changes": harmful,
        "neutral_changes": neutral,
        "net_fixes": tp_fixes - harmful,
        "prompt_eval_tokens_max": max(prompt_eval_counts) if prompt_eval_counts else None,
        "prompt_eval_tokens_mean": round(statistics.mean(prompt_eval_counts), 1) if prompt_eval_counts else None,
        "decode_tokens_per_sec_mean": round(statistics.mean(decode_tps_list), 2) if decode_tps_list else None,
        "ollama_ps_total_mib": round(float(size_b) / (1024 * 1024), 1) if size_b else None,
        "ollama_ps_vram_mib": round(float(vram_b) / (1024 * 1024), 1) if vram_b is not None else None,
        "ollama_ps_gpu_offload_pct": offload_pct,
        "resources": res_summary,
        "concurrent_voice": voice_stats,
    }


def _measure_model_swap_costs(base_url: str) -> dict[str, Any]:
    def _ping(model: str) -> float:
        t0 = time.perf_counter()
        r = httpx.post(
            f"{base_url}/api/chat",
            json={
                "model": model,
                "stream": False,
                "think": False,
                "keep_alive": "2m",
                "messages": [{"role": "user", "content": "OK"}],
                "options": {"temperature": 0, "num_ctx": 2048, "num_predict": 8},
            },
            timeout=180.0,
            trust_env=False,
        )
        r.raise_for_status()
        return (time.perf_counter() - t0) * 1000

    _wait_ollama_unloaded(base_url)
    load_4b_ms = _ping("qwen3-vl:4b-instruct-q4_K_M")
    t_swap_4_to_2 = _ping("qwen3-vl:2b-instruct-q4_K_M")
    t_swap_2_to_4 = _ping("qwen3-vl:4b-instruct-q4_K_M")
    _wait_ollama_unloaded(base_url)
    return {
        "cold_load_4b_ms": round(load_4b_ms, 2),
        "swap_4b_to_2b_ms": round(t_swap_4_to_2, 2),
        "swap_2b_to_4b_ms": round(t_swap_2_to_4, 2),
    }


def _prepare_combined_ocr_only(
    dataset_path: Path,
    *,
    cpu_threads: int | None = None,
) -> list[dict[str, Any]]:
    cases = load_eval_cases(dataset_path)
    ocr_engine._get_ocr_engines()
    _reapply_torch_cap_if_set(cpu_threads)
    prepared: list[dict[str, Any]] = []
    for case in cases:
        img_bytes = case.image_path.read_bytes()
        t0 = time.perf_counter()
        c_out = ocr_engine.extract_text_and_boxes(img_bytes)
        c_ms = (time.perf_counter() - t0) * 1000
        c_text = unicodedata.normalize("NFC", str(c_out["text"]))
        word_boxes = [tuple(float(v) for v in w["bbox"]) for w in c_out["words"]]
        prepared.append(
            {
                "case": case,
                "image_bytes": img_bytes,
                "ocr_text": c_text,
                "word_boxes": word_boxes,
                "ocr_ms": c_ms,
                "metadata": c_out.get("metadata") if isinstance(c_out, dict) else {},
            }
        )
    print(f"[ocr-prepare] prepared {len(prepared)} cases via extract_text_and_boxes", file=sys.stderr, flush=True)
    return prepared


def run_ollama_section(
    dataset_path: Path,
    prepared_cases: list[dict[str, Any]] | None = None,
    *,
    cpu_threads: int | None = None,
) -> dict[str, Any]:
    if prepared_cases is None:
        prepared_cases = _prepare_combined_ocr_only(dataset_path, cpu_threads=cpu_threads)

    ver_resp = httpx.get(f"{OLLAMA_BASE_URL}/api/version", timeout=5.0, trust_env=False).json()
    tags_resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5.0, trust_env=False).json()
    models_meta = {
        m["name"]: {
            "digest": m.get("digest"),
            "size_bytes": m.get("size"),
            "size_mib": round(float(m.get("size", 0)) / (1024 * 1024), 1),
            "details": m.get("details"),
        }
        for m in tags_resp.get("models", [])
        if m.get("name") in {"qwen3-vl:4b-instruct-q4_K_M", "qwen3-vl:2b-instruct-q4_K_M"}
    }

    ram_with_ocr_voice = _get_ram_stats()
    gpu_with_ocr_voice = _get_gpu_stats()
    upstream_check = _check_upstream_ollama_release()
    stt_clips = _build_stt_probe_clips(8)

    async def _run_all_arms() -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        # (a) Baseline 4b num_ctx=4096 keep_alive=5m
        results.append(
            await _run_ollama_arm(
                arm_name="a_4b_baseline_ctx4096_ka5m",
                base_url=OLLAMA_BASE_URL,
                model="qwen3-vl:4b-instruct-q4_K_M",
                num_ctx=4096,
                num_predict=1024,
                keep_alive="5m",
                prepared_cases=prepared_cases,
                stt_clips=stt_clips,
            )
        )
        # (b1) Tuned 4b num_ctx=2048 keep_alive=2m
        results.append(
            await _run_ollama_arm(
                arm_name="b1_4b_ctx2048_ka2m",
                base_url=OLLAMA_BASE_URL,
                model="qwen3-vl:4b-instruct-q4_K_M",
                num_ctx=2048,
                num_predict=1024,
                keep_alive="2m",
                prepared_cases=prepared_cases,
                stt_clips=stt_clips,
            )
        )
        # (b2) 4b keep_alive=0 (forced unload/reload every page, 5 pages to bound wall time)
        results.append(
            await _run_ollama_arm(
                arm_name="b2_4b_ctx2048_ka0_unload",
                base_url=OLLAMA_BASE_URL,
                model="qwen3-vl:4b-instruct-q4_K_M",
                num_ctx=2048,
                num_predict=1024,
                keep_alive=0,
                prepared_cases=prepared_cases,
                stt_clips=stt_clips,
                max_pages=5,
            )
        )
        # (c1) 2b num_ctx=4096 keep_alive=2m
        results.append(
            await _run_ollama_arm(
                arm_name="c1_2b_ctx4096_ka2m",
                base_url=OLLAMA_BASE_URL,
                model="qwen3-vl:2b-instruct-q4_K_M",
                num_ctx=4096,
                num_predict=1024,
                keep_alive="2m",
                prepared_cases=prepared_cases,
                stt_clips=stt_clips,
            )
        )
        # (c2) 2b num_ctx=2048 keep_alive=2m
        results.append(
            await _run_ollama_arm(
                arm_name="c2_2b_ctx2048_ka2m",
                base_url=OLLAMA_BASE_URL,
                model="qwen3-vl:2b-instruct-q4_K_M",
                num_ctx=2048,
                num_predict=1024,
                keep_alive="2m",
                prepared_cases=prepared_cases,
                stt_clips=stt_clips,
            )
        )
        # (b3) Isolated Ollama server with explicit OLLAMA_NUM_PARALLEL=1
        _wait_ollama_unloaded(OLLAMA_BASE_URL)
        iso_proc = _start_isolated_ollama(OLLAMA_ISOLATED_PORT, num_parallel=1, keep_alive="2m")
        try:
            iso_url = f"http://127.0.0.1:{OLLAMA_ISOLATED_PORT}"
            results.append(
                await _run_ollama_arm(
                    arm_name="b3_2b_explicit_num_parallel_1_ctx2048",
                    base_url=iso_url,
                    model="qwen3-vl:2b-instruct-q4_K_M",
                    num_ctx=2048,
                    num_predict=1024,
                    keep_alive="2m",
                    prepared_cases=prepared_cases,
                    stt_clips=stt_clips,
                )
            )
            _wait_ollama_unloaded(iso_url)
        finally:
            iso_proc.terminate()
            try:
                iso_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                iso_proc.kill()
        return results

    arms = asyncio.run(_run_all_arms())
    swap_costs = _measure_model_swap_costs(OLLAMA_BASE_URL)
    _wait_ollama_unloaded(OLLAMA_BASE_URL)

    return {
        "environment": {
            "ollama_server_version": ver_resp.get("version"),
            "ollama_python_client_version": package_version("ollama"),
            "upstream_release_check": upstream_check,
            "models": models_meta,
            "host_ram_with_voice_and_ocr": ram_with_ocr_voice,
            "gpu_vram_with_voice_and_ocr": gpu_with_ocr_voice,
        },
        "arms": arms,
        "model_swap_costs": swap_costs,
    }


def run_ocr_stress_worker(
    dataset_path: Path,
    *,
    cpu_threads: int | None,
    ollama_model: str,
    status_file: Path,
    reapply_torch_cap: bool = True,
) -> None:
    """Looping heavy 3-engine OCR + Ollama worker for Voice contention benchmarking."""
    cases = load_eval_cases(dataset_path)
    paddle_engine, vietocr_engine = ocr_engine._get_ocr_engines()
    if reapply_torch_cap and cpu_threads is not None:
        torch.set_num_threads(max(1, int(cpu_threads)))
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass
    del paddle_engine, vietocr_engine

    chunk_cfg = ChunkingConfig.from_environment()
    pages_done = 0
    ocr_ms_list: list[float] = []
    ollama_ms_list: list[float] = []
    stop_flag = status_file.with_suffix(".stop")

    def _write_status() -> None:
        status_file.write_text(
            json.dumps(
                {
                    "pid": os.getpid(),
                    "priority": _get_process_priority(os.getpid()),
                    "cpu_threads": cpu_threads,
                    "torch_num_threads": torch.get_num_threads(),
                    "ollama_model": ollama_model,
                    "pages_done": pages_done,
                    "ocr_mean_ms": round(statistics.mean(ocr_ms_list), 1) if ocr_ms_list else None,
                    "ollama_mean_ms": round(statistics.mean(ollama_ms_list), 1) if ollama_ms_list else None,
                }
            ),
            encoding="utf-8",
        )

    _write_status()
    with httpx.Client(base_url=OLLAMA_BASE_URL, timeout=120.0, trust_env=False) as client:
        idx = 0
        while not stop_flag.exists():
            case = cases[idx % len(cases)]
            idx += 1
            img_bytes = case.image_path.read_bytes()
            t0 = time.perf_counter()
            out = ocr_engine.extract_text_and_boxes(img_bytes)
            ocr_ms_list.append((time.perf_counter() - t0) * 1000)

            if stop_flag.exists():
                pages_done += 1
                _write_status()
                break

            text = unicodedata.normalize("NFC", str(out["text"]))
            boxes = [tuple(float(v) for v in w["bbox"]) for w in out["words"]]
            plan = chunk_ocr_text(text, chunk_cfg, word_normalizer=ocr_engine.normalize_word)
            prepared = _prepare_source_image(img_bytes)
            t1 = time.perf_counter()
            for chunk in plan.chunks:
                if stop_flag.exists():
                    break
                crop = _crop_chunk_image(prepared, boxes[chunk.start_token_index : chunk.end_token_index])
                payload = {
                    "model": ollama_model,
                    "stream": False,
                    "think": False,
                    "keep_alive": "2m",
                    "format": response_json_schema(chunk.expected_word_count),
                    "messages": [
                        {
                            "role": "user",
                            "content": f"{SYSTEM_PROMPT}\n\n{chunk_prompt(chunk)}",
                            "images": [base64.b64encode(crop).decode("ascii")],
                        }
                    ],
                    "options": {"temperature": 0, "num_ctx": 2048, "num_predict": 512},
                }
                try:
                    client.post("/api/chat", json=payload)
                except Exception:
                    pass
            ollama_ms_list.append((time.perf_counter() - t1) * 1000)
            pages_done += 1
            _write_status()


def _run_30_voice_turns(regime_tag: str, stt_clips: list[tuple[str, bytes]]) -> dict[str, Any]:
    """Execute 30 uncached TTS + 30 uncached timed-TTS + 30 real STT turns sequentially."""
    words_vi = [
        "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín", "mười",
        "mười một", "mười hai", "mười ba", "mười bốn", "mười lăm",
        "mười sáu", "mười bảy", "mười tám", "mười chín", "hai mươi",
        "hai mươi mốt", "hai mươi hai", "hai mươi ba", "hai mươi bốn", "hai mươi lăm",
        "hai mươi sáu", "hai mươi bảy", "hai mươi tám", "hai mươi chín", "ba mươi",
    ]
    nouns = ["cây xanh", "bông hoa", "con mèo", "chú thỏ", "đàn chim", "dòng sông"]
    regime_word_tag = {
        "idle": "nắng",
        "uncapped_normal": "gió",
        "cap4_isolated": "mưa",
        "cap2_isolated_2b": "sao",
        "cap2_isolated_4b": "mây",
        "cap1_isolated_2b": "trăng",
    }.get(regime_tag, "hoa")

    tts_ms: list[float] = []
    timed_ms: list[float] = []
    stt_ms: list[float] = []
    tts_fail = timed_fail = stt_fail = 0

    with httpx.Client(
        base_url=VOICE_BASE_URL,
        timeout=httpx.Timeout(30.0, connect=5.0),
        trust_env=False,
        headers=_voice_headers(),
    ) as client:
        for i in range(30):
            noun = nouns[i % len(nouns)]
            num = words_vi[i]
            tts_text = (
                f"{noun} {regime_word_tag} {num}"
                if i % 2 == 0
                else f"Bé nhìn thấy {noun} {regime_word_tag} số {num}."
            )
            t0 = time.perf_counter()
            try:
                r1 = client.post(
                    "/tts",
                    json={
                        "text": tts_text,
                        "voice_id": "local_north_truc_ly",
                        "speed": 1.0,
                        "word_sample": (i % 2 == 0),
                    },
                )
                dt1 = (time.perf_counter() - t0) * 1000
                if r1.status_code == 200 and len(r1.content) > 44:
                    tts_ms.append(dt1)
                else:
                    tts_fail += 1
            except Exception:
                tts_fail += 1

            timed_text = f"Đoạn đọc {regime_word_tag} số {num} có {noun} đẹp."
            t0 = time.perf_counter()
            try:
                r2 = client.post(
                    "/tts/timed",
                    json={
                        "text": timed_text,
                        "voice_id": "local_north_truc_ly",
                        "speed": 1.0,
                    },
                )
                dt2 = (time.perf_counter() - t0) * 1000
                if r2.status_code == 200 and r2.json().get("words"):
                    timed_ms.append(dt2)
                else:
                    timed_fail += 1
            except Exception:
                timed_fail += 1

            _, clip = stt_clips[i % len(stt_clips)]
            t0 = time.perf_counter()
            try:
                r3 = client.post(
                    "/stt",
                    files={"audio_file": ("turn.wav", clip, "audio/wav")},
                    data={"language": "vi"},
                )
                dt3 = (time.perf_counter() - t0) * 1000
                if r3.status_code == 200 and isinstance(r3.json().get("text"), str):
                    stt_ms.append(dt3)
                else:
                    stt_fail += 1
            except Exception:
                stt_fail += 1

    all_tts = tts_ms + timed_ms
    total_failures = tts_fail + timed_fail + stt_fail
    tts_p95 = _percentile(tts_ms, 0.95)
    timed_p95 = _percentile(timed_ms, 0.95)
    stt_p95 = _percentile(stt_ms, 0.95)
    return {
        "regime": regime_tag,
        "turns": 30,
        "tts": {
            "count": len(tts_ms),
            "failures": tts_fail,
            "p50_ms": _percentile(tts_ms, 0.50),
            "p95_ms": tts_p95,
            "max_ms": round(max(tts_ms), 2) if tts_ms else None,
        },
        "timed_tts": {
            "count": len(timed_ms),
            "failures": timed_fail,
            "p50_ms": _percentile(timed_ms, 0.50),
            "p95_ms": timed_p95,
            "max_ms": round(max(timed_ms), 2) if timed_ms else None,
        },
        "combined_tts_p95_ms": _percentile(all_tts, 0.95),
        "stt": {
            "count": len(stt_ms),
            "failures": stt_fail,
            "p50_ms": _percentile(stt_ms, 0.50),
            "p95_ms": stt_p95,
            "max_ms": round(max(stt_ms), 2) if stt_ms else None,
        },
        "total_failures": total_failures,
        "meets_sla": (
            total_failures == 0
            and stt_p95 is not None and stt_p95 <= 3000.0
            and tts_p95 is not None and tts_p95 <= 2000.0
            and timed_p95 is not None and timed_p95 <= 2000.0
        ),
    }


def run_voice_contention_section(dataset_path: Path, *, env_file: Path | None) -> dict[str, Any]:
    voice_pid = _find_listening_pid(8010)
    if voice_pid is None:
        raise RuntimeError("Voice Worker is not listening on 127.0.0.1:8010")
    original_voice_prio = _get_process_priority(voice_pid)
    stt_clips = _build_stt_probe_clips(10)

    # Warmup 1 STT + 1 TTS call so JIT/filter buffers are warm
    with httpx.Client(base_url=VOICE_BASE_URL, timeout=30.0, trust_env=False, headers=_voice_headers()) as c:
        c.post("/tts", json={"text": "khởi động", "voice_id": "local_north_truc_ly", "speed": 1.0, "word_sample": True})
        c.post("/stt", files={"audio_file": ("w.wav", stt_clips[0][1], "audio/wav")}, data={"language": "vi"})

    regimes_spec = [
        ("idle", None, "Normal", "Normal", None),
        ("uncapped_normal", None, "Normal", "Normal", "qwen3-vl:2b-instruct-q4_K_M"),
        ("cap4_isolated", 4, "BelowNormal", "AboveNormal", "qwen3-vl:2b-instruct-q4_K_M"),
        ("cap2_isolated_2b", 2, "BelowNormal", "AboveNormal", "qwen3-vl:2b-instruct-q4_K_M"),
        ("cap2_isolated_4b", 2, "BelowNormal", "AboveNormal", "qwen3-vl:4b-instruct-q4_K_M"),
        ("cap1_isolated_2b", 1, "BelowNormal", "AboveNormal", "qwen3-vl:2b-instruct-q4_K_M"),
    ]

    results: list[dict[str, Any]] = []
    try:
        for tag, cpu_cap, ocr_prio, voice_prio, ollama_model in regimes_spec:
            print(
                f"[voice-regime] starting {tag} (voice={voice_prio}, ocr={ocr_prio}, threads={cpu_cap}, ollama={ollama_model})",
                file=sys.stderr,
                flush=True,
            )
            _set_process_priority(voice_pid, voice_prio)
            applied_voice_prio = _get_process_priority(voice_pid)

            if ollama_model is None:
                _wait_ollama_unloaded(OLLAMA_BASE_URL)
                with ResourceSampler(0.25) as sampler:
                    voice_res = _run_30_voice_turns(tag, stt_clips)
                results.append({
                    **voice_res,
                    "voice_priority": applied_voice_prio,
                    "ocr_priority": None,
                    "cpu_threads": None,
                    "ollama_model": None,
                    "ocr_worker_progress": None,
                    "resources": sampler.summary(),
                })
                continue

            with tempfile.TemporaryDirectory(prefix="viread-stress-") as tmp_dir:
                status_file = Path(tmp_dir) / "status.json"
                stop_file = status_file.with_suffix(".stop")
                cmd = [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--dataset",
                    str(dataset_path),
                    "--section",
                    "ocr-stress-worker",
                    "--ollama-model",
                    ollama_model,
                    "--status-file",
                    str(status_file),
                ]
                if env_file is not None:
                    cmd.extend(["--env-file", str(env_file)])
                if cpu_cap is not None:
                    cmd.extend(["--cpu-threads", str(cpu_cap)])

                cflags = _PRIORITY_CLASSES.get(ocr_prio, 0) if os.name == "nt" else 0
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=cflags,
                )
                try:
                    # Wait until stress worker initializes OCR engines & starts page 1
                    wait_deadline = time.monotonic() + 60.0
                    while time.monotonic() < wait_deadline:
                        if status_file.is_file() or proc.poll() is not None:
                            break
                        time.sleep(0.25)
                    # Give OCR+Ollama ~2s to enter active inference
                    time.sleep(2.0)

                    with ResourceSampler(0.25) as sampler:
                        voice_res = _run_30_voice_turns(tag, stt_clips)

                    stop_file.write_text("stop", encoding="utf-8")
                    try:
                        proc.wait(timeout=45)
                    except subprocess.TimeoutExpired:
                        proc.terminate()
                        proc.wait(timeout=5)
                finally:
                    if proc.poll() is None:
                        proc.kill()

                worker_status = (
                    json.loads(status_file.read_text(encoding="utf-8"))
                    if status_file.is_file()
                    else {}
                )
                results.append({
                    **voice_res,
                    "voice_priority": applied_voice_prio,
                    "ocr_priority": ocr_prio,
                    "cpu_threads": cpu_cap if cpu_cap is not None else "uncapped",
                    "ollama_model": ollama_model,
                    "ocr_worker_progress": worker_status,
                    "resources": sampler.summary(),
                })
    finally:
        if original_voice_prio and original_voice_prio in _PRIORITY_CLASSES:
            _set_process_priority(voice_pid, original_voice_prio)
        _wait_ollama_unloaded(OLLAMA_BASE_URL)

    return {
        "voice_worker_pid": voice_pid,
        "original_voice_priority": original_voice_prio,
        "restored_voice_priority": _get_process_priority(voice_pid),
        "regimes": results,
    }


def _render_markdown_summary(report: dict[str, Any]) -> str:
    lines: list[str] = [
        "# ViRead Real Hardware, 3-Engine OCR, Ollama A/B & Voice Contention Benchmark",
        "",
        f"- **Timestamp (UTC):** {report.get('timestamp_utc')}",
        f"- **Dataset Cases:** {report.get('dataset_case_count')}",
        "",
    ]
    if "ocr_proof" in report and report["ocr_proof"]:
        ocr = report["ocr_proof"]
        rt = ocr["runtime"]
        lines.extend([
            "## 1. Real 3-Engine + Combined Pipeline OCR Proof",
            f"- **Python / Torch / Paddle / VietOCR:** `{rt['python_version']}` / `{rt['torch_version']}` (cuda={rt['torch_cuda_available']}) / `{rt['paddle_version']}` / `{rt['vietocr_version']}`",
            f"- **Tesseract:** `{rt['tesseract_version']}` (`vie` available: `{rt['tesseract_vie_available']}`)",
            f"- **VietOCR Active Profile / SHA:** `{rt['vietocr_runtime_status']['loaded_profile']}` / `{rt['vietocr_runtime_status']['loaded_checkpoint_sha256']}` (verified={rt['vietocr_runtime_status']['verified_runtime_proof']})",
            f"- **All pages 3 engines `success`:** `{rt['all_pages_3_engines_success']}` | **VietOCR provenance verified:** `{rt['all_pages_vietocr_provenance_verified']}`",
            "",
            "| Engine / Pipeline | Micro CER | Micro WER | Exact Word | Diacritic Word | Tone Acc | Vowel Qual | đ Acc | Strict Order | Invalid Boxes | P50 (ms) | P95 (ms) |",
            "|---|---:|---:|---|---|---|---|---|---|---:|---:|---:|",
        ])
        for key, label in [
            ("paddleocr_alone", "PaddleOCR alone"),
            ("vietocr_alone", "VietOCR alone (rec)"),
            ("tesseract_vie_alone", "Tesseract vie alone"),
            ("combined_pipeline", "Combined `extract_text_and_boxes`"),
        ]:
            e = ocr["engines"][key]
            ro = e["reading_order"]
            bx = e["bbox_integrity"]
            inv_str = f"{bx['invalid_boxes']} (strict>{1}:{bx['strict_unit_violations']})" if bx else "N/A"
            lines.append(
                f"| {label} | {e['micro_cer']} | {e['micro_wer']} | {e['exact_word_accuracy']} | "
                f"{e['diacritic_word_accuracy']} | {e['tone_accuracy']} | {e['vowel_quality_accuracy']} | "
                f"{e['d_stroke_accuracy']} | {ro['strict_order_ok_pages']}/{e['pages']} | "
                f"{inv_str} | {e['timing_ms']['p50']} | {e['timing_ms']['p95']} |"
            )
        cc = ocr["cold_cache_recovery"]
        lines.extend([
            "",
            "### Cold-Cache Initialization & Recovery",
            f"- Cache absent before run: `{cc.get('cache_absent_before_run')}` | Recovered `.pth`/`.yml`: `{cc.get('cache_pth_recovered')}`/`{cc.get('cache_yml_recovered')}` | SHA match: `{cc.get('reassembled_pth_sha256_matches')}` | Cold init+page ms: `{cc.get('cold_init_plus_page_ms')}` | Matches warm page-0 output: `{cc.get('matches_warm_page0_output')}`",
            "",
        ])

    if "ollama_ab" in report and report["ollama_ab"]:
        ol = report["ollama_ab"]
        env = ol["environment"]
        lines.extend([
            "## 2. Ollama A/B Evaluation (Under Concurrent Voice Load)",
            f"- **Ollama Server / Client:** `{env['ollama_server_version']}` / `{env['ollama_python_client_version']}` | Upstream check: `{env['upstream_release_check']}`",
            f"- **Host RAM with Voice+OCR loaded:** `{env['host_ram_with_voice_and_ocr']}`",
            f"- **GPU VRAM with Voice+OCR loaded:** `{env['gpu_vram_with_voice_and_ocr']}`",
            "",
            "| Arm | Cold ms | Warm P50/P95 ms | VRAM/Total MiB | Valid JSON | Base->After CER | Diac Err | Dropped Lines | TP Fixes | Harmful | Voice TTS/STT P95 ms |",
            "|---|---:|---:|---|---:|---|---:|---:|---:|---:|---|",
        ])
        for a in ol["arms"]:
            cv = a.get("concurrent_voice") or {}
            lines.append(
                f"| {a['arm']} | {a['cold_first_page_ms']} | {a['warm_p50_page_ms']}/{a['warm_p95_page_ms']} | "
                f"{a['ollama_ps_vram_mib']}/{a['ollama_ps_total_mib']} ({a['ollama_ps_gpu_offload_pct']}%) | "
                f"{a['valid_json_rate']:.2%} ({a['ok_pages']}/{a['pages_tested']}) | "
                f"{a['baseline_ocr_cer']} -> {a['after_ollama_cer']} | "
                f"{a['baseline_diacritic_errors']} -> {a['after_diacritic_errors']} | "
                f"{a['dropped_lines_vs_gt']} | {a['true_positive_fixes']} | {a['harmful_changes']} | "
                f"{cv.get('tts_p95_ms')}/{cv.get('stt_p95_ms')} (fail={cv.get('failures')}) |"
            )
        sc = ol.get("model_swap_costs") or {}
        lines.extend([
            "",
            f"- **Model-swap costs:** cold 4B `{sc.get('cold_load_4b_ms')}` ms, 4B->2B `{sc.get('swap_4b_to_2b_ms')}` ms, 2B->4B `{sc.get('swap_2b_to_4b_ms')}` ms",
            "",
        ])

    if "voice_contention" in report and report["voice_contention"]:
        vc = report["voice_contention"]
        lines.extend([
            "## 3. Decisive Voice vs OCR Contention Benchmark (30 Real Turns Each)",
            f"- **Voice Worker PID:** `{vc['voice_worker_pid']}` (original priority `{vc['original_voice_priority']}`, restored `{vc['restored_voice_priority']}`)",
            "",
            "| Regime | Voice Prio | OCR Prio / Threads | Ollama | TTS P50/P95 ms | Timed P50/P95 ms | STT P50/P95 ms | Failures | SLA Pass (STT<=3s, TTS<=2s) |",
            "|---|---|---|---|---:|---:|---:|---:|:---:|",
        ])
        for r in vc["regimes"]:
            lines.append(
                f"| {r['regime']} | {r['voice_priority']} | {r['ocr_priority']} / {r['cpu_threads']} | "
                f"{r['ollama_model']} | {r['tts']['p50_ms']}/{r['tts']['p95_ms']} | "
                f"{r['timed_tts']['p50_ms']}/{r['timed_tts']['p95_ms']} | "
                f"{r['stt']['p50_ms']}/{r['stt']['p95_ms']} | {r['total_failures']} | "
                f"{'PASS' if r['meets_sla'] else 'FAIL'} |"
            )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True, help="Private JSONL manifest path")
    parser.add_argument("--env-file", type=Path, default=None, help="Backend .env path")
    parser.add_argument("--artifact-dir", type=Path, default=None, help="Output directory for JSON/MD artifacts")
    parser.add_argument(
        "--section",
        choices=("all", "ocr", "ollama", "voice", "cold-cache-probe", "ocr-stress-worker"),
        default="all",
    )
    parser.add_argument("--cpu-threads", type=int, default=None)
    parser.add_argument("--probe-image-index", type=int, default=0)
    parser.add_argument("--ollama-model", type=str, default="qwen3-vl:2b-instruct-q4_K_M")
    parser.add_argument("--status-file", type=Path, default=None)
    args = parser.parse_args(argv)

    if args.section == "cold-cache-probe":
        print(json.dumps(run_cold_cache_probe(args.dataset, args.probe_image_index), ensure_ascii=False))
        return 0

    if args.section == "ocr-stress-worker":
        if args.status_file is None:
            parser.error("--status-file is required for ocr-stress-worker")
        run_ocr_stress_worker(
            args.dataset,
            cpu_threads=args.cpu_threads,
            ollama_model=args.ollama_model,
            status_file=args.status_file,
        )
        return 0

    cache_before = _snapshot_voice_cache()
    try:
        cases = load_eval_cases(args.dataset)
        report: dict[str, Any] = {
            "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "dataset_case_count": len(cases),
        }
        prepared_cases: list[dict[str, Any]] | None = None

        if args.section in ("all", "ocr"):
            ocr_rep, prepared_cases = run_ocr_section(
                args.dataset, env_file=args.env_file, cpu_threads=args.cpu_threads
            )
            report["ocr_proof"] = ocr_rep

        if args.section in ("all", "ollama"):
            report["ollama_ab"] = run_ollama_section(
                args.dataset, prepared_cases=prepared_cases, cpu_threads=args.cpu_threads
            )

        if args.section in ("all", "voice"):
            report["voice_contention"] = run_voice_contention_section(
                args.dataset, env_file=args.env_file
            )

        if args.artifact_dir is not None:
            out_dir = args.artifact_dir.expanduser().resolve()
            out_dir.mkdir(parents=True, exist_ok=True)
            suffix = "" if args.section == "all" else f"_{args.section}"
            json_path = out_dir / f"ollama_ocr_voice_benchmark{suffix}.json"
            md_path = out_dir / f"ollama_ocr_voice_benchmark{suffix}.md"
            json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            md_path.write_text(_render_markdown_summary(report), encoding="utf-8")

        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    finally:
        _cleanup_new_voice_cache(cache_before)


if __name__ == "__main__":
    raise SystemExit(main())
