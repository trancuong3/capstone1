"""Run the tutor/reading/voice regression suite without local server secrets.

Usage from backend: .venv/Scripts/python.exe -B run_tutor_tests.py
Real HTTPX transports are blocked; TestClient and MockTransport still work.
"""

import os
import unittest
from unittest.mock import patch

import httpx


TEST_ENVIRONMENT = {
    "DATABASE_URL": "postgresql+asyncpg://test:test@127.0.0.1:1/test",
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_KEY": "isolated-test-key",
    "SUPABASE_SECRET_KEY": "isolated-test-secret",
    "SUPABASE_SERVICE_ROLE_KEY": "isolated-test-service-role",
    "SUPABASE_STORAGE_BUCKET": "isolated-test-bucket",
    "GEMINI_API_KEY": "isolated-test-gemini-key",
    "GEMINI_TUTOR_MODEL": "gemini-test",
    "ELEVENLABS_API_KEY": "isolated-test-voice-key",
    "ELEVENLABS_VOICE_ID": "isolated-test-voice",
    "ELEVENLABS_MODEL_ID": "eleven_flash_v2_5",
}


def block_http(_transport, request):
    raise httpx.ConnectError("Real HTTP disabled in tutor tests", request=request)


async def block_async_http(_transport, request):
    raise httpx.ConnectError("Real HTTP disabled in tutor tests", request=request)


def main():
    # Non-empty dummy values prevent the app's dotenv fallback from loading any
    # real server keys. Load all test modules only after applying the isolation.
    with (
        patch.dict(os.environ, TEST_ENVIRONMENT),
        patch.object(httpx.HTTPTransport, "handle_request", block_http),
        patch.object(httpx.AsyncHTTPTransport, "handle_async_request", block_async_http),
    ):
        suite = unittest.defaultTestLoader.loadTestsFromNames([
            "test_reading_content_service",
            "test_tutor_service",
            "test_tutor_provider",
            "test_tutor_api",
            "test_voice",
        ])
        return 0 if unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
