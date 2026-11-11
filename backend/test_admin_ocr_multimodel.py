"""Mocked boundaries and orchestration tests for cloud-to-local OCR fallback."""
import json
import logging
import os
import tempfile
import unittest
from io import BytesIO, StringIO
from dotenv.main import DotEnv
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from PIL import Image

from app.database import config as database_config
from app.services.admin_ocr_chunking import ChunkingConfig, chunk_ocr_text
from app.services.admin_ocr_local import LocalOcrConfig
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import (
    OcrConfigurationError,
    OcrOrchestrationError,
    OcrProviderError,
)
from app.services.ocr_ai.gemini_provider import GeminiOcrProvider
from app.services.ocr_ai.groq_provider import GroqOcrProvider
from app.services.ocr_ai.ollama_provider import OllamaOcrProvider
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator
from app.services.ocr_ai.schemas import ChunkCorrectionResult
from app.services.ocr_ai.validators import validate_chunk_result


def _image() -> bytes:
    output = BytesIO()
    Image.new("RGB", (500, 300), "white").save(output, format="PNG")
    return output.getvalue()


def _boxes(count: int) -> list[tuple[float, float, float, float]]:
    return [(0.08 + index * 0.2, 0.15, 0.12, 0.08) for index in range(count)]


def _config(*, max_words: int = 10) -> OcrCorrectionConfig:
    return OcrCorrectionConfig(
        local=LocalOcrConfig(
            timeout_seconds=2,
            total_timeout_seconds=10,
            chunking=ChunkingConfig(
                max_bytes=100,
                max_words=max_words,
                max_chunks=10,
                context_bytes=20,
                max_document_bytes=1000,
            ),
        ),
        total_timeout_seconds=10,
    )


class _Provider:
    def __init__(self, name, calls, result=None, error=None, result_by_chunk=None):
        self.name = name
        self.family = "google" if name.startswith("gemini") else name
        self._calls = calls
        self._result = result
        self._error = error
        self._result_by_chunk = result_by_chunk

    async def correct_chunk(self, *, chunk, image_bytes, image_mime_type):
        self._calls.append(
            (
                self.name,
                chunk.chunk_id,
                image_mime_type,
                bool(image_bytes),
                tuple(token.text for token in chunk.tokens),
                chunk.target_text,
            )
        )
        if self._error is not None:
            raise self._error
        if self._result_by_chunk is not None:
            return self._result_by_chunk(chunk)
        return self._result or ChunkCorrectionResult(
            chunk.chunk_id,
            tuple(token.text for token in chunk.tokens),
            (),
        )


class OcrCorrectionConfigTests(unittest.TestCase):
    def _provider_chain(self, values):
        with (
            patch.dict(os.environ, values, clear=True),
            patch("app.services.ocr_ai.orchestrator.log_diagnostic"),
        ):
            config = OcrCorrectionConfig.from_environment()
            providers = OcrCorrectionOrchestrator(config).providers
        return [provider.name for provider in providers]

    def test_runtime_provider_chain_configuration_matrix(self):
        cases = (
            (
                {
                    "OCR_CLOUD_CORRECTION_ENABLED": "false",
                    "GEMINI_API_KEY": "gemini-test-key",
                    "GROQ_API_KEY": "groq-test-key",
                },
                ["ollama_qwen3_vl"],
            ),
            ({"OCR_CLOUD_CORRECTION_ENABLED": "true"}, ["ollama_qwen3_vl"]),
            (
                {
                    "OCR_CLOUD_CORRECTION_ENABLED": "true",
                    "GEMINI_API_KEY": "gemini-test-key",
                },
                ["gemini_3_5", "gemini_3_1", "ollama_qwen3_vl"],
            ),
            (
                {
                    "OCR_CLOUD_CORRECTION_ENABLED": "true",
                    "GROQ_API_KEY": "groq-test-key",
                },
                ["groq_qwen", "ollama_qwen3_vl"],
            ),
            (
                {
                    "OCR_CLOUD_CORRECTION_ENABLED": "true",
                    "GEMINI_API_KEY": "gemini-test-key",
                    "GROQ_API_KEY": "groq-test-key",
                },
                ["gemini_3_5", "gemini_3_1", "groq_qwen", "ollama_qwen3_vl"],
            ),
            (
                {
                    "GEMINI_API_KEY": "gemini-test-key",
                    "GROQ_API_KEY": "groq-test-key",
                },
                ["ollama_qwen3_vl"],
            ),
            (
                {
                    "OCR_CLOUD_CORRECTION_ENABLED": "true",
                    "GEMINI_API_KEY": "  \t",
                    "GROQ_API_KEY": "   ",
                },
                ["ollama_qwen3_vl"],
            ),
        )
        for values, expected in cases:
            with self.subTest(values=tuple(values)):
                self.assertEqual(self._provider_chain(values), expected)

    def test_invalid_cloud_flag_is_rejected(self):
        with patch.dict(
            os.environ, {"OCR_CLOUD_CORRECTION_ENABLED": "sometimes"}, clear=True
        ):
            with self.assertRaises(OcrConfigurationError):
                OcrCorrectionConfig.from_environment()

    def test_process_environment_overrides_dotenv_and_dotenv_values_load(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temporary_directory:
            root = Path(temporary_directory)
            backend_root = root / "backend"
            repository_root = root / "repository"
            workspace_root = root / "workspace"
            backend_root.mkdir()
            repository_root.mkdir()
            workspace_root.mkdir()
            # Exercise the real dotenv parser over explicit synthetic streams.
            # No .env file is created or read, including in isolated CI runs.
            fixtures = {
                backend_root / ".env": 'OCR_CLOUD_CORRECTION_ENABLED="true"\n',
                repository_root / ".env": 'GEMINI_API_KEY="dotenv-gemini"\nOCR_CLOUD_CORRECTION_ENABLED="false"\n',
                workspace_root / ".env": 'GROQ_API_KEY="dotenv-groq"\n',
            }
            def fixture_values(path):
                return DotEnv(dotenv_path=None, stream=StringIO(fixtures[path])).dict()
            with (
                patch.object(database_config, "BACKEND_ROOT", backend_root),
                patch.object(database_config, "REPOSITORY_ROOT", repository_root),
                patch.object(database_config, "WORKSPACE_ROOT", workspace_root),
                patch.object(Path, "is_file", lambda path: path in fixtures),
                patch.object(database_config, "dotenv_values", side_effect=fixture_values),
                patch.dict(os.environ, {}, clear=True),
            ):
                database_config._load_missing_dotenv_values()
                config = OcrCorrectionConfig.from_environment()
                self.assertTrue(config.cloud_enabled)
                self.assertTrue(config.gemini_enabled)
                self.assertTrue(config.groq_enabled)
                self.assertEqual(
                    [
                        provider.name
                        for provider in OcrCorrectionOrchestrator(config).providers
                    ],
                    ["gemini_3_5", "gemini_3_1", "groq_qwen", "ollama_qwen3_vl"],
                )

        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temporary_directory:
            backend_root = Path(temporary_directory) / "backend"
            backend_root.mkdir()
            fixtures = {backend_root / ".env": 'OCR_CLOUD_CORRECTION_ENABLED="true"\n'}
            with (
                patch.object(database_config, "BACKEND_ROOT", backend_root),
                patch.object(database_config, "REPOSITORY_ROOT", backend_root.parent / "none"),
                patch.object(database_config, "WORKSPACE_ROOT", backend_root.parent / "missing"),
                patch.object(Path, "is_file", lambda path: path in fixtures),
                patch.object(database_config, "dotenv_values", side_effect=fixture_values),
                patch.dict(
                    os.environ, {"OCR_CLOUD_CORRECTION_ENABLED": "false"}, clear=True
                ),
            ):
                database_config._load_missing_dotenv_values()
                self.assertFalse(OcrCorrectionConfig.from_environment().cloud_enabled)

    def test_configuration_is_read_again_after_environment_changes(self):
        with patch.dict(
            os.environ, {"OCR_CLOUD_CORRECTION_ENABLED": "false"}, clear=True
        ):
            before_restart = OcrCorrectionConfig.from_environment()
        with patch.dict(
            os.environ,
            {
                "OCR_CLOUD_CORRECTION_ENABLED": "true",
                "GEMINI_API_KEY": "gemini-test-key",
            },
            clear=True,
        ):
            after_restart = OcrCorrectionConfig.from_environment()
        self.assertFalse(before_restart.cloud_enabled)
        self.assertTrue(after_restart.gemini_enabled)
        self.assertNotIn("gemini-test-key", repr(after_restart))

    def test_cloud_is_optional_and_local_is_never_disabled_by_missing_keys(self):
        with patch.dict(
            os.environ,
            {
                "OCR_CLOUD_CORRECTION_ENABLED": "true",
                "GEMINI_API_KEY": "",
                "GROQ_API_KEY": "",
            },
            clear=False,
        ):
            config = OcrCorrectionConfig.from_environment()
        with self.assertLogs("app.services.ocr_ai.orchestrator", level=logging.WARNING) as logs:
            orchestrator = OcrCorrectionOrchestrator(config)
        self.assertFalse(config.gemini_enabled)
        self.assertFalse(config.groq_enabled)
        self.assertNotIn("GEMINI_API_KEY", repr(config))
        self.assertEqual(
            [provider.name for provider in orchestrator.providers],
            ["ollama_qwen3_vl"],
        )
        self.assertIn("MISSING_CREDENTIAL", "\n".join(logs.output))

    def test_cloud_flags_keys_models_and_timeouts_are_validated(self):
        with patch.dict(
            os.environ,
            {
                "OCR_CLOUD_CORRECTION_ENABLED": "true",
                "GEMINI_API_KEY": "new-gemini-secret",
                "GROQ_API_KEY": "new-groq-secret",
                "GEMINI_OCR_PRIMARY_MODEL": "gemini-3.5-flash-lite",
                "GEMINI_OCR_FALLBACK_MODEL": "gemini-3.1-flash-lite",
                "GROQ_OCR_MODEL": "qwen/qwen3.8-27b",
            },
            clear=False,
        ):
            config = OcrCorrectionConfig.from_environment()
        self.assertTrue(config.gemini_enabled)
        self.assertTrue(config.groq_enabled)
        self.assertNotIn("new-gemini-secret", repr(config))
        self.assertEqual(
            [provider.name for provider in OcrCorrectionOrchestrator(config).providers],
            ["gemini_3_5", "gemini_3_1", "groq_qwen", "ollama_qwen3_vl"],
        )
        with patch.dict(
            os.environ,
            {"GEMINI_OCR_PRIMARY_MODEL": "not a valid model id"},
            clear=False,
        ):
            with self.assertRaises(OcrConfigurationError):
                OcrCorrectionConfig.from_environment()
        with patch.dict(os.environ, {"OCR_CLOUD_TIMEOUT_SECONDS": "0"}, clear=False):
            with self.assertRaises(OcrConfigurationError):
                OcrCorrectionConfig.from_environment()


class ProviderHttpErrorClassificationTests(unittest.TestCase):
    def test_gemini_http_statuses_and_shared_credential_disablement(self):
        provider = GeminiOcrProvider(
            name="gemini_3_5",
            model="gemini-3.5-flash-lite",
            api_key="test-key",
            timeout_seconds=2,
        )
        cases = {
            400: ("PROVIDER_REJECTED", False),
            401: ("PROVIDER_AUTHENTICATION", True),
            403: ("PROVIDER_AUTHENTICATION", True),
            404: ("MODEL_UNAVAILABLE", False),
            429: ("PROVIDER_QUOTA", True),
            500: ("PROVIDER_UNAVAILABLE", True),
            503: ("PROVIDER_UNAVAILABLE", True),
        }
        for status_code, (code, disables_family) in cases.items():
            with self.subTest(status_code=status_code):
                error = provider._http_error(status_code)
                self.assertEqual(error.code, code)
                self.assertEqual(error.disables_family, disables_family)

    def test_groq_http_statuses_disable_only_invalid_credentials(self):
        provider = GroqOcrProvider(
            model="qwen/qwen3.8-27b",
            api_key="test-key",
            timeout_seconds=2,
        )
        cases = {
            400: ("PROVIDER_REJECTED", False),
            401: ("PROVIDER_AUTHENTICATION", True),
            403: ("PROVIDER_AUTHENTICATION", True),
            404: ("MODEL_UNAVAILABLE", False),
            429: ("PROVIDER_QUOTA", False),
            500: ("PROVIDER_UNAVAILABLE", False),
            503: ("PROVIDER_UNAVAILABLE", False),
        }
        for status_code, (code, disables_family) in cases.items():
            with self.subTest(status_code=status_code):
                error = provider._http_error(
                    httpx.Response(
                        status_code,
                        headers={"x-request-id": "req_test-123"},
                        json={
                            "error": {
                                "type": "invalid_request_error",
                                "code": "schema_rejected",
                                "message": "must never be logged",
                            }
                        },
                    )
                )
                self.assertEqual(error.code, code)
                self.assertEqual(error.disables_family, disables_family)
                self.assertEqual(error.upstream_status_code, status_code)
                self.assertEqual(error.upstream_error_type, "invalid_request_error")
                self.assertEqual(error.upstream_error_code, "schema_rejected")
                self.assertEqual(error.upstream_request_id, "req_test-123")


class CloudProviderBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_gemini_sends_image_text_schema_and_model_without_key_in_url(self):
        plan = chunk_ocr_text("ngay xua.", _config().local.chunking)
        seen = []

        async def handler(request):
            seen.append(request)
            body = json.loads(request.content)
            self.assertEqual(request.headers["x-goog-api-key"], "fresh-key")
            self.assertNotIn("fresh-key", str(request.url))
            self.assertEqual(
                request.url.path,
                "/v1beta/models/gemini-3.5-flash-lite:generateContent",
            )
            self.assertEqual(body["generationConfig"]["responseMimeType"], "application/json")
            self.assertEqual(
                body["generationConfig"]["responseJsonSchema"]["required"],
                ["chunk_id", "corrected_words", "uncertain_word_indices"],
            )
            self.assertIn("inline_data", body["contents"][0]["parts"][1])
            result = {
                "chunk_id": 0,
                "corrected_words": ["ngày", "xưa."],
                "uncertain_word_indices": [],
            }
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": json.dumps(result)}]}}]},
            )

        provider = GeminiOcrProvider(
            name="gemini_3_5",
            model="gemini-3.5-flash-lite",
            api_key="fresh-key",
            timeout_seconds=2,
            transport=httpx.MockTransport(handler),
        )
        result = await provider.correct_chunk(
            chunk=plan.chunks[0], image_bytes=_image(), image_mime_type="image/jpeg"
        )
        self.assertEqual(result.corrected_words, ("ngày", "xưa."))
        self.assertIn("gemini-3.5-flash-lite", str(seen[0].url))

    async def test_groq_sends_data_image_and_rejects_invalid_json(self):
        plan = chunk_ocr_text("ngay xua.", _config().local.chunking)

        async def handler(request):
            body = json.loads(request.content)
            self.assertEqual(body["model"], "qwen/qwen3.8-27b")
            self.assertTrue(
                body["messages"][1]["content"][1]["image_url"]["url"].startswith(
                    "data:image/jpeg;base64,"
                )
            )
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "{not-json"}}]},
            )

        provider = GroqOcrProvider(
            model="qwen/qwen3.8-27b",
            api_key="fresh-key",
            timeout_seconds=2,
            transport=httpx.MockTransport(handler),
        )
        with self.assertRaises(OcrProviderError) as caught:
            await provider.correct_chunk(
                chunk=plan.chunks[0], image_bytes=_image(), image_mime_type="image/jpeg"
            )
        self.assertEqual(caught.exception.code, "INVALID_JSON")

    async def test_groq_accepts_multimodal_structured_response(self):
        plan = chunk_ocr_text("ngay xua.", _config().local.chunking)

        async def handler(request):
            body = json.loads(request.content)
            self.assertEqual(
                str(request.url), "https://api.groq.com/openai/v1/chat/completions"
            )
            self.assertEqual(request.headers["Authorization"], "Bearer fresh-key")
            self.assertEqual(body["model"], "qwen/qwen3.8-27b")
            self.assertEqual(body["response_format"], {"type": "json_object"})
            self.assertIn("text", body["messages"][1]["content"][0])
            self.assertIn(
                '"corrected_words" must contain exactly 2 strings',
                body["messages"][1]["content"][0]["text"],
            )
            self.assertTrue(
                body["messages"][1]["content"][1]["image_url"]["url"].startswith(
                    "data:image/jpeg;base64,"
                )
            )
            result = {
                "chunk_id": 0,
                "corrected_words": ["ngày", "xưa."],
                "uncertain_word_indices": [],
            }
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": json.dumps(result)}}]},
            )

        provider = GroqOcrProvider(
            model="qwen/qwen3.8-27b",
            api_key="fresh-key",
            timeout_seconds=2,
            transport=httpx.MockTransport(handler),
        )
        result = await provider.correct_chunk(
            chunk=plan.chunks[0], image_bytes=_image(), image_mime_type="image/jpeg"
        )
        self.assertEqual(result.corrected_words, ("ngày", "xưa."))

    async def test_cloud_provider_timeout_and_network_errors_are_classified(self):
        plan = chunk_ocr_text("ngay", _config().local.chunking)
        factories = (
            lambda transport: GeminiOcrProvider(
                name="gemini_3_5",
                model="gemini-3.5-flash-lite",
                api_key="fresh-key",
                timeout_seconds=2,
                transport=transport,
            ),
            lambda transport: GroqOcrProvider(
                model="qwen/qwen3.8-27b",
                api_key="fresh-key",
                timeout_seconds=2,
                transport=transport,
            ),
        )
        for factory in factories:
            for provider_error, expected_code in (
                (httpx.ConnectTimeout("timeout"), "PROVIDER_TIMEOUT"),
                (httpx.ConnectError("network"), "PROVIDER_NETWORK"),
            ):
                async def handler(_request, error=provider_error):
                    raise error

                provider = factory(httpx.MockTransport(handler))
                with self.subTest(
                    provider=provider.name, error=expected_code
                ), self.assertRaises(OcrProviderError) as caught:
                    await provider.correct_chunk(
                        chunk=plan.chunks[0],
                        image_bytes=_image(),
                        image_mime_type="image/jpeg",
                    )
                self.assertEqual(caught.exception.code, expected_code)


class OllamaProviderBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_disables_thinking_and_only_accepts_final_content(self):
        plan = chunk_ocr_text("ngay xua.", _config().local.chunking)
        seen = []

        async def handler(request):
            payload = json.loads(request.content)
            seen.append(payload)
            self.assertEqual(
                str(request.url), "http://127.0.0.1:11434/api/chat"
            )
            self.assertEqual(payload["model"], "qwen3-vl:4b-instruct-q4_K_M")
            self.assertEqual(len(payload["messages"][0]["images"]), 1)
            self.assertTrue(payload["messages"][0]["images"][0])
            result = {
                "chunk_id": plan.chunks[0].chunk_id,
                "corrected_words": [token.text for token in plan.chunks[0].tokens],
                "uncertain_word_indices": [],
            }
            return httpx.Response(
                200,
                json={
                    "message": {
                        "content": json.dumps(result, ensure_ascii=False),
                        "thinking": "intermediate reasoning is ignored",
                    },
                    "done_reason": "stop",
                },
            )

        provider = OllamaOcrProvider(
            _config().local, transport=httpx.MockTransport(handler)
        )
        result = await provider.correct_chunk(
            chunk=plan.chunks[0], image_bytes=_image(), image_mime_type="image/jpeg"
        )
        self.assertIs(seen[0]["think"], False)
        self.assertEqual(result.corrected_words, tuple(token.text for token in plan.chunks[0].tokens))

    async def test_rejects_answer_returned_only_in_thinking_field(self):
        plan = chunk_ocr_text("ngay xua.", _config().local.chunking)
        result = {
            "chunk_id": plan.chunks[0].chunk_id,
            "corrected_words": [token.text for token in plan.chunks[0].tokens],
            "uncertain_word_indices": [],
        }

        async def handler(_request):
            return httpx.Response(
                200,
                json={
                    "message": {
                        "content": "",
                        "thinking": json.dumps(result, ensure_ascii=False),
                    },
                    "done_reason": "stop",
                },
            )

        provider = OllamaOcrProvider(
            _config().local, transport=httpx.MockTransport(handler)
        )
        with self.assertRaises(OcrProviderError) as caught:
            await provider.correct_chunk(
                chunk=plan.chunks[0], image_bytes=_image(), image_mime_type="image/jpeg"
            )
        self.assertEqual(caught.exception.code, "EMPTY_CONTENT")


class OcrFallbackOrchestratorTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_start_and_success_diagnostics_describe_real_call(self):
        calls = []
        provider = _Provider("gemini_3_5", calls)
        provider.model = "gemini-3.5-flash-lite"
        with self.assertLogs(
            "app.services.ocr_ai.orchestrator", level=logging.INFO
        ) as logs:
            await OcrCorrectionOrchestrator(
                _config(), providers=[provider]
            ).correct("ngay", _image(), _boxes(1))

        events = [
            json.loads(line.split("readalong_diagnostic ", 1)[1])
            for line in logs.output
        ]
        self.assertEqual(
            [event["event"] for event in events],
            ["ocr_provider_started", "ocr_provider_succeeded"],
        )
        self.assertEqual(events[0]["provider"], "gemini_3_5")
        self.assertEqual(events[0]["model"], "gemini-3.5-flash-lite")
        self.assertEqual(events[0]["chunk_id"], 0)
        self.assertEqual(events[1]["provider"], "gemini_3_5")
        self.assertGreaterEqual(events[1]["elapsed_ms"], 0)
        self.assertNotIn("ngay", "\n".join(logs.output))

    async def test_primary_success_including_unchanged_words_does_not_fallback(self):
        calls = []
        providers = [_Provider("gemini_3_5", calls), _Provider("groq_qwen", calls)]
        result = await OcrCorrectionOrchestrator(
            _config(), providers=providers
        ).correct("ngay xua.", _image(), _boxes(2))
        self.assertEqual(result, "ngay xua.")
        self.assertEqual([entry[0] for entry in calls], ["gemini_3_5"])

    async def test_timeout_falls_to_groq_then_stops(self):
        calls = []
        providers = [
            _Provider(
                "gemini_3_5",
                calls,
                error=OcrProviderError(
                    provider="gemini_3_5", code="PROVIDER_TIMEOUT", status_code=504
                ),
            ),
            _Provider("groq_qwen", calls),
            _Provider("gemini_3_1", calls),
        ]
        result = await OcrCorrectionOrchestrator(
            _config(), providers=providers
        ).correct("ngay xua.", _image(), _boxes(2))
        self.assertEqual(result, "ngay xua.")
        self.assertEqual([entry[0] for entry in calls], ["gemini_3_5", "groq_qwen"])

    async def test_gemini_and_groq_failures_advance_to_gemini_fallback(self):
        calls = []
        providers = [
            _Provider(
                "gemini_3_5",
                calls,
                error=OcrProviderError(provider="gemini_3_5", code="PROVIDER_TIMEOUT"),
            ),
            _Provider(
                "groq_qwen",
                calls,
                error=OcrProviderError(provider="groq_qwen", code="PROVIDER_QUOTA"),
            ),
            _Provider("gemini_3_1", calls),
            _Provider("ollama_qwen3_vl", calls),
        ]
        result = await OcrCorrectionOrchestrator(
            _config(), providers=providers
        ).correct("ngay xua.", _image(), _boxes(2))
        self.assertEqual(result, "ngay xua.")
        self.assertEqual(
            [entry[0] for entry in calls], ["gemini_3_5", "groq_qwen", "gemini_3_1"]
        )

    async def test_all_cloud_failures_advance_to_ollama_last(self):
        calls = []
        providers = [
            _Provider(
                "gemini_3_5",
                calls,
                error=OcrProviderError(provider="gemini_3_5", code="PROVIDER_TIMEOUT"),
            ),
            _Provider(
                "groq_qwen",
                calls,
                error=OcrProviderError(provider="groq_qwen", code="PROVIDER_TIMEOUT"),
            ),
            _Provider(
                "gemini_3_1",
                calls,
                error=OcrProviderError(provider="gemini_3_1", code="PROVIDER_TIMEOUT"),
            ),
            _Provider("ollama_qwen3_vl", calls),
        ]
        result = await OcrCorrectionOrchestrator(
            _config(), providers=providers
        ).correct("ngay xua.", _image(), _boxes(2))
        self.assertEqual(result, "ngay xua.")
        self.assertEqual(
            [entry[0] for entry in calls],
            ["gemini_3_5", "groq_qwen", "gemini_3_1", "ollama_qwen3_vl"],
        )

    async def test_disabled_cloud_flag_calls_only_ollama_even_with_keys(self):
        calls = []
        local_provider = _Provider("ollama_qwen3_vl", calls)
        with (
            patch.dict(
                os.environ,
                {
                    "OCR_CLOUD_CORRECTION_ENABLED": "false",
                    "GEMINI_API_KEY": "gemini-test-key",
                    "GROQ_API_KEY": "groq-test-key",
                },
                clear=True,
            ),
            patch(
                "app.services.ocr_ai.orchestrator.GeminiOcrProvider",
                side_effect=AssertionError("cloud provider must not be built"),
            ),
            patch(
                "app.services.ocr_ai.orchestrator.GroqOcrProvider",
                side_effect=AssertionError("cloud provider must not be built"),
            ),
            patch(
                "app.services.ocr_ai.orchestrator.OllamaOcrProvider",
                return_value=local_provider,
            ),
            patch("app.services.ocr_ai.orchestrator.log_diagnostic"),
        ):
            config = OcrCorrectionConfig.from_environment()
            orchestrator = OcrCorrectionOrchestrator(config)
            result = await orchestrator.correct("ngay xua.", _image(), _boxes(2))
        self.assertEqual(result, "ngay xua.")
        self.assertEqual([provider.name for provider in orchestrator.providers], ["ollama_qwen3_vl"])
        self.assertEqual([entry[0] for entry in calls], ["ollama_qwen3_vl"])

    async def test_uncertain_word_falls_forward_and_keeps_confirmed_word(self):
        calls = []
        providers = [
            _Provider(
                "gemini_3_5",
                calls,
                result=ChunkCorrectionResult(0, ("ngày", "xua"), (1,)),
            ),
            _Provider(
                "groq_qwen",
                calls,
                result=ChunkCorrectionResult(0, ("ngay", "xưa"), ()),
            ),
            _Provider("gemini_3_1", calls),
        ]
        with self.assertLogs("app.services.ocr_ai.orchestrator", level=logging.WARNING) as logs:
            result = await OcrCorrectionOrchestrator(
                _config(), providers=providers
            ).correct("ngay xua", _image(), _boxes(2))
        self.assertEqual(result, "ngày xưa")
        self.assertEqual([entry[0] for entry in calls], ["gemini_3_5", "groq_qwen"])
        self.assertEqual(calls[1][4], ("ngày", "xua"))
        self.assertEqual(calls[1][5], "ngày xua")
        self.assertIn("UNCERTAIN_TOKENS", "\n".join(logs.output))
        self.assertNotIn("ngay xua", "\n".join(logs.output))

    async def test_all_providers_uncertain_preserves_original_and_logs_count(self):
        calls = []
        partial = ChunkCorrectionResult(0, ("ngay",), (0,))
        providers = [
            _Provider(name, calls, result=partial)
            for name in ("gemini_3_5", "groq_qwen", "gemini_3_1", "ollama_qwen3_vl")
        ]
        with self.assertLogs("app.services.ocr_ai.orchestrator", level=logging.WARNING) as logs:
            result = await OcrCorrectionOrchestrator(
                _config(), providers=providers
            ).correct("ngay", _image(), _boxes(1))
        self.assertEqual(result, "ngay")
        self.assertEqual(
            [entry[0] for entry in calls],
            ["gemini_3_5", "groq_qwen", "gemini_3_1", "ollama_qwen3_vl"],
        )
        output = "\n".join(logs.output)
        self.assertIn("ocr_uncertain_tokens_preserved", output)
        self.assertIn('"uncertain_count":1', output)
        self.assertNotIn('"text"', output)

    async def test_unexpected_provider_error_falls_back_without_logging_exception_text(self):
        calls = []
        providers = [
            _Provider("gemini_3_5", calls, error=RuntimeError("secret payload must not leak")),
            _Provider("groq_qwen", calls),
        ]
        with self.assertLogs("app.services.ocr_ai.orchestrator", level=logging.ERROR) as logs:
            result = await OcrCorrectionOrchestrator(
                _config(), providers=providers
            ).correct("ngay xua.", _image(), _boxes(2))
        self.assertEqual(result, "ngay xua.")
        self.assertEqual([entry[0] for entry in calls], ["gemini_3_5", "groq_qwen"])
        self.assertNotIn("secret payload", "\n".join(logs.output))

    async def test_google_auth_error_skips_later_gemini_but_reaches_ollama(self):
        calls = []
        providers = [
            _Provider(
                "gemini_3_5",
                calls,
                error=OcrProviderError(
                    provider="gemini_3_5",
                    code="PROVIDER_AUTHENTICATION",
                    disables_family=True,
                ),
            ),
            _Provider(
                "groq_qwen",
                calls,
                error=OcrProviderError(provider="groq_qwen", code="PROVIDER_TIMEOUT"),
            ),
            _Provider("gemini_3_1", calls),
            _Provider("ollama_qwen3_vl", calls),
        ]
        result = await OcrCorrectionOrchestrator(
            _config(), providers=providers
        ).correct("ngay xua.", _image(), _boxes(2))
        self.assertEqual(result, "ngay xua.")
        self.assertEqual(
            [entry[0] for entry in calls],
            ["gemini_3_5", "groq_qwen", "ollama_qwen3_vl"],
        )

    async def test_groq_auth_error_disables_groq_and_advances_to_gemini_fallback(self):
        calls = []
        providers = [
            _Provider("gemini_3_5", calls, error=OcrProviderError(
                provider="gemini_3_5", code="PROVIDER_TIMEOUT"
            )),
            _Provider("groq_qwen", calls, error=OcrProviderError(
                provider="groq_qwen", code="PROVIDER_AUTHENTICATION", disables_family=True
            )),
            _Provider("gemini_3_1", calls),
            _Provider("ollama_qwen3_vl", calls),
        ]
        result = await OcrCorrectionOrchestrator(
            _config(), providers=providers
        ).correct("ngay xua.", _image(), _boxes(2))
        self.assertEqual(result, "ngay xua.")
        self.assertEqual(
            [entry[0] for entry in calls],
            ["gemini_3_5", "groq_qwen", "gemini_3_1"],
        )

    async def test_fallback_is_independent_for_each_chunk_and_failure_is_fail_closed(self):
        calls = []

        def primary_result(chunk):
            if chunk.chunk_id == 0:
                raise AssertionError("primary should fail through provider error")
            return ChunkCorrectionResult(
                chunk.chunk_id, tuple(token.text for token in chunk.tokens), ()
            )

        class FirstChunkFailure(_Provider):
            async def correct_chunk(self, *, chunk, image_bytes, image_mime_type):
                self._calls.append((self.name, chunk.chunk_id, image_mime_type, bool(image_bytes)))
                if chunk.chunk_id == 0:
                    raise OcrProviderError(provider=self.name, code="INVALID_RESPONSE")
                return primary_result(chunk)

        providers = [FirstChunkFailure("gemini_3_5", calls), _Provider("groq_qwen", calls)]
        result = await OcrCorrectionOrchestrator(
            _config(max_words=1), providers=providers
        ).correct("một hai", _image(), _boxes(2))
        self.assertEqual(result, "một hai")
        self.assertEqual(
            [(entry[0], entry[1]) for entry in calls],
            [("gemini_3_5", 0), ("groq_qwen", 0), ("gemini_3_5", 1)],
        )

        failures = [
            _Provider(
                "gemini_3_5",
                [],
                error=OcrProviderError(provider="gemini_3_5", code="INVALID_RESPONSE"),
            ),
            _Provider(
                "ollama_qwen3_vl",
                [],
                error=OcrProviderError(provider="ollama_qwen3_vl", code="PROVIDER_NETWORK"),
            ),
        ]
        with self.assertRaises(OcrOrchestrationError):
            await OcrCorrectionOrchestrator(
                _config(), providers=failures
            ).correct("ngay", _image(), _boxes(1))


class OcrStructuredValidationTests(unittest.TestCase):
    def setUp(self):
        self.chunk = chunk_ocr_text(
            "‘ngay,’ xua-tu",
            _config().local.chunking,
        ).chunks[0]

    def test_unchanged_and_uncertain_tokens_are_valid(self):
        result = validate_chunk_result(
            {
                "chunk_id": self.chunk.chunk_id,
                "corrected_words": ["‘ngay,’", "xua-tu"],
                "uncertain_word_indices": [0, 1],
            },
            chunk=self.chunk,
            provider="test",
        )
        self.assertEqual(result.corrected_words, ("‘ngay,’", "xua-tu"))

    def test_preserves_source_boundary_punctuation_when_model_changes_it(self):
        result = validate_chunk_result(
            {
                "chunk_id": self.chunk.chunk_id,
                "corrected_words": ["“ngày.”", "xua-tu"],
                "uncertain_word_indices": [],
            },
            chunk=self.chunk,
            provider="test",
        )
        self.assertEqual(result.corrected_words, ("‘ngày,’", "xua-tu"))

    def test_uncertain_word_change_is_kept_as_original(self):
        result = validate_chunk_result(
            {
                "chunk_id": self.chunk.chunk_id,
                "corrected_words": ["‘ngày,’", "xua-tu"],
                "uncertain_word_indices": [0],
            },
            chunk=self.chunk,
            provider="test",
        )
        self.assertEqual(result.corrected_words, ("‘ngay,’", "xua-tu"))
        self.assertEqual(result.uncertain_word_indices, (0,))

    def test_internal_punctuation_drift_keeps_source_token_and_marks_uncertain(self):
        result = validate_chunk_result(
            {
                "chunk_id": self.chunk.chunk_id,
                "corrected_words": ["‘ngay,’", "xuatu"],
                "uncertain_word_indices": [],
            },
            chunk=self.chunk,
            provider="test",
        )
        self.assertEqual(result.corrected_words, ("‘ngay,’", "xua-tu"))
        self.assertEqual(result.uncertain_word_indices, (1,))

    def test_suspected_reorder_preserves_original_words_and_marks_uncertain(self):
        reordered_chunk = chunk_ocr_text(
            "ngay xua", _config().local.chunking
        ).chunks[0]
        reordered = {
            "chunk_id": reordered_chunk.chunk_id,
            "corrected_words": ["xua", "ngay"],
            "uncertain_word_indices": [],
        }
        result = validate_chunk_result(reordered, chunk=reordered_chunk, provider="test")
        self.assertEqual(result.corrected_words, ("ngay", "xua"))
        self.assertEqual(result.uncertain_word_indices, (0, 1))

        duplicate_source_word = {
            "chunk_id": reordered_chunk.chunk_id,
            "corrected_words": ["xua", "xua"],
            "uncertain_word_indices": [],
        }
        result = validate_chunk_result(
            duplicate_source_word, chunk=reordered_chunk, provider="test"
        )
        self.assertEqual(result.corrected_words, ("ngay", "xua"))
        self.assertEqual(result.uncertain_word_indices, (0,))

    def test_rejects_split(self):
        cases = [(["‘ngay moi,’", "xua-tu"], [])]
        for corrected, uncertain in cases:
            with self.subTest(corrected=corrected), self.assertRaises(OcrProviderError):
                validate_chunk_result(
                    {
                        "chunk_id": self.chunk.chunk_id,
                        "corrected_words": corrected,
                        "uncertain_word_indices": uncertain,
                    },
                    chunk=self.chunk,
                    provider="test",
                )

    def test_rejects_token_count_mismatch(self):
        with self.assertRaises(OcrProviderError):
            validate_chunk_result(
                {
                    "chunk_id": self.chunk.chunk_id,
                    "corrected_words": ["ngày"],
                    "uncertain_word_indices": [],
                },
                chunk=self.chunk,
                provider="test",
            )


if __name__ == "__main__":
    unittest.main()
