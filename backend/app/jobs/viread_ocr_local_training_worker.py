from __future__ import annotations

import asyncio
import os
import signal

from app.jobs.viread_ocr_training_auto_worker import run_local_training_worker


async def _run() -> None:
    enabled = os.getenv("VIREAD_LOCAL_TRAINING_ENABLED", "false").strip().lower() in {
        "1", "true", "yes", "on",
    }
    if not enabled:
        raise RuntimeError("Set VIREAD_LOCAL_TRAINING_ENABLED=true before starting the dedicated local trainer")
    from app.jobs.viread_ocr_training_auto_worker import local_training_capacity

    ready, details = await asyncio.to_thread(local_training_capacity)
    if not ready and details.get("reason") in {
        "LOCAL_TRAINING_DISABLED", "CUDA_UNAVAILABLE", "PYTORCH_CPU_BUILD", "CUDA_PROBE_FAILED",
    }:
        print(f"Local VietOCR trainer not started: {details.get('reason', 'LOCAL_CAPACITY_UNAVAILABLE')}")
        return
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_args: loop.call_soon_threadsafe(stop.set))
    await run_local_training_worker(stop)


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
