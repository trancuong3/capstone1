"""Idempotently provision and seed the isolated local PostgreSQL staging DB (`viread_qa_local`).

Safety guarantees:
  - NEVER modifies `backend/.env` or writes to the remote family Supabase PostgreSQL DB.
  - Asserts that target `DATABASE_URL` points strictly to 127.0.0.1 / localhost (`viread_qa_local`).
  - Supabase Auth is used ONLY for user login tokens (`acceptance-accounts.json`);
    all application rows (profiles, children, books, pages, sessions, quiz) live in `viread_qa_local`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid5, NAMESPACE_DNS

import psycopg2
from dotenv import dotenv_values
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import create_engine, delete, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"
PASSAGES_FILE = (
    REPO_ROOT
    / "docs"
    / "reading"
    / "evidence"
    / "reading_acceptance_20261125"
    / "fixtures"
    / "passages.json"
)
ACCOUNTS_FILE = Path(r"F:\c1\viread-host-runtime\acceptance-accounts.json")
LOCAL_STORAGE_DIR = Path(r"F:\c1\viread-host-runtime\local-storage")
STAGING_INFO_FILE = Path(r"F:\c1\viread-host-runtime\staging-seed-info.json")

DEFAULT_DB_NAME = "viread_qa_local"
DEFAULT_PG_USER = "postgres"
DEFAULT_PG_PASS = "viread_local_test"
DEFAULT_PG_HOST = "127.0.0.1"
DEFAULT_PG_PORT = 5432

# Deterministic staging IDs for idempotent re-seeding
LOCAL_ADMIN_ID = UUID("aaaaaaaa-2026-4112-8000-000000000001")
ACCEPTANCE_BOOK_ID = UUID("aaaaaaaa-2026-4112-8001-000000000001")
PAGE_1_ID = UUID("aaaaaaaa-2026-4112-8001-000000000101")
PAGE_2_ID = UUID("aaaaaaaa-2026-4112-8001-000000000102")
PAGE_3_ID = UUID("aaaaaaaa-2026-4112-8001-000000000103")
REV_1_ID = UUID("aaaaaaaa-2026-4112-8001-000000000201")
REV_2_ID = UUID("aaaaaaaa-2026-4112-8001-000000000202")
REV_3_ID = UUID("aaaaaaaa-2026-4112-8001-000000000203")
SEED_SESSION_ID = UUID("aaaaaaaa-2026-4112-8001-000000000901")
QUESTION_1_ID = UUID("aaaaaaaa-2026-4112-8001-000000000911")
QUESTION_2_ID = UUID("aaaaaaaa-2026-4112-8001-000000000912")
QUESTION_3_ID = UUID("aaaaaaaa-2026-4112-8001-000000000913")

PAGE_3_OVERLAY_TEXT = (
    "Bé Mi che ô cho bạn An.\n"
    "Đọc rõ từng tiếng:\n"
    "mốt, một, bàn, bạn, nghỉ, nghĩ.\n"
    "Chú thỏ nhắc: Dừng lại!"
)

BOOTSTRAP_SQL = """
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL REFERENCES storage.buckets(id) ON DELETE CASCADE,
  name text NOT NULL,
  owner uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
"""

OCR_MIGRATION_FILES = (
    "20261112110945_viread_vietocr_v2.sql",
    "20261113023322_viread_training_job_queue.sql",
    "20261113051337_viread_colab_enterprise_dispatch.sql",
    "20261114093543_auto_lock_verified_holdout_and_job_lineage.sql",
    "20261115151028_viread_progressive_evaluation.sql",
    "20261121210000_flow2_google_drive_storage.sql",
    "20261122100000_flow2_sample_quarantine_and_archive.sql",
)


def _assert_local_db_url(url_str: str) -> None:
    parsed = make_url(url_str)
    host = (parsed.host or "").lower()
    if host not in {"127.0.0.1", "localhost", "::1"} or "supabase" in url_str.lower():
        raise RuntimeError(
            f"SAFETY ABORT: refusing to operate on non-local DB host={host!r}"
        )


def _load_local_env(async_db_url: str) -> None:
    env_file = BACKEND_ROOT / ".env"
    if env_file.is_file():
        for k, v in dotenv_values(env_file).items():
            if v is None or k == "DATABASE_URL":
                continue
            if not os.environ.get(k):
                os.environ[k] = v
    # Force strict local DB & storage overrides in process env only
    os.environ["DATABASE_URL"] = async_db_url
    os.environ["DATABASE_POOLER_MODE"] = "local"
    os.environ["DATABASE_SSL_REQUIRED"] = "false"
    os.environ["APP_ENVIRONMENT"] = "development"
    os.environ["VIREAD_LOCAL_STORAGE_DIR"] = str(LOCAL_STORAGE_DIR)


def _ensure_postgres_listening(host: str, port: int) -> None:
    import socket
    import subprocess
    import time

    def _can_connect() -> bool:
        try:
            with socket.create_connection((host, port), timeout=1.5):
                return True
        except OSError:
            return False

    if _can_connect():
        return
    if host not in {"127.0.0.1", "localhost", "::1"}:
        return
    # Local PostgreSQL 18 on this machine runs inside WSL2 Ubuntu, which auto-suspends when idle.
    subprocess.run(
        ["wsl", "-d", "Ubuntu", "-u", "root", "--", "service", "postgresql", "start"],
        capture_output=True,
        timeout=30,
        check=False,
    )
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        if _can_connect():
            return
        time.sleep(0.4)


def _ensure_database_exists(admin_sync_url: str, db_name: str) -> None:
    _assert_local_db_url(admin_sync_url)
    parsed = make_url(admin_sync_url)
    _ensure_postgres_listening(parsed.host or "127.0.0.1", parsed.port or 5432)
    conn = psycopg2.connect(admin_sync_url)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
            if cur.fetchone() is None:
                cur.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        conn.close()


def _apply_schema(sync_url: str) -> None:
    _assert_local_db_url(sync_url)
    conn = psycopg2.connect(sync_url)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
        conn.commit()
    finally:
        conn.close()

    sys.path.insert(0, str(BACKEND_ROOT))
    import app.models  # noqa: F401
    from app.database.session import Base

    sync_engine = create_engine(sync_url.replace("postgresql://", "postgresql+psycopg2://", 1))
    try:
        non_karaoke_tables = [
            tbl for tbl in Base.metadata.sorted_tables if not tbl.name.startswith("karaoke_")
        ]
        Base.metadata.create_all(bind=sync_engine, tables=non_karaoke_tables, checkfirst=True)
    finally:
        sync_engine.dispose()

    conn = psycopg2.connect(sync_url)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.karaoke_songs') IS NOT NULL")
            if not bool(cur.fetchone()[0]):
                for fname in ("20261114130000_add_karaoke.sql", "20261117060000_add_karaoke_processing.sql"):
                    sql_path = MIGRATIONS_DIR / fname
                    if sql_path.is_file():
                        cur.execute(sql_path.read_text(encoding="utf-8"))
            cur.execute(
                "SELECT to_regclass('public.viread_ocr_outbox') IS NOT NULL"
            )
            has_ocr_tables = bool(cur.fetchone()[0])
            if not has_ocr_tables:
                for fname in OCR_MIGRATION_FILES:
                    sql_path = MIGRATIONS_DIR / fname
                    if sql_path.is_file():
                        cur.execute(sql_path.read_text(encoding="utf-8"))
        conn.commit()
    finally:
        conn.close()


def _resolve_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        r"C:\Windows\Fonts\times.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
    ):
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def _render_text_page_png_with_boxes(
    lines: list[str],
    *,
    width: int = 1200,
    height: int = 900,
    font_size: int = 52,
    margin_x: int = 72,
    start_y: int = 120,
    line_step: int = 160,
) -> tuple[bytes, list[dict]]:
    """Render Vietnamese text onto a crisp cream PNG and return exact normalized word boxes."""
    img = Image.new("RGB", (width, height), (251, 248, 241))
    draw = ImageDraw.Draw(img)
    font = _resolve_font(font_size)

    word_rows: list[dict] = []
    word_index = 0
    y = start_y
    for line_index, line in enumerate(lines):
        tokens = line.split()
        x = margin_x
        space_advance = max(14, int(draw.textlength(" ", font=font)))
        for tok in tokens:
            bbox = draw.textbbox((x, y), tok, font=font)
            x0, y0, x1, y1 = bbox
            # Add gentle padding while keeping strictly non-overlapping with neighbors
            pad_x = 3
            pad_y = 6
            bx0 = max(0, x0 - pad_x)
            by0 = max(0, y0 - pad_y)
            bx1 = min(width, max(bx0 + 4, x1 + pad_x))
            by1 = min(height, max(by0 + 14, y1 + pad_y))
            draw.text((x, y), tok, font=font, fill=(24, 24, 28))

            norm_x = round(bx0 / width, 6)
            norm_y = round(by0 / height, 6)
            norm_w = round((bx1 - bx0) / width, 6)
            norm_h = round((by1 - by0) / height, 6)
            word_rows.append(
                {
                    "word_index": word_index,
                    "line_index": line_index,
                    "text": unicodedata.normalize("NFC", tok),
                    "bbox": [norm_x, norm_y, norm_w, norm_h],
                }
            )
            word_index += 1
            x = int(round(x + draw.textlength(tok, font=font) + space_advance))
        y += line_step

    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), word_rows


def _build_reflow_words(text_value: str, *, words_per_line: int = 10) -> list[dict]:
    tokens = text_value.split()
    out: list[dict] = []
    for idx, tok in enumerate(tokens):
        line_idx = idx // words_per_line
        col_idx = idx % words_per_line
        x = round(0.04 + col_idx * 0.09, 6)
        y = round(0.05 + (line_idx % 18) * 0.045, 6)
        out.append(
            {
                "word_index": idx,
                "line_index": line_idx,
                "text": unicodedata.normalize("NFC", tok),
                "bbox": [x, y, 0.08, 0.035],
            }
        )
    return out


def _sha256_text(text_value: str) -> str:
    return hashlib.sha256(unicodedata.normalize("NFC", text_value).encode("utf-8")).hexdigest()


def _upsert_seed_data(sync_url: str, *, reset_seed_answers: bool = False) -> dict:
    from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
    from app.models import (
        Book,
        BookPage,
        ChildProfile,
        ComprehensionAnswer,
        ComprehensionQuestion,
        PageRevision,
        PageRevisionWord,
        Profile,
        ReadingSession,
        ReadingSessionPage,
    )
    from app.services.storage_service import upload_object
    from app.services.tutor_questions.text_utils import normalize_text
    from app.services.word_box_geometry import build_geometry_evidence, has_verified_geometry

    if not ACCOUNTS_FILE.is_file():
        raise FileNotFoundError(f"Missing acceptance accounts file: {ACCOUNTS_FILE}")
    if not PASSAGES_FILE.is_file():
        raise FileNotFoundError(f"Missing acceptance passages file: {PASSAGES_FILE}")

    accounts = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
    passages = json.loads(PASSAGES_FILE.read_text(encoding="utf-8"))

    parent_a = accounts["parent_a"]
    parent_b = accounts.get("parent_b")
    parent_a_id = UUID(parent_a["user_id"])
    child_a_id = UUID(parent_a["child_id"])

    short_text = unicodedata.normalize("NFC", passages["short_passage"].strip())
    long_text = unicodedata.normalize("NFC", passages["long_passage"].strip())
    overlay_text = unicodedata.normalize("NFC", PAGE_3_OVERLAY_TEXT.strip())

    p1_png, _ = _render_text_page_png_with_boxes(
        [
            "Sáng nay, Mi mang ô đến lớp.",
            "Tan học, trời đổ mưa.",
            "Mi che ô cho bạn An.",
        ],
        width=1200,
        height=640,
        font_size=46,
        start_y=90,
        line_step=140,
    )
    p2_png, _ = _render_text_page_png_with_boxes(
        ["Trang 2: Đọc đoạn văn dài (401 từ)", "Xem chi tiết trong chế độ văn bản."],
        width=1200,
        height=480,
        font_size=38,
        start_y=120,
        line_step=120,
    )
    p3_lines = overlay_text.splitlines()
    p3_png, p3_words = _render_text_page_png_with_boxes(
        p3_lines,
        width=1200,
        height=900,
        font_size=52,
        margin_x=72,
        start_y=110,
        line_step=175,
    )
    p3_geometry = build_geometry_evidence(p3_words, 1200, 900, reliable=True)
    if not has_verified_geometry(p3_geometry, p3_words, 1200, 900):
        raise RuntimeError("Page 3 overlay geometry failed verification")

    p1_storage_path = f"qa-staging/{ACCEPTANCE_BOOK_ID}/page-1.png"
    p2_storage_path = f"qa-staging/{ACCEPTANCE_BOOK_ID}/page-2.png"
    p3_storage_path = f"qa-staging/{ACCEPTANCE_BOOK_ID}/page-3.png"
    upload_object(p1_storage_path, p1_png, "image/png", bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET, upsert=True)
    upload_object(p2_storage_path, p2_png, "image/png", bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET, upsert=True)
    upload_object(p3_storage_path, p3_png, "image/png", bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET, upsert=True)

    p1_words = _build_reflow_words(short_text, words_per_line=7)
    p2_words = _build_reflow_words(long_text, words_per_line=10)

    sync_engine = create_engine(sync_url.replace("postgresql://", "postgresql+psycopg2://", 1))
    now = datetime.now(timezone.utc)
    try:
        with Session(sync_engine) as db:
            # 1. Profiles & ChildProfiles
            profiles_spec = [
                (LOCAL_ADMIN_ID, "admin", "Local Staging Admin"),
                (parent_a_id, "parent", parent_a.get("full_name") or "Phụ huynh Nghiệm thu A"),
            ]
            if parent_b:
                profiles_spec.append(
                    (UUID(parent_b["user_id"]), "parent", parent_b.get("full_name") or "Phụ huynh Nghiệm thu B")
                )
            for pid, role, display_name in profiles_spec:
                prof = db.get(Profile, pid)
                if prof is None:
                    db.add(Profile(Id=pid, Role=role, DisplayName=display_name, Active=1))
                else:
                    prof.Role = role
                    prof.DisplayName = display_name
                    prof.Active = 1

            child_a = db.get(ChildProfile, child_a_id)
            if child_a is None:
                db.add(
                    ChildProfile(
                        Id=child_a_id,
                        ParentId=parent_a_id,
                        Alias=parent_a.get("child_alias") or "Bé Minh Nghiệm Thu",
                        Grade=2,
                        Settings={},
                    )
                )
            else:
                child_a.ParentId = parent_a_id
                child_a.Alias = parent_a.get("child_alias") or "Bé Minh Nghiệm Thu"
                child_a.Grade = 2

            if parent_b:
                child_b_id = UUID(parent_b["child_id"])
                child_b = db.get(ChildProfile, child_b_id)
                if child_b is None:
                    db.add(
                        ChildProfile(
                            Id=child_b_id,
                            ParentId=UUID(parent_b["user_id"]),
                            Alias=parent_b.get("child_alias") or "Bé Lan Nghiệm Thu",
                            Grade=2,
                            Settings={},
                        )
                    )
            db.flush()

            # 2. 5-Minute Acceptance Book (PARENT_PRIVATE owned by parent_a -> local storage image proxy!)
            book_title = "Truyện Ngắn Bé Mi & Bạn An (Nghiệm Thu 5 Phút)"
            book = db.get(Book, ACCEPTANCE_BOOK_ID)
            if book is None:
                book = Book(
                    Id=ACCEPTANCE_BOOK_ID,
                    Name=book_title,
                    Title=book_title,
                    Author="ViRead QA Acceptance",
                    MinGrade=1,
                    MaxGrade=2,
                    ExpectedPageCount=3,
                    LifecycleStatus="ACTIVE",
                    CreatedBy=parent_a_id,
                    VisibilityScope="PARENT_PRIVATE",
                    OwnerParentId=parent_a_id,
                    ModerationStatus="ACTIVE",
                    SourceDeclaration="SELF_AUTHORED",
                )
                db.add(book)
            else:
                book.Name = book_title
                book.Title = book_title
                book.MinGrade = 1
                book.MaxGrade = 2
                book.ExpectedPageCount = 3
                book.LifecycleStatus = "ACTIVE"
                book.VisibilityScope = "PARENT_PRIVATE"
                book.OwnerParentId = parent_a_id
                book.ModerationStatus = "ACTIVE"
            db.flush()

            pages_spec = [
                (PAGE_1_ID, REV_1_ID, 1, p1_storage_path, 1200, 640, short_text, p1_words, {}),
                (PAGE_2_ID, REV_2_ID, 2, p2_storage_path, 1200, 480, long_text, p2_words, {}),
                (
                    PAGE_3_ID,
                    REV_3_ID,
                    3,
                    p3_storage_path,
                    1200,
                    900,
                    overlay_text,
                    p3_words,
                    {
                        "source_image_path": p3_storage_path,
                        "source_image_width": 1200,
                        "source_image_height": 900,
                        "word_box_geometry": p3_geometry,
                    },
                ),
            ]
            for page_id, rev_id, page_no, img_path, w, h, txt, words_list, proc_meta in pages_spec:
                page = db.get(BookPage, page_id)
                if page is None:
                    page = BookPage(
                        Id=page_id,
                        BookId=ACCEPTANCE_BOOK_ID,
                        PageNumber=page_no,
                        ImagePath=img_path,
                        Width=w,
                        Height=h,
                        ContentType="CONTENT",
                        ProcessingMeta={},
                        LifecycleStatus="ACTIVE",
                    )
                    db.add(page)
                else:
                    page.BookId = ACCEPTANCE_BOOK_ID
                    page.PageNumber = page_no
                    page.ImagePath = img_path
                    page.Width = w
                    page.Height = h
                    page.LifecycleStatus = "ACTIVE"
                db.flush()

                rev = db.get(PageRevision, rev_id)
                chash = _sha256_text(txt)
                if rev is None:
                    rev = PageRevision(
                        Id=rev_id,
                        PageId=page_id,
                        RevisionNo="1",
                        VerificationStatus="VERIFIED",
                        OriginalOcrText=txt,
                        VerifiedText=txt,
                        DraftText=txt,
                        ContentHash=chash,
                        ProcessingMeta=proc_meta,
                        VerifiedBy=LOCAL_ADMIN_ID,
                        VerifiedAt=now,
                    )
                    db.add(rev)
                else:
                    rev.PageId = page_id
                    rev.VerificationStatus = "VERIFIED"
                    rev.OriginalOcrText = txt
                    rev.VerifiedText = txt
                    rev.DraftText = txt
                    rev.ContentHash = chash
                    rev.ProcessingMeta = proc_meta
                    rev.VerifiedBy = LOCAL_ADMIN_ID
                    rev.VerifiedAt = now
                db.flush()

                page.CurrentVerifiedRevisionId = rev_id
                db.execute(
                    delete(PageRevisionWord).where(PageRevisionWord.PageRevisionId == rev_id)
                )
                for w_item in words_list:
                    w_uuid = uuid5(NAMESPACE_DNS, f"viread-qa:{rev_id}:{w_item['word_index']}")
                    db.add(
                        PageRevisionWord(
                            Id=w_uuid,
                            PageRevisionId=rev_id,
                            WordIndex=w_item["word_index"],
                            LineIndex=w_item["line_index"],
                            Text=w_item["text"],
                            NormalizedText=normalize_text(w_item["text"]) or w_item["text"].lower(),
                            BoundingBox=w_item["bbox"],
                            OCRConfidence=0.99,
                        )
                    )
            db.flush()

            # 3. Pre-seeded completed ReadingSession + 3 ComprehensionQuestions
            sess = db.get(ReadingSession, SEED_SESSION_ID)
            if sess is None:
                sess = ReadingSession(
                    Id=SEED_SESSION_ID,
                    ChildId=child_a_id,
                    BookId=ACCEPTANCE_BOOK_ID,
                    SelectedPageId=PAGE_1_ID,
                    SelectedPageRevisionId=REV_1_ID,
                    StartPageId=PAGE_1_ID,
                    EndPageId=PAGE_3_ID,
                    CurrentPageId=PAGE_3_ID,
                    State="COMPLETED",
                    Mode="realtime",
                    ClientMeta={"qa_staging_seed": True},
                    StartedAt=now - timedelta(minutes=5),
                    EndedAt=now - timedelta(minutes=1),
                )
                db.add(sess)
            else:
                sess.ChildId = child_a_id
                sess.BookId = ACCEPTANCE_BOOK_ID
                sess.State = "COMPLETED"
            db.flush()

            for order, (pid, rid, pno) in enumerate(
                [(PAGE_1_ID, REV_1_ID, 1), (PAGE_2_ID, REV_2_ID, 2), (PAGE_3_ID, REV_3_ID, 3)]
            ):
                sp = db.scalar(
                    select(ReadingSessionPage).where(
                        ReadingSessionPage.SessionId == SEED_SESSION_ID,
                        ReadingSessionPage.PageId == pid,
                    )
                )
                if sp is None:
                    db.add(
                        ReadingSessionPage(
                            SessionId=SEED_SESSION_ID,
                            PageId=pid,
                            PageRevisionId=rid,
                            PageNumber=pno,
                            PageOrder=order,
                            Status="COMPLETED",
                            StartedAt=now - timedelta(minutes=5 - order),
                            CompletedAt=now - timedelta(minutes=4 - order),
                        )
                    )
            db.flush()

            questions_spec = [
                (
                    QUESTION_1_ID,
                    PAGE_1_ID,
                    REV_1_ID,
                    "FACTUAL",
                    "Mi che ô cho ai?",
                    "Bạn An",
                    ["Bạn Lan", "Bạn An", "Cô giáo"],
                    12,
                    18,
                    "EASY",
                    now,
                ),
                (
                    QUESTION_2_ID,
                    PAGE_2_ID,
                    REV_2_ID,
                    "FACTUAL",
                    "Trong truyện đọc thêm, chú thỏ anh nhắc em điều gì?",
                    "Đọc lại cho rõ dấu hỏi và dấu ngã",
                    [
                        "Đọc lại cho rõ dấu hỏi và dấu ngã",
                        "Chạy thật nhanh ra sân trường",
                        "Cất sách vào cặp ngay",
                    ],
                    118,
                    136,
                    "MEDIUM",
                    now + timedelta(microseconds=10),
                ),
                (
                    QUESTION_3_ID,
                    PAGE_2_ID,
                    REV_2_ID,
                    "VOCABULARY",
                    "Khi về nhà, bé Mi tập viết cẩn thận những chữ nào?",
                    "bàn, bạn, nghỉ, nghĩ",
                    [
                        "hoa cúc, sân trường",
                        "mây xám, mái ngói",
                        "bàn, bạn, nghỉ, nghĩ",
                    ],
                    137,
                    156,
                    "MEDIUM",
                    now + timedelta(microseconds=20),
                ),
            ]
            for (
                qid,
                pid,
                rid,
                qtype,
                prompt,
                expected_ans,
                choices,
                s_idx,
                e_idx,
                diff,
                created_at,
            ) in questions_spec:
                accepted = [
                    normalize_text(expected_ans),
                    normalize_text(choices[choices.index(expected_ans)]),
                ]
                letter = "ABC"[choices.index(expected_ans)]
                span_payload = {
                    "start_word_index": s_idx,
                    "end_word_index_exclusive": e_idx,
                    "sentence_index": None,
                    "choices": choices,
                    "correct_letter": letter,
                    "generation": {"source": "RULE_BASED", "provider": "qa_staging_seed"},
                }
                q = db.get(ComprehensionQuestion, qid)
                if q is None:
                    db.add(
                        ComprehensionQuestion(
                            Id=qid,
                            SessionId=SEED_SESSION_ID,
                            PageId=pid,
                            PageRevisionId=rid,
                            Type=qtype,
                            Prompt=prompt,
                            ExpectedAnswer=expected_ans,
                            AcceptedAnswers=list(dict.fromkeys(accepted)),
                            SourceSpan=span_payload,
                            Difficulty=diff,
                            CreatedAt=created_at,
                        )
                    )
                else:
                    q.Type = qtype
                    q.Prompt = prompt
                    q.ExpectedAnswer = expected_ans
                    q.AcceptedAnswers = list(dict.fromkeys(accepted))
                    q.SourceSpan = span_payload
                    q.Difficulty = diff
                if reset_seed_answers:
                    db.execute(
                        delete(ComprehensionAnswer).where(ComprehensionAnswer.QuestionId == qid)
                    )
            db.commit()
    finally:
        sync_engine.dispose()

    info = {
        "database_name": DEFAULT_DB_NAME,
        "parent_a_email": parent_a["email"],
        "parent_a_id": str(parent_a_id),
        "child_a_alias": "Bé Minh Nghiệm Thu",
        "child_a_id": str(child_a_id),
        "book_id": str(ACCEPTANCE_BOOK_ID),
        "book_title": book_title,
        "visibility_scope": "PARENT_PRIVATE",
        "pages": [
            {"page_number": 1, "page_id": str(PAGE_1_ID), "revision_id": str(REV_1_ID), "word_count": len(p1_words), "mode": "reflow_text"},
            {"page_number": 2, "page_id": str(PAGE_2_ID), "revision_id": str(REV_2_ID), "word_count": len(p2_words), "mode": "reflow_text"},
            {"page_number": 3, "page_id": str(PAGE_3_ID), "revision_id": str(REV_3_ID), "word_count": len(p3_words), "mode": "image_overlay", "image_size": [1200, 900]},
        ],
        "seed_session_id": str(SEED_SESSION_ID),
        "seed_question_ids": [str(QUESTION_1_ID), str(QUESTION_2_ID), str(QUESTION_3_ID)],
        "local_storage_dir": str(LOCAL_STORAGE_DIR),
    }
    STAGING_INFO_FILE.parent.mkdir(parents=True, exist_ok=True)
    STAGING_INFO_FILE.write_text(json.dumps(info, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return info


def main() -> None:
    parser = argparse.ArgumentParser(description="Provision isolated local Postgres staging DB viread_qa_local.")
    parser.add_argument("--pg-host", default=os.getenv("VIREAD_STAGING_PG_HOST", DEFAULT_PG_HOST))
    parser.add_argument("--pg-port", type=int, default=int(os.getenv("VIREAD_STAGING_PG_PORT", str(DEFAULT_PG_PORT))))
    parser.add_argument("--pg-user", default=os.getenv("VIREAD_STAGING_PG_USER", DEFAULT_PG_USER))
    parser.add_argument("--pg-password", default=os.getenv("VIREAD_STAGING_PG_PASSWORD", DEFAULT_PG_PASS))
    parser.add_argument("--db-name", default=os.getenv("VIREAD_STAGING_PG_DB", DEFAULT_DB_NAME))
    parser.add_argument("--reset-seed-answers", action="store_true", help="Clear answers on the 3 pre-seeded questions.")
    args = parser.parse_args()

    admin_sync_url = f"postgresql://{args.pg_user}:{args.pg_password}@{args.pg_host}:{args.pg_port}/postgres"
    target_sync_url = f"postgresql://{args.pg_user}:{args.pg_password}@{args.pg_host}:{args.pg_port}/{args.db_name}"
    target_async_url = f"postgresql+asyncpg://{args.pg_user}:{args.pg_password}@{args.pg_host}:{args.pg_port}/{args.db_name}"

    _load_local_env(target_async_url)
    _ensure_database_exists(admin_sync_url, args.db_name)
    _apply_schema(target_sync_url)
    summary = _upsert_seed_data(target_sync_url, reset_seed_answers=args.reset_seed_answers)
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
