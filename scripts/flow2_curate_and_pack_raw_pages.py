#!/usr/bin/env python3
"""Curate multi-grade Vietnamese textbook line crops from raw_pages with dual-recognizer verification.

Stages:
  1. select: Query Supabase for existing image_sha256 & ingested Grade 4 pages,
     inventory E:\\raw_pages\\raw_pages\\lop_1..lop_5, skip front/back matter, and
     partition untouched content pages cleanly into train, validation, cohort1, cohort2.
  2. vlm: Run async Cloud VLM page-level line transcription with per-page JSON caching
     and multi-provider fallback (gemini-3.1-flash-lite -> gemini-3.5-flash-lite -> Groq qwen/qwen3.8-27b).
  3. ocr: Run single-process local PaddleOCR + VietOCR (200edce4) matching ocr_engine.py
     line dewarping & upscaling, filtering visual traps (Tô và viết grids, Bản in thử, noise).
  4. align: Align VLM lines with dewarped crops via scipy linear_sum_assignment, verify
     disagreed crops via composite crop-only VLM sheets, validate hygiene/PII, balance splits,
     and write <sha256>.png crops + curated_manifest.json ready for Phase 3 tar packing.
  5. check: Run standalone integrity verification across all curated crops & manifest.
"""
from __future__ import annotations

import os

# Keep CPU BLAS/OpenMP single-threaded to avoid Windows memory contention.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("FLAGS_omp_num_threads", "1")

import argparse
import asyncio
import base64
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
import gc
import hashlib
from io import BytesIO
import json
from pathlib import Path
import random
import re
import sys
import tempfile
import time
from typing import Any
import unicodedata
from uuid import NAMESPACE_URL, uuid5

import cv2
from dotenv import load_dotenv
import httpx
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.optimize import linear_sum_assignment
import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.viread_flow2_hygiene import (
    DEFAULT_MAX_LABEL_LENGTH,
    detect_vietnamese_pii_strict,
    normalize_typographic_for_vietocr,
    open_image_exif_safe,
    sanitize_and_validate_vietocr_label,
    validate_flow2_line_crop,
)

DEFAULT_RAW_ROOT = Path(r"E:\raw_pages\raw_pages")
DEFAULT_ENV_FILE = Path(r"F:\c1\capstone1\backend\.env")
DEFAULT_OUT_DIR = Path(
    r"C:\Users\cuong\.gemini\antigravity\brain\67e59fb5-b414-4df9-8983-8734471b4249\scratch\flow2_raw_curation"
)
ACTIVE_VIETOCR_SHA256 = "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6"
ACTIVE_VIETOCR_PROFILE = "FLOW1_EXTERNAL_TRDG"

BOOK_META: dict[str, tuple[str, str]] = {
    "tieng_viet_1_tap_1": ("lop_1", "tv1"),
    "ctst_tieng_viet_2_tap_1": ("lop_2", "ctst2"),
    "kntt_tieng_viet_2_tap_1": ("lop_2", "kntt2"),
    "cd_tieng_viet_3_tap_1": ("lop_3", "cd3"),
    "kntt_tieng_viet_3_tap_1": ("lop_3", "kntt3"),
    "ctst_tieng_viet_4_tap_1": ("lop_4", "ctst4"),
    "kntt_tieng_viet_4_tap_1": ("lop_4", "kntt4"),
    "cd_tieng_viet_5_tap_1": ("lop_5", "cd5"),
    "kntt_tieng_viet_5_tap_1": ("lop_5", "kntt5"),
}

# Candidate page budgets per book: (cohort1, cohort2, train+val)
BOOK_PAGE_QUOTAS: dict[str, tuple[int, int, int]] = {
    "tieng_viet_1_tap_1": (22, 12, 60),
    "ctst_tieng_viet_2_tap_1": (10, 5, 24),
    "kntt_tieng_viet_2_tap_1": (10, 5, 24),
    "cd_tieng_viet_3_tap_1": (10, 5, 24),
    "kntt_tieng_viet_3_tap_1": (10, 5, 24),
    "ctst_tieng_viet_4_tap_1": (5, 3, 7),
    "kntt_tieng_viet_4_tap_1": (10, 5, 16),
    "cd_tieng_viet_5_tap_1": (10, 5, 24),
    "kntt_tieng_viet_5_tap_1": (10, 5, 24),
}

_PAGE_FILE_RE = re.compile(r"^(?P<slug>.+)_page_(?P<page>\d+)\.png$", re.IGNORECASE)
_STANDALONE_PAGE_NUM_RE = re.compile(r"^\d{1,3}$")
_ITEM_BADGE_RE = re.compile(r"^[\(\[]?(?:\d{1,2}|[a-zA-Z])[\)\].:]?$")
_WATERMARK_STRINGS = frozenset({
    "ket noi tri thuc voi cuoc song",
    "chan troi sang tao",
    "canh dieu",
})
_PENMANSHIP_HEADER_RE = re.compile(
    r"\b(?:to va viet|luyen viet|viet chu hoa|tap viet)\b"
)
_SECTION_BOUNDARY_RE = re.compile(
    r"(?:^\s*\d+\s*[\.\):]?\s*(?:ke chuyen|doc|noi|nghe|viet ung dung|luyen tu|van dung|tro choi|tim hieu|on tap)\b|"
    r"\b(?:ke chuyen|doc hieu|noi va nghe|viet ung dung|luyen tu va cau)\b)"
)
_BAN_IN_THU_RE = re.compile(r"\bban\s+in\s+thu\b")

_GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"

PAGE_VLM_PROMPT = """Bạn đang đọc ảnh trang sách giáo khoa Tiếng Việt tiểu học (lớp 1-5).
Hãy trích xuất chính xác TỪNG DÒNG CHỮ IN đọc được theo thứ tự đọc tự nhiên từ trên xuống dưới, trái sang phải.

Quy tắc BẮT BUỘC:
1. Chỉ trả về JSON hợp lệ với đúng cấu trúc:
   {"page_kind": "content" | "toc" | "cover" | "penmanship_only", "lines": ["dòng 1", "dòng 2", ...]}
2. Nếu đây là trang Mục lục (bảng có cột Tuần/Bài/Nội dung/Trang), đặt "page_kind": "toc" và "lines": []. Nếu là trang bìa/lời nói đầu chỉ có tiêu đề bìa, đặt "page_kind": "cover".
3. Mỗi phần tử trong "lines" phải tương ứng ĐÚNG MỘT DÒNG IN trên ảnh (KHÔNG tự ý gộp nhiều dòng thành một đoạn, KHÔNG sửa chính tả hay viết lại). Giữ nguyên dấu câu, chữ hoa/thường và dấu tiếng Việt.
4. LOẠI BỎ HOÀN TOÀN (không đưa vào "lines"):
   - Số trang đơn lẻ ở góc/chân trang (ví dụ "9", "23", "169").
   - Chữ mờ đóng dấu chìm (watermark) ở nền giữa trang như "KẾT NỐI TRI THỨC VỚI CUỘC SỐNG", "CHÂN TRỜI SÁNG TẠO".
   - Dòng chân trang "Bản in thử".
   - Mọi chữ viết tay/tô nét đứt/chữ mẫu nằm trên ô li kẻ vuông xanh ("Tô và viết", "Luyện viết", "Viết chữ hoa").
   - Ô thẻ 1 chữ cái đơn lẻ (ví dụ chỉ có "a", "b", "đ")."""

CROP_VLM_PROMPT = """Đây là ảnh ghép gồm {count} dòng cắt riêng lẻ từ sách giáo khoa Tiếng Việt, mỗi dòng có nhãn chỉ số [0], [1], ... ở lề trái và đường kẻ ngang phân cách.
Hãy đọc CHÍNH XÁC từng dòng chữ tiếng Việt tương ứng với đúng chỉ số [i].

Quy tắc BẮT BUỘC:
1. Trả về JSON đúng dạng:
   {{"items": [{{"index": 0, "text": "...", "certain": true, "bad_crop": false}}, ...]}}
2. Phải trả đủ {count} phần tử từ index 0 đến {max_idx}.
3. Giữ nguyên dấu tiếng Việt, chính tả, chữ hoa/thường và dấu câu nhìn thấy rõ trong từng ô ảnh. KHÔNG đoán mò theo trí nhớ nếu ảnh bị cắt mất chữ, mờ nhòe, chứa chữ tô ô li xanh, hoặc có nhiều dòng chồng lên nhau -> đặt "certain": false và/hoặc "bad_crop": true.
4. Không kèm markdown hay giải thích."""


def _strip_accents_lower(text: str) -> str:
    nfd = unicodedata.normalize("NFD", str(text or ""))
    no_marks = "".join(ch for ch in nfd if unicodedata.category(ch) != "Mn")
    folded = no_marks.replace("đ", "d").replace("Đ", "D")
    return " ".join(re.sub(r"[^a-zA-Z0-9\s]", " ", folded).lower().split())


def _alnum_diacritics_key(text: str) -> str:
    nfc = unicodedata.normalize("NFC", str(text or ""))
    return " ".join(
        "".join(ch if ch.isalnum() else " " for ch in nfc).split()
    )


def _edit_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    if len(left) < len(right):
        left, right = right, left
    prev = list(range(len(right) + 1))
    for i, lc in enumerate(left, 1):
        curr = [i]
        for j, rc in enumerate(right, 1):
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + (lc != rc)))
        prev = curr
    return prev[-1]


def _cer(ref: str, hyp: str) -> float:
    if not ref:
        return 0.0 if not hyp else 1.0
    return _edit_distance(ref, hyp) / float(len(ref))


def _canonical_png_bytes(bgr_or_rgb: np.ndarray, *, is_bgr: bool = True) -> tuple[bytes, Image.Image]:
    rgb_arr = cv2.cvtColor(bgr_or_rgb, cv2.COLOR_BGR2RGB) if is_bgr else bgr_or_rgb
    pil_img = Image.fromarray(rgb_arr).convert("RGB")
    buf = BytesIO()
    pil_img.save(buf, format="PNG", compress_level=3)
    return buf.getvalue(), pil_img


def _parse_existing_grade4_pages(groups: dict[str, Any]) -> set[tuple[str, int]]:
    existing: set[tuple[str, int]] = set()
    for grp, info in groups.items():
        m = re.match(r"^(ctst|kntt)-tv4-t1-p(\d+)$", grp)
        if m:
            slug = f"{m.group(1)}_tieng_viet_4_tap_1"
            existing.add((slug, int(m.group(2))))
        src = str(info.get("source_name") or "")
        m2 = re.search(r"(ctst|kntt)_tieng_viet_4_tap_1_page_(\d+)", src)
        if m2:
            existing.add((f"{m2.group(1)}_tieng_viet_4_tap_1", int(m2.group(2))))
    return existing


async def _fetch_db_exclusions() -> dict[str, Any]:
    import asyncpg

    db_url = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")
    conn = await asyncpg.connect(db_url, statement_cache_size=0, ssl="require")
    try:
        rows = await conn.fetch(
            """
            SELECT s.source_flow, s.source_group_id, s.split, s.image_sha256,
                   s.training_eligibility,
                   COALESCE(s.provenance->>'source_name', '') AS source_name,
                   COALESCE(s.provenance->>'book_slug', '') AS book_slug
            FROM public.viread_ocr_samples s
            """
        )
        hashes = sorted({str(r["image_sha256"]).lower() for r in rows if r["image_sha256"]})
        groups: dict[str, dict[str, Any]] = {}
        for r in rows:
            gid = str(r["source_group_id"])
            if gid not in groups:
                groups[gid] = {
                    "source_flow": r["source_flow"],
                    "split": r["split"],
                    "training_eligibility": r["training_eligibility"],
                    "source_name": r["source_name"],
                    "book_slug": r["book_slug"],
                    "count": 0,
                }
            groups[gid]["count"] += 1
        return {
            "total_rows": len(rows),
            "distinct_hashes_count": len(hashes),
            "existing_hashes": hashes,
            "groups": groups,
        }
    finally:
        await conn.close()


def _select_stratified_pages_for_book(
    book_slug: str,
    grade: str,
    pages: list[tuple[int, Path]],
    quotas: tuple[int, int, int],
) -> list[dict[str, Any]]:
    """Select well-spread content pages across a book with buffer gaps between split blocks."""
    pages = sorted(pages, key=lambda item: item[0])
    q_c1, q_c2, q_tv = quotas
    total_want = q_c1 + q_c2 + q_tv
    n = len(pages)
    if n == 0 or total_want == 0:
        return []

    # Skip known early TOC pages if enough pages remain cleanly.
    if book_slug == "ctst_tieng_viet_4_tap_1":
        pages = [item for item in pages if item[0] >= 13]
    elif book_slug == "kntt_tieng_viet_4_tap_1":
        pages = [item for item in pages if item[0] >= 11]
    else:
        pages = [item for item in pages if item[0] >= 10]
    n = len(pages)

    # For scarce Grade 4 books where almost all untouched pages are used, partition by
    # contiguous blocks separated along page numbers so adjacent pages never cross splits.
    if n <= total_want + 4:
        selected_pages = list(pages)
        m = len(selected_pages)
        # Interleave 3-page lesson blocks across early/mid/late sections cleanly.
        c1_slots = min(q_c1, m)
        c2_slots = min(q_c2, max(0, m - c1_slots))
        tv_slots = max(0, m - c1_slots - c2_slots)
        # Partition into blocks: assign cohort1, cohort2, train+val across distinct page ranges.
        assigned: list[tuple[int, Path, str]] = []
        # Deterministic block pattern across available pages (block size 2-3 where possible)
        idx = 0
        rem_c1, rem_c2, rem_tv = c1_slots, c2_slots, tv_slots
        cycle = [("train_val", 2), ("cohort1", 2), ("cohort2", 1)]
        while idx < m:
            progressed = False
            for kind, blk in cycle:
                take = min(blk, rem_tv if kind == "train_val" else (rem_c1 if kind == "cohort1" else rem_c2))
                for _ in range(take):
                    if idx < m:
                        pnum, ppath = selected_pages[idx]
                        assigned.append((pnum, ppath, kind))
                        idx += 1
                        progressed = True
                        if kind == "train_val":
                            rem_tv -= 1
                        elif kind == "cohort1":
                            rem_c1 -= 1
                        else:
                            rem_c2 -= 1
            if not progressed:
                break
    else:
        # Abundant book (>= 65 untouched pages): place 1 skipped buffer page between every
        # contiguous 2-3 page block of different splits so adjacent lesson pages stay isolated.
        blocks: list[tuple[str, int]] = []
        rem_c1, rem_c2, rem_tv = q_c1, q_c2, q_tv
        # Interleave evenly across the entire book length
        while rem_c1 + rem_c2 + rem_tv > 0:
            if rem_tv > 0:
                take = min(3 if rem_tv >= 6 else rem_tv, rem_tv)
                blocks.append(("train_val", take))
                rem_tv -= take
            if rem_c1 > 0:
                take = min(2 if rem_c1 >= 4 else rem_c1, rem_c1)
                blocks.append(("cohort1", take))
                rem_c1 -= take
            if rem_c2 > 0:
                take = 1
                blocks.append(("cohort2", take))
                rem_c2 -= take

        needed_with_buffers = sum(sz for _, sz in blocks) + max(0, len(blocks) - 1)
        use_buffers = n >= needed_with_buffers
        total_slots = needed_with_buffers if use_buffers else sum(sz for _, sz in blocks)
        # Spread slots evenly across [0, n-1]
        slot_indices = [
            min(n - 1, int(round(i * (n - 1) / max(1, total_slots - 1))))
            for i in range(total_slots)
        ]
        # Ensure strictly increasing indices
        for i in range(1, len(slot_indices)):
            if slot_indices[i] <= slot_indices[i - 1]:
                slot_indices[i] = min(n - 1, slot_indices[i - 1] + 1)

        assigned = []
        cursor = 0
        for b_idx, (kind, sz) in enumerate(blocks):
            for _ in range(sz):
                if cursor < len(slot_indices):
                    pnum, ppath = pages[slot_indices[cursor]]
                    assigned.append((pnum, ppath, kind))
                    cursor += 1
            if use_buffers and b_idx + 1 < len(blocks):
                cursor += 1  # skip buffer page between split blocks

    # Assign train (~82%) vs validation (~18%) across train_val groups in contiguous chunks.
    tv_indices = [i for i, (_, _, k) in enumerate(assigned) if k == "train_val"]
    n_val = max(1, round(len(tv_indices) * 0.18)) if tv_indices else 0
    val_positions: set[int] = set()
    if n_val > 0 and len(tv_indices) >= 2:
        step = len(tv_indices) / float(n_val)
        for v_i in range(n_val):
            pos = min(len(tv_indices) - 1, int(round((v_i + 0.5) * step)))
            val_positions.add(tv_indices[pos])

    records: list[dict[str, Any]] = []
    for idx, (pnum, ppath, kind) in enumerate(assigned):
        if kind == "cohort1":
            split, cohort, elig = "holdout", "cohort1", True
        elif kind == "cohort2":
            split, cohort, elig = "holdout", "cohort2", False
        elif idx in val_positions:
            split, cohort, elig = "validation", "validation", None
        else:
            split, cohort, elig = "train", "train", None
        stem = ppath.stem
        records.append({
            "grade": grade,
            "book_slug": book_slug,
            "page_number": pnum,
            "page_stem": stem,
            "page_filename": ppath.name,
            "image_path": str(ppath),
            "source_group_id": f"rawpages:{book_slug}:{stem}",
            "split": split,
            "cohort": cohort,
            "eligible_for_locked_test": elig,
        })
    return records


def run_stage_select(raw_root: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    print("Querying live Supabase public.viread_ocr_samples for deduplication...", flush=True)
    db_state = asyncio.run(_fetch_db_exclusions())
    (out_dir / "existing_db_state.json").write_text(
        json.dumps(db_state, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    existing_grade4 = _parse_existing_grade4_pages(db_state["groups"])
    print(
        f"DB exclusions loaded: {db_state['total_rows']} rows, "
        f"{db_state['distinct_hashes_count']} distinct hashes, "
        f"{len(existing_grade4)} Grade 4 pages.",
        flush=True,
    )

    books_pages: dict[str, tuple[str, list[tuple[int, Path]]]] = {}
    for grade_dir in sorted(raw_root.iterdir()):
        if not grade_dir.is_dir():
            continue
        for img_path in sorted(grade_dir.iterdir()):
            if not img_path.is_file():
                continue
            m = _PAGE_FILE_RE.match(img_path.name)
            if not m:
                continue
            slug = m.group("slug")
            pnum = int(m.group("page"))
            if slug not in BOOK_META:
                continue
            grade, _ = BOOK_META[slug]
            books_pages.setdefault(slug, (grade, []))[1].append((pnum, img_path))

    selected: list[dict[str, Any]] = []
    existing_groups = set(db_state["groups"].keys())
    for slug, (grade, all_pages) in sorted(books_pages.items()):
        all_pages.sort(key=lambda x: x[0])
        last2 = {all_pages[-1][0], all_pages[-2][0]} if len(all_pages) >= 2 else set()
        untouched = [
            (pnum, path)
            for pnum, path in all_pages
            if pnum > 5 and pnum not in last2 and (slug, pnum) not in existing_grade4
        ]
        chosen = _select_stratified_pages_for_book(
            slug, grade, untouched, BOOK_PAGE_QUOTAS[slug]
        )
        for rec in chosen:
            assert rec["source_group_id"] not in existing_groups, f"Group collision: {rec['source_group_id']}"
        selected.extend(chosen)
        by_c = Counter(r["cohort"] for r in chosen)
        print(
            f"  {grade} | {slug}: untouched={len(untouched)} -> selected={len(chosen)} "
            f"(train={by_c['train']}, val={by_c['validation']}, c1={by_c['cohort1']}, c2={by_c['cohort2']})",
            flush=True,
        )

    plan_path = out_dir / "selected_pages.json"
    plan = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_selected_pages": len(selected),
        "by_cohort": dict(Counter(r["cohort"] for r in selected)),
        "by_grade": dict(Counter(r["grade"] for r in selected)),
        "pages": selected,
    }
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved selection plan ({len(selected)} pages) -> {plan_path}", flush=True)
    return plan_path


def _parse_json_object(raw_text: str) -> dict[str, Any]:
    txt = (raw_text or "").strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*", "", txt)
        txt = re.sub(r"\s*```$", "", txt)
    start = txt.find("{")
    end = txt.rfind("}")
    if start >= 0 and end > start:
        txt = txt[start : end + 1]
    obj = json.loads(txt)
    if not isinstance(obj, dict):
        raise ValueError("Expected JSON object")
    return obj


def _encode_vlm_png_b64(image_bytes: bytes) -> str:
    with Image.open(BytesIO(image_bytes)) as src:
        rgb = src.convert("RGB")
        w, h = rgb.size
        max_side = max(w, h)
        if max_side > 1800:
            scale = 1800.0 / float(max_side)
            rgb = rgb.resize((round(w * scale), round(h * scale)), Image.Resampling.BILINEAR)
        buf = BytesIO()
        rgb.save(buf, format="PNG", compress_level=1)
        return base64.b64encode(buf.getvalue()).decode("ascii")


class CloudVlmCaller:
    """Async Cloud VLM caller with Gemini primary/fallback -> Groq fallback & backoff."""

    def __init__(self, *, timeout_seconds: float = 45.0) -> None:
        self.gemini_key = (os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or "").strip()
        self.groq_key = (os.getenv("GROQ_API_KEY") or "").strip()
        self.timeout_seconds = timeout_seconds
        self.chain: list[tuple[str, str]] = []
        if self.gemini_key:
            self.chain.append(("gemini", "gemini-3.1-flash-lite"))
            self.chain.append(("gemini", "gemini-3.5-flash-lite"))
        if self.groq_key:
            self.chain.append(("groq", os.getenv("GROQ_OCR_MODEL", "qwen/qwen3.8-27b")))
        if not self.chain:
            raise RuntimeError("No GEMINI_API_KEY/GOOGLE_API_KEY or GROQ_API_KEY found in environment")
        self._rr = 0
        self._cooldown_until: dict[tuple[str, str], float] = {}

    async def _call_once(
        self,
        client: httpx.AsyncClient,
        provider: str,
        model: str,
        prompt: str,
        image_b64: str,
    ) -> dict[str, Any]:
        if provider == "gemini":
            url = _GEMINI_ENDPOINT.format(model=model)
            payload = {
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"text": prompt},
                            {"inline_data": {"mime_type": "image/png", "data": image_b64}},
                        ],
                    }
                ],
                "generationConfig": {
                    "temperature": 0,
                    "responseMimeType": "application/json",
                },
            }
            resp = await client.post(
                url,
                headers={"x-goog-api-key": self.gemini_key},
                json=payload,
                timeout=httpx.Timeout(self.timeout_seconds),
            )
            if resp.status_code != 200:
                raise httpx.HTTPStatusError(
                    f"Gemini {model} HTTP {resp.status_code}", request=resp.request, response=resp
                )
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return _parse_json_object(text)

        payload = {
            "model": model,
            "temperature": 0,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                        },
                    ],
                }
            ],
            "response_format": {"type": "json_object"},
        }
        resp = await client.post(
            _GROQ_ENDPOINT,
            headers={"Authorization": f"Bearer {self.groq_key}"},
            json=payload,
            timeout=httpx.Timeout(self.timeout_seconds),
        )
        if resp.status_code != 200:
            raise httpx.HTTPStatusError(
                f"Groq {model} HTTP {resp.status_code}", request=resp.request, response=resp
            )
        data = resp.json()
        text = data["choices"][0]["message"]["content"]
        return _parse_json_object(text)

    async def infer_json(
        self,
        client: httpx.AsyncClient,
        prompt: str,
        image_bytes: bytes,
        *,
        max_rounds: int = 10,
    ) -> tuple[str, dict[str, Any]]:
        b64 = await asyncio.to_thread(_encode_vlm_png_b64, image_bytes)

        last_err: Exception | None = None
        for round_idx in range(max_rounds):
            start_idx = self._rr % len(self.chain)
            self._rr += 1
            ordered = self.chain[start_idx:] + self.chain[:start_idx]
            tried_any = False
            for key in ordered:
                now = time.monotonic()
                if self._cooldown_until.get(key, 0.0) > now:
                    continue
                tried_any = True
                provider, model = key
                try:
                    parsed = await self._call_once(client, provider, model, prompt, b64)
                    return f"{provider}:{model}", parsed
                except httpx.HTTPStatusError as exc:
                    last_err = exc
                    code = exc.response.status_code if exc.response is not None else 0
                    if code == 429 or code >= 500:
                        ra = exc.response.headers.get("retry-after") if exc.response else None
                        wait_s = float(ra) if ra and ra.replace(".", "", 1).isdigit() else min(25.0, 2.0 * (2 ** min(round_idx, 4)))
                        self._cooldown_until[key] = time.monotonic() + min(wait_s, 25.0)
                    elif code in (400, 404):
                        self._cooldown_until[key] = time.monotonic() + 60.0
                except (httpx.RequestError, KeyError, IndexError, TypeError, ValueError) as exc:
                    last_err = exc
            if not tried_any:
                now = time.monotonic()
                soonest = min(self._cooldown_until.get(k, now) for k in self.chain)
                sleep_s = max(0.5, min(25.0, soonest - now + 0.5))
            else:
                sleep_s = min(25.0, 1.5 * (2 ** min(round_idx, 4)) + random.uniform(0.1, 0.8))
            await asyncio.sleep(sleep_s)
        raise RuntimeError(f"VLM failed after {max_rounds} rounds: {type(last_err).__name__}: {last_err}")


async def _run_stage_vlm_async(out_dir: Path, concurrency: int) -> None:
    plan = json.loads((out_dir / "selected_pages.json").read_text(encoding="utf-8"))
    pages: list[dict[str, Any]] = plan["pages"]
    cache_dir = out_dir / "vlm_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    pending = []
    for rec in pages:
        cpath = cache_dir / f"{rec['page_stem']}.json"
        if not cpath.is_file():
            pending.append((rec, cpath))
    print(f"VLM stage: {len(pages)} total pages, {len(pages) - len(pending)} cached, {len(pending)} pending.", flush=True)
    if not pending:
        return

    caller = CloudVlmCaller()
    sem = asyncio.Semaphore(max(1, min(concurrency, 10)))
    completed = 0
    failed = 0
    lock = asyncio.Lock()

    async with httpx.AsyncClient(trust_env=False) as client:
        async def _worker(rec: dict[str, Any], cpath: Path) -> None:
            nonlocal completed, failed
            async with sem:
                try:
                    raw_bytes = Path(rec["image_path"]).read_bytes()
                    model_id, parsed = await caller.infer_json(client, PAGE_VLM_PROMPT, raw_bytes)
                    lines_raw = parsed.get("lines") if isinstance(parsed.get("lines"), list) else []
                    cleaned_lines = [
                        normalize_typographic_for_vietocr(str(x))
                        for x in lines_raw
                        if isinstance(x, str) and str(x).strip()
                    ]
                    payload = {
                        "page_stem": rec["page_stem"],
                        "book_slug": rec["book_slug"],
                        "grade": rec["grade"],
                        "model": model_id,
                        "page_kind": str(parsed.get("page_kind") or "content").strip().lower(),
                        "lines": cleaned_lines,
                        "cached_at": datetime.now(timezone.utc).isoformat(),
                    }
                    tmp = cpath.with_suffix(".tmp")
                    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
                    tmp.replace(cpath)
                except Exception as exc:
                    async with lock:
                        failed += 1
                    print(f"  VLM failed for {rec['page_stem']}: {type(exc).__name__}: {exc}", flush=True)
                    return
                async with lock:
                    completed += 1
                    if completed % 20 == 0 or completed == len(pending):
                        print(f"  VLM progress: {completed}/{len(pending)} done (failed={failed})", flush=True)

        await asyncio.gather(*(_worker(rec, cpath) for rec, cpath in pending))
    print(f"VLM stage finished: {completed} newly cached, {failed} failed.", flush=True)


def _is_cyan_grid_crop(crop_bgr: np.ndarray, label: str | None = None) -> bool:
    """Detect lop_1/lop_2 cursive penmanship crops sitting on cyan/blue or square ruled grids."""
    if crop_bgr is None or crop_bgr.size == 0 or crop_bgr.ndim < 3:
        return False
    h, w = crop_bgr.shape[:2]
    if h < 12 or w < 12:
        return False
    b = crop_bgr[:, :, 0].astype(np.int16)
    g = crop_bgr[:, :, 1].astype(np.int16)
    r = crop_bgr[:, :, 2].astype(np.int16)
    # Cyan/blue ruled penmanship grids: brighter blue/cyan channel than red channel.
    cyan_mask = (b >= 135) & (g >= 115) & ((b - r) >= 14)
    cyan_ratio = float(cyan_mask.mean())
    row_cyan = cyan_mask.mean(axis=1)
    col_cyan = cyan_mask.mean(axis=0)
    # Thin periodic horizontal & vertical grid lines (distinguishes ô li grid from solid pastel card)
    h_grid_rows = int((row_cyan >= 0.38).sum())
    v_grid_cols = int((col_cyan >= 0.35).sum())
    is_solid_bg = float((row_cyan >= 0.85).mean()) > 0.70 or float((col_cyan >= 0.85).mean()) > 0.70
    if not is_solid_bg and h_grid_rows >= 3 and v_grid_cols >= 6 and cyan_ratio >= 0.08:
        return True
    if not is_solid_bg and cyan_ratio >= 0.18 and v_grid_cols >= 10:
        return True
    # Also check grey square penmanship grids (e.g. lop_2 Viết chữ hoa) with tight single-char text
    if label is not None:
        clean = label.strip()
        alnum = [ch for ch in clean if ch.isalnum()]
        if len(alnum) <= 2:
            return True
    return False


def _find_penmanship_zones(ordered_items: list[dict[str, Any]], page_h: int) -> list[tuple[float, float]]:
    """Identify vertical [y_start, y_end] bands belonging to 'Tô và viết' / 'Luyện viết'."""
    headers: list[tuple[float, str]] = []
    for it in ordered_items:
        norm = _strip_accents_lower(it.get("paddle_text", ""))
        if not norm:
            continue
        yc = float(it["yc"])
        if _PENMANSHIP_HEADER_RE.search(norm):
            headers.append((yc, "penmanship"))
        elif _SECTION_BOUNDARY_RE.search(norm):
            headers.append((yc, "other"))
    headers.sort(key=lambda x: x[0])

    zones: list[tuple[float, float]] = []
    for idx, (yc, kind) in enumerate(headers):
        if kind != "penmanship":
            continue
        y_start = max(0.0, yc - 0.015 * page_h)
        y_end = float(page_h)
        for next_yc, next_kind in headers[idx + 1 :]:
            if next_kind == "other" and next_yc > yc + 0.02 * page_h:
                y_end = next_yc - 0.01 * page_h
                break
        zones.append((y_start, y_end))
    return zones


def _is_in_zones(yc: float, zones: list[tuple[float, float]]) -> bool:
    return any(y0 <= yc <= y1 for y0, y1 in zones)


def _is_visual_trap_text(norm_text: str, *, grade: str, book_slug: str, yc: float, page_h: int) -> str | None:
    stripped = _strip_accents_lower(norm_text)
    if _BAN_IN_THU_RE.search(stripped):
        return "BAN_IN_THU_FOOTER"
    if book_slug == "cd_tieng_viet_5_tap_1" and yc > 0.92 * page_h:
        return "LOP5_BOTTOM_FOOTER"
    clean = " ".join(unicodedata.normalize("NFC", norm_text).split())
    if len(clean) < 2:
        return "SHORT_LT_2_CHARS"
    if _STANDALONE_PAGE_NUM_RE.fullmatch(clean):
        return "STANDALONE_PAGE_NUMBER"
    if _ITEM_BADGE_RE.fullmatch(clean):
        return "ISOLATED_ITEM_BADGE"
    if stripped in _WATERMARK_STRINGS:
        return "PUBLISHER_WATERMARK"
    if _PENMANSHIP_HEADER_RE.search(stripped) and len(clean) <= 32:
        return "PENMANSHIP_HEADER"
    if grade in {"lop_1", "lop_2"}:
        alnum = [ch.casefold() for ch in clean if ch.isalnum()]
        if len(alnum) < 2:
            return "LOW_ALNUM_CELL"
        tokens = clean.split()
        # Repeated 1-2 char penmanship cells like "m m n n", "11 22 33 44"
        if len(tokens) >= 2 and all(len(t) <= 2 for t in tokens) and len(set(alnum)) <= 3:
            return "REPEATED_CHAR_CELL"
        if grade == "lop_1" and yc > 0.90 * page_h and len(clean) <= 5:
            return "BOTTOM_PAGE_NUM_OR_NOISE"
    return None


def _load_active_vietocr_200edce4(torch_mod: Any, *, force_cpu: bool = False):
    """Load VietOCR FLOW1_EXTERNAL_TRDG (200edce4) from verified local cache or artifact router."""
    from PIL import Image as _PilImage
    from vietocr.tool.config import Cfg
    from vietocr.tool.predictor import Predictor
    from app.services.ocr_engine import (
        _deep_merge_dict,
        _install_safe_vietocr_downloaders,
        _sha256_path,
        _v2_artifact_from_storage,
    )

    if not hasattr(_PilImage, "ANTIALIAS"):
        _PilImage.ANTIALIAS = _PilImage.Resampling.LANCZOS

    _install_safe_vietocr_downloaders()
    temp_dir = Path(tempfile.gettempdir())
    candidates = [
        (
            temp_dir / "viread-models" / f"viread-vietocr-v2-{ACTIVE_VIETOCR_SHA256}.pth",
            temp_dir / "viread-models" / f"viread-vietocr-v2-{ACTIVE_VIETOCR_SHA256}.yml",
        ),
        (
            temp_dir / f"viread-vietocr-v2-{ACTIVE_VIETOCR_SHA256}.pth",
            temp_dir / f"viread-vietocr-v2-{ACTIVE_VIETOCR_SHA256}.yml",
        ),
    ]
    weights_path: Path | None = None
    custom_cfg: dict[str, Any] | None = None
    for pth, yml in candidates:
        if pth.is_file() and _sha256_path(str(pth)) == ACTIVE_VIETOCR_SHA256:
            weights_path = pth
            if yml.is_file():
                custom_cfg = yaml.safe_load(yml.read_text(encoding="utf-8"))
            break

    if weights_path is None:
        from app.services.ocr_engine import refresh_active_viread_model

        active = refresh_active_viread_model()
        if not active or str(active.get("checkpoint_sha256", "")).lower() != ACTIVE_VIETOCR_SHA256:
            active = {
                "profile": ACTIVE_VIETOCR_PROFILE,
                "checkpoint_sha256": ACTIVE_VIETOCR_SHA256,
                "storage_path": "ocr-training/checkpoints/flow1-manual/abc12169-0faf-43ef-af51-fc29e3a045d1/checkpoint.manifest.json",
            }
        local_pth, custom_cfg, _ = _v2_artifact_from_storage(active)
        weights_path = Path(local_pth)

    cfg = Cfg.load_config_from_name("vgg_transformer")
    if isinstance(custom_cfg, dict):
        _deep_merge_dict(cfg, custom_cfg)
    device = "cpu" if force_cpu else ("cuda" if torch_mod.cuda.is_available() else "cpu")
    if device.startswith("cuda"):
        torch_mod.set_num_threads(1)
        try:
            torch_mod.backends.cudnn.benchmark = False
            if hasattr(torch_mod.backends, "cuda"):
                if hasattr(torch_mod.backends.cuda, "enable_flash_sdp"):
                    torch_mod.backends.cuda.enable_flash_sdp(False)
                if hasattr(torch_mod.backends.cuda, "enable_mem_efficient_sdp"):
                    torch_mod.backends.cuda.enable_mem_efficient_sdp(False)
        except Exception:
            pass
    else:
        torch_mod.set_num_threads(max(4, min(6, os.cpu_count() or 4)))
    cfg["device"] = device
    if isinstance(cfg.get("cnn"), dict):
        cfg["cnn"]["pretrained"] = False
    cfg["weights"] = str(weights_path)
    try:
        predictor = Predictor(cfg)
    except Exception as exc:
        if device.startswith("cuda"):
            print(
                f"  WARNING: CUDA VietOCR init failed ({type(exc).__name__}: {exc}); falling back cleanly to CPU...",
                flush=True,
            )
            gc.collect()
            try:
                torch_mod.cuda.empty_cache()
            except Exception:
                pass
            device = "cpu"
            torch_mod.set_num_threads(max(4, min(6, os.cpu_count() or 4)))
            cfg["device"] = device
            predictor = Predictor(cfg)
        else:
            raise
    return predictor, device


def _predict_vietocr_page(
    predictor: Any,
    prepped_imgs: list[Image.Image],
    torch_mod: Any,
    device: str,
    chunk_size: int = 6,
) -> list[str | None]:
    """Run VietOCR inference in bounded chunks; propagate CUDA faults instead of poisoning cache."""

    def _is_cuda_fault(exc: BaseException) -> bool:
        msg = f"{type(exc).__name__}: {exc}".lower()
        return "cuda" in msg or "acceleratorerror" in msg or "illegal memory" in msg

    preds: list[str | None] = []
    with torch_mod.inference_mode():
        for cs in range(0, len(prepped_imgs), chunk_size):
            chunk = prepped_imgs[cs : cs + chunk_size]
            try:
                out_batch = predictor.predict_batch(chunk)
                if not isinstance(out_batch, (list, tuple)) or len(out_batch) != len(chunk):
                    raise RuntimeError("predict_batch returned mismatched length")
                preds.extend(out_batch)
            except Exception as batch_exc:
                if device.startswith("cuda") and _is_cuda_fault(batch_exc):
                    raise
                for single in chunk:
                    try:
                        preds.append(predictor.predict(single))
                    except Exception as single_exc:
                        if device.startswith("cuda") and _is_cuda_fault(single_exc):
                            raise
                        preds.append(None)
        if device.startswith("cuda"):
            torch_mod.cuda.synchronize()
    return preds


def run_stage_ocr(out_dir: Path, *, max_pages: int = 0) -> None:
    import torch

    torch.set_num_threads(1)
    from paddleocr import PaddleOCR
    from app.services.ocr_engine import (
        _sanitize_vietocr_prediction,
        sort_reading_order_adaptive,
    )
    from app.services.viread_vietocr_v2_preprocessing import preprocess_line_array

    plan = json.loads((out_dir / "selected_pages.json").read_text(encoding="utf-8"))
    pages: list[dict[str, Any]] = plan["pages"]
    vlm_cache_dir = out_dir / "vlm_cache"
    ocr_cache_dir = out_dir / "ocr_cache"
    cand_crops_dir = out_dir / "candidate_crops"
    ocr_cache_dir.mkdir(parents=True, exist_ok=True)
    cand_crops_dir.mkdir(parents=True, exist_ok=True)

    # Filter out missing VLM pages, TOC/cover pages flagged by VLM, and already-cached OCR pages.
    todo: list[dict[str, Any]] = []
    skipped_toc = 0
    for rec in pages:
        ocr_file = ocr_cache_dir / f"{rec['page_stem']}.json"
        if ocr_file.is_file():
            continue
        vlm_file = vlm_cache_dir / f"{rec['page_stem']}.json"
        if not vlm_file.is_file():
            skipped_toc += 1
            continue
        vlm_data = json.loads(vlm_file.read_text(encoding="utf-8"))
        if vlm_data.get("page_kind") in {"toc", "cover", "penmanship_only"} or not vlm_data.get("lines"):
            skipped_toc += 1
            ocr_file.write_text(
                json.dumps({"page_stem": rec["page_stem"], "skipped_vlm_kind": vlm_data.get("page_kind"), "items": []}, ensure_ascii=False),
                encoding="utf-8",
            )
            continue
        todo.append(rec)

    # Interleave pending pages round-robin across books so every batch covers all books/grades.
    by_book: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for rec in todo:
        by_book[rec["book_slug"]].append(rec)
    interleaved: list[dict[str, Any]] = []
    book_keys = sorted(by_book.keys())
    max_len = max((len(by_book[b]) for b in book_keys), default=0)
    for pos in range(max_len):
        for b in book_keys:
            if pos < len(by_book[b]):
                interleaved.append(by_book[b][pos])
    todo = interleaved

    total_pending = len(todo)
    if max_pages > 0 and len(todo) > max_pages:
        todo = todo[:max_pages]

    print(
        f"OCR stage: {len(pages)} total pages, {skipped_toc} skipped as TOC/cover/empty, {total_pending} pending (batch={len(todo)}).",
        flush=True,
    )
    if not todo:
        return

    t_init = time.perf_counter()
    paddle = PaddleOCR(
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
    viet, device = _load_active_vietocr_200edce4(torch)
    print(f"Initialized PaddleOCR + VietOCR 200edce4 ({device}) in {time.perf_counter()-t_init:.2f}s", flush=True)

    cv2.setNumThreads(1)
    prep_pool = ThreadPoolExecutor(max_workers=4)
    try:
        for idx, rec in enumerate(todo, 1):
            t0 = time.perf_counter()
            img_bytes = Path(rec["image_path"]).read_bytes()
            arr = np.frombuffer(img_bytes, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                continue
            page_h, page_w = img.shape[:2]
            scale = 1.0
            max_dim = max(page_w, page_h)
            if max_dim < 1500:
                scale = min(2.5, 1500.0 / max_dim)
                proc = cv2.resize(img, (int(round(page_w * scale)), int(round(page_h * scale))), interpolation=cv2.INTER_CUBIC)
            else:
                proc = img

            ocr_res = paddle.ocr(proc, cls=False)
            raw_items = ocr_res[0] if (ocr_res and ocr_res[0] is not None) else []
            if scale > 1.01:
                for item in raw_items:
                    item[0] = np.array(item[0], dtype=np.float32) / scale

            ordered, _ = sort_reading_order_adaptive(raw_items, img_width=page_w, image=img)
            penmanship_zones = _find_penmanship_zones(ordered, page_h)
            t_pad = time.perf_counter() - t0

            candidates: list[dict[str, Any]] = []
            dropped_traps: Counter[str] = Counter()
            scaled_arrays: list[np.ndarray] = []

            for line_i, item in enumerate(ordered):
                dewarped = item["dewarped_img"]
                hc, wc = dewarped.shape[:2]
                if hc < 8 or wc < 8:
                    dropped_traps["TOO_TINY_RAW"] += 1
                    continue
                yc = float(item["yc"])
                p_text = normalize_typographic_for_vietocr(str(item.get("paddle_text") or ""))

                if _is_in_zones(yc, penmanship_zones):
                    dropped_traps["TO_VA_VIET_ZONE"] += 1
                    continue
                if rec["book_slug"] == "cd_tieng_viet_5_tap_1" and yc > 0.92 * page_h:
                    dropped_traps["LOP5_BOTTOM_FOOTER"] += 1
                    continue
                if _BAN_IN_THU_RE.search(_strip_accents_lower(p_text)):
                    dropped_traps["BAN_IN_THU_TEXT"] += 1
                    continue
                if (yc < 0.08 * page_h or yc > 0.90 * page_h) and _STANDALONE_PAGE_NUM_RE.fullmatch(p_text):
                    dropped_traps["PAGE_NUMBER_MARGIN"] += 1
                    continue

                if hc < 52:
                    target_h = 56
                    target_w = int(round(wc * (target_h / hc)))
                    scaled = cv2.resize(dewarped, (target_w, target_h), interpolation=cv2.INTER_CUBIC)
                else:
                    scaled = dewarped

                if rec["grade"] in {"lop_1", "lop_2"} and _is_cyan_grid_crop(scaled):
                    dropped_traps["CYAN_GRID_PIXEL_TRAP"] += 1
                    continue

                png_bytes, pil_rgb = _canonical_png_bytes(scaled, is_bgr=True)
                ok_img, _metrics, reason_img = validate_flow2_line_crop(pil_rgb, page_height=page_h)
                if not ok_img:
                    dropped_traps[reason_img or "CROP_QUALITY"] += 1
                    continue

                crop_sha = hashlib.sha256(png_bytes).hexdigest()
                crop_name = f"{rec['page_stem']}__{line_i:03d}.png"
                (cand_crops_dir / crop_name).write_bytes(png_bytes)

                scaled_arrays.append(scaled)
                candidates.append({
                    "line_index": line_i,
                    "crop_file": crop_name,
                    "crop_sha256": crop_sha,
                    "width": pil_rgb.size[0],
                    "height": pil_rgb.size[1],
                    "yc": round(yc, 2),
                    "xc": round(float(item["xc"]), 2),
                    "x0": round(float(item["x0"]), 2),
                    "quad": [[round(float(pt[0]), 1), round(float(pt[1]), 1)] for pt in item["quad"]],
                    "paddle_text": p_text,
                    "paddle_conf": (
                        round(float(item["paddle_conf"]), 4)
                        if isinstance(item.get("paddle_conf"), (int, float)) and np.isfinite(item["paddle_conf"])
                        else None
                    ),
                })

            t1 = time.perf_counter()
            if scaled_arrays:
                def _prep_for_vietocr(bgr: np.ndarray) -> Image.Image:
                    h_in, w_in = bgr.shape[:2]
                    if h_in > 64:
                        new_w = max(8, int(round(w_in * (64.0 / h_in))))
                        bgr_infer = cv2.resize(bgr, (new_w, 64), interpolation=cv2.INTER_AREA)
                    else:
                        bgr_infer = bgr
                    return Image.fromarray(cv2.cvtColor(preprocess_line_array(bgr_infer), cv2.COLOR_BGR2RGB))

                prepped_imgs = list(prep_pool.map(_prep_for_vietocr, scaled_arrays))
                try:
                    viet_preds = _predict_vietocr_page(viet, prepped_imgs, torch, device, chunk_size=6)
                except Exception as exc:
                    if device.startswith("cuda"):
                        print(
                            f"  WARNING: CUDA VietOCR error on {rec['page_stem']} ({type(exc).__name__}: {exc}); "
                            "reloading VietOCR cleanly on CPU...",
                            flush=True,
                        )
                        try:
                            del viet
                        except Exception:
                            pass
                        gc.collect()
                        viet, device = _load_active_vietocr_200edce4(torch, force_cpu=True)
                        viet_preds = _predict_vietocr_page(viet, prepped_imgs, torch, device, chunk_size=8)
                    else:
                        raise
                for cand, raw_v in zip(candidates, viet_preds):
                    sanitized, had_ctrl = _sanitize_vietocr_prediction(raw_v)
                    cand["vietocr_raw"] = raw_v
                    cand["vietocr_text"] = None if had_ctrl else normalize_typographic_for_vietocr(sanitized or "")
                raw_nones = sum(1 for cand in candidates if cand.get("vietocr_raw") is None)
                if len(candidates) >= 3 and raw_nones >= len(candidates) // 2 + 1:
                    raise RuntimeError(
                        f"Refusing to cache corrupt OCR result for {rec['page_stem']}: {raw_nones}/{len(candidates)} raw_none"
                    )
            t_viet = time.perf_counter() - t1

            ocr_out = {
                "page_stem": rec["page_stem"],
                "book_slug": rec["book_slug"],
                "grade": rec["grade"],
                "page_width": page_w,
                "page_height": page_h,
                "dropped_traps": dict(dropped_traps),
                "items": candidates,
            }
            tmp_ocr = ocr_cache_dir / f"{rec['page_stem']}.tmp"
            tmp_ocr.write_text(json.dumps(ocr_out, ensure_ascii=False), encoding="utf-8")
            tmp_ocr.replace(ocr_cache_dir / f"{rec['page_stem']}.json")

            if idx % 5 == 0 and device.startswith("cuda"):
                torch.cuda.empty_cache()
            if idx % 10 == 0:
                gc.collect()

            print(
                f"  OCR [{idx}/{len(todo)}] {rec['page_stem']} ({device}): kept={len(candidates)} "
                f"traps={sum(dropped_traps.values())} paddle={t_pad:.2f}s viet={t_viet:.2f}s",
                flush=True,
            )
    finally:
        prep_pool.shutdown(wait=True)


def _build_crop_sheet(crop_paths: list[Path]) -> bytes:
    """Stack up to 8 line crops vertically with bold [0]..[N-1] index tags for Cloud VLM verification."""
    imgs: list[Image.Image] = []
    max_w = 600
    for p in crop_paths:
        im = Image.open(p).convert("RGB")
        if im.width > 1400:
            ratio = 1400.0 / im.width
            im = im.resize((1400, max(20, round(im.height * ratio))), Image.Resampling.LANCZOS)
        max_w = max(max_w, im.width)
        imgs.append(im)

    gutter = 90
    pad_y = 14
    total_h = sum(im.height + pad_y * 2 for im in imgs) + 12
    canvas = Image.new("RGB", (gutter + max_w + 24, total_h), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default()
    y = 6
    for idx, im in enumerate(imgs):
        draw.rectangle([4, y + 4, gutter - 12, y + im.height + pad_y], fill=(240, 245, 255), outline=(90, 120, 200))
        draw.text((16, y + max(6, im.height // 2 - 4)), f"[{idx}]", fill=(10, 20, 120), font=font)
        canvas.paste(im, (gutter, y + pad_y // 2))
        y += im.height + pad_y * 2
        draw.line([(0, y - 2), (canvas.width, y - 2)], fill=(180, 180, 180), width=2)
    buf = BytesIO()
    canvas.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


async def _verify_disagreed_crops_with_vlm(
    disagreed: list[dict[str, Any]],
    out_dir: Path,
    concurrency: int = 4,
) -> dict[str, dict[str, Any]]:
    cache_path = out_dir / "vlm_crop_verify_cache.json"
    cache: dict[str, dict[str, Any]] = {}
    if cache_path.is_file():
        cache = json.loads(cache_path.read_text(encoding="utf-8"))

    pending = [d for d in disagreed if d["crop_key"] not in cache]
    print(f"Crop-only VLM verify: {len(disagreed)} total disagreed, {len(cache)} cached, {len(pending)} pending.", flush=True)
    if not pending:
        return cache

    caller = CloudVlmCaller()
    batches = [pending[i : i + 8] for i in range(0, len(pending), 8)]
    sem = asyncio.Semaphore(max(1, min(concurrency, 6)))
    lock = asyncio.Lock()
    done_batches = 0

    async with httpx.AsyncClient(trust_env=False) as client:
        async def _run_batch(batch: list[dict[str, Any]]) -> None:
            nonlocal done_batches
            async with sem:
                sheet_bytes = await asyncio.to_thread(_build_crop_sheet, [Path(item["crop_path"]) for item in batch])
                prompt = CROP_VLM_PROMPT.format(count=len(batch), max_idx=len(batch) - 1)
                try:
                    model_id, parsed = await caller.infer_json(client, prompt, sheet_bytes)
                    items = parsed.get("items") if isinstance(parsed.get("items"), list) else []
                    by_idx = {
                        int(it["index"]): it
                        for it in items
                        if isinstance(it, dict) and isinstance(it.get("index"), int)
                    }
                    async with lock:
                        for idx, d in enumerate(batch):
                            res = by_idx.get(idx, {})
                            cache[d["crop_key"]] = {
                                "model": model_id,
                                "text": normalize_typographic_for_vietocr(str(res.get("text") or "")),
                                "certain": bool(res.get("certain", False)),
                                "bad_crop": bool(res.get("bad_crop", True)) if idx not in by_idx else bool(res.get("bad_crop", False)),
                            }
                except Exception as exc:
                    print(f"  Crop-verify batch failed: {type(exc).__name__}: {exc}", flush=True)
                async with lock:
                    done_batches += 1
                    if done_batches % 15 == 0 or done_batches == len(batches):
                        cache_path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
                        print(f"  Crop-verify batches: {done_batches}/{len(batches)}", flush=True)

        await asyncio.gather(*(_run_batch(b) for b in batches))
    cache_path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return cache


def _align_page_crops_to_vlm(
    page_rec: dict[str, Any],
    ocr_items: list[dict[str, Any]],
    vlm_lines: list[str],
    page_h: int,
) -> list[dict[str, Any]]:
    if not ocr_items or not vlm_lines:
        return []
    n_c = len(ocr_items)
    n_v = len(vlm_lines)
    cost = np.full((n_c, n_v), 1e6, dtype=np.float64)

    for i, item in enumerate(ocr_items):
        viet = str(item.get("vietocr_text") or "")
        pad = str(item.get("paddle_text") or "")
        hyp = viet if viet else pad
        if not hyp:
            continue
        hyp_base = _strip_accents_lower(hyp)
        for j, vline in enumerate(vlm_lines):
            v_base = _strip_accents_lower(vline)
            if not v_base:
                continue
            len_ratio = len(hyp) / float(max(1, len(vline)))
            if len_ratio < 0.45 or len_ratio > 1.85:
                continue
            base_cer = _cer(v_base, hyp_base)
            char_cer = _cer(vline, hyp)
            if pad:
                pad_base_cer = _cer(v_base, _strip_accents_lower(pad))
                base_cer = min(base_cer, 0.9 * pad_base_cer + 0.1)
            if base_cer > 0.50:
                continue
            order_pen = 0.02 * abs((i / max(1, n_c)) - (j / max(1, n_v)))
            cost[i, j] = 0.65 * base_cer + 0.35 * char_cer + order_pen

    row_ind, col_ind = linear_sum_assignment(cost)
    matched: list[dict[str, Any]] = []
    for i, j in zip(row_ind, col_ind):
        if cost[i, j] >= 100.0:
            continue
        item = ocr_items[i]
        vlm_line = vlm_lines[j]
        viet_line = str(item.get("vietocr_text") or "")
        pad_line = str(item.get("paddle_text") or "")
        trap = _is_visual_trap_text(
            vlm_line,
            grade=page_rec["grade"],
            book_slug=page_rec["book_slug"],
            yc=float(item["yc"]),
            page_h=page_h,
        )
        if trap:
            continue
        matched.append({
            "page_rec": page_rec,
            "item": item,
            "vlm_line": vlm_line,
            "viet_line": viet_line,
            "pad_line": pad_line,
            "page_h": page_h,
            "align_cost": float(cost[i, j]),
        })
    return matched


def _select_evenly_spaced(items: list[dict[str, Any]], cap: int) -> list[dict[str, Any]]:
    if len(items) <= cap:
        return items
    ordered = sorted(items, key=lambda x: int(x["line_index"]))
    indices = [round(i * (len(ordered) - 1) / float(max(1, cap - 1))) for i in range(cap)]
    seen: set[int] = set()
    picked: list[dict[str, Any]] = []
    for idx in indices:
        while idx in seen and idx + 1 < len(ordered):
            idx += 1
        if idx not in seen:
            seen.add(idx)
            picked.append(ordered[idx])
    return picked


def _stride_order_groups(groups: list[tuple[str, list[dict[str, Any]]]]) -> list[tuple[str, list[dict[str, Any]]]]:
    """Order groups cleanly by alternating strides across early/mid/late pages."""
    if len(groups) <= 2:
        return groups
    ordered = sorted(groups, key=lambda kv: (kv[1][0]["book_slug"], kv[1][0]["page_number"], kv[0]))
    # Interleave indices with golden-ratio-like step or 3-pass stride so prefixes stay spread across the book
    used: set[int] = set()
    result: list[tuple[str, list[dict[str, Any]]]] = []
    n = len(ordered)
    step = max(2, n // 8)
    for offset in range(step):
        for i in range(offset, n, step):
            if i not in used:
                used.add(i)
                result.append(ordered[i])
    return result


def run_stage_align_and_pack(out_dir: Path, *, max_crop_verify: int = 3500) -> Path:
    db_state = json.loads((out_dir / "existing_db_state.json").read_text(encoding="utf-8"))
    existing_hashes = {h.lower() for h in db_state["existing_hashes"]}
    existing_groups = set(db_state["groups"].keys())
    plan = json.loads((out_dir / "selected_pages.json").read_text(encoding="utf-8"))

    vlm_cache_dir = out_dir / "vlm_cache"
    ocr_cache_dir = out_dir / "ocr_cache"
    cand_crops_dir = out_dir / "candidate_crops"

    exact_or_punct: list[dict[str, Any]] = []
    disagreed: list[dict[str, Any]] = []

    for rec in plan["pages"]:
        vlm_file = vlm_cache_dir / f"{rec['page_stem']}.json"
        ocr_file = ocr_cache_dir / f"{rec['page_stem']}.json"
        if not vlm_file.is_file() or not ocr_file.is_file():
            continue
        vlm_data = json.loads(vlm_file.read_text(encoding="utf-8"))
        ocr_data = json.loads(ocr_file.read_text(encoding="utf-8"))
        if ocr_data.get("skipped_vlm_kind") or not vlm_data.get("lines") or not ocr_data.get("items"):
            continue
        page_h = int(ocr_data["page_height"])
        matches = _align_page_crops_to_vlm(rec, ocr_data["items"], vlm_data["lines"], page_h)
        for m in matches:
            vlm_clean, _ = sanitize_and_validate_vietocr_label(m["vlm_line"], max_length=DEFAULT_MAX_LABEL_LENGTH)
            viet_clean, _ = sanitize_and_validate_vietocr_label(m["viet_line"], max_length=DEFAULT_MAX_LABEL_LENGTH)
            crop_path = cand_crops_dir / m["item"]["crop_file"]
            if not crop_path.is_file():
                continue
            m["vlm_clean"] = vlm_clean
            m["viet_clean"] = viet_clean
            m["crop_path"] = str(crop_path)
            m["crop_key"] = f"{rec['page_stem']}:{m['item']['line_index']}"

            if vlm_clean and viet_clean and vlm_clean == viet_clean:
                m["final_label"] = vlm_clean
                m["verification_tier"] = "dual_exact"
                m["crop_vlm_text"] = None
                exact_or_punct.append(m)
            elif (
                rec["split"] != "holdout"
                and vlm_clean
                and viet_clean
                and _alnum_diacritics_key(vlm_clean) == _alnum_diacritics_key(viet_clean)
                and abs(len(vlm_clean) - len(viet_clean)) <= 2
                and _alnum_diacritics_key(vlm_clean)
            ):
                # Punctuation-only difference on train/validation; verify holdouts strictly via crop VLM.
                m["final_label"] = vlm_clean
                m["verification_tier"] = "dual_punct_consensus"
                m["crop_vlm_text"] = None
                exact_or_punct.append(m)
            else:
                disagreed.append(m)

    # Prioritize holdouts & grade balance when bounding crop-only VLM verification calls
    disagreed.sort(
        key=lambda d: (
            0 if d["page_rec"]["cohort"] == "cohort1" else (1 if d["page_rec"]["cohort"] == "cohort2" else 2),
            d["align_cost"],
        )
    )
    if len(disagreed) > max_crop_verify:
        disagreed = disagreed[:max_crop_verify]

    crop_verify_cache = asyncio.run(_verify_disagreed_crops_with_vlm(disagreed, out_dir))
    verified_disagreed: list[dict[str, Any]] = []
    for m in disagreed:
        cv = crop_verify_cache.get(m["crop_key"])
        if not cv or not cv.get("certain") or cv.get("bad_crop"):
            continue
        crop_txt, _ = sanitize_and_validate_vietocr_label(cv.get("text"), max_length=DEFAULT_MAX_LABEL_LENGTH)
        if not crop_txt:
            continue
        vlm_clean = m.get("vlm_clean")
        viet_clean = m.get("viet_clean")
        pad_clean, _ = sanitize_and_validate_vietocr_label(m.get("pad_line") or "", max_length=DEFAULT_MAX_LABEL_LENGTH)
        confirmed = False
        tier = ""
        if vlm_clean and crop_txt == vlm_clean:
            confirmed, tier = True, "crop_vlm_confirmed_page_vlm"
        elif viet_clean and crop_txt == viet_clean:
            confirmed, tier = True, "crop_vlm_confirmed_vietocr"
        elif pad_clean and crop_txt == pad_clean:
            confirmed, tier = True, "crop_vlm_confirmed_paddleocr"
        elif vlm_clean and _alnum_diacritics_key(crop_txt) == _alnum_diacritics_key(vlm_clean) and abs(len(crop_txt) - len(vlm_clean)) <= 2:
            confirmed, tier = True, "crop_vlm_confirmed_punct"
        if confirmed:
            m["final_label"] = crop_txt
            m["verification_tier"] = tier
            m["crop_vlm_text"] = crop_txt
            verified_disagreed.append(m)

    all_candidates = exact_or_punct + verified_disagreed
    print(
        f"Dual-recognizer results: {len(exact_or_punct)} consensus + "
        f"{len(verified_disagreed)}/{len(disagreed)} crop-VLM confirmed = {len(all_candidates)} total candidates.",
        flush=True,
    )

    # Strict hygiene, PII, SHA-256 deduplication, and visual trap checks
    verified_at = datetime.now(timezone.utc).isoformat()
    seen_hashes: set[str] = set()
    by_cohort_group: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))

    for m in all_candidates:
        rec = m["page_rec"]
        item = m["item"]
        label = m["final_label"]
        cleaned, reason = sanitize_and_validate_vietocr_label(label, max_length=DEFAULT_MAX_LABEL_LENGTH)
        if cleaned is None:
            continue
        if detect_vietnamese_pii_strict(cleaned, mode="contact_only"):
            continue
        if _is_visual_trap_text(
            cleaned,
            grade=rec["grade"],
            book_slug=rec["book_slug"],
            yc=float(item["yc"]),
            page_h=int(m["page_h"]),
        ):
            continue

        raw_bytes = Path(m["crop_path"]).read_bytes()
        rgb_pil = open_image_exif_safe(raw_bytes)
        ok_crop, _, _ = validate_flow2_line_crop(rgb_pil, label=cleaned, page_height=int(m["page_h"]))
        if not ok_crop:
            continue

        sha = hashlib.sha256(raw_bytes).hexdigest().lower()
        if sha in existing_hashes or sha in seen_hashes:
            continue
        if rec["source_group_id"] in existing_groups:
            continue
        seen_hashes.add(sha)

        line_idx = int(item["line_index"])
        sample_id = str(
            uuid5(
                NAMESPACE_URL,
                f"viread-flow2-rawpages:{rec['source_group_id']}:{line_idx}:{sha}",
            )
        )
        by_cohort_group[rec["cohort"]][rec["source_group_id"]].append({
            "sample_id": sample_id,
            "source_flow": "FLOW1_VERIFIED",
            "source_group_id": rec["source_group_id"],
            "split": rec["split"],
            "cohort": rec["cohort"],
            "eligible_for_locked_test": rec["eligible_for_locked_test"],
            "grade": rec["grade"],
            "book_slug": rec["book_slug"],
            "page_number": rec["page_number"],
            "page_filename": rec["page_filename"],
            "line_index": line_idx,
            "label": cleaned,
            "label_sha256": hashlib.sha256(cleaned.encode("utf-8")).hexdigest(),
            "image_filename": f"{sha}.png",
            "image_relpath": f"crops/{sha}.png",
            "image_sha256": sha,
            "width": rgb_pil.size[0],
            "height": rgb_pil.size[1],
            "yc": item["yc"],
            "quad": item["quad"],
            "source_name": f"{rec['book_slug']} ({rec['page_filename']})",
            "rights_basis": "owner_supplied",
            "verification_status": "VERIFIED",
            "verification_source": "admin",
            "verified_by": "owner-rawpages-dual-vlm-vietocr-curated-v1",
            "verified_at": verified_at,
            "verification_tier": m["verification_tier"],
            "vietocr_200edce4_text": m.get("viet_clean"),
            "vlm_page_text": m.get("vlm_clean"),
            "paddle_text": m.get("pad_line"),
            "crop_vlm_text": m.get("crop_vlm_text"),
            "_src_crop_path": m["crop_path"],
        })

    # Enforce cross-split text uniqueness for long lines (>= 24 chars) so cohort1, cohort2,
    # validation, and train never share any exact >=24-char sentence.
    c1_long_texts: set[str] = set()
    for rows in by_cohort_group["cohort1"].values():
        for row in rows:
            tkey = " ".join(row["label"].lower().split())
            if len(tkey) >= 24:
                c1_long_texts.add(tkey)

    for gid in list(by_cohort_group["cohort2"].keys()):
        kept_c2 = [
            r for r in by_cohort_group["cohort2"][gid]
            if " ".join(r["label"].lower().split()) not in c1_long_texts
        ]
        if kept_c2:
            by_cohort_group["cohort2"][gid] = kept_c2
        else:
            del by_cohort_group["cohort2"][gid]

    holdout_long_texts: set[str] = set(c1_long_texts)
    for rows in by_cohort_group["cohort2"].values():
        for row in rows:
            tkey = " ".join(row["label"].lower().split())
            if len(tkey) >= 24:
                holdout_long_texts.add(tkey)

    val_long_texts: set[str] = set()
    for rows in by_cohort_group["validation"].values():
        for row in rows:
            tkey = " ".join(row["label"].lower().split())
            if len(tkey) >= 24:
                val_long_texts.add(tkey)

    for cohort_name, forbid in (("validation", holdout_long_texts), ("train", holdout_long_texts | val_long_texts)):
        for gid in list(by_cohort_group[cohort_name].keys()):
            kept = [
                r for r in by_cohort_group[cohort_name][gid]
                if " ".join(r["label"].lower().split()) not in forbid
            ]
            if kept:
                by_cohort_group[cohort_name][gid] = kept
            else:
                del by_cohort_group[cohort_name][gid]

    # Cap holdouts per group (~10 lines/group) and balance to target windows.
    final_samples: list[dict[str, Any]] = []

    def _collect_capped_cohort(
        cohort_name: str,
        target_min: int,
        target_aim: int,
        target_max: int,
        max_per_group: int,
    ) -> list[dict[str, Any]]:
        grp_map = by_cohort_group[cohort_name]
        raw_grps = sorted(
            [(gid, sorted(rows, key=lambda x: int(x["line_index"]))) for gid, rows in grp_map.items() if len(rows) >= 2],
            key=lambda kv: (kv[1][0]["grade"], kv[1][0]["book_slug"], kv[1][0]["page_number"]),
        )
        eligible_grps = [(gid, _select_evenly_spaced(rows, max_per_group)) for gid, rows in raw_grps]
        total_now = sum(len(r) for _, r in eligible_grps)
        if total_now < target_min:
            # Top up round-robin by +1 line on groups that have surplus clean lines, keeping all groups & grade balance
            raw_lookup = dict(raw_grps)
            cap_by_gid = {gid: len(rows) for gid, rows in eligible_grps}
            by_grade_gids: dict[str, list[str]] = defaultdict(list)
            for gid, rows in eligible_grps:
                by_grade_gids[rows[0]["grade"]].append(gid)
            extra_cap = max_per_group + 1
            while total_now < target_aim and extra_cap <= max_per_group + 3:
                gained = False
                for g in sorted(by_grade_gids.keys()):
                    for gid in by_grade_gids[g]:
                        if total_now >= target_aim:
                            break
                        if len(raw_lookup[gid]) > cap_by_gid[gid] and cap_by_gid[gid] < extra_cap:
                            cap_by_gid[gid] += 1
                            total_now += 1
                            gained = True
                if not gained:
                    extra_cap += 1
            eligible_grps = [(gid, _select_evenly_spaced(raw_lookup[gid], cap_by_gid[gid])) for gid, _ in eligible_grps]

        by_grade: dict[str, list[tuple[str, list[dict[str, Any]]]]] = defaultdict(list)
        for gid, rows in eligible_grps:
            by_grade[rows[0]["grade"]].append((gid, rows))
        picked_rows: list[dict[str, Any]] = []
        total_now = sum(len(r) for _, r in eligible_grps)
        if total_now <= target_max:
            for _, rows in eligible_grps:
                picked_rows.extend(rows)
            return picked_rows
        # Trim evenly across grades and book positions until <= target_max
        queues = {g: _stride_order_groups(lst) for g, lst in by_grade.items()}
        grades = sorted(queues.keys())
        while any(queues.values()):
            progressed = False
            for g in grades:
                if not queues[g]:
                    continue
                gid, rows = queues[g].pop(0)
                if len(picked_rows) + len(rows) <= target_max:
                    picked_rows.extend(rows)
                    progressed = True
            if not progressed:
                break
        return picked_rows

    c1_rows = _collect_capped_cohort("cohort1", target_min=830, target_aim=855, target_max=880, max_per_group=10)
    c2_rows = _collect_capped_cohort("cohort2", target_min=415, target_aim=445, target_max=480, max_per_group=10)

    # Collect train + validation (~2,800-3,200 combined, ~82% train / ~18% val)
    train_grps = list(by_cohort_group["train"].items())
    val_grps = list(by_cohort_group["validation"].items())
    train_rows_all = [r for _, rows in train_grps for r in rows]
    val_rows_all = [r for _, rows in val_grps for r in rows]

    # If combined train+val > 3150, trim whole groups from train/val proportionally across grades
    def _trim_groups(grps: list[tuple[str, list[dict[str, Any]]]], cap: int) -> list[dict[str, Any]]:
        total = sum(len(rows) for _, rows in grps)
        if total <= cap:
            return [r for _, rows in grps for r in rows]
        by_grade: dict[str, list[tuple[str, list[dict[str, Any]]]]] = defaultdict(list)
        for gid, rows in sorted(grps, key=lambda kv: (kv[1][0]["grade"], kv[1][0]["book_slug"], kv[1][0]["page_number"], kv[0])):
            by_grade[rows[0]["grade"]].append((gid, rows))
        queues = {g: _stride_order_groups(lst) for g, lst in by_grade.items()}
        kept: list[dict[str, Any]] = []
        grades = sorted(queues.keys())
        while any(queues.values()):
            progressed = False
            for g in grades:
                if not queues[g]:
                    continue
                _, rows = queues[g].pop(0)
                if len(kept) + len(rows) <= cap:
                    kept.extend(rows)
                    progressed = True
            if not progressed:
                break
        return kept

    if len(train_rows_all) + len(val_rows_all) > 3150:
        val_cap = min(len(val_rows_all), round(3100 * 0.18))
        val_rows_all = _trim_groups(val_grps, val_cap)
        train_cap = 3100 - len(val_rows_all)
        train_rows_all = _trim_groups(train_grps, train_cap)

    final_samples = train_rows_all + val_rows_all + c1_rows + c2_rows

    # Write final <sha256>.png files into out_dir/crops/ (cleaning any stale crops from earlier runs)
    crops_dir = out_dir / "crops"
    crops_dir.mkdir(parents=True, exist_ok=True)
    expected_files = {row["image_filename"] for row in final_samples}
    for old_png in crops_dir.glob("*.png"):
        if old_png.name not in expected_files:
            old_png.unlink(missing_ok=True)
    for row in final_samples:
        src = Path(row.pop("_src_crop_path"))
        dst = crops_dir / row["image_filename"]
        if not dst.is_file():
            dst.write_bytes(src.read_bytes())
        row["image_path"] = str(dst)

    manifest = {
        "schema": "viread-rawpages-curated-v1",
        "generated_at": verified_at,
        "crops_dir": str(crops_dir),
        "counts": _summarize_samples(final_samples),
        "samples": final_samples,
    }
    manifest_path = out_dir / "curated_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote curated_manifest.json ({len(final_samples)} samples) -> {manifest_path}", flush=True)
    return manifest_path


def _summarize_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    by_cohort: dict[str, dict[str, Any]] = {}
    for cohort in ("train", "validation", "cohort1", "cohort2"):
        sub = [s for s in samples if s["cohort"] == cohort]
        by_cohort[cohort] = {
            "samples": len(sub),
            "groups": len({s["source_group_id"] for s in sub}),
            "by_grade": dict(sorted(Counter(s["grade"] for s in sub).items())),
            "by_tier": dict(sorted(Counter(s["verification_tier"] for s in sub).items())),
        }
    return {
        "total_samples": len(samples),
        "total_groups": len({s["source_group_id"] for s in samples}),
        "train_plus_validation_samples": by_cohort["train"]["samples"] + by_cohort["validation"]["samples"],
        "by_cohort": by_cohort,
    }


def run_stage_check(out_dir: Path) -> int:
    manifest_path = out_dir / "curated_manifest.json"
    db_state = json.loads((out_dir / "existing_db_state.json").read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    samples: list[dict[str, Any]] = manifest["samples"]

    existing_hashes = {h.lower() for h in db_state["existing_hashes"]}
    existing_groups = set(db_state["groups"].keys())
    existing_grade4 = _parse_existing_grade4_pages(db_state["groups"])

    errors: list[str] = []
    seen_hashes: set[str] = set()
    seen_ids: set[str] = set()
    group_cohorts: dict[str, set[str]] = defaultdict(set)
    cohort_counts: Counter[str] = Counter()
    grade_counts: Counter[str] = Counter()

    for idx, s in enumerate(samples):
        sha = str(s["image_sha256"]).lower()
        sid = str(s["sample_id"])
        gid = str(s["source_group_id"])
        cohort = str(s["cohort"])
        label = str(s["label"])
        cohort_counts[cohort] += 1
        grade_counts[str(s["grade"])] += 1

        if sid in seen_ids:
            errors.append(f"Duplicate sample_id: {sid}")
        seen_ids.add(sid)

        if sha in seen_hashes:
            errors.append(f"Duplicate image_sha256 in manifest: {sha}")
        if sha in existing_hashes:
            errors.append(f"Overlap with existing DB image_sha256: {sha}")
        seen_hashes.add(sha)

        if gid in existing_groups:
            errors.append(f"Group overlaps existing DB group: {gid}")
        if (s["book_slug"], int(s["page_number"])) in existing_grade4:
            errors.append(f"Existing Grade 4 page leaked: {s['book_slug']} p{s['page_number']}")

        group_cohorts[gid].add(cohort)
        if int(s["page_number"]) <= 5:
            errors.append(f"Front matter page leaked: {gid}")

        norm_lbl, reason = sanitize_and_validate_vietocr_label(label, max_length=DEFAULT_MAX_LABEL_LENGTH)
        if norm_lbl is None or norm_lbl != label:
            errors.append(f"Label failed hygiene ({reason}): {label!r}")
        if detect_vietnamese_pii_strict(label, mode="contact_only"):
            errors.append(f"PII detected in label: {label!r}")

        folded = _strip_accents_lower(label)
        if "ban in thu" in folded or "to va viet" in folded:
            errors.append(f"Trap keyword leaked in label: {label!r}")
        if len(label.strip()) < 2 or _STANDALONE_PAGE_NUM_RE.fullmatch(label.strip()):
            errors.append(f"Too short / page number leaked: {label!r}")

        img_p = Path(s["image_path"])
        if not img_p.is_file():
            errors.append(f"Missing crop file: {img_p}")
        else:
            raw = img_p.read_bytes()
            if hashlib.sha256(raw).hexdigest().lower() != sha:
                errors.append(f"SHA mismatch on disk: {img_p}")
            rgb = open_image_exif_safe(raw)
            ok_c, _, r_c = validate_flow2_line_crop(rgb, label=label)
            if not ok_c:
                errors.append(f"Crop quality check failed ({r_c}) at idx={idx}")

    multi_cohort_groups = {g: c for g, c in group_cohorts.items() if len(c) > 1}
    if multi_cohort_groups:
        errors.append(f"Groups span multiple cohorts/splits: {list(multi_cohort_groups.items())[:5]}")

    long_by_cohort: dict[str, set[str]] = defaultdict(set)
    for s in samples:
        tkey = " ".join(str(s["label"]).lower().split())
        if len(tkey) >= 24:
            long_by_cohort[str(s["cohort"])].add(tkey)
    cohort_names = sorted(long_by_cohort.keys())
    for i in range(len(cohort_names)):
        for j in range(i + 1, len(cohort_names)):
            overlap_txt = long_by_cohort[cohort_names[i]] & long_by_cohort[cohort_names[j]]
            if overlap_txt:
                errors.append(f"Cross-cohort >=24-char overlap ({cohort_names[i]} vs {cohort_names[j]}): {len(overlap_txt)}")

    disk_pngs = list((out_dir / "crops").glob("*.png"))
    if len(disk_pngs) != len(seen_hashes):
        errors.append(f"crops/ PNG count mismatch: disk={len(disk_pngs)} manifest_unique_hashes={len(seen_hashes)}")

    summary = _summarize_samples(samples)
    print("=== INTEGRITY AUDIT SUMMARY ===", flush=True)
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    print(f"Total errors: {len(errors)}", flush=True)
    for err in errors[:20]:
        print("  ERROR:", err, flush=True)
    return 1 if errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Flow 2 multi-grade raw_pages dataset curator.")
    parser.add_argument(
        "--stage",
        choices=["all", "select", "vlm", "ocr", "align", "check"],
        default="all",
    )
    parser.add_argument("--raw-root", type=Path, default=DEFAULT_RAW_ROOT)
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--vlm-concurrency", type=int, default=8)
    parser.add_argument("--max-crop-verify", type=int, default=3500)
    parser.add_argument("--ocr-max-pages", type=int, default=0)
    args = parser.parse_args()

    load_dotenv(args.env_file, override=False)

    if args.stage in ("all", "select"):
        run_stage_select(args.raw_root, args.out_dir)
    if args.stage in ("all", "vlm"):
        asyncio.run(_run_stage_vlm_async(args.out_dir, args.vlm_concurrency))
    if args.stage in ("all", "ocr"):
        run_stage_ocr(args.out_dir, max_pages=args.ocr_max_pages)
    if args.stage in ("all", "align"):
        run_stage_align_and_pack(args.out_dir, max_crop_verify=args.max_crop_verify)
    if args.stage in ("all", "check"):
        return run_stage_check(args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
