import { describe, expect, it } from "vitest";

import { isServiceError } from "@/lib/api/service-error";
import { createMockBookService } from "@/lib/mock/mock-book-service";

const catBookId = "20000000-0000-4000-8000-000000000001";
const retiredBookId = "20000000-0000-4000-8000-000000000005";

describe("MockBookService", () => {
  it("returns only ACTIVE books with VERIFIED active pages", async () => {
    const service = createMockBookService("default");
    const books = await service.list();

    expect(books).toHaveLength(4);
    expect(books.every((book) => book.lifecycle_status === "ACTIVE")).toBe(
      true,
    );
    expect(books.map((book) => book.title)).not.toContain(
      "Sách đã ngừng phát hành",
    );
    expect(books.map((book) => book.title)).not.toContain(
      "Bản thảo đang duyệt",
    );
  });

  it("searches title and author and filters by grade deterministically", async () => {
    const service = createMockBookService("default");

    await expect(service.list({ search: "dân gian" })).resolves.toMatchObject([
      { title: "Cây Khế" },
    ]);
    await expect(service.list({ grade: 2 })).resolves.toHaveLength(4);
    await expect(
      service.list({ author: "Nhóm ReadAlong", grade: 2 }),
    ).resolves.toHaveLength(3);
  });

  it("returns only preview-safe active pages with verified revisions", async () => {
    const service = createMockBookService("default");
    const pages = await service.listPages(catBookId);

    expect(pages.map((page) => page.page_number)).toEqual([4, 5, 6]);
    expect(
      pages.every(
        (page) =>
          page.lifecycle_status === "ACTIVE" &&
          page.current_verified_revision_id.length > 0,
      ),
    ).toBe(true);
  });

  it("uses canonical errors for unknown and inactive books", async () => {
    const service = createMockBookService("default");

    await expect(
      service.get("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isServiceError(error) &&
        error.code === "RESOURCE_NOT_FOUND" &&
        error.status === 404,
    );
    await expect(service.get(retiredBookId)).rejects.toSatisfy(
      (error: unknown) =>
        isServiceError(error) &&
        error.code === "CONTENT_INACTIVE" &&
        error.status === 409,
    );
  });
});
