import { describe, expect, it } from "vitest";
import { ServiceError } from "@/lib/api/service-error";
import { createMockAdminBookService } from "@/lib/mock/mock-admin-book-service";
import { createMockAdminPageService } from "@/lib/mock/mock-admin-page-service";
import { createMockAuditService } from "@/lib/mock/mock-audit-service";
import { createMockOcrReviewService } from "@/lib/mock/mock-ocr-review-service";
import { createMockRevisionService } from "@/lib/mock/mock-revision-service";
import {
  cloneRevision,
  createMockAdminStore,
  MOCK_ADMIN_BOOK_ID,
  MOCK_ADMIN_PAGE_ID,
  MOCK_ADMIN_R1_ID,
} from "@/lib/mock/mock-admin-store";
import type { AdminPageUploadInputUI } from "@/types/admin";

const validUpload: AdminPageUploadInputUI = {
  client_id: "one",
  file_name: "page.png",
  mime_type: "image/png",
  size_bytes: 120,
  page_number: 6,
  width: 1200,
  height: 1600,
};

describe("mock admin services", () => {
  it("keeps R1 immutable when reprocessing and advances the pointer only after verification", async () => {
    const store = createMockAdminStore();
    const revisions = createMockRevisionService(store, "default");
    const original = store.revisions.get(MOCK_ADMIN_R1_ID);
    if (!original) throw new Error("Missing R1 fixture");
    const originalSnapshot = cloneRevision(original);

    const r2 = await revisions.reprocess(MOCK_ADMIN_PAGE_ID);

    expect(r2.revision_no).toBe(2);
    expect(r2.verification_status).toBe("NEEDS_REVIEW");
    expect(store.revisions.get(MOCK_ADMIN_R1_ID)).toEqual(originalSnapshot);
    expect(
      store.pages.get(MOCK_ADMIN_PAGE_ID)?.current_verified_revision_id,
    ).toBe(MOCK_ADMIN_R1_ID);

    const verified = await revisions.verify(MOCK_ADMIN_PAGE_ID, {
      page_revision_id: r2.page_revision_id,
      corrected_text: r2.draft_text ?? "Nội dung",
      words: r2.words,
    });
    expect(verified.verification_status).toBe("VERIFIED");
    expect(
      store.pages.get(MOCK_ADMIN_PAGE_ID)?.current_verified_revision_id,
    ).toBe(r2.page_revision_id);
    expect(store.revisions.get(MOCK_ADMIN_R1_ID)).toEqual(originalSnapshot);
    expect(store.revisions.get(MOCK_ADMIN_R1_ID)?.verification_status).toBe(
      "VERIFIED",
    );
  });

  it("keeps a book eligible while a newer review revision exists", async () => {
    const store = createMockAdminStore();
    const revisions = createMockRevisionService(store, "default");
    const books = createMockAdminBookService(store, "default");

    await revisions.reprocess(MOCK_ADMIN_PAGE_ID);
    const listed = await books.list();
    expect(
      listed.find((item) => item.book.id === MOCK_ADMIN_BOOK_ID)
        ?.parent_catalog_eligible,
    ).toBe(true);

    await books.updateStatus(MOCK_ADMIN_BOOK_ID, { status: "RETIRED" });
    await expect(
      books.updateStatus(MOCK_ADMIN_BOOK_ID, { status: "ACTIVE" }),
    ).resolves.toMatchObject({ lifecycle_status: "ACTIVE" });
  });

  it("uses the canonical reprocess error for an invalid state", async () => {
    const store = createMockAdminStore();
    const revisions = createMockRevisionService(store, "default");
    await expect(
      revisions.reprocess("83000000-0000-4000-8000-000000000002"),
    ).rejects.toMatchObject({
      code: "OCR_REPROCESS_INVALID_STATE",
      status: 409,
    });
  });

  it("moves a processing revision to review when Admin reloads", async () => {
    const store = createMockAdminStore();
    const pages = createMockAdminPageService(store, "default");
    const status = await pages.reload("83000000-0000-4000-8000-000000000002");
    expect(status.verification_status).toBe("NEEDS_REVIEW");
  });

  it("does not allow a verified revision to be edited", async () => {
    const store = createMockAdminStore();
    const ocr = createMockOcrReviewService(store, "default");
    await expect(
      ocr.saveDraft(MOCK_ADMIN_PAGE_ID, MOCK_ADMIN_R1_ID, "Nội dung sửa", []),
    ).rejects.toMatchObject({ code: "OCR_REPROCESS_INVALID_STATE" });
  });

  it("rejects an invalid upload with INVALID_UPLOAD", async () => {
    const store = createMockAdminStore();
    const pages = createMockAdminPageService(store, "invalid-upload");
    await expect(
      pages.upload(MOCK_ADMIN_BOOK_ID, [validUpload]),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it.each([
    {
      name: "oversized file",
      input: { ...validUpload, size_bytes: 12 * 1024 * 1024 + 1 },
    },
    { name: "invalid page", input: { ...validUpload, page_number: 0 } },
    { name: "invalid dimensions", input: { ...validUpload, width: 0 } },
    {
      name: "invalid MIME",
      input: {
        ...validUpload,
        mime_type: "image/gif",
      } as unknown as AdminPageUploadInputUI,
    },
  ])("rejects $name at the service boundary", async ({ input }) => {
    const pages = createMockAdminPageService(createMockAdminStore(), "default");
    await expect(
      pages.upload(MOCK_ADMIN_BOOK_ID, [input]),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD", status: 422 });
  });

  it("rejects malformed revision words during verification", async () => {
    const store = createMockAdminStore();
    const revisions = createMockRevisionService(store, "default");
    const r2 = await revisions.reprocess(MOCK_ADMIN_PAGE_ID);
    const malformed = r2.words.map((word, index) => ({
      ...word,
      word_index: index + 1,
    }));

    await expect(
      revisions.verify(MOCK_ADMIN_PAGE_ID, {
        page_revision_id: r2.page_revision_id,
        corrected_text: r2.draft_text ?? "Nội dung",
        words: malformed,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
  });

  it("overlays the current page lifecycle without mutating R1", async () => {
    const store = createMockAdminStore();
    const pages = createMockAdminPageService(store, "default");
    const ocr = createMockOcrReviewService(store, "default");
    const original = store.revisions.get(MOCK_ADMIN_R1_ID);
    if (!original) throw new Error("Missing R1 fixture");
    const originalSnapshot = cloneRevision(original);

    await pages.updateStatus(MOCK_ADMIN_PAGE_ID, { status: "RETIRED" });
    await expect(
      ocr.getRevision(MOCK_ADMIN_PAGE_ID, MOCK_ADMIN_R1_ID),
    ).resolves.toMatchObject({ lifecycle_status: "RETIRED" });
    expect(store.revisions.get(MOCK_ADMIN_R1_ID)).toEqual(originalSnapshot);
  });

  it("filters books by exact lifecycle and never deletes retired content", async () => {
    const store = createMockAdminStore();
    const books = createMockAdminBookService(store, "default");
    const retired = await books.list({ lifecycle_status: "RETIRED" });
    expect(retired).toHaveLength(1);
    expect(retired[0].book.lifecycle_status).toBe("RETIRED");
    expect(store.books.size).toBe(3);
  });

  it("keeps audit metadata bounded and free of secrets", async () => {
    const store = createMockAdminStore();
    const audit = createMockAuditService(store, "default");
    const page = await audit.list({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(JSON.stringify(page.items)).not.toMatch(
      /password|credential|token/i,
    );
  });
});
