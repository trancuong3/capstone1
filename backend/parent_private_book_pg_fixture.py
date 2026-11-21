"""Disposable local PostgreSQL 18 harness for Parent Private Books tests.

Creates an isolated disposable database per test class inside local PostgreSQL
(never touching any production/Supabase URL), seeds realistic legacy schema &
catalog data, applies `supabase/migrations/20261121220000_parent_private_books.sql`
verbatim, and wires real FastAPI + local isolated Storage.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import psycopg2
from fastapi import FastAPI
from PIL import Image, ImageDraw
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = REPO_ROOT / "supabase" / "migrations" / "20261121220000_parent_private_books.sql"

DEFAULT_LOCAL_ADMIN_PG_URL = "postgresql://postgres:viread_local_test@127.0.0.1:5432/postgres"


def _resolve_local_pg_admin_url() -> str:
    explicit = os.getenv("PARENT_PRIVATE_BOOK_TEST_ADMIN_URL")
    if explicit:
        return explicit
    for env_name in ("ADMIN_OCR_TEST_DATABASE_URL", "READING_REPORT_TEST_DATABASE_URL", "DATABASE_URL"):
        candidate = (os.getenv(env_name) or "").strip()
        if not candidate:
            continue
        if "127.0.0.1" not in candidate and "localhost" not in candidate:
            continue
        sync_candidate = candidate.replace("postgresql+asyncpg://", "postgresql://", 1)
        if "/" in sync_candidate.rsplit("@", 1)[-1]:
            return sync_candidate.rsplit("/", 1)[0] + "/postgres"
    return DEFAULT_LOCAL_ADMIN_PG_URL


LOCAL_PG_ADMIN_URL = _resolve_local_pg_admin_url()

PARENT_A = UUID("11111111-1111-4111-8111-111111111111")
CHILD_A = UUID("11111111-1111-4111-8111-111111111112")
PARENT_B = UUID("22222222-2222-4222-8222-222222222221")
CHILD_B = UUID("22222222-2222-4222-8222-222222222222")
ADMIN_1 = UUID("33333333-3333-4333-8333-333333333331")
ADMIN_2 = UUID("33333333-3333-4333-8333-333333333332")
LEGACY_CATALOG_BOOK_ADMIN_CREATED = UUID("44444444-4444-4444-8444-444444444441")
LEGACY_CATALOG_BOOK_NULL_CREATED = UUID("44444444-4444-4444-8444-444444444442")
LEGACY_CATALOG_PAGE_ID = UUID("44444444-4444-4444-8444-444444444443")
LEGACY_CATALOG_REV_ID = UUID("44444444-4444-4444-8444-444444444444")


def make_synthetic_png(text_label: str = "Mèo con đi học", *, width: int = 400, height: int = 300, bg=(255, 255, 255)) -> bytes:
    from io import BytesIO

    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)
    if text_label:
        draw.text((30, 80), text_label, fill=(0, 0, 0))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_synthetic_pdf(page_texts: list[str]) -> bytes:
    from io import BytesIO

    images = []
    for label in page_texts:
        img = Image.new("RGB", (500, 700), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        if label:
            draw.text((40, 120), label, fill=(0, 0, 0))
        images.append(img)
    buf = BytesIO()
    images[0].save(buf, format="PDF", save_all=True, append_images=images[1:])
    return buf.getvalue()


BASE_SCHEMA_SQL = """
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
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL DEFAULT 'parent',
  displayname text,
  contact_phone text,
  avatar_path text,
  active smallint NOT NULL DEFAULT 1,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.childprofiles (
  id uuid PRIMARY KEY,
  parentid uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  alias text NOT NULL,
  grade smallint NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  avatar_path text,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  title text NOT NULL,
  author text,
  mingrade smallint NOT NULL,
  maxgrade smallint NOT NULL,
  expectedpagecount integer,
  lifecyclestatus text NOT NULL DEFAULT 'ACTIVE',
  createdby uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bookpages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bookid uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  pagenumber smallint NOT NULL,
  imagepath text NOT NULL,
  width smallint NOT NULL,
  height smallint NOT NULL,
  featurepath text,
  contenttype text NOT NULL DEFAULT 'CONTENT',
  processingmeta jsonb NOT NULL DEFAULT '{}'::jsonb,
  currentverifiedrevisionid uuid,
  lifecyclestatus text NOT NULL DEFAULT 'ACTIVE',
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pagerevisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pageid uuid NOT NULL REFERENCES public.bookpages(id) ON DELETE CASCADE,
  revisionno text NOT NULL,
  verificationstatus text NOT NULL,
  originalocrtext text,
  verifiedtext text,
  drafttext text,
  contenthash text NOT NULL,
  processingmeta jsonb NOT NULL DEFAULT '{}'::jsonb,
  verifiedby uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verifiedat timestamptz,
  createdat timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pageid, revisionno)
);

ALTER TABLE public.bookpages
  ADD CONSTRAINT bookpages_currentverifiedrevisionid_fkey
  FOREIGN KEY (currentverifiedrevisionid) REFERENCES public.pagerevisions(id) ON DELETE SET NULL;

CREATE TABLE public.pagerevisionwords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pagerevisionid uuid NOT NULL REFERENCES public.pagerevisions(id) ON DELETE CASCADE,
  wordindex smallint NOT NULL,
  lineindex smallint NOT NULL,
  text text NOT NULL,
  normalizedtext text NOT NULL,
  boundingbox jsonb NOT NULL,
  ocrconfidence double precision,
  UNIQUE (pagerevisionid, wordindex)
);

CREATE TABLE public.auditlogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actorid uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  resourcetype text NOT NULL,
  resourceid uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  requestid text NOT NULL DEFAULT '',
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.adminaiworkflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pageid uuid NOT NULL REFERENCES public.bookpages(id) ON DELETE CASCADE,
  bookid uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  pagerevisionid uuid NOT NULL REFERENCES public.pagerevisions(id) ON DELETE CASCADE,
  actorid uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  idempotencykey uuid NOT NULL,
  originaltext text NOT NULL,
  inputtext text NOT NULL,
  inputwords jsonb NOT NULL DEFAULT '[]'::jsonb,
  imagepath text NOT NULL,
  sourceimagesha256 varchar(64),
  originalocrhash varchar(64) NOT NULL,
  admininputhash varchar(64) NOT NULL,
  proofreadtext text,
  proofreadoutputhash varchar(64),
  candidatetext text,
  candidatehash varchar(64),
  candidateversion integer NOT NULL DEFAULT 0,
  candidatehistory jsonb NOT NULL DEFAULT '[]'::jsonb,
  safetyinputhash varchar(64),
  safetyhistory jsonb NOT NULL DEFAULT '[]'::jsonb,
  suitability varchar(32),
  safetystatus varchar(32) NOT NULL DEFAULT 'PENDING',
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  correctionsuggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
  uncertainwordindices jsonb NOT NULL DEFAULT '[]'::jsonb,
  providerevents jsonb NOT NULL DEFAULT '[]'::jsonb,
  proofreadmetadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  safetymetadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewevents jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(40) NOT NULL DEFAULT 'QUEUED',
  stage varchar(40) NOT NULL DEFAULT 'PROOFREADING',
  completedchunks integer NOT NULL DEFAULT 0,
  totalchunks integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  errorcode varchar(80),
  workerid varchar(120),
  leaseexpiresat timestamptz,
  retryafter timestamptz,
  safetyconfirmedat timestamptz,
  safetyconfirmedby uuid,
  imagesafetystatus varchar(40) NOT NULL DEFAULT 'UNASSESSED_NO_VISION_MODEL',
  imagesafetyreviewedby uuid,
  imagesafetyreviewedat timestamptz,
  imagesafetyreviewnote varchar(1000),
  imagesafetyimagesha256 varchar(64),
  imagesafetyreason varchar(500),
  rightsprofileid uuid,
  rightsprofileversion integer,
  rightsprofilehash varchar(64),
  ocrapprovedat timestamptz,
  ocrapprovedby uuid,
  finalapprovedtexthash varchar(64),
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.readingsessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  childid uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  bookid uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  selectedpageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  selectedpagerevisionid uuid REFERENCES public.pagerevisions(id) ON DELETE SET NULL,
  startpageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  endpageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  currentpageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'IN_PROGRESS',
  mode text NOT NULL DEFAULT 'realtime',
  clientmeta jsonb NOT NULL DEFAULT '{}'::jsonb,
  startedat timestamptz NOT NULL DEFAULT now(),
  endedat timestamptz
);

CREATE TABLE public.readingsessionpages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessionid uuid NOT NULL REFERENCES public.readingsessions(id) ON DELETE CASCADE,
  pageid uuid NOT NULL REFERENCES public.bookpages(id) ON DELETE CASCADE,
  pagerevisionid uuid NOT NULL REFERENCES public.pagerevisions(id) ON DELETE CASCADE,
  pagenumber smallint NOT NULL,
  pageorder smallint NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  startedat timestamptz,
  completedat timestamptz
);

CREATE TABLE public.readingevents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessionid uuid NOT NULL REFERENCES public.readingsessions(id) ON DELETE CASCADE,
  pageid uuid NOT NULL,
  pagerevisionid uuid NOT NULL,
  wordid uuid,
  type text NOT NULL,
  startms integer NOT NULL DEFAULT 0,
  endms integer,
  confidence double precision,
  status text NOT NULL DEFAULT 'CONFIRMED',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.fluencyassessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessionid uuid NOT NULL REFERENCES public.readingsessions(id) ON DELETE CASCADE,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  score double precision,
  uncertainty double precision,
  modelversion text,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.comprehensionquestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessionid uuid NOT NULL REFERENCES public.readingsessions(id) ON DELETE CASCADE,
  pagerevisionid uuid NOT NULL,
  type text NOT NULL,
  prompt text NOT NULL,
  sourcespan jsonb,
  difficulty text,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.comprehensionanswers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  questionid uuid NOT NULL REFERENCES public.comprehensionquestions(id) ON DELETE CASCADE,
  answer text NOT NULL,
  iscorrect boolean,
  score double precision,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.readingcomparisonreports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessionid uuid NOT NULL REFERENCES public.readingsessions(id) ON DELETE CASCADE,
  pageid uuid NOT NULL,
  pagerevisionid uuid NOT NULL,
  transcript text NOT NULL,
  distance integer NOT NULL DEFAULT 0,
  alignment jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.progressreports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  childid uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  periodstart date NOT NULL,
  periodend date NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  generatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.consentrecords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parentid uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  childid uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  scope text NOT NULL,
  granted boolean NOT NULL,
  grantedat timestamptz,
  revokedat timestamptz
);

CREATE TABLE public.readingpresencesettings (
  parentid uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  emailenabled boolean NOT NULL DEFAULT false,
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.readingpresencealerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sessionid uuid NOT NULL REFERENCES public.readingsessions(id) ON DELETE CASCADE,
  parentid uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  childid uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  episodeid uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  dueat timestamptz NOT NULL,
  expiresat timestamptz NOT NULL,
  lastconfirmedat timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  claimedat timestamptz,
  sentat timestamptz,
  cancelreason varchar(32),
  errorcode varchar(64),
  createdat timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sessionid, episodeid)
);

CREATE TABLE public.readinggoals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  childid uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  metric text NOT NULL,
  targetvalue integer NOT NULL,
  period text NOT NULL,
  startson date NOT NULL,
  endson date,
  timezone text NOT NULL,
  status text NOT NULL,
  completedvalue integer,
  completedat timestamptz,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.readingplans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  childid uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  bookid uuid REFERENCES public.books(id) ON DELETE SET NULL,
  title text NOT NULL,
  targetminutes integer NOT NULL,
  weekdays integer[] NOT NULL,
  startson date NOT NULL,
  endson date,
  timezone text NOT NULL,
  status text NOT NULL,
  completedat timestamptz,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.childbookcollections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  childid uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  bookid uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  collectiontype text NOT NULL,
  createdat timestamptz NOT NULL DEFAULT now(),
  UNIQUE (childid, bookid, collectiontype)
);

CREATE TABLE public.readingreminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  childid uuid NOT NULL REFERENCES public.childprofiles(id) ON DELETE CASCADE,
  remindat time NOT NULL,
  weekdays integer[] NOT NULL,
  timezone text NOT NULL,
  isactive boolean NOT NULL DEFAULT true,
  emailenabled boolean NOT NULL DEFAULT false,
  deletedat timestamptz,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.readingreminderoccurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminderid uuid NOT NULL REFERENCES public.readingreminders(id) ON DELETE CASCADE,
  scheduledlocaldate date NOT NULL,
  scheduledfor timestamptz,
  status text NOT NULL,
  acknowledgedat timestamptz,
  emailstatus text NOT NULL DEFAULT 'NOT_REQUESTED',
  emailattempts integer NOT NULL DEFAULT 0,
  emaillastattemptat timestamptz,
  emailnextattemptat timestamptz,
  emailsentat timestamptz,
  emailerrorcode text,
  UNIQUE (reminderid, scheduledlocaldate)
);

CREATE TABLE public.bookqualityscanruns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bookid uuid REFERENCES public.books(id) ON DELETE SET NULL,
  booktitlesnapshot text NOT NULL DEFAULT '',
  triggertype text NOT NULL,
  scan_scope text NOT NULL DEFAULT 'BOOK',
  targetpageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  totalpages integer NOT NULL DEFAULT 0,
  completedpages integer NOT NULL DEFAULT 0,
  skippedpages integer NOT NULL DEFAULT 0,
  failedpages integer NOT NULL DEFAULT 0,
  aicompletedpages integer NOT NULL DEFAULT 0,
  aiunavailablepages integer NOT NULL DEFAULT 0,
  errorsummary text,
  attemptcount integer NOT NULL DEFAULT 0,
  workerid text,
  leaseexpiresat timestamptz,
  startedat timestamptz,
  completedat timestamptz,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bookcontentreports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporterid uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reporternamesnapshot text,
  bookid uuid REFERENCES public.books(id) ON DELETE SET NULL,
  booktitlesnapshot text NOT NULL DEFAULT '',
  pageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  pagenumbersnapshot integer,
  pagerevisionid uuid REFERENCES public.pagerevisions(id) ON DELETE SET NULL,
  verifiedtextsnapshot text,
  contenthashsnapshot text,
  issuetype text NOT NULL,
  description text NOT NULL,
  reportedtext text,
  suggestedcorrection text,
  idempotencykey uuid NOT NULL,
  scanrunid uuid REFERENCES public.bookqualityscanruns(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'OPEN',
  adminresolutionnote text,
  reviewedby uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewedbynamesnapshot text,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now(),
  resolvedat timestamptz,
  UNIQUE (reporterid, idempotencykey)
);

CREATE TABLE public.bookcontentreporthistory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reportid uuid NOT NULL REFERENCES public.bookcontentreports(id) ON DELETE CASCADE,
  actorid uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actornamesnapshot text,
  fromstatus text,
  tostatus text NOT NULL,
  note text,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bookqualitypagescans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scanrunid uuid NOT NULL REFERENCES public.bookqualityscanruns(id) ON DELETE CASCADE,
  bookid uuid REFERENCES public.books(id) ON DELETE SET NULL,
  pageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  pagenumbersnapshot integer NOT NULL DEFAULT 1,
  pagelifecyclesnapshot text NOT NULL DEFAULT 'ACTIVE',
  pagerevisionid uuid REFERENCES public.pagerevisions(id) ON DELETE SET NULL,
  contenthash text,
  verifiedtextsnapshot text,
  status text NOT NULL DEFAULT 'QUEUED',
  rulecheckstatus text NOT NULL DEFAULT 'PENDING',
  aianalysisstatus text NOT NULL DEFAULT 'PENDING',
  rejectedaifindingcount integer NOT NULL DEFAULT 0,
  attemptcount integer NOT NULL DEFAULT 0,
  errorcode text,
  errorsummary text,
  startedat timestamptz,
  completedat timestamptz,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bookqualityfindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pagescanid uuid NOT NULL REFERENCES public.bookqualitypagescans(id) ON DELETE CASCADE,
  bookid uuid REFERENCES public.books(id) ON DELETE SET NULL,
  pageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  pagerevisionid uuid REFERENCES public.pagerevisions(id) ON DELETE SET NULL,
  issuetype text NOT NULL,
  severity text NOT NULL,
  originalexcerpt text NOT NULL DEFAULT '',
  excerptstart integer NOT NULL DEFAULT 0,
  excerptend integer NOT NULL DEFAULT 0,
  suggestedcorrection text,
  explanation text NOT NULL DEFAULT '',
  detectionsource text NOT NULL,
  modelname text,
  confidence double precision,
  status text NOT NULL DEFAULT 'NEEDS_REVIEW',
  reviewedby uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewnote text,
  reviewedat timestamptz,
  createdat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bookcontentrightsprofiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bookid uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  pageid uuid REFERENCES public.bookpages(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'BOOK',
  status text NOT NULL DEFAULT 'NOT_ASSESSED',
  sourcename text,
  rightsholder text,
  usagebasis text,
  evidenceurl text,
  evidencereference text,
  notes text,
  sourcefingerprint text,
  profileversion integer NOT NULL DEFAULT 1,
  referencecheckstatus text NOT NULL DEFAULT 'NOT_RUN',
  referencecheckevidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewedby uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewedbynamesnapshot text,
  reviewedat timestamptz,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bookqualityreportfindings (
  reportid uuid NOT NULL REFERENCES public.bookcontentreports(id) ON DELETE CASCADE,
  findingid uuid NOT NULL REFERENCES public.bookqualityfindings(id) ON DELETE CASCADE,
  PRIMARY KEY (reportid, findingid)
);

CREATE TABLE public.bookrightsevidences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bookid uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  pageid uuid REFERENCES public.bookpages(id) ON DELETE CASCADE,
  scope varchar(8) NOT NULL DEFAULT 'BOOK',
  status varchar(32) NOT NULL DEFAULT 'UNASSESSED',
  sourcedescription varchar(500),
  authororrightsholder varchar(300),
  usagebasis varchar(120),
  evidenceurlorref varchar(1000),
  notes varchar(2000),
  version integer NOT NULL DEFAULT 1,
  contentfingerprint varchar(64),
  reviewedby uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewedbynamesnapshot varchar(160),
  reviewedat timestamptz,
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bookrightsevidencehistory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidenceid uuid NOT NULL REFERENCES public.bookrightsevidences(id) ON DELETE CASCADE,
  bookid uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  pageid uuid REFERENCES public.bookpages(id) ON DELETE SET NULL,
  scope varchar(8) NOT NULL,
  version integer NOT NULL,
  fromstatus varchar(32),
  tostatus varchar(32) NOT NULL,
  sourcedescription varchar(500),
  authororrightsholder varchar(300),
  usagebasis varchar(120),
  evidenceurlorref varchar(1000),
  notes varchar(2000),
  contentfingerprint varchar(64),
  actorid uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actornamesnapshot varchar(160),
  createdat timestamptz NOT NULL DEFAULT now()
);

-- Grant permissive catalog-style SELECT privileges to anon/authenticated so our
-- AS RESTRICTIVE RLS policies in the migration are genuinely exercised in tests!
GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
GRANT SELECT ON public.books, public.bookpages, public.pagerevisions, public.pagerevisionwords TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated, service_role;

CREATE POLICY test_permissive_books_select ON public.books FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY test_permissive_bookpages_select ON public.bookpages FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY test_permissive_pagerevisions_select ON public.pagerevisions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY test_permissive_pagerevisionwords_select ON public.pagerevisionwords FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY test_permissive_storage_select ON storage.objects FOR SELECT TO anon, authenticated USING (true);
"""


class DisposablePrivateBookDatabase:
    """Manages one disposable PostgreSQL database + isolated local Storage dir + FastAPI test app."""

    def __init__(self) -> None:
        self.db_name = f"viread_ppb_test_{uuid4().hex[:12]}"
        self.sync_url = LOCAL_PG_ADMIN_URL.rsplit("/", 1)[0] + f"/{self.db_name}"
        self.async_url = self.sync_url.replace("postgresql://", "postgresql+asyncpg://", 1)
        self.storage_dir = Path(tempfile.mkdtemp(prefix="viread_ppb_storage_"))
        self.engine = None
        self.sessions = None
        self.previous_storage_env: str | None = None

    def setup(self) -> None:
        # 1. Create fresh disposable database
        admin_conn = psycopg2.connect(LOCAL_PG_ADMIN_URL)
        admin_conn.autocommit = True
        try:
            with admin_conn.cursor() as cur:
                cur.execute(f'CREATE DATABASE "{self.db_name}"')
        finally:
            admin_conn.close()

        # 2. Apply base schema + seed legacy catalog books BEFORE migration
        conn = psycopg2.connect(self.sync_url)
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                cur.execute(BASE_SCHEMA_SQL)
                # Seed users & children (2 families + 2 admins)
                cur.execute(
                    """
                    INSERT INTO public.profiles (id, role, displayname, contact_phone, active) VALUES
                      (%s, 'parent', 'Phụ huynh A', '0901111111', 1),
                      (%s, 'parent', 'Phụ huynh B', '0902222222', 1),
                      (%s, 'admin', 'Admin 1', NULL, 1),
                      (%s, 'admin', 'Admin 2', NULL, 1)
                    """,
                    (str(PARENT_A), str(PARENT_B), str(ADMIN_1), str(ADMIN_2)),
                )
                cur.execute(
                    """
                    INSERT INTO public.childprofiles (id, parentid, alias, grade) VALUES
                      (%s, %s, 'Bé An', 2),
                      (%s, %s, 'Bé Bình', 2)
                    """,
                    (str(CHILD_A), str(PARENT_A), str(CHILD_B), str(PARENT_B)),
                )
                # Seed pre-migration legacy catalog books (one with createdby=Admin, one with createdby=NULL)
                cur.execute(
                    """
                    INSERT INTO public.books (id, name, title, author, mingrade, maxgrade, lifecyclestatus, createdby) VALUES
                      (%s, 'Chú Mèo Nhỏ', 'Chú Mèo Nhỏ', 'Tác giả Hệ thống', 1, 3, 'ACTIVE', %s),
                      (%s, 'Khu Vườn Mùa Xuân', 'Khu Vườn Mùa Xuân', 'Tác giả Cũ', 1, 5, 'ACTIVE', NULL)
                    """,
                    (
                        str(LEGACY_CATALOG_BOOK_ADMIN_CREATED),
                        str(ADMIN_1),
                        str(LEGACY_CATALOG_BOOK_NULL_CREATED),
                    ),
                )
                # Seed a verified page + workflow + approval audit log for LEGACY_CATALOG_BOOK_ADMIN_CREATED
                wf_id = str(uuid4())
                cand_hash = "legacy-catalog-hash-1"
                cur.execute(
                    """
                    INSERT INTO public.bookpages (id, bookid, pagenumber, imagepath, width, height, lifecyclestatus)
                    VALUES (%s, %s, 1, 'catalog/cat-p1.png', 600, 800, 'ACTIVE')
                    """,
                    (str(LEGACY_CATALOG_PAGE_ID), str(LEGACY_CATALOG_BOOK_ADMIN_CREATED)),
                )
                cur.execute(
                    """
                    INSERT INTO public.pagerevisions (
                      id, pageid, revisionno, verificationstatus, originalocrtext, verifiedtext, drafttext,
                      contenthash, processingmeta, verifiedby, verifiedat
                    ) VALUES (
                      %s, %s, '1', 'VERIFIED', 'Chú mèo nhỏ đi học.', 'Chú mèo nhỏ đi học.', 'Chú mèo nhỏ đi học.',
                      %s,
                      jsonb_build_object('admin_ai_workflow', jsonb_build_object(
                        'workflow_id', %s::text, 'candidate_hash', %s::text, 'safety_input_hash', %s::text
                      )),
                      %s, now()
                    )
                    """,
                    (
                        str(LEGACY_CATALOG_REV_ID),
                        str(LEGACY_CATALOG_PAGE_ID),
                        cand_hash,
                        wf_id,
                        cand_hash,
                        cand_hash,
                        str(ADMIN_1),
                    ),
                )
                cur.execute(
                    "UPDATE public.bookpages SET currentverifiedrevisionid = %s WHERE id = %s",
                    (str(LEGACY_CATALOG_REV_ID), str(LEGACY_CATALOG_PAGE_ID)),
                )
                cur.execute(
                    """
                    INSERT INTO public.pagerevisionwords (pagerevisionid, wordindex, lineindex, text, normalizedtext, boundingbox)
                    VALUES (%s, 0, 0, 'Chú', 'chú', '[0.1,0.1,0.2,0.05]'::jsonb),
                           (%s, 1, 0, 'mèo', 'mèo', '[0.32,0.1,0.2,0.05]'::jsonb)
                    """,
                    (str(LEGACY_CATALOG_REV_ID), str(LEGACY_CATALOG_REV_ID)),
                )
                cur.execute(
                    """
                    INSERT INTO public.adminaiworkflows (
                      id, pageid, bookid, pagerevisionid, actorid, idempotencykey,
                      originaltext, inputtext, imagepath, originalocrhash, admininputhash,
                      candidatetext, candidatehash, safetyinputhash, suitability, safetystatus,
                      findings, status, stage, safetyconfirmedat, safetyconfirmedby,
                      ocrapprovedat, ocrapprovedby, finalapprovedtexthash
                    ) VALUES (
                      %s, %s, %s, %s, %s, gen_random_uuid(),
                      'Chú mèo nhỏ đi học.', 'Chú mèo nhỏ đi học.', 'catalog/cat-p1.png', %s, %s,
                      'Chú mèo nhỏ đi học.', %s, %s, 'SUITABLE', 'CONFIRMED',
                      '[]'::jsonb, 'READY_FOR_ADMIN_REVIEW', 'CHILD_SAFETY_SCANNING', now(), %s,
                      now(), %s, %s
                    )
                    """,
                    (
                        wf_id,
                        str(LEGACY_CATALOG_PAGE_ID),
                        str(LEGACY_CATALOG_BOOK_ADMIN_CREATED),
                        str(LEGACY_CATALOG_REV_ID),
                        str(ADMIN_1),
                        cand_hash,
                        cand_hash,
                        cand_hash,
                        cand_hash,
                        str(ADMIN_1),
                        str(ADMIN_1),
                        cand_hash,
                    ),
                )
                # Compute exact page_snapshot matching CatalogRepository.eligible_book
                from app.policies.book_approval import BOOK_APPROVAL_POLICY_VERSION

                cur.execute(
                    """
                    WITH snap AS (
                      SELECT jsonb_agg(
                        jsonb_build_object(
                          'page_id', p.id::text,
                          'page_number', p.pagenumber,
                          'lifecycle_status', p.lifecyclestatus,
                          'revision_id', r.id::text,
                          'revision_content_hash', r.contenthash,
                          'revision_status', r.verificationstatus,
                          'revision_workflow_id', r.processingmeta->'admin_ai_workflow'->>'workflow_id',
                          'revision_candidate_hash', r.processingmeta->'admin_ai_workflow'->>'candidate_hash',
                          'revision_safety_input_hash', r.processingmeta->'admin_ai_workflow'->>'safety_input_hash',
                          'workflow_id', w.id::text,
                          'candidate_hash', w.candidatehash,
                          'safety_input_hash', w.safetyinputhash,
                          'suitability', w.suitability,
                          'workflow_status', w.status,
                          'safety_status', w.safetystatus,
                          'final_approved_text_hash', w.finalapprovedtexthash,
                          'safety_confirmed', (w.safetyconfirmedat IS NOT NULL),
                          'safety_confirmed_by', (w.safetyconfirmedby IS NOT NULL),
                          'ocr_approved', (w.ocrapprovedat IS NOT NULL AND w.ocrapprovedby IS NOT NULL),
                          'findings_hash', md5(coalesce(w.findings, '[]'::jsonb)::text),
                          'safety_metadata_hash', md5(coalesce(w.safetymetadata, '{}'::jsonb)::text),
                          'proofread_metadata_hash', md5(coalesce(w.proofreadmetadata, '{}'::jsonb)::text)
                        )
                      ) AS page_snapshot
                      FROM public.bookpages p
                      JOIN public.pagerevisions r ON r.id = p.currentverifiedrevisionid
                      JOIN public.adminaiworkflows w ON w.pageid = p.id
                      WHERE p.bookid = %s
                    )
                    INSERT INTO public.auditlogs (actorid, action, resourcetype, resourceid, metadata)
                    SELECT %s, 'book.children.approved', 'book', %s,
                           jsonb_build_object('policy', %s::text, 'page_snapshot', snap.page_snapshot)
                    FROM snap
                    """,
                    (
                        str(LEGACY_CATALOG_BOOK_ADMIN_CREATED),
                        str(ADMIN_1),
                        str(LEGACY_CATALOG_BOOK_ADMIN_CREATED),
                        BOOK_APPROVAL_POLICY_VERSION,
                    ),
                )
            conn.commit()

            # 3. Apply the REAL parent private books migration verbatim!
            migration_sql = MIGRATION_PATH.read_text(encoding="utf-8")
            with conn.cursor() as cur:
                cur.execute(migration_sql)
            conn.commit()
        finally:
            conn.close()

        self.previous_storage_env = os.environ.get("VIREAD_LOCAL_STORAGE_DIR")
        os.environ["VIREAD_LOCAL_STORAGE_DIR"] = str(self.storage_dir)

        self.engine = create_async_engine(self.async_url, poolclass=NullPool)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def teardown(self) -> None:
        if self.engine is not None:
            await self.engine.dispose()
        if self.previous_storage_env is None:
            os.environ.pop("VIREAD_LOCAL_STORAGE_DIR", None)
        else:
            os.environ["VIREAD_LOCAL_STORAGE_DIR"] = self.previous_storage_env
        shutil.rmtree(self.storage_dir, ignore_errors=True)

        admin_conn = psycopg2.connect(LOCAL_PG_ADMIN_URL)
        admin_conn.autocommit = True
        try:
            with admin_conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT pg_terminate_backend(pid)
                    FROM pg_stat_activity
                    WHERE datname = %s AND pid <> pg_backend_pid()
                    """,
                    (self.db_name,),
                )
                cur.execute(f'DROP DATABASE IF EXISTS "{self.db_name}"')
        finally:
            admin_conn.close()

    def build_app(self) -> FastAPI:
        """Build a FastAPI app routed to this disposable DB with strict Bearer-token actor dispatch."""
        from fastapi import Depends, HTTPException
        from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
        from app.api.deps import get_current_parent_id, get_db
        from app.api.router import api_router

        tokens: dict[str, UUID] = {
            "token-parent-a": PARENT_A,
            "token-parent-b": PARENT_B,
            "token-admin-1": ADMIN_1,
            "token-admin-2": ADMIN_2,
        }
        bearer = HTTPBearer(auto_error=False)

        async def _override_db():
            async with self.sessions() as session:
                yield session

        def _override_actor(
            credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
        ) -> UUID:
            if credentials is None:
                raise HTTPException(status_code=401, detail="Authentication required")
            actor = tokens.get(credentials.credentials)
            if actor is None:
                raise HTTPException(status_code=401, detail="Invalid authentication credentials")
            return actor

        app = FastAPI()
        app.include_router(api_router)
        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_parent_id] = _override_actor
        return app

    def client(self, app: FastAPI, token: str | None = None) -> httpx.AsyncClient:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers=headers,
        )
