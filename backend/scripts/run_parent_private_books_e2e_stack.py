"""Local full-stack test harness for Parent Private Books ("Sách của tôi") E2E.

Strictly local/test-only:
- Uses a disposable PostgreSQL database inside local PostgreSQL 18 (127.0.0.1:5432)
- Applies `supabase/migrations/20261121220000_parent_private_books.sql` verbatim
- Uses isolated local temp Storage (`VIREAD_LOCAL_STORAGE_DIR`)
- Serves local test-only Supabase Auth + PostgREST (`127.0.0.1:54321`) with RS256 JWKS
- Runs the real ViRead FastAPI API (`127.0.0.1:8010`) + real background worker + real local Ollama (`127.0.0.1:11434`)
- NEVER connects to any production Supabase or database URL.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import signal
import sys
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs
from uuid import UUID, uuid4

import jwt
import psycopg2
import uvicorn
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageDraw, ImageFont

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from parent_private_book_pg_fixture import (  # noqa: E402
    ADMIN_1,
    CHILD_A,
    CHILD_B,
    LEGACY_CATALOG_BOOK_ADMIN_CREATED,
    LEGACY_CATALOG_PAGE_ID,
    PARENT_A,
    PARENT_B,
    DisposablePrivateBookDatabase,
)

AUTH_PORT = int(os.getenv("VIREAD_E2E_AUTH_PORT", "54321"))
API_PORT = int(os.getenv("VIREAD_E2E_API_PORT", "8010"))
WEB_ORIGIN = os.getenv("VIREAD_E2E_WEB_ORIGIN", "http://127.0.0.1:3010")
STACK_INFO_PATH = Path(
    os.getenv(
        "VIREAD_E2E_STACK_INFO",
        str(Path(tempfile.gettempdir()) / "viread_ppb_e2e_stack_info.json"),
    )
)

TEST_USERS: dict[str, dict[str, Any]] = {
    "parent-a@viread.test": {
        "id": str(PARENT_A),
        "email": "parent-a@viread.test",
        "password": "VireadTest!2026",
        "role": "parent",
        "display_name": "Phụ huynh A",
    },
    "parent-b@viread.test": {
        "id": str(PARENT_B),
        "email": "parent-b@viread.test",
        "password": "VireadTest!2026",
        "role": "parent",
        "display_name": "Phụ huynh B",
    },
    "admin@viread.test": {
        "id": str(ADMIN_1),
        "email": "admin@viread.test",
        "password": "VireadAdmin!2026",
        "role": "admin",
        "display_name": "Admin 1",
    },
}
USERS_BY_ID = {u["id"]: u for u in TEST_USERS.values()}


def _int_to_b64url(n: int) -> str:
    length = (n.bit_length() + 7) // 8
    return base64.urlsafe_b64encode(n.to_bytes(length, "big")).rstrip(b"=").decode("ascii")


def _render_vietnamese_png(text_lines: list[str], out_path: Path) -> None:
    img = Image.new("RGB", (900, 420), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    font = None
    for candidate in (
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\tahoma.ttf",
    ):
        if Path(candidate).exists():
            font = ImageFont.truetype(candidate, 40)
            break
    if font is None:
        font = ImageFont.load_default()
    y = 70
    for line in text_lines:
        draw.text((50, y), line, fill=(15, 23, 42), font=font)
        y += 68
    buf = BytesIO()
    img.save(buf, format="PNG")
    out_path.write_bytes(buf.getvalue())


def _create_local_supabase_auth_app(sync_db_url: str) -> FastAPI:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_numbers = private_key.public_key().public_numbers()
    kid = "viread-e2e-rsa-1"
    jwks_doc = {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "alg": "RS256",
                "kid": kid,
                "n": _int_to_b64url(public_numbers.n),
                "e": _int_to_b64url(public_numbers.e),
            }
        ]
    }
    revoked_tokens: set[str] = set()
    refresh_tokens: dict[str, str] = {}  # refresh_token -> user_id

    auth_app = FastAPI(title="ViRead Local Test Supabase Auth")
    auth_app.add_middleware(
        CORSMiddleware,
        allow_origins=[WEB_ORIGIN, "http://localhost:3010", "http://127.0.0.1:3000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def _issue_session(user: dict[str, Any]) -> dict[str, Any]:
        now = int(time.time())
        exp = now + 3600
        claims = {
            "aud": "authenticated",
            "exp": exp,
            "iat": now,
            "iss": f"http://127.0.0.1:{AUTH_PORT}/auth/v1",
            "sub": user["id"],
            "email": user["email"],
            "role": "authenticated",
            "aal": "aal1",
            "session_id": str(uuid4()),
            "user_metadata": {"display_name": user["display_name"]},
            "app_metadata": {"provider": "email", "providers": ["email"]},
        }
        access_token = jwt.encode(
            claims,
            private_key,
            algorithm="RS256",
            headers={"kid": kid, "typ": "JWT"},
        )
        refresh = f"e2e-refresh-{uuid4().hex}"
        refresh_tokens[refresh] = user["id"]
        user_obj = {
            "id": user["id"],
            "aud": "authenticated",
            "role": "authenticated",
            "email": user["email"],
            "email_confirmed_at": "2026-01-01T00:00:00Z",
            "app_metadata": {"provider": "email", "providers": ["email"]},
            "user_metadata": {"display_name": user["display_name"]},
            "identities": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        }
        return {
            "access_token": access_token,
            "token_type": "bearer",
            "expires_in": 3600,
            "expires_at": exp,
            "refresh_token": refresh,
            "user": user_obj,
        }

    def _verify_bearer(authorization: str | None) -> dict[str, Any]:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail={"code": "no_authorization", "msg": "Missing bearer token"})
        token = authorization.split(" ", 1)[1].strip()
        if token in revoked_tokens:
            raise HTTPException(status_code=401, detail={"code": "session_not_found", "msg": "Token revoked"})
        try:
            payload = jwt.decode(
                token,
                private_key.public_key(),
                algorithms=["RS256"],
                audience="authenticated",
            )
        except Exception:
            raise HTTPException(status_code=401, detail={"code": "bad_jwt", "msg": "Invalid JWT"}) from None
        uid = str(payload.get("sub") or "")
        user = USERS_BY_ID.get(uid)
        if not user:
            raise HTTPException(status_code=401, detail={"code": "user_not_found", "msg": "Unknown user"})
        return user

    @auth_app.get("/auth/v1/.well-known/jwks.json")
    async def jwks() -> dict[str, Any]:
        return jwks_doc

    @auth_app.get("/auth/v1/settings")
    async def settings() -> dict[str, Any]:
        return {"external": {"email": True}, "disable_signup": False}

    @auth_app.post("/auth/v1/token")
    async def token_endpoint(request: Request) -> dict[str, Any]:
        grant_type = request.query_params.get("grant_type", "password")
        body = await request.json()
        if grant_type == "password":
            email = str(body.get("email") or "").strip().lower()
            password = str(body.get("password") or "")
            user = TEST_USERS.get(email)
            if not user or user["password"] != password:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "invalid_credentials",
                        "error_code": "invalid_credentials",
                        "msg": "Invalid login credentials",
                    },
                )
            return _issue_session(user)
        if grant_type == "refresh_token":
            rt = str(body.get("refresh_token") or "")
            uid = refresh_tokens.get(rt)
            if not uid or uid not in USERS_BY_ID:
                raise HTTPException(
                    status_code=400,
                    detail={"code": "refresh_token_not_found", "msg": "Invalid refresh token"},
                )
            return _issue_session(USERS_BY_ID[uid])
        raise HTTPException(status_code=400, detail={"code": "unsupported_grant_type", "msg": "Unsupported grant"})

    @auth_app.get("/auth/v1/user")
    async def get_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        user = _verify_bearer(authorization)
        return {
            "id": user["id"],
            "aud": "authenticated",
            "role": "authenticated",
            "email": user["email"],
            "email_confirmed_at": "2026-01-01T00:00:00Z",
            "app_metadata": {"provider": "email", "providers": ["email"]},
            "user_metadata": {"display_name": user["display_name"]},
            "identities": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        }

    @auth_app.post("/auth/v1/logout")
    async def logout(authorization: str | None = Header(default=None)) -> Response:
        if authorization and authorization.lower().startswith("bearer "):
            revoked_tokens.add(authorization.split(" ", 1)[1].strip())
        return Response(status_code=204)

    @auth_app.get("/rest/v1/profiles")
    async def rest_profiles(
        request: Request,
        authorization: str | None = Header(default=None),
        accept: str | None = Header(default=None),
    ) -> Response:
        _verify_bearer(authorization)
        qs = parse_qs(str(request.url.query))
        id_filter = (qs.get("id") or [""])[0]
        target_id = id_filter.removeprefix("eq.").strip()
        rows: list[dict[str, Any]] = []
        conn = psycopg2.connect(sync_db_url)
        try:
            with conn.cursor() as cur:
                if target_id:
                    cur.execute(
                        "SELECT id::text, role, displayname FROM public.profiles WHERE id = %s::uuid AND active = 1",
                        (target_id,),
                    )
                else:
                    cur.execute("SELECT id::text, role, displayname FROM public.profiles WHERE active = 1")
                for rid, role, displayname in cur.fetchall():
                    rows.append({"id": rid, "role": role, "displayname": displayname})
        finally:
            conn.close()

        wants_object = bool(accept and "application/vnd.pgrst.object+json" in accept)
        if wants_object:
            if not rows:
                return Response(
                    content=json.dumps({"code": "PGRST116", "message": "0 rows"}),
                    status_code=406,
                    media_type="application/json",
                )
            return Response(content=json.dumps(rows[0]), status_code=200, media_type="application/json")
        return Response(content=json.dumps(rows), status_code=200, media_type="application/json")

    return auth_app


@dataclass
class E2EController:
    mode: str = "real_ollama"
    failed_once_ids: set[str] = field(default_factory=set)
    slow_delay_seconds: float = 0.0
    last_real_ollama_proof: dict[str, Any] | None = None
    stale_started_event: asyncio.Event | None = None


def main() -> None:
    fixture = DisposablePrivateBookDatabase()
    fixture.setup()
    print(f"[E2E] Disposable PostgreSQL DB ready: {fixture.db_name}", flush=True)
    print(f"[E2E] Isolated local Storage dir: {fixture.storage_dir}", flush=True)

    # Seed legacy catalog book page image in isolated storage so preview renders
    legacy_png_path = fixture.storage_dir / "viread-books" / "legacy-p1.png"
    legacy_png_path.parent.mkdir(parents=True, exist_ok=True)
    _render_vietnamese_png(["Chú mèo nhỏ đi học buổi sáng."], legacy_png_path)
    conn = psycopg2.connect(fixture.sync_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE public.bookpages SET imagepath = 'legacy-p1.png' WHERE id = %s::uuid",
                (str(LEGACY_CATALOG_PAGE_ID),),
            )
            conn.commit()
    finally:
        conn.close()

    # Generate crisp Vietnamese PNG fixtures for Playwright uploads
    assets_dir = fixture.storage_dir / "_e2e_assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    clean_png = assets_dir / "clean_page.png"
    flagged_png = assets_dir / "flagged_page.png"
    retry_png = assets_dir / "retry_page.png"
    replaced_png = assets_dir / "replaced_page.png"
    _render_vietnamese_png(
        ["Mèo con đi học buổi sáng cùng bạn bè vui vẻ."],
        clean_png,
    )
    _render_vietnamese_png(
        ["Câu chuyện khu rừng có bóng tối bí ẩn cần kiểm tra."],
        flagged_png,
    )
    _render_vietnamese_png(
        ["Chú chim nhỏ hót vang trên cành cây xanh mát."],
        retry_png,
    )
    _render_vietnamese_png(
        ["Bé Lan tưới hoa trong vườn nắng sớm ấm áp."],
        replaced_png,
    )

    # Configure environment BEFORE importing ViRead backend modules!
    os.environ["APP_ENVIRONMENT"] = "test"
    os.environ["DATABASE_URL"] = fixture.async_url
    os.environ["SUPABASE_URL"] = f"http://127.0.0.1:{AUTH_PORT}"
    os.environ["SUPABASE_KEY"] = "sb_publishable_local_e2e_key"
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "sb_secret_local_e2e_key"
    os.environ["VIREAD_LOCAL_STORAGE_DIR"] = str(fixture.storage_dir)
    os.environ["PARENT_BOOK_WORKER_POLL_SECONDS"] = "0.35"
    os.environ["VIREAD_PRIVATE_BOOK_ALLOW_CLOUD_AI"] = "false"
    os.environ["OCR_AI_OLLAMA_BASE_URL"] = os.getenv("OCR_AI_OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    os.environ["OCR_AI_OLLAMA_MODEL"] = os.getenv("OCR_AI_OLLAMA_MODEL", "qwen3-vl:4b-instruct-q4_K_M")

    # 1. Start local Supabase Auth server on background daemon thread
    auth_app = _create_local_supabase_auth_app(fixture.sync_url)
    auth_config = uvicorn.Config(auth_app, host="127.0.0.1", port=AUTH_PORT, log_level="warning")
    auth_server = uvicorn.Server(auth_config)
    auth_thread = threading.Thread(target=auth_server.run, daemon=True)
    auth_thread.start()
    time.sleep(0.8)
    print(f"[E2E] Local Test Supabase Auth running at http://127.0.0.1:{AUTH_PORT}", flush=True)

    # 2. Import real ViRead FastAPI modules bound to the disposable local PostgreSQL DB
    from app.api.router import api_router  # noqa: E402
    from app.database.session import AsyncSessionLocal  # noqa: E402
    from app.repositories.parent_private_book_repository import ParentPrivateBookRepository  # noqa: E402
    from app.services.ocr_ai.child_safety import (  # noqa: E402
        ChildSafetyError,
        build_private_book_child_safety_orchestrator,
    )
    from app.services.parent_private_book_pipeline import (  # noqa: E402
        PipelineHooks,
        process_submission_stages,
    )

    controller = E2EController()

    class _PassthroughProofreader:
        async def correct(self, text: str, *args: Any, **kwargs: Any) -> str:
            return text

    class _FlaggedMediumSafety:
        async def analyze(self, text_value: str) -> dict[str, Any]:
            excerpt = text_value[: min(60, len(text_value))]
            return {
                "target": "GRADE_1_TO_5",
                "status": "PROVISIONAL",
                "suitability": "REVIEW_REQUIRED",
                "findings": [
                    {
                        "finding_id": f"e2e-flag-{uuid4().hex[:6]}",
                        "category": "MILD_SCARY_THEME",
                        "content_type": "DESCRIPTION",
                        "severity": "MEDIUM",
                        "evidence_text": excerpt,
                        "explanation": "Nội dung có chi tiết bí ẩn cần Admin xem xét trước khi mở cho trẻ.",
                        "recommendation": "Gửi Admin xem xét đúng phiên bản này.",
                    }
                ],
                "provider_events": [
                    {
                        "provider": "ollama_local",
                        "model": "qwen3-vl:4b-instruct-q4_K_M",
                        "stage": "CHILD_SAFETY_SCANNING",
                        "chunk_id": 0,
                        "availability": True,
                        "error_code": None,
                        "duration_ms": 42,
                    }
                ],
            }

    class _FailOnceThenRealSafety:
        def __init__(self, sub_id: str) -> None:
            self.sub_id = sub_id

        async def analyze(self, text_value: str) -> dict[str, Any]:
            if self.sub_id not in controller.failed_once_ids:
                controller.failed_once_ids.add(self.sub_id)
                raise ChildSafetyError(
                    "Simulated transient Ollama timeout for E2E stage retry",
                    code="OLLAMA_TIMEOUT",
                    provider_events=[
                        {
                            "provider": "ollama_local",
                            "model": "qwen3-vl:4b-instruct-q4_K_M",
                            "stage": "CHILD_SAFETY_SCANNING",
                            "chunk_id": 0,
                            "availability": False,
                            "error_code": "OLLAMA_TIMEOUT",
                            "duration_ms": 120,
                        }
                    ],
                )
            real_orch = build_private_book_child_safety_orchestrator()
            return await real_orch.analyze(text_value)

    class _SlowSafety:
        async def analyze(self, text_value: str) -> dict[str, Any]:
            if controller.stale_started_event is not None:
                controller.stale_started_event.set()
            await asyncio.sleep(controller.slow_delay_seconds or 2.5)
            return {
                "target": "GRADE_1_TO_5",
                "status": "PROVISIONAL",
                "suitability": "SUITABLE",
                "findings": [],
                "provider_events": [
                    {
                        "provider": "ollama_local",
                        "model": "qwen3-vl:4b-instruct-q4_K_M",
                        "stage": "CHILD_SAFETY_SCANNING",
                        "chunk_id": 0,
                        "availability": True,
                        "error_code": None,
                        "duration_ms": 2500,
                    }
                ],
            }

    def _run_real_tesseract_ocr(image_bytes: bytes) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
        """Run real Tesseract Vietnamese OCR with word bounding boxes on uploaded image."""
        import pytesseract

        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        w, h = img.size
        data = pytesseract.image_to_data(img, lang="vie", output_type=pytesseract.Output.DICT)
        words: list[dict[str, Any]] = []
        tokens: list[str] = []
        for idx in range(len(data["text"])):
            tok = (data["text"][idx] or "").strip()
            if not tok:
                continue
            left = max(0.0, min(1.0, data["left"][idx] / max(1, w)))
            top = max(0.0, min(1.0, data["top"][idx] / max(1, h)))
            bw = max(0.01, min(1.0 - left, data["width"][idx] / max(1, w)))
            bh = max(0.01, min(1.0 - top, data["height"][idx] / max(1, h)))
            try:
                conf = float(data["conf"][idx]) / 100.0
                if conf < 0:
                    conf = None
            except Exception:
                conf = None
            words.append(
                {
                    "word_index": len(words),
                    "line_index": int(data["line_num"][idx] or 0),
                    "text": tok,
                    "bounding_box": [round(left, 4), round(top, 4), round(bw, 4), round(bh, 4)],
                    "ocr_confidence": conf,
                }
            )
            tokens.append(tok)
        return " ".join(tokens).strip(), words, {"engine": "tesseract_vie_local"}

    async def _e2e_worker_loop(stop_event: asyncio.Event) -> None:
        worker_name = f"e2e-ppb-worker-{uuid4().hex[:6]}"
        while not stop_event.is_set():
            did_work = False
            try:
                async with AsyncSessionLocal() as db:
                    repo = ParentPrivateBookRepository(db)
                    claimed = await repo.claim_next_checking_submission(worker_name)
                    sub_id = claimed.Id if claimed is not None else None
                if sub_id is not None:
                    did_work = True
                    mode = controller.mode
                    if mode == "flagged_medium":
                        hooks = PipelineHooks(
                            ocr_fn=_run_real_tesseract_ocr,
                            proofread_orchestrator_factory=_PassthroughProofreader,
                            safety_orchestrator_factory=_FlaggedMediumSafety,
                        )
                    elif mode == "fail_tool_check_once":
                        hooks = PipelineHooks(
                            ocr_fn=_run_real_tesseract_ocr,
                            proofread_orchestrator_factory=_PassthroughProofreader,
                            safety_orchestrator_factory=lambda sid=str(sub_id): _FailOnceThenRealSafety(sid),
                        )
                    elif mode == "slow_then_stale":
                        hooks = PipelineHooks(
                            ocr_fn=_run_real_tesseract_ocr,
                            proofread_orchestrator_factory=_PassthroughProofreader,
                            safety_orchestrator_factory=_SlowSafety,
                        )
                    else:
                        hooks = PipelineHooks(
                            ocr_fn=_run_real_tesseract_ocr,
                            proofread_orchestrator_factory=_PassthroughProofreader,
                            safety_orchestrator_factory=build_private_book_child_safety_orchestrator,
                        )
                    async with AsyncSessionLocal() as db:
                        result = await process_submission_stages(db, sub_id, hooks=hooks)
                        if result is not None and mode in ("real_ollama", "fail_tool_check_once"):
                            events = list(result.ToolCheckProviderEventsJson or [])
                            if result.ToolCheckWorkflowId and events:
                                controller.last_real_ollama_proof = {
                                    "submission_id": str(result.Id),
                                    "tool_check_workflow_id": str(result.ToolCheckWorkflowId),
                                    "tool_check_suitability": result.ToolCheckSuitability,
                                    "workflow_status": result.WorkflowStatus,
                                    "provider_events": events,
                                }
                                print(
                                    f"[E2E_REAL_OLLAMA_PROOF] workflow_id={result.ToolCheckWorkflowId} "
                                    f"status={result.WorkflowStatus} events={events}",
                                    flush=True,
                                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[E2E_WORKER_ERROR] {exc!r}", flush=True)
            if not did_work:
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=0.3)
                except TimeoutError:
                    pass

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        stop_event = asyncio.Event()
        controller.stale_started_event = asyncio.Event()
        task = asyncio.create_task(_e2e_worker_loop(stop_event))
        try:
            yield
        finally:
            stop_event.set()
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    api_app = FastAPI(title="ViRead E2E Backend", lifespan=lifespan)
    api_app.add_middleware(
        CORSMiddleware,
        allow_origins=[WEB_ORIGIN, "http://localhost:3010", "http://127.0.0.1:3000"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    api_app.include_router(api_router)

    @api_app.get("/_e2e/health")
    async def e2e_health() -> dict[str, Any]:
        return {
            "status": "ok",
            "mode": controller.mode,
            "db_name": fixture.db_name,
            "last_real_ollama_proof": controller.last_real_ollama_proof,
        }

    @api_app.post("/_e2e/mode")
    async def e2e_set_mode(request: Request) -> dict[str, Any]:
        body = await request.json()
        next_mode = str(body.get("mode") or "real_ollama")
        if next_mode not in ("real_ollama", "flagged_medium", "fail_tool_check_once", "slow_then_stale"):
            raise HTTPException(status_code=400, detail="Unsupported E2E mode")
        controller.mode = next_mode
        if "slow_delay_seconds" in body:
            controller.slow_delay_seconds = float(body["slow_delay_seconds"])
        if body.get("reset_fail_once"):
            controller.failed_once_ids.clear()
        if controller.stale_started_event is not None:
            controller.stale_started_event.clear()
        return {"mode": controller.mode}

    @api_app.get("/_e2e/wait-slow-started")
    async def e2e_wait_slow_started(timeout: float = 10.0) -> dict[str, Any]:
        assert controller.stale_started_event is not None
        try:
            await asyncio.wait_for(controller.stale_started_event.wait(), timeout=timeout)
            return {"started": True}
        except TimeoutError:
            return {"started": False}

    stack_info = {
        "auth_url": f"http://127.0.0.1:{AUTH_PORT}",
        "api_url": f"http://127.0.0.1:{API_PORT}",
        "web_origin": WEB_ORIGIN,
        "db_name": fixture.db_name,
        "users": {
            "parent_a": {**TEST_USERS["parent-a@viread.test"], "child_id": str(CHILD_A), "child_alias": "Bé An"},
            "parent_b": {**TEST_USERS["parent-b@viread.test"], "child_id": str(CHILD_B), "child_alias": "Bé Bình"},
            "admin": TEST_USERS["admin@viread.test"],
        },
        "legacy_catalog_book_id": str(LEGACY_CATALOG_BOOK_ADMIN_CREATED),
        "assets": {
            "clean_png": str(clean_png),
            "flagged_png": str(flagged_png),
            "retry_png": str(retry_png),
            "replaced_png": str(replaced_png),
        },
    }
    STACK_INFO_PATH.write_text(json.dumps(stack_info, indent=2), encoding="utf-8")
    print(f"[E2E] Stack info written to {STACK_INFO_PATH}", flush=True)

    def _cleanup(*_args: Any) -> None:
        print("[E2E] Shutting down and cleaning disposable DB & storage...", flush=True)
        auth_server.should_exit = True
        try:
            fixture.teardown()
        except Exception as exc:
            print(f"[E2E] Teardown warning: {exc!r}", flush=True)

    signal.signal(signal.SIGINT, _cleanup)
    signal.signal(signal.SIGTERM, _cleanup)

    try:
        uvicorn.run(api_app, host="127.0.0.1", port=API_PORT, log_level="warning")
    finally:
        _cleanup()


if __name__ == "__main__":
    main()
