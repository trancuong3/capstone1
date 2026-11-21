from __future__ import annotations

import hashlib
import json
import unicodedata
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AdminAiWorkflow
from app.repositories.admin_ai_workflow_repository import AdminAiWorkflowRepository
from app.repositories.admin_ocr_repository import AdminOcrRepository
from app.schemas.admin_ai_workflow import (
    AdminAiCandidateUpdate,
    AdminAiImageSafetyReviewRequest,
    AdminAiSafetyDecision,
    AdminAiUncertainResolutionRequest,
    AdminAiWorkflowCreate,
    AdminAiWorkflowRead,
)
from app.services.admin_ocr_service import AdminOcrService
from app.services.ocr_ai.child_safety import (
    compact_finding_text,
    normalize_safety_text,
)


class AdminAiWorkflowService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = AdminAiWorkflowRepository(db)

    @staticmethod
    def _hash(value: str) -> str:
        return hashlib.sha256(normalize_safety_text(value).encode("utf-8")).hexdigest()

    @staticmethod
    def _archive_safety_result(row: AdminAiWorkflow, now: datetime) -> None:
        if not row.SafetyInputHash and not row.Findings:
            return
        history = list(row.SafetyHistory or [])
        history.append({
            "scan_id": (row.SafetyMetadata or {}).get("scan_id"),
            "content_hash": row.SafetyInputHash,
            "status": row.SafetyStatus,
            "suitability": row.Suitability,
            "findings": list(row.Findings or []),
            "metadata": dict(row.SafetyMetadata or {}),
            "confirmed_at": row.SafetyConfirmedAt.isoformat() if row.SafetyConfirmedAt else None,
            "confirmed_by": str(row.SafetyConfirmedBy) if row.SafetyConfirmedBy else None,
            "archived_at": now.isoformat(),
        })
        row.SafetyHistory = history

    @staticmethod
    def validate_safety_decision_reason(
        row: AdminAiWorkflow, payload: AdminAiSafetyDecision
    ) -> None:
        requires_reason = bool(row.Findings) or row.Suitability != "SUITABLE"
        if payload.confirmed and requires_reason and not payload.reason:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "SAFETY_REVIEW_REASON_REQUIRED",
                    "message": "Hãy ghi lý do Admin xác nhận kết quả Safety có finding hoặc cần xem xét.",
                },
            )

    @staticmethod
    def _compact_findings(value: object) -> list[dict[str, object]]:
        findings: list[dict[str, object]] = []
        if not isinstance(value, list):
            return findings
        for item in value:
            if not isinstance(item, dict):
                continue
            compact = dict(item)
            explanation, recommendation = compact_finding_text(
                compact.get("category"),
                compact.get("severity"),
                compact.get("evidence_text"),
                compact.get("explanation"),
                compact.get("recommendation"),
            )
            compact["explanation"] = explanation
            compact["recommendation"] = recommendation
            findings.append(compact)
        return findings

    @staticmethod
    def _image_hash(image_path: str, revision_meta: object | None) -> str:
        if isinstance(revision_meta, dict):
            stored = revision_meta.get("source_image_sha256")
            if isinstance(stored, str) and len(stored.strip()) == 64:
                return stored.strip().lower()
        return hashlib.sha256(image_path.encode("utf-8")).hexdigest()

    @staticmethod
    def _read(row: AdminAiWorkflow) -> AdminAiWorkflowRead:
        candidate_hash = row.CandidateHash
        safety_hash = row.SafetyInputHash
        findings = AdminAiWorkflowService._compact_findings(row.Findings)
        safety_history: list[dict[str, object]] = []
        for item in row.SafetyHistory or []:
            if not isinstance(item, dict):
                continue
            compact = dict(item)
            compact["findings"] = AdminAiWorkflowService._compact_findings(
                compact.get("findings")
            )
            safety_history.append(compact)
        return AdminAiWorkflowRead(
            workflow_id=row.Id,
            page_id=row.PageId,
            book_id=row.BookId,
            page_revision_id=row.PageRevisionId,
            status=row.Status,
            stage=row.Stage,
            progress={"completed_chunks": row.CompletedChunks, "total_chunks": row.TotalChunks},
            attempts=int(row.Attempts or 0),
            error_code=row.ErrorCode,
            original_ocr_hash=row.OriginalOcrHash,
            admin_input_hash=row.AdminInputHash,
            image_hash=getattr(row, "ImageHash", None),
            proofread_text=row.ProofreadText,
            proofread_output_hash=row.ProofreadOutputHash,
            corrections=list(row.CorrectionSuggestions or []),
            uncertain_word_indices=[int(value) for value in row.UncertainWordIndices or []],
            proofread_metadata=dict(row.ProofreadMetadata or {}),
            safety_metadata=dict(row.SafetyMetadata or {}),
            candidate_history=list(row.CandidateHistory or []),
            safety_history=safety_history,
            review_history=list(row.ReviewEvents or []),
            candidate_text=row.CandidateText,
            candidate_hash=candidate_hash,
            candidate_version=row.CandidateVersion,
            safety_input_hash=safety_hash,
            hash_match=bool(candidate_hash and safety_hash and candidate_hash == safety_hash),
            suitability=row.Suitability,
            safety_status=row.SafetyStatus,
            image_safety_status=getattr(row, "ImageSafetyStatus", None) or "NOT_REVIEWED",
            image_safety_reviewed_at=getattr(row, "ImageSafetyReviewedAt", None),
            image_safety_review_note=getattr(row, "ImageSafetyReviewNote", None),
            rights_profile_id=getattr(row, "RightsProfileId", None),
            rights_profile_version=getattr(row, "RightsProfileVersion", None),
            rights_profile_hash=getattr(row, "RightsProfileHash", None),
            findings=findings,
            provider_events=list(row.ProviderEvents or []),
            ocr_approved_at=row.OcrApprovedAt,
            final_approved_text_hash=row.FinalApprovedTextHash,
            created_at=row.CreatedAt,
            updated_at=row.UpdatedAt,
        )

    async def start(
        self, actor_id: UUID, page_id: UUID, payload: AdminAiWorkflowCreate
    ) -> AdminAiWorkflowRead:
        await AdminOcrService(self.db).require_admin(actor_id)
        existing = await self.repo.by_idempotency(actor_id, page_id, payload.idempotency_key)
        if existing is not None:
            return self._read(existing)

        ocr_service = AdminOcrService(self.db)
        prepared = await ocr_service.prepare_ai_correction(
            actor_id, page_id, payload.draft_text,
            [word for word in payload.words],
        )
        revision = await AdminOcrRepository(self.db).revision(
            page_id, payload.page_revision_id, lock=True
        )
        if revision is None:
            raise HTTPException(status_code=404, detail="Revision does not belong to this page")
        if revision.VerificationStatus not in {"NEEDS_REVIEW", "VERIFIED"}:
            raise HTTPException(status_code=409, detail="AI workflow requires a reviewable OCR revision")
        revision_text = unicodedata.normalize(
            "NFC", revision.OriginalOcrText or revision.DraftText or revision.VerifiedText or ""
        )
        if not revision_text.strip():
            raise HTTPException(status_code=409, detail="Original OCR text is unavailable")
        page = await AdminOcrRepository(self.db).page(page_id, lock=True)
        if page is None or page.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Page is no longer active")
        if (
            revision.VerificationStatus == "VERIFIED"
            and page.CurrentVerifiedRevisionId != revision.Id
        ):
            raise HTTPException(status_code=409, detail="Verified OCR revision is no longer current")
        input_text = prepared.draft_text
        input_hash = self._hash(input_text)
        image_hash = self._image_hash(prepared.image_path, revision.ProcessingMeta)
        active_existing = await self.repo.active_for_revision(page_id, revision.Id)
        if (
            active_existing is not None
            and active_existing.AdminInputHash == input_hash
            and (
                getattr(active_existing, "ImageHash", None) in (None, image_hash)
                and active_existing.ImagePath == prepared.image_path
            )
        ):
            response = self._read(active_existing)
            await self.db.rollback()
            return response
        existing_snapshot = await self.repo.by_input_snapshot(
            page_id, revision.Id, input_hash, image_hash=image_hash
        )
        if existing_snapshot is not None and existing_snapshot.ImagePath == prepared.image_path:
            response = self._read(existing_snapshot)
            await self.db.rollback()
            return response
        words = [word.model_dump(mode="json") for word in payload.words]
        now = datetime.now(timezone.utc)
        row = AdminAiWorkflow(
            Id=uuid4(),
            PageId=page.Id,
            BookId=page.BookId,
            PageRevisionId=revision.Id,
            ActorId=actor_id,
            IdempotencyKey=payload.idempotency_key,
            OriginalText=revision_text,
            InputText=input_text,
            InputWords=words,
            ImagePath=prepared.image_path,
            ImageHash=image_hash,
            OriginalOcrHash=self._hash(revision_text),
            AdminInputHash=input_hash,
            Status="QUEUED",
            Stage="PROOFREADING",
            TotalChunks=prepared.total_chunks,
            CompletedChunks=0,
            SafetyStatus="PENDING",
            ImageSafetyStatus="NOT_REVIEWED",
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.db.add(row)
        try:
            await self.db.commit()
            await self.db.refresh(row)
        except IntegrityError:
            await self.db.rollback()
            existing = await self.repo.by_idempotency(actor_id, page_id, payload.idempotency_key)
            if existing is None:
                raise HTTPException(status_code=409, detail="Unable to create AI workflow")
            return self._read(existing)
        return self._read(row)

    async def get(
        self, actor_id: UUID, page_id: UUID, workflow_id: UUID
    ) -> AdminAiWorkflowRead:
        await AdminOcrService(self.db).require_admin(actor_id)
        row = await self.repo.get(workflow_id, page_id=page_id)
        if row is None:
            raise HTTPException(status_code=404, detail="AI workflow not found")
        return self._read(row)

    async def get_latest(
        self, actor_id: UUID, page_id: UUID, revision_id: UUID
    ) -> AdminAiWorkflowRead | None:
        await AdminOcrService(self.db).require_admin(actor_id)
        row = await self.repo.latest_for_revision(actor_id, page_id, revision_id)
        return self._read(row) if row is not None else None

    async def update_candidate(
        self, actor_id: UUID, page_id: UUID, workflow_id: UUID,
        payload: AdminAiCandidateUpdate,
    ) -> AdminAiWorkflowRead:
        await AdminOcrService(self.db).require_admin(actor_id)
        row = await self.repo.get(workflow_id, page_id=page_id, lock=True)
        if row is None:
            raise HTTPException(status_code=404, detail="AI workflow not found")
        if row.OcrApprovedAt is not None:
            raise HTTPException(status_code=409, detail="Candidate is locked after OCR final approval")
        if row.ProofreadText is None or row.Stage == "PROOFREADING":
            raise HTTPException(status_code=409, detail="Proofreading has not completed")
        if payload.expected_candidate_version != row.CandidateVersion:
            raise HTTPException(status_code=409, detail="Candidate changed; reload the workflow")
        candidate = normalize_safety_text(payload.candidate_text)
        candidate_hash = self._hash(candidate)
        if candidate_hash == row.CandidateHash:
            response = self._read(row)
            await self.db.rollback()
            return response
        now = datetime.now(timezone.utc)
        history = list(row.CandidateHistory or [])
        next_version = row.CandidateVersion + 1
        self._archive_safety_result(row, now)
        history.append({
            "version": next_version,
            "text": candidate,
            "content_hash": candidate_hash,
            "changed_at": now.isoformat(),
            "changed_by": str(actor_id),
        })
        row.CandidateHistory = history
        row.ReviewEvents = list(row.ReviewEvents or []) + [{
            "event": "CANDIDATE_UPDATED",
            "actor_id": str(actor_id),
            "candidate_version": next_version,
            "content_hash": candidate_hash,
            "created_at": now.isoformat(),
        }]
        row.CandidateVersion = next_version
        row.CandidateText = candidate
        row.CandidateHash = candidate_hash
        row.SafetyInputHash = None
        row.Suitability = None
        row.Findings = []
        row.SafetyStatus = "STALE"
        row.Status = "QUEUED"
        row.Stage = "CHILD_SAFETY_SCANNING"
        row.CompletedChunks = 0
        row.TotalChunks = 1
        row.Attempts = 0
        row.ErrorCode = None
        row.RetryAfter = None
        row.WorkerId = None
        row.LeaseExpiresAt = None
        row.SafetyConfirmedAt = None
        row.SafetyConfirmedBy = None
        row.UpdatedAt = now
        await self.db.commit()
        await self.db.refresh(row)
        return self._read(row)

    async def retry(
        self, actor_id: UUID, page_id: UUID, workflow_id: UUID
    ) -> AdminAiWorkflowRead:
        await AdminOcrService(self.db).require_admin(actor_id)
        row = await self.repo.get(workflow_id, page_id=page_id, lock=True)
        if row is None:
            raise HTTPException(status_code=404, detail="AI workflow not found")
        if (
            row.Status == "READY_FOR_ADMIN_REVIEW"
            and row.ProofreadText is not None
            and row.SafetyStatus in {"FAILED", "STALE"}
        ):
            self.prepare_safety_rescan(
                row,
                actor_id,
                datetime.now(timezone.utc),
                "Admin retried the Child Safety stage independently",
            )
            await self.db.commit()
            await self.db.refresh(row)
            return self._read(row)
        if row.Status != "FAILED":
            raise HTTPException(status_code=409, detail="Only a failed workflow stage can be retried")
        if row.Stage == "CHILD_SAFETY_SCANNING" and (not row.CandidateText or not row.CandidateHash):
            raise HTTPException(status_code=409, detail="Candidate text is unavailable")
        if row.Stage not in {"PROOFREADING", "CHILD_SAFETY_SCANNING"}:
            raise HTTPException(status_code=409, detail="Workflow stage cannot be retried")
        self.prepare_retry(row, actor_id, datetime.now(timezone.utc))
        await self.db.commit()
        await self.db.refresh(row)
        return self._read(row)

    @staticmethod
    def prepare_retry(
        row: AdminAiWorkflow, actor_id: UUID, now: datetime
    ) -> None:
        """Queue a failed workflow row inside a caller-owned transaction."""
        if row.Status != "FAILED":
            raise HTTPException(status_code=409, detail="Only a failed workflow stage can be retried")
        if row.Stage == "CHILD_SAFETY_SCANNING" and (not row.CandidateText or not row.CandidateHash):
            raise HTTPException(status_code=409, detail="Candidate text is unavailable")
        if row.Stage not in {"PROOFREADING", "CHILD_SAFETY_SCANNING"}:
            raise HTTPException(status_code=409, detail="Workflow stage cannot be retried")
        retry_stage = row.Stage
        row.Status = "QUEUED"
        if retry_stage == "CHILD_SAFETY_SCANNING":
            AdminAiWorkflowService._archive_safety_result(row, now)
            row.SafetyStatus = "STALE"
            row.SafetyInputHash = None
            row.Suitability = None
            row.Findings = []
        else:
            # Keep a valid scan of the immutable OCR input. The worker reuses it
            # if proofreading retries to the same text hash, and only rescans
            # when the corrected candidate differs.
            row.CandidateText = None
            row.CandidateHash = None
            row.CandidateVersion = 0
            row.CandidateHistory = []
            row.ProofreadText = None
            row.ProofreadOutputHash = None
            row.CorrectionSuggestions = []
            if not row.SafetyInputHash:
                row.SafetyStatus = "PENDING"
        row.Stage = retry_stage
        row.Attempts = 0
        row.ErrorCode = None
        row.RetryAfter = None
        row.WorkerId = None
        row.LeaseExpiresAt = None
        row.CompletedChunks = 0
        if retry_stage == "CHILD_SAFETY_SCANNING":
            row.TotalChunks = 1
        row.ReviewEvents = list(row.ReviewEvents or []) + [{
            "event": "WORKFLOW_STAGE_RETRY_QUEUED",
            "actor_id": str(actor_id),
            "stage": retry_stage,
            "created_at": now.isoformat(),
        }]
        row.UpdatedAt = now

    @staticmethod
    def prepare_safety_rescan(
        row: AdminAiWorkflow, actor_id: UUID, now: datetime, reason: str
    ) -> None:
        """Queue only Child Safety for a current, otherwise valid candidate."""
        if not row.CandidateText or not row.CandidateHash:
            raise HTTPException(status_code=409, detail="Candidate text is unavailable")
        if row.Status in {"QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"}:
            raise HTTPException(status_code=409, detail="Workflow is already processing")
        AdminAiWorkflowService._archive_safety_result(row, now)
        row.Status = "QUEUED"
        row.Stage = "CHILD_SAFETY_SCANNING"
        row.SafetyStatus = "STALE"
        row.SafetyInputHash = None
        row.Suitability = None
        row.Findings = []
        row.SafetyConfirmedAt = None
        row.SafetyConfirmedBy = None
        row.Attempts = 0
        row.ErrorCode = None
        row.RetryAfter = None
        row.WorkerId = None
        row.LeaseExpiresAt = None
        row.CompletedChunks = 0
        row.TotalChunks = 1
        row.ReviewEvents = list(row.ReviewEvents or []) + [{
            "event": "BOOK_LEVEL_SAFETY_RESCAN_QUEUED",
            "actor_id": str(actor_id),
            "reason": reason,
            "created_at": now.isoformat(),
        }]
        row.UpdatedAt = now

    async def decide_safety(
        self, actor_id: UUID, page_id: UUID, workflow_id: UUID,
        payload: AdminAiSafetyDecision,
    ) -> AdminAiWorkflowRead:
        await AdminOcrService(self.db).require_admin(actor_id)
        row = await self.repo.get(workflow_id, page_id=page_id, lock=True)
        if row is None:
            raise HTTPException(status_code=404, detail="AI workflow not found")
        if payload.expected_candidate_hash != row.CandidateHash:
            raise HTTPException(status_code=409, detail="Candidate changed; reload the safety review")
        if row.SafetyStatus not in {"PROVISIONAL", "CONFIRMED"} or row.SafetyInputHash != row.CandidateHash:
            raise HTTPException(status_code=409, detail="Safety scan is stale or incomplete")
        self.validate_safety_decision_reason(row, payload)
        if payload.confirmed:
            row.SafetyStatus = "CONFIRMED"
            row.SafetyConfirmedAt = datetime.now(timezone.utc)
            row.SafetyConfirmedBy = actor_id
            event_name = "SAFETY_CONFIRMED"
        else:
            row.SafetyStatus = "PROVISIONAL"
            row.SafetyConfirmedAt = None
            row.SafetyConfirmedBy = None
            event_name = "SAFETY_CONFIRMATION_REVOKED"
        now = datetime.now(timezone.utc)
        row.ReviewEvents = list(row.ReviewEvents or []) + [{
            "event": event_name,
            "actor_id": str(actor_id),
            "candidate_hash": row.CandidateHash,
            "reason": payload.reason,
            "created_at": now.isoformat(),
        }]
        row.UpdatedAt = now
        await self.db.commit()
        await self.db.refresh(row)
        return self._read(row)

    async def resolve_uncertain_words(
        self,
        actor_id: UUID,
        page_id: UUID,
        workflow_id: UUID,
        payload: AdminAiUncertainResolutionRequest,
    ) -> AdminAiWorkflowRead:
        await AdminOcrService(self.db).require_admin(actor_id)
        row = await self.repo.get(workflow_id, page_id=page_id, lock=True)
        if row is None:
            raise HTTPException(status_code=404, detail="AI workflow not found")
        if payload.expected_candidate_hash != row.CandidateHash:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CANDIDATE_HASH_MISMATCH",
                    "message": "Nội dung đã thay đổi; hãy tải lại trước khi xác nhận từ chưa chắc chắn.",
                },
            )
        now = datetime.now(timezone.utc)
        proofread_meta = dict(row.ProofreadMetadata or {})
        proofread_meta["uncertain_resolution"] = {
            "candidate_hash": row.CandidateHash,
            "resolved_indices": [int(idx) for idx in (row.UncertainWordIndices or [])],
            "reviewed_by": str(actor_id),
            "reviewed_at": now.isoformat(),
            "note": payload.note,
        }
        row.ProofreadMetadata = proofread_meta
        row.ReviewEvents = list(row.ReviewEvents or []) + [{
            "event": "UNCERTAIN_WORDS_RESOLVED",
            "actor_id": str(actor_id),
            "candidate_hash": row.CandidateHash,
            "uncertain_count": len(row.UncertainWordIndices or []),
            "note": payload.note,
            "created_at": now.isoformat(),
        }]
        row.UpdatedAt = now
        await self.db.commit()
        await self.db.refresh(row)
        return self._read(row)

    async def review_image_safety(
        self,
        actor_id: UUID,
        page_id: UUID,
        workflow_id: UUID,
        payload: AdminAiImageSafetyReviewRequest,
    ) -> AdminAiWorkflowRead:
        await AdminOcrService(self.db).require_admin(actor_id)
        row = await self.repo.get(workflow_id, page_id=page_id, lock=True)
        if row is None:
            raise HTTPException(status_code=404, detail="AI workflow not found")
        now = datetime.now(timezone.utc)
        if payload.page_content_type is not None:
            page = await AdminOcrRepository(self.db).page(page_id, lock=True)
            if page is not None:
                page.ContentType = payload.page_content_type
        row.ImageSafetyStatus = payload.status
        row.ImageSafetyReviewedBy = actor_id
        row.ImageSafetyReviewedAt = now
        row.ImageSafetyReviewNote = payload.note
        row.ReviewEvents = list(row.ReviewEvents or []) + [{
            "event": "IMAGE_SAFETY_REVIEWED",
            "actor_id": str(actor_id),
            "status": payload.status,
            "image_hash": getattr(row, "ImageHash", None),
            "note": payload.note,
            "created_at": now.isoformat(),
        }]
        row.UpdatedAt = now
        await self.db.commit()
        await self.db.refresh(row)
        return self._read(row)
