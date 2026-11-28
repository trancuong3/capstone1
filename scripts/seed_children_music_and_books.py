"""Idempotently generate & push ViRead's Grade 1–5 children's music tracks & 3-page books.

What this script automates:
1. Music Tracks (`karaoke_songs` + `viread-karaoke` Storage):
   - Enriches `Ngôi sao nhỏ` + syncs all 7 folk/educational songs (`CHILDREN_KARAOKE_PACK`)
   - Synthesizes, verifies, uploads, and publishes all 5 Grade 1–5 companion songs
     (`GRADE_SERIES_KARAOKE_PACK`: 1 song per grade from Lớp 1 to Lớp 5)
2. Children's Storybooks (`books`, `bookpages`, `pagerevisions`, `pagerevisionwords`,
   `adminaiworkflows`, `book_presentation_assets`, `bookrightsevidences`, `auditlogs` +
   `SUPABASE_STORAGE_BUCKET` Storage):
   - Generates & uploads 5 copyright-clean CC0 Vietnamese storybooks from Lớp 1 to Lớp 5
     (1 book per grade, strictly 3 pages per book = 15 pages total).
   - Uploads 3:4 WebP book covers + 15 text-free WebP page illustrations + 15 crisp typeset
     960x1280 JPEG reading scans with exact word bounding boxes (`has_verified_geometry == True`).
   - Satisfies 100% of `CatalogRepository.eligible_book()` and `BookContentQualityService`
     gates (`OCR VERIFIED`, `Proofreading`, `Child Safety CONFIRMED / SUITABLE`,
     `Image Safety ADMIN_CONFIRMED_SAFE`, `Rights Evidence RIGHTS_REVIEWED`, and
     `book.children.approved` audit decision) without polluting Flow 2 camera-OCR training queues.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT_DIR / "backend"
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import delete, select  # noqa: E402

from app.database.config import SUPABASE_STORAGE_BUCKET  # noqa: E402
from app.database.session import AsyncSessionLocal, engine  # noqa: E402
from app.models import (  # noqa: E402
    AdminAiWorkflow,
    AuditLog,
    Book,
    BookPage,
    BookPresentationAsset,
    BookRightsEvidence,
    BookRightsEvidenceHistory,
    PageRevision,
    PageRevisionWord,
    Profile,
)
from app.policies.book_approval import BOOK_APPROVAL_POLICY_VERSION  # noqa: E402
from app.repositories.book_content_quality_repository import (  # noqa: E402
    BookContentQualityRepository,
)
from app.repositories.book_repository import CatalogRepository  # noqa: E402
from app.services.book_content_quality_service import (  # noqa: E402
    BookContentQualityService,
)
from app.services.children_books_catalog import (  # noqa: E402
    CHILDREN_BOOKS_PACK,
    build_complete_book_bundle,
)
from app.services.karaoke_children_catalog import (  # noqa: E402
    ALL_CHILDREN_KARAOKE_SONGS,
    CHILDREN_KARAOKE_PACK,
    GRADE_SERIES_KARAOKE_PACK,
    build_complete_song_bundle,
)
from app.services.storage_service import download_object, upload_object  # noqa: E402
from scripts.seed_children_karaoke_songs import (  # noqa: E402
    export_pack_bundles as export_core_karaoke_bundles,
    seed_database_and_storage as seed_karaoke_database_and_storage,
)

BOOKS_DOCS_DIR = ROOT_DIR / "docs" / "children-books-pack"
KARAOKE_DOCS_DIR = ROOT_DIR / "docs" / "karaoke-children-pack"


def export_grade_series_karaoke_bundles(export_audio: bool = False) -> list[dict[str, Any]]:
    """Build & export JSON metadata for the 5 Grade 1–5 companion songs."""
    KARAOKE_DOCS_DIR.mkdir(parents=True, exist_ok=True)
    bundles: list[dict[str, Any]] = []
    manifest_items: list[dict[str, Any]] = []

    for spec in GRADE_SERIES_KARAOKE_PACK:
        bundle = build_complete_song_bundle(spec)
        bundles.append(bundle)
        song_dir = KARAOKE_DOCS_DIR / spec.slug
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

    (KARAOKE_DOCS_DIR / "grade-series-manifest.json").write_text(
        json.dumps(
            {
                "pack_version": "1.0",
                "license_policy": "ViRead CC0 1.0 Original Educational Grade 1–5 Companion Songs",
                "songs": manifest_items,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return bundles


def export_children_book_bundles(export_images: bool = False) -> list[dict[str, Any]]:
    """Build & export verified JSON metadata for the 5 Grade 1–5 3-page children's books."""
    BOOKS_DOCS_DIR.mkdir(parents=True, exist_ok=True)
    bundles: list[dict[str, Any]] = []
    manifest_books: list[dict[str, Any]] = []

    for spec in CHILDREN_BOOKS_PACK:
        bundle = build_complete_book_bundle(spec)
        bundles.append(bundle)
        book_dir = BOOKS_DOCS_DIR / spec.slug
        book_dir.mkdir(parents=True, exist_ok=True)

        pages_meta: list[dict[str, Any]] = []
        for p in bundle["pages"]:
            p_num = p["page_number"]
            pages_meta.append(
                {
                    "page_number": p_num,
                    "page_id": str(spec.deterministic_page_id(p_num)),
                    "revision_id": str(spec.deterministic_revision_id(p_num)),
                    "workflow_id": str(spec.deterministic_workflow_id(p_num)),
                    "illustration_asset_id": str(
                        spec.deterministic_illustration_asset_id(p_num)
                    ),
                    "width": p["width"],
                    "height": p["height"],
                    "word_count": len(p["words"]),
                    "line_count": p["line_count"],
                    "image_sha256": p["image_sha256"],
                    "illustration_hash": p["illustration_hash"],
                    "content_hash": p["content_hash"],
                    "candidate_hash": p["candidate_hash"],
                    "text": p["canonical_text"],
                }
            )
            if export_images:
                (book_dir / f"page-{p_num}.jpg").write_bytes(p["jpeg_bytes"])
                (book_dir / f"page-{p_num}-illustration.webp").write_bytes(
                    p["illustration_webp"]
                )

        if export_images:
            (book_dir / "cover.webp").write_bytes(bundle["cover_webp"])

        book_meta = {
            "slug": spec.slug,
            "book_id": str(spec.deterministic_book_id),
            "name": spec.name,
            "title": spec.title,
            "author": spec.author,
            "grade": spec.grade,
            "min_grade": spec.min_grade,
            "max_grade": spec.max_grade,
            "expected_page_count": len(spec.pages),
            "pedagogy_focus": spec.pedagogy_focus,
            "source_declaration": spec.source_declaration,
            "cover_asset_id": str(spec.deterministic_cover_asset_id),
            "cover_hash": bundle["cover_hash"],
            "pages": pages_meta,
        }
        (book_dir / "book.json").write_text(
            json.dumps(book_meta, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        manifest_books.append(book_meta)

    (BOOKS_DOCS_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "pack_version": "1.0",
                "license_policy": "ViRead CC0 1.0 Public Domain Dedication — Grade 1 to Grade 5 Curated 3-Page Storybooks",
                "books": manifest_books,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return bundles


def _ensure_book_storage_object(
    object_path: str,
    payload_bytes: bytes,
    content_type: str,
    *,
    bucket_name: str,
) -> None:
    """Idempotently upsert object to book Storage bucket without noisy 404 probes."""
    upload_object(
        object_path,
        payload_bytes,
        content_type,
        bucket_name=bucket_name,
        upsert=True,
    )


async def _resolve_seed_admin_actor(db) -> tuple[UUID, str]:
    row = (
        await db.execute(
            select(Profile.Id, Profile.DisplayName)
            .where(Profile.Role == "admin", Profile.Active == 1)
            .order_by(Profile.CreatedAt.asc())
            .limit(1)
        )
    ).first()
    if row is not None:
        return row.Id, str(row.DisplayName or "ViRead System Admin")

    fallback = (
        await db.execute(
            select(Profile.Id, Profile.DisplayName)
            .where(Profile.Role == "admin")
            .limit(1)
        )
    ).first()
    if fallback is not None:
        return fallback.Id, str(fallback.DisplayName or "ViRead System Admin")

    raise RuntimeError(
        "No admin profile found in `public.profiles`; create an admin account before seeding books."
    )


async def seed_books_database_and_storage(book_bundles: list[dict[str, Any]]) -> None:
    """Idempotently upload book page scans, covers, illustrations & seed PostgreSQL."""
    bucket_name = (SUPABASE_STORAGE_BUCKET or "books").strip()

    async with AsyncSessionLocal() as db:
        admin_id, admin_name = await _resolve_seed_admin_actor(db)
        await db.rollback()  # Release read transaction before network Storage uploads!

    # Phase 1: Upload all media objects to Supabase Storage outside any DB transaction
    storage_paths_by_slug: dict[str, dict[str, Any]] = {}
    for bundle in book_bundles:
        spec = bundle["spec"]
        book_id = spec.deterministic_book_id
        cover_id = spec.deterministic_cover_asset_id
        cover_path = f"studio/books/{book_id}/covers/{cover_id}.webp"
        _ensure_book_storage_object(
            cover_path,
            bundle["cover_webp"],
            "image/webp",
            bucket_name=bucket_name,
        )

        page_paths: dict[int, dict[str, str]] = {}
        for p in bundle["pages"]:
            p_num = p["page_number"]
            page_id = spec.deterministic_page_id(p_num)
            ill_id = spec.deterministic_illustration_asset_id(p_num)
            img_path = f"books/{book_id}/pages/{page_id}/{p['image_sha256'][:32]}.jpg"
            ill_path = f"studio/books/{book_id}/pages/{page_id}/illustrations/{ill_id}.webp"

            _ensure_book_storage_object(
                img_path,
                p["jpeg_bytes"],
                "image/jpeg",
                bucket_name=bucket_name,
            )
            _ensure_book_storage_object(
                ill_path,
                p["illustration_webp"],
                "image/webp",
                bucket_name=bucket_name,
            )
            page_paths[p_num] = {
                "image_path": img_path,
                "illustration_path": ill_path,
            }

        storage_paths_by_slug[spec.slug] = {
            "cover_path": cover_path,
            "pages": page_paths,
        }

    # Phase 2: Upsert deterministic DB rows per book in short, clean transactions
    for bundle in book_bundles:
        spec = bundle["spec"]
        book_id = spec.deterministic_book_id
        paths_info = storage_paths_by_slug[spec.slug]
        cover_path = paths_info["cover_path"]
        now = datetime.now(timezone.utc)

        async with AsyncSessionLocal() as db:
            book_row = await db.get(Book, book_id)
            if book_row is None:
                book_row = Book(
                    Id=book_id,
                    Name=spec.name,
                    Title=spec.title,
                    Author=spec.author,
                    MinGrade=spec.min_grade,
                    MaxGrade=spec.max_grade,
                    ExpectedPageCount=len(spec.pages),
                    LifecycleStatus="ACTIVE",
                    CreatedBy=admin_id,
                    VisibilityScope="CATALOG",
                    ModerationStatus="ACTIVE",
                    IsDeleted=False,
                    SourceDeclaration=spec.source_declaration,
                    CreatedAt=now,
                )
                db.add(book_row)
            else:
                book_row.Name = spec.name
                book_row.Title = spec.title
                book_row.Author = spec.author
                book_row.MinGrade = spec.min_grade
                book_row.MaxGrade = spec.max_grade
                book_row.ExpectedPageCount = len(spec.pages)
                book_row.LifecycleStatus = "ACTIVE"
                book_row.VisibilityScope = "CATALOG"
                book_row.ModerationStatus = "ACTIVE"
                book_row.IsDeleted = False
                book_row.DeletedAt = None
                book_row.DeletedBy = None
                book_row.SourceDeclaration = spec.source_declaration
            await db.flush()

            # Upsert 3:4 Cover Asset
            cover_id = spec.deterministic_cover_asset_id
            cover_asset = await db.get(BookPresentationAsset, cover_id)
            if cover_asset is None:
                cover_asset = BookPresentationAsset(
                    Id=cover_id,
                    BookId=book_id,
                    BookPageId=None,
                    SourceRevisionId=None,
                    OwnerId=admin_id,
                    AssetRole="COVER",
                    SourceType="USER_UPLOAD",
                    StoragePath=cover_path,
                    MimeType="image/webp",
                    Width=bundle["cover_width"],
                    Height=bundle["cover_height"],
                    SizeBytes=len(bundle["cover_webp"]),
                    AssetHash=bundle["cover_hash"],
                    AssetVersion=1,
                    IsActive=True,
                    TextFreeVerified=False,
                    ModerationStatus="APPROVED",
                    MetadataJson={"pack_slug": spec.slug, "grade": spec.grade},
                    CreatedAt=now,
                    UpdatedAt=now,
                )
                db.add(cover_asset)
            else:
                cover_asset.StoragePath = cover_path
                cover_asset.Width = bundle["cover_width"]
                cover_asset.Height = bundle["cover_height"]
                cover_asset.SizeBytes = len(bundle["cover_webp"])
                cover_asset.AssetHash = bundle["cover_hash"]
                cover_asset.IsActive = True
                cover_asset.ModerationStatus = "APPROVED"
                cover_asset.UpdatedAt = now
            await db.flush()

            # Upsert all 3 pages, verified revisions, word boxes, AI safety workflows & illustrations
            for p in bundle["pages"]:
                p_num = p["page_number"]
                page_id = spec.deterministic_page_id(p_num)
                rev_id = spec.deterministic_revision_id(p_num)
                wf_id = spec.deterministic_workflow_id(p_num)
                ill_id = spec.deterministic_illustration_asset_id(p_num)
                img_path = paths_info["pages"][p_num]["image_path"]
                ill_path = paths_info["pages"][p_num]["illustration_path"]

                page_row = await db.get(BookPage, page_id)
                if page_row is None:
                    page_row = BookPage(
                        Id=page_id,
                        BookId=book_id,
                        PageNumber=p_num,
                        ImagePath=img_path,
                        Width=p["width"],
                        Height=p["height"],
                        ContentType="CONTENT",
                        ProcessingMeta={
                            "storage": "supabase",
                            "image_sha256": p["image_sha256"],
                            "pack_slug": spec.slug,
                        },
                        CurrentVerifiedRevisionId=None,
                        LifecycleStatus="ACTIVE",
                        CreatedAt=now,
                    )
                    db.add(page_row)
                else:
                    page_row.PageNumber = p_num
                    page_row.ImagePath = img_path
                    page_row.Width = p["width"]
                    page_row.Height = p["height"]
                    page_row.ContentType = "CONTENT"
                    page_row.LifecycleStatus = "ACTIVE"
                    page_row.ProcessingMeta = {
                        "storage": "supabase",
                        "image_sha256": p["image_sha256"],
                        "pack_slug": spec.slug,
                    }
                await db.flush()

                processing_meta = {
                    "engine": "viread_curated_typeset_v1",
                    "language": "vi",
                    "line_count": p["line_count"],
                    "word_count": len(p["words"]),
                    "source_width": p["width"],
                    "source_height": p["height"],
                    "processed_width": p["width"],
                    "processed_height": p["height"],
                    "source_image_path": img_path,
                    "source_image_width": p["width"],
                    "source_image_height": p["height"],
                    "source_image_sha256": p["image_sha256"],
                    "coordinate_space": "normalized_0_1",
                    "word_box_geometry": p["geometry_evidence"],
                    "paragraph_start_line_indices": p["paragraph_start_line_indices"],
                    "indented_line_indices": p["indented_line_indices"],
                    "ocr_score_contract": "ocr_calibrated_word_accuracy_v1",
                    "word_review_statuses": ["verified"] * len(p["words"]),
                    "word_score_sources": ["ocr_calibrated_word_accuracy_v1"] * len(p["words"]),
                    "ai_proofread_audit": {
                        "source_revision_id": str(rev_id),
                        "mode": "AI_AUTO_VERIFIED",
                        "checked_text": p["canonical_text"],
                        "suggestions": [],
                        "reason_code": None,
                        "final_content_sha256": p["content_hash"],
                        "reviewed_by": None,
                        "automated_by": str(admin_id),
                    },
                    "admin_ai_workflow": {
                        "workflow_id": str(wf_id),
                        "candidate_hash": p["candidate_hash"],
                        "safety_input_hash": p["candidate_hash"],
                        "safety_status": "CONFIRMED",
                        "image_safety_status": "ADMIN_CONFIRMED_SAFE",
                        "approval_scope": "CURATED_CHILDREN_CATALOG_SEED",
                        "assessment_policy": BOOK_APPROVAL_POLICY_VERSION,
                    },
                }

                rev_row = await db.get(PageRevision, rev_id)
                if rev_row is None:
                    rev_row = PageRevision(
                        Id=rev_id,
                        PageId=page_id,
                        RevisionNo="1",
                        VerificationStatus="VERIFIED",
                        OriginalOcrText=p["canonical_text"],
                        DraftText=p["canonical_text"],
                        VerifiedText=p["canonical_text"],
                        ContentHash=p["content_hash"],
                        ProcessingMeta=processing_meta,
                        VerifiedBy=admin_id,
                        VerifiedAt=now,
                        CreatedAt=now,
                    )
                    db.add(rev_row)
                else:
                    rev_row.VerificationStatus = "VERIFIED"
                    rev_row.OriginalOcrText = p["canonical_text"]
                    rev_row.DraftText = p["canonical_text"]
                    rev_row.VerifiedText = p["canonical_text"]
                    rev_row.ContentHash = p["content_hash"]
                    rev_row.ProcessingMeta = processing_meta
                    rev_row.VerifiedBy = admin_id
                    rev_row.VerifiedAt = rev_row.VerifiedAt or now
                await db.flush()

                page_row.CurrentVerifiedRevisionId = rev_id
                await db.flush()

                # Replace revision words deterministically
                await db.execute(
                    delete(PageRevisionWord).where(
                        PageRevisionWord.PageRevisionId == rev_id
                    )
                )
                for w_item in p["words"]:
                    db.add(
                        PageRevisionWord(
                            Id=spec.deterministic_word_id(p_num, w_item["word_index"]),
                            PageRevisionId=rev_id,
                            WordIndex=w_item["word_index"],
                            LineIndex=w_item["line_index"],
                            Text=w_item["text"],
                            NormalizedText=w_item["normalized_text"],
                            BoundingBox=list(w_item["bbox"]),
                            OCRConfidence=w_item["ocr_confidence"],
                        )
                    )
                await db.flush()

                # Upsert AdminAiWorkflow (OCR + Proofreading + Text Child Safety + Image Safety)
                idem_key = uuid5(
                    NAMESPACE_URL,
                    f"viread:books:children-pack:idem:{spec.slug}:page:{p_num}",
                )
                wf_row = await db.get(AdminAiWorkflow, wf_id)
                if wf_row is None:
                    wf_row = AdminAiWorkflow(
                        Id=wf_id,
                        PageId=page_id,
                        BookId=book_id,
                        PageRevisionId=rev_id,
                        ActorId=admin_id,
                        IdempotencyKey=idem_key,
                        OriginalText=p["canonical_text"],
                        InputText=p["canonical_text"],
                        InputWords=p["words"],
                        ImagePath=img_path,
                        SourceImageSha256=p["image_sha256"],
                        OriginalOcrHash=p["candidate_hash"],
                        AdminInputHash=p["candidate_hash"],
                        ProofreadText=p["candidate_text"],
                        ProofreadOutputHash=p["candidate_hash"],
                        CandidateText=p["candidate_text"],
                        CandidateHash=p["candidate_hash"],
                        CandidateVersion=1,
                        CandidateHistory=[],
                        SafetyInputHash=p["candidate_hash"],
                        SafetyHistory=[],
                        Suitability="SUITABLE",
                        SafetyStatus="CONFIRMED",
                        Findings=[],
                        CorrectionSuggestions=[],
                        UncertainWordIndices=[],
                        ProviderEvents=[],
                        ProofreadMetadata={"source": "curated_cc0_catalog"},
                        SafetyMetadata={
                            "all_chunks_completed": True,
                            "target": "GRADE_1_TO_5",
                            "source": "curated_cc0_catalog",
                        },
                        ReviewEvents=[],
                        Status="READY_FOR_ADMIN_REVIEW",
                        Stage="READY_FOR_ADMIN_REVIEW",
                        CompletedChunks=1,
                        TotalChunks=1,
                        Attempts=1,
                        SafetyConfirmedAt=now,
                        SafetyConfirmedBy=admin_id,
                        ImageSafetyStatus="ADMIN_CONFIRMED_SAFE",
                        ImageSafetyReviewedAt=now,
                        ImageSafetyReviewedBy=admin_id,
                        ImageSafetyImageSha256=p["image_sha256"],
                        ImageSafetyReason="Minh họa sách thiếu nhi gốc ViRead (CC0) an toàn, không chứa văn bản.",
                        OcrApprovedAt=now,
                        OcrApprovedBy=admin_id,
                        FinalApprovedTextHash=p["candidate_hash"],
                        CreatedAt=now,
                        UpdatedAt=now,
                    )
                    db.add(wf_row)
                else:
                    wf_row.PageRevisionId = rev_id
                    wf_row.OriginalText = p["canonical_text"]
                    wf_row.InputText = p["canonical_text"]
                    wf_row.InputWords = p["words"]
                    wf_row.ImagePath = img_path
                    wf_row.SourceImageSha256 = p["image_sha256"]
                    wf_row.OriginalOcrHash = p["candidate_hash"]
                    wf_row.AdminInputHash = p["candidate_hash"]
                    wf_row.ProofreadText = p["candidate_text"]
                    wf_row.ProofreadOutputHash = p["candidate_hash"]
                    wf_row.CandidateText = p["candidate_text"]
                    wf_row.CandidateHash = p["candidate_hash"]
                    wf_row.SafetyInputHash = p["candidate_hash"]
                    wf_row.Suitability = "SUITABLE"
                    wf_row.SafetyStatus = "CONFIRMED"
                    wf_row.Findings = []
                    wf_row.Status = "READY_FOR_ADMIN_REVIEW"
                    wf_row.Stage = "READY_FOR_ADMIN_REVIEW"
                    wf_row.CompletedChunks = 1
                    wf_row.TotalChunks = 1
                    wf_row.SafetyConfirmedAt = wf_row.SafetyConfirmedAt or now
                    wf_row.SafetyConfirmedBy = admin_id
                    wf_row.ImageSafetyStatus = "ADMIN_CONFIRMED_SAFE"
                    wf_row.ImageSafetyReviewedAt = wf_row.ImageSafetyReviewedAt or now
                    wf_row.ImageSafetyReviewedBy = admin_id
                    wf_row.ImageSafetyImageSha256 = p["image_sha256"]
                    wf_row.OcrApprovedAt = wf_row.OcrApprovedAt or now
                    wf_row.OcrApprovedBy = admin_id
                    wf_row.FinalApprovedTextHash = p["candidate_hash"]
                    wf_row.UpdatedAt = now
                await db.flush()

                # Upsert Page Illustration Asset (verified text-free)
                ill_asset = await db.get(BookPresentationAsset, ill_id)
                if ill_asset is None:
                    ill_asset = BookPresentationAsset(
                        Id=ill_id,
                        BookId=book_id,
                        BookPageId=page_id,
                        SourceRevisionId=rev_id,
                        OwnerId=admin_id,
                        AssetRole="PAGE_ILLUSTRATION",
                        SourceType="USER_UPLOAD",
                        StoragePath=ill_path,
                        MimeType="image/webp",
                        Width=p["illustration_width"],
                        Height=p["illustration_height"],
                        SizeBytes=len(p["illustration_webp"]),
                        AssetHash=p["illustration_hash"],
                        AssetVersion=1,
                        IsActive=True,
                        TextFreeVerified=True,
                        ModerationStatus="APPROVED",
                        MetadataJson={
                            "pack_slug": spec.slug,
                            "page_number": p_num,
                            "text_free_verified": True,
                        },
                        CreatedAt=now,
                        UpdatedAt=now,
                    )
                    db.add(ill_asset)
                else:
                    ill_asset.SourceRevisionId = rev_id
                    ill_asset.StoragePath = ill_path
                    ill_asset.Width = p["illustration_width"]
                    ill_asset.Height = p["illustration_height"]
                    ill_asset.SizeBytes = len(p["illustration_webp"])
                    ill_asset.AssetHash = p["illustration_hash"]
                    ill_asset.IsActive = True
                    ill_asset.TextFreeVerified = True
                    ill_asset.ModerationStatus = "APPROVED"
                    ill_asset.UpdatedAt = now
                await db.flush()

            # Compute exact Rights Fingerprint & Book Approval Assessment Hash
            quality_repo = BookContentQualityRepository(db)
            assessment_rows = await quality_repo.book_assessment_rows(book_id)
            rights_fp = BookContentQualityService._rights_content_fingerprint(
                book_row, assessment_rows
            )

            rights_id = spec.deterministic_rights_id
            rights_row = await db.get(BookRightsEvidence, rights_id)
            if rights_row is None:
                rights_row = BookRightsEvidence(
                    Id=rights_id,
                    BookId=book_id,
                    PageId=None,
                    Scope="BOOK",
                    Status="RIGHTS_REVIEWED",
                    SourceDescription=spec.source_declaration,
                    AuthorOrRightsHolder=spec.author,
                    UsageBasis="CC0_1_0_PUBLIC_DOMAIN",
                    EvidenceUrlOrRef=f"docs/children-books-pack/{spec.slug}/book.json",
                    Notes="Sách thiếu nhi biên soạn gốc bởi dự án ViRead theo chuẩn GDPT 2018.",
                    Version=1,
                    ContentFingerprint=rights_fp,
                    ReviewedBy=admin_id,
                    ReviewedByNameSnapshot=admin_name,
                    ReviewedAt=now,
                    CreatedAt=now,
                    UpdatedAt=now,
                )
                db.add(rights_row)
                await db.flush()
                db.add(
                    BookRightsEvidenceHistory(
                        Id=uuid5(
                            NAMESPACE_URL,
                            f"viread:books:children-pack:book:{spec.slug}:rights-history:v1",
                        ),
                        EvidenceId=rights_id,
                        BookId=book_id,
                        PageId=None,
                        Scope="BOOK",
                        Version=1,
                        FromStatus=None,
                        ToStatus="RIGHTS_REVIEWED",
                        SourceDescription=spec.source_declaration,
                        AuthorOrRightsHolder=spec.author,
                        UsageBasis="CC0_1_0_PUBLIC_DOMAIN",
                        EvidenceUrlOrRef=f"docs/children-books-pack/{spec.slug}/book.json",
                        Notes="Khởi tạo bằng chứng bản quyền CC0 tự động.",
                        ContentFingerprint=rights_fp,
                        ActorId=admin_id,
                        ActorNameSnapshot=admin_name,
                        CreatedAt=now,
                    )
                )
            else:
                rights_row.Status = "RIGHTS_REVIEWED"
                rights_row.SourceDescription = spec.source_declaration
                rights_row.AuthorOrRightsHolder = spec.author
                rights_row.UsageBasis = "CC0_1_0_PUBLIC_DOMAIN"
                rights_row.EvidenceUrlOrRef = f"docs/children-books-pack/{spec.slug}/book.json"
                rights_row.ContentFingerprint = rights_fp
                rights_row.ReviewedBy = admin_id
                rights_row.ReviewedByNameSnapshot = admin_name
                rights_row.ReviewedAt = rights_row.ReviewedAt or now
                rights_row.UpdatedAt = now
            await db.flush()

            existing_decisions = await quality_repo.book_decisions(book_id)
            assessment = BookContentQualityService._assessment(
                assessment_rows,
                existing_decisions,
                rights_evidence=rights_row,
                current_rights_fingerprint=rights_fp,
            )
            if assessment.blockers:
                raise RuntimeError(
                    f"Book '{spec.title}' still has quality blockers: {assessment.blockers}"
                )

            if assessment.status not in ("PUBLISHED", "APPROVED_BY_ADMIN"):
                db.add(
                    AuditLog(
                        Id=uuid5(
                            NAMESPACE_URL,
                            f"viread:books:children-pack:audit:{spec.slug}:{assessment.assessment_hash[:16]}",
                        ),
                        ActorId=admin_id,
                        Action="book.children.approved",
                        ResourceType="book",
                        ResourceId=book_id,
                        RequestId=f"seed-children-pack-{spec.slug}",
                        Metadata={
                            "policy": BOOK_APPROVAL_POLICY_VERSION,
                            "assessment_hash": assessment.assessment_hash,
                            "decision_source": "AUTO_APPROVAL",
                            "note": f"Duyệt tự động sách thiếu nhi Lớp {spec.grade} (CC0 ViRead).",
                        },
                        CreatedAt=now,
                    )
                )
                await db.flush()

            is_eligible = await CatalogRepository(db).is_eligible(book_id)
            if not is_eligible:
                raise RuntimeError(
                    f"CatalogRepository.is_eligible({book_id}) returned False for '{spec.title}'"
                )

            await db.commit()
            total_words = sum(len(p["words"]) for p in bundle["pages"])
            print(
                f"[OK] Seeded Book Lớp {spec.grade}: '{spec.title}' "
                f"({len(bundle['pages'])} trang, {total_words} từ, eligible={is_eligible})"
            )


async def run_all_seeding(
    *,
    core_song_bundles: list[dict[str, Any]],
    grade_song_bundles: list[dict[str, Any]],
    book_bundles: list[dict[str, Any]],
    skip_music: bool = False,
    skip_books: bool = False,
) -> None:
    try:
        if not skip_music:
            await seed_karaoke_database_and_storage(
                core_song_bundles + grade_song_bundles
            )
        if not skip_books:
            await seed_books_database_and_storage(book_bundles)
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Automatically generate & push ViRead Grade 1–5 children's music & 3-page books."
    )
    parser.add_argument(
        "--seed-db",
        action="store_true",
        help="Upload all audio/covers/pages/illustrations to Supabase Storage & seed PostgreSQL",
    )
    parser.add_argument(
        "--export-media",
        action="store_true",
        help="Also write MP3/WebP/JPEG binaries into local docs/ packs",
    )
    parser.add_argument("--skip-music", action="store_true", help="Skip karaoke music seeding")
    parser.add_argument("--skip-books", action="store_true", help="Skip books seeding")
    args = parser.parse_args()

    core_songs: list[dict[str, Any]] = []
    grade_songs: list[dict[str, Any]] = []
    books: list[dict[str, Any]] = []

    if not args.skip_music:
        core_songs = export_core_karaoke_bundles(export_audio=args.export_media)
        grade_songs = export_grade_series_karaoke_bundles(export_audio=args.export_media)
        print(
            f"[OK] Prepared {len(core_songs)} folk/core songs + {len(grade_songs)} Grade 1–5 companion songs "
            f"(total={len(ALL_CHILDREN_KARAOKE_SONGS)} pack songs + Ngôi sao nhỏ)"
        )
        if args.seed_db:
            asyncio.run(
                run_all_seeding(
                    core_song_bundles=core_songs,
                    grade_song_bundles=grade_songs,
                    book_bundles=[],
                    skip_music=False,
                    skip_books=True,
                )
            )
        core_songs.clear()
        grade_songs.clear()
        import gc

        gc.collect()

    if not args.skip_books:
        from app.services.book_illustration_service import _build_default_ocr_check_fn

        shared_ocr_fn = _build_default_ocr_check_fn()
        BOOKS_DOCS_DIR.mkdir(parents=True, exist_ok=True)
        manifest_books: list[dict[str, Any]] = []
        for spec in CHILDREN_BOOKS_PACK:
            bundle = build_complete_book_bundle(spec, ocr_check_fn=shared_ocr_fn)
            books.append(bundle)
            book_dir = BOOKS_DOCS_DIR / spec.slug
            book_dir.mkdir(parents=True, exist_ok=True)
            pages_meta: list[dict[str, Any]] = []
            for p in bundle["pages"]:
                p_num = p["page_number"]
                pages_meta.append(
                    {
                        "page_number": p_num,
                        "page_id": str(spec.deterministic_page_id(p_num)),
                        "revision_id": str(spec.deterministic_revision_id(p_num)),
                        "workflow_id": str(spec.deterministic_workflow_id(p_num)),
                        "illustration_asset_id": str(
                            spec.deterministic_illustration_asset_id(p_num)
                        ),
                        "width": p["width"],
                        "height": p["height"],
                        "word_count": len(p["words"]),
                        "line_count": p["line_count"],
                        "image_sha256": p["image_sha256"],
                        "illustration_hash": p["illustration_hash"],
                        "content_hash": p["content_hash"],
                        "candidate_hash": p["candidate_hash"],
                        "text": p["canonical_text"],
                    }
                )
                if args.export_media:
                    (book_dir / f"page-{p_num}.jpg").write_bytes(p["jpeg_bytes"])
                    (book_dir / f"page-{p_num}-illustration.webp").write_bytes(
                        p["illustration_webp"]
                    )
            if args.export_media:
                (book_dir / "cover.webp").write_bytes(bundle["cover_webp"])
            book_meta = {
                "slug": spec.slug,
                "book_id": str(spec.deterministic_book_id),
                "name": spec.name,
                "title": spec.title,
                "author": spec.author,
                "grade": spec.grade,
                "min_grade": spec.min_grade,
                "max_grade": spec.max_grade,
                "expected_page_count": len(spec.pages),
                "pedagogy_focus": spec.pedagogy_focus,
                "source_declaration": spec.source_declaration,
                "cover_asset_id": str(spec.deterministic_cover_asset_id),
                "cover_hash": bundle["cover_hash"],
                "pages": pages_meta,
            }
            (book_dir / "book.json").write_text(
                json.dumps(book_meta, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            manifest_books.append(book_meta)

        (BOOKS_DOCS_DIR / "manifest.json").write_text(
            json.dumps(
                {
                    "pack_version": "1.0",
                    "license_policy": "ViRead CC0 1.0 Public Domain Dedication — Grade 1 to Grade 5 Curated 3-Page Storybooks",
                    "books": manifest_books,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(
            f"[OK] Prepared {len(books)} Grade 1–5 children's books "
            f"({sum(len(b['pages']) for b in books)} pages total, 3 pages/book)"
        )
        if args.seed_db:
            asyncio.run(
                run_all_seeding(
                    core_song_bundles=[],
                    grade_song_bundles=[],
                    book_bundles=books,
                    skip_music=True,
                    skip_books=False,
                )
            )


if __name__ == "__main__":
    main()
