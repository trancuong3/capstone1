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

import {
  AuthRuntimeContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import { BookCoverStudio } from "@/components/books/book-cover-studio";
import { ParentMyBooksScreen } from "@/components/books/parent-my-books-screen";
import { ParentPrivateBookManager } from "@/components/books/parent-private-book-manager";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { StudioTasksPageScreen } from "@/components/tasks/studio-tasks-page-screen";
import type { BookAssetsService } from "@/lib/api/book-assets-service";
import type { GlobalTasksService } from "@/lib/api/global-tasks-service";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  bookFixture,
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import type {
  ParentPageSubmissionDTO,
  ParentPrivateBookDetailDTO,
  ParentPrivateBookSummaryDTO,
} from "@/types/parent-private-book";

const { pushMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "parent-mobile-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

function installMobileMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const originalMatchMedia = window.matchMedia;

const BOOK_ID = "aa000000-0000-4000-8000-000000000001";
const SUB_ID_1 = "bb000000-0000-4000-8000-000000000001";
const SUB_ID_2 = "bb000000-0000-4000-8000-000000000002";
const BATCH_ID = "cc000000-0000-4000-8000-000000000001";
const NOW = "2026-11-28T03:00:00Z";

function makeAuthRuntime(userId = "parent-1"): AuthRuntimeState {
  return {
    initializationFailure: null,
    isPasswordRecovery: false,
    lastEvent: "SIGNED_IN",
    mode: "supabase",
    status: "ready",
    session: {
      expires_at: null,
      user: {
        id: userId,
        email: `${userId}@example.test`,
        display_name: "Phụ huynh Mobile",
      },
    },
  };
}

const privateBookSummary: ParentPrivateBookSummaryDTO = {
  id: BOOK_ID,
  title: "Truyện Riêng Nhà An",
  author: "Gia đình bé An",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
  visibility_scope: "PARENT_PRIVATE",
  moderation_status: "ACTIVE",
  suspended_reason: null,
  source_declaration: "Sách giấy gia đình mua",
  committed_page_count: 1,
  pending_submission_count: 0,
  flagged_submission_count: 0,
  failed_submission_count: 0,
  ready_to_add_count: 2,
  readable_for_children: true,
  has_held_multipage_batch: false,
  privacy_notice: "Chỉ gia đình xem được.",
  created_at: NOW,
};

function makeSubmission(
  id: string,
  pageNumber: number,
): ParentPageSubmissionDTO {
  return {
    id,
    book_id: BOOK_ID,
    batch_id: BATCH_ID,
    batch_total_pages: 2,
    source_page_number: pageNumber,
    target_page_number: null,
    source_file_name: "truyen.pdf",
    source_format: "PDF",
    image_width: 400,
    image_height: 300,
    image_url: `/media/submissions/${id}.png`,
    source_type: "OWNED_PHYSICAL_BOOK",
    source_type_label: "Sách giấy gia đình sở hữu",
    source_note: null,
    submission_version: 1,
    optimistic_lock_version: 1,
    workflow_status: "PASSED_READY_TO_ADD",
    workflow_status_label: "Đạt — sẵn sàng thêm vào sách",
    ocr_status: "COMPLETED",
    ocr_text: `Nội dung trang ${pageNumber}`,
    ocr_error_code: null,
    is_image_only: false,
    proofread_status: "COMPLETED",
    proofread_text: `Nội dung trang ${pageNumber}`,
    proofread_suggestions: [],
    uncertain_word_indices: [],
    proofread_error_code: null,
    spelling_accepted: true,
    candidate_text: `Nội dung trang ${pageNumber}`,
    candidate_hash: "1".repeat(64),
    tool_check_status: "PASSED",
    tool_check_suitability: "SUITABLE",
    tool_check_scope: {
      modality: "TEXT_ONLY",
      covers_all_chunks: true,
      chunks_checked: 1,
      total_chunks: 1,
      image_visual_safety_checked: false,
      requires_admin_visual_review: false,
      copyright_scanner_status: "UNAVAILABLE",
      local_ai_enforced: false,
    },
    tool_check_findings_count: 0,
    tool_check_parent_notice: null,
    tool_check_policy_blocked: false,
    tool_check_workflow_id: null,
    tool_check_error_code: null,
    provider_events: [],
    can_add_to_book: true,
    can_request_admin_review: false,
    can_retry: false,
    admin_decision: null,
    admin_decision_reason: null,
    approved_snapshot_hash: null,
    approved_submission_version: null,
    committed_page_id: null,
    committed_revision_id: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

const privateBookDetail: ParentPrivateBookDetailDTO = {
  book: {
    ...privateBookSummary,
    privacy_notice: "Chỉ gia đình xem được.",
  },
  pages: [],
  submissions: [makeSubmission(SUB_ID_1, 1), makeSubmission(SUB_ID_2, 2)],
};

beforeEach(() => {
  installMobileMatchMedia();
  installApiFetchFixture();
  pushMock.mockReset();
  replaceMock.mockReset();
});

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: originalMatchMedia,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("F11 mobile screens (< 768px) & /studio/tasks refresh stability", () => {
  it("renders ParentMyBooksScreen with 2-col stats, >= 44px controls, and bottom-sheet Create/Delete modals", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/books/my-books/paged") {
        return Response.json({
          items: [privateBookSummary],
          total: 1,
          limit: 9,
          offset: 0,
        });
      }
      if (url.pathname === "/books/my-books") {
        return Response.json([privateBookSummary]);
      }
      throw new Error(`Unexpected route: ${url.pathname}`);
    });

    const user = userEvent.setup();
    const { container } = render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime()}>
        <AppServicesProvider>
          <ParentMyBooksScreen />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(
      await screen.findByText(privateBookSummary.title),
    ).toBeInTheDocument();

    // 2-column stats grid instead of cramped 4-column strip
    const dl = container.querySelector("dl");
    expect(dl?.className).toContain("grid-cols-2");
    expect(dl?.className).not.toContain("grid-cols-4");

    // >= 44px controls
    expect(screen.getByRole("button", { name: "Tải lại" }).className).toContain(
      "min-h-11",
    );
    expect(
      screen.getByRole("button", { name: "Tạo sách riêng" }).className,
    ).toContain("min-h-11");
    expect(
      screen.getByRole("link", { name: "Quản lý & thêm trang" }).className,
    ).toContain("min-h-11");
    expect(
      screen.getByRole("link", { name: "Mở đọc cùng bé" }).className,
    ).toContain("min-h-11");

    // Create book opens bottom-sheet Modal with single-mounted form
    await user.click(screen.getByRole("button", { name: "Tạo sách riêng" }));
    const createDialog = await screen.findByRole("dialog", {
      name: "Thông tin sách riêng mới",
    });
    expect(createDialog.className).toContain("rounded-t-[20px]");
    expect(
      screen.getAllByRole("form", { name: "Tạo sách riêng mới" }),
    ).toHaveLength(1);
    await user.click(within(createDialog).getByRole("button", { name: "Hủy" }));

    // Delete book opens alertdialog bottom sheet
    await user.click(
      screen.getByRole("button", {
        name: `Xóa sách ${privateBookSummary.title}`,
      }),
    );
    const deleteDialog = await screen.findByRole("alertdialog");
    expect(deleteDialog.className).toContain("rounded-t-[20px]");
  });

  it("renders ParentPrivateBookManager with >= 44px touch targets, collapsible overview, and in-article submission commit action", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/books/my-books/${BOOK_ID}`) {
        return Response.json(privateBookDetail);
      }
      if (url.pathname === "/ocr/worker-health") {
        return Response.json({ worker_online: true });
      }
      if (
        url.pathname === `/studio/books/${BOOK_ID}/cover` ||
        url.pathname === `/books/my-books/${BOOK_ID}/cover`
      ) {
        return Response.json({ book_id: BOOK_ID, asset: null });
      }
      throw new Error(`Unexpected route: ${url.pathname}`);
    });

    const { container } = render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime()}>
        <AppServicesProvider>
          <ParentPrivateBookManager bookId={BOOK_ID} />
        </AppServicesProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(
      await screen.findByRole("heading", { name: privateBookSummary.title }),
    ).toBeInTheDocument();

    for (const control of [
      screen.getByRole("link", { name: "Quay lại Sách của tôi" }),
      screen.getByRole("button", { name: "Làm mới trạng thái" }),
      screen.getByRole("link", { name: "Mở đọc cùng bé" }),
      screen.getByRole("link", { name: "Trung tâm tác vụ" }),
      screen.getByRole("button", { name: "Đổi ảnh bìa" }),
      screen.getByRole("button", { name: "Sửa sách" }),
      screen.getByRole("button", {
        name: `Xóa sách ${privateBookSummary.title}`,
      }),
    ]) {
      expect(control.className).toContain("min-h-11");
    }

    // Overview jump chips collapsed in <details> on mobile
    const overviewDetails = container.querySelector("details");
    expect(overviewDetails).not.toBeNull();

    // Commit action remains inside article[data-submission-id]
    const subCard = container.querySelector(
      `article[data-submission-id="${SUB_ID_1}"]`,
    ) as HTMLElement | null;
    expect(subCard).not.toBeNull();
    const commitBtn = within(subCard!).getByRole("button", {
      name: "Thêm trang vào sách",
    });
    expect(commitBtn.className).toContain("min-h-11");
  });

  it("renders ReadingManagementScreen without .reading-organizer or !important hacks and keeps >= 44px mobile controls", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/profiles/children") {
        return Response.json([childFixture]);
      }
      if (path === "/books/catalog") {
        return Response.json([bookFixture]);
      }
      if (path === "/reading-management/plans") {
        return Response.json([]);
      }
      if (path === "/reading-management/goals") {
        return Response.json([]);
      }
      if (path === "/reading-management/collections") {
        return Response.json([]);
      }
      if (path === "/reading-management/reminders") {
        return Response.json([
          {
            id: "ff000000-0000-4000-8000-000000000001",
            child_id: TEST_CHILD_ID,
            remind_at: "19:30:00",
            timezone: "Asia/Ho_Chi_Minh",
            weekdays: [0, 2, 4],
            is_active: true,
            email_enabled: false,
            deleted_at: null,
            created_at: NOW,
            updated_at: NOW,
          },
        ]);
      }
      if (path === "/reading-management/reminders/due") {
        return Response.json([]);
      }
      throw new Error(`Unexpected route: ${path}`);
    });

    const user = userEvent.setup();
    const { container } = render(
      <AppServicesProvider>
        <ReadingManagementScreen />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByRole("button", { name: "Thêm kế hoạch" }),
    ).toBeInTheDocument();

    expect(container.querySelector(".reading-organizer")).toBeNull();

    // Zero !important utility hacks anywhere in buttons
    const allButtons = Array.from(container.querySelectorAll("button"));
    for (const button of allButtons) {
      expect(button.className).not.toContain("!");
    }

    expect(screen.getByRole("button", { name: "Tải lại" }).className).toContain(
      "min-h-11",
    );
    expect(
      screen.getByRole("button", { name: "Thêm kế hoạch" }).className,
    ).toContain("min-h-11");
    expect(
      screen.getByRole("button", { name: "Thêm mục tiêu" }).className,
    ).toContain("min-h-11");
    expect(
      screen.getByRole("button", { name: "Thêm lịch nhắc" }).className,
    ).toContain("min-h-11");

    const reminderCard = container.querySelector(
      'article[data-reminder-id="ff000000-0000-4000-8000-000000000001"]',
    ) as HTMLElement | null;
    expect(reminderCard).not.toBeNull();
    expect(
      within(reminderCard!).getByRole("button", { name: "Chỉnh sửa" })
        .className,
    ).toContain("min-h-11");
    expect(
      within(reminderCard!).getByRole("button", { name: "Xóa" }).className,
    ).toContain("min-h-11");

    // Clicking "Thêm kế hoạch" still opens .figma-form-page cleanly
    await user.click(screen.getByRole("button", { name: "Thêm kế hoạch" }));
    expect(container.querySelector(".figma-form-page")).not.toBeNull();
  });

  it("renders BookScannerScreen idle actions with full-width >= 44px mobile buttons", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/ocr/worker-health") {
        return Response.json({ worker_online: true });
      }
      if (path === "/ocr/scan-jobs") {
        return Response.json({ jobs: [] });
      }
      throw new Error(`Unexpected route: ${path}`);
    });

    render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookScannerScreen />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    const cameraBtn = await screen.findByRole("button", {
      name: /Bật camera để quét/i,
    });
    expect(cameraBtn.className).toContain("min-h-14");
    expect(cameraBtn.className).toContain("w-full");
  });

  it("mounts StudioTasksPageScreen inside AiTaskCenterProvider without an infinite GET /studio/tasks refresh loop", async () => {
    const listTasksMock = vi.fn<GlobalTasksService["listTasks"]>(async () => ({
      actor_id: "parent-1",
      actor_role: "parent",
      tasks: [
        {
          id: "task-1",
          source: "ocr_inference_job",
          actor_role: "parent",
          job_type: "OCR_EXTRACT",
          title_vi: "Quét trang sách",
          status: "SUCCEEDED",
          status_label_vi: "Hoàn tất",
          stage: "COMPLETED",
          stage_label_vi: "Hoàn tất",
          priority: 0,
          book_id: BOOK_ID,
          book_title: "Truyện Riêng Nhà An",
          book_page_id: null,
          page_number: 1,
          source_revision_id: null,
          progress_completed: 1,
          progress_total: 1,
          progress_pct: 100,
          progress_unit: "trang",
          is_indeterminate: false,
          attempt_count: 1,
          max_attempts: 3,
          can_retry: false,
          can_cancel: false,
          result_href: `/my-books/${BOOK_ID}`,
          result_ref: {},
          checkpoints: {},
          error_code: null,
          error_message_vi: null,
          started_at: NOW,
          completed_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      active_count: 0,
      waiting_review_count: 0,
      failed_count: 0,
      completed_count: 1,
      worker_online: true,
      recommended_poll_ms: 4000,
    }));

    const mockService: GlobalTasksService = {
      listTasks: listTasksMock,
      retryTask: vi.fn(),
      cancelTask: vi.fn(),
      createTask: vi.fn(),
      getCapabilities: vi.fn(),
    };

    render(
      <AiTaskCenterProvider
        actorId="parent-1"
        actorRole="parent"
        autoSyncOnMount
        service={mockService}
      >
        <StudioTasksPageScreen viewMode="parent" />
      </AiTaskCenterProvider>,
    );

    expect(
      await screen.findByTestId("studio-task-row-task-1"),
    ).toBeInTheDocument();

    const callsAfterMount = listTasksMock.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThanOrEqual(1);
    expect(callsAfterMount).toBeLessThanOrEqual(2);

    // Wait 150ms to prove no infinite abort-and-refetch loop occurs when contextValue updates
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(listTasksMock.mock.calls.length).toBe(callsAfterMount);

    const refreshBtn = screen.getByRole("button", { name: "Làm mới" });
    await waitFor(() => expect(refreshBtn).not.toBeDisabled());
    expect(refreshBtn.className).toContain("min-h-11");

    const resultLink = screen.getByRole("link", { name: "Xem kết quả" });
    expect(resultLink.className).toContain("min-h-11");
    expect(resultLink.className).toContain("w-full");
  });

  it("renders BookCoverStudio CUSTOM crop sliders and labels with >= 44px (min-h-11) mobile touch targets", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue(
      "blob:mobile-cover-preview",
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const assetsService: BookAssetsService = {
      getBookAssets: vi.fn().mockResolvedValue({
        book_id: BOOK_ID,
        effective_cover_source: "METADATA_RENDER",
        active_cover: null,
        metadata_fallback: {
          title: privateBookSummary.title,
          author: privateBookSummary.author,
          grade_label: "Lớp 1–3",
        },
        style_bible: null,
        ai_image_provider_available: false,
        ai_image_provider_name: null,
        ai_image_provider_message_vi:
          "Chưa cấu hình nhà cung cấp tạo ảnh AI miễn phí.",
        page_assets: [],
      }),
      uploadCover: vi.fn(),
      deleteCover: vi.fn(),
      generateAiCover: vi.fn(),
      buildStyleBible: vi.fn(),
      extractPageIllustration: vi.fn(),
      generatePageIllustration: vi.fn(),
      moderatePageIllustration: vi.fn(),
    };

    const user = userEvent.setup();
    render(
      <BookCoverStudio
        actorRole="parent"
        autoLoad
        bookId={BOOK_ID}
        bookTitle={privateBookSummary.title}
        service={assetsService}
      />,
    );

    await waitFor(() => {
      expect(assetsService.getBookAssets).toHaveBeenCalledWith(
        BOOK_ID,
        expect.any(AbortSignal),
      );
    });

    const galleryInput = screen.getByTestId("cover-gallery-input");
    const file = new File(["cover-bytes"], "bia.png", { type: "image/png" });
    fireEvent.change(galleryInput, { target: { files: [file] } });

    expect(
      await screen.findByTestId("cover-crop-rotate-panel"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tùy chỉnh" }));

    for (const label of [
      "Vị trí cắt ngang",
      "Vị trí cắt dọc",
      "Kích thước khung cắt",
    ]) {
      const slider = screen.getByRole("slider", { name: label });
      expect(slider).toHaveAttribute("type", "range");
      expect(slider.className).toContain("min-h-11");
      expect(slider.className).not.toContain("!");
      expect(slider.closest("label")?.className).toContain("min-h-11");
    }

    fireEvent.change(screen.getByRole("slider", { name: "Vị trí cắt ngang" }), {
      target: { value: "15" },
    });
    expect(screen.getByText("Dịch ngang (15%)")).toBeInTheDocument();
  });
});
