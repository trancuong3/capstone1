import unittest

from app.models.karaoke import KaraokeSongVersion, utcnow
from app.schemas.karaoke import MelodyProfileRead
from app.services.book_illustration_service import (
    _build_default_ocr_check_fn,
    verify_illustration_text_free,
)
from app.services.children_books_catalog import (
    CHILDREN_BOOKS_PACK,
    _decode_webp_to_bgr,
    build_complete_book_bundle,
)
from app.services.karaoke_children_catalog import (
    ALL_CHILDREN_KARAOKE_SONGS,
    CHILDREN_KARAOKE_PACK,
    GRADE_SERIES_KARAOKE_PACK,
    build_melody_profile_for_v2_lyrics,
    build_timed_lyrics_for_spec,
)
from app.services.karaoke_service import content_issues
from app.services.ocr_text_utils import normalize_text_tokens
from app.services.word_box_geometry import has_verified_geometry


class ChildrenBooksAndMusicSeedTests(unittest.TestCase):
    def test_grade_1_to_5_books_have_one_book_per_grade_and_three_pages_each(self) -> None:
        self.assertEqual(len(CHILDREN_BOOKS_PACK), 5)
        self.assertEqual([b.grade for b in CHILDREN_BOOKS_PACK], [1, 2, 3, 4, 5])

        seen_book_ids: set[object] = set()
        seen_slugs: set[str] = set()
        ocr_fn = _build_default_ocr_check_fn()

        for spec in CHILDREN_BOOKS_PACK:
            self.assertEqual(spec.min_grade, spec.grade)
            self.assertEqual(spec.max_grade, spec.grade)
            self.assertEqual(len(spec.pages), 3)
            self.assertNotIn(spec.slug, seen_slugs)
            self.assertNotIn(spec.deterministic_book_id, seen_book_ids)
            seen_slugs.add(spec.slug)
            seen_book_ids.add(spec.deterministic_book_id)

            bundle = build_complete_book_bundle(spec, ocr_check_fn=ocr_fn)
            self.assertEqual(bundle["cover_webp"][:4], b"RIFF")
            self.assertEqual(bundle["cover_webp"][8:12], b"WEBP")
            self.assertLessEqual(len(bundle["cover_webp"]), 300 * 1024)
            self.assertEqual(len(bundle["pages"]), 3)

            for idx, page in enumerate(bundle["pages"], start=1):
                self.assertEqual(page["page_number"], idx)
                self.assertEqual(page["jpeg_bytes"][:3], b"\xff\xd8\xff")
                self.assertGreater(len(page["words"]), 25)
                self.assertEqual(
                    normalize_text_tokens(page["canonical_text"]),
                    [w["normalized_text"] for w in page["words"]],
                )
                self.assertTrue(
                    has_verified_geometry(
                        page["geometry_evidence"],
                        page["words"],
                        page["width"],
                        page["height"],
                    )
                )

                ill_bytes = page["illustration_webp"]
                self.assertEqual(ill_bytes[:4], b"RIFF")
                self.assertEqual(ill_bytes[8:12], b"WEBP")
                bgr = _decode_webp_to_bgr(ill_bytes)
                ver = verify_illustration_text_free(
                    bgr,
                    canonical_text=page["canonical_text"],
                    ocr_check_fn=ocr_fn,
                    image_bytes=ill_bytes,
                )
                self.assertTrue(
                    ver.text_free_verified,
                    f"Illustration failed text-free gate for {spec.slug} page {idx}: {ver}",
                )

    def test_grade_series_karaoke_pack_covers_grades_1_to_5_cleanly(self) -> None:
        self.assertEqual(len(CHILDREN_KARAOKE_PACK), 7)
        self.assertEqual(len(GRADE_SERIES_KARAOKE_PACK), 5)
        self.assertEqual(len(ALL_CHILDREN_KARAOKE_SONGS), 12)
        self.assertEqual(
            [(s.min_grade, s.max_grade) for s in GRADE_SERIES_KARAOKE_PACK],
            [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5)],
        )

        now = utcnow()
        for spec in GRADE_SERIES_KARAOKE_PACK:
            lyrics, duration_ms = build_timed_lyrics_for_spec(spec)
            self.assertGreater(duration_ms, 20_000)
            version_row = KaraokeSongVersion(
                id=spec.deterministic_version_id,
                song_id=spec.deterministic_song_id,
                version_no=1,
                state="PUBLISHED",
                title=spec.title,
                author=spec.author,
                min_grade=spec.min_grade,
                max_grade=spec.max_grade,
                source_note=spec.source_note,
                usage_note=spec.usage_note,
                audio_path=f"songs/{spec.deterministic_song_id}/audio.mp3",
                cover_path=f"songs/{spec.deterministic_song_id}/cover.webp",
                audio_sha256="b" * 64,
                timed_audio_sha256="b" * 64,
                requires_processing_review=False,
                audio_size_bytes=120_000,
                duration_ms=duration_ms,
                lyrics=lyrics,
                created_at=now,
                updated_at=now,
                published_at=now,
            )
            self.assertEqual(content_issues(version_row), [])
            melody = build_melody_profile_for_v2_lyrics(
                lyrics,
                line_midis=tuple(midis for _text, midis in spec.lines),
                duration_ms=duration_ms,
                bpm=spec.bpm,
            )
            validated = MelodyProfileRead.model_validate(melody)
            self.assertEqual(
                len(validated.notes),
                sum(len(midis) for _text, midis in spec.lines),
            )


if __name__ == "__main__":
    unittest.main()
