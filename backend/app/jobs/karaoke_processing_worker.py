"""Independent karaoke worker: python -m app.jobs.karaoke_processing_worker."""
import argparse
import asyncio
from copy import deepcopy
import json
import logging
from pathlib import Path
import shutil
import signal
import tempfile
from uuid import uuid4

from fastapi import HTTPException

from app.core.karaoke_processing_config import KaraokeProcessingConfig, KaraokeConfigurationError
from app.providers.karaoke_local_aligner_client import (
    KaraokeEngineError, KaraokeLeaseLost, LocalKaraokeClient,
)
from app.repositories.karaoke_processing_repository import KaraokeProcessingRepository, freeze
from app.services.karaoke_alignment import AlignmentRejected
from app.services.karaoke_media_service import inspect_audio
from app.services.karaoke_processing_pipeline import KaraokeProcessingPipeline, MediaAsset
from app.services.karaoke_processing_review import fingerprint, snapshot_matches
from app.services.karaoke_storage_service import KaraokeStorage
from app.services.worker_telemetry import record_worker_error, record_worker_success

logger = logging.getLogger(__name__)
LOCAL_PROOF = {"execution": "OFFLINE_LOCAL_V1", "external_charge_possible": False}


async def _settle_heartbeat(task, *, timeout=5):
    """Let an in-flight SQL heartbeat close normally after finished is signaled.

    Cancellation interrupts asyncpg connection close if sent during its context
    exit. Idle heartbeats wake immediately; an unresponsive heartbeat still has
    a bounded grace period and its owned task is always reaped.
    """
    settled = asyncio.gather(task, return_exceptions=True)
    try:
        await asyncio.wait_for(asyncio.shield(settled), timeout=timeout)
    except TimeoutError:
        logger.warning("karaoke_heartbeat_shutdown_timeout")
    finally:
        if not task.done():
            task.cancel()
        await settled


def _workspace(root, job_id):
    root = Path(root).resolve()
    if (len(root.parts) < 3 or root == Path.home().resolve()
            or root == Path.cwd().resolve() or root in Path.cwd().resolve().parents):
        raise KaraokeConfigurationError("KARAOKE_TEMP_DIR")
    root.mkdir(parents=True, exist_ok=True)
    return root, Path(tempfile.mkdtemp(prefix=f"job-{job_id}-", dir=root))


class ProcessingContext:
    def __init__(self, job, sessions, config, storage, workspace, cancel):
        self.job, self.sessions, self.config = job, sessions, config
        self.storage, self.workspace, self.cancel = storage, workspace, cancel

    async def guard(self, stage):
        if self.cancel.is_set():
            raise KaraokeLeaseLost()
        current = False
        async with self.sessions() as db:
            repo = KaraokeProcessingRepository(db)
            async with repo.write():
                # This is a new transaction after claim; take song before job.
                state = await repo.songs.state(self.job.song_id, lock=True)
                job = await repo.locked_running(self.job.id, self.job.lease_token)
                if state is not None and job is not None:
                    if snapshot_matches(state, job):
                        current = await repo.progress(job.id, job.lease_token, stage=stage)
                    else:
                        repo.stale(job)
        if not current:
            self.cancel.set()
            raise KaraokeLeaseLost()

    async def download(self, asset, label):
        if self.cancel.is_set():
            raise KaraokeLeaseLost()
        try:
            data = await asyncio.to_thread(self.storage.download, asset.path, self.job.song_id, asset.size_bytes)
            info = await asyncio.to_thread(inspect_audio, data)
            if (info.sha256, info.size_bytes, info.duration_ms) != (
                    asset.sha256, asset.size_bytes, asset.duration_ms):
                raise ValueError()
            path = self.workspace / f"{label}-{uuid4()}.mp3"
            await asyncio.to_thread(path.write_bytes, data)
            return path
        except HTTPException:
            raise KaraokeEngineError("MEDIA_UNAVAILABLE") from None
        except ValueError:
            raise KaraokeEngineError("MEDIA_UNAVAILABLE") from None

    async def upload(self, path):
        if self.cancel.is_set():
            raise KaraokeLeaseLost()
        path = Path(path).resolve(strict=True)
        if not path.is_relative_to(self.workspace.resolve()) or not 1 <= path.stat().st_size <= 20971520:
            raise KaraokeEngineError("INVALID_PROVIDER_RESULT")
        data = await asyncio.to_thread(path.read_bytes)
        try:
            info = await asyncio.to_thread(inspect_audio, data)
        except HTTPException:
            raise KaraokeEngineError("INVALID_PROVIDER_RESULT") from None
        target = f"songs/{self.job.song_id}/versions/{self.job.draft_version_id}/audio/{uuid4()}.mp3"
        await asyncio.to_thread(self.storage.upload, target, self.job.song_id, data, "audio/mpeg")
        # Uploaded objects are immutable. Never delete after ambiguous DB commit;
        # dry-run cleanup can audit genuine orphans later.
        return MediaAsset(target, info.sha256, info.size_bytes, info.duration_ms)

    async def _cached(self, key, input_hash, provider, model):
        async with self.sessions() as db:
            repo = KaraokeProcessingRepository(db)
            async with repo.read():
                current = await repo.get(self.job.id, self.job.song_id)
                sources = [current] if current else []
                if self.job.retry_of_job_id:
                    parent = await repo.get(self.job.retry_of_job_id, self.job.song_id)
                    if parent:
                        sources.append(parent)
                for source in sources:
                    if (source.input_fingerprint != self.job.input_fingerprint
                            or source.pipeline_version != self.job.pipeline_version):
                        continue
                    for op in reversed(await repo.operations(source.id)):
                        if (op.state == "COMPLETED" and op.step_key == key
                                and op.step_input_fingerprint == input_hash and op.provider == provider
                                and op.model_version == model and op.pipeline_version == self.job.pipeline_version):
                            usage = deepcopy(op.usage)
                            keys = usage.get("checkpoint_keys", [])
                            if (not isinstance(keys, list) or set(keys) - {"result_lyrics", "quality_report"}):
                                continue
                            checkpoint = {name: deepcopy(getattr(source, name)) for name in keys}
                            result = usage.get("result")
                            if isinstance(result, dict) and op.result_digest == fingerprint(
                                    dict(usage=result, checkpoint=checkpoint)):
                                return source.id, result, checkpoint
        return None

    async def step(self, stage, key, input_hash, provider, model, perform, hydrate):
        await self.guard(stage)
        product, reused = None, False
        cached = await self._cached(key, input_hash, provider, model)
        if cached:
            try:
                product = await hydrate(cached[1], cached[2])
                reused = True
            except (HTTPException, KaraokeEngineError, ValueError, KeyError, TypeError, OSError):
                # Missing/corrupt artifacts cannot be reused. Local recomputation
                # is bounded by the same attempt and reservation controls.
                product = None
            if product is not None and cached[0] == self.job.id:
                await self.guard(stage)
                return product

        async with self.sessions() as db:
            repo = KaraokeProcessingRepository(db)
            async with repo.write():
                operations = await repo.operations(self.job.id)
                if sum(op.step_key == key for op in operations) >= self.config.max_safe_attempts:
                    raise KaraokeEngineError("INVALID_PROVIDER_RESULT")
                operation = await repo.prepare_operation(
                    self.job.id, self.job.lease_token, stage=stage, step_key=key,
                    step_input_fingerprint=input_hash, provider=provider, model_version=model,
                    usage=LOCAL_PROOF,
                )
                if operation is None:
                    raise KaraokeLeaseLost()
        async with self.sessions() as db:
            repo = KaraokeProcessingRepository(db)
            async with repo.write():
                if not await repo.operation_transition(self.job.id, self.job.lease_token,
                                                       operation.id, state="SUBMITTED"):
                    raise KaraokeLeaseLost()
        try:
            if product is None:
                await self.guard(stage)
                product = await perform()
            usage = {**LOCAL_PROOF, "result": product.usage,
                     "checkpoint_keys": sorted(product.checkpoint), "reused": reused}
            if len(json.dumps(usage, ensure_ascii=False).encode()) > 30000:
                raise KaraokeEngineError("INVALID_PROVIDER_RESULT")
            async with self.sessions() as db:
                repo = KaraokeProcessingRepository(db)
                async with repo.write():
                    if not await repo.operation_transition(
                        self.job.id, self.job.lease_token, operation.id, state="COMPLETED",
                        usage=usage, artifact_paths=product.artifact_paths,
                        result_digest=fingerprint(dict(usage=product.usage, checkpoint=product.checkpoint)),
                    ):
                        raise KaraokeLeaseLost()
                    if product.checkpoint and not await repo.progress(
                            self.job.id, self.job.lease_token, stage=stage, **product.checkpoint):
                        raise KaraokeLeaseLost()
            return product
        except BaseException:
            # Keep intent and any possible work. Lease loss prevents even this
            # transition; recovery reads the preserved ledger in that case.
            try:
                async with self.sessions() as db:
                    repo = KaraokeProcessingRepository(db)
                    async with repo.write():
                        await repo.operation_transition(self.job.id, self.job.lease_token,
                                                        operation.id, state="UNKNOWN")
            except Exception:
                logger.warning("karaoke_operation_outcome_unrecorded job_id=%s step=%s", self.job.id, key)
            raise


class KaraokeProcessingWorker:
    def __init__(self, sessions, config, *, storage_factory=KaraokeStorage, client_factory=LocalKaraokeClient):
        self.sessions, self.config = sessions, config
        self.storage_factory, self.client_factory = storage_factory, client_factory

    async def _heartbeat(self, job, cancel, finished):
        while not finished.is_set() and not cancel.is_set():
            try:
                await asyncio.wait_for(finished.wait(), timeout=self.config.heartbeat_seconds)
                return
            except TimeoutError:
                pass
            try:
                async with self.sessions() as db:
                    repo = KaraokeProcessingRepository(db)
                    async with repo.write():
                        alive = await repo.heartbeat(job.id, job.lease_token, self.config.lease_seconds)
                if not alive:
                    cancel.set()
                    return
            except Exception:
                logger.warning("karaoke_heartbeat_unavailable job_id=%s", job.id)
                cancel.set()
                return

    async def process(self, job, shutdown=None):
        cancel, finished = asyncio.Event(), asyncio.Event()
        heartbeat = asyncio.create_task(self._heartbeat(job, cancel, finished))
        watcher = asyncio.create_task(shutdown.wait()) if shutdown is not None else None
        async def propagate_shutdown():
            if watcher:
                await watcher
                cancel.set()
        propagation = asyncio.create_task(propagate_shutdown())
        root = workspace = None
        try:
            if job.pipeline_version != self.config.pipeline_version:
                raise KaraokeEngineError("PROCESSING_CONFIGURATION_INVALID")
            root, workspace = _workspace(self.config.temp_dir, job.id)
            context = ProcessingContext(job, self.sessions, self.config, self.storage_factory(), workspace, cancel)
            result = await KaraokeProcessingPipeline(self.client_factory(self.config)).process(job, context)
            await context.guard("VALIDATING_RESULT")
            async with self.sessions() as db:
                repo = KaraokeProcessingRepository(db)
                async with repo.write():
                    applied = await repo.finish(job.id, job.lease_token,
                                               status=result.status, result=result.values)
            logger.info("karaoke_job_finished job_id=%s staged=%s", job.id, applied)
        except KaraokeLeaseLost:
            logger.info("karaoke_job_fenced job_id=%s", job.id)
        except (KaraokeEngineError, AlignmentRejected, HTTPException, OSError, ValueError) as error:
            code = getattr(error, "code", "INVALID_PROVIDER_RESULT")
            retry = "SAFE_RETRY" if code in {"PROVIDER_TIMEOUT", "MEDIA_UNAVAILABLE"} else "NEEDS_INPUT_CHANGE"
            async with self.sessions() as db:
                repo = KaraokeProcessingRepository(db)
                async with repo.write():
                    await repo.finish(job.id, job.lease_token, status="FAILED", error=code, retry_policy=retry)
            logger.warning("karaoke_job_failed job_id=%s code=%s", job.id, code)
        except asyncio.CancelledError:
            cancel.set()
            raise
        except Exception:
            # Unknown DB/commit outcomes must not become success or trigger a
            # second provider call. Expired-lease recovery will inspect the ledger.
            logger.warning("karaoke_job_unresolved job_id=%s", job.id)
        finally:
            finished.set()
            try:
                for task in (watcher, propagation):
                    if task and not task.done():
                        task.cancel()
                await asyncio.gather(*(task for task in (watcher, propagation) if task),
                                     return_exceptions=True)
            finally:
                try:
                    await _settle_heartbeat(heartbeat)
                finally:
                    if workspace is not None and root is not None:
                        resolved = workspace.resolve()
                        if resolved.parent == root and workspace.name.startswith(f"job-{job.id}-"):
                            await asyncio.to_thread(shutil.rmtree, workspace, ignore_errors=True)

    async def run_once(self, shutdown=None):
        if not self.config.worker_enabled:
            return False
        if not self.config.configured:
            raise KaraokeConfigurationError("PROCESSING_CONFIGURATION_INVALID")
        async with self.sessions() as db:
            repo = KaraokeProcessingRepository(db)
            async with repo.write():
                await repo.recover_expired(self.config)
        async with self.sessions() as db:
            repo = KaraokeProcessingRepository(db)
            async with repo.write():
                job = await repo.claim(self.config)
        if job is None:
            record_worker_success("karaoke_processing")
            return False
        await self.process(job, shutdown)
        record_worker_success("karaoke_processing")
        return True

    async def run(self, shutdown):
        async def slot():
            while not shutdown.is_set():
                try:
                    worked = await self.run_once(shutdown)
                except Exception as exc:
                    record_worker_error("karaoke_processing", exc)
                    logger.warning("karaoke_worker_poll_unavailable")
                    worked = False
                if not worked:
                    try:
                        await asyncio.wait_for(shutdown.wait(), timeout=self.config.poll_seconds)
                    except TimeoutError:
                        pass
        await asyncio.gather(*(slot() for _ in range(self.config.concurrency)))


async def _main(once):
    config = KaraokeProcessingConfig.from_env()
    if not config.worker_enabled:
        logger.info("karaoke_worker_disabled")
        return 0
    if not config.configured:
        raise KaraokeConfigurationError("PROCESSING_CONFIGURATION_INVALID")
    from app.database.session import AsyncSessionLocal, engine
    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, shutdown.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(shutdown.set))
    worker = KaraokeProcessingWorker(AsyncSessionLocal, config)
    try:
        if once:
            await worker.run_once(shutdown)
        else:
            await worker.run(shutdown)
    finally:
        await engine.dispose()
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        return asyncio.run(_main(args.once))
    except KaraokeConfigurationError:
        logger.error("karaoke_worker_configuration_invalid")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
