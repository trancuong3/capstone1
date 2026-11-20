"""Read-only karaoke configuration/schema checks. Never starts a worker/model."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.core.karaoke_processing_config import KaraokeConfigurationError, KaraokeProcessingConfig

ALIGNMENT_HASH = "0c25b2cd0aaea6417a0ed325493300d1a46799c2e123dafd73412cafa1886123"
STEM_HASH = "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4"


def _load_karaoke_env():
    from dotenv import dotenv_values
    for file in (ROOT / "backend/.env", ROOT / ".env", ROOT.parent / ".env"):
        if file.is_file():
            for key, value in dotenv_values(file).items():
                if key.startswith("KARAOKE_") and value is not None and not os.environ.get(key, "").strip():
                    os.environ[key] = value


def _hash(path):
    result = hashlib.sha256()
    with open(path, "rb") as stream:
        while block := stream.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


async def _schema():
    from sqlalchemy import text
    from app.database.session import AsyncSessionLocal, engine
    required = {
        "karaoke_processing_jobs": {"id", "status", "lease_token", "input_fingerprint", "quota_day"},
        "karaoke_processing_operations": {"id", "job_id", "step_key", "operation_key", "artifact_paths"},
        "karaoke_songs": {"creation_request_id", "creation_request_fingerprint"},
        "karaoke_song_versions": {"origin_job_id", "requires_processing_review",
                                 "reviewed_content_sha256", "reference_audio_path"},
    }
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SET TRANSACTION READ ONLY"))
            rows = (await db.execute(text(
                "SELECT table_name,column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name = ANY(:tables)"
            ), {"tables": list(required)})).all()
            actual = {}
            for table, column in rows:
                actual.setdefault(table, set()).add(column)
            missing = {table: sorted(columns - actual.get(table, set()))
                       for table, columns in required.items() if columns - actual.get(table, set())}
            rls = (await db.execute(text(
                "SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace "
                "WHERE n.nspname='public' AND relname=ANY(:tables)"
            ), {"tables": ["karaoke_processing_jobs", "karaoke_processing_operations"]})).all()
            await db.rollback()
            return dict(checked=True, available=True, missing=missing,
                        server_tables_rls=len(rls) == 2 and all(enabled for _, enabled in rls))
    except Exception:
        return dict(checked=True, available=False, error="SCHEMA_CHECK_UNAVAILABLE")
    finally:
        await engine.dispose()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-schema", action="store_true")
    parser.add_argument("--check-weights", action="store_true")
    args = parser.parse_args()
    _load_karaoke_env()
    try:
        config = KaraokeProcessingConfig.from_env()
        report = dict(
            enabled=config.enabled, worker_enabled=config.worker_enabled,
            configured=config.configured, worker_health="NOT_CHECKED_USE_SUPERVISOR",
            production_quality_gate="NOT_VERIFIED", weights_checked=False,
            schema={"checked": False}, queue_warning_after_seconds=config.queue_warning_seconds,
        )
        if args.check_weights:
            report["weights_checked"] = True
            try:
                report["weights_match"] = (
                    _hash(Path(config.model_path) / "pytorch_model.bin") == ALIGNMENT_HASH
                    and _hash(Path(config.stem_model_path) / "955717e8-8726e21a.th") == STEM_HASH)
            except OSError:
                report["weights_match"] = False
        if args.check_schema:
            report["schema"] = asyncio.run(_schema())
        print(json.dumps(report, ensure_ascii=True))
        bad_schema = args.check_schema and (
            not report["schema"].get("available") or report["schema"].get("missing")
            or not report["schema"].get("server_tables_rls"))
        return 2 if (bad_schema or args.check_weights and not report.get("weights_match")
                     or (config.enabled or config.worker_enabled) and not config.configured) else 0
    except KaraokeConfigurationError:
        print(json.dumps({"configured": False, "safe_error": "PROCESSING_CONFIGURATION_INVALID"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
