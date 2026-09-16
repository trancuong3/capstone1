import type { RevisionService } from "@/lib/api/revision-service";
import {
  adminServiceError,
  assertAdminScenarioAllowed,
} from "@/lib/mock/mock-admin-errors";
import {
  cloneRevision,
  type MockAdminStore,
  toAdminPageListItem,
  waitForAdminMock,
  waitForever,
} from "@/lib/mock/mock-admin-store";
import { areAdminRevisionWordsValid } from "@/lib/utils/admin-revision";
import type {
  AdminMockScenario,
  AdminPageRevisionDetailDTO,
} from "@/types/admin";

function pageOrThrow(store: MockAdminStore, pageId: string) {
  const page = store.pages.get(pageId);
  if (!page) throw adminServiceError("RESOURCE_NOT_FOUND", 404);
  return page;
}

export function createMockRevisionService(
  store: MockAdminStore,
  scenario: AdminMockScenario,
): RevisionService {
  return {
    async list(pageId) {
      if (scenario === "loading") return waitForever();
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      const page = pageOrThrow(store, pageId);
      return [...store.revisions.values()]
        .filter((revision) => revision.page_id === pageId)
        .sort((left, right) => right.revision_no - left.revision_no)
        .map((revision) => ({
          page_revision_id: revision.page_revision_id,
          revision_no: revision.revision_no,
          verification_status: revision.verification_status,
          created_at: revision.created_at,
          is_current_verified:
            page.current_verified_revision_id === revision.page_revision_id,
        }));
    },
    async verify(pageId, request) {
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      const page = pageOrThrow(store, pageId);
      const revision = store.revisions.get(request.page_revision_id);
      if (!revision || revision.page_id !== pageId) {
        throw adminServiceError("RESOURCE_NOT_FOUND", 404);
      }
      if (revision.verification_status !== "NEEDS_REVIEW") {
        throw adminServiceError("OCR_REPROCESS_INVALID_STATE", 409);
      }
      if (
        !request.corrected_text.trim() ||
        !areAdminRevisionWordsValid(request.words)
      ) {
        throw adminServiceError("VALIDATION_ERROR", 422);
      }
      const verified: AdminPageRevisionDetailDTO = {
        ...revision,
        lifecycle_status: page.lifecycle_status,
        draft_text: request.corrected_text.trim(),
        words: request.words.map((word) => ({ ...word, bbox: [...word.bbox] })),
        verification_status: "VERIFIED",
        verified_at: new Date().toISOString(),
        verified_by: "88000000-0000-4000-8000-000000000001",
      };
      store.revisions.set(request.page_revision_id, verified);
      page.current_verified_revision_id = request.page_revision_id;
      page.latest_revision_id = request.page_revision_id;
      store.audits.unshift({
        id: `89000000-0000-4000-8000-${String(store.audits.length + 20).padStart(12, "0")}`,
        actor_id: verified.verified_by,
        action: "PAGE_REVISION_VERIFIED",
        resource_type: "page_revision",
        resource_id: verified.page_revision_id,
        request_id: `mock-request-${store.audits.length + 20}`,
        created_at: verified.verified_at ?? new Date().toISOString(),
        metadata: { revision_no: verified.revision_no },
      });
      return cloneRevision(verified);
    },
    async reprocess(pageId, onStatus) {
      assertAdminScenarioAllowed(scenario);
      const page = pageOrThrow(store, pageId);
      const latest = store.revisions.get(page.latest_revision_id);
      if (
        !latest ||
        latest.verification_status !== "VERIFIED" ||
        scenario === "ocr-reprocess-invalid-state"
      ) {
        throw adminServiceError("OCR_REPROCESS_INVALID_STATE", 409);
      }
      const revisionNo = latest.revision_no + 1;
      const suffix = String(store.nextPageSequence++).padStart(12, "0");
      const revisionId = `84000000-0000-4000-8000-${suffix}`;
      const processing: AdminPageRevisionDetailDTO = {
        ...cloneRevision(latest),
        page_revision_id: revisionId,
        revision_no: revisionNo,
        verification_status: "PROCESSING",
        lifecycle_status: page.lifecycle_status,
        draft_text: null,
        words: [],
        ocr_metadata: { source_revision_id: latest.page_revision_id },
        created_at: new Date().toISOString(),
        verified_at: null,
        verified_by: null,
      };
      store.revisions.set(revisionId, processing);
      page.latest_revision_id = revisionId;
      onStatus?.(toAdminPageListItem(store, pageId).processing);
      await waitForAdminMock(500);
      const review: AdminPageRevisionDetailDTO = {
        ...processing,
        verification_status: "NEEDS_REVIEW",
        draft_text: latest.draft_text,
        words: latest.words.map((word) => ({ ...word, bbox: [...word.bbox] })),
        ocr_metadata: { ...processing.ocr_metadata, processing_complete: true },
      };
      store.revisions.set(revisionId, review);
      onStatus?.(toAdminPageListItem(store, pageId).processing);
      return cloneRevision(review);
    },
  };
}
