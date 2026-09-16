import type {
  AdminPageListItemUI,
  AdminPageRevisionDetailDTO,
  AdminRevisionWordDTO,
  AuditLogDTO,
} from "@/types/admin";
import type { BookListItemDTO } from "@/types/book";

export const MOCK_ADMIN_ID = "88000000-0000-4000-8000-000000000001";
export const MOCK_ADMIN_BOOK_ID = "82000000-0000-4000-8000-000000000001";
export const MOCK_RETIRED_BOOK_ID = "82000000-0000-4000-8000-000000000002";
export const MOCK_REVIEW_BOOK_ID = "82000000-0000-4000-8000-000000000003";
export const MOCK_ADMIN_PAGE_ID = "83000000-0000-4000-8000-000000000001";
export const MOCK_ADMIN_R1_ID = "84000000-0000-4000-8000-000000000001";

export interface MockAdminPageRecord {
  readonly book_id: string;
  readonly page_number: number;
  readonly image_url: string;
  readonly width: number;
  readonly height: number;
  lifecycle_status: "ACTIVE" | "RETIRED";
  current_verified_revision_id: string | null;
  latest_revision_id: string;
}

export interface MockAdminStore {
  readonly books: Map<string, BookListItemDTO>;
  readonly pages: Map<string, MockAdminPageRecord>;
  readonly revisions: Map<string, AdminPageRevisionDetailDTO>;
  readonly audits: AuditLogDTO[];
  nextBookSequence: number;
  nextPageSequence: number;
}

const baseWords: readonly AdminRevisionWordDTO[] = [
  {
    word_index: 0,
    line_index: 0,
    text: "Chú",
    normalized_text: "chú",
    bbox: [0.1, 0.2, 0.12, 0.06],
    ocr_confidence: 0.96,
  },
  {
    word_index: 1,
    line_index: 0,
    text: "mèo",
    normalized_text: "mèo",
    bbox: [0.24, 0.2, 0.13, 0.06],
    ocr_confidence: 0.94,
  },
  {
    word_index: 2,
    line_index: 0,
    text: "nhỏ",
    normalized_text: "nhỏ",
    bbox: [0.39, 0.2, 0.12, 0.06],
    ocr_confidence: 0.92,
  },
];

function revision(
  pageId: string,
  revisionId: string,
  revisionNo: number,
  status: AdminPageRevisionDetailDTO["verification_status"],
  lifecycle: AdminPageRevisionDetailDTO["lifecycle_status"],
): AdminPageRevisionDetailDTO {
  return {
    page_id: pageId,
    page_revision_id: revisionId,
    revision_no: revisionNo,
    verification_status: status,
    lifecycle_status: lifecycle,
    draft_text: "Chú mèo nhỏ",
    words: baseWords.map((word) => ({ ...word, bbox: [...word.bbox] })),
    ocr_metadata: { engine: "local-mock", language: "vie" },
    created_at: `2026-09-0${revisionNo}T08:00:00.000Z`,
    verified_at: status === "VERIFIED" ? "2026-09-01T08:10:00.000Z" : null,
    verified_by: status === "VERIFIED" ? MOCK_ADMIN_ID : null,
  };
}

function processingItem(
  pageId: string,
  record: MockAdminPageRecord,
  detail: AdminPageRevisionDetailDTO,
): AdminPageListItemUI {
  return {
    book_id: record.book_id,
    page_number: record.page_number,
    processing: {
      page_id: pageId,
      page_revision_id: detail.page_revision_id,
      revision_no: detail.revision_no,
      verification_status: detail.verification_status,
      lifecycle_status: record.lifecycle_status,
      ocr_preview_metadata: { word_count: detail.words.length },
      verified_at: detail.verified_at,
      current_verified_revision_id: record.current_verified_revision_id,
    },
  };
}

export function toAdminPageListItem(
  store: MockAdminStore,
  pageId: string,
): AdminPageListItemUI {
  const page = store.pages.get(pageId);
  if (!page) throw new Error("Mock page missing");
  const detail = store.revisions.get(page.latest_revision_id);
  if (!detail) throw new Error("Mock revision missing");
  return processingItem(pageId, page, detail);
}

export function createMockAdminStore(): MockAdminStore {
  const books: BookListItemDTO[] = [
    {
      id: MOCK_ADMIN_BOOK_ID,
      title: "Chú Mèo Nhỏ",
      author: "Nhóm ReadAlong",
      min_grade: 2,
      max_grade: 2,
      lifecycle_status: "ACTIVE",
    },
    {
      id: MOCK_RETIRED_BOOK_ID,
      title: "Khu Vườn Cũ",
      author: "Nhóm ReadAlong",
      min_grade: 1,
      max_grade: 3,
      lifecycle_status: "RETIRED",
    },
    {
      id: MOCK_REVIEW_BOOK_ID,
      title: "Bản Thảo Cây Khế",
      author: "Truyện dân gian Việt Nam",
      min_grade: 3,
      max_grade: 5,
      lifecycle_status: "ACTIVE",
    },
  ];

  const pageRecords: Array<[string, MockAdminPageRecord]> = [
    [
      MOCK_ADMIN_PAGE_ID,
      {
        book_id: MOCK_ADMIN_BOOK_ID,
        page_number: 4,
        image_url: "/images/figma/book-cat.svg",
        width: 1200,
        height: 1600,
        lifecycle_status: "ACTIVE",
        current_verified_revision_id: MOCK_ADMIN_R1_ID,
        latest_revision_id: MOCK_ADMIN_R1_ID,
      },
    ],
    [
      "83000000-0000-4000-8000-000000000002",
      {
        book_id: MOCK_ADMIN_BOOK_ID,
        page_number: 5,
        image_url: "/images/figma/book-cat.svg",
        width: 1200,
        height: 1600,
        lifecycle_status: "ACTIVE",
        current_verified_revision_id: null,
        latest_revision_id: "84000000-0000-4000-8000-000000000002",
      },
    ],
    [
      "83000000-0000-4000-8000-000000000003",
      {
        book_id: MOCK_REVIEW_BOOK_ID,
        page_number: 1,
        image_url: "/images/figma/book-starfruit.svg",
        width: 1200,
        height: 1600,
        lifecycle_status: "ACTIVE",
        current_verified_revision_id: null,
        latest_revision_id: "84000000-0000-4000-8000-000000000003",
      },
    ],
    [
      "83000000-0000-4000-8000-000000000004",
      {
        book_id: MOCK_RETIRED_BOOK_ID,
        page_number: 1,
        image_url: "/images/figma/book-garden.svg",
        width: 1200,
        height: 1600,
        lifecycle_status: "ACTIVE",
        current_verified_revision_id: "84000000-0000-4000-8000-000000000004",
        latest_revision_id: "84000000-0000-4000-8000-000000000004",
      },
    ],
  ];

  const revisions = [
    revision(MOCK_ADMIN_PAGE_ID, MOCK_ADMIN_R1_ID, 1, "VERIFIED", "ACTIVE"),
    revision(
      "83000000-0000-4000-8000-000000000002",
      "84000000-0000-4000-8000-000000000002",
      1,
      "PROCESSING",
      "ACTIVE",
    ),
    revision(
      "83000000-0000-4000-8000-000000000003",
      "84000000-0000-4000-8000-000000000003",
      1,
      "NEEDS_REVIEW",
      "ACTIVE",
    ),
    revision(
      "83000000-0000-4000-8000-000000000004",
      "84000000-0000-4000-8000-000000000004",
      1,
      "VERIFIED",
      "ACTIVE",
    ),
  ];

  return {
    books: new Map(books.map((book) => [book.id, book])),
    pages: new Map(pageRecords),
    revisions: new Map(revisions.map((item) => [item.page_revision_id, item])),
    audits: [
      {
        id: "89000000-0000-4000-8000-000000000001",
        actor_id: MOCK_ADMIN_ID,
        action: "PAGE_REVISION_VERIFIED",
        resource_type: "page_revision",
        resource_id: MOCK_ADMIN_R1_ID,
        request_id: "mock-request-admin-001",
        created_at: "2026-09-12T08:10:00.000Z",
        metadata: { revision_no: 1 },
      },
      {
        id: "89000000-0000-4000-8000-000000000002",
        actor_id: MOCK_ADMIN_ID,
        action: "BOOK_STATUS_UPDATED",
        resource_type: "book",
        resource_id: MOCK_RETIRED_BOOK_ID,
        request_id: "mock-request-admin-002",
        created_at: "2026-09-11T09:00:00.000Z",
        metadata: { status: "RETIRED" },
      },
      {
        id: "89000000-0000-4000-8000-000000000003",
        actor_id: null,
        action: "ADMIN_LOGIN_CHECK",
        resource_type: "auth",
        resource_id: null,
        request_id: "mock-request-admin-003",
        created_at: "2026-09-10T07:30:00.000Z",
        metadata: { outcome: "allowed" },
      },
    ],
    nextBookSequence: 10,
    nextPageSequence: 10,
  };
}

export function cloneRevision(
  detail: AdminPageRevisionDetailDTO,
): AdminPageRevisionDetailDTO {
  return {
    ...detail,
    words: detail.words.map((word) => ({ ...word, bbox: [...word.bbox] })),
    ocr_metadata: { ...detail.ocr_metadata },
  };
}

export function waitForAdminMock(delay = 320): Promise<void> {
  if (process.env.NODE_ENV === "test") return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(resolve, delay));
}

export function waitForever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}
