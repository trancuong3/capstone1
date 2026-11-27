from __future__ import annotations

import asyncio
import io
import json
import os
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.system import AdminSystemService, router as system_router
from app.jobs import book_quality_worker
from app.schemas.book_assets import (
    BookCoverGenerateRequest,
    BookStyleBibleRead,
    PageIllustrationGenerateRequest,
    StyleBibleContentRead,
)
from app.schemas.book_content_quality import BookQualityFindingRead
from app.services import cron_dispatch_service as cron_svc
from app.services.admin_ocr_local import LocalCorrectionError
from app.services.ai_capability_router import (
    ImageGenerationResult,
    build_default_provider_registry,
)
from app.services.book_cover_service import (
    BookCoverService,
    detect_image_generation_provider,
)
from app.services.book_illustration_service import BookIllustrationService
from app.services.book_quality_cloud import analyse_with_cloud_ai
from app.services.ocr_ai.child_safety import ChildSafetyError, ChildSafetyOrchestrator
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrConfigurationError
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator
from app.services.picture_description_ai import get_picture_ai_config


def _make_png_bytes(width: int = 320, height: int = 240) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(110, 180, 220)).save(buf, format="PNG")
    return buf.getvalue()


class RenderBlueprintAndConfigTests(unittest.TestCase):
    def test_render_yaml_has_cloud_ai_and_cloudflare_flags(self) -> None:
        render_yaml = Path(__file__).resolve().parents[1] / "render.yaml"
        content = render_yaml.read_text(encoding="utf-8")
        for expected in (
            'key: OCR_CLOUD_CORRECTION_ENABLED',
            'value: "true"',
            'key: PRIVATE_BOOK_ALLOW_CLOUD_AI',
            'key: LOCAL_OCR_ENABLED',
            'value: "false"',
            'key: PICTURE_DESC_OLLAMA_ENABLED',
            'key: GEMINI_IMAGE_BILLING_ENABLED',
            'key: CLOUDFLARE_ACCOUNT_ID',
            'key: CLOUDFLARE_API_TOKEN',
        ):
            self.assertIn(expected, content)

    def test_config_auto_enables_cloud_on_render_unless_explicitly_false(self) -> None:
        base_env = {
            "RENDER": "true",
            "VIREAD_OCR_MODE": "remote_worker",
            "LOCAL_OCR_ENABLED": "",
            "OCR_CLOUD_CORRECTION_ENABLED": "",
            "PRIVATE_BOOK_ALLOW_CLOUD_AI": "",
            "GEMINI_API_KEY": "test-gemini-key",
            "GROQ_API_KEY": "",
        }
        with patch.dict(os.environ, base_env, clear=False):
            cfg = OcrCorrectionConfig.from_environment()
            self.assertFalse(cfg.local_enabled)
            self.assertTrue(cfg.cloud_enabled)
            self.assertTrue(cfg.gemini_enabled)
            self.assertTrue(OcrCorrectionConfig.private_book_allow_cloud_ai())

        explicit_off = {**base_env, "OCR_CLOUD_CORRECTION_ENABLED": "false"}
        with patch.dict(os.environ, explicit_off, clear=False):
            cfg_off = OcrCorrectionConfig.from_environment()
            self.assertFalse(cfg_off.local_enabled)
            self.assertFalse(cfg_off.cloud_enabled)
            self.assertFalse(OcrCorrectionConfig.private_book_allow_cloud_ai())

        local_env = {
            **base_env,
            "RENDER": "",
            "VIREAD_OCR_MODE": "",
            "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "",
            "LOCAL_OCR_ENABLED": "",
        }
        with patch.dict(os.environ, local_env, clear=False):
            cfg_local = OcrCorrectionConfig.from_environment()
            self.assertTrue(cfg_local.local_enabled)
            self.assertFalse(cfg_local.cloud_enabled)
            self.assertFalse(OcrCorrectionConfig.private_book_allow_cloud_ai())

    def test_orchestrators_do_not_force_ollama_when_local_disabled_and_no_cloud(self) -> None:
        cfg = OcrCorrectionConfig(cloud_enabled=False, local_enabled=False)
        orch = OcrCorrectionOrchestrator(cfg)
        safety = ChildSafetyOrchestrator(cfg)
        self.assertEqual(orch.providers, ())
        self.assertEqual(safety.providers, [])
        with self.assertRaises(OcrConfigurationError) as proof_err:
            asyncio.run(orch.correct("Xin chào", _make_png_bytes(), [(0.1, 0.1, 0.2, 0.1), (0.4, 0.1, 0.2, 0.1)]))
        self.assertEqual(proof_err.exception.code, "NO_AI_PROVIDER_CONFIGURED")
        with self.assertRaises(ChildSafetyError) as safety_err:
            asyncio.run(safety.analyze("Xin chào"))
        self.assertEqual(safety_err.exception.code, "NO_AI_PROVIDER_CONFIGURED")

    def test_picture_description_defaults_ollama_to_local_ollama_enabled(self) -> None:
        with patch.dict(
            os.environ,
            {
                "RENDER": "true",
                "VIREAD_OCR_MODE": "remote_worker",
                "LOCAL_OCR_ENABLED": "",
                "PICTURE_DESC_OLLAMA_ENABLED": "",
            },
            clear=False,
        ):
            self.assertFalse(get_picture_ai_config().ollama_enabled)

        with patch.dict(
            os.environ,
            {
                "RENDER": "true",
                "VIREAD_OCR_MODE": "remote_worker",
                "LOCAL_OCR_ENABLED": "",
                "PICTURE_DESC_OLLAMA_ENABLED": "true",
            },
            clear=False,
        ):
            self.assertTrue(get_picture_ai_config().ollama_enabled)

    def test_ai_capability_router_respects_local_ollama_and_cloud_auto_enable(self) -> None:
        render_env = {
            "RENDER": "true",
            "VIREAD_OCR_MODE": "remote_worker",
            "GEMINI_API_KEY": "g-key",
            "GROQ_API_KEY": "q-key",
        }
        specs = {s.provider_id: s for s in build_default_provider_registry(env=render_env)}
        self.assertFalse(specs["ollama_local"].enabled)
        self.assertTrue(specs["gemini_primary"].enabled)
        self.assertTrue(specs["groq_qwen"].enabled)


class CloudBookQualityTests(unittest.IsolatedAsyncioTestCase):
    async def test_analyse_with_cloud_ai_falls_back_gemini_to_groq_and_validates_spans(self) -> None:
        seen_urls: list[str] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            seen_urls.append(str(request.url))
            if "generativelanguage.googleapis.com" in str(request.url):
                return httpx.Response(429, json={"error": {"message": "quota"}})
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "findings": [
                                            {
                                                "excerpt": "trời mua",
                                                "issue_type": "SPELLING_SUSPECTED",
                                                "severity": "MEDIUM",
                                                "explanation": "Nghi thiếu dấu thanh.",
                                                "suggested_correction": "trời mưa",
                                                "confidence": 0.88,
                                            },
                                            {
                                                "excerpt": "không tồn tại",
                                                "issue_type": "OCR_SUSPECTED",
                                                "severity": "LOW",
                                                "explanation": "Bị từ chối vì không có trong nguồn.",
                                                "suggested_correction": None,
                                                "confidence": 0.4,
                                            },
                                        ]
                                    },
                                    ensure_ascii=False,
                                )
                            }
                        }
                    ]
                },
            )

        cfg = OcrCorrectionConfig(
            cloud_enabled=True,
            gemini_api_key="gem-key",
            groq_api_key="groq-key",
            local_enabled=False,
        )
        source = "Hôm nay trời mua rất to."
        result = await analyse_with_cloud_ai(
            source,
            page_number=4,
            config=cfg,
            transport=httpx.MockTransport(handler),
        )
        # 429 on Gemini primary disables google family and routes directly to Groq
        self.assertEqual(len(seen_urls), 2)
        self.assertIn("api.groq.com", seen_urls[1])
        self.assertEqual(result.rejected_excerpt_count, 1)
        self.assertEqual(len(result.findings), 1)
        finding = result.findings[0]
        self.assertEqual(finding.issue_type, "SPELLING_SUSPECTED")
        self.assertEqual(
            source[finding.excerpt_start:finding.excerpt_end],
            "trời mua",
        )
        self.assertEqual(finding.suggested_correction, "trời mưa")

    async def test_analyse_with_cloud_ai_raises_502_on_invalid_json(self) -> None:
        async def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "not-valid-json"}}]},
            )

        cfg = OcrCorrectionConfig(
            cloud_enabled=True,
            groq_api_key="groq-key",
            local_enabled=False,
        )
        with self.assertRaises(LocalCorrectionError) as caught:
            await analyse_with_cloud_ai(
                "Bé đi học.",
                page_number=1,
                config=cfg,
                transport=httpx.MockTransport(handler),
            )
        self.assertEqual(caught.exception.status_code, 502)

    async def test_worker_uses_cloud_ai_and_writes_cloud_error_codes(self) -> None:
        page_scan_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        text_snapshot = "Hôm nay trời mua rất to."
        content_hash = "abc123"

        def _make_objects():
            page_scan = SimpleNamespace(
                Id=page_scan_id,
                ScanRunId=uuid4(),
                BookId=book_id,
                PageId=page_id,
                PageNumberSnapshot=1,
                PageLifecycleSnapshot="ACTIVE",
                PageRevisionId=rev_id,
                ContentHash=content_hash,
                VerifiedTextSnapshot=text_snapshot,
                Status="QUEUED",
                RuleCheckStatus="COMPLETED",
                AIAnalysisStatus="PENDING",
                RejectedAIFindingCount=0,
                AttemptCount=0,
                ErrorCode=None,
                ErrorSummary=None,
                StartedAt=None,
                CompletedAt=None,
            )
            page = SimpleNamespace(
                Id=page_id,
                LifecycleStatus="ACTIVE",
                CurrentVerifiedRevisionId=rev_id,
            )
            revision = SimpleNamespace(
                Id=rev_id,
                PageId=page_id,
                VerificationStatus="VERIFIED",
                ContentHash=content_hash,
                VerifiedText=text_snapshot,
            )
            return page_scan, page, revision

        # 1) Cloud AI succeeds -> DetectionSource="CLOUD_AI" and valid Pydantic DTO
        page_scan, page, revision = _make_objects()
        created_rows: list = []

        class _FakeRepo:
            def __init__(self, _session):
                pass

            async def scan_page_context(self, _id):
                return page_scan, page, revision

            async def create_findings(self, rows):
                created_rows.extend(rows)
                return [r.Id for r in rows]

            async def link_findings_to_reports(self, **_kwargs):
                return None

        class _FakeSession:
            async def execute(self, *_args, **_kwargs):
                return None

            async def commit(self):
                return None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

        from app.services.book_quality_ollama import OllamaAnalysisResult, OllamaFindingEvidence

        cloud_res = OllamaAnalysisResult(
            findings=(
                OllamaFindingEvidence(
                    issue_type="SPELLING_SUSPECTED",
                    severity="MEDIUM",
                    excerpt="trời mua",
                    excerpt_start=8,
                    excerpt_end=16,
                    explanation="Nghi thiếu dấu.",
                    suggested_correction="trời mưa",
                    confidence=0.9,
                    model_name="gemini-3.5-flash-lite",
                ),
            ),
            model_name="gemini-3.5-flash-lite",
            rejected_excerpt_count=0,
        )
        render_cfg = OcrCorrectionConfig(
            cloud_enabled=True,
            gemini_api_key="gem-key",
            local_enabled=False,
        )
        with (
            patch.object(book_quality_worker, "AsyncSessionLocal", return_value=_FakeSession()),
            patch.object(book_quality_worker, "BookContentQualityRepository", _FakeRepo),
            patch("app.services.ocr_ai.config.OcrCorrectionConfig.from_environment", return_value=render_cfg),
            patch.object(book_quality_worker, "analyse_with_cloud_ai", AsyncMock(return_value=cloud_res)),
        ):
            await book_quality_worker._process_page_scan(page_scan_id)

        self.assertEqual(page_scan.AIAnalysisStatus, "COMPLETED")
        self.assertEqual(len(created_rows), 1)
        self.assertEqual(created_rows[0].DetectionSource, "CLOUD_AI")
        self.assertEqual(created_rows[0].IssueType, "SPELLING_SUSPECTED")
        dto = BookQualityFindingRead(
            id=created_rows[0].Id,
            page_scan_id=page_scan.Id,
            book_id=book_id,
            page_id=page_id,
            page_number=1,
            page_revision_id=rev_id,
            issue_type=created_rows[0].IssueType,
            severity=created_rows[0].Severity,
            original_excerpt=created_rows[0].OriginalExcerpt,
            excerpt_start=created_rows[0].ExcerptStart,
            excerpt_end=created_rows[0].ExcerptEnd,
            suggested_correction=created_rows[0].SuggestedCorrection,
            explanation=created_rows[0].Explanation,
            detection_source=created_rows[0].DetectionSource,
            model_name=created_rows[0].ModelName,
            confidence=created_rows[0].Confidence,
            status="NEEDS_REVIEW",
            review_note=None,
            created_at=datetime.now(timezone.utc),
        )
        self.assertEqual(dto.detection_source, "CLOUD_AI")

        # 2) Cloud AI 503 -> CLOUD_AI_UNAVAILABLE; 502 -> CLOUD_AI_INVALID_RESPONSE
        for code, expected_err, expected_ai_status in (
            (503, "CLOUD_AI_UNAVAILABLE", "UNAVAILABLE"),
            (502, "CLOUD_AI_INVALID_RESPONSE", "FAILED"),
        ):
            page_scan, page, revision = _make_objects()
            with (
                patch.object(book_quality_worker, "AsyncSessionLocal", return_value=_FakeSession()),
                patch.object(book_quality_worker, "BookContentQualityRepository", _FakeRepo),
                patch("app.services.ocr_ai.config.OcrCorrectionConfig.from_environment", return_value=render_cfg),
                patch.object(
                    book_quality_worker,
                    "analyse_with_cloud_ai",
                    AsyncMock(side_effect=LocalCorrectionError(code, "cloud err")),
                ),
            ):
                await book_quality_worker._process_page_scan(page_scan_id)
            self.assertEqual(page_scan.ErrorCode, expected_err)
            self.assertEqual(page_scan.AIAnalysisStatus, expected_ai_status)


class ImageRouterAndHealthAndCronTests(unittest.IsolatedAsyncioTestCase):
    async def test_image_provider_detection_and_router_dispatch(self) -> None:
        with patch.dict(
            os.environ,
            {
                "SMART_AI_IMAGE_GEN_ENABLED": "true",
                "CLOUDFLARE_ACCOUNT_ID": "",
                "CLOUDFLARE_API_TOKEN": "",
                "GEMINI_IMAGE_BILLING_ENABLED": "true",
                "GEMINI_API_KEY": "gem-key",
                "LOCAL_IMAGE_GEN_URL": "",
                "RENDER": "true",
                "OCR_CLOUD_CORRECTION_ENABLED": "true",
                "PRIVATE_BOOK_ALLOW_CLOUD_AI": "",
            },
            clear=False,
        ):
            priv = detect_image_generation_provider(is_private_book=True)
            self.assertTrue(priv.available)
            self.assertEqual(priv.provider_name, "gemini_image")

        # BookCoverService dispatches via AiCapabilityRouter.generate_image when no custom transport
        book_id = uuid4()
        actor_id = uuid4()
        fake_book = SimpleNamespace(
            Id=book_id,
            Title="Mèo con",
            Author="An",
            MinGrade=1,
            MaxGrade=2,
            VisibilityScope="CATALOG",
            OwnerParentId=None,
            LifecycleStatus="ACTIVE",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
        fake_db = SimpleNamespace(
            commit=AsyncMock(),
            rollback=AsyncMock(),
        )
        style_bible_dto = BookStyleBibleRead(
            book_id=book_id,
            context_hash="ctx",
            cache_hit=True,
            bible=StyleBibleContentRead(
                genre="Truyện thiếu nhi",
                age_group="6-10 tuổi",
                art_style="Watercolor",
                prompt_prefix="Cute watercolor",
            ),
            provider_name="local_deterministic",
            model_id="deterministic",
            updated_at=datetime.now(timezone.utc),
        )
        svc = BookCoverService(fake_db)  # type: ignore[arg-type]
        svc.authorize_book_write = AsyncMock(return_value=(fake_book, "admin"))  # type: ignore[method-assign]
        svc.style_bible_service.get_or_build_for_book = AsyncMock(  # type: ignore[method-assign]
            return_value=style_bible_dto
        )
        svc.repo = SimpleNamespace(
            has_active_user_uploaded_cover=AsyncMock(return_value=False),
            record_studio_job=AsyncMock(return_value=None),
        )  # type: ignore[assignment]
        fake_asset = SimpleNamespace(
            Id=uuid4(),
            BookId=book_id,
            BookPageId=None,
            SourceRevisionId=None,
            AssetRole="COVER",
            SourceType="AI_GENERATED",
            MimeType="image/webp",
            Width=768,
            Height=1024,
            SizeBytes=1200,
            AssetHash="hash",
            AssetVersion=1,
            IsActive=True,
            TextFreeVerified=True,
            ModerationStatus="APPROVED",
            ProviderName="cloudflare_flux",
            ModelId="@cf/black-forest-labs/flux-1-schnell",
            JobId=None,
            MetadataJson={},
            CreatedAt=datetime.now(timezone.utc),
            UpdatedAt=datetime.now(timezone.utc),
            StoragePath="studio/covers/catalog/x.webp",
        )
        svc.commit_generated_cover_bytes = AsyncMock(return_value=(fake_asset, False))  # type: ignore[method-assign]

        router_mock = MagicMock()
        router_mock.eligible_providers.return_value = [object()]
        router_mock.generate_image = AsyncMock(
            return_value=ImageGenerationResult(
                image_bytes=_make_png_bytes(600, 800),
                mime_type="image/png",
                provider_id="cloudflare_flux",
                model_id="@cf/black-forest-labs/flux-1-schnell",
                width=768,
                height=1024,
                latency_ms=42,
            )
        )
        with (
            patch.dict(
                os.environ,
                {
                    "SMART_AI_IMAGE_GEN_ENABLED": "true",
                    "CLOUDFLARE_ACCOUNT_ID": "cf-acc",
                    "CLOUDFLARE_API_TOKEN": "cf-tok",
                },
                clear=False,
            ),
            patch("app.services.ai_capability_router.get_default_ai_router", return_value=router_mock),
        ):
            res = await svc.generate_ai_cover(
                actor_id, book_id, BookCoverGenerateRequest(prompt_hint="Nắng mai")
            )
        self.assertEqual(res.status, "SUCCEEDED")
        router_mock.generate_image.assert_awaited_once()

        # BookIllustrationService also dispatches via AiCapabilityRouter.generate_image
        page_id = uuid4()
        rev_id = uuid4()
        fake_page = SimpleNamespace(Id=page_id, CurrentVerifiedRevisionId=rev_id)
        ill_svc = BookIllustrationService(fake_db)  # type: ignore[arg-type]
        ill_svc.cover_service.authorize_book_write = AsyncMock(return_value=(fake_book, "admin"))  # type: ignore[method-assign]
        ill_svc.style_bible_service.get_or_build_for_book = AsyncMock(  # type: ignore[method-assign]
            return_value=SimpleNamespace(
                context_hash="ctx",
                bible=SimpleNamespace(prompt_prefix="Cute watercolor"),
            )
        )
        ill_svc.repo = SimpleNamespace(
            get_page=AsyncMock(return_value=fake_page),
            get_page_revision_context=AsyncMock(return_value=(rev_id, "Mèo con ngủ", [])),
            record_studio_job=AsyncMock(return_value=None),
            create_page_illustration_asset=AsyncMock(return_value=fake_asset),
        )  # type: ignore[assignment]
        with (
            patch.dict(
                os.environ,
                {
                    "SMART_AI_IMAGE_GEN_ENABLED": "true",
                    "CLOUDFLARE_ACCOUNT_ID": "cf-acc",
                    "CLOUDFLARE_API_TOKEN": "cf-tok",
                },
                clear=False,
            ),
            patch("app.services.ai_capability_router.get_default_ai_router", return_value=router_mock),
            patch("app.services.book_illustration_service.upload_object"),
        ):
            ill_res = await ill_svc.generate_page_illustration(
                actor_id, book_id, page_id, PageIllustrationGenerateRequest()
            )
        self.assertEqual(ill_res.status, "SUCCEEDED")
        self.assertEqual(router_mock.generate_image.await_count, 2)

    async def test_health_local_ocr_label_uses_cloud_ai_and_difficult_word_forwards_policy(self) -> None:
        repo = AsyncMock()
        repo.probe_database.return_value = True
        voice = AsyncMock()
        voice.get_status.return_value = {
            "local": {"configured": False, "available": False, "stt_ready": False, "tts_ready": False},
            "google": {"stt_configured": False, "tts_configured": True},
        }
        cloud_env = {
            "RENDER": "true",
            "VIREAD_OCR_MODE": "remote_worker",
            "OCR_CLOUD_CORRECTION_ENABLED": "true",
            "GEMINI_API_KEY": "gem-key",
            "LOCAL_OCR_ENABLED": "",
        }
        with (
            patch.dict(os.environ, cloud_env, clear=False),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value={
                "id": "storage", "label": "Supabase Storage", "status": "HEALTHY",
                "detail_status": "healthy", "safe_message": "ok",
            })),
        ):
            health = await AdminSystemService(repo, voice).health()
        local_item = next(item for item in health.services if item.id == "local_ocr")
        self.assertEqual(local_item.execution_mode, "cloud_ai")
        self.assertEqual(local_item.label, "AI OCR đám mây")

        # Difficult words evaluate route parses provider_mode & allow_google_stt into VoicePolicyContext
        app = FastAPI()
        app.include_router(system_router, prefix="/system")
        actor_id = uuid4()
        child_id = uuid4()
        app.dependency_overrides[get_current_parent_id] = lambda: actor_id
        app.dependency_overrides[get_db] = lambda: SimpleNamespace()
        captured: dict[str, object] = {}

        class _FakeDifficultSvc:
            async def evaluate_word_direct(self, cid, aid, **kwargs):
                captured["cid"] = cid
                captured["aid"] = aid
                captured.update(kwargs)
                return {
                    "attempt_id": str(uuid4()),
                    "child_id": str(cid),
                    "normalized_word": "mèo",
                    "display_text": "mèo",
                    "attempt_number": 1,
                    "state": "COMPLETED",
                    "assessment_status": "CORRECT",
                    "recognition_source": "SERVER_STT",
                    "spoken_transcript": "mèo",
                    "confidence": 0.95,
                    "audio_duration_ms": 400,
                    "assessment_version": 1,
                    "evidence_word_ids": [],
                    "started_at": datetime.now(timezone.utc).isoformat(),
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "feedback_message": "Giỏi lắm",
                    "word_progress": {
                        "normalized_word": "mèo",
                        "practice_status": "IN_PROGRESS",
                        "practice_attempts_count": 1,
                        "practice_correct_count": 1,
                        "practice_incorrect_count": 0,
                        "practice_uncertain_count": 0,
                        "consecutive_correct_count": 1,
                        "required_consecutive_correct": 2,
                        "last_practiced_at": datetime.now(timezone.utc).isoformat(),
                    },
                    "next_recommended_word": None,
                    "evidence_count_unchanged": True,
                }

        with (
            patch("app.api.routes.system._difficult_words_service", return_value=_FakeDifficultSvc()),
            TestClient(app) as client,
        ):
            resp = client.post(
                f"/system/difficult-words/{child_id}/practice/evaluate",
                data={
                    "request_id": str(uuid4()),
                    "normalized_word": "mèo",
                    "browser_transcript": "mèo",
                    "browser_confidence": "0.95",
                    "provider_mode": "local_with_google_fallback",
                    "allow_google_stt": "true",
                },
            )
        self.assertEqual(resp.status_code, 200, resp.text)
        policy = captured.get("policy")
        self.assertIsNotNone(policy)
        self.assertEqual(policy.provider_mode, "local_with_google_fallback")  # type: ignore[union-attr]
        self.assertTrue(policy.allow_google_stt)  # type: ignore[union-attr]

    async def test_cron_sweep_notifies_smart_studio_worker_when_pending_jobs_exist(self) -> None:
        with (
            patch.object(cron_svc, "_sweep_ocr_leases_and_heartbeats", AsyncMock(return_value=(0, 0, 0))),
            patch.object(cron_svc, "reconcile_orphaned_parent_submissions", AsyncMock(return_value={"reclaimed_count": 0, "failed_count": 0})),
            patch.object(cron_svc, "_sweep_admin_ai_workflows", AsyncMock(return_value=0)),
            patch.object(cron_svc, "_sweep_book_quality_scans", AsyncMock(return_value=0)),
            patch.object(cron_svc, "_sweep_viread_ocr_outbox", AsyncMock(return_value=0)),
            patch.object(cron_svc, "_cleanup_expired_local_scans", AsyncMock(return_value=0)),
            patch.object(cron_svc, "maybe_keep_warm_hf_space_from_cron", AsyncMock(return_value=False)),
            patch.object(cron_svc, "_sweep_viread_ocr_training_maintenance", AsyncMock(return_value=(True, 0))),
            patch.object(cron_svc, "_persist_cron_heartbeat", AsyncMock()),
            patch.object(cron_svc, "_count_pending_smart_studio_jobs", AsyncMock(return_value=2)),
            patch("app.services.global_tasks_service.notify_smart_studio_worker") as notify_mock,
        ):
            res = await cron_svc.run_scheduled_cron_dispatch(
                run_remote_sweeps=True,
                reminders_runner=AsyncMock(return_value=0),
                alerts_runner=AsyncMock(return_value=0),
                temp_cleanup_runner=AsyncMock(return_value=0),
                parent_post_ocr_runner=AsyncMock(return_value=False),
            )
        self.assertTrue(res["ok"])
        notify_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
