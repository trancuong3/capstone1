"""Comprehensive M3 contract tests: AI Capability Router, GPU Scheduler, Durable Studio Jobs,
Unified Global Tasks API (3-actor IDOR), and R-01 Private-Book Privacy & Orphan Reconciliation.

Compatible with both `python -m unittest` and `pytest`.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import sys
import unittest
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

_BACKEND_DIR = str(Path(__file__).resolve().parent)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
from sqlalchemy.exc import IntegrityError, ProgrammingError

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.global_tasks import router as global_tasks_router
from app.models import (
    AdminAiWorkflow,
    Book,
    BookPage,
    BookPresentationAsset,
    BookStyleBible,
    OcrInferenceJob,
    OcrWorkerHeartbeat,
    PageRevision,
    ParentBookPageSubmission,
    Profile,
    SmartStudioJob,
)
from app.schemas.global_tasks import GlobalTaskCreateRequest
from app.services.ai_capability_router import (
    ALL_TEXT_VISION_CAPABILITIES,
    AiCapability,
    AiCapabilityRouter,
    AiErrorKind,
    AiProviderCallError,
    AiRoutingError,
    CircuitBreakerRegistry,
    CircuitState,
    ImageGenerationRequest,
    ProviderSpec,
    TenantAiCache,
    build_default_provider_registry,
    build_tenant_cache_key,
    classify_http_error,
)
from app.services.global_tasks_service import (
    GlobalTasksService,
    JobCancelledError,
    StaleLeaseError,
    get_remaining_stages,
)
from app.services.gpu_workload_scheduler import (
    GpuWorkloadScheduler,
    PreemptionRequested,
    WorkloadPriority,
)
from app.services.ocr_inference_job_service import (
    JOB_KIND_ADMIN_UPLOAD,
    JOB_KIND_PARENT_SUBMISSION,
    compute_candidate_hash,
    reconcile_orphaned_parent_submissions,
    run_parent_submission_post_ocr,
)


# ---------------------------------------------------------------------------
# Deterministic In-Memory AsyncSession Emulator (with nested savepoint support)
# ---------------------------------------------------------------------------


def _resolve_col_val(row: Any, col_expr: Any) -> Any:
    col_key = getattr(col_expr, "key", None) or getattr(col_expr, "name", None)
    val = getattr(row, col_key, None) if col_key else None
    if val is None and col_key is not None and hasattr(row, "__mapper__"):
        for attr in row.__mapper__.attrs:
            cols = getattr(attr, "columns", ())
            if cols and cols[0].name == col_key:
                return getattr(row, attr.key, None)
    return val


def _eval_clause(row: Any, expr: Any) -> bool:
    cls_name = type(expr).__name__
    if cls_name == "BooleanClauseList":
        op_name = getattr(expr.operator, "__name__", "")
        sub_results = [_eval_clause(row, c) for c in expr.clauses]
        return any(sub_results) if "or" in op_name else all(sub_results)
    if cls_name == "Grouping":
        return _eval_clause(row, expr.element)

    left = getattr(expr, "left", None)
    right = getattr(expr, "right", None)
    op = getattr(expr, "operator", None)
    op_name = getattr(op, "__name__", str(op))
    if left is None:
        return True

    val = _resolve_col_val(row, left)
    if right is None or type(right).__name__ == "Null":
        return val is None if "is_" in op_name and "not" not in op_name else val is not None
    if type(right).__name__ == "False_":
        rhs_val = False
    elif type(right).__name__ == "True_":
        rhs_val = True
    elif hasattr(right, "table") or "Column" in type(right).__name__:
        rhs_val = _resolve_col_val(row, right)
    else:
        rhs_val = getattr(right, "value", getattr(right, "element", right))
        if hasattr(right, "effective_value"):
            rhs_val = right.effective_value

    if op_name in ("is_", "is"):
        return val is rhs_val
    if op_name in ("is_not", "isnot"):
        return val is not rhs_val
    if op_name in ("in_op", "in"):
        return val in rhs_val
    if op_name in ("not_in_op", "notin_op"):
        return val not in rhs_val
    if op_name == "eq":
        return val == rhs_val
    if op_name == "ne":
        return val != rhs_val
    if op_name == "lt":
        return val is not None and rhs_val is not None and val < rhs_val
    if op_name == "le":
        return val is not None and rhs_val is not None and val <= rhs_val
    if op_name == "gt":
        return val is not None and rhs_val is not None and val > rhs_val
    if op_name == "ge":
        return val is not None and rhs_val is not None and val >= rhs_val
    return True


@dataclass
class StudioDbState:
    tables: dict[type, list[Any]] = field(
        default_factory=lambda: {
            Profile: [],
            Book: [],
            BookPage: [],
            BookPresentationAsset: [],
            BookStyleBible: [],
            PageRevision: [],
            SmartStudioJob: [],
            OcrInferenceJob: [],
            OcrWorkerHeartbeat: [],
            AdminAiWorkflow: [],
            ParentBookPageSubmission: [],
        }
    )
    missing_tables: set[str] = field(default_factory=set)


class _ScalarResult:
    def __init__(self, items: list[Any]):
        self._items = items

    def all(self) -> list[Any]:
        return list(self._items)

    def first(self) -> Any | None:
        return self._items[0] if self._items else None

    def scalar_one_or_none(self) -> Any | None:
        return self._items[0] if self._items else None

    def scalars(self) -> _ScalarResult:
        return self


class FakeStudioAsyncSession:
    """In-memory AsyncSession supporting savepoints, unique constraints, and ordering."""

    def __init__(self, state: StudioDbState):
        self.state = state
        self._pending_adds: list[Any] = []
        self._snapshots: dict[tuple[type, int], dict[str, Any]] = {}

    def _snapshot(self, obj: Any) -> dict[str, Any]:
        return {attr.key: getattr(obj, attr.key) for attr in obj.__mapper__.attrs}

    def _track_snapshot(self, obj: Any) -> None:
        key = (type(obj), id(obj))
        if key not in self._snapshots and hasattr(obj, "__mapper__"):
            self._snapshots[key] = self._snapshot(obj)

    @asynccontextmanager
    async def begin_nested(self):
        saved_adds = list(self._pending_adds)
        saved_snaps = {
            (cls, id(obj)): self._snapshot(obj)
            for cls, rows in self.state.tables.items()
            for obj in rows
            if hasattr(obj, "__mapper__")
        }
        try:
            yield self
        except Exception:
            for obj in list(self._pending_adds):
                if obj not in saved_adds:
                    rows = self.state.tables.get(type(obj), [])
                    if obj in rows:
                        rows.remove(obj)
            self._pending_adds = saved_adds
            for (cls, obj_id), snap in saved_snaps.items():
                for row in self.state.tables.get(cls, []):
                    if id(row) == obj_id:
                        for k, v in snap.items():
                            setattr(row, k, v)
                        break
            raise

    def add(self, obj: Any) -> None:
        cls = type(obj)
        table_name = getattr(cls, "__tablename__", "")
        if table_name in self.state.missing_tables:
            raise ProgrammingError(
                f'relation "{table_name}" does not exist',
                params=None,
                orig=RuntimeError(f'relation "{table_name}" does not exist'),
            )
        if cls is SmartStudioJob:
            for existing in self.state.tables.get(SmartStudioJob, []):
                if existing.ActorId == obj.ActorId and existing.IdempotencyKey == obj.IdempotencyKey:
                    raise IntegrityError("uq_smart_studio_jobs_actor_idem", None, RuntimeError("dup"))
        if getattr(obj, "Id", None) is None and hasattr(cls, "Id"):
            obj.Id = uuid4()
        now = datetime.now(timezone.utc)
        if hasattr(obj, "CreatedAt") and getattr(obj, "CreatedAt", None) is None:
            obj.CreatedAt = now
        if hasattr(obj, "UpdatedAt") and getattr(obj, "UpdatedAt", None) is None:
            obj.UpdatedAt = now
        self.state.tables.setdefault(cls, []).append(obj)
        self._pending_adds.append(obj)

    def add_all(self, objs: list[Any]) -> None:
        for obj in objs:
            self.add(obj)

    async def flush(self) -> None:
        for cls, rows in self.state.tables.items():
            for row in rows:
                self._track_snapshot(row)

    async def commit(self) -> None:
        self._pending_adds.clear()
        self._snapshots.clear()

    async def rollback(self) -> None:
        for obj in self._pending_adds:
            rows = self.state.tables.get(type(obj), [])
            if obj in rows:
                rows.remove(obj)
        self._pending_adds.clear()
        for (cls, obj_id), snap in self._snapshots.items():
            for row in self.state.tables.get(cls, []):
                if id(row) == obj_id:
                    for k, v in snap.items():
                        setattr(row, k, v)
                    break
        self._snapshots.clear()

    async def scalar(self, query: Any) -> Any | None:
        rows = (await self.scalars(query)).all()
        return rows[0] if rows else None

    async def execute(self, query: Any) -> _ScalarResult:
        return await self.scalars(query)

    async def scalars(self, query: Any) -> _ScalarResult:
        desc = query.column_descriptions[0]
        model_cls = desc.get("entity")
        expr = desc.get("expr")
        single_col = None
        if model_cls is None:
            single_col = expr
            table_name = getattr(getattr(single_col, "table", None), "name", None)
            model_cls = next(
                (c for c in self.state.tables if getattr(c, "__tablename__", None) == table_name),
                None,
            )
        else:
            table_name = getattr(model_cls, "__tablename__", None)
            if expr is not None and expr is not model_cls:
                single_col = expr

        if table_name in self.state.missing_tables:
            raise ProgrammingError(
                f'relation "{table_name}" does not exist',
                params=None,
                orig=RuntimeError(f'relation "{table_name}" does not exist'),
            )

        rows = list(self.state.tables.get(model_cls, [])) if model_cls else []
        for crit in getattr(query, "_where_criteria", ()):
            rows = [r for r in rows if _eval_clause(r, crit)]

        order_clauses = list(getattr(query, "_order_by_clauses", ()))
        for clause in reversed(order_clauses):
            is_desc = "desc" in str(getattr(clause, "modifier", "")).lower() or type(clause).__name__ == "UnaryExpression" and "desc" in str(clause).lower()
            col_expr = getattr(clause, "element", clause)

            def _sort_key(row: Any, expr=col_expr):
                v = _resolve_col_val(row, expr)
                if v is None:
                    return (1, "")
                if isinstance(v, datetime):
                    return (0, v.timestamp())
                if isinstance(v, UUID):
                    return (0, str(v))
                return (0, v)

            rows.sort(key=_sort_key, reverse=is_desc)

        limit_clause = getattr(query, "_limit_clause", None)
        if limit_clause is not None and getattr(limit_clause, "value", None) is not None:
            rows = rows[: int(limit_clause.value)]

        for r in rows:
            self._track_snapshot(r)

        if single_col is not None:
            attr_key = single_col.key
            result_vals = []
            for r in rows:
                val = getattr(r, attr_key, None)
                if val is None and hasattr(r, "__mapper__"):
                    for attr in r.__mapper__.attrs:
                        cols = getattr(attr, "columns", ())
                        if cols and cols[0].name == attr_key:
                            val = getattr(r, attr.key, None)
                            break
                result_vals.append(val)
            return _ScalarResult(result_vals)

        return _ScalarResult(rows)


class _SessionCtx:
    def __init__(self, state: StudioDbState):
        self.state = state

    async def __aenter__(self) -> FakeStudioAsyncSession:
        return FakeStudioAsyncSession(self.state)

    async def __aexit__(self, _exc_type, _exc, _tb) -> None:
        return None


class _FakeClock:
    def __init__(self, start: float = 1000.0):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


# ---------------------------------------------------------------------------
# 1. Section 63 AI Provider Contract & Capability Router Tests
# ---------------------------------------------------------------------------


class AiCapabilityRouterContractTests(unittest.IsolatedAsyncioTestCase):
    def _build_router(self, clock: _FakeClock | None = None) -> tuple[AiCapabilityRouter, _FakeClock]:
        clk = clock or _FakeClock()
        providers = (
            ProviderSpec(
                provider_id="gemini_primary",
                family="google",
                model_id="gemini-3.5-flash-lite",
                capabilities=ALL_TEXT_VISION_CAPABILITIES,
                quota_group="gemini_free_shared",
                is_local=False,
                enabled=True,
                max_attempt_timeout_seconds=5.0,
                priority_order=10,
            ),
            ProviderSpec(
                provider_id="gemini_fallback",
                family="google",
                model_id="gemini-3.1-flash-lite",
                capabilities=ALL_TEXT_VISION_CAPABILITIES,
                quota_group="gemini_free_shared",
                is_local=False,
                enabled=True,
                max_attempt_timeout_seconds=5.0,
                priority_order=20,
            ),
            ProviderSpec(
                provider_id="groq_qwen",
                family="groq",
                model_id="qwen/qwen3.8-27b",
                capabilities=ALL_TEXT_VISION_CAPABILITIES,
                quota_group="groq_free_shared",
                is_local=False,
                enabled=True,
                max_attempt_timeout_seconds=5.0,
                priority_order=30,
            ),
            ProviderSpec(
                provider_id="ollama_local",
                family="ollama",
                model_id="qwen3-vl:4b-instruct-q4_K_M",
                capabilities=ALL_TEXT_VISION_CAPABILITIES,
                quota_group=None,
                is_local=True,
                enabled=True,
                max_attempt_timeout_seconds=10.0,
                priority_order=40,
            ),
            ProviderSpec(
                provider_id="cloudflare_flux",
                family="cloudflare",
                model_id="@cf/black-forest-labs/flux-1-schnell",
                capabilities=frozenset({AiCapability.IMAGE_GENERATION}),
                quota_group="cloudflare_workers_ai_daily",
                is_local=False,
                enabled=True,
                max_attempt_timeout_seconds=8.0,
                priority_order=50,
            ),
            ProviderSpec(
                provider_id="local_diffusers",
                family="local_diffusers",
                model_id="sd15-lcm-local",
                capabilities=frozenset({AiCapability.IMAGE_GENERATION, AiCapability.INPAINTING}),
                quota_group=None,
                is_local=True,
                enabled=True,
                max_attempt_timeout_seconds=10.0,
                priority_order=60,
            ),
        )
        cb = CircuitBreakerRegistry(
            clock=clk,
            base_cooldown_seconds=30.0,
            max_cooldown_seconds=300.0,
            auth_cooldown_seconds=3600.0,
            limit_zero_cooldown_seconds=21600.0,
        )
        cache = TenantAiCache(clock=clk, default_ttl_seconds=600.0)
        return AiCapabilityRouter(providers=providers, circuit_breaker=cb, cache=cache, clock=clk), clk

    async def test_cloud_1_ok_stops_without_fallback(self):
        router, _ = self._build_router()
        called: list[str] = []

        async def handler(spec: ProviderSpec, _timeout: float) -> str:
            called.append(spec.provider_id)
            return f"ok:{spec.provider_id}"

        res = await router.route_and_execute(AiCapability.LAYOUT_CLASSIFICATION, handler)
        self.assertEqual(res.provider_id, "gemini_primary")
        self.assertEqual(res.value, "ok:gemini_primary")
        self.assertEqual(called, ["gemini_primary"])

    async def test_cloud_1_timeout_falls_back_cleanly_within_budget(self):
        router, _ = self._build_router()
        called: list[str] = []

        async def handler(spec: ProviderSpec, timeout_s: float) -> str:
            called.append(spec.provider_id)
            if spec.provider_id == "gemini_primary":
                await asyncio.sleep(timeout_s + 0.5)
            return f"recovered:{spec.provider_id}"

        res = await router.route_and_execute(
            AiCapability.OCR_PROOFREADING,
            handler,
            total_budget_seconds=1.0,
            per_attempt_timeout_seconds=0.08,
        )
        self.assertEqual(res.provider_id, "gemini_fallback")
        self.assertEqual(called, ["gemini_primary", "gemini_fallback"])
        self.assertEqual(
            router.circuit_breaker.get_state("provider:gemini_primary"),
            CircuitState.OPEN,
        )

    async def test_unsupported_capability_skips_groq_and_ollama_for_image_gen(self):
        router, _ = self._build_router()
        called: list[str] = []

        async def handler(spec: ProviderSpec, _timeout: float) -> str:
            called.append(spec.provider_id)
            return "img-ok"

        res = await router.route_and_execute(AiCapability.IMAGE_GENERATION, handler)
        self.assertEqual(res.provider_id, "cloudflare_flux")
        self.assertEqual(called, ["cloudflare_flux"])
        self.assertNotIn("groq_qwen", called)
        self.assertNotIn("gemini_primary", called)
        self.assertNotIn("ollama_local", called)
        skipped_ids = {a.provider_id for a in res.attempts if a.outcome == "SKIPPED_UNSUPPORTED_CAPABILITY"}
        self.assertIn("groq_qwen", skipped_ids)

    async def test_429_trips_shared_quota_group_and_skips_sibling_gemini_models(self):
        router, _ = self._build_router()
        called: list[str] = []

        async def handler(spec: ProviderSpec, _timeout: float) -> str:
            called.append(spec.provider_id)
            if spec.provider_id == "gemini_primary":
                raise classify_http_error(
                    provider_id=spec.provider_id,
                    status_code=429,
                    body_text="Quota exceeded for metric free_tier_requests, limit: 0",
                )
            return f"served:{spec.provider_id}"

        res = await router.route_and_execute(AiCapability.TEXT_ANALYSIS, handler)
        # Sibling gemini_fallback MUST be skipped because gemini_free_shared is OPEN!
        self.assertEqual(called, ["gemini_primary", "groq_qwen"])
        self.assertEqual(res.provider_id, "groq_qwen")
        self.assertEqual(
            router.circuit_breaker.get_state("quota_group:gemini_free_shared"),
            CircuitState.OPEN,
        )
        self.assertTrue(
            any(
                a.provider_id == "gemini_fallback"
                and a.outcome == "SKIPPED_QUOTA_GROUP_CIRCUIT_OPEN"
                for a in res.attempts
            )
        )

    async def test_401_403_404_500_503_and_groq_429_circuit_breaker_contract(self):
        for status_code, expected_kind in (
            (401, AiErrorKind.AUTH_FAILURE),
            (403, AiErrorKind.PERMISSION_FAILURE),
            (404, AiErrorKind.UNSUPPORTED_CAPABILITY),
            (429, AiErrorKind.RATE_LIMIT),
            (500, AiErrorKind.NETWORK_ERROR),
            (503, AiErrorKind.NETWORK_ERROR),
        ):
            with self.subTest(status_code=status_code):
                router, _ = self._build_router()
                called: list[str] = []

                async def handler(spec: ProviderSpec, _timeout: float, code=status_code) -> str:
                    called.append(spec.provider_id)
                    if spec.provider_id == "groq_qwen":
                        raise classify_http_error(provider_id=spec.provider_id, status_code=code)
                    return f"ok:{spec.provider_id}"

                # Force groq first to verify Groq 429/5xx/401/403/404 circuit breaking!
                res = await router.route_and_execute(
                    AiCapability.STRUCTURED_JSON,
                    handler,
                    preferred_providers=["groq_qwen", "ollama_local"],
                )
                self.assertEqual(called, ["groq_qwen", "ollama_local"])
                self.assertEqual(res.provider_id, "ollama_local")
                groq_attempt = next(a for a in res.attempts if a.provider_id == "groq_qwen")
                self.assertEqual(groq_attempt.error_kind, expected_kind)
                self.assertTrue(groq_attempt.circuit_tripped)
                self.assertEqual(
                    router.circuit_breaker.get_state("provider:groq_qwen"),
                    CircuitState.OPEN,
                )
                # Next request skips Groq immediately with zero retry!
                called.clear()
                res2 = await router.route_and_execute(
                    AiCapability.STRUCTURED_JSON,
                    handler,
                    preferred_providers=["groq_qwen", "ollama_local"],
                )
                self.assertEqual(called, ["ollama_local"])
                self.assertEqual(res2.provider_id, "ollama_local")

    async def test_unsafe_output_fails_closed_without_retry_or_fallback(self):
        router, _ = self._build_router()
        called: list[str] = []

        async def handler(spec: ProviderSpec, _timeout: float) -> str:
            called.append(spec.provider_id)
            raise AiProviderCallError(
                provider_id=spec.provider_id,
                kind=AiErrorKind.UNSAFE_OUTPUT,
                code="CHILD_SAFETY_BLOCKED",
            )

        with self.assertRaises(AiRoutingError) as ctx:
            await router.route_and_execute(AiCapability.CHILD_SAFETY, handler)
        self.assertEqual(ctx.exception.kind, AiErrorKind.UNSAFE_OUTPUT)
        # Must NOT retry or bypass to another provider!
        self.assertEqual(called, ["gemini_primary"])

    async def test_circuit_open_exponential_backoff_and_half_open_recovery(self):
        router, clk = self._build_router()
        fail_groq = True

        async def handler(spec: ProviderSpec, _timeout: float) -> str:
            if spec.provider_id == "groq_qwen" and fail_groq:
                raise classify_http_error(provider_id="groq_qwen", status_code=503)
            return f"ok:{spec.provider_id}"

        # 1st failure -> 30s cooldown
        res1 = await router.route_and_execute(
            AiCapability.TEXT_ANALYSIS,
            handler,
            preferred_providers=["groq_qwen", "ollama_local"],
        )
        self.assertEqual(res1.provider_id, "ollama_local")
        self.assertEqual(router.circuit_breaker.get_state("provider:groq_qwen"), CircuitState.OPEN)

        # Advance 31s -> HALF_OPEN probe fails -> exponential cooldown 60s
        clk.advance(31.0)
        self.assertEqual(router.circuit_breaker.get_state("provider:groq_qwen"), CircuitState.HALF_OPEN)
        res2 = await router.route_and_execute(
            AiCapability.TEXT_ANALYSIS,
            handler,
            preferred_providers=["groq_qwen", "ollama_local"],
        )
        self.assertEqual(res2.provider_id, "ollama_local")
        snap = router.circuit_breaker.snapshot()["provider:groq_qwen"]
        self.assertEqual(snap["consecutive_failures"], 2)
        self.assertGreater(snap["cooldown_remaining_seconds"], 50.0)

        # Advance 61s -> HALF_OPEN probe succeeds -> CLOSED!
        clk.advance(61.0)
        fail_groq = False
        res3 = await router.route_and_execute(
            AiCapability.TEXT_ANALYSIS,
            handler,
            preferred_providers=["groq_qwen", "ollama_local"],
        )
        self.assertEqual(res3.provider_id, "groq_qwen")
        self.assertEqual(router.circuit_breaker.get_state("provider:groq_qwen"), CircuitState.CLOSED)

    async def test_task_deadline_exhausted_stops_provider_cascade(self):
        router, clk = self._build_router()
        called: list[str] = []

        async def handler(spec: ProviderSpec, _timeout: float) -> str:
            called.append(spec.provider_id)
            clk.advance(5.0)
            raise classify_http_error(provider_id=spec.provider_id, status_code=503)

        with self.assertRaises(AiRoutingError) as ctx:
            await router.route_and_execute(
                AiCapability.TEXT_ANALYSIS,
                handler,
                total_budget_seconds=4.0,
            )
        self.assertEqual(ctx.exception.kind, AiErrorKind.TIMEOUT)
        self.assertEqual(ctx.exception.code, "TASK_DEADLINE_EXHAUSTED")
        self.assertEqual(called, ["gemini_primary"])

    async def test_tenant_isolated_versioned_cache_never_shares_private_accounts_or_errors(self):
        router, _ = self._build_router()
        call_count = 0

        async def handler(spec: ProviderSpec, _timeout: float) -> dict[str, Any]:
            nonlocal call_count
            call_count += 1
            return {"call": call_count, "provider": spec.provider_id}

        key_a = build_tenant_cache_key(
            source_hash="sha-page-1",
            revision="rev-1",
            model_version="gemini-3.5-flash-lite",
            prompt_version="p1",
            algorithm_version="v2.0",
            policy_version="grade1-5",
            tenant_scope="parent:alice",
            capability=AiCapability.LAYOUT_CLASSIFICATION,
        )
        key_b = build_tenant_cache_key(
            source_hash="sha-page-1",
            revision="rev-1",
            model_version="gemini-3.5-flash-lite",
            prompt_version="p1",
            algorithm_version="v2.0",
            policy_version="grade1-5",
            tenant_scope="parent:bob",
            capability=AiCapability.LAYOUT_CLASSIFICATION,
        )
        key_a_rev2 = build_tenant_cache_key(
            source_hash="sha-page-1",
            revision="rev-2",
            model_version="gemini-3.5-flash-lite",
            prompt_version="p1",
            algorithm_version="v2.0",
            policy_version="grade1-5",
            tenant_scope="parent:alice",
            capability=AiCapability.LAYOUT_CLASSIFICATION,
        )
        self.assertNotEqual(key_a, key_b)
        self.assertNotEqual(key_a, key_a_rev2)

        r1 = await router.route_and_execute(
            AiCapability.LAYOUT_CLASSIFICATION,
            handler,
            cache_key=key_a,
            tenant_scope="parent:alice",
        )
        r2 = await router.route_and_execute(
            AiCapability.LAYOUT_CLASSIFICATION,
            handler,
            cache_key=key_a,
            tenant_scope="parent:alice",
        )
        self.assertFalse(r1.cached)
        self.assertTrue(r2.cached)
        self.assertEqual(r2.value["call"], 1)

        # Parent B with identical book text MUST NOT get Parent A's cached output!
        r_bob = await router.route_and_execute(
            AiCapability.LAYOUT_CLASSIFICATION,
            handler,
            cache_key=key_b,
            tenant_scope="parent:bob",
        )
        self.assertFalse(r_bob.cached)
        self.assertEqual(r_bob.value["call"], 2)

        # Errors are NEVER cached!
        err_key = build_tenant_cache_key(
            source_hash="sha-err",
            revision="rev-1",
            model_version="m1",
            prompt_version="p1",
            algorithm_version="v2.0",
            policy_version="pol1",
            tenant_scope="parent:alice",
        )

        async def fail_all(spec: ProviderSpec, _timeout: float) -> dict[str, Any]:
            raise classify_http_error(provider_id=spec.provider_id, status_code=503)

        with self.assertRaises(AiRoutingError):
            await router.route_and_execute(
                AiCapability.TEXT_ANALYSIS,
                fail_all,
                cache_key=err_key,
                tenant_scope="parent:alice",
            )
        self.assertIsNone(router.cache.get(err_key, expected_tenant_scope="parent:alice"))

    async def test_private_book_policy_hard_filters_to_local_only(self):
        router, _ = self._build_router()
        called: list[str] = []

        async def handler(spec: ProviderSpec, _timeout: float) -> str:
            called.append(spec.provider_id)
            return spec.provider_id

        res = await router.route_and_execute(
            AiCapability.OCR_PROOFREADING,
            handler,
            allow_cloud=False,
        )
        self.assertEqual(called, ["ollama_local"])
        self.assertEqual(res.provider_id, "ollama_local")

    async def test_real_image_generation_dispatch_cloudflare_gemini_limit0_and_local_diffusers(self):
        env = {
            "SMART_AI_IMAGE_GEN_ENABLED": "true",
            "CLOUDFLARE_ACCOUNT_ID": "cf-acc-123",
            "CLOUDFLARE_API_TOKEN": "super-secret-cf-token",
            "GEMINI_API_KEY": "super-secret-gemini-key",
            "GEMINI_IMAGE_BILLING_ENABLED": "true",
            "LOCAL_IMAGE_GEN_URL": "http://127.0.0.1:8090",
        }
        clk = _FakeClock()
        router = AiCapabilityRouter(
            providers=build_default_provider_registry(env=env),
            clock=clk,
            env=env,
        )

        # Verify snapshot leaks ZERO secrets!
        snap_text = str(router.get_capabilities_snapshot())
        self.assertNotIn("super-secret-cf-token", snap_text)
        self.assertNotIn("super-secret-gemini-key", snap_text)

        seen_urls: list[str] = []

        async def mock_handler(request: httpx.Request) -> httpx.Response:
            seen_urls.append(str(request.url))
            if "api.cloudflare.com" in str(request.url):
                return httpx.Response(200, headers={"content-type": "image/png"}, content=b"\x89PNGcf")
            return httpx.Response(500)

        img_res = await router.generate_image(
            ImageGenerationRequest(prompt="Friendly orange cat watercolor", tenant_scope="admin:catalog"),
            transport=httpx.MockTransport(mock_handler),
        )
        self.assertEqual(img_res.provider_id, "cloudflare_flux")
        self.assertEqual(img_res.image_bytes, b"\x89PNGcf")
        self.assertEqual(len(seen_urls), 1)

        # Now simulate Cloudflare 429 + Gemini Image 429 limit:0 -> Local Diffusers succeeds!
        router.cache.clear_all()
        router.circuit_breaker.reset()

        async def fallback_handler(request: httpx.Request) -> httpx.Response:
            url_str = str(request.url)
            if "api.cloudflare.com" in url_str:
                return httpx.Response(429, text="daily neuron quota exhausted")
            if "generativelanguage.googleapis.com" in url_str:
                return httpx.Response(429, text="Quota exceeded free_tier_requests, limit: 0")
            if "127.0.0.1:8090/generate" in url_str:
                return httpx.Response(200, headers={"content-type": "image/webp"}, content=b"RIFFwebp")
            return httpx.Response(404)

        img_res2 = await router.generate_image(
            ImageGenerationRequest(prompt="Sunny village river", tenant_scope="admin:catalog"),
            transport=httpx.MockTransport(fallback_handler),
        )
        self.assertEqual(img_res2.provider_id, "local_diffusers")
        self.assertEqual(img_res2.image_bytes, b"RIFFwebp")
        self.assertEqual(
            router.circuit_breaker.get_state("quota_group:cloudflare_workers_ai_daily"),
            CircuitState.OPEN,
        )


# ---------------------------------------------------------------------------
# 2. GPU & Workload Priority Scheduler Tests
# ---------------------------------------------------------------------------


class GpuWorkloadSchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_strict_priority_order_and_bounded_vram_concurrency(self):
        clk = _FakeClock()
        scheduler = GpuWorkloadScheduler(
            max_concurrent_gpu_jobs=1,
            max_vram_mb=4096,
            clock=clk,
        )
        execution_order: list[str] = []
        concurrent_peak = 0
        active_now = 0
        blocker = asyncio.Event()

        async def run_job(label: str, prio: WorkloadPriority, hold: bool = False) -> None:
            nonlocal active_now, concurrent_peak
            async with scheduler.acquire(priority=prio, workload_id=label, estimated_vram_mb=2500):
                active_now += 1
                concurrent_peak = max(concurrent_peak, active_now)
                execution_order.append(label)
                if hold:
                    await blocker.wait()
                else:
                    await asyncio.sleep(0)
                active_now -= 1

        # Hold the single GPU slot while enqueueing all priority tiers out-of-order.
        t_hold = asyncio.create_task(run_job("initial_holder", WorkloadPriority.COVER_GEN, hold=True))
        await asyncio.sleep(0)

        queued = [
            asyncio.create_task(run_job("batch", WorkloadPriority.BATCH_MAINTENANCE)),
            asyncio.create_task(run_job("illust", WorkloadPriority.ILLUSTRATION_GEN)),
            asyncio.create_task(run_job("cover", WorkloadPriority.COVER_GEN)),
            asyncio.create_task(run_job("preprocess", WorkloadPriority.PREPROCESSING)),
            asyncio.create_task(run_job("ocr", WorkloadPriority.URGENT_OCR)),
            asyncio.create_task(run_job("reading", WorkloadPriority.INTERACTIVE_READING)),
        ]
        await asyncio.sleep(0)
        blocker.set()
        await asyncio.gather(t_hold, *queued)

        self.assertEqual(concurrent_peak, 1)
        self.assertEqual(
            execution_order,
            ["initial_holder", "reading", "ocr", "preprocess", "cover", "illust", "batch"],
        )

    async def test_cooperative_checkpoint_preemption_for_interactive_reading(self):
        scheduler = GpuWorkloadScheduler(max_concurrent_gpu_jobs=1, max_vram_mb=4096)
        started_bg = asyncio.Event()
        proceed_checkpoint = asyncio.Event()
        events: list[str] = []

        async def background_illustration() -> None:
            try:
                async with scheduler.acquire(
                    priority=WorkloadPriority.ILLUSTRATION_GEN,
                    workload_id="bg-illust",
                ) as handle:
                    events.append("bg-start")
                    started_bg.set()
                    await proceed_checkpoint.wait()
                    self.assertTrue(handle.should_yield())
                    handle.checkpoint("after-step-1", raise_on_preempt=True)
                    events.append("bg-should-not-reach")
            except PreemptionRequested as exc:
                events.append(f"bg-preempted:{exc.stage}")

        async def interactive_reading() -> None:
            async with scheduler.acquire(
                priority=WorkloadPriority.INTERACTIVE_READING,
                workload_id="child-read",
            ):
                events.append("reading-ran")

        bg_task = asyncio.create_task(background_illustration())
        await started_bg.wait()
        read_task = asyncio.create_task(interactive_reading())
        await asyncio.sleep(0)
        proceed_checkpoint.set()
        await asyncio.gather(bg_task, read_task)

        self.assertEqual(events, ["bg-start", "bg-preempted:after-step-1", "reading-ran"])
        self.assertEqual(scheduler.get_status()["total_preemptions"], 1)

    async def test_aging_fairness_prevents_low_priority_starvation_while_keeping_reading_first(self):
        clk = _FakeClock()
        scheduler = GpuWorkloadScheduler(
            max_concurrent_gpu_jobs=1,
            aging_interval_seconds=10.0,
            aging_step=15,
            max_background_aged_priority=89,
            clock=clk,
        )
        blocker = asyncio.Event()
        order: list[str] = []

        async def holder() -> None:
            async with scheduler.acquire(priority=WorkloadPriority.PREPROCESSING, workload_id="hold"):
                await blocker.wait()

        async def worker(label: str, prio: WorkloadPriority) -> None:
            async with scheduler.acquire(priority=prio, workload_id=label):
                order.append(label)

        t_hold = asyncio.create_task(holder())
        await asyncio.sleep(0)

        # Enqueue low-priority BATCH_MAINTENANCE at t=1000
        t_batch = asyncio.create_task(worker("aged_batch", WorkloadPriority.BATCH_MAINTENANCE))
        await asyncio.sleep(0)

        # Advance clock 60s -> BATCH_MAINTENANCE ages from 10 to 89 (beats fresh PREPROCESSING 60!)
        clk.advance(60.0)
        t_fresh_pre = asyncio.create_task(worker("fresh_pre", WorkloadPriority.PREPROCESSING))
        t_reading = asyncio.create_task(worker("interactive", WorkloadPriority.INTERACTIVE_READING))
        await asyncio.sleep(0)

        blocker.set()
        await asyncio.gather(t_hold, t_batch, t_fresh_pre, t_reading)
        # INTERACTIVE_READING (100) still beats aged_batch (89), which beats fresh_pre (60)!
        self.assertEqual(order, ["interactive", "aged_batch", "fresh_pre"])


# ---------------------------------------------------------------------------
# 3. Durable Workflows Engine, Fencing, Checkpoint Resume & 3-Actor IDOR Tests
# ---------------------------------------------------------------------------


class DurableGlobalTasksTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.state = StudioDbState()
        self.db = FakeStudioAsyncSession(self.state)
        self.admin_id = uuid4()
        self.parent_a = uuid4()
        self.parent_b = uuid4()

        self.db.add_all(
            [
                Profile(Id=self.admin_id, Role="admin", Active=1),
                Profile(Id=self.parent_a, Role="parent", Active=1),
                Profile(Id=self.parent_b, Role="parent", Active=1),
            ]
        )
        self.svc = GlobalTasksService(self.db)  # type: ignore[arg-type]

    async def test_idempotent_creation_prevents_double_click_duplicates(self):
        payload = GlobalTaskCreateRequest(
            job_type="COVER_GENERATE",
            input_hash="a" * 32,
            idempotency_key="cover-book-1-v1",
            priority=40,
        )
        first = await self.svc.create_task(actor_id=self.admin_id, payload=payload)
        second = await self.svc.create_task(actor_id=self.admin_id, payload=payload)

        self.assertFalse(first.deduplicated)
        self.assertTrue(second.deduplicated)
        self.assertEqual(first.task.id, second.task.id)
        self.assertEqual(len(self.state.tables[SmartStudioJob]), 1)

        # Different actor with same key gets a distinct job!
        other = await self.svc.create_task(actor_id=self.parent_a, payload=payload)
        self.assertFalse(other.deduplicated)
        self.assertNotEqual(other.task.id, first.task.id)

    async def test_atomic_claim_heartbeat_lease_expiry_reclaim_and_stale_lease_rejection(self):
        t0 = datetime(2026, 11, 25, 10, 0, 0, tzinfo=timezone.utc)
        created = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="OCR_EXTRACT",
                input_hash="h" * 32,
                idempotency_key="extract-1",
                priority=80,
                max_attempts=2,
            ),
        )
        job_id = created.task.id

        # Worker 1 claims atomically
        claimed1 = await self.svc.claim_next_job(worker_id="worker-1", lease_seconds=60, now=t0)
        self.assertIsNotNone(claimed1)
        assert claimed1 is not None
        token1 = claimed1.LeaseToken
        self.assertIsNotNone(token1)
        self.assertEqual(claimed1.AttemptCount, 1)

        # Second claim while locked/running returns None
        self.assertIsNone(await self.svc.claim_next_job(worker_id="worker-2", lease_seconds=60, now=t0))

        # Heartbeat succeeds with valid token and rejects wrong token
        hb_ok = await self.svc.heartbeat(
            job_id=job_id,
            lease_token=token1,
            lease_seconds=60,
            now=t0 + timedelta(seconds=20),
        )
        self.assertIsNotNone(hb_ok)
        self.assertIsNone(
            await self.svc.heartbeat(
                job_id=job_id,
                lease_token=uuid4(),
                lease_seconds=60,
                now=t0 + timedelta(seconds=25),
            )
        )

        # Worker 1 dies -> lease expires at t0 + 80s -> startup reconciler reclaims at t0 + 90s!
        rec1 = await self.svc.reconcile_stale_jobs(
            now=t0 + timedelta(seconds=90),
            retry_backoff_seconds=0,
            reschedule_parent_post_ocr=False,
        )
        self.assertEqual(rec1.reclaimed_studio_jobs, 1)
        job_row = self.state.tables[SmartStudioJob][0]
        self.assertEqual(job_row.Status, "RETRY_SCHEDULED")
        self.assertIsNone(job_row.LeaseToken)

        # Worker 2 claims reclaimed job with a fresh lease token
        claimed2 = await self.svc.claim_next_job(
            worker_id="worker-2",
            lease_seconds=60,
            now=t0 + timedelta(seconds=95),
        )
        self.assertIsNotNone(claimed2)
        assert claimed2 is not None
        token2 = claimed2.LeaseToken
        self.assertNotEqual(token2, token1)
        self.assertEqual(claimed2.AttemptCount, 2)

        # Zombie Worker 1 tries to commit with stale token1 -> MUST BE REJECTED!
        with self.assertRaises(StaleLeaseError):
            await self.svc.commit_stage_result(
                job_id=job_id,
                lease_token=token1,
                stage="OCR",
                next_status="SUCCEEDED",
            )
        self.assertEqual(job_row.Status, "RUNNING")

        # Worker 2 also dies -> attempt 2 >= max_attempts(2) -> reconciler marks FAILED (no infinite loop!)
        rec2 = await self.svc.reconcile_stale_jobs(
            now=t0 + timedelta(seconds=200),
            retry_backoff_seconds=0,
            reschedule_parent_post_ocr=False,
        )
        self.assertEqual(rec2.failed_studio_jobs, 1)
        self.assertEqual(job_row.Status, "FAILED")
        self.assertEqual(job_row.ErrorCode, "WORKER_LEASE_EXPIRED")

    async def test_revision_fencing_marks_job_stale_instead_of_overwriting_newer_revision(self):
        book_id = uuid4()
        page_id = uuid4()
        rev1_id = uuid4()
        rev2_id = uuid4()
        t0 = datetime(2026, 11, 25, 10, 0, 0, tzinfo=timezone.utc)

        self.db.add_all(
            [
                Book(Id=book_id, Title="Truyện Cổ", MinGrade=1, MaxGrade=3, LifecycleStatus="ACTIVE"),
                BookPage(
                    Id=page_id,
                    BookId=book_id,
                    PageNumber=1,
                    ImagePath="books/1/p1.png",
                    Width=800,
                    Height=1000,
                    CurrentVerifiedRevisionId=rev1_id,
                    LifecycleStatus="NEEDS_REVIEW",
                ),
                PageRevision(
                    Id=rev1_id,
                    PageId=page_id,
                    RevisionNo="1",
                    VerificationStatus="NEEDS_REVIEW",
                    ContentHash="1" * 64,
                    CreatedAt=t0,
                ),
            ]
        )

        created = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="ILLUSTRATION_EXTRACT",
                book_id=book_id,
                book_page_id=page_id,
                source_revision_id=rev1_id,
                input_hash="f" * 32,
                idempotency_key="illust-p1-rev1",
            ),
        )
        claimed = await self.svc.claim_next_job(worker_id="w-1", lease_seconds=120, now=t0)
        assert claimed is not None and claimed.LeaseToken is not None

        # Page moves forward to newer revision rev2 while job is still running!
        self.db.add(
            PageRevision(
                Id=rev2_id,
                PageId=page_id,
                RevisionNo="2",
                VerificationStatus="VERIFIED",
                ContentHash="2" * 64,
                CreatedAt=t0 + timedelta(seconds=10),
            )
        )

        outcome = await self.svc.commit_stage_result(
            job_id=created.task.id,
            lease_token=claimed.LeaseToken,
            stage="ILLUSTRATION",
            result_ref={"asset_id": "should-not-commit"},
            next_status="SUCCEEDED",
            now=t0 + timedelta(seconds=15),
        )
        self.assertFalse(outcome["accepted"])
        self.assertEqual(outcome["status"], "STALE")
        self.assertEqual(outcome["reason"], "REVISION_FENCED")
        job_row = self.state.tables[SmartStudioJob][0]
        self.assertEqual(job_row.Status, "STALE")
        self.assertEqual(job_row.ResultRefJson, {})

    async def test_checkpoint_resume_skips_already_completed_stages_on_retry(self):
        ordered_stages = ["BOUNDARY_DETECT", "OCR", "LAYOUT_CLASSIFY"]
        created = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="OCR_EXTRACT",
                input_hash="c" * 32,
                idempotency_key="checkpoint-job-1",
                progress_completed=0,
                progress_total=3,
                progress_unit="bước",
            ),
        )
        job_id = created.task.id
        claimed1 = await self.svc.claim_next_job(worker_id="w-1", lease_seconds=120)
        assert claimed1 is not None and claimed1.LeaseToken is not None

        # Stage 1 succeeds & saves checkpoint
        res1 = await self.svc.commit_stage_result(
            job_id=job_id,
            lease_token=claimed1.LeaseToken,
            stage="BOUNDARY_DETECT",
            checkpoint_data={"angle": -1.2},
            progress_completed=1,
            progress_total=3,
            progress_unit="bước",
        )
        self.assertTrue(res1["accepted"])

        # Stage 2 fails
        await self.svc.commit_stage_result(
            job_id=job_id,
            lease_token=claimed1.LeaseToken,
            stage="OCR",
            mark_stage_completed=False,
            next_status="FAILED",
            error_code="OCR_TIMEOUT",
            error_message_vi="Quá thời gian nhận diện chữ.",
        )

        # User retries -> checkpoints MUST survive and BOUNDARY_DETECT MUST be skipped!
        retried = await self.svc.retry_task(actor_id=self.admin_id, job_id=job_id)
        self.assertEqual(retried.task.status, "QUEUED")
        claimed2 = await self.svc.claim_next_job(worker_id="w-2", lease_seconds=120)
        assert claimed2 is not None
        self.assertEqual(get_remaining_stages(claimed2, ordered_stages), ["OCR", "LAYOUT_CLASSIFY"])
        self.assertEqual(claimed2.CheckpointsJson["stage_outputs"]["BOUNDARY_DETECT"]["angle"], -1.2)

    async def test_cooperative_cancel_and_cancel_vs_complete_race(self):
        # Case A: Cancel QUEUED job -> immediate CANCELLED
        q_job = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="STYLE_BIBLE",
                input_hash="q" * 32,
                idempotency_key="cancel-queued",
            ),
        )
        cancelled_q = await self.svc.cancel_task(actor_id=self.admin_id, job_id=q_job.task.id)
        self.assertEqual(cancelled_q.task.status, "CANCELLED")
        self.assertEqual(cancelled_q.action, "cancelled")

        # Case B: Cancel RUNNING job -> CANCEL_REQUESTED, then worker commit safely transitions to CANCELLED
        r_job = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="COVER_GENERATE",
                input_hash="r" * 32,
                idempotency_key="cancel-running",
            ),
        )
        claimed = await self.svc.claim_next_job(worker_id="w-1", lease_seconds=120)
        assert claimed is not None and claimed.LeaseToken is not None
        req = await self.svc.cancel_task(actor_id=self.admin_id, job_id=r_job.task.id)
        self.assertEqual(req.task.status, "CANCEL_REQUESTED")

        race = await self.svc.commit_stage_result(
            job_id=r_job.task.id,
            lease_token=claimed.LeaseToken,
            stage="COVER",
            result_ref={"cover_asset_id": "discarded"},
            next_status="SUCCEEDED",
        )
        self.assertFalse(race["accepted"])
        self.assertEqual(race["status"], "CANCELLED")
        self.assertEqual(race["reason"], "CANCEL_ACKNOWLEDGED")
        self.assertEqual(claimed.ResultRefJson, {})

        # Further commit on already CANCELLED job raises JobCancelledError
        with self.assertRaises(JobCancelledError):
            await self.svc.commit_stage_result(
                job_id=r_job.task.id,
                lease_token=uuid4(),
                stage="COVER",
                next_status="SUCCEEDED",
            )

        # Case C: Cancel AFTER SUCCEEDED returns 409 and preserves SUCCEEDED!
        done_job = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="STYLE_BIBLE",
                input_hash="d" * 32,
                idempotency_key="complete-before-cancel",
            ),
        )
        claimed_done = await self.svc.claim_next_job(worker_id="w-1", lease_seconds=120)
        assert claimed_done is not None and claimed_done.LeaseToken is not None
        await self.svc.commit_stage_result(
            job_id=done_job.task.id,
            lease_token=claimed_done.LeaseToken,
            stage="STYLE_BIBLE",
            next_status="SUCCEEDED",
        )
        with self.assertRaises(Exception) as exc_ctx:
            await self.svc.cancel_task(actor_id=self.admin_id, job_id=done_job.task.id)
        self.assertEqual(getattr(exc_ctx.exception, "status_code", None), 409)
        self.assertEqual(claimed_done.Status, "SUCCEEDED")

    async def test_unmigrated_smart_studio_jobs_table_degrades_gracefully(self):
        self.state.missing_tables.add("smart_studio_jobs")
        feed = await self.svc.list_tasks(actor_id=self.admin_id)
        self.assertEqual(feed.actor_role, "admin")
        self.assertEqual(feed.tasks, [])

    def test_three_actor_idor_rbac_honest_progress_and_capabilities_via_http(self):
        app = FastAPI()
        app.include_router(global_tasks_router, prefix="/studio")

        book_admin = Book(
            Id=uuid4(), Title="Sách Kho Admin", MinGrade=1, MaxGrade=5,
            LifecycleStatus="ACTIVE", VisibilityScope="CATALOG",
        )
        book_a = Book(
            Id=uuid4(), Title="Sách Riêng Mẹ A", MinGrade=1, MaxGrade=2,
            LifecycleStatus="ACTIVE", VisibilityScope="PARENT_PRIVATE", OwnerParentId=self.parent_a,
        )
        book_b = Book(
            Id=uuid4(), Title="Sách Riêng Mẹ B", MinGrade=1, MaxGrade=2,
            LifecycleStatus="ACTIVE", VisibilityScope="PARENT_PRIVATE", OwnerParentId=self.parent_b,
        )
        now = datetime.now(timezone.utc)
        job_admin = SmartStudioJob(
            Id=uuid4(), JobType="COVER_GENERATE", ActorId=self.admin_id, ActorRole="admin",
            BookId=book_admin.Id, InputHash="1" * 32, IdempotencyKey="adm-1",
            Stage="COVER", Status="RUNNING", Priority=40,
            ProgressCompleted=3, ProgressTotal=10, ProgressUnit="trang",
            CreatedAt=now, UpdatedAt=now,
        )
        job_a = SmartStudioJob(
            Id=uuid4(), JobType="OCR_EXTRACT", ActorId=self.parent_a, ActorRole="parent",
            BookId=book_a.Id, InputHash="2" * 32, IdempotencyKey="par-a-1",
            Stage="OCR", Status="FAILED", Priority=50,
            CreatedAt=now, UpdatedAt=now,
        )
        job_b = SmartStudioJob(
            Id=uuid4(), JobType="OCR_EXTRACT", ActorId=self.parent_b, ActorRole="parent",
            BookId=book_b.Id, InputHash="3" * 32, IdempotencyKey="par-b-1",
            Stage="QUEUED", Status="QUEUED", Priority=50,
            CreatedAt=now, UpdatedAt=now,
        )
        ocr_a = OcrInferenceJob(
            Id=uuid4(), JobKind=JOB_KIND_PARENT_SUBMISSION, Status="QUEUED",
            OwnerUserId=self.parent_a, BookId=book_a.Id,
            ImagePath="private/a.png", ImageSha256="a" * 64,
            CreatedAt=now, UpdatedAt=now,
        )
        ocr_admin = OcrInferenceJob(
            Id=uuid4(), JobKind=JOB_KIND_ADMIN_UPLOAD, Status="RUNNING",
            OwnerUserId=self.admin_id, BookId=book_admin.Id,
            ImagePath="books/adm.png", ImageSha256="b" * 64,
            CreatedAt=now, UpdatedAt=now,
        )
        wf_admin = AdminAiWorkflow(
            Id=uuid4(), PageId=uuid4(), BookId=book_admin.Id, PageRevisionId=uuid4(),
            ActorId=self.admin_id, IdempotencyKey=uuid4(),
            OriginalText="abc", InputText="abc", ImagePath="books/adm.png",
            OriginalOcrHash="1" * 64, AdminInputHash="1" * 64,
            Status="READY_FOR_ADMIN_REVIEW", Stage="CHILD_SAFETY",
            CompletedChunks=2, TotalChunks=2,
            CreatedAt=now, UpdatedAt=now,
        )
        sub_a = ParentBookPageSubmission(
            Id=uuid4(), BookId=book_a.Id, OwnerParentId=self.parent_a,
            BatchId=uuid4(), BatchTotalPages=1, SourcePageNumber=1,
            IdempotencyKey="sub-a", SourceFileName="p1.png", SourceFormat="IMAGE",
            SourceStoragePath="private/a.png", SourceSha256="a" * 64,
            ImageWidth=500, ImageHeight=700, WorkflowStatus="CHECKING",
            OcrStatus="COMPLETED", ProofreadStatus="PENDING", ToolCheckStatus="PENDING",
            CreatedAt=now, UpdatedAt=now,
        )
        self.db.add_all([book_admin, book_a, book_b, job_admin, job_a, job_b, ocr_a, ocr_admin, wf_admin, sub_a])

        active_actor = {"id": self.parent_a}

        async def _fake_get_db():
            yield FakeStudioAsyncSession(self.state)

        def _fake_actor():
            return active_actor["id"]

        app.dependency_overrides[get_db] = _fake_get_db
        app.dependency_overrides[get_current_parent_id] = _fake_actor
        client = TestClient(app)

        # 1. Parent A sees ONLY Parent A's 3 tasks (job_a, ocr_a, sub_a) — ZERO Parent B, ZERO Admin!
        resp_a = client.get("/studio/tasks")
        self.assertEqual(resp_a.status_code, 200)
        self.assertIn("no-store", resp_a.headers.get("cache-control", ""))
        data_a = resp_a.json()
        self.assertEqual(data_a["actor_role"], "parent")
        ids_a = {item["id"] for item in data_a["tasks"]}
        self.assertEqual(ids_a, {str(job_a.Id), str(ocr_a.Id), str(sub_a.Id)})
        self.assertNotIn(str(job_b.Id), ids_a)
        self.assertNotIn(str(job_admin.Id), ids_a)
        self.assertNotIn(str(wf_admin.Id), ids_a)

        # Deterministic staged progress check: ocr_a reports waiting-for-worker staged % (2.0%)!
        ocr_a_item = next(t for t in data_a["tasks"] if t["id"] == str(ocr_a.Id))
        self.assertEqual(ocr_a_item["progress_pct"], 2.0)
        self.assertFalse(ocr_a_item["is_indeterminate"])
        self.assertEqual(ocr_a_item["progress_mode"], "staged")
        self.assertEqual(ocr_a_item["portal"], "parent")
        self.assertEqual(ocr_a_item["actor_id"], str(self.parent_a))
        self.assertEqual(ocr_a_item["status"], "WAITING_FOR_WORKER")
        self.assertEqual(ocr_a_item["status_label_vi"], "Chờ máy xử lý AI kết nối lại")

        # 2. Parent B sees ONLY Parent B's task (job_b) & gets 404/403 on Parent A / Admin actions!
        active_actor["id"] = self.parent_b
        resp_b = client.get("/studio/tasks")
        self.assertEqual(resp_b.status_code, 200)
        ids_b = {item["id"] for item in resp_b.json()["tasks"]}
        self.assertEqual(ids_b, {str(job_b.Id)})

        # Cross-tenant IDOR blocked!
        self.assertEqual(client.post(f"/studio/tasks/{job_a.Id}/retry").status_code, 404)
        self.assertEqual(client.post(f"/studio/tasks/{job_a.Id}/cancel").status_code, 404)
        self.assertEqual(client.post(f"/studio/tasks/{job_admin.Id}/cancel").status_code, 404)
        self.assertEqual(
            client.post(
                "/studio/tasks",
                json={
                    "job_type": "COVER_GENERATE",
                    "book_id": str(book_a.Id),
                    "input_hash": "x" * 32,
                    "idempotency_key": "idor-attempt",
                },
            ).status_code,
            404,
        )
        # Non-admin reconcile blocked (403)!
        self.assertEqual(client.post("/studio/tasks/reconcile").status_code, 403)

        # 3. Admin sees ONLY Admin tasks (job_admin, ocr_admin, wf_admin) — ZERO private parent jobs!
        active_actor["id"] = self.admin_id
        resp_adm = client.get("/studio/tasks")
        self.assertEqual(resp_adm.status_code, 200)
        data_adm = resp_adm.json()
        self.assertEqual(data_adm["actor_role"], "admin")
        ids_adm = {item["id"] for item in data_adm["tasks"]}
        self.assertEqual(ids_adm, {str(job_admin.Id), str(ocr_admin.Id), str(wf_admin.Id)})
        self.assertNotIn(str(job_a.Id), ids_adm)
        self.assertNotIn(str(sub_a.Id), ids_adm)

        # Measured progress check on job_admin (3/10 trang = 30.0%)
        adm_item = next(t for t in data_adm["tasks"] if t["id"] == str(job_admin.Id))
        self.assertEqual(adm_item["progress_completed"], 3)
        self.assertEqual(adm_item["progress_total"], 10)
        self.assertEqual(adm_item["progress_pct"], 30.0)
        self.assertFalse(adm_item["is_indeterminate"])

        # Admin reconcile succeeds (200) and capabilities leaks ZERO secrets!
        self.assertEqual(client.post("/studio/tasks/reconcile").status_code, 200)
        caps = client.get("/studio/capabilities")
        self.assertEqual(caps.status_code, 200)
        caps_json = caps.json()
        self.assertIn("providers", caps_json)
        self.assertIn("circuit_breakers", caps_json)
        self.assertNotIn("api_key", str(caps_json).lower())


# ---------------------------------------------------------------------------
# 4. R-01 Private-Book Cloud-Leak Regression & Orphan Reconciliation Tests
# ---------------------------------------------------------------------------


class R01PrivacyAndOrphanReconcileTests(unittest.IsolatedAsyncioTestCase):
    async def test_r01_private_book_post_ocr_never_leaks_to_cloud_when_disallowed(self):
        state = StudioDbState()
        db = FakeStudioAsyncSession(state)
        parent_id = uuid4()
        book_id = uuid4()
        raw_img = b"private-family-book-page-image"
        img_sha = hashlib.sha256(raw_img).hexdigest()
        cand_hash = compute_candidate_hash("Con meo nho", source_sha256=img_sha, is_image_only=False)
        sub = ParentBookPageSubmission(
            Id=uuid4(),
            BookId=book_id,
            OwnerParentId=parent_id,
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            IdempotencyKey="r01-privacy-test",
            SourceFileName="page1.png",
            SourceFormat="IMAGE",
            SourceStoragePath="private-books/u/b/p1.png",
            SourceSha256=img_sha,
            ImageWidth=600,
            ImageHeight=800,
            SubmissionVersion=1,
            OptimisticLockVersion=1,
            WorkflowStatus="CHECKING",
            OcrStatus="COMPLETED",
            OcrText="Con meo nho",
            OcrWordsJson=[
                {"text": "Con", "bbox": [0.1, 0.1, 0.1, 0.05]},
                {"text": "meo", "bbox": [0.22, 0.1, 0.1, 0.05]},
                {"text": "nho", "bbox": [0.34, 0.1, 0.1, 0.05]},
            ],
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            CandidateText="Con meo nho",
            CandidateHash=cand_hash,
            IsImageOnly=False,
        )
        db.add(sub)

        captured_configs: list[Any] = []

        class _SpyOrchestrator:
            def __init__(self, config: Any):
                captured_configs.append(config)

            async def correct(self, text: str, *_args: Any, **_kwargs: Any) -> str:
                return "Con mèo nhỏ"

        class _CleanSafety:
            async def analyze(self, _text: str) -> dict[str, Any]:
                return {"suitability": "SUITABLE", "findings": [], "provider_events": []}

        with (
            patch.dict(
                os.environ,
                {
                    "OCR_CLOUD_CORRECTION_ENABLED": "true",
                    "GEMINI_API_KEY": "must-not-be-used-for-private-book",
                    "GROQ_API_KEY": "must-not-be-used-for-private-book",
                    "PRIVATE_BOOK_ALLOW_CLOUD_AI": "false",
                },
                clear=False,
            ),
            patch(
                "app.services.ocr_inference_job_service.AsyncSessionLocal",
                side_effect=lambda: _SessionCtx(state),
            ),
            patch(
                "app.services.ocr_ai.orchestrator.OcrCorrectionOrchestrator",
                _SpyOrchestrator,
            ),
        ):
            result = await run_parent_submission_post_ocr(
                sub.Id,
                safety_orchestrator=_CleanSafety(),
                download_bytes=lambda _path: raw_img,
            )

        self.assertEqual(result["status"], "PASSED_READY_TO_ADD")
        self.assertEqual(len(captured_configs), 1)
        cfg = captured_configs[0]
        # CRITICAL R-01 INVARIANT: cloud MUST be disabled and keys stripped for private books!
        self.assertFalse(cfg.cloud_enabled)
        self.assertFalse(cfg.gemini_enabled)
        self.assertFalse(cfg.groq_enabled)
        self.assertIsNone(cfg.gemini_api_key)
        self.assertIsNone(cfg.groq_api_key)

    async def test_r01_reconcile_orphaned_parent_submissions_reclaims_and_caps_attempts(self):
        state = StudioDbState()
        db = FakeStudioAsyncSession(state)
        t0 = datetime(2026, 11, 25, 12, 0, 0, tzinfo=timezone.utc)

        orphan_retryable = ParentBookPageSubmission(
            Id=uuid4(),
            BookId=uuid4(),
            OwnerParentId=uuid4(),
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            IdempotencyKey="orphan-1",
            SourceFileName="p1.png",
            SourceFormat="IMAGE",
            SourceStoragePath="private/o1.png",
            SourceSha256="a" * 64,
            ImageWidth=500,
            ImageHeight=700,
            WorkflowStatus="CHECKING",
            OcrStatus="COMPLETED",
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            Attempts=1,
            OptimisticLockVersion=1,
            UpdatedAt=t0 - timedelta(minutes=5),
        )
        orphan_exhausted = ParentBookPageSubmission(
            Id=uuid4(),
            BookId=uuid4(),
            OwnerParentId=uuid4(),
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=2,
            IdempotencyKey="orphan-2",
            SourceFileName="p2.png",
            SourceFormat="IMAGE",
            SourceStoragePath="private/o2.png",
            SourceSha256="b" * 64,
            ImageWidth=500,
            ImageHeight=700,
            WorkflowStatus="CHECKING",
            OcrStatus="COMPLETED",
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            Attempts=3,
            OptimisticLockVersion=1,
            UpdatedAt=t0 - timedelta(minutes=10),
        )
        fresh_checking = ParentBookPageSubmission(
            Id=uuid4(),
            BookId=uuid4(),
            OwnerParentId=uuid4(),
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=3,
            IdempotencyKey="fresh-3",
            SourceFileName="p3.png",
            SourceFormat="IMAGE",
            SourceStoragePath="private/o3.png",
            SourceSha256="c" * 64,
            ImageWidth=500,
            ImageHeight=700,
            WorkflowStatus="CHECKING",
            OcrStatus="COMPLETED",
            ProofreadStatus="PENDING",
            ToolCheckStatus="PENDING",
            Attempts=0,
            OptimisticLockVersion=1,
            UpdatedAt=t0 - timedelta(seconds=10),
        )
        db.add_all([orphan_retryable, orphan_exhausted, fresh_checking])

        rescheduled: list[UUID] = []
        with patch(
            "app.services.ocr_inference_job_service.schedule_parent_submission_post_ocr",
            side_effect=lambda sid: rescheduled.append(sid),
        ):
            summary = await reconcile_orphaned_parent_submissions(
                db,  # type: ignore[arg-type]
                stale_after_seconds=90,
                max_attempts=3,
                reschedule=True,
                now=t0,
            )

        self.assertEqual(summary["reclaimed_count"], 1)
        self.assertEqual(summary["failed_count"], 1)
        self.assertEqual(rescheduled, [orphan_retryable.Id])
        self.assertEqual(orphan_retryable.Attempts, 2)
        self.assertEqual(orphan_retryable.WorkflowStatus, "CHECKING")
        self.assertEqual(orphan_exhausted.WorkflowStatus, "CHECK_FAILED")
        self.assertEqual(orphan_exhausted.ProofreadErrorCode, "POST_OCR_ORPHANED_MAX_ATTEMPTS")
        self.assertEqual(fresh_checking.Attempts, 0)

    async def test_p0_04_parent_submission_added_to_book_maps_to_succeeded_not_running(self):
        state = StudioDbState()
        db = FakeStudioAsyncSession(state)
        parent_id = uuid4()
        book_id = uuid4()
        db.add(Profile(Id=parent_id, Role="parent", Active=1))
        db.add(
            Book(
                Id=book_id,
                Title="Sách riêng",
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=parent_id,
                LifecycleStatus="ACTIVE",
                IsDeleted=False,
            )
        )
        now = datetime.now(timezone.utc)
        sub_done = ParentBookPageSubmission(
            Id=uuid4(),
            BookId=book_id,
            OwnerParentId=parent_id,
            BatchId=uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            IdempotencyKey="done-1",
            SourceFileName="p1.png",
            SourceFormat="IMAGE",
            SourceStoragePath="private/p1.png",
            SourceSha256="c" * 64,
            ImageWidth=400,
            ImageHeight=600,
            WorkflowStatus="ADDED_TO_BOOK",
            OcrStatus="COMPLETED",
            ProofreadStatus="COMPLETED",
            ToolCheckStatus="PASSED",
            Attempts=1,
            OptimisticLockVersion=1,
            CreatedAt=now,
            UpdatedAt=now,
        )
        db.add(sub_done)
        svc = GlobalTasksService(db)  # type: ignore[arg-type]
        feed = await svc.list_tasks(actor_id=parent_id)
        self.assertEqual(feed.active_count, 0)
        self.assertEqual(len(feed.tasks), 1)
        self.assertEqual(feed.tasks[0].status, "SUCCEEDED")

    async def test_p1_03_half_open_circuit_releases_probe_after_invalid_output(self):
        fake_now = [100.0]
        clk = lambda: fake_now[0]
        prov = ProviderSpec(
            provider_id="gemini_primary",
            model_id="gemini-3.5-flash-lite",
            family="gemini",
            quota_group="gemini_free_shared",
            capabilities=frozenset({AiCapability.LAYOUT_CLASSIFICATION}),
            enabled=True,
            priority_order=1,
        )
        cb = CircuitBreakerRegistry(clock=clk, base_cooldown_seconds=30.0)
        router = AiCapabilityRouter(providers=(prov,), circuit_breaker=cb, clock=clk)
        # Trip circuit with 503
        async def fail_503(_p, _t):
            raise AiProviderCallError(
                provider_id="gemini_primary",
                kind=AiErrorKind.RATE_LIMIT,
                http_status=503,
            )

        with self.assertRaises(AiRoutingError):
            await router.route_and_execute(
                AiCapability.LAYOUT_CLASSIFICATION,
                fail_503,
                allow_cloud=True,
            )
        # Advance past cooldown -> HALF_OPEN
        fake_now[0] += 300.0

        # Non-circuit-tripping INVALID_OUTPUT must NOT permanently lock HALF_OPEN!
        async def fail_invalid(_p, _t):
            raise AiProviderCallError(
                provider_id="gemini_primary",
                kind=AiErrorKind.INVALID_OUTPUT,
            )

        with self.assertRaises(AiRoutingError):
            await router.route_and_execute(
                AiCapability.LAYOUT_CLASSIFICATION,
                fail_invalid,
                allow_cloud=True,
            )

        # Next call must be allowed and recover to CLOSED!
        async def succeed(_p, _t):
            return {"ok": True}

        res = await router.route_and_execute(
            AiCapability.LAYOUT_CLASSIFICATION,
            succeed,
            allow_cloud=True,
        )
        self.assertEqual(res.value, {"ok": True})

    async def test_p0_06_runtime_worker_claims_and_executes_studio_job_and_redacts_parent_capabilities(
        self,
    ):
        from app.services.global_tasks_service import process_one_smart_studio_job

        state = StudioDbState()
        db = FakeStudioAsyncSession(state)
        parent_id = uuid4()
        book_id = uuid4()
        db.add(Profile(Id=parent_id, Role="parent", Active=1))
        db.add(
            Book(
                Id=book_id,
                Title="Sách kiểm thử worker",
                MinGrade=1,
                MaxGrade=5,
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=parent_id,
                LifecycleStatus="ACTIVE",
                IsDeleted=False,
            )
        )
        svc = GlobalTasksService(db)  # type: ignore[arg-type]
        # 1. Parent capabilities redacts global circuit breakers / cache / scheduler telemetry
        caps = await svc.get_capabilities(actor_id=parent_id)
        self.assertEqual(caps.circuit_breakers, {})
        self.assertEqual(caps.cache_entries, 0)
        self.assertEqual(caps.scheduler, {})

        # 2. Enqueue a job and let process_one_smart_studio_job claim + execute it
        created = await svc.create_task(
            actor_id=parent_id,
            payload=GlobalTaskCreateRequest(
                job_type="COVER_GENERATE",
                book_id=book_id,
                idempotency_key="worker-exec-1",
                input_hash="a" * 64,
            ),
        )
        self.assertEqual(created.task.status, "QUEUED")
        with patch.dict(
            os.environ,
            {"CLOUDFLARE_ACCOUNT_ID": "", "CLOUDFLARE_API_TOKEN": "", "LOCAL_IMAGE_GEN_URL": ""},
            clear=False,
        ):
            ran = await process_one_smart_studio_job(db, worker_id="test-worker-1")  # type: ignore[arg-type]
        self.assertTrue(ran)
        feed = await svc.list_tasks(actor_id=parent_id)
        matching = [item for item in feed.tasks if item.id == created.task.id]
        self.assertEqual(len(matching), 1)
        # Honest failure with BLOCKED_NO_IMAGE_PROVIDER (job did NOT stay stuck in QUEUED!)
        self.assertEqual(matching[0].status, "FAILED")
        self.assertEqual(matching[0].error_code, "BLOCKED_NO_IMAGE_PROVIDER")

        # 3. STYLE_BIBLE real DTO dispatch succeeds cleanly with context_hash & book_id
        style_created = await svc.create_task(
            actor_id=parent_id,
            payload=GlobalTaskCreateRequest(
                job_type="STYLE_BIBLE",
                book_id=book_id,
                idempotency_key="worker-style-1",
                input_hash="b" * 64,
            ),
        )
        ran_style = await process_one_smart_studio_job(db, worker_id="test-worker-1")  # type: ignore[arg-type]
        self.assertTrue(ran_style)
        feed2 = await svc.list_tasks(actor_id=parent_id)
        style_item = next(item for item in feed2.tasks if item.id == style_created.task.id)
        self.assertEqual(style_item.status, "SUCCEEDED")
        self.assertIn("context_hash", style_item.result_ref)

        # 4. Suspended private book (ModerationStatus='SUSPENDED') is blocked for Parent
        suspended_book_id = uuid4()
        db.add(
            Book(
                Id=suspended_book_id,
                Title="Sách bị tạm khóa",
                MinGrade=1,
                MaxGrade=5,
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=parent_id,
                LifecycleStatus="ACTIVE",
                ModerationStatus="SUSPENDED",
                IsDeleted=False,
            )
        )
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            await svc.create_task(
                actor_id=parent_id,
                payload=GlobalTaskCreateRequest(
                    job_type="STYLE_BIBLE",
                    book_id=suspended_book_id,
                    idempotency_key="suspended-book-1",
                    input_hash="c" * 64,
                ),
            )
        self.assertEqual(ctx.exception.status_code, 404)

        # 5. Parent GET /studio/capabilities via real FastAPI response_model returns HTTP 200
        app = FastAPI()
        app.include_router(global_tasks_router, prefix="/studio")
        app.dependency_overrides[get_current_parent_id] = lambda: parent_id

        async def _override_db():
            yield FakeStudioAsyncSession(state)

        app.dependency_overrides[get_db] = _override_db
        client = TestClient(app)
        resp = client.get("/studio/capabilities")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["circuit_breakers"], {})
        self.assertEqual(body["cache_entries"], 0)
        for p in body["providers"]:
            self.assertEqual(p["quota_group_circuit_state"], "CLOSED")


if __name__ == "__main__":
    unittest.main()
