import type {
  AdminBookListItemUI,
  AdminPageListItemUI,
  AdminPageRevisionDetailDTO,
} from "@/types/admin";
import type { PageRevisionVerificationStatus } from "@/types/reading";

export const verificationLabels: Record<
  PageRevisionVerificationStatus,
  string
> = {
  PROCESSING: "Đang xử lý",
  NEEDS_REVIEW: "Cần kiểm tra",
  VERIFIED: "Đã xác minh",
};

export function isAdminPageParentCatalogEligible(
  page: AdminPageListItemUI,
  revisions: readonly AdminPageRevisionDetailDTO[],
): boolean {
  const pointer = page.processing.current_verified_revision_id;
  if (page.processing.lifecycle_status !== "ACTIVE" || pointer === null) {
    return false;
  }

  return revisions.some(
    (revision) =>
      revision.page_id === page.processing.page_id &&
      revision.page_revision_id === pointer &&
      revision.verification_status === "VERIFIED",
  );
}

export function summarizeAdminBook(
  book: AdminBookListItemUI["book"],
  pages: readonly AdminPageListItemUI[],
  revisions: readonly AdminPageRevisionDetailDTO[],
): AdminBookListItemUI {
  const relevant = pages.filter((page) => page.book_id === book.id);
  const count = (status: PageRevisionVerificationStatus) =>
    relevant.filter((page) => page.processing.verification_status === status)
      .length;
  const verifiedCount = count("VERIFIED");

  return {
    book,
    page_count: relevant.length,
    processing_count: count("PROCESSING"),
    needs_review_count: count("NEEDS_REVIEW"),
    verified_count: verifiedCount,
    parent_catalog_eligible:
      book.lifecycle_status === "ACTIVE" &&
      relevant.some((page) =>
        isAdminPageParentCatalogEligible(page, revisions),
      ),
  };
}
