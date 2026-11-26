import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import type { AdminAiWorkflowDTO } from "@/lib/api/ocr-review-service";
import { ServiceError } from "@/lib/api/service-error";
import {
  ADMIN_BOOK_ID,
  ADMIN_PAGE_ID,
  ADMIN_R2_ID,
  adminR2Fixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type { AdminPageRevisionDetailDTO } from "@/types/admin";

let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => currentSearchParams,
  };
});

function makeEditableDetail(): AdminPageRevisionDetailDTO {
  const tokens = ["Mèo", "con", "ngủ"];
  return {
    ...adminR2Fixture,
    verification_status: "NEEDS_REVIEW",
    draft_text: tokens.join(" "),
    words: tokens.map((text, index) => ({
      word_index: index,
      line_index: 0,
      text,
      normalized_text: text.toLocaleLowerCase("vi"),
      bbox: [0.1 + index * 0.15, 0.1, 0.1, 0.04] as const,
      ocr_confidence: 0.9,
    })),
  };
}

function makeReadyWorkflow(text: string): AdminAiWorkflowDTO {
  const hash = "d".repeat(64);
  return {
    workflow_id: "85000000-0000-4000-8000-000000000099",
    page_id: ADMIN_PAGE_ID,
    book_id: ADMIN_BOOK_ID,
    page_revision_id: ADMIN_R2_ID,
    status: "READY_FOR_ADMIN_REVIEW",
    stage: "READY_FOR_ADMIN_REVIEW",
    progress: { completed_chunks: 1, total_chunks: 1 },
    attempts: 1,
    error_code: null,
    original_ocr_hash: "a".repeat(64),
    admin_input_hash: "b".repeat(64),
    proofread_text: text,
    proofread_output_hash: hash,
    corrections: [],
    uncertain_word_indices: [],
    proofread_metadata: {},
    safety_metadata: {},
    candidate_history: [],
    safety_history: [],
    review_history: [],
    candidate_text: text,
    candidate_hash: hash,
    candidate_version: 1,
    safety_input_hash: hash,
    hash_match: true,
    suitability: "SUITABLE",
    safety_status: "PROVISIONAL",
    findings: [],
    provider_events: [],
    ocr_approved_at: null,
    final_approved_text_hash: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

describe("AdminOcrReviewScreen Wave 1 P0 regressions", () => {
  beforeEach(() => {
    currentSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears candidateEditPending when updateWorkflowCandidate fails so it never loops every 600ms", async () => {
    const services = createAdminServiceFixture();
    const detail = makeEditableDetail();
    const wf = makeReadyWorkflow(detail.draft_text ?? "");
    services.ocr.getRevision.mockResolvedValue(detail);
    services.ocr.getLatestWorkflow.mockResolvedValue(wf);
    services.ocr.updateWorkflowCandidate.mockRejectedValue(
      new ServiceError({
        code: "SESSION_STATE_INVALID",
        message: "candidate version conflict",
        status: 409,
        request_id: "req-409",
        retryable: false,
      }),
    );

    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const textarea = await screen.findByLabelText("Nội dung trang");
    await waitFor(() =>
      expect(services.ocr.getLatestWorkflow).toHaveBeenCalledTimes(1),
    );

    // Switch to fake timers BEFORE triggering edit so debounce is deterministic
    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "Mèo con ăn" } });

    // First 600ms debounce fires updateWorkflowCandidate once, rejects, and fetches latest workflow
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(services.ocr.updateWorkflowCandidate).toHaveBeenCalledTimes(1);

    // Advance 3 more seconds: MUST NOT re-trigger updateWorkflowCandidate in a 600ms infinite loop!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(services.ocr.updateWorkflowCandidate).toHaveBeenCalledTimes(1);
  });

  it("adds a single-token default word ('Từ') in words view without desyncing and flags candidateEditPending", async () => {
    currentSearchParams = new URLSearchParams("view=words");
    const services = createAdminServiceFixture();
    const detail = makeEditableDetail();
    const wf = makeReadyWorkflow(detail.draft_text ?? "");
    services.ocr.getRevision.mockResolvedValue(detail);
    services.ocr.getLatestWorkflow.mockResolvedValue(wf);
    services.ocr.updateWorkflowCandidate.mockResolvedValue({
      ...wf,
      candidate_version: 2,
      candidate_text: "Mèo con ngủ Từ",
    });

    render(
      withAdminFixture(
        <AdminOcrReviewScreen bookId={ADMIN_BOOK_ID} pageId={ADMIN_PAGE_ID} />,
        services,
      ),
    );

    const addWordBtn = await screen.findByRole("button", {
      name: /Thêm từ/i,
    });
    await waitFor(() =>
      expect(services.ocr.getLatestWorkflow).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(addWordBtn);

    // New word input has single token "Từ" (NOT two-token "Từ mới") and NO word sync error
    const wordInputs = screen.getAllByLabelText(/^Từ \d+ \(di động\)$/);
    expect(wordInputs).toHaveLength(4);
    expect((wordInputs[3] as HTMLInputElement).value).toBe("Từ");
    expect(
      screen.queryByText(/Không thể đồng bộ văn bản/i),
    ).not.toBeInTheDocument();

    // Because candidateEditPending was set to true, debounced updateWorkflowCandidate runs with the 4-word text
    await waitFor(
      () => {
        expect(services.ocr.updateWorkflowCandidate).toHaveBeenCalledWith(
          ADMIN_PAGE_ID,
          wf.workflow_id,
          wf.candidate_version,
          "Mèo con ngủ Từ",
        );
      },
      { timeout: 2_000 },
    );
  });
});
