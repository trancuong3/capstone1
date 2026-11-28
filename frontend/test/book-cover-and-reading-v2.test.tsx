import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminBookEditorScreen } from "@/components/admin/admin-book-editor-screen";
import { BookCover } from "@/components/books/book-cover";
import { BookCoverStudio } from "@/components/books/book-cover-studio";
import { ParentPrivateBookManager } from "@/components/books/parent-private-book-manager";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import type { BookAssetsService } from "@/lib/api/book-assets-service";
import {
  adminBookFixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type { BookListItemDTO } from "@/types/book";
import type {
  BookAssetsSummaryDTO,
  BookPresentationAssetDTO,
} from "@/types/book-assets";
import type { ReadingPageDTO } from "@/types/reading";

const { routerMock, fetchMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  fetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "studio-v2-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const BOOK_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const ILL_ASSET_ID = "33333333-3333-4333-8333-333333333333";

const sampleBook: BookListItemDTO = {
  id: BOOK_ID,
  title: "Khu Vườn Nắng Sớm Của Mèo Con",
  author: "Nguyễn Nhật Ánh",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
};

function makeAsset(
  overrides: Partial<BookPresentationAssetDTO> = {},
): BookPresentationAssetDTO {
  return {
    id: ASSET_ID,
    book_id: BOOK_ID,
    book_page_id: null,
    source_revision_id: null,
    asset_role: "COVER",
    source_type: "USER_UPLOAD",
    media_url: `/studio/assets/${ASSET_ID}/media`,
    mime_type: "image/webp",
    width: 900,
    height: 1200,
    size_bytes: 42_000,
    asset_hash: "a".repeat(64),
    asset_version: 1,
    is_active: true,
    text_free_verified: true,
    moderation_status: "APPROVED",
    provider_name: "user_upload",
    model_id: null,
    job_id: null,
    metadata: {},
    created_at: "2026-11-25T10:00:00Z",
    updated_at: "2026-11-25T10:00:00Z",
    ...overrides,
  };
}

function makeSummary(
  overrides: Partial<BookAssetsSummaryDTO> = {},
): BookAssetsSummaryDTO {
  return {
    book_id: BOOK_ID,
    title: sampleBook.title,
    author: sampleBook.author,
    min_grade: 1,
    max_grade: 3,
    visibility_scope: "CATALOG",
    active_cover: null,
    effective_cover_source: "METADATA_RENDER",
    metadata_fallback: {
      palette_id: "meadow-leaf",
      primary_color: "#ECF8F2",
      secondary_color: "#52B788",
      accent_color: "#1B6B4D",
      motif: "leaves",
      title: sampleBook.title,
      author: sampleBook.author,
      grade_label: "Lớp 1–3",
      source_type: "METADATA_RENDER",
    },
    style_bible: null,
    page_illustrations: [],
    ai_image_provider_available: false,
    ai_image_provider_name: null,
    ai_image_provider_message_vi:
      "Chưa cấu hình nhà cung cấp tạo ảnh AI miễn phí (Cloudflare Workers AI hoặc Local Image Worker).",
    v2_storage_degraded: false,
    ...overrides,
  };
}

function makeMockAssetsService(
  overrides: Partial<BookAssetsService> = {},
): BookAssetsService {
  return {
    getBookAssets: vi.fn().mockResolvedValue(makeSummary()),
    uploadCover: vi.fn().mockResolvedValue(makeAsset()),
    deleteCover: vi.fn().mockResolvedValue({
      book_id: BOOK_ID,
      removed_count: 1,
      metadata_fallback: makeSummary().metadata_fallback,
      message_vi:
        "Đã gỡ ảnh bìa hiện tại và chuyển về bìa chữ tiếng Việt tự động.",
    }),
    generateAiCover: vi.fn().mockResolvedValue({
      status: "BLOCKED_NO_IMAGE_PROVIDER",
      job_id: null,
      provider_name: null,
      model_id: null,
      message_vi:
        "Chưa cấu hình nhà cung cấp tạo ảnh AI miễn phí. Hệ thống giữ bìa chữ tiếng Việt tự động.",
      cover: null,
      metadata_fallback: makeSummary().metadata_fallback,
      style_bible: null,
      honest_ai_generated: false,
    }),
    buildStyleBible: vi.fn(),
    extractPageIllustration: vi.fn(),
    generatePageIllustration: vi.fn(),
    moderatePageIllustration: vi.fn(),
    ...overrides,
  };
}

const readingPage: ReadingPageDTO = {
  page_id: "44444444-4444-4444-8444-444444444444",
  page_revision_id: "55555555-5555-4555-8555-555555555555",
  page_number: 3,
  confidence: 0.98,
  width: 800,
  height: 1000,
  image_url: "https://example.test/raw-text-laden-scan.png",
  image_overlay_safe: false,
  text: "Mèo con bước ra vườn hoa.",
  words: ["Mèo", "con", "bước", "ra", "vườn", "hoa."].map((text, idx) => ({
    word_id: `w-${idx}`,
    word_index: idx,
    line_index: 0,
    text,
    bbox: [0.08 + idx * 0.14, 0.7, 0.12, 0.05] as const,
  })),
};

describe("BookCover V2 (Unified Cover & Metadata Fallback)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:studio-v2-cover"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a crisp Vietnamese Unicode metadata cover without duplicating the title or claiming AI", () => {
    const { container } = render(
      <BookCover author="Nguyễn Nhật Ánh" book={sampleBook} grade="Lớp 1–3" />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-cover-source", "METADATA_RENDER");
    expect(screen.getAllByText(sampleBook.title)).toHaveLength(1);
    expect(screen.getByText("Nguyễn Nhật Ánh")).toBeInTheDocument();
    expect(screen.getByText("Lớp 1–3")).toBeInTheDocument();
    expect(screen.queryByTestId("book-cover-ai-badge")).not.toBeInTheDocument();

    const hero = render(
      <BookCover
        author="Nguyễn Nhật Ánh"
        book={sampleBook}
        className="reader-cover-art"
        grade="Lớp 1–3"
        hero
      />,
    );
    for (const part of [
      "spine",
      "body",
      "header",
      "grade",
      "monogram",
      "title-block",
      "footer",
    ]) {
      expect(
        hero.container.querySelector(`[data-cover-part="${part}"]`),
      ).not.toBeNull();
    }
  });

  it("loads authenticated /studio/assets/.../media cover with Bearer token and revokes blob on unmount", async () => {
    fetchMock.mockResolvedValue(
      new Response("webp-bytes", {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      }),
    );

    const { unmount } = render(
      <BookCover
        book={sampleBook}
        coverSourceType="USER_UPLOAD"
        coverUrl={`/studio/assets/${ASSET_ID}/media`}
      />,
    );

    const img = await screen.findByRole("img", {
      name: `Ảnh bìa sách ${sampleBook.title}`,
    });
    expect(img).toHaveAttribute("src", "blob:studio-v2-cover");
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8000/studio/assets/${ASSET_ID}/media`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer studio-v2-test-token",
        }),
      }),
    );

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:studio-v2-cover");
  });

  it("gracefully degrades to Vietnamese metadata cover if a direct coverUrl fails to load", () => {
    const { container } = render(
      <BookCover
        book={sampleBook}
        coverSourceType="USER_UPLOAD"
        coverUrl="https://example.test/broken-cover.webp"
      />,
    );
    const img = screen.getByRole("img", {
      name: `Ảnh bìa sách ${sampleBook.title}`,
    });
    fireEvent.error(img);
    expect(container.firstElementChild).toHaveAttribute(
      "data-cover-source",
      "METADATA_RENDER",
    );
  });

  it("preserves cover_url/cover_source_type and illustration_url/illustration_text_free through live Zod schemas", async () => {
    const { bookDtoSchema } = await import("@/lib/api/book-service");
    const { readingPageDtoSchema } = await import("@/lib/api/reading-service");

    const parsedBook = bookDtoSchema.parse({
      id: BOOK_ID,
      title: "Mèo con đi học",
      author: "Nguyễn Văn A",
      min_grade: 1,
      max_grade: 3,
      lifecycle_status: "ACTIVE",
      visibility_scope: "CATALOG",
      cover_url: `/studio/assets/${ASSET_ID}/media`,
      cover_source_type: "USER_UPLOAD",
    });
    expect(parsedBook.cover_url).toBe(`/studio/assets/${ASSET_ID}/media`);
    expect(parsedBook.cover_source_type).toBe("USER_UPLOAD");

    const parsedPage = readingPageDtoSchema.parse({
      page_id: "33333333-3333-4333-8333-333333333333",
      page_revision_id: "44444444-4444-4444-8444-444444444444",
      page_number: 1,
      confidence: 0.96,
      width: 800,
      height: 1200,
      image_url: "https://example.test/page1.webp",
      illustration_url: `/studio/assets/${ASSET_ID}/media`,
      illustration_text_free: true,
      words: [],
    });
    expect(parsedPage.illustration_url).toBe(
      `/studio/assets/${ASSET_ID}/media`,
    );
    expect(parsedPage.illustration_text_free).toBe(true);
  });
});

describe("BookCoverStudio (Admin & Parent, Android Capture, Crop/Rotate, Honest AI)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    routerMock.push.mockReset();
    routerMock.refresh.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:staged-preview"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers dual Android camera+gallery inputs, rotates 90°, applies 3:4 crop, uploads, deletes, and shows honest AI status", async () => {
    const service = makeMockAssetsService();
    const onCoverUpdated = vi.fn();
    const user = userEvent.setup();

    fetchMock.mockResolvedValue(
      new Response("webp", {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      }),
    );

    render(
      <BookCoverStudio
        actorRole="parent"
        author={sampleBook.author}
        autoLoad
        bookId={BOOK_ID}
        bookTitle={sampleBook.title}
        maxGrade={3}
        minGrade={1}
        onCoverUpdated={onCoverUpdated}
        service={service}
      />,
    );

    // Wait for initial asset summary load
    await waitFor(() => {
      expect(service.getBookAssets).toHaveBeenCalledWith(
        BOOK_ID,
        expect.any(AbortSignal),
      );
    });
    expect(screen.getByTestId("cover-source-badge")).toHaveTextContent(
      "Bìa chữ tiếng Việt tự động",
    );

    // Verify dual Android-friendly inputs
    const cameraInput = screen.getByTestId("cover-camera-input");
    const galleryInput = screen.getByTestId("cover-gallery-input");
    expect(cameraInput).toHaveAttribute("capture", "environment");
    expect(galleryInput).not.toHaveAttribute("capture");

    // Stage a cover file via gallery input
    const file = new File(["fake-png"], "bia-sach.png", { type: "image/png" });
    fireEvent.change(galleryInput, { target: { files: [file] } });

    expect(
      await screen.findByTestId("cover-crop-rotate-panel"),
    ).toBeInTheDocument();

    // Rotate 90° and choose CENTER 3:4 crop preset
    await user.click(screen.getByRole("button", { name: /Xoay 90°/ }));
    expect(
      screen.getByRole("button", { name: /Xoay 90° \(90°\)/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cắt giữa 80%" }));

    // Upload cover
    await user.click(screen.getByRole("button", { name: "Lưu ảnh bìa" }));
    await waitFor(() => {
      expect(service.uploadCover).toHaveBeenCalledWith(
        BOOK_ID,
        expect.any(File),
        {
          crop: { crop_x: 0.1, crop_y: 0.1, crop_w: 0.8, crop_h: 0.8 },
          rotation: 90,
        },
      );
    });
    expect(onCoverUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ source_type: "USER_UPLOAD" }),
    );
    expect(screen.getByTestId("cover-source-badge")).toHaveTextContent(
      "Ảnh bìa tự tải lên",
    );

    // Delete cover -> reverts to metadata fallback
    await user.click(screen.getByRole("button", { name: "Xóa ảnh bìa" }));
    await waitFor(() => {
      expect(service.deleteCover).toHaveBeenCalledWith(BOOK_ID);
    });
    expect(screen.getByTestId("cover-source-badge")).toHaveTextContent(
      "Bìa chữ tiếng Việt tự động",
    );

    // Click "Tạo bìa bằng AI" -> shows honest BLOCKED_NO_IMAGE_PROVIDER message (never fakes AI cover!)
    await user.click(screen.getByRole("button", { name: "Tạo bìa bằng AI" }));
    const aiStatus = await screen.findByRole("status");
    expect(aiStatus).toHaveTextContent(
      /Chưa cấu hình nhà cung cấp tạo ảnh AI miễn phí/,
    );
    expect(screen.getByTestId("cover-source-badge")).toHaveTextContent(
      "Bìa chữ tiếng Việt tự động",
    );
  });

  it("opens Cover Studio cleanly inside AdminBookEditorScreen without modifying book metadata", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.books.get).mockResolvedValue(adminBookFixture);
    fetchMock.mockResolvedValue(
      Response.json(makeSummary({ book_id: adminBookFixture.id })),
    );
    const user = userEvent.setup();

    render(
      withAdminFixture(
        <AdminBookEditorScreen bookId={adminBookFixture.id} />,
        services,
      ),
    );

    await screen.findByRole("heading", { name: "Ảnh bìa sách" });
    await user.click(screen.getByRole("button", { name: "Mở Cover Studio" }));
    expect(await screen.findByTestId("book-cover-studio")).toBeInTheDocument();
    expect(services.books.update).not.toHaveBeenCalled();
  });

  it("fixes ParentPrivateBookManager pagination total to filteredSubmissions.length and isolates Cover Studio from OCR recheck", async () => {
    const privateBookId = "91000000-0000-4000-8000-000000000001";
    const batchId = "93000000-0000-4000-8000-000000000001";
    const submissions = Array.from({ length: 25 }, (_, i) => {
      const pageNum = i + 1;
      const isFailed = pageNum === 7;
      return {
        id: `92000000-0000-4000-8000-${String(pageNum).padStart(12, "0")}`,
        book_id: privateBookId,
        batch_id: batchId,
        batch_total_pages: 25,
        source_page_number: pageNum,
        target_page_number: pageNum,
        source_file_name: "sach-25-trang.pdf",
        source_format: "PDF",
        image_width: 800,
        image_height: 1100,
        image_url: `https://storage.example.com/p${pageNum}.jpg`,
        source_type: "OWNED_PHYSICAL_BOOK",
        source_type_label: "Sách giấy gia đình mua",
        source_note: null,
        submission_version: 1,
        optimistic_lock_version: 1,
        ocr_status: isFailed ? "FAILED" : "PASSED",
        ocr_text: isFailed ? null : `Trang ${pageNum}`,
        ocr_error_code: isFailed ? "LOCAL_OCR_UNAVAILABLE" : null,
        is_image_only: false,
        proofread_status: isFailed ? "PENDING" : "PASSED",
        proofread_text: isFailed ? null : `Trang ${pageNum}`,
        proofread_suggestions: [],
        uncertain_word_indices: [],
        proofread_error_code: null,
        spelling_accepted: !isFailed,
        candidate_text: isFailed ? null : `Trang ${pageNum}`,
        candidate_hash: `hash-${pageNum}`,
        tool_check_status: isFailed ? "PENDING" : "PASSED",
        tool_check_suitability: isFailed ? null : "SAFE",
        tool_check_scope: {
          modality: "TEXT_ONLY",
          covers_all_chunks: !isFailed,
          chunks_checked: isFailed ? 0 : 1,
          total_chunks: isFailed ? 0 : 1,
          image_visual_safety_checked: false,
          requires_admin_visual_review: false,
          copyright_scanner_status: "CLEAR",
          local_ai_enforced: true,
        },
        tool_check_findings_count: 0,
        tool_check_parent_notice: null,
        tool_check_policy_blocked: false,
        tool_check_workflow_id: null,
        tool_check_error_code: null,
        provider_events: [],
        workflow_status: isFailed ? "CHECK_FAILED" : "PASSED_READY_TO_ADD",
        workflow_status_label: isFailed ? "Kiểm tra lỗi" : "Sẵn sàng thêm",
        can_add_to_book: !isFailed,
        can_request_admin_review: false,
        can_retry: isFailed,
        admin_decision: null,
        admin_decision_reason: null,
        approved_snapshot_hash: null,
        approved_submission_version: null,
        committed_page_id: null,
        committed_revision_id: null,
        created_at: "2026-11-25T00:00:00Z",
        updated_at: "2026-11-25T00:00:00Z",
      };
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/studio/books/")) {
        return Response.json(
          makeSummary({
            book_id: privateBookId,
            visibility_scope: "PARENT_PRIVATE",
          }),
        );
      }
      return Response.json({
        book: {
          id: privateBookId,
          title: "Truyện 25 trang của bé",
          author: "Mẹ bé An",
          min_grade: 1,
          max_grade: 3,
          lifecycle_status: "ACTIVE",
          visibility_scope: "PARENT_PRIVATE",
          moderation_status: "ACTIVE",
          suspended_reason: null,
          source_declaration: "OWNED_PHYSICAL_BOOK",
          committed_page_count: 2,
          pending_submission_count: 25,
          flagged_submission_count: 0,
          failed_submission_count: 1,
          ready_to_add_count: 24,
          readable_for_children: true,
          has_held_multipage_batch: false,
          privacy_notice: "Chỉ hiển thị trong tài khoản gia đình.",
          ocr_contribution: null,
          created_at: "2026-11-25T00:00:00Z",
        },
        pages: [],
        submissions,
      });
    });

    const user = userEvent.setup();
    render(
      <AppServicesProvider>
        <ParentPrivateBookManager bookId={privateBookId} />
      </AppServicesProvider>,
    );

    // Before filter: 25 submissions -> pagination shows 3 pages
    expect(
      await screen.findByText(/Các trang đang kiểm tra & duyệt \(25\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", {
        name: "Phân trang các trang đang kiểm tra",
      }),
    ).toBeInTheDocument();

    // Filter to "Lỗi kiểm tra (1)" -> ONLY 1 item, so pagination bar MUST disappear (not stay stuck at 25/3 pages!)
    const filterGroup = screen.getByRole("group", {
      name: "Lọc trạng thái từng trang",
    });
    await user.click(
      within(filterGroup).getByRole("button", { name: "Lỗi kiểm tra (1)" }),
    );
    expect(
      screen.queryByRole("navigation", {
        name: "Phân trang các trang đang kiểm tra",
      }),
    ).not.toBeInTheDocument();

    // Open "Đổi ảnh bìa" -> renders BookCoverStudio without calling PATCH /books/my-books/
    await user.click(screen.getByRole("button", { name: "Đổi ảnh bìa" }));
    expect(await screen.findByTestId("book-cover-studio")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes(`/books/my-books/${privateBookId}`) &&
          init?.method === "PATCH",
      ),
    ).toBe(false);
  });
});

describe("BookPageViewer V2 (3-Mode Child Reading UI)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:storybook-illustration"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to ILLUSTRATED mode when illustrationUrl & illustrationTextFree=true, hides raw scan, and switches modes without breaking word tap or highlight", async () => {
    const onWordClick = vi.fn();
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      new Response("webp-art", {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      }),
    );

    render(
      <BookPageViewer
        currentWordId="w-1"
        illustrationTextFree
        illustrationUrl={`/studio/assets/${ILL_ASSET_ID}/media`}
        onWordClick={onWordClick}
        page={readingPage}
        title="Mèo con ra vườn"
      />,
    );

    const article = screen.getByRole("article");
    expect(article).toHaveAttribute("data-reading-mode", "ILLUSTRATED");
    expect(article).toHaveAttribute("data-render-mode", "illustrated");

    // Storybook illustration loads via authenticated fetch, ZERO raw text-laden scan shown!
    const illCard = await screen.findByTestId("storybook-illustration-card");
    expect(
      within(illCard).getByRole("img", { name: "Tranh minh họa trang 3" }),
    ).toHaveAttribute("src", "blob:storybook-illustration");
    expect(
      screen.queryByTestId("original-page-reference-panel"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Xem ảnh trang sách")).not.toBeInTheDocument();

    // Current word highlight & word tap work seamlessly
    const currentWord = screen.getByRole("button", { name: "con" });
    expect(currentWord).toHaveAttribute("data-reading-state", "current");
    expect(currentWord).toHaveAttribute("aria-current", "true");
    await user.click(currentWord);
    expect(onWordClick).toHaveBeenCalledWith(
      expect.objectContaining({ word_id: "w-1", text: "con" }),
    );

    // Switch to "Đọc chữ" -> illustration card disappears, highlight & tap stay intact
    await user.click(screen.getByRole("tab", { name: "Đọc chữ" }));
    expect(article).toHaveAttribute("data-reading-mode", "TEXT");
    expect(
      screen.queryByTestId("storybook-illustration-card"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "con" })).toHaveAttribute(
      "data-reading-state",
      "current",
    );

    // Switch to "Trang gốc đối chiếu" -> reveals original page panel on demand, preserving highlight
    await user.click(screen.getByRole("tab", { name: "Trang gốc đối chiếu" }));
    expect(article).toHaveAttribute("data-reading-mode", "ORIGINAL");
    expect(
      screen.getByTestId("original-page-reference-panel"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "con" })).toHaveAttribute(
      "data-reading-state",
      "current",
    );
  });

  it("refuses ILLUSTRATED mode and falls back to TEXT mode when illustrationTextFree is false", () => {
    render(
      <BookPageViewer
        currentWordId="w-0"
        illustrationTextFree={false}
        illustrationUrl="https://example.test/unverified-with-text.webp"
        page={readingPage}
      />,
    );

    const article = screen.getByRole("article");
    expect(article).toHaveAttribute("data-reading-mode", "TEXT");
    expect(
      screen.queryByRole("tab", { name: "Minh họa" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("storybook-illustration-card"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mèo" })).toHaveAttribute(
      "data-reading-state",
      "current",
    );
  });
});
