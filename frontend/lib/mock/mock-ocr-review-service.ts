import type { OcrReviewService } from "@/lib/api/ocr-review-service";
import {
  adminServiceError,
  assertAdminScenarioAllowed,
} from "@/lib/mock/mock-admin-errors";
import {
  cloneRevision,
  type MockAdminStore,
  waitForAdminMock,
  waitForever,
} from "@/lib/mock/mock-admin-store";
import { areAdminRevisionWordsValid } from "@/lib/utils/admin-revision";
import type {
  AdminMockScenario,
  AdminPageRevisionDetailDTO,
  AdminRevisionWordDTO,
} from "@/types/admin";

function getRevision(
  store: MockAdminStore,
  pageId: string,
  revisionId: string,
) {
  const revision = store.revisions.get(revisionId);
  if (!revision || revision.page_id !== pageId) {
    throw adminServiceError("RESOURCE_NOT_FOUND", 404);
  }
  return revision;
}

function cloneWithCurrentLifecycle(
  store: MockAdminStore,
  pageId: string,
  revision: AdminPageRevisionDetailDTO,
): AdminPageRevisionDetailDTO {
  const page = store.pages.get(pageId);
  if (!page) throw adminServiceError("RESOURCE_NOT_FOUND", 404);
  return {
    ...cloneRevision(revision),
    lifecycle_status: page.lifecycle_status,
  };
}

export function createMockOcrReviewService(
  store: MockAdminStore,
  scenario: AdminMockScenario,
): OcrReviewService {
  return {
    async getRevision(pageId, revisionId) {
      if (scenario === "loading") return waitForever();
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      return cloneWithCurrentLifecycle(
        store,
        pageId,
        getRevision(store, pageId, revisionId),
      );
    },
    async saveDraft(pageId, revisionId, draftText, words) {
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      const revision = getRevision(store, pageId, revisionId);
      if (revision.verification_status === "VERIFIED") {
        throw adminServiceError("OCR_REPROCESS_INVALID_STATE", 409);
      }
      if (!draftText.trim()) throw adminServiceError("VALIDATION_ERROR", 422);
      if (!areAdminRevisionWordsValid(words)) {
        throw adminServiceError("VALIDATION_ERROR", 422);
      }
      const updated = {
        ...revision,
        draft_text: draftText.trim(),
        words: words.map((word) => ({
          ...word,
          bbox: [...word.bbox] as AdminRevisionWordDTO["bbox"],
        })),
      };
      store.revisions.set(revisionId, updated);
      return cloneWithCurrentLifecycle(store, pageId, updated);
    },
  };
}
