"""Idempotently generate & seed ViRead's 8 copyright-clean Vietnamese children's karaoke songs.

Actions:
1. Export verified JSON metadata + v2 syllable-timed lyrics + `melody_profile` into
   `docs/karaoke-children-pack/` (never touching `docs/karaoke-demo/`).
2. When `--seed-db` is passed (and `DATABASE_URL` + Supabase Storage credentials are available):
   - Idempotently apply `supabase/migrations/20261128020000_karaoke_melody_profile.sql` statements.
   - Enrich existing published `Ngôi sao nhỏ` with its syllable-aligned `melody_profile` + `karaoke_musical_profiles` row.
   - Upload MP3 + WebP cover to private `viread-karaoke` Storage bucket (`KaraokeStorage.upload` + `verify`)
     and publish all 7 new folk/educational children's songs in `karaoke_songs`, `karaoke_song_versions`,
     and `karaoke_musical_profiles`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys
from uuid import NAMESPACE_URL, uuid5

ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import select, text

from app.database.session import AsyncSessionLocal
from app.models.karaoke import KaraokeSong, KaraokeSongVersion, utcnow
from app.repositories.karaoke_practice_repository import KaraokePracticeRepository
from app.services.karaoke_children_catalog import (
    CHILDREN_KARAOKE_PACK,
    build_complete_song_bundle,
    build_ngoi_sao_nho_melody_profile,
    render_ngoi_sao_nho_cover_webp,
)
from app.services.karaoke_melody_extractor import build_musical_profile_payload
from app.services.karaoke_service import content_issues
from app.services.karaoke_storage_service import KaraokeStorage


PACK_DOCS_DIR = ROOT_DIR / "docs" / "karaoke-children-pack"
DEMO_V2_LYRICS_PATH = ROOT_DIR / "docs" / "karaoke-demo" / "ngoi-sao-nho-v2.json"
MELODY_MIGRATION_SQL_STATEMENTS: tuple[str, ...] = (
    """
    ALTER TABLE public.karaoke_song_versions
      ADD COLUMN IF NOT EXISTS melody_profile jsonb NULL
    """,
    """
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_karaoke_song_versions_melody_profile_object'
          AND conrelid = 'public.karaoke_song_versions'::regclass
      ) THEN
        ALTER TABLE public.karaoke_song_versions
          ADD CONSTRAINT ck_karaoke_song_versions_melody_profile_object
          CHECK (melody_profile IS NULL OR jsonb_typeof(melody_profile) = 'object');
      END IF;
    END
    $$
    """,
)


def export_pack_bundles(export_audio: bool = False) -> list[dict]:
    PACK_DOCS_DIR.mkdir(parents=True, exist_ok=True)
    bundles: list[dict] = []

    if DEMO_V2_LYRICS_PATH.is_file():
        demo_v2 = json.loads(DEMO_V2_LYRICS_PATH.read_text(encoding="utf-8"))
        demo_melody = build_ngoi_sao_nho_melody_profile(demo_v2, duration_ms=103_366)
        (PACK_DOCS_DIR / "ngoi-sao-nho-melody-profile.json").write_text(
            json.dumps(demo_melody, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    manifest_items: list[dict] = []
    for spec in CHILDREN_KARAOKE_PACK:
        bundle = build_complete_song_bundle(spec)
        bundles.append(bundle)
        song_dir = PACK_DOCS_DIR / spec.slug
        song_dir.mkdir(parents=True, exist_ok=True)

        song_meta = {
            "slug": spec.slug,
            "song_id": str(spec.deterministic_song_id),
            "version_id": str(spec.deterministic_version_id),
            "title": spec.title,
            "author": spec.author,
            "min_grade": spec.min_grade,
            "max_grade": spec.max_grade,
            "bpm": spec.bpm,
            "phonics_focus": spec.phonics_focus,
            "source_note": spec.source_note,
            "usage_note": spec.usage_note,
            "duration_ms": bundle["audio_meta"].duration_ms,
            "audio_size_bytes": bundle["audio_meta"].size_bytes,
            "audio_sha256": bundle["audio_meta"].sha256,
        }
        (song_dir / "song.json").write_text(
            json.dumps(song_meta, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (song_dir / "lyrics-v2.json").write_text(
            json.dumps(bundle["lyrics"], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (song_dir / "melody-profile.json").write_text(
            json.dumps(bundle["melody_profile"], ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        if export_audio:
            (song_dir / f"{spec.slug}.mp3").write_bytes(bundle["mp3_bytes"])
            (song_dir / f"{spec.slug}.webp").write_bytes(bundle["cover_webp"])

        manifest_items.append(song_meta)

    (PACK_DOCS_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "pack_version": "1.0",
                "license_policy": "Public Domain Vietnamese Folk Rhymes & ViRead CC0 1.0 Original Educational Songs",
                "songs": manifest_items,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return bundles


async def seed_database_and_storage(bundles: list[dict]) -> None:
    storage = KaraokeStorage()

    async with AsyncSessionLocal() as db:
        for stmt in MELODY_MIGRATION_SQL_STATEMENTS:
            await db.execute(text(stmt))
        await db.commit()

        practice_repo = KaraokePracticeRepository(db)

        # 1. Enrich existing published 'Ngôi sao nhỏ' with exact melody_profile
        existing_demo = (
            await db.execute(
                select(KaraokeSong, KaraokeSongVersion)
                .join(
                    KaraokeSongVersion,
                    KaraokeSongVersion.id == KaraokeSong.published_version_id,
                )
                .where(
                    KaraokeSong.status == "PUBLISHED",
                    KaraokeSongVersion.title == "Ngôi sao nhỏ",
                )
            )
        ).first()
        if existing_demo is not None:
            demo_song, demo_ver = existing_demo
            demo_cover_ok = False
            if demo_ver.cover_path:
                try:
                    storage.verify(demo_ver.cover_path, demo_song.id)
                    demo_cover_ok = True
                except Exception:
                    demo_cover_ok = False
            if not demo_cover_ok:
                demo_cover_webp = render_ngoi_sao_nho_cover_webp()
                demo_cover_asset_id = uuid5(
                    NAMESPACE_URL,
                    f"viread:karaoke:children-pack:cover:ngoi-sao-nho:{demo_ver.id}:v1",
                )
                demo_cover_path = (
                    f"songs/{demo_song.id}/versions/{demo_ver.id}/covers/{demo_cover_asset_id}.webp"
                )
                try:
                    storage.verify(demo_cover_path, demo_song.id, len(demo_cover_webp))
                except Exception:
                    storage.remove(demo_cover_path, demo_song.id)
                    storage.upload(demo_cover_path, demo_song.id, demo_cover_webp, "image/webp")
                    storage.verify(demo_cover_path, demo_song.id, len(demo_cover_webp))
                demo_ver.cover_path = demo_cover_path
                demo_ver.updated_at = utcnow()
                await db.flush()
                print(f"[OK] Uploaded & linked cover for 'Ngôi sao nhỏ' ({demo_cover_path})")
            demo_lyrics = (
                demo_ver.lyrics
                if isinstance(demo_ver.lyrics, dict)
                and demo_ver.lyrics.get("format_version") == 2
                else json.loads(DEMO_V2_LYRICS_PATH.read_text(encoding="utf-8"))
            )
            demo_melody = build_ngoi_sao_nho_melody_profile(
                demo_lyrics,
                duration_ms=int(demo_ver.duration_ms or 103_366),
            )
            demo_profile_payload = build_musical_profile_payload(demo_melody, demo_lyrics)
            await practice_repo.save_version_melody_profile(demo_ver.id, demo_melody)
            await practice_repo.upsert_musical_profile(
                demo_ver.id,
                bpm=demo_profile_payload.get("bpm"),
                audio_type="VOCAL_FULL",
                has_pitch_contour=True,
                has_beat_grid=True,
                source_method="AUDIO_DSP",
                profile_json=demo_profile_payload,
            )
            await db.commit()
            print(f"[OK] Enriched melody_profile for 'Ngôi sao nhỏ' (version={demo_ver.id})")

        # 2. Seed all 7 new children's songs idempotently
        for bundle in bundles:
            spec = bundle["spec"]
            song_id = spec.deterministic_song_id
            version_id = spec.deterministic_version_id
            audio_meta = bundle["audio_meta"]
            audio_asset_id = uuid5(
                NAMESPACE_URL, f"viread:karaoke:children-pack:audio:{spec.slug}:{audio_meta.sha256[:16]}"
            )
            cover_asset_id = uuid5(
                NAMESPACE_URL, f"viread:karaoke:children-pack:cover:{spec.slug}:v1"
            )
            audio_path = f"songs/{song_id}/versions/{version_id}/audio/{audio_asset_id}.mp3"
            cover_path = f"songs/{song_id}/versions/{version_id}/covers/{cover_asset_id}.webp"

            # Ensure audio & cover exist in Supabase Storage
            try:
                storage.verify(audio_path, song_id, audio_meta.size_bytes)
            except Exception:
                storage.remove(audio_path, song_id)
                storage.upload(audio_path, song_id, bundle["mp3_bytes"], "audio/mpeg")
                storage.verify(audio_path, song_id, audio_meta.size_bytes)

            try:
                storage.verify(cover_path, song_id, len(bundle["cover_webp"]))
            except Exception:
                storage.remove(cover_path, song_id)
                storage.upload(cover_path, song_id, bundle["cover_webp"], "image/webp")
                storage.verify(cover_path, song_id, len(bundle["cover_webp"]))

            now = utcnow()
            existing_song = await db.scalar(select(KaraokeSong).where(KaraokeSong.id == song_id))
            existing_by_title = await db.scalar(
                select(KaraokeSong)
                .join(
                    KaraokeSongVersion,
                    KaraokeSongVersion.id == KaraokeSong.published_version_id,
                )
                .where(KaraokeSongVersion.title == spec.title)
            )
            if existing_by_title is not None and existing_song is None:
                print(f"[SKIP] Song '{spec.title}' already exists under id={existing_by_title.id}")
                continue

            if existing_song is None:
                song_row = KaraokeSong(
                    id=song_id,
                    status="PUBLISHED",
                    published_version_id=version_id,
                    revision=1,
                    created_at=now,
                    updated_at=now,
                )
                version_row = KaraokeSongVersion(
                    id=version_id,
                    song_id=song_id,
                    version_no=1,
                    state="PUBLISHED",
                    title=spec.title,
                    author=spec.author,
                    min_grade=spec.min_grade,
                    max_grade=spec.max_grade,
                    source_note=spec.source_note,
                    usage_note=spec.usage_note,
                    audio_path=audio_path,
                    cover_path=cover_path,
                    audio_sha256=audio_meta.sha256,
                    timed_audio_sha256=audio_meta.sha256,
                    requires_processing_review=False,
                    audio_size_bytes=audio_meta.size_bytes,
                    duration_ms=audio_meta.duration_ms,
                    lyrics=bundle["lyrics"],
                    created_at=now,
                    updated_at=now,
                    published_at=now,
                )
                issues = content_issues(version_row)
                if issues:
                    raise RuntimeError(f"Validation issues on {spec.slug}: {issues}")
                db.add(song_row)
                db.add(version_row)
                await db.flush()
            else:
                version_row = await db.scalar(
                    select(KaraokeSongVersion).where(KaraokeSongVersion.id == version_id)
                )
                if version_row is not None:
                    version_row.title = spec.title
                    version_row.author = spec.author
                    version_row.min_grade = spec.min_grade
                    version_row.max_grade = spec.max_grade
                    version_row.source_note = spec.source_note
                    version_row.usage_note = spec.usage_note
                    version_row.audio_path = audio_path
                    version_row.cover_path = cover_path
                    version_row.audio_sha256 = audio_meta.sha256
                    version_row.timed_audio_sha256 = audio_meta.sha256
                    version_row.audio_size_bytes = audio_meta.size_bytes
                    version_row.duration_ms = audio_meta.duration_ms
                    version_row.lyrics = bundle["lyrics"]
                    version_row.state = "PUBLISHED"
                    version_row.published_at = version_row.published_at or now
                    version_row.updated_at = now
                existing_song.status = "PUBLISHED"
                existing_song.published_version_id = version_id
                existing_song.updated_at = now
                await db.flush()

            profile_payload = build_musical_profile_payload(
                bundle["melody_profile"], bundle["lyrics"]
            )
            await practice_repo.save_version_melody_profile(
                version_id, bundle["melody_profile"]
            )
            await practice_repo.upsert_musical_profile(
                version_id,
                bpm=profile_payload.get("bpm"),
                audio_type="INSTRUMENTAL_ONLY",
                has_pitch_contour=True,
                has_beat_grid=True,
                source_method="AUDIO_DSP",
                profile_json=profile_payload,
            )
            await db.commit()
            print(
                f"[OK] Seeded '{spec.title}' (Lớp {spec.min_grade}-{spec.max_grade}, "
                f"{audio_meta.duration_ms}ms, {len(bundle['melody_profile']['notes'])} notes)"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed ViRead children's karaoke pack")
    parser.add_argument("--seed-db", action="store_true", help="Upload media & seed PostgreSQL")
    parser.add_argument("--export-audio", action="store_true", help="Write MP3/WebP to docs pack")
    args = parser.parse_args()

    bundles = export_pack_bundles(export_audio=args.export_audio)
    print(f"[OK] Generated {len(bundles)} verified song bundles under {PACK_DOCS_DIR}")
    if args.seed_db:
        asyncio.run(seed_database_and_storage(bundles))


if __name__ == "__main__":
    main()
