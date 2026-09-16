import type { AdminBookService } from "@/lib/api/admin-book-service";
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
import {
  isAdminPageParentCatalogEligible,
  summarizeAdminBook,
} from "@/lib/utils/admin-mappers";
import type { AdminBookCreateDTO, AdminMockScenario } from "@/types/admin";
import type { BookListItemDTO } from "@/types/book";

function normalize(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("vi");
}

function validate(request: AdminBookCreateDTO): void {
  if (
    !request.title.trim() ||
    request.min_grade < 1 ||
    request.max_grade > 5 ||
    request.min_grade > request.max_grade
  ) {
    throw adminServiceError("VALIDATION_ERROR", 422);
  }
}

function getBook(store: MockAdminStore, bookId: string): BookListItemDTO {
  const book = store.books.get(bookId);
  if (!book) throw adminServiceError("RESOURCE_NOT_FOUND", 404);
  return book;
}

function writeAudit(
  store: MockAdminStore,
  action: string,
  bookId: string,
  metadata: Record<string, unknown>,
): void {
  store.audits.unshift({
    id: `89000000-0000-4000-8000-${String(store.audits.length + 10).padStart(12, "0")}`,
    actor_id: "88000000-0000-4000-8000-000000000001",
    action,
    resource_type: "book",
    resource_id: bookId,
    request_id: `mock-request-${store.audits.length + 10}`,
    created_at: new Date().toISOString(),
    metadata,
  });
}

export function createMockAdminBookService(
  store: MockAdminStore,
  scenario: AdminMockScenario,
): AdminBookService {
  return {
    async list(query = {}) {
      if (scenario === "loading") return waitForever();
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      if (scenario === "empty" || scenario === "no-result") return [];
      const pages = [...store.pages.keys()].map((id) =>
        toAdminPageListItem(store, id),
      );
      const revisions = [...store.revisions.values()];
      return [...store.books.values()]
        .map((book) => summarizeAdminBook({ ...book }, pages, revisions))
        .filter((item) => {
          if (
            query.search &&
            !normalize(`${item.book.title} ${item.book.author ?? ""}`).includes(
              normalize(query.search),
            )
          ) {
            return false;
          }
          if (
            query.lifecycle_status &&
            item.book.lifecycle_status !== query.lifecycle_status
          ) {
            return false;
          }
          if (query.verification_status) {
            const count =
              query.verification_status === "PROCESSING"
                ? item.processing_count
                : query.verification_status === "NEEDS_REVIEW"
                  ? item.needs_review_count
                  : item.verified_count;
            if (count === 0) return false;
          }
          return true;
        });
    },
    async get(bookId) {
      if (scenario === "loading") return waitForever();
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      return { ...getBook(store, bookId) };
    },
    async create(request) {
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      validate(request);
      const id = `82000000-0000-4000-8000-${String(store.nextBookSequence++).padStart(12, "0")}`;
      const book: BookListItemDTO = {
        id,
        title: request.title.trim(),
        author: request.author?.trim() || null,
        min_grade: request.min_grade,
        max_grade: request.max_grade,
        lifecycle_status: "ACTIVE",
      };
      store.books.set(id, book);
      writeAudit(store, "BOOK_CREATED", id, {});
      return { ...book };
    },
    async update(bookId, request) {
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      validate(request);
      const current = getBook(store, bookId);
      const updated: BookListItemDTO = {
        ...current,
        title: request.title.trim(),
        author: request.author?.trim() || null,
        min_grade: request.min_grade,
        max_grade: request.max_grade,
      };
      store.books.set(bookId, updated);
      writeAudit(store, "BOOK_METADATA_UPDATED", bookId, {});
      return { ...updated };
    },
    async updateStatus(bookId, request) {
      await waitForAdminMock();
      assertAdminScenarioAllowed(scenario);
      const current = getBook(store, bookId);
      const pages = [...store.pages.entries()]
        .filter(([, page]) => page.book_id === bookId)
        .map(([id]) => toAdminPageListItem(store, id));
      const revisions = [...store.revisions.values()];
      const eligible = pages.some((page) =>
        isAdminPageParentCatalogEligible(page, revisions),
      );
      if (
        request.status === "ACTIVE" &&
        (!eligible || scenario === "invalid-lifecycle")
      ) {
        throw adminServiceError("CONTENT_INACTIVE", 409);
      }
      const updated = { ...current, lifecycle_status: request.status };
      store.books.set(bookId, updated);
      writeAudit(store, "BOOK_STATUS_UPDATED", bookId, {
        status: request.status,
      });
      return { ...updated };
    },
  };
}
