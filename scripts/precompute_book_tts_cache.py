"""Offline/CLI precomputation script to populate `tts_audio_cache_entries` with 64 kbps MP3 clips.

Prefer running with `F:\\c1\\tools\\voice-runtime\\.venv\\Scripts\\python.exe` (which includes
PyAV `libmp3lame` for 12x WAV->MP3 64 kbps compression) while the local voice worker
(`127.0.0.1:8010`) is running. Never prints secrets, JWTs, or DATABASE_URL.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path
from typing import Any
from uuid import UUID

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPO_ROOT / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import select  # noqa: E402

from app.database.session import AsyncSessionLocal, engine  # noqa: E402
from app.models import Book, BookPage, PageRevision, PageRevisionWord  # noqa: E402
from app.providers.local_voice_provider import (  # noqa: E402
    DEFAULT_LOCAL_VOICE_ID,
    LOCAL_TTS_MODEL_VERSION,
)
from app.repositories.tts_audio_cache_repository import TtsAudioCacheRepository  # noqa: E402
from app.services.tts_audio_cache_service import (  # noqa: E402
    ALLOWED_COACHING_PHRASES_RAW,
    ResolvedCacheTarget,
    TtsAudioCacheService,
    canonical_tts_sha256,
    canonical_tts_text,
    get_tts_cache_max_bytes,
    preferred_cache_formats,
    transcode_to_mp3_64k,
)
from app.services.voice_orchestrator import VoiceOrchestrator, VoicePolicyContext  # noqa: E402

logger = logging.getLogger("viread.precompute_tts_cache")

COACHING_PHRASES: tuple[str, ...] = ALLOWED_COACHING_PHRASES_RAW


async def _collect_page_targets(
    *,
    scope: str,
    book_id: UUID | None,
    limit: int | None,
) -> list[dict[str, Any]]:
    async with AsyncSessionLocal() as db:
        query = (
            select(
                Book.Id.label("book_id"),
                Book.VisibilityScope,
                Book.OwnerParentId,
                BookPage.Id.label("page_id"),
                PageRevision.Id.label("revision_id"),
                PageRevision.VerifiedText,
            )
            .join(BookPage, BookPage.BookId == Book.Id)
            .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
            .where(
                Book.IsDeleted.is_(False),
                Book.LifecycleStatus == "ACTIVE",
                Book.ModerationStatus == "ACTIVE",
                BookPage.LifecycleStatus == "ACTIVE",
                PageRevision.VerificationStatus == "VERIFIED",
                PageRevision.VerifiedText.is_not(None),
            )
            .order_by(Book.CreatedAt.asc(), BookPage.PageNumber.asc())
        )
        if book_id is not None:
            query = query.where(Book.Id == book_id)
        if scope == "catalog":
            query = query.where(Book.VisibilityScope == "CATALOG")
        elif scope == "private":
            query = query.where(Book.VisibilityScope == "PARENT_PRIVATE")
        if limit is not None and limit > 0:
            query = query.limit(limit)

        rows = (await db.execute(query)).all()
        targets: list[dict[str, Any]] = []
        for row in rows:
            text = canonical_tts_text(str(row.VerifiedText or ""))
            if not text:
                continue
            words_res = await db.execute(
                select(PageRevisionWord.NormalizedText, PageRevisionWord.Text)
                .where(PageRevisionWord.PageRevisionId == row.revision_id)
                .order_by(PageRevisionWord.WordOrder.asc())
            )
            tokens = [
                canonical_tts_text(str(w.NormalizedText or w.Text or ""))
                for w in words_res.all()
                if canonical_tts_text(str(w.NormalizedText or w.Text or ""))
            ]
            entry_scope = "PRIVATE" if row.VisibilityScope == "PARENT_PRIVATE" else "CATALOG"
            targets.append(
                {
                    "scope": entry_scope,
                    "owner_parent_id": row.OwnerParentId if entry_scope == "PRIVATE" else None,
                    "book_id": row.book_id,
                    "page_id": row.page_id,
                    "page_revision_id": row.revision_id,
                    "text": text,
                    "tokens": tokens,
                }
            )
        return targets


async def _is_already_cached(
    *,
    target: ResolvedCacheTarget,
    normalized_text: str,
    voice_id: str,
    speed: float,
) -> bool:
    content_sha256 = canonical_tts_sha256(normalized_text)
    async with AsyncSessionLocal() as db:
        repo = TtsAudioCacheRepository(db)
        entry = await repo.get_active_entry(
            scope=target.scope,
            owner_parent_id=target.owner_parent_id,
            content_sha256=content_sha256,
            voice_id=voice_id,
            model_version=None,
            speed=speed,
            audio_formats=preferred_cache_formats(audio_format="mp3"),
        )
        return entry is not None


async def _current_cache_bytes() -> int:
    async with AsyncSessionLocal() as db:
        return await TtsAudioCacheRepository(db).total_active_bytes()


async def run_precompute(
    *,
    scope: str = "catalog",
    book_id: UUID | None = None,
    voice_id: str = DEFAULT_LOCAL_VOICE_ID,
    speed: float = 1.0,
    dry_run: bool = False,
    limit: int | None = None,
    include_words: bool = True,
    include_coaching: bool = True,
    worker_url: str | None = None,
) -> dict[str, int]:
    if worker_url:
        os.environ["VIREAD_LOCAL_VOICE_WORKER_URL"] = worker_url.strip()

    max_bytes = get_tts_cache_max_bytes()
    used_bytes = await _current_cache_bytes()
    orchestrator = VoiceOrchestrator()
    policy = VoicePolicyContext(
        provider_mode="local_only",
        allow_google_tts=False,
        accept="audio/mpeg",
        audio_format="mp3",
    )

    stats = {"planned": 0, "cached_hit": 0, "synthesized": 0, "skipped_quota": 0, "errors": 0}
    items: list[tuple[ResolvedCacheTarget, str, list[str] | None, bool]] = []

    if scope != "coaching":
        pages = await _collect_page_targets(scope=scope, book_id=book_id, limit=limit)
        seen_words: set[tuple[str, str | None, str]] = set()
        for page in pages:
            target = ResolvedCacheTarget(
                scope=page["scope"],
                owner_parent_id=page["owner_parent_id"],
                book_id=page["book_id"],
                page_id=page["page_id"],
                page_revision_id=page["page_revision_id"],
                can_store_on_miss=True,
            )
            page_tokens = page["tokens"] or page["text"].split()
            timed_key_text = canonical_tts_text(" ".join(page_tokens)) if page_tokens else page["text"]
            items.append((target, timed_key_text, page_tokens, False))
            if include_words:
                for token in page["tokens"]:
                    dedup = (
                        page["scope"],
                        str(page["owner_parent_id"]) if page["owner_parent_id"] else None,
                        token,
                    )
                    if dedup in seen_words:
                        continue
                    seen_words.add(dedup)
                    items.append(
                        (
                            ResolvedCacheTarget(
                                scope=page["scope"],
                                owner_parent_id=page["owner_parent_id"],
                                book_id=page["book_id"],
                                page_id=None,
                                page_revision_id=None,
                                can_store_on_miss=True,
                            ),
                            token,
                            None,
                            True,
                        )
                    )

    if include_coaching and book_id is None and scope in {"all", "catalog", "coaching"}:
        coaching_target = ResolvedCacheTarget(
            scope="COACHING",
            owner_parent_id=None,
            book_id=None,
            page_id=None,
            page_revision_id=None,
            can_store_on_miss=True,
        )
        for phrase in COACHING_PHRASES:
            items.append((coaching_target, canonical_tts_text(phrase), None, False))

    for target, text, tokens, is_word_sample in items:
        stats["planned"] += 1
        if await _is_already_cached(
            target=target,
            normalized_text=text,
            voice_id=voice_id,
            speed=speed,
        ):
            stats["cached_hit"] += 1
            continue

        if dry_run:
            logger.info("[dry-run] would precompute scope=%s chars=%d", target.scope, len(text))
            continue

        if used_bytes >= max_bytes:
            stats["skipped_quota"] += 1
            continue

        try:
            if tokens:
                speech = await orchestrator.local.synthesize_timed(
                    words=tokens,
                    voice_id=voice_id,
                    speed=speed,
                    accept="audio/mpeg",
                    audio_format="mp3",
                )
                raw_bytes, raw_ct = speech.audio, speech.content_type
                model_ver = speech.model_version or LOCAL_TTS_MODEL_VERSION
                dur = speech.duration_seconds
                word_timings = [
                    {"index": w.index, "start": w.start, "end": w.end}
                    for w in speech.words
                ]
            else:
                audio = await orchestrator.local.synthesize(
                    text=text,
                    voice_id=voice_id,
                    speed=speed,
                    word_sample=is_word_sample,
                    accept="audio/mpeg",
                    audio_format="mp3",
                )
                raw_bytes, raw_ct = audio.content, audio.content_type
                model_ver = audio.model_version or LOCAL_TTS_MODEL_VERSION
                dur = None
                word_timings = None

            compressed, _fmt = transcode_to_mp3_64k(raw_bytes, raw_ct)
            if used_bytes + len(compressed) > max_bytes:
                stats["skipped_quota"] += 1
                continue

            async with AsyncSessionLocal() as db:
                stored = await TtsAudioCacheService(db).store_cached_audio(
                    target=target,
                    normalized_text=text,
                    voice_id=voice_id,
                    model_version=model_ver,
                    speed=speed,
                    audio_bytes=compressed,
                    source_content_type=_fmt,
                    duration_seconds=dur,
                    word_timings_json=word_timings,
                )
                if stored:
                    used_bytes += len(compressed)
                    stats["synthesized"] += 1
                else:
                    stats["errors"] += 1
        except Exception as exc:
            stats["errors"] += 1
            logger.warning(
                "precompute_item_failed scope=%s error=%s",
                target.scope,
                type(exc).__name__,
            )

    del policy
    return stats


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Precompute ViRead TTS cache clips (64 kbps MP3).")
    parser.add_argument("--scope", choices=("catalog", "private", "all", "coaching"), default="catalog")
    parser.add_argument("--book-id", type=str, default=None)
    parser.add_argument("--voice-id", type=str, default=DEFAULT_LOCAL_VOICE_ID)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--worker-url", type=str, default=None)
    parser.add_argument("--no-words", action="store_true")
    parser.add_argument("--no-coaching", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


async def _async_main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = _parse_args()
    book_uuid = UUID(args.book_id) if args.book_id else None
    try:
        stats = await run_precompute(
            scope=args.scope,
            book_id=book_uuid,
            voice_id=args.voice_id,
            speed=args.speed,
            dry_run=args.dry_run,
            limit=args.limit,
            include_words=not args.no_words,
            include_coaching=not args.no_coaching,
            worker_url=args.worker_url,
        )
        print(
            "precompute_summary",
            f"planned={stats['planned']}",
            f"cached_hit={stats['cached_hit']}",
            f"synthesized={stats['synthesized']}",
            f"skipped_quota={stats['skipped_quota']}",
            f"errors={stats['errors']}",
        )
        return 0 if stats["errors"] == 0 else 1
    finally:
        await engine.dispose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_async_main()))
