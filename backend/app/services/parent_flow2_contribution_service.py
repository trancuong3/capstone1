"""Business logic for Parent Private Book -> Flow 2 (Admin Verified) OCR sample contribution.

Enforces:
- Strict book-level opt-in consent (default OFF; owner-parent only; Admin cannot opt in on behalf of parent).
- Multi-gate recruitment (ownership, active non-suspended book/page, active current revision, completed OCR +
  proofread + Tool Check / Admin moderation, clear training rights basis, line image quality, PII exclusion).
- Line-level Admin verification against the actual cropped image (never auto-verified from "readable for children").
- Atomic revocation across candidates, outbox, pool samples, active dataset snapshots, and queued training jobs.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import logging
import math
import re
from typing import Any
import unicodedata
from uuid import UUID

import numpy as np
from fastapi import HTTPException, status
from PIL import Image, ImageStat
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.models import (
    Book,
    BookPage,
    PageRevision,
    ParentBookFlow2Candidate,
    ParentBookOcrContributionConsent,
    ParentBookOcrContributionConsentEvent,
    ParentBookPageSubmission,
)
from app.policies.book_access import (
    MODERATION_ACTIVE,
    VISIBILITY_PARENT_PRIVATE,
    admin_flow2_candidate_crop_url,
)
from app.repositories.parent_flow2_contribution_repository import (
    ParentFlow2ContributionRepository,
)
from app.schemas.parent_private_book import (
    FLOW2_CANDIDATE_STATUS_LABELS,
    FLOW2_REJECTION_CODE_LABELS,
    OCR_CONTRIBUTION_NOTICE_VERSION,
    SOURCE_TYPE_LABELS,
    AdminFlow2CandidateDecisionRequest,
    AdminFlow2CandidateDecisionResponse,
    AdminFlow2CandidatePageRead,
    AdminFlow2CandidateRead,
    ParentOcrContributionStateRead,
    ParentOcrContributionUpdateRequest,
    SourceUsageType,
)
from app.services.storage_service import download_object
from app.services.viread_flow2_hygiene import (
    MIN_LINE_ASPECT_RATIO,
    MIN_LINE_EDGE_VARIANCE,
    MIN_LINE_HEIGHT_PX,
    MIN_LINE_STDDEV,
    MIN_LINE_WIDTH_PX,
    compute_line_crop_box,
    detect_vietnamese_pii_strict,
    open_image_exif_safe,
    sanitize_and_validate_vietocr_label,
    validate_flow2_line_crop,
    validate_line_word_geometry,
)

logger = logging.getLogger(__name__)

ALLOWED_TRAINING_RIGHTS: frozenset[str] = frozenset(
    {"SELF_AUTHORED", "PUBLIC_DOMAIN", "LICENSED_OR_PERMISSION"}
)


def parse_book_source_type(source_declaration: str | None) -> SourceUsageType:
    cleaned = (source_declaration or "").strip()
    if cleaned.startswith("[") and "]" in cleaned:
        tag = cleaned[1:].split("]", 1)[0].strip()
        if tag in SOURCE_TYPE_LABELS:
            return tag  # type: ignore[return-value]
    return "OWNED_PHYSICAL_BOOK"


def normalize_and_validate_ocr_label(raw: str) -> str:
    cleaned, reason = sanitize_and_validate_vietocr_label(raw)
    if cleaned is None:
        messages = {
            "FORBIDDEN_CONTROL_CHARS": "Nhãn OCR chứa ký tự điều khiển không hợp lệ.",
            "EMPTY_LABEL": "Nhãn OCR không được để trống.",
            "LABEL_TOO_LONG": "Nhãn OCR vượt quá giới hạn ký tự cho một dòng huấn luyện.",
            "UNSUPPORTED_VIETOCR_VOCAB_CHAR": "Nhãn OCR chứa ký tự ngoài bảng chữ cái VietOCR được hỗ trợ.",
            "OCR_GARBAGE_PATTERN": "Nhãn OCR chứa chuỗi nhiễu không hợp lệ.",
            "NON_ALPHANUMERIC_GARBAGE": "Nhãn OCR chỉ chứa ký hiệu/dấu câu mà không có chữ hoặc số.",
        }
        raise ValueError(messages.get(reason or "", "Nhãn OCR không hợp lệ."))
    return cleaned


def detect_line_pii(label_text: str) -> list[str]:
    """Deterministic Vietnamese PII detector for parent private book line labels."""
    return detect_vietnamese_pii_strict(label_text, mode="strict")


def evaluate_line_crop_quality(
    crop_rgb: Image.Image,
    *,
    label: str | None = None,
    page_height: int | None = None,
) -> tuple[bool, dict[str, Any], str | None]:
    """Enforce clean-sample-standard.md image quality thresholds."""
    return validate_flow2_line_crop(crop_rgb, label=label, page_height=page_height)


def extract_line_crops_with_boxes(
    image_bytes: bytes,
    words: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Crop individual lines from a private page image and compute PNG bytes + quality metrics."""
    page = open_image_exif_safe(image_bytes)
    try:
        if page.width <= 0 or page.height <= 0:
            return []

        by_line: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for w in words:
            by_line[int(w["line_index"])].append(w)

        results: list[dict[str, Any]] = []
        for line_index, line_words in sorted(by_line.items()):
            line_words.sort(key=lambda item: int(item["word_index"]))
            geom_ok, geom_reason = validate_line_word_geometry(line_words)
            if not geom_ok:
                results.append(
                    {
                        "line_index": line_index,
                        "eligible": False,
                        "reject_reason": geom_reason or "INVALID_WORD_GEOMETRY",
                        "quality_metrics": {},
                    }
                )
                continue

            bounds: list[tuple[float, float, float, float]] = []
            tokens: list[str] = []
            valid_geometry = True
            for word in line_words:
                box = word.get("bounding_box")
                if not isinstance(box, list) or len(box) != 4:
                    valid_geometry = False
                    break
                x, y, bw, bh = (float(v) for v in box)
                if (
                    not all(math.isfinite(v) for v in (x, y, bw, bh))
                    or x < 0
                    or y < 0
                    or bw <= 0
                    or bh <= 0
                    or x + bw > 1.001
                    or y + bh > 1.001
                ):
                    valid_geometry = False
                    break
                bounds.append(
                    (x * page.width, y * page.height, (x + bw) * page.width, (y + bh) * page.height)
                )
                token = str(word.get("text") or "").strip()
                if token:
                    tokens.append(token)
            if not valid_geometry or not bounds or not tokens:
                continue

            crop_box = list(
                compute_line_crop_box(bounds, page_width=page.width, page_height=page.height)
            )
            if crop_box[2] <= crop_box[0] or crop_box[3] <= crop_box[1]:
                continue

            try:
                proposed_label = normalize_and_validate_ocr_label(" ".join(tokens))
            except ValueError:
                continue

            cropped = page.crop(tuple(crop_box))
            try:
                quality_ok, quality_metrics, quality_reject = evaluate_line_crop_quality(
                    cropped,
                    label=proposed_label,
                    page_height=page.height,
                )
                if not quality_ok:
                    results.append(
                        {
                            "line_index": line_index,
                            "eligible": False,
                            "reject_reason": quality_reject,
                            "quality_metrics": quality_metrics,
                        }
                    )
                    continue

                buf = BytesIO()
                cropped.save(buf, format="PNG", optimize=True)
                png_bytes = buf.getvalue()
            finally:
                cropped.close()
            if not png_bytes:
                continue
            image_sha256 = hashlib.sha256(png_bytes).hexdigest()
            pii_flags = detect_line_pii(proposed_label)
            results.append(
                {
                    "line_index": line_index,
                    "eligible": True,
                    "crop_box": crop_box,
                    "png_bytes": png_bytes,
                    "image_sha256": image_sha256,
                    "proposed_label": proposed_label,
                    "pii_flags": pii_flags,
                    "quality_metrics": quality_metrics,
                }
            )
        return results
    finally:
        page.close()


def _submission_passed_private_gates(sub: ParentBookPageSubmission | None) -> bool:
    """True only when the submission completed OCR, proofreading, and Tool Check / Admin moderation."""
    if sub is None:
        return False
    if sub.WorkflowStatus != "ADDED_TO_BOOK":
        return False
    if sub.OcrStatus != "COMPLETED" or sub.IsImageOnly:
        return False
    if sub.ProofreadStatus != "COMPLETED":
        return False
    if sub.ToolCheckPolicyBlocked:
        return False
    if not sub.CandidateHash:
        return False

    # Path A: Clean Tool Check pass on exact revision snapshot
    clean_tool_check = (
        sub.ToolCheckStatus == "PASSED"
        and sub.ToolCheckInputHash == sub.CandidateHash
        and sub.ToolCheckSuitability == "SUITABLE"
        and len(sub.ToolCheckFindingsJson or []) == 0
    )
    if clean_tool_check:
        return True

    # Path B: Flagged revision explicitly approved by Admin for exact snapshot & version
    admin_approved = (
        sub.AdminDecision == "APPROVE"
        and sub.ApprovedBy is not None
        and sub.ApprovedAt is not None
        and sub.ApprovedSnapshotHash == sub.CandidateHash
        and sub.ApprovedSubmissionVersion == sub.SubmissionVersion
    )
    return admin_approved


def _build_contribution_status_notice(
    *,
    enabled: bool,
    rights_eligible: bool,
    rights_basis: str,
    status_val: str,
) -> str:
    if not enabled:
        if status_val == "REVOKED":
            return (
                "Đóng góp cải thiện nhận diện chữ đã bị thu hồi. Sách này hiện không được dùng cho các đợt "
                "cải thiện mới; quyền đọc sách và tiến độ của bé không bị ảnh hưởng."
            )
        return (
            "Sách này hiện không được dùng để đóng góp cải thiện nhận diện chữ. Bạn có thể chủ động bật đóng góp "
            "ảnh cắt dòng chữ và nhãn đã xác minh bất kỳ lúc nào."
        )
    if not rights_eligible:
        label = SOURCE_TYPE_LABELS.get(rights_basis, rights_basis)
        return (
            f"Bạn đã bật đóng góp, nhưng nguồn sách hiện tại ({label}) chưa đủ căn cứ quyền "
            "đóng góp cải thiện nhận diện chữ. Chỉ sách tự biên soạn, phạm vi công cộng hoặc có giấy phép mới được tuyển mẫu."
        )
    return (
        "Đang bật đóng góp cải thiện nhận diện chữ (Admin xác minh). Các trang đủ điều kiện sẽ tự động "
        "đưa vào hàng đợi Admin đối chiếu từng dòng chữ trước khi đồng bộ. Bạn có thể ngừng đóng góp bất kỳ lúc nào."
    )


class ParentFlow2ContributionService:
    """Service for Parent Private Book -> Flow 2 (Admin Verified) OCR contribution."""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ParentFlow2ContributionRepository(db)

    async def _require_parent(self, actor_id: UUID) -> None:
        if await self.repo.role(actor_id) != "parent":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Chỉ phụ huynh chủ sách mới được thay đổi quyền đóng góp cải thiện nhận diện chữ.",
            )

    async def _require_admin(self, actor_id: UUID) -> None:
        if await self.repo.role(actor_id) != "admin":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin access required",
            )

    def serialize_state(
        self,
        book: Book,
        consent: ParentBookOcrContributionConsent | None,
        counts: dict[str, int] | None = None,
        *,
        last_recruitment_skipped_pages: int = 0,
    ) -> ParentOcrContributionStateRead:
        rights_basis = parse_book_source_type(book.SourceDeclaration)
        rights_eligible = rights_basis in ALLOWED_TRAINING_RIGHTS
        rights_ineligible_reason = (
            None
            if rights_eligible
            else "Nguồn sách hiện tại chưa có căn cứ quyền đóng góp cải thiện nhận diện chữ (cần Tự biên soạn, Phạm vi công cộng hoặc Có giấy phép)."
        )
        enabled = bool(
            consent is not None
            and consent.Status == "OPTED_IN"
            and consent.RightsConfirmed
            and book.LifecycleStatus == "ACTIVE"
            and book.ModerationStatus == MODERATION_ACTIVE
        )
        status_val = consent.Status if consent is not None else "OPTED_OUT"
        c = counts or {}
        return ParentOcrContributionStateRead(
            book_id=book.Id,
            enabled=enabled,
            status=status_val,  # type: ignore[arg-type]
            purpose="FLOW2_ADMIN_VERIFIED_OCR",
            consent_version=int(consent.ConsentVersion) if consent is not None else 0,
            notice_version=consent.NoticeVersion if consent is not None else OCR_CONTRIBUTION_NOTICE_VERSION,
            rights_confirmed=bool(consent.RightsConfirmed) if consent is not None else False,
            consented_at=consent.ConsentedAt if consent is not None else None,
            revoked_at=consent.RevokedAt if consent is not None else None,
            revoke_reason=consent.RevokeReason if consent is not None else None,
            rights_basis=rights_basis,
            rights_eligible_for_training=rights_eligible,
            rights_ineligible_reason=rights_ineligible_reason,
            pending_verification_count=int(c.get("PENDING_VERIFICATION", 0)),
            sync_queued_count=int(c.get("SYNC_QUEUED", 0) + c.get("VERIFIED", 0)),
            synced_count=int(c.get("SYNCED", 0)),
            rejected_count=int(c.get("REJECTED", 0)),
            revoked_count=int(c.get("REVOKED", 0)),
            last_recruitment_skipped_pages=last_recruitment_skipped_pages,
            status_notice=_build_contribution_status_notice(
                enabled=enabled,
                rights_eligible=rights_eligible,
                rights_basis=rights_basis,
                status_val=status_val,
            ),
        )

    async def get_book_contribution_state(
        self, actor_id: UUID, book_id: UUID
    ) -> ParentOcrContributionStateRead:
        await self._require_parent(actor_id)
        book = await self.repo.get_owned_private_book(book_id, actor_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        consent = await self.repo.get_consent(book.Id)
        counts = (await self.repo.get_candidate_counts_by_book([book.Id])).get(book.Id, {})
        return self.serialize_state(book, consent, counts)

    async def update_book_contribution_consent(
        self,
        actor_id: UUID,
        book_id: UUID,
        payload: ParentOcrContributionUpdateRequest,
    ) -> ParentOcrContributionStateRead:
        await self._require_parent(actor_id)

        if payload.enabled:
            # Phase 1: Unlocked validation + snapshot of eligible pages BEFORE releasing DB transaction
            book_snap = await self.repo.get_owned_private_book(book_id, actor_id)
            if book_snap is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if book_snap.VisibilityScope != VISIBILITY_PARENT_PRIVATE or book_snap.OwnerParentId != actor_id:
                raise HTTPException(status_code=403, detail="Access denied")
            if book_snap.LifecycleStatus != "ACTIVE" or book_snap.ModerationStatus != MODERATION_ACTIVE:
                raise HTTPException(
                    status_code=409,
                    detail="Sách riêng đang bị đình chỉ hoặc không còn hoạt động nên không thể bật đóng góp cải thiện nhận diện chữ.",
                )
            if not payload.rights_confirmed:
                raise HTTPException(
                    status_code=422,
                    detail="Bạn cần xác nhận có quyền cho phép sử dụng ảnh cắt dòng chữ và nhãn để đóng góp cải thiện nhận diện chữ.",
                )

            pages_snap = await self.repo.list_active_committed_pages(book_snap.Id)
            download_jobs: list[tuple[UUID, UUID, str, str, list[dict[str, Any]]]] = []
            for page_row, rev_row in pages_snap:
                sub_row = await self.repo.get_committed_submission_for_revision(
                    book_snap.Id, page_row.Id, rev_row.Id
                )
                if not _submission_passed_private_gates(sub_row):
                    continue
                rights_basis = (
                    sub_row.SourceType
                    if sub_row is not None and sub_row.SourceType in SOURCE_TYPE_LABELS
                    else parse_book_source_type(book_snap.SourceDeclaration)
                )
                if rights_basis not in ALLOWED_TRAINING_RIGHTS:
                    continue
                src_path = str(
                    (rev_row.ProcessingMeta or {}).get("source_image_path") or page_row.ImagePath or ""
                ).strip()
                src_hash = str(rev_row.ContentHash or "").strip()
                if not src_path or not src_hash:
                    continue
                rev_words = await self.repo.list_revision_words(rev_row.Id)
                if not rev_words:
                    continue
                word_dicts = [
                    {
                        "word_index": int(w.WordIndex),
                        "line_index": int(w.LineIndex),
                        "text": w.Text,
                        "bounding_box": list(w.BoundingBox or []),
                    }
                    for w in rev_words
                ]
                download_jobs.append((page_row.Id, rev_row.Id, src_path, src_hash, word_dicts))

            # Release DB read transaction before any Storage downloads or PIL cropping
            await self.repo.rollback()

            # Phase 2: Download & crop outside DB locks
            preloaded_crops: dict[tuple[UUID, UUID, str, str], list[dict[str, Any]] | None] = {}
            for p_id, r_id, src_path, src_hash, word_dicts in download_jobs:
                key = (p_id, r_id, src_path, src_hash)
                try:
                    image_bytes = await asyncio.to_thread(
                        download_object, src_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
                    )
                    preloaded_crops[key] = await asyncio.to_thread(
                        extract_line_crops_with_boxes, image_bytes, word_dicts
                    )
                except Exception as exc:
                    logger.warning(
                        "Failed to download private page image for Flow 2 recruitment: %s",
                        type(exc).__name__,
                    )
                    preloaded_crops[key] = None

            # Phase 3: Acquire canonical Book -> Consent locks and persist atomically
            book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
            if book is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            if book.VisibilityScope != VISIBILITY_PARENT_PRIVATE or book.OwnerParentId != actor_id:
                raise HTTPException(status_code=403, detail="Access denied")
            if book.LifecycleStatus != "ACTIVE" or book.ModerationStatus != MODERATION_ACTIVE:
                raise HTTPException(
                    status_code=409,
                    detail="Sách riêng đang bị đình chỉ hoặc không còn hoạt động nên không thể bật đóng góp cải thiện nhận diện chữ.",
                )

            now = datetime.now(timezone.utc)
            consent = await self.repo.get_consent(book.Id, lock=True)

            if consent is None:
                consent = ParentBookOcrContributionConsent(
                    BookId=book.Id,
                    OwnerParentId=actor_id,
                    Purpose="FLOW2_ADMIN_VERIFIED_OCR",
                    Status="OPTED_IN",
                    ConsentVersion=1,
                    NoticeVersion=payload.notice_version,
                    RightsConfirmed=True,
                    ConsentedAt=now,
                    RevokedAt=None,
                    RevokeReason=None,
                    CreatedAt=now,
                    UpdatedAt=now,
                )
                await self.repo.save_consent(consent)
                await self.repo.add_consent_event(
                    ParentBookOcrContributionConsentEvent(
                        BookId=book.Id,
                        OwnerParentId=actor_id,
                        ActorId=actor_id,
                        Action="OPT_IN",
                        ConsentVersion=1,
                        Purpose="FLOW2_ADMIN_VERIFIED_OCR",
                        NoticeVersion=payload.notice_version,
                        RightsConfirmed=True,
                        CreatedAt=now,
                    )
                )
            elif consent.Status != "OPTED_IN":
                consent.Status = "OPTED_IN"
                consent.ConsentVersion = int(consent.ConsentVersion) + 1
                consent.NoticeVersion = payload.notice_version
                consent.RightsConfirmed = True
                consent.ConsentedAt = now
                consent.RevokedAt = None
                consent.RevokeReason = None
                consent.UpdatedAt = now
                await self.repo.add_consent_event(
                    ParentBookOcrContributionConsentEvent(
                        BookId=book.Id,
                        OwnerParentId=actor_id,
                        ActorId=actor_id,
                        Action="OPT_IN",
                        ConsentVersion=int(consent.ConsentVersion),
                        Purpose="FLOW2_ADMIN_VERIFIED_OCR",
                        NoticeVersion=payload.notice_version,
                        RightsConfirmed=True,
                        CreatedAt=now,
                    )
                )
            else:
                # Idempotent re-enable: do not bump consent_version or create duplicate events
                consent.UpdatedAt = now

            recruitment = await self.recruit_book_pages(
                book, consent, preloaded_crops=preloaded_crops
            )
            await self.repo.add_audit_log(
                actor_id=actor_id,
                action="parent_private_book.ocr_contribution.opted_in",
                resource_type="book",
                resource_id=book.Id,
                metadata={
                    "consent_version": int(consent.ConsentVersion),
                    "notice_version": consent.NoticeVersion,
                    "recruited_candidates": recruitment["recruited_candidates"],
                    "skipped_pages": recruitment["skipped_pages"],
                },
            )
            await self.repo.commit()
            counts = (await self.repo.get_candidate_counts_by_book([book.Id])).get(book.Id, {})
            return self.serialize_state(
                book,
                consent,
                counts,
                last_recruitment_skipped_pages=recruitment["skipped_pages"],
            )

        # Turning OFF consent (OPT_OUT) — canonical Book -> Consent lock order
        book = await self.repo.get_owned_private_book(book_id, actor_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.VisibilityScope != VISIBILITY_PARENT_PRIVATE or book.OwnerParentId != actor_id:
            raise HTTPException(status_code=403, detail="Access denied")
        now = datetime.now(timezone.utc)
        consent = await self.repo.get_consent(book.Id, lock=True)
        revoke_reason = payload.revoke_reason or "PARENT_OPTED_OUT"
        if consent is None:
            consent = ParentBookOcrContributionConsent(
                BookId=book.Id,
                OwnerParentId=actor_id,
                Purpose="FLOW2_ADMIN_VERIFIED_OCR",
                Status="OPTED_OUT",
                ConsentVersion=1,
                NoticeVersion=payload.notice_version,
                RightsConfirmed=False,
                ConsentedAt=None,
                RevokedAt=now,
                RevokeReason=revoke_reason,
                CreatedAt=now,
                UpdatedAt=now,
            )
            await self.repo.save_consent(consent)
        else:
            if consent.Status == "OPTED_IN":
                consent.ConsentVersion = int(consent.ConsentVersion) + 1
            consent.Status = "OPTED_OUT"
            consent.RevokedAt = now
            consent.RevokeReason = revoke_reason
            consent.UpdatedAt = now

        await self.repo.add_consent_event(
            ParentBookOcrContributionConsentEvent(
                BookId=book.Id,
                OwnerParentId=actor_id,
                ActorId=actor_id,
                Action="OPT_OUT",
                ConsentVersion=int(consent.ConsentVersion),
                Purpose="FLOW2_ADMIN_VERIFIED_OCR",
                NoticeVersion=consent.NoticeVersion,
                RightsConfirmed=False,
                Reason=revoke_reason,
                CreatedAt=now,
            )
        )
        downstream = await self.repo.revoke_candidates_and_downstream(
            book_id=book.Id,
            page_id=None,
            reason=revoke_reason,
            now=now,
        )
        await self.repo.add_audit_log(
            actor_id=actor_id,
            action="parent_private_book.ocr_contribution.opted_out",
            resource_type="book",
            resource_id=book.Id,
            metadata={
                "consent_version": int(consent.ConsentVersion),
                "reason": revoke_reason,
                **downstream,
            },
        )
        await self.repo.commit()
        counts = (await self.repo.get_candidate_counts_by_book([book.Id])).get(book.Id, {})
        return self.serialize_state(book, consent, counts)

    async def recruit_book_pages(
        self,
        book: Book,
        consent: ParentBookOcrContributionConsent,
        *,
        preloaded_crops: dict[tuple[UUID, UUID, str, str], list[dict[str, Any]] | None] | None = None,
    ) -> dict[str, int]:
        """Automatically recruit all eligible active committed pages of an opted-in book."""
        if (
            book.VisibilityScope != VISIBILITY_PARENT_PRIVATE
            or book.LifecycleStatus != "ACTIVE"
            or book.ModerationStatus != MODERATION_ACTIVE
            or consent.Status != "OPTED_IN"
            or not consent.RightsConfirmed
        ):
            return {"recruited_candidates": 0, "skipped_pages": 0}

        pages = await self.repo.list_active_committed_pages(book.Id)
        recruited = 0
        skipped_pages = 0
        for page, rev in pages:
            sub = await self.repo.get_committed_submission_for_revision(
                book.Id, page.Id, rev.Id
            )
            src_path = str(
                (rev.ProcessingMeta or {}).get("source_image_path") or page.ImagePath or ""
            ).strip()
            src_hash = str(rev.ContentHash or "").strip()
            crop_key = (page.Id, rev.Id, src_path, src_hash)
            has_preloaded = preloaded_crops is not None and crop_key in preloaded_crops
            if has_preloaded and preloaded_crops is not None and preloaded_crops[crop_key] is None:
                skipped_pages += 1
                continue
            page_res = await self.recruit_committed_page(
                book=book,
                page=page,
                revision=rev,
                submission=sub,
                consent=consent,
                preloaded_extracted=(
                    preloaded_crops[crop_key]
                    if has_preloaded and preloaded_crops is not None
                    else None
                ),
            )
            recruited += page_res["recruited_candidates"]
            if page_res["page_skipped"]:
                skipped_pages += 1
        return {"recruited_candidates": recruited, "skipped_pages": skipped_pages}

    async def recruit_committed_page_if_opted_in(
        self,
        *,
        book: Book,
        page: BookPage,
        revision: PageRevision,
        submission: ParentBookPageSubmission | None,
        preloaded_image_bytes: bytes | None = None,
    ) -> dict[str, int]:
        """Hook called after add_page_to_book() commits a page; recruits only if book is OPTED_IN."""
        consent = await self.repo.get_consent(book.Id)
        if consent is None or consent.Status != "OPTED_IN" or not consent.RightsConfirmed:
            return {"recruited_candidates": 0, "page_skipped": False}
        return await self.recruit_committed_page(
            book=book,
            page=page,
            revision=revision,
            submission=submission,
            consent=consent,
            preloaded_image_bytes=preloaded_image_bytes,
        )

    async def recruit_committed_page(
        self,
        *,
        book: Book,
        page: BookPage,
        revision: PageRevision,
        submission: ParentBookPageSubmission | None,
        consent: ParentBookOcrContributionConsent,
        preloaded_image_bytes: bytes | None = None,
        preloaded_extracted: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Enforce all Section 3 gates for one committed page and insert line candidates."""
        if (
            book.VisibilityScope != VISIBILITY_PARENT_PRIVATE
            or book.LifecycleStatus != "ACTIVE"
            or book.ModerationStatus != MODERATION_ACTIVE
            or page.LifecycleStatus != "ACTIVE"
            or page.CurrentVerifiedRevisionId != revision.Id
            or revision.VerificationStatus != "VERIFIED"
            or consent.Status != "OPTED_IN"
            or not consent.RightsConfirmed
        ):
            return {"recruited_candidates": 0, "page_skipped": True, "reason": "INACTIVE_OR_NO_CONSENT"}

        if not _submission_passed_private_gates(submission):
            return {"recruited_candidates": 0, "page_skipped": True, "reason": "PRIVATE_GATES_NOT_MET"}

        rights_basis = (
            submission.SourceType
            if submission is not None and submission.SourceType in SOURCE_TYPE_LABELS
            else parse_book_source_type(book.SourceDeclaration)
        )
        if rights_basis not in ALLOWED_TRAINING_RIGHTS:
            return {"recruited_candidates": 0, "page_skipped": True, "reason": "RIGHTS_BASIS_INSUFFICIENT"}

        source_image_path = str(
            (revision.ProcessingMeta or {}).get("source_image_path") or page.ImagePath or ""
        ).strip()
        source_content_hash = str(revision.ContentHash or "").strip()
        if not source_image_path or not source_content_hash:
            return {"recruited_candidates": 0, "page_skipped": True, "reason": "MISSING_IMAGE_OR_HASH"}

        book_id = book.Id
        owner_parent_id = book.OwnerParentId
        page_id = page.Id
        revision_id = revision.Id
        submission_id = submission.Id if submission is not None else None
        consent_version = int(consent.ConsentVersion)

        if preloaded_extracted is not None:
            extracted = preloaded_extracted
        else:
            words = await self.repo.list_revision_words(revision_id)
            if not words:
                return {"recruited_candidates": 0, "page_skipped": True, "reason": "NO_REVISION_WORDS"}

            word_dicts = [
                {
                    "word_index": int(w.WordIndex),
                    "line_index": int(w.LineIndex),
                    "text": w.Text,
                    "bounding_box": list(w.BoundingBox or []),
                }
                for w in words
            ]
            if preloaded_image_bytes is not None:
                image_bytes = preloaded_image_bytes
            else:
                in_nested_fn = getattr(self.db, "in_nested_transaction", None)
                if not (callable(in_nested_fn) and in_nested_fn()):
                    await self.repo.rollback()
                try:
                    image_bytes = await asyncio.to_thread(
                        download_object, source_image_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
                    )
                except Exception as exc:
                    logger.warning("Failed to download private page image for Flow 2 recruitment: %s", type(exc).__name__)
                    return {"recruited_candidates": 0, "page_skipped": True, "reason": "IMAGE_DOWNLOAD_FAILED"}

            extracted = await asyncio.to_thread(extract_line_crops_with_boxes, image_bytes, word_dicts)

        now = datetime.now(timezone.utc)
        recruited = 0

        for line in extracted:
            if not line.get("eligible"):
                continue
            line_index = int(line["line_index"])
            image_sha256 = str(line["image_sha256"])
            proposed_label = str(line["proposed_label"])
            pii_flags = list(line.get("pii_flags") or [])
            pii_status = "FLAGGED_PII" if pii_flags else "CLEAR"
            idempotency_key = f"{book_id}:{page_id}:{revision_id}:{line_index}:{image_sha256}"

            existing = await self.repo.get_candidate_by_idempotency_key(idempotency_key)
            if existing is not None:
                # Idempotent: never duplicate; if previously revoked and now opted back in cleanly,
                # reopen for fresh Admin verification and clear all stale decision/outbox/sample fields.
                if existing.Status == "REVOKED" and pii_status == "CLEAR":
                    existing.ConsentVersion = consent_version
                    existing.Status = "PENDING_VERIFICATION"
                    existing.ProposedLabel = proposed_label
                    existing.RightsBasis = rights_basis
                    existing.VerifiedLabel = None
                    existing.VerifiedLabelSha256 = None
                    existing.VerifiedBy = None
                    existing.VerifiedAt = None
                    existing.RejectionCode = None
                    existing.RejectionReason = None
                    existing.OutboxEventId = None
                    existing.SampleId = None
                    existing.RevokedAt = None
                    existing.RevokeReason = None
                    existing.PiiCheckStatus = "CLEAR"
                    existing.PiiFlagsJson = []
                    existing.QualityMetricsJson = line["quality_metrics"]
                    existing.UpdatedAt = now
                    recruited += 1
                continue

            # If PII is detected, record as REJECTED immediately so it can NEVER enter training
            if pii_status == "FLAGGED_PII":
                cand = ParentBookFlow2Candidate(
                    BookId=book_id,
                    OwnerParentId=owner_parent_id,
                    PageId=page_id,
                    RevisionId=revision_id,
                    SubmissionId=submission_id,
                    ConsentVersion=consent_version,
                    LineIndex=line_index,
                    IdempotencyKey=idempotency_key,
                    SourceImagePath=source_image_path,
                    SourceContentHash=source_content_hash,
                    CropBoxJson=line["crop_box"],
                    ImageSha256=image_sha256,
                    ProposedLabel=proposed_label,
                    RightsBasis=rights_basis,
                    PiiCheckStatus="FLAGGED_PII",
                    PiiFlagsJson=pii_flags,
                    QualityMetricsJson=line["quality_metrics"],
                    Status="REJECTED",
                    RejectionCode="CONTAINS_PII",
                    RejectionReason=f"Tự động loại do phát hiện dấu hiệu thông tin cá nhân: {', '.join(pii_flags)}",
                    CreatedAt=now,
                    UpdatedAt=now,
                )
                await self.repo.create_candidate(cand)
                continue

            # Check if an Admin ALREADY verified this exact revision+line+image+content_hash
            prior_verified = await self.repo.get_prior_admin_verified_candidate(
                revision_id=revision_id,
                line_index=line_index,
                image_sha256=image_sha256,
                source_content_hash=source_content_hash,
            )
            if prior_verified is not None:
                # Already exists and verified on this exact revision
                continue

            cand = ParentBookFlow2Candidate(
                BookId=book_id,
                OwnerParentId=owner_parent_id,
                PageId=page_id,
                RevisionId=revision_id,
                SubmissionId=submission_id,
                ConsentVersion=consent_version,
                LineIndex=line_index,
                IdempotencyKey=idempotency_key,
                SourceImagePath=source_image_path,
                SourceContentHash=source_content_hash,
                CropBoxJson=line["crop_box"],
                ImageSha256=image_sha256,
                ProposedLabel=proposed_label,
                RightsBasis=rights_basis,
                PiiCheckStatus="CLEAR",
                PiiFlagsJson=[],
                QualityMetricsJson=line["quality_metrics"],
                Status="PENDING_VERIFICATION",
                CreatedAt=now,
                UpdatedAt=now,
            )
            await self.repo.create_candidate(cand)
            recruited += 1

        return {"recruited_candidates": recruited, "page_skipped": False}

    async def revoke_on_lifecycle_change(
        self,
        *,
        book: Book,
        actor_id: UUID,
        reason: str,
        page_id: UUID | None = None,
        consent_event_action: str | None = None,
    ) -> dict[str, int]:
        """Called inside book delete, book suspend, page delete, or page revision edit/replace transactions."""
        now = datetime.now(timezone.utc)
        if page_id is None and consent_event_action in ("REVOKE_BOOK_DELETED", "REVOKE_BOOK_SUSPENDED"):
            consent = await self.repo.get_consent(book.Id, lock=True)
            if consent is not None and consent.Status == "OPTED_IN":
                consent.Status = "REVOKED"
                consent.ConsentVersion = int(consent.ConsentVersion) + 1
                consent.RevokedAt = now
                consent.RevokeReason = reason
                consent.UpdatedAt = now
                await self.repo.add_consent_event(
                    ParentBookOcrContributionConsentEvent(
                        BookId=book.Id,
                        OwnerParentId=book.OwnerParentId,
                        ActorId=actor_id,
                        Action=consent_event_action,
                        ConsentVersion=int(consent.ConsentVersion),
                        Purpose="FLOW2_ADMIN_VERIFIED_OCR",
                        NoticeVersion=consent.NoticeVersion,
                        RightsConfirmed=False,
                        Reason=reason,
                        CreatedAt=now,
                    )
                )

        return await self.repo.revoke_candidates_and_downstream(
            book_id=book.Id,
            page_id=page_id,
            reason=reason,
            now=now,
        )

    # ------------------------------------------------------------------
    # Admin Line-Label Verification Queue ("Chất lượng sách -> Sách người dùng")
    # ------------------------------------------------------------------
    def _serialize_admin_candidate(
        self,
        cand: ParentBookFlow2Candidate,
        book_title: str,
        page_number: int,
        *,
        base_url: str | None = None,
    ) -> AdminFlow2CandidateRead:
        return AdminFlow2CandidateRead(
            id=cand.Id,
            book_id=cand.BookId,
            book_title=book_title,
            page_id=cand.PageId,
            page_number=page_number,
            revision_id=cand.RevisionId,
            line_index=int(cand.LineIndex),
            consent_version=int(cand.ConsentVersion),
            crop_image_url=admin_flow2_candidate_crop_url(cand.Id, base_url=base_url),
            image_sha256=cand.ImageSha256,
            proposed_label=cand.ProposedLabel,
            verified_label=cand.VerifiedLabel,
            rights_basis=cand.RightsBasis,  # type: ignore[arg-type]
            rights_basis_label=SOURCE_TYPE_LABELS.get(cand.RightsBasis, cand.RightsBasis),
            pii_check_status=cand.PiiCheckStatus,  # type: ignore[arg-type]
            pii_flags=list(cand.PiiFlagsJson or []),
            quality_metrics=dict(cand.QualityMetricsJson or {}),
            status=cand.Status,  # type: ignore[arg-type]
            status_label=FLOW2_CANDIDATE_STATUS_LABELS.get(cand.Status, cand.Status),
            verified_at=cand.VerifiedAt,
            rejection_code=cand.RejectionCode,
            rejection_reason=cand.RejectionReason,
            outbox_event_id=cand.OutboxEventId,
            sample_id=cand.SampleId,
            revoked_at=cand.RevokedAt,
            revoke_reason=cand.RevokeReason,
            created_at=cand.CreatedAt,
            updated_at=cand.UpdatedAt,
        )

    async def admin_list_candidates(
        self,
        actor_id: UUID,
        *,
        status_filter: str | None = None,
        book_id: UUID | None = None,
        limit: int = 25,
        offset: int = 0,
        base_url: str | None = None,
    ) -> AdminFlow2CandidatePageRead:
        await self._require_admin(actor_id)
        rows, total, summary = await self.repo.list_admin_candidates(
            status_filter=status_filter or None,
            book_id=book_id,
            limit=limit,
            offset=offset,
        )
        return AdminFlow2CandidatePageRead(
            items=[
                self._serialize_admin_candidate(cand, title, page_num, base_url=base_url)
                for cand, title, page_num in rows
            ],
            total=total,
            limit=limit,
            offset=offset,
            summary=summary,
        )

    async def admin_read_candidate_crop_image(
        self, actor_id: UUID, candidate_id: UUID
    ) -> tuple[bytes, str]:
        """Stream ONLY the cropped line PNG to an authenticated Admin after live book/consent verification."""
        await self._require_admin(actor_id)
        cand = await self.repo.get_candidate(candidate_id)
        if cand is None or cand.Status == "REVOKED":
            raise HTTPException(status_code=404, detail="Resource not found")

        book = await self.repo.get_private_book(cand.BookId)
        if (
            book is None
            or bool(getattr(book, "IsDeleted", False))
            or book.LifecycleStatus != "ACTIVE"
        ):
            raise HTTPException(status_code=404, detail="Resource not found")
        if book.ModerationStatus != MODERATION_ACTIVE:
            raise HTTPException(
                status_code=403,
                detail="Sách riêng đang bị đình chỉ nên không thể xem ảnh đóng góp.",
            )

        consent = await self.repo.get_consent(cand.BookId)
        if consent is None or consent.Status != "OPTED_IN":
            raise HTTPException(
                status_code=403,
                detail="Phụ huynh đã tắt hoặc thu hồi quyền đóng góp OCR cho sách này.",
            )

        source_image_path = str(cand.SourceImagePath)
        crop_box = list(cand.CropBoxJson or [])
        cand_id = cand.Id
        cand_book_id = cand.BookId
        cand_page_id = cand.PageId
        cand_revision_id = cand.RevisionId
        cand_line_index = int(cand.LineIndex)
        if len(crop_box) != 4:
            raise HTTPException(status_code=409, detail="Invalid line crop geometry")

        await self.repo.add_audit_log(
            actor_id=actor_id,
            action="admin.flow2_candidate.crop_viewed",
            resource_type="parent_book_flow2_candidate",
            resource_id=cand_id,
            metadata={
                "book_id": str(cand_book_id),
                "page_id": str(cand_page_id),
                "revision_id": str(cand_revision_id),
                "line_index": cand_line_index,
            },
        )
        await self.repo.commit()

        image_bytes = await asyncio.to_thread(
            download_object, source_image_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
        )

        def _render_crop() -> bytes:
            rgb = open_image_exif_safe(image_bytes)
            try:
                cropped = rgb.crop(
                    (int(crop_box[0]), int(crop_box[1]), int(crop_box[2]), int(crop_box[3]))
                )
                try:
                    out = BytesIO()
                    cropped.save(out, format="PNG", optimize=True)
                    return out.getvalue()
                finally:
                    cropped.close()
            finally:
                rgb.close()

        png_bytes = await asyncio.to_thread(_render_crop)
        return png_bytes, "image/png"

    async def admin_decide_candidate(
        self,
        actor_id: UUID,
        candidate_id: UUID,
        payload: AdminFlow2CandidateDecisionRequest,
    ) -> AdminFlow2CandidateDecisionResponse:
        await self._require_admin(actor_id)
        # Canonical lock order: Book -> Consent -> Candidate (prevents AB-BA deadlock
        # with parent opt-out / book delete / book suspend).
        cand_preview = await self.repo.get_candidate(candidate_id)
        if cand_preview is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        book = await self.repo.get_private_book(cand_preview.BookId, lock=True)
        consent = await self.repo.get_consent(cand_preview.BookId, lock=True)
        cand = await self.repo.get_candidate(candidate_id, lock=True)
        if cand is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        now = datetime.now(timezone.utc)

        if payload.decision == "REJECT":
            reason = payload.reason or (
                FLOW2_REJECTION_CODE_LABELS.get(payload.rejection_code or "", None)
                if payload.rejection_code
                else None
            )
            if not reason or len(reason.strip()) < 3:
                raise HTTPException(
                    status_code=422,
                    detail="Vui lòng chọn mã từ chối hoặc nhập lý do từ chối mẫu.",
                )
            if cand.Status in ("SYNCED", "REVOKED"):
                raise HTTPException(
                    status_code=409,
                    detail=f"Mẫu đang ở trạng thái {cand.Status} nên không thể từ chối.",
                )
            cand.Status = "REJECTED"
            cand.RejectionCode = payload.rejection_code or "OTHER"
            cand.RejectionReason = reason.strip()
            cand.VerifiedBy = actor_id
            cand.VerifiedAt = now
            cand.UpdatedAt = now
            audit = await self.repo.add_audit_log(
                actor_id=actor_id,
                action="admin.flow2_candidate.rejected",
                resource_type="parent_book_flow2_candidate",
                resource_id=cand.Id,
                metadata={
                    "book_id": str(cand.BookId),
                    "page_id": str(cand.PageId),
                    "revision_id": str(cand.RevisionId),
                    "rejection_code": cand.RejectionCode,
                    "reason": cand.RejectionReason,
                },
            )
            await self.repo.commit()
            return AdminFlow2CandidateDecisionResponse(
                candidate_id=cand.Id,
                book_id=cand.BookId,
                page_id=cand.PageId,
                revision_id=cand.RevisionId,
                decision="REJECT",
                status="REJECTED",
                rejection_code=cand.RejectionCode,
                rejection_reason=cand.RejectionReason,
                decided_at=now,
                audit_log_id=audit.Id,
            )

        # APPROVE: strict live re-verification of ownership, consent, active page/revision, rights, PII, label
        if cand.Status in ("SYNC_QUEUED", "SYNCED") and cand.OutboxEventId is not None:
            # Idempotent replay if already approved & queued/synced
            audit = await self.repo.add_audit_log(
                actor_id=actor_id,
                action="admin.flow2_candidate.approve_idempotent_replay",
                resource_type="parent_book_flow2_candidate",
                resource_id=cand.Id,
                metadata={"status": cand.Status, "outbox_event_id": str(cand.OutboxEventId)},
            )
            await self.repo.commit()
            return AdminFlow2CandidateDecisionResponse(
                candidate_id=cand.Id,
                book_id=cand.BookId,
                page_id=cand.PageId,
                revision_id=cand.RevisionId,
                decision="APPROVE",
                status=cand.Status,  # type: ignore[arg-type]
                verified_label=cand.VerifiedLabel,
                outbox_event_id=cand.OutboxEventId,
                decided_at=cand.VerifiedAt or now,
                audit_log_id=audit.Id,
            )

        if cand.Status != "PENDING_VERIFICATION":
            raise HTTPException(
                status_code=409,
                detail=f"Mẫu đang ở trạng thái {cand.Status}, không thể xác nhận duyệt.",
            )

        page, rev = await self.repo.get_page_and_revision(cand.PageId, cand.RevisionId)

        if (
            book is None
            or book.LifecycleStatus != "ACTIVE"
            or book.ModerationStatus != MODERATION_ACTIVE
            or consent is None
            or consent.Status != "OPTED_IN"
            or not consent.RightsConfirmed
            or int(consent.ConsentVersion) != int(cand.ConsentVersion)
            or page is None
            or page.LifecycleStatus != "ACTIVE"
            or rev is None
            or page.CurrentVerifiedRevisionId != rev.Id
            or rev.VerificationStatus != "VERIFIED"
            or rev.ContentHash != cand.SourceContentHash
        ):
            cand.Status = "REVOKED"
            cand.RevokedAt = now
            cand.RevokeReason = "STALE_CONSENT_OR_REVISION_AT_ADMIN_APPROVAL"
            cand.UpdatedAt = now
            await self.repo.commit()
            raise HTTPException(
                status_code=409,
                detail="Quyền đóng góp hoặc phiên bản trang đã thay đổi nên mẫu này đã bị thu hồi và không thể duyệt.",
            )

        if cand.RightsBasis not in ALLOWED_TRAINING_RIGHTS:
            raise HTTPException(
                status_code=409,
                detail="Nguồn sách của mẫu không đủ căn cứ quyền huấn luyện.",
            )

        raw_label = payload.verified_label if payload.verified_label is not None else cand.ProposedLabel
        try:
            verified_label = normalize_and_validate_ocr_label(raw_label)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        pii_flags = detect_line_pii(verified_label)
        if cand.PiiCheckStatus != "CLEAR" or pii_flags:
            raise HTTPException(
                status_code=422,
                detail=f"Nhãn chứa dấu hiệu thông tin cá nhân ({', '.join(pii_flags or cand.PiiFlagsJson or ['PII'])}) nên không thể đưa vào tập huấn luyện.",
            )

        verified_label_sha256 = hashlib.sha256(verified_label.encode("utf-8")).hexdigest()
        cand.VerifiedLabel = verified_label
        cand.VerifiedLabelSha256 = verified_label_sha256
        cand.VerifiedBy = actor_id
        cand.VerifiedAt = now
        cand.Status = "SYNC_QUEUED"
        cand.UpdatedAt = now

        outbox_payload = json.dumps(
            {
                "source_origin": "PARENT_PRIVATE_CONTRIBUTION",
                "book_id": str(cand.BookId),
                "candidate_id": str(cand.Id),
                "consent_version": int(cand.ConsentVersion),
                "notice_version": consent.NoticeVersion,
                "rights_basis": cand.RightsBasis,
                "line_index": int(cand.LineIndex),
                "source_content_hash": cand.SourceContentHash,
                "image_sha256": cand.ImageSha256,
                "verified_label_sha256": verified_label_sha256,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        outbox_event_id = await self.repo.enqueue_candidate_outbox(
            candidate_id=cand.Id,
            page_id=cand.PageId,
            revision_id=cand.RevisionId,
            actor_id=actor_id,
            payload_json=outbox_payload,
        )
        cand.OutboxEventId = outbox_event_id

        audit = await self.repo.add_audit_log(
            actor_id=actor_id,
            action="admin.flow2_candidate.approved",
            resource_type="parent_book_flow2_candidate",
            resource_id=cand.Id,
            metadata={
                "book_id": str(cand.BookId),
                "page_id": str(cand.PageId),
                "revision_id": str(cand.RevisionId),
                "consent_version": int(cand.ConsentVersion),
                "outbox_event_id": str(outbox_event_id),
                "verified_label_sha256": verified_label_sha256,
            },
        )
        await self.repo.commit()

        return AdminFlow2CandidateDecisionResponse(
            candidate_id=cand.Id,
            book_id=cand.BookId,
            page_id=cand.PageId,
            revision_id=cand.RevisionId,
            decision="APPROVE",
            status="SYNC_QUEUED",
            verified_label=verified_label,
            outbox_event_id=outbox_event_id,
            decided_at=now,
            audit_log_id=audit.Id,
        )
