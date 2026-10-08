import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionHistoryScreen } from "@/components/reports/session-history-screen";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
import { ProgressReportScreen } from "@/components/reports/progress-report-screen";
import { DifficultWordsScreen } from "@/components/reports/difficult-words-screen";
import { DifficultWordItem } from "@/components/reports/difficult-word-item";

vi.mock("next/navigation", () => ({
  usePathname: () => "/sessions",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const childId = "22222222-2222-4222-8222-222222222222";
const sessionId = "44444444-4444-4444-8444-444444444444";
const bookId = "33333333-3333-4333-8333-333333333333";
const child = {
  id: childId,
  parent_id: bookId,
  alias: "Bé từ API",
  grade: 2,
  settings: {},
  created_at: "2026-10-08T00:00:00Z",
};
const book = {
  id: bookId,
  title: "Sách lịch sử đã ngừng phát hành",
  author: null,
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "RETIRED",
};
const summary = {
  id: sessionId,
  child_id: childId,
  book_id: bookId,
  state: "ABORTED",
  started_at: "2026-10-08T01:00:00Z",
  ended_at: null,
  duration_ms: null,
};
const detail = {
  ...summary,
  selected_page_revision_ids: [],
  reference_page_revision_ids: [],
  events: [],
  fluency_assessment: null,
  comprehension: [],
  report_id: null,
};
const word = {
  normalized_word: "meo",
  display_text: "Mèo API",
  difficulty_score: 3,
  omission_count: 1,
  repetition_count: 0,
  long_pause_count: 0,
  read_example_count: 0,
  session_count: 1,
  last_seen_at: "2026-10-08T01:00:00Z",
  evidence_word_ids: [bookId],
};
const fetchMock = vi.fn();

function readyResponse(url: string): Response {
  if (url.includes("/profiles/children/")) return Response.json(child);
  if (url.includes("/profiles/children")) return Response.json([child]);
  if (url.endsWith("/book")) return Response.json(book);
  if (url.includes(`/reading/history/${sessionId}`))
    return Response.json(detail);
  if (url.includes("/reading/history?"))
    return Response.json({ sessions: [summary], next_cursor: "page-2" });
  if (url.includes("/system/difficult-words/")) return Response.json([word]);
  if (url.includes("/system/progress/")) {
    const query = new URL(url).searchParams;
    return Response.json({
      child_id: childId,
      period_start: query.get("period_start"),
      period_end: query.get("period_end"),
      completed_sessions: 2,
      reading_duration_ms: 120000,
      omission_count: 1,
      repetition_count: 0,
      long_pause_count: 0,
      omission_rate: null,
      repetition_rate: null,
      long_pause_rate: null,
      comprehension_accuracy: null,
      difficult_words: [],
      previous_period: null,
      trend_deltas: {
        completed_sessions: null,
        reading_duration_ms: null,
        omission_rate: null,
        repetition_rate: null,
        long_pause_rate: null,
        comprehension_accuracy: null,
      },
    });
  }
  throw new Error("Unexpected test API route");
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => readyResponse(url));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Parent report UI through real adapters and HTTP test doubles", () => {
  it.each([0, -1, 100001, Number.NaN, Number.POSITIVE_INFINITY, 2.5])(
    "uses first page for invalid history page %s without forwarding an invalid cursor",
    async (page) => {
      render(
        <AppServicesProvider>
          <SessionHistoryScreen page={page} />
        </AppServicesProvider>,
      );
      await screen.findByRole("heading", { name: book.title });
      expect(
        fetchMock.mock.calls
          .filter(([url]) => String(url).includes("/reading/history?"))
          .every(([url]) => !new URL(String(url)).searchParams.has("cursor")),
      ).toBe(true);
      expect(
        screen.queryByRole("link", { name: "Trang trước" }),
      ).not.toBeInTheDocument();
    },
  );
  it("shows loading while history has not arrived", async () => {
    let resolveHistory: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveHistory = resolve;
    });
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/reading/history?") ? pending : readyResponse(url),
    );
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} />
      </AppServicesProvider>,
    );
    expect(screen.getByLabelText("Đang tải lịch sử đọc")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/reading/history?"),
        ),
      ).toBe(true),
    );
    resolveHistory(Response.json({ sessions: [], next_cursor: null }));
    expect(
      await screen.findByRole("heading", { name: "Chưa có buổi đọc" }),
    ).toBeInTheDocument();
  });
  it("shows owned history for retired books without requesting current catalog", async () => {
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: book.title }),
    ).toBeInTheDocument();
    expect(screen.getByText("Chưa hoàn tất")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trang sau" })).toHaveAttribute(
      "href",
      `/sessions?childId=${childId}&page=2`,
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/books/catalog"),
      ),
    ).toBe(false);
  });
  it("passes page cursor and shows previous-page navigation", async () => {
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={2} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: book.title });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("cursor=page-2"),
      ),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Trang trước" })).toHaveAttribute(
      "href",
      `/sessions?childId=${childId}&page=1`,
    );
  });
  it("keeps optional details unknown instead of displaying sample metrics", async () => {
    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={sessionId} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Buổi đọc chưa hoàn tất" });
    expect(screen.getByText("Chưa đánh giá")).toBeInTheDocument();
    expect(screen.getAllByText("Chưa ghi nhận")).toHaveLength(2);
    expect(
      screen.getByText("Buổi đọc này chưa có sự kiện để hiển thị."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Buổi đọc này không có câu hỏi đọc hiểu."),
    ).toBeInTheDocument();
    expect(screen.queryByText("0 từ/phút")).not.toBeInTheDocument();
  });
  it("shows actual report counts with missing previous period", async () => {
    render(
      <AppServicesProvider>
        <ProgressReportScreen />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", {
      name: `Cùng nhìn lại hành trình của ${child.alias}`,
    });
    expect(screen.getByText("2 buổi")).toBeInTheDocument();
    expect(screen.getByText("Chưa đủ kỳ so sánh")).toBeInTheDocument();
  });
  it("shows actual stored words", async () => {
    render(
      <AppServicesProvider>
        <DifficultWordsScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: word.display_text }),
    ).toBeInTheDocument();
    expect(screen.getByText("Điểm bằng chứng 3")).toBeInTheDocument();
  });
  it("distinguishes an actual empty word list from unavailable data", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/system/difficult-words/")
        ? Response.json([])
        : readyResponse(url),
    );
    render(
      <AppServicesProvider>
        <DifficultWordsScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Chưa có từ cần luyện" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Dữ liệu đang chờ bổ sung"),
    ).not.toBeInTheDocument();
  });
  it.each([
    ["history", <SessionHistoryScreen key="history" page={1} />],
    ["detail", <SessionDetailScreen key="detail" sessionId={sessionId} />],
    ["progress", <ProgressReportScreen key="progress" />],
    ["words", <DifficultWordsScreen key="words" />],
  ])(
    "shows unavailable and retries %s without runtime fallback",
    async (_name, element) => {
      const user = userEvent.setup();
      fetchMock.mockImplementation(async (url: string) =>
        url.includes("/profiles/children")
          ? readyResponse(url)
          : Response.json({ detail: "private sql token" }, { status: 501 }),
      );
      render(<AppServicesProvider>{element}</AppServicesProvider>);
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: "Dữ liệu đang chờ bổ sung",
        }),
      ).toBeInTheDocument();
      expect(screen.queryByText("private sql token")).not.toBeInTheDocument();
      fetchMock.mockImplementation(async (url: string) => readyResponse(url));
      await user.click(screen.getByRole("button", { name: "Thử lại" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "Dữ liệu đang chờ bổ sung" }),
        ).not.toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(screen.queryByLabelText(/Đang tải/)).not.toBeInTheDocument(),
      );
    },
  );
  it("does not request history for an inaccessible child", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/profiles/children/")
        ? Response.json({}, { status: 404 })
        : readyResponse(url),
    );
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} requestedChildId={bookId} />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByText("Không tìm thấy lịch sử"),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/reading/")),
    ).toBe(false);
  });
  it("no children prompts profile creation without reading reports", async () => {
    fetchMock.mockImplementation(async () => Response.json([]));
    render(
      <AppServicesProvider>
        <ProgressReportScreen />
      </AppServicesProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Chưa có dữ liệu báo cáo" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tạo hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children/new",
    );
    expect(
      fetchMock.mock.calls.every(([url]) =>
        String(url).includes("/profiles/children"),
      ),
    ).toBe(true);
  });
  it("practice never reports mocked success or sends a write request", async () => {
    const user = userEvent.setup();
    render(
      <AppServicesProvider>
        <DifficultWordItem childId={childId} word={word} />
      </AppServicesProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Luyện từ" }));
    expect(
      await screen.findByText(/Chức năng luyện từ chưa sẵn sàng/),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/mô phỏng chữ/)).not.toBeInTheDocument();
  });
});
