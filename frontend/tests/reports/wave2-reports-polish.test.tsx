import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { DifficultWordBookCard } from "@/components/reports/difficult-word-book-card";
import { ProgressReportScreen } from "@/components/reports/progress-report-screen";
import type { DifficultWordBookGroup, DifficultWordDTO } from "@/types/reports";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const CHILD_ID = "10000000-0000-4000-8000-000000000001";
const BOOK_ID = "20000000-0000-4000-8000-000000000001";
const MISSING_CHILD_ID = "99999999-9999-4999-8999-999999999999";

const sampleWord: DifficultWordDTO = {
  normalized_word: "hoa",
  display_text: "hoa",
  difficulty_score: 3,
  omission_count: 1,
  repetition_count: 0,
  long_pause_count: 0,
  read_example_count: 0,
  session_count: 1,
  last_seen_at: "2026-11-27T10:00:00Z",
  evidence_word_ids: [BOOK_ID],
  practice_status: "COMPLETED",
};

const sampleGroup: DifficultWordBookGroup = {
  key: BOOK_ID,
  bookId: BOOK_ID,
  bookTitle: "Chào ngày mới",
  bookAuthor: "Minh Anh",
  bookCoverUrl: null,
  minGrade: 1,
  maxGrade: 2,
  latestSeenAt: "2026-11-27T10:00:00Z",
  totalWords: 2,
  completedWords: 1,
  progressPercent: 50,
  words: [
    sampleWord,
    {
      ...sampleWord,
      normalized_word: "nắng",
      display_text: "nắng",
      practice_status: "NOT_PRACTICED",
    },
  ],
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Wave 2 reports UX and accessibility polish", () => {
  it("renders loadErrorDescription when loading children fails", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ detail: "upstream 500" }, { status: 500 }),
    );

    render(
      <AppServicesProvider>
        <ProgressReportScreen />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByText("Chưa tải được báo cáo"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Dữ liệu không tồn tại, không thuộc tài khoản hiện tại hoặc chưa tải được.",
      ),
    ).not.toBeInTheDocument();
  });

  it("preserves notFoundDescription when a requested child returns 404", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/profiles/children")) {
        return Response.json([
          {
            id: CHILD_ID,
            parent_id: BOOK_ID,
            alias: "Bé An",
            grade: 1,
            settings: {},
            created_at: "2026-11-01T00:00:00Z",
          },
        ]);
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    });

    render(
      <AppServicesProvider>
        <ProgressReportScreen requestedChildId={MISSING_CHILD_ID} />
      </AppServicesProvider>,
    );

    expect(
      await screen.findByText("Không tìm thấy báo cáo"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Dữ liệu không tồn tại, không thuộc tài khoản hiện tại hoặc chưa tải được.",
      ),
    ).toBeInTheDocument();
  });

  it("renders accessible role=progressbar on DifficultWordBookCard", () => {
    render(
      <DifficultWordBookCard
        group={sampleGroup}
        onSelectWord={vi.fn()}
        onStartBookPractice={vi.fn()}
      />,
    );

    const progressBar = screen.getByRole("progressbar", {
      name: "Chào ngày mới — Đã luyện đúng 1/2 từ",
    });
    expect(progressBar).not.toHaveAttribute("aria-hidden");
    expect(progressBar).toHaveAttribute("aria-valuenow", "50");
    expect(progressBar).toHaveAttribute("aria-valuemin", "0");
    expect(progressBar).toHaveAttribute("aria-valuemax", "100");
    expect(progressBar).toHaveAttribute("aria-valuetext", "50%");
    expect(screen.getByText("50%")).toBeInTheDocument();
  });
});
