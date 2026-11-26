"""GPU & workload priority scheduler with VRAM guard, cooperative preemption & aging fairness.

Protects 4GB / 6GB VRAM hosts (e.g., GTX 1650 / RTX 3060 Laptop) from concurrent OCR + image
generation OOM while guaranteeing live child interactive reading always stays top priority
and low-priority background tasks never starve indefinitely.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import IntEnum
import threading
import time
from typing import Any, TypeVar
from uuid import uuid4

T = TypeVar("T")


class WorkloadPriority(IntEnum):
    """Strict priority tiers from ADR-07."""

    INTERACTIVE_READING = 100
    URGENT_OCR = 80
    PREPROCESSING = 60
    COVER_GEN = 40
    ILLUSTRATION_GEN = 30
    BATCH_MAINTENANCE = 10


class PreemptionRequested(RuntimeError):
    """Raised cooperatively at a safe checkpoint when a higher-priority workload waits."""

    def __init__(self, workload_id: str, stage: str, waiting_priority: int) -> None:
        super().__init__(
            f"Workload {workload_id} yielded at stage '{stage}' for higher-priority tier {waiting_priority}"
        )
        self.workload_id = workload_id
        self.stage = stage
        self.waiting_priority = waiting_priority


@dataclass
class _QueuedWaiter:
    workload_id: str
    base_priority: int
    estimated_vram_mb: int
    enqueued_at: float
    seq: int
    event: asyncio.Event = field(default_factory=asyncio.Event)
    granted: bool = False
    cancelled: bool = False


@dataclass
class _ActiveWorkload:
    workload_id: str
    base_priority: int
    estimated_vram_mb: int
    started_at: float
    last_stage: str = "STARTED"
    checkpoints: list[str] = field(default_factory=list)


class WorkloadExecutionHandle:
    """Cooperative execution handle provided to a scheduled GPU/CPU workload."""

    def __init__(
        self,
        scheduler: "GpuWorkloadScheduler",
        active: _ActiveWorkload,
    ) -> None:
        self._scheduler = scheduler
        self._active = active
        self.workload_id = active.workload_id
        self.base_priority = active.base_priority

    def should_yield(self) -> bool:
        """Return True if a strictly higher-priority workload is waiting for GPU capacity."""
        highest_waiting = self._scheduler.highest_waiting_effective_priority()
        return highest_waiting is not None and highest_waiting > self.base_priority

    def checkpoint(
        self,
        stage: str,
        *,
        raise_on_preempt: bool = False,
    ) -> bool:
        """Record a safe checkpoint boundary; optionally raise PreemptionRequested if yielding."""
        self._active.last_stage = stage
        self._active.checkpoints.append(stage)
        highest_waiting = self._scheduler.highest_waiting_effective_priority()
        needs_yield = highest_waiting is not None and highest_waiting > self.base_priority
        if needs_yield and raise_on_preempt:
            raise PreemptionRequested(
                workload_id=self.workload_id,
                stage=stage,
                waiting_priority=int(highest_waiting),
            )
        return needs_yield


class GpuWorkloadScheduler:
    """Bounded-concurrency priority scheduler with VRAM budgeting & starvation-proof aging."""

    def __init__(
        self,
        *,
        max_concurrent_gpu_jobs: int = 1,
        max_vram_mb: int = 4096,
        aging_interval_seconds: float = 15.0,
        aging_step: int = 10,
        max_background_aged_priority: int = 89,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_concurrent_gpu_jobs = max(1, int(max_concurrent_gpu_jobs))
        self.max_vram_mb = max(512, int(max_vram_mb))
        self.aging_interval_seconds = max(0.01, float(aging_interval_seconds))
        self.aging_step = max(1, int(aging_step))
        # Keep aged background tasks strictly below INTERACTIVE_READING (100)!
        self.max_background_aged_priority = min(
            int(WorkloadPriority.INTERACTIVE_READING) - 1,
            int(max_background_aged_priority),
        )
        self._clock = clock

        self._seq = 0
        self._waiters: list[_QueuedWaiter] = []
        self._active: dict[str, _ActiveWorkload] = {}
        self._in_use_vram_mb = 0
        self._total_completed = 0
        self._total_preemptions = 0

    def effective_priority(self, base_priority: int, enqueued_at: float, now: float | None = None) -> int:
        """Compute priority with aging boost while preserving INTERACTIVE_READING dominance."""
        if base_priority >= int(WorkloadPriority.INTERACTIVE_READING):
            return int(base_priority)
        current = self._clock() if now is None else now
        waited = max(0.0, current - enqueued_at)
        boost = int(waited // self.aging_interval_seconds) * self.aging_step
        return min(self.max_background_aged_priority, int(base_priority) + boost)

    def highest_waiting_effective_priority(self) -> int | None:
        now = self._clock()
        best: int | None = None
        for waiter in self._waiters:
            if waiter.cancelled or waiter.granted:
                continue
            eff = self.effective_priority(waiter.base_priority, waiter.enqueued_at, now=now)
            if best is None or eff > best:
                best = eff
        return best

    def _can_admit(self, estimated_vram_mb: int) -> bool:
        if len(self._active) >= self.max_concurrent_gpu_jobs:
            return False
        if not self._active:
            # Always admit at least one workload even if its estimate exceeds soft VRAM cap,
            # so a single task never deadlocks forever.
            return True
        return (self._in_use_vram_mb + estimated_vram_mb) <= self.max_vram_mb

    def _dispatch_next_waiters(self) -> None:
        """Wake highest effective-priority waiting tasks that fit inside concurrency & VRAM bounds."""
        now = self._clock()
        while True:
            pending = [w for w in self._waiters if not w.cancelled and not w.granted]
            if not pending:
                break
            pending.sort(
                key=lambda w: (
                    -self.effective_priority(w.base_priority, w.enqueued_at, now=now),
                    -w.base_priority,
                    w.seq,
                )
            )
            admitted_any = False
            for candidate in pending:
                if self._can_admit(candidate.estimated_vram_mb):
                    candidate.granted = True
                    self._waiters.remove(candidate)
                    active = _ActiveWorkload(
                        workload_id=candidate.workload_id,
                        base_priority=candidate.base_priority,
                        estimated_vram_mb=candidate.estimated_vram_mb,
                        started_at=now,
                    )
                    self._active[candidate.workload_id] = active
                    self._in_use_vram_mb += candidate.estimated_vram_mb
                    candidate.event.set()
                    admitted_any = True
                    break
            if not admitted_any:
                break

    @asynccontextmanager
    async def acquire(
        self,
        *,
        priority: WorkloadPriority | int,
        workload_id: str | None = None,
        estimated_vram_mb: int = 1500,
        timeout_seconds: float | None = None,
    ) -> AsyncIterator[WorkloadExecutionHandle]:
        """Acquire a bounded GPU/heavy-compute execution slot in strict priority order."""
        wid = workload_id or f"wl-{uuid4().hex[:10]}"
        vram = max(0, int(estimated_vram_mb))
        prio = int(priority)
        now = self._clock()

        if not self._waiters and self._can_admit(vram):
            active = _ActiveWorkload(
                workload_id=wid,
                base_priority=prio,
                estimated_vram_mb=vram,
                started_at=now,
            )
            self._active[wid] = active
            self._in_use_vram_mb += vram
        else:
            self._seq += 1
            waiter = _QueuedWaiter(
                workload_id=wid,
                base_priority=prio,
                estimated_vram_mb=vram,
                enqueued_at=now,
                seq=self._seq,
            )
            self._waiters.append(waiter)
            try:
                if timeout_seconds is not None:
                    await asyncio.wait_for(waiter.event.wait(), timeout=timeout_seconds)
                else:
                    await waiter.event.wait()
            except BaseException:
                waiter.cancelled = True
                if waiter in self._waiters:
                    self._waiters.remove(waiter)
                if waiter.granted:
                    self._release(wid)
                raise
            active = self._active[wid]

        handle = WorkloadExecutionHandle(self, active)
        preempted = False
        try:
            yield handle
        except PreemptionRequested:
            preempted = True
            self._total_preemptions += 1
            raise
        finally:
            self._release(wid, completed=not preempted)

    def _release(self, workload_id: str, *, completed: bool = True) -> None:
        active = self._active.pop(workload_id, None)
        if active is not None:
            self._in_use_vram_mb = max(0, self._in_use_vram_mb - active.estimated_vram_mb)
            if completed:
                self._total_completed += 1
        self._dispatch_next_waiters()

    async def run(
        self,
        *,
        priority: WorkloadPriority | int,
        coro_factory: Callable[[WorkloadExecutionHandle], Awaitable[T]],
        workload_id: str | None = None,
        estimated_vram_mb: int = 1500,
        timeout_seconds: float | None = None,
    ) -> T:
        async with self.acquire(
            priority=priority,
            workload_id=workload_id,
            estimated_vram_mb=estimated_vram_mb,
            timeout_seconds=timeout_seconds,
        ) as handle:
            return await coro_factory(handle)

    def get_status(self) -> dict[str, Any]:
        now = self._clock()
        queued_by_tier: dict[str, int] = {}
        for waiter in self._waiters:
            if waiter.cancelled or waiter.granted:
                continue
            tier_name = str(waiter.base_priority)
            for member in WorkloadPriority:
                if member.value == waiter.base_priority:
                    tier_name = member.name
                    break
            queued_by_tier[tier_name] = queued_by_tier.get(tier_name, 0) + 1
        return {
            "max_concurrent_gpu_jobs": self.max_concurrent_gpu_jobs,
            "active_count": len(self._active),
            "queued_count": sum(queued_by_tier.values()),
            "queued_by_tier": queued_by_tier,
            "max_vram_mb": self.max_vram_mb,
            "in_use_vram_mb": self._in_use_vram_mb,
            "highest_waiting_priority": self.highest_waiting_effective_priority(),
            "total_completed": self._total_completed,
            "total_preemptions": self._total_preemptions,
            "active_workloads": [
                {
                    "workload_id": item.workload_id,
                    "base_priority": item.base_priority,
                    "estimated_vram_mb": item.estimated_vram_mb,
                    "last_stage": item.last_stage,
                    "elapsed_seconds": round(max(0.0, now - item.started_at), 2),
                }
                for item in self._active.values()
            ],
        }


_DEFAULT_SCHEDULER_LOCK = threading.Lock()
_DEFAULT_SCHEDULER: GpuWorkloadScheduler | None = None


def get_default_gpu_scheduler() -> GpuWorkloadScheduler:
    global _DEFAULT_SCHEDULER
    with _DEFAULT_SCHEDULER_LOCK:
        if _DEFAULT_SCHEDULER is None:
            _DEFAULT_SCHEDULER = GpuWorkloadScheduler()
        return _DEFAULT_SCHEDULER


def reset_default_gpu_scheduler() -> None:
    global _DEFAULT_SCHEDULER
    with _DEFAULT_SCHEDULER_LOCK:
        _DEFAULT_SCHEDULER = None
