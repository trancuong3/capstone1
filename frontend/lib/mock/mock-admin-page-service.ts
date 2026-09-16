import type { AdminPageService } from "@/lib/api/admin-page-service";
import {
  adminServiceError,
  assertAdminScenarioAllowed,
} from "@/lib/mock/mock-admin-errors";
import {
  type MockAdminStore,
  toAdminPageListItem,
  waitForAdminMock,
  waitForever,
} from "@/lib/mock/mock-admin-store";
import { validateUploadInput } from "@/lib/utils/admin-upload";
import type {
  AdminMockScenario,
  AdminPageRevisionDetailDTO,
} from "@/types/admin";

function findPage(store: MockAdminStore, pageId: string) {
  const page = store.pages.get(pageId);
  if (!page) throw adminServiceError("RESOURCE_NOT_FOUND", 404);
  return page;
}

export function createMockAdminPageService(
  store: MockAdminStore,
  scenario: AdminMockScenario,
): AdminPageService {
  return {
    async list(bookId) {
      if (scenario === "loading") return waitForever();
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      if (!store.books.has(bookId)) {
        throw adminServiceError("RESOURCE_NOT_FOUND", 404);
      }
      return [...store.pages.entries()]
        .filter(([, page]) => page.book_id === bookId)
        .map(([id]) => toAdminPageListItem(store, id))
        .sort((left, right) => left.page_number - right.page_number);
    },
    async getImage(pageId) {
      if (scenario === "loading") return waitForever();
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      const page = findPage(store, pageId);
      return {
        page_id: pageId,
        page_number: page.page_number,
        preview_url: page.image_url,
        width: page.width,
        height: page.height,
      };
    },
    async upload(bookId, inputs, onProgress) {
      assertAdminScenarioAllowed(scenario);
      if (!store.books.has(bookId)) {
        throw adminServiceError("RESOURCE_NOT_FOUND", 404);
      }
      if (inputs.length === 0 || scenario === "invalid-upload") {
        throw adminServiceError("INVALID_UPLOAD", 422);
      }
      const usedNumbers = new Set(
        [...store.pages.values()]
          .filter((page) => page.book_id === bookId)
          .map((page) => page.page_number),
      );
      for (const input of inputs) {
        if (validateUploadInput(input) || usedNumbers.has(input.page_number)) {
          throw adminServiceError("INVALID_UPLOAD", 422);
        }
        usedNumbers.add(input.page_number);
      }
      for (const input of inputs) {
        onProgress?.({
          client_id: input.client_id,
          progress_percent: 15,
          status: "UPLOADING",
        });
      }
      await waitForAdminMock(240);
      if (scenario === "upload-failure") {
        for (const input of inputs) {
          onProgress?.({
            client_id: input.client_id,
            progress_percent: 45,
            status: "FAILED",
          });
        }
        throw new Error("Mock upload failed");
      }

      const created = inputs.map((input) => {
        const sequence = String(store.nextPageSequence++).padStart(12, "0");
        const pageId = `83000000-0000-4000-8000-${sequence}`;
        const revisionId = `84000000-0000-4000-8000-${sequence}`;
        store.pages.set(pageId, {
          book_id: bookId,
          page_number: input.page_number,
          image_url: "/images/figma/book-cat.svg",
          width: input.width,
          height: input.height,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: null,
          latest_revision_id: revisionId,
        });
        const detail: AdminPageRevisionDetailDTO = {
          page_id: pageId,
          page_revision_id: revisionId,
          revision_no: 1,
          verification_status: "PROCESSING",
          lifecycle_status: "ACTIVE",
          draft_text: null,
          words: [],
          ocr_metadata: { file_name: input.file_name },
          created_at: new Date().toISOString(),
          verified_at: null,
          verified_by: null,
        };
        store.revisions.set(revisionId, detail);
        onProgress?.({
          client_id: input.client_id,
          progress_percent: 100,
          status: "PROCESSING",
        });
        return toAdminPageListItem(store, pageId);
      });
      return created;
    },
    async reload(pageId) {
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      const page = findPage(store, pageId);
      const revision = store.revisions.get(page.latest_revision_id);
      if (!revision) throw adminServiceError("RESOURCE_NOT_FOUND", 404);
      if (revision.verification_status === "PROCESSING") {
        store.revisions.set(revision.page_revision_id, {
          ...revision,
          verification_status: "NEEDS_REVIEW",
          draft_text: "Nội dung OCR đang chờ quản trị viên kiểm tra",
          words: [],
          ocr_metadata: { ...revision.ocr_metadata, processing_complete: true },
        });
      }
      return toAdminPageListItem(store, pageId).processing;
    },
    async updateStatus(pageId, request) {
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      const page = findPage(store, pageId);
      page.lifecycle_status = request.status;
      return toAdminPageListItem(store, pageId).processing;
    },
  };
}
