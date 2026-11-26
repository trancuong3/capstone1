"""Tests for authenticated WS /voice/stt-stream proxy, status reporting, and fallback codes."""

from __future__ import annotations

import asyncio
import json
import os
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI, HTTPException, status
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.deps import require_active_profile_id
from app.api.routes import voice as voice_routes
from app.providers.local_voice_provider import (
    LOCAL_STT_MODEL_VERSION,
    STATIC_LOCAL_VOICES,
    LocalVoiceProvider,
    build_local_tts_model_version,
)
from app.services.voice_orchestrator import (
    VoiceOrchestrator,
    clear_voice_orchestrator_caches,
)

ACTOR_ID = UUID("33333333-3333-4333-8333-333333333333")


class FakeWorkerWs:
    """In-memory mock of the local voice worker's /stt/stream WebSocket."""

    def __init__(self) -> None:
        self.sent_messages: list[str | bytes] = []
        self._incoming: asyncio.Queue[str | bytes | None] = asyncio.Queue()
        self.closed = False

    async def send(self, data: str | bytes) -> None:
        self.sent_messages.append(data)
        if isinstance(data, str):
            payload = json.loads(data)
            msg_type = payload.get("type")
            if msg_type == "start":
                await self._incoming.put(
                    json.dumps(
                        {
                            "type": "ready",
                            "session_id": payload.get("session_id", ""),
                            "page_id": payload.get("page_id", ""),
                            "turn_id": payload.get("turn_id", ""),
                            "sample_rate": 16000,
                            "model_version": LOCAL_STT_MODEL_VERSION,
                            "stt_mode": "ws",
                        }
                    )
                )
            elif msg_type == "flush":
                await self._incoming.put(
                    json.dumps(
                        {
                            "type": "final",
                            "text": "một con mèo",
                            "words": [
                                {"text": "một", "start": 0.04, "end": 0.24, "type": "word"},
                                {"text": "con", "start": 0.26, "end": 0.44, "type": "word"},
                                {"text": "mèo", "start": 0.46, "end": 0.72, "type": "word"},
                            ],
                            "segment_id": "sess_1:seg_1",
                            "turn_id": payload.get("turn_id", "turn_1"),
                            "epoch_ms": 1732510000100,
                            "audio_ended_ms": 720,
                            "decode_ms": 44.5,
                            "provider": "local",
                            "model_version": LOCAL_STT_MODEL_VERSION,
                        }
                    )
                )
            elif msg_type == "stop":
                await self._incoming.put(None)
        elif isinstance(data, (bytes, bytearray)):
            await self._incoming.put(
                json.dumps(
                    {
                        "type": "interim",
                        "text": "một",
                        "words": [
                            {"text": "một", "start": 0.04, "end": 0.24, "type": "word"}
                        ],
                        "segment_id": "sess_1:seg_1",
                        "turn_id": "turn_1",
                        "epoch_ms": 1732510000050,
                        "audio_ended_ms": 80,
                        "decode_ms": 38.2,
                        "provider": "local",
                        "model_version": LOCAL_STT_MODEL_VERSION,
                    }
                )
            )

    def __aiter__(self):
        return self

    async def __anext__(self) -> str | bytes:
        item = await self._incoming.get()
        if item is None:
            raise StopAsyncIteration
        return item


class VoiceStreamProxyTests(unittest.TestCase):
    def setUp(self) -> None:
        clear_voice_orchestrator_caches()
        self._orig_factory = voice_routes.get_voice_orchestrator
        self._orig_open_ws = voice_routes.open_local_stt_ws

    def tearDown(self) -> None:
        voice_routes.get_voice_orchestrator = self._orig_factory
        voice_routes.open_local_stt_ws = self._orig_open_ws

    def _build_client(self, *, override_auth: bool = True) -> TestClient:
        app = FastAPI()
        app.include_router(voice_routes.router, prefix="/voice")
        orchestrator = VoiceOrchestrator(
            local_provider=LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        )
        voice_routes.get_voice_orchestrator = lambda: orchestrator  # type: ignore[assignment]
        if override_auth:
            app.dependency_overrides[require_active_profile_id] = lambda: ACTOR_ID
        return TestClient(app)

    def test_ws_stream_proxies_control_binary_pcm_and_interim_final_messages(self) -> None:
        fake_worker = FakeWorkerWs()
        captured_urls: list[str] = []

        @asynccontextmanager
        async def _fake_open_ws(url: str, _headers: dict[str, str]):
            captured_urls.append(url)
            yield fake_worker

        voice_routes.open_local_stt_ws = _fake_open_ws  # type: ignore[assignment]

        with self._build_client(override_auth=True) as client:
            with client.websocket_connect("/voice/stt-stream") as ws:
                ws.send_text(
                    json.dumps(
                        {
                            "type": "start",
                            "session_id": "sess_1",
                            "page_id": "page_1",
                            "turn_id": "turn_1",
                            "sample_rate": 16000,
                        }
                    )
                )
                ready = ws.receive_json()
                self.assertEqual(ready["type"], "ready")
                self.assertEqual(ready["stt_mode"], "ws")

                # 80ms Int16 mono PCM frame @ 16kHz (1280 samples * 2 bytes)
                ws.send_bytes(b"\x01\x00" * 1280)
                interim = ws.receive_json()
                self.assertEqual(interim["type"], "interim")
                self.assertEqual(interim["text"], "một")
                self.assertEqual(interim["decode_ms"], 38.2)

                ws.send_text(json.dumps({"type": "flush", "turn_id": "turn_1"}))
                final = ws.receive_json()
                self.assertEqual(final["type"], "final")
                self.assertEqual(final["text"], "một con mèo")
                self.assertEqual(len(final["words"]), 3)

                ws.send_text(json.dumps({"type": "stop"}))

        self.assertEqual(captured_urls, ["ws://127.0.0.1:8010/stt/stream"])
        self.assertTrue(any(isinstance(m, bytes) for m in fake_worker.sent_messages))

    def test_ws_stream_first_frame_auth_strips_token_and_rejects_unauthenticated(self) -> None:
        fake_worker = FakeWorkerWs()

        @asynccontextmanager
        async def _fake_open_ws(_url: str, _headers: dict[str, str]):
            yield fake_worker

        voice_routes.open_local_stt_ws = _fake_open_ws  # type: ignore[assignment]

        def _fake_verify(credentials):
            if credentials is None or credentials.credentials != "valid-jwt":
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid authentication credentials",
                )
            return ACTOR_ID

        with (
            patch("app.api.routes.voice.get_current_parent_id", _fake_verify),
            patch(
                "app.api.routes.voice._verify_ws_active_profile",
                AsyncMock(return_value=ACTOR_ID),
            ),
        ):
            with self._build_client(override_auth=False) as client:
                # 1. Missing/invalid token on first frame -> 4401 error + close
                with client.websocket_connect("/voice/stt-stream") as ws:
                    ws.send_text(json.dumps({"type": "start", "token": "bad-jwt"}))
                    err = ws.receive_json()
                    self.assertEqual(err["type"], "error")
                    self.assertEqual(err["code"], "UNAUTHORIZED")
                    with self.assertRaises(WebSocketDisconnect) as ctx:
                        ws.receive_text()
                    self.assertEqual(ctx.exception.code, 4401)

                # 2. Valid token in first `start` frame -> strips token before forwarding!
                with client.websocket_connect(
                    "/voice/stt-stream", subprotocols=["viread-stt-v1"]
                ) as ws:
                    ws.send_text(
                        json.dumps(
                            {
                                "type": "start",
                                "token": "valid-jwt",
                                "session_id": "sess_auth",
                                "page_id": "page_1",
                                "turn_id": "turn_1",
                            }
                        )
                    )
                    ready = ws.receive_json()
                    self.assertEqual(ready["type"], "ready")
                    ws.send_text(json.dumps({"type": "stop"}))

        forwarded_start = json.loads(fake_worker.sent_messages[0])  # type: ignore[arg-type]
        self.assertNotIn("token", forwarded_start)
        self.assertEqual(forwarded_start["session_id"], "sess_auth")

    def test_ws_stream_rejects_bearer_subprotocol_and_requires_first_frame_auth(self) -> None:
        fake_worker = FakeWorkerWs()

        @asynccontextmanager
        async def _fake_open_ws(_url: str, _headers: dict[str, str]):
            yield fake_worker

        voice_routes.open_local_stt_ws = _fake_open_ws  # type: ignore[assignment]

        def _fake_verify(credentials):
            if credentials is None or credentials.credentials != "proto-jwt":
                raise HTTPException(status_code=401, detail="bad")
            return ACTOR_ID

        with (
            patch("app.api.routes.voice.get_current_parent_id", _fake_verify),
            patch(
                "app.api.routes.voice._verify_ws_active_profile",
                AsyncMock(return_value=ACTOR_ID),
            ),
        ):
            with self._build_client(override_auth=False) as client:
                # Sending bearer.* in Sec-WebSocket-Protocol must NOT authenticate the socket;
                # only `viread-stt-v1` is negotiated and first-frame JSON token auth is still required.
                with client.websocket_connect(
                    "/voice/stt-stream",
                    subprotocols=["viread-stt-v1", "bearer.proto-jwt"],
                ) as ws:
                    self.assertEqual(ws.accepted_subprotocol, "viread-stt-v1")
                    ws.send_text(json.dumps({"type": "start", "session_id": "s_proto"}))
                    err = ws.receive_json()
                    self.assertEqual(err["type"], "error")
                    self.assertEqual(err["code"], "UNAUTHORIZED")
                    with self.assertRaises(WebSocketDisconnect) as ctx:
                        ws.receive_text()
                    self.assertEqual(ctx.exception.code, 4401)

    def test_ws_stream_stop_drains_delayed_final_frame_before_closing(self) -> None:
        class DelayedFinalWorkerWs(FakeWorkerWs):
            async def send(self, data: str | bytes) -> None:
                self.sent_messages.append(data)
                if isinstance(data, str):
                    payload = json.loads(data)
                    if payload.get("type") == "start":
                        await super().send(data)
                    elif payload.get("type") == "stop":
                        async def _emit_delayed_final() -> None:
                            await asyncio.sleep(0.05)
                            await self._incoming.put(
                                json.dumps(
                                    {
                                        "type": "final",
                                        "text": "câu cuối",
                                        "words": [{"text": "câu", "start": 0.0, "end": 0.2, "type": "word"}],
                                        "segment_id": "sess_stop:seg_1",
                                        "turn_id": "turn_stop",
                                        "provider": "local",
                                        "model_version": LOCAL_STT_MODEL_VERSION,
                                    }
                                )
                            )
                            await self._incoming.put(None)

                        asyncio.create_task(_emit_delayed_final())

        fake_worker = DelayedFinalWorkerWs()

        @asynccontextmanager
        async def _fake_open_ws(_url: str, _headers: dict[str, str]):
            yield fake_worker

        voice_routes.open_local_stt_ws = _fake_open_ws  # type: ignore[assignment]

        with self._build_client(override_auth=True) as client:
            with client.websocket_connect("/voice/stt-stream") as ws:
                ws.send_text(json.dumps({"type": "start", "session_id": "sess_stop"}))
                self.assertEqual(ws.receive_json()["type"], "ready")
                ws.send_text(json.dumps({"type": "stop"}))
                final = ws.receive_json()
                self.assertEqual(final["type"], "final")
                self.assertEqual(final["text"], "câu cuối")

    def test_ws_stream_reports_4503_when_worker_down_or_http_rollback_enabled(self) -> None:
        @asynccontextmanager
        async def _failing_open_ws(_url: str, _headers: dict[str, str]):
            raise ConnectionRefusedError("worker down")
            yield  # pragma: no cover

        voice_routes.open_local_stt_ws = _failing_open_ws  # type: ignore[assignment]

        with self._build_client(override_auth=True) as client:
            with client.websocket_connect("/voice/stt-stream") as ws:
                err = ws.receive_json()
                self.assertEqual(err["code"], "LOCAL_STT_UNAVAILABLE")
                self.assertTrue(err["retryable"])
                with self.assertRaises(WebSocketDisconnect) as ctx:
                    ws.receive_text()
                self.assertEqual(ctx.exception.code, 4503)

            with patch.dict(os.environ, {"VIREAD_STT_MODE": "http"}, clear=False):
                with client.websocket_connect("/voice/stt-stream") as ws:
                    err = ws.receive_json()
                    self.assertEqual(err["code"], "STT_WS_DISABLED")
                    self.assertTrue(err["retryable"])
                    with self.assertRaises(WebSocketDisconnect) as ctx:
                        ws.receive_text()
                    self.assertEqual(ctx.exception.code, 4503)

    def test_voice_status_reports_active_models_modes_precision_and_voices(self) -> None:
        with self._build_client(override_auth=True) as client:
            with patch(
                "app.providers.local_voice_provider.LocalVoiceProvider.get_health",
                new=AsyncMock(
                    return_value={
                        "available": True,
                        "stt_ready": True,
                        "tts_ready": True,
                        "stt_model_version": LOCAL_STT_MODEL_VERSION,
                        "stt_mode": "ws",
                        "tts_model_version": build_local_tts_model_version("hybrid"),
                        "tts_precision": "hybrid",
                        "active_voices": [v["voice_id"] for v in STATIC_LOCAL_VOICES],
                    }
                ),
            ):
                resp = client.get("/voice/status")

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["local"]["stt_model_version"], LOCAL_STT_MODEL_VERSION)
        self.assertEqual(body["local"]["stt_mode"], "ws")
        self.assertEqual(
            body["local"]["tts_model_version"],
            "vieneu-v3-turbo-onnx-hybrid-3.8.5",
        )
        self.assertEqual(body["local"]["tts_precision"], "hybrid")
        self.assertEqual(len(body["local"]["active_voices"]), 8)


if __name__ == "__main__":
    unittest.main()
