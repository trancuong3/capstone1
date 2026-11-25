"""Sliding-window in-memory HTTP 429 rate limiter for cost- and compute-sensitive routes."""

from __future__ import annotations

import math
import os
import threading
import time
from collections import deque
from uuid import UUID

from fastapi import Depends, HTTPException, status

from app.api.deps import get_current_parent_id

_MAX_TRACKED_KEYS = 10_000


def _read_int_env(name: str, default: int, *, minimum: int = 1) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


def _read_float_env(name: str, default: float, *, minimum: float = 1.0) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return max(minimum, float(raw))
    except ValueError:
        return default


class SlidingWindowRateLimiter:
    """Thread-safe per-subject sliding-window rate limiter with bounded memory."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: dict[tuple[str, str], deque[float]] = {}
        self._overrides: dict[str, tuple[int, float]] = {}

    def reset(self) -> None:
        with self._lock:
            self._events.clear()
            self._overrides.clear()

    def set_override(
        self,
        bucket: str,
        max_requests: int | None,
        window_seconds: float | None = None,
    ) -> None:
        with self._lock:
            if max_requests is None or window_seconds is None:
                self._overrides.pop(bucket, None)
            else:
                self._overrides[bucket] = (max(1, int(max_requests)), max(0.05, float(window_seconds)))

    def resolve_limits(self, bucket: str, default_max: int, default_window: float) -> tuple[int, float]:
        with self._lock:
            override = self._overrides.get(bucket)
        if override is not None:
            return override
        env_prefix = f"VIREAD_RATE_LIMIT_{bucket.upper()}"
        max_req = _read_int_env(f"{env_prefix}_MAX", default_max)
        window_s = _read_float_env(f"{env_prefix}_WINDOW_SECONDS", default_window)
        return max_req, window_s

    def check(self, bucket: str, subject: str, *, max_requests: int, window_seconds: float) -> int | None:
        """Record a request if under limit, or return integer Retry-After seconds when throttled."""
        now = time.monotonic()
        cutoff = now - window_seconds
        key = (bucket, subject)
        with self._lock:
            if len(self._events) >= _MAX_TRACKED_KEYS and key not in self._events:
                stale = [k for k, q in self._events.items() if not q or q[-1] <= cutoff]
                for k in stale:
                    self._events.pop(k, None)
                if len(self._events) >= _MAX_TRACKED_KEYS:
                    oldest_key = next(iter(self._events))
                    self._events.pop(oldest_key, None)

            queue = self._events.get(key)
            if queue is None:
                queue = deque()
                self._events[key] = queue

            while queue and queue[0] <= cutoff:
                queue.popleft()

            if len(queue) >= max_requests:
                retry_after = max(1, int(math.ceil(queue[0] + window_seconds - now)))
                return retry_after

            queue.append(now)
            return None


rate_limiter = SlidingWindowRateLimiter()


def clear_rate_limits() -> None:
    """Reset sliding-window counters and test overrides."""
    rate_limiter.reset()


def rate_limit(
    bucket: str,
    *,
    default_max: int,
    default_window: float = 60.0,
    actor_dependency=get_current_parent_id,
):
    """Build a FastAPI dependency enforcing a sliding-window per-actor limit."""

    async def _enforce_rate_limit(actor_id: UUID = Depends(actor_dependency)) -> None:
        max_requests, window_seconds = rate_limiter.resolve_limits(
            bucket, default_max, default_window
        )
        retry_after = rate_limiter.check(
            bucket,
            str(actor_id),
            max_requests=max_requests,
            window_seconds=window_seconds,
        )
        if retry_after is not None:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "code": "RATE_LIMIT_EXCEEDED",
                    "message": "Too many requests. Please slow down and try again shortly.",
                },
                headers={"Retry-After": str(retry_after)},
            )

    return _enforce_rate_limit
