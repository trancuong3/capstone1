import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminBookEditorScreen } from "@/components/admin/admin-book-editor-screen";
import { AdminNewBookScreen } from "@/components/admin/admin-new-book-screen";
import { AdminPageUploader } from "@/components/admin/admin-page-uploader";
import { SmartOcrBlockReview } from "@/components/admin/smart-ocr-block-review";
import { PageIllustrationStudio } from "@/components/books/page-illustration-studio";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { ReadingLayout } from "@/components/reading/reading-layout";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import { StudioTasksPageScreen } from "@/components/tasks/studio-tasks-page-screen";
import { clearAdminBookUploadSessionForTests } from "@/lib/admin/admin-book-upload-session";
import type { BookAssetsService } from "@/lib/api/book-assets-service";
import {
  clearGlobalTasksMemoryCache,
  emitStudioTasksChanged,
  STUDIO_TASKS_CHANGED_EVENT,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import { applyPageOcrExtractionToDraft } from "@/lib/api/ocr-extraction-service";
import {
  adminBookFixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type {
  BookAssetsSummaryDTO,
  BookPresentationAssetDTO,
} from "@/types/book-assets";
import type {
  GlobalTaskActionResponse,
  GlobalTaskItem,
  GlobalTaskListResponse,
} from "@/types/global-tasks";
import type { PageOcrExtractionDTO } from "@/types/ocr-extraction";
import type { ReadingPageDTO } from "@/types/reading";

const { routerMock, pathnameMock, fetchMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  pathnameMock: { current: "/my-books" },
  fetchMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => pathnameMock.current,
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "studio-v2-complete-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const BOOK_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_1_ID = "22222222-2222-4222-8222-222222222221";
const PAGE_2_ID = "22222222-2222-4222-8222-222222222222";
const REV_1_ID = "33333333-3333-4333-8333-333333333331";
const REV_2_ID = "33333333-3333-4333-8333-333333333332";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";

function makeReadingPage(
  overrides: Partial<ReadingPageDTO> = {},
): ReadingPageDTO {
  return {
    page_id: PAGE_1_ID,
    page_revision_id: REV_1_ID,
    page_number: 1,
    confidence: 0.99,
    width: 800,
    height: 1000,
    image_url: "https://example.test/page-1.png",
    image_overlay_safe: false,
    illustration_url: null,
    illustration_text_free: false,
    text: "Mèo con đi học.",
    words: ["Mèo", "con", "đi", "học."].map((text, idx) => ({
      word_id: `w-${idx}`,
      word_index: idx,
      line_index: 0,
      text,
      bbox: [0.1 + idx * 0.2, 0.5, 0.16, 0.05] as const,
    })),
    ...overrides,
  };
}

function makeAsset(
  overrides: Partial<BookPresentationAssetDTO> = {},
): BookPresentationAssetDTO {
  return {
    id: ASSET_ID,
    book_id: BOOK_ID,
    book_page_id: PAGE_1_ID,
    source_revision_id: REV_1_ID,
    asset_role: "PAGE_ILLUSTRATION",
    source_type: "ORIGINAL_CROP",
    media_url: `/studio/assets/${ASSET_ID}/media`,
    mime_type: "image/webp",
    width: 800,
    height: 600,
    size_bytes: 54_000,
    asset_hash: "b".repeat(64),
    asset_version: 1,
    is_active: true,
    text_free_verified: true,
    moderation_status: "PENDING",
    provider_name: "opencv_local",
    model_id: null,
    job_id: null,
    metadata: { ocr_gate_mode: "tesseract_ocr" },
    created_at: "2026-11-26T00:00:00Z",
    updated_at: "2026-11-26T00:00:00Z",
    ...overrides,
  };
}

function makeSummary(
  overrides: Partial<BookAssetsSummaryDTO> = {},
): BookAssetsSummaryDTO {
  return {
    book_id: BOOK_ID,
    title: "Mèo con đi học",
    author: "Nguyễn Nhật Ánh",
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
      title: "Mèo con đi học",
      author: "Nguyễn Nhật Ánh",
      grade_label: "Lớp 1–3",
      source_type: "METADATA_RENDER",
    },
    style_bible: null,
    page_illustrations: [],
    ai_image_provider_available: true,
    ai_image_provider_name: "cloudflare_workers_ai",
    ai_image_provider_message_vi: "Cloudflare Workers AI sẵn sàng (0 VND).",
    v2_storage_degraded: false,
    ...overrides,
  };
}

function makeMockAssetsService(
  overrides: Partial<BookAssetsService> = {},
): BookAssetsService {
  return {
    getBookAssets: vi.fn().mockResolvedValue(makeSummary()),
    uploadCover: vi.fn().mockResolvedValue(
      makeAsset({
        book_page_id: null,
        asset_role: "COVER",
        source_type: "USER_UPLOAD",
        moderation_status: "APPROVED",
      }),
    ),
    deleteCover: vi.fn(),
    generateAiCover: vi.fn(),
    buildStyleBible: vi.fn(),
    extractPageIllustration: vi.fn().mockResolvedValue({
      status: "EXTRACTED_VERIFIED",
      asset: makeAsset({
        moderation_status: "PENDING",
        text_free_verified: true,
      }),
      text_free_verified: true,
      text_density_score: 0.01,
      ocr_overlap_score: 0.0,
      artwork_area_ratio: 0.35,
      recommended_reading_mode: "ILLUSTRATED",
      message_vi: "Đã tách tranh minh họa sạch chữ từ trang sách.",
    }),
    generatePageIllustration: vi.fn().mockResolvedValue({
      status: "QUEUED",
      job_id: "99999999-9999-4999-8999-999999999999",
      provider_name: "cloudflare_workers_ai",
      model_id: "@cf/black-forest-labs/flux-1-schnell",
      asset: null,
      recommended_reading_mode: "TEXT",
      message_vi: "Đã xếp hàng tạo tranh minh họa AI miễn phí.",
    }),
    moderatePageIllustration: vi
      .fn()
      .mockImplementation(async (_bookId, _pageId, _assetId, action) =>
        makeAsset({
          moderation_status:
            action === "APPROVE"
              ? "APPROVED"
              : action === "REJECT"
                ? "REJECTED"
                : "PENDING",
        }),
      ),
    ...overrides,
  };
}

function makeTask(overrides: Partial<GlobalTaskItem> = {}): GlobalTaskItem {
  const nowIso = "2026-11-26T08:00:00.000Z";
  return {
    id: "task-1",
    source: "smart_studio_job",
    job_type: "OCR_EXTRACT",
    title_vi: "Tách nội dung OCR thông minh",
    book_id: BOOK_ID,
    book_page_id: PAGE_1_ID,
    book_title: "Mèo con đi học",
    page_number: 1,
    source_revision_id: REV_1_ID,
    actor_role: "admin",
    status: "RUNNING",
    status_label_vi: "Đang xử lý",
    stage: "OCR",
    stage_label_vi: "Nhận diện chữ",
    priority: 50,
    attempt_count: 1,
    max_attempts: 3,
    progress_completed: 2,
    progress_total: 5,
    progress_unit: "trang",
    progress_pct: 40,
    is_indeterminate: false,
    can_retry: false,
    can_cancel: true,
    result_href: `/admin/books/${BOOK_ID}/pages/${PAGE_1_ID}`,
    result_ref: {},
    checkpoints: {},
    error_code: null,
    error_message_vi: null,
    created_at: nowIso,
    updated_at: nowIso,
    started_at: nowIso,
    completed_at: null,
    ...overrides,
  };
}

function makeTaskFeed(
  tasks: GlobalTaskItem[],
  overrides: Partial<GlobalTaskListResponse> = {},
): GlobalTaskListResponse {
  return {
    actor_id: "admin-1",
    actor_role: "admin",
    active_count: tasks.filter((t) =>
      [
        "QUEUED",
        "RUNNING",
        "WAITING_FOR_WORKER",
        "WAITING_FOR_QUOTA",
        "RETRY_SCHEDULED",
        "CANCEL_REQUESTED",
      ].includes(t.status),
    ).length,
    waiting_review_count: tasks.filter((t) => t.status === "WAITING_FOR_REVIEW")
      .length,
    failed_count: tasks.filter((t) => t.status === "FAILED").length,
    completed_count: tasks.filter((t) => t.status === "SUCCEEDED").length,
    worker_online: true,
    recommended_poll_ms: 4000,
    tasks,
    ...overrides,
  };
}

function makeExtractionFixture(): PageOcrExtractionDTO {
  return {
    extraction_id: "55555555-5555-4555-8555-555555555555",
    book_id: BOOK_ID,
    book_page_id: PAGE_1_ID,
    page_revision_id: REV_1_ID,
    source_hash: "c".repeat(64),
    algorithm_version: "v2.0",
    filter_mode: "active",
    page_kind: "TEXT_ONLY",
    geometry_transform: null,
    blocks: [
      {
        block_id: "blk-1",
        raw_text: "Mèo con đi học.",
        display_text: "Mèo con đi học.",
        bbox: [0.1, 0.2, 0.7, 0.08],
        reading_order: 0,
        column_index: 0,
        line_indices: [0],
        word_ids: ["w-0", "w-1", "w-2", "w-3"],
        source_word_indices: [0, 1, 2, 3],
        block_type: "STORY_BODY",
        decision: "KEEP",
        auto_decision: "KEEP",
        reason_vi: "Nội dung bài đọc chính.",
        reason_code: "STORY_BODY",
        decision_source: "GEOMETRIC",
        confidence: 0.98,
        user_override: false,
        edited_text: null,
        cross_page_matches: [],
        in_canonical: true,
        audit_trail: [],
      },
    ],
    canonical_text: "Mèo con đi học.",
    canonical_words: [],
    stats: {
      total_blocks: 1,
      keep_blocks: 1,
      exclude_blocks: 0,
      review_blocks: 0,
      total_chars: 15,
      kept_chars: 15,
      excluded_chars: 0,
      review_chars: 0,
      retention_ratio: 1,
      circuit_breaker_triggered: false,
      fast_path_ms: 4,
      cross_page_ms: 0,
      semantic_ai_ms: 0,
      total_ms: 4,
      semantic_ai_invoked: false,
      semantic_ai_fallback_used: false,
      semantic_ai_error_code: null,
    },
    requires_review: false,
    undo_available: false,
    undo_depth: 0,
    persisted: true,
    storage_degraded: false,
    created_at: null,
    updated_at: null,
  };
}

describe("Wave 2B Studio V2 Complete Integration", () => {
  beforeEach(() => {
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
    routerMock.refresh.mockReset();
    pathnameMock.current = "/my-books";
    fetchMock.mockReset();
    clearGlobalTasksMemoryCache();
    clearAdminBookUploadSessionForTests();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:v2-complete-preview"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearGlobalTasksMemoryCache();
    clearAdminBookUploadSessionForTests();
  });

  it("always renders the 3-mode switcher (even without illustration) and persists mode across page turns in ReadingLayout", async () => {
    const user = userEvent.setup();
    const page1WithoutArt = makeReadingPage({
      page_id: PAGE_1_ID,
      page_number: 1,
      illustration_url: null,
      illustration_text_free: false,
    });
    const page2WithArt = makeReadingPage({
      page_id: PAGE_2_ID,
      page_revision_id: REV_2_ID,
      page_number: 2,
      image_url: "https://example.test/page-2.png",
      illustration_url: "https://example.test/page-2-art.webp",
      illustration_text_free: true,
    });

    const noop = vi.fn();
    const { rerender } = render(
      <ReadingLayout
        bookTitle="Mèo con đi học"
        currentWordId="w-0"
        exitHref="/books"
        isListening={false}
        onFinish={noop}
        onHelp={noop}
        onPause={noop}
        page={page1WithoutArt}
      />,
    );

    // Switcher MUST be visible even when illustration_url is null!
    const switcher = screen.getByTestId("reading-mode-switcher");
    expect(
      within(switcher).getByRole("tab", { name: "Đọc chữ" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      within(switcher).getByRole("tab", { name: "Trang gốc đối chiếu" }),
    ).toBeInTheDocument();
    expect(
      within(switcher).queryByRole("tab", { name: "Đọc có tranh" }),
    ).not.toBeInTheDocument();

    // Switch to ORIGINAL ("Trang gốc đối chiếu") on page 1
    await user.click(
      within(switcher).getByRole("tab", { name: "Trang gốc đối chiếu" }),
    );
    expect(screen.getByRole("article")).toHaveAttribute(
      "data-reading-mode",
      "ORIGINAL",
    );

    // Turn to page 2 (which HAS a verified illustration) -> selected mode ORIGINAL MUST persist!
    rerender(
      <ReadingLayout
        bookTitle="Mèo con đi học"
        currentWordId="w-1"
        exitHref="/books"
        isListening={false}
        onFinish={noop}
        onHelp={noop}
        onPause={noop}
        page={page2WithArt}
      />,
    );

    expect(screen.getByRole("article")).toHaveAttribute(
      "data-reading-mode",
      "ORIGINAL",
    );
    const switcherPage2 = screen.getByTestId("reading-mode-switcher");
    const illustratedTab = within(switcherPage2).getByRole("tab", {
      name: "Đọc có tranh",
    });
    expect(illustratedTab).toBeInTheDocument();

    // Child can now switch to "Đọc có tranh" seamlessly without breaking currentWordId
    await user.click(illustratedTab);
    expect(screen.getByRole("article")).toHaveAttribute(
      "data-reading-mode",
      "ILLUSTRATED",
    );
    expect(
      screen.getByTestId("storybook-illustration-card"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "con" })).toHaveAttribute(
      "data-reading-state",
      "current",
    );
  });

  it("shows live cover preview on AdminNewBookScreen and uploads staged cover with viread:tasks-changed", async () => {
    const user = userEvent.setup();
    const services = createAdminServiceFixture();
    const assetsService = makeMockAssetsService();
    vi.mocked(services.books.create).mockResolvedValue({
      ...adminBookFixture,
      id: BOOK_ID,
      title: "Chú Ếch Xanh",
    });

    const events: Event[] = [];
    const listener = (ev: Event) => events.push(ev);
    window.addEventListener(STUDIO_TASKS_CHANGED_EVENT, listener);

    render(
      withAdminFixture(
        <AdminNewBookScreen assetsService={assetsService} />,
        services,
      ),
    );

    const preview = screen.getByTestId("admin-book-live-cover-preview");
    expect(preview).toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "Tên sách *" }),
      "Chú Ếch Xanh",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Tiêu đề sách *" }),
      "Chú Ếch Xanh",
    );
    expect(within(preview).getByText("Chú Ếch Xanh")).toBeInTheDocument();

    // Stage an optional cover file
    const coverFile = new File(["png-bytes"], "ech-xanh.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByTestId("new-book-cover-input"), {
      target: { files: [coverFile] },
    });
    expect(screen.getByText(/Đã chọn: ech-xanh\.png/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tạo sách" }));

    await waitFor(() => {
      expect(services.books.create).toHaveBeenCalledOnce();
      expect(assetsService.uploadCover).toHaveBeenCalledWith(
        BOOK_ID,
        coverFile,
      );
      expect(routerMock.push).toHaveBeenCalledWith(`/admin/books/${BOOK_ID}`);
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    window.removeEventListener(STUDIO_TASKS_CHANGED_EVENT, listener);
  });

  it("hydrates AdminBookEditorScreen cover preview immediately on mount without opening Cover Studio", async () => {
    const services = createAdminServiceFixture();
    vi.mocked(services.books.get).mockResolvedValue({
      ...adminBookFixture,
      id: BOOK_ID,
      cover_url: "https://example.test/hydrated-cover.webp",
      cover_source_type: "USER_UPLOAD",
    });
    const assetsService = makeMockAssetsService({
      getBookAssets: vi.fn().mockResolvedValue(
        makeSummary({
          active_cover: makeAsset({
            book_page_id: null,
            asset_role: "COVER",
            source_type: "USER_UPLOAD",
            media_url: "https://example.test/hydrated-cover.webp",
            moderation_status: "APPROVED",
          }),
          effective_cover_source: "USER_UPLOAD",
        }),
      ),
    });

    render(
      withAdminFixture(
        <AdminBookEditorScreen
          assetsService={assetsService}
          bookId={BOOK_ID}
        />,
        services,
      ),
    );

    const coverImg = await screen.findByRole("img", {
      name: `Ảnh bìa sách ${adminBookFixture.title}`,
    });
    expect(coverImg).toHaveAttribute(
      "src",
      "https://example.test/hydrated-cover.webp",
    );
    expect(screen.queryByTestId("book-cover-studio")).not.toBeInTheDocument();
  });

  it("renders dedicated StudioTasksPageScreen with status/role filters, Retry, Cancel, deep links, and drawer link", async () => {
    const user = userEvent.setup();
    const adminFailed = makeTask({
      id: "task-admin-failed",
      title_vi: "Nhập sách PDF 12 trang",
      actor_role: "admin",
      status: "FAILED",
      status_label_vi: "Xử lý thất bại",
      can_retry: true,
      can_cancel: false,
      error_message_vi: "Tạm hết hạn mức AI.",
    });
    const parentRunning = makeTask({
      id: "task-parent-running",
      title_vi: "Kiểm tra trang sách gia đình",
      actor_role: "parent",
      status: "RUNNING",
      status_label_vi: "Đang xử lý",
      can_retry: false,
      can_cancel: true,
      result_href: `/my-books?bookId=${BOOK_ID}`,
    });
    const mockService: GlobalTasksService = {
      listTasks: vi
        .fn()
        .mockResolvedValue(makeTaskFeed([adminFailed, parentRunning])),
      createTask: vi.fn(),
      retryTask: vi.fn().mockResolvedValue({
        task: makeTask({ id: "task-admin-failed", status: "QUEUED" }),
        action: "retried",
        deduplicated: false,
        message_vi: "Đã xếp lịch chạy lại.",
      } satisfies GlobalTaskActionResponse),
      cancelTask: vi.fn().mockResolvedValue({
        task: makeTask({
          id: "task-parent-running",
          status: "CANCEL_REQUESTED",
        }),
        action: "cancel_requested",
        deduplicated: false,
        message_vi: "Đã gửi yêu cầu hủy.",
      } satisfies GlobalTaskActionResponse),
      getCapabilities: vi.fn(),
    };

    render(<StudioTasksPageScreen service={mockService} viewMode="admin" />);

    expect(
      await screen.findByTestId("studio-task-row-task-admin-failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("studio-task-row-task-parent-running"),
    ).toBeInTheDocument();

    // Filter by status = Thất bại
    const statusGroup = screen.getByRole("group", {
      name: "Lọc tác vụ theo trạng thái",
    });
    await user.click(
      within(statusGroup).getByRole("button", { name: /Thất bại/ }),
    );
    expect(
      screen.getByTestId("studio-task-row-task-admin-failed"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("studio-task-row-task-parent-running"),
    ).not.toBeInTheDocument();

    // Retry failed task
    await user.click(
      within(screen.getByTestId("studio-task-row-task-admin-failed")).getByRole(
        "button",
        { name: "Thử lại" },
      ),
    );
    await waitFor(() =>
      expect(mockService.retryTask).toHaveBeenCalledWith("task-admin-failed"),
    );

    // Reset to Tất cả, filter by role = Phụ huynh, then Cancel
    await user.click(
      within(statusGroup).getByRole("button", { name: /Tất cả/ }),
    );
    const roleGroup = screen.getByRole("group", {
      name: "Lọc tác vụ theo vai trò",
    });
    await user.click(
      within(roleGroup).getByRole("button", { name: "Phụ huynh" }),
    );
    const parentRow = screen.getByTestId("studio-task-row-task-parent-running");
    expect(
      within(parentRow).getByRole("link", { name: /Mở sách/ }),
    ).toHaveAttribute("href", `/admin/books/${BOOK_ID}`);
    await user.click(within(parentRow).getByRole("button", { name: "Hủy" }));
    await waitFor(() =>
      expect(mockService.cancelTask).toHaveBeenCalledWith(
        "task-parent-running",
      ),
    );
  });

  it("refreshes AiTaskCenterProvider on viread:tasks-changed & viread:android-resume even when autoSyncOnMount=false, and exposes /studio/tasks drawer link", async () => {
    const listTasks = vi.fn().mockResolvedValue(
      makeTaskFeed([makeTask({ id: "t-resume", actor_role: "parent" })], {
        actor_id: "parent-1",
        actor_role: "parent",
      }),
    );
    const service: GlobalTasksService = {
      listTasks,
      createTask: vi.fn(),
      retryTask: vi.fn(),
      cancelTask: vi.fn(),
      getCapabilities: vi.fn(),
    };

    render(
      <AiTaskCenterProvider
        actorId="parent-1"
        actorRole="parent"
        autoSyncOnMount={false}
        service={service}
      >
        <GlobalTaskCenter variant="header-pill" />
      </AiTaskCenterProvider>,
    );

    // Idle with autoSyncOnMount=false -> 0 fetches on mount
    expect(listTasks).toHaveBeenCalledTimes(0);

    // Emit viread:tasks-changed -> triggers immediate refresh
    await act(async () => {
      emitStudioTasksChanged();
    });
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(1));

    // Dispatch viread:android-resume on document -> triggers immediate refresh
    await act(async () => {
      document.dispatchEvent(new Event("viread:android-resume"));
    });
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));

    // Open drawer -> verify link to /studio/tasks
    fireEvent.click(screen.getByTestId("global-task-center-trigger"));
    expect(
      screen.getByTestId("global-task-center-full-page-link"),
    ).toHaveAttribute("href", "/studio/tasks");
  });

  it("rehydrates active server-side book OCR jobs in AdminPageUploader from GET /studio/tasks after reload", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/health")) {
        return Response.json({ ocr: { ready: true } });
      }
      if (url.includes("/studio/tasks")) {
        return Response.json(
          makeTaskFeed([
            makeTask({
              id: "server-ocr-job-1",
              source: "ocr_inference_job",
              job_type: "BATCH_BOOK_IMPORT",
              title_vi: "OCR 5 trang đang chạy trên máy chủ",
              book_id: BOOK_ID,
              status: "RUNNING",
              progress_completed: 2,
              progress_total: 5,
              progress_pct: 40,
              is_indeterminate: false,
            }),
          ]),
        );
      }
      return Response.json([]);
    });

    render(
      <AdminServicesProvider>
        <AdminPageUploader bookId={BOOK_ID} onUploaded={vi.fn()} />
      </AdminServicesProvider>,
    );

    const rehydrated = await screen.findByTestId("rehydrated-server-tasks");
    expect(rehydrated).toHaveTextContent("OCR 5 trang đang chạy trên máy chủ");
    expect(rehydrated).toHaveTextContent("2/5 (40%)");
    expect(
      within(rehydrated).getByRole("link", { name: /Mở trung tâm tác vụ/ }),
    ).toHaveAttribute("href", "/admin/tasks");
  });

  it("wires SmartOcrBlockReview apply-to-draft to POST /studio/pages/{pageId}/ocr-extraction/apply-to-draft and disables when VERIFIED", async () => {
    const user = userEvent.setup();
    const onApplyToDraft = vi.fn();

    fetchMock.mockResolvedValueOnce(
      Response.json({
        page_id: PAGE_1_ID,
        revision_id: REV_1_ID,
        applied_word_count: 4,
        canonical_text: "Mèo con đi học.",
        status: "APPLIED",
      }),
    );

    const { rerender } = render(
      <SmartOcrBlockReview
        extraction={makeExtractionFixture()}
        isRevisionVerified={false}
        onApplyToDraft={onApplyToDraft}
        pageId={PAGE_1_ID}
        pageRevisionId={REV_1_ID}
      />,
    );

    const applyBtn = screen.getByTestId("apply-ocr-to-draft-btn");
    expect(applyBtn).toBeEnabled();
    await user.click(applyBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://127.0.0.1:8000/studio/pages/${PAGE_1_ID}/ocr-extraction/apply-to-draft`,
        expect.objectContaining({ method: "POST" }),
      );
      expect(onApplyToDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          page_id: PAGE_1_ID,
          revision_id: REV_1_ID,
          applied_word_count: 4,
          status: "APPLIED",
        }),
      );
    });
    expect(
      screen.getByText(/Đã áp dụng văn bản sạch \(4 từ\)/),
    ).toBeInTheDocument();

    // Direct service helper smoke check
    fetchMock.mockResolvedValueOnce(
      Response.json({
        page_id: PAGE_1_ID,
        revision_id: REV_1_ID,
        applied_word_count: 4,
        canonical_text: "Mèo con đi học.",
        status: "APPLIED",
      }),
    );
    const directRes = await applyPageOcrExtractionToDraft(PAGE_1_ID);
    expect(directRes.status).toBe("APPLIED");

    // Disabled when revision is VERIFIED
    rerender(
      <SmartOcrBlockReview
        extraction={makeExtractionFixture()}
        isRevisionVerified
        onApplyToDraft={onApplyToDraft}
        pageId={PAGE_1_ID}
        pageRevisionId={REV_1_ID}
      />,
    );
    expect(screen.getByTestId("apply-ocr-to-draft-btn")).toBeDisabled();
  });

  it("supports Extract, 0 VND AI Generate, Text-Free badge, and Approve/Reject moderation in PageIllustrationStudio", async () => {
    const user = userEvent.setup();
    const assetsService = makeMockAssetsService();
    const onAssetChanged = vi.fn();
    const taskEvents: Event[] = [];
    const listener = (ev: Event) => taskEvents.push(ev);
    window.addEventListener(STUDIO_TASKS_CHANGED_EVENT, listener);

    fetchMock.mockResolvedValue(
      new Response("webp-illustration", {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      }),
    );

    render(
      <PageIllustrationStudio
        actorRole="admin"
        autoLoad
        bookId={BOOK_ID}
        canonicalText="Mèo con đi học."
        onAssetChanged={onAssetChanged}
        pageId={PAGE_1_ID}
        pageNumber={1}
        service={assetsService}
      />,
    );

    await waitFor(() =>
      expect(assetsService.getBookAssets).toHaveBeenCalledWith(
        BOOK_ID,
        expect.any(AbortSignal),
      ),
    );

    // Extract from page
    await user.click(screen.getByTestId("extract-illustration-btn"));
    await waitFor(() =>
      expect(assetsService.extractPageIllustration).toHaveBeenCalledWith(
        BOOK_ID,
        PAGE_1_ID,
        expect.objectContaining({
          canonical_text: "Mèo con đi học.",
          apply_clahe_restore: true,
        }),
      ),
    );
    expect(screen.getByTestId("text-free-badge")).toHaveTextContent(
      "Đã xác minh sạch chữ",
    );

    // Approve illustration
    await user.click(screen.getByTestId("approve-illustration-btn"));
    await waitFor(() =>
      expect(assetsService.moderatePageIllustration).toHaveBeenCalledWith(
        BOOK_ID,
        PAGE_1_ID,
        ASSET_ID,
        "APPROVE",
      ),
    );
    expect(
      screen.getByTestId("illustration-moderation-badge"),
    ).toHaveTextContent("Đã duyệt hiển thị cho bé");

    // Reject illustration
    await user.click(screen.getByTestId("reject-illustration-btn"));
    await waitFor(() =>
      expect(assetsService.moderatePageIllustration).toHaveBeenCalledWith(
        BOOK_ID,
        PAGE_1_ID,
        ASSET_ID,
        "REJECT",
      ),
    );
    expect(
      screen.getByTestId("illustration-moderation-badge"),
    ).toHaveTextContent("Đã từ chối");

    // AI Generate via 0 VND router
    await user.type(
      screen.getByLabelText("Gợi ý cảnh cho tranh minh họa AI"),
      "Mèo con đeo cặp đi học",
    );
    await user.click(screen.getByTestId("generate-illustration-btn"));
    await waitFor(() =>
      expect(assetsService.generatePageIllustration).toHaveBeenCalledWith(
        BOOK_ID,
        PAGE_1_ID,
        { prompt_hint: "Mèo con đeo cặp đi học" },
      ),
    );
    expect(
      screen.getByText(/Đã xếp hàng tạo tranh minh họa AI miễn phí/),
    ).toBeInTheDocument();

    expect(taskEvents.length).toBeGreaterThanOrEqual(4);
    expect(onAssetChanged).toHaveBeenCalled();
    window.removeEventListener(STUDIO_TASKS_CHANGED_EVENT, listener);
  });

  it("disables Approve in PageIllustrationStudio when text_free_verified is false", async () => {
    const assetsService = makeMockAssetsService({
      getBookAssets: vi.fn().mockResolvedValue(
        makeSummary({
          page_illustrations: [
            makeAsset({
              text_free_verified: false,
              moderation_status: "PENDING",
            }),
          ],
        }),
      ),
    });

    fetchMock.mockResolvedValue(
      new Response("webp", {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      }),
    );

    render(
      <PageIllustrationStudio
        actorRole="parent"
        autoLoad
        bookId={BOOK_ID}
        pageId={PAGE_1_ID}
        service={assetsService}
      />,
    );

    expect(await screen.findByTestId("text-free-badge")).toHaveTextContent(
      "Chưa đạt sạch chữ",
    );
    expect(screen.getByTestId("approve-illustration-btn")).toBeDisabled();
  });

  it("BookPageViewer renders localized switcher tabs with >=44px touch targets", () => {
    render(
      <BookPageViewer
        currentWordId="w-0"
        illustrationTextFree
        illustrationUrl="https://example.test/art.webp"
        page={makeReadingPage()}
      />,
    );
    const tabs = within(
      screen.getByTestId("reading-mode-switcher"),
    ).getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(tab.className).toContain("min-h-11");
    }
  });
});
