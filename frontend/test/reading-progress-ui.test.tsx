import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { ProgressReportScreen } from "@/components/reports/progress-report-screen";
import {
  childFixture as child,
  progressReportFixture as report,
  TEST_CHILD_ID,
  TEST_FOREIGN_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import type { ProgressReportDTO } from "@/types/reports";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
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
const second = { ...child, id: TEST_FOREIGN_CHILD_ID, alias: "Bé thứ hai" };
let current: ProgressReportDTO;
const fetchMock = vi.fn();
const option = {
  id: report.id,
  child_id: TEST_CHILD_ID,
  period_start: report.period_start,
  period_end: report.period_end,
  generated_at: report.generated_at,
};
const older = {
  ...option,
  period_start: "2026-08-01",
  period_end: "2026-08-31",
};
function respond(input: string) {
  const url = new URL(input);
  if (url.pathname === "/profiles/children")
    return Response.json([child, second]);
  if (url.pathname === `/profiles/children/${TEST_CHILD_ID}`)
    return Response.json(child);
  if (url.pathname === `/profiles/children/${TEST_FOREIGN_CHILD_ID}`)
    return Response.json(second);
  if (url.pathname.endsWith("/periods"))
    return Response.json({ items: [option], next_cursor: "page-2" });
  return Response.json({
    ...current,
    child_id: url.pathname.split("/").at(-1),
  });
}
beforeEach(() => {
  current = report;
  navigation.push.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => respond(url));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
function renderReport(
  props: React.ComponentProps<typeof ProgressReportScreen> = {},
) {
  return render(
    <AppServicesProvider>
      <ProgressReportScreen {...props} />
    </AppServicesProvider>,
  );
}

describe("Saved reading progress UI", () => {
  it("opens an older saved latest report, labels its actual period and never promises live aggregation", async () => {
    renderReport();
    expect(
      screen.getByLabelText("Đang tải báo cáo tiến bộ"),
    ).toBeInTheDocument();
    await screen.findByText("4 buổi");
    expect(screen.getByText(/Kỳ: 2026-09-02 → 2026-10-01/)).toBeInTheDocument();
    expect(screen.getByLabelText("Kỳ báo cáo đã lưu")).toHaveValue("latest");
    expect(
      screen.getByText(/không tự tính lại sau mỗi buổi đọc/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lịch sử đọc" })).toHaveAttribute(
      "href",
      `/sessions?childId=${TEST_CHILD_ID}`,
    );
  });
  it("selects an exact period and resets it when switching child", async () => {
    const user = userEvent.setup();
    renderReport({
      requestedPeriodStart: report.period_start,
      requestedPeriodEnd: report.period_end,
    });
    await screen.findByText("4 buổi");
    await user.selectOptions(
      screen.getByLabelText("Kỳ báo cáo đã lưu"),
      "latest",
    );
    expect(navigation.push).toHaveBeenLastCalledWith(
      `/reports?childId=${TEST_CHILD_ID}`,
    );
    await user.selectOptions(
      screen.getByLabelText("Chọn hồ sơ bé để xem dữ liệu"),
      TEST_FOREIGN_CHILD_ID,
    );
    expect(navigation.push).toHaveBeenLastCalledWith(
      `/reports?childId=${TEST_FOREIGN_CHILD_ID}`,
    );
  });
  it("paginates saved periods without repeating an existing option", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("cursor=page-2")
        ? Response.json({ items: [older], next_cursor: null })
        : respond(url),
    );
    renderReport();
    await screen.findByText("4 buổi");
    await user.click(screen.getByRole("button", { name: "Tải thêm kỳ" }));
    await screen.findByRole("option", { name: "2026-08-01 → 2026-08-31" });
    await user.selectOptions(
      screen.getByLabelText("Kỳ báo cáo đã lưu"),
      "2026-08-01/2026-08-31",
    );
    expect(navigation.push).toHaveBeenLastCalledWith(
      `/reports?childId=${TEST_CHILD_ID}&period_start=2026-08-01&period_end=2026-08-31`,
    );
  });
  it("preserves missing metrics, real zeros and explicit legacy values", async () => {
    current = {
      ...report,
      completed_sessions: null,
      reading_duration_ms: null,
      omission_count: null,
      repetition_count: 0,
      difficult_words: null,
      legacy: { avg_fluency: 80, total_books: 2 },
      data_status: "partial",
      availability: {
        metrics: "partial",
        difficult_words: "absent",
        comparison: "absent",
      },
    };
    renderReport();
    await screen.findByText("Báo cáo có dữ liệu chưa đầy đủ");
    expect(screen.queryByText("0 buổi")).not.toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("row", { name: "Bỏ sót Chưa có dữ liệu" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("row", { name: "Lặp từ 0" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Điểm trôi chảy trung bình")).toBeInTheDocument();
    expect(
      screen.queryByText("Báo cáo này chưa ghi nhận từ cần luyện."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Chưa đủ kỳ so sánh")).toBeInTheDocument();
  });
  it("keeps filters usable for a genuinely missing report", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/system/progress/") && !url.includes("/periods")
        ? Response.json({}, { status: 404 })
        : respond(url),
    );
    renderReport();
    await screen.findByText("Chưa có báo cáo đã lưu");
    expect(screen.getByLabelText("Kỳ báo cáo đã lưu")).toBeEnabled();
    expect(screen.queryByText("0 buổi")).not.toBeInTheDocument();
  });
  it("shows a period-list failure without discarding the valid report", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/periods")
        ? Response.json({}, { status: 503 })
        : respond(url),
    );
    renderReport();
    await screen.findByText("4 buổi");
    expect(screen.getByText("Chưa tải được danh sách kỳ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeInTheDocument();
  });
  it("rejects invalid dates without requesting data or silently showing latest", async () => {
    renderReport({
      requestedPeriodStart: "2026-02-30",
      requestedPeriodEnd: "2026-03-01",
    });
    expect(screen.getByText("Kỳ báo cáo không hợp lệ")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not show old-child data while navigation is loading or after its request resolves late", async () => {
    let resolve: (response: Response) => void = () => {};
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith(`/system/progress/${TEST_CHILD_ID}`)
        ? pending
        : respond(url),
    );
    const view = renderReport({ requestedChildId: TEST_CHILD_ID });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).endsWith(`/system/progress/${TEST_CHILD_ID}`),
        ),
      ).toBe(true),
    );
    view.rerender(
      <AppServicesProvider>
        <ProgressReportScreen requestedChildId={TEST_FOREIGN_CHILD_ID} />
      </AppServicesProvider>,
    );
    expect(screen.queryByText("4 buổi")).not.toBeInTheDocument();
    await screen.findByRole("heading", {
      name: `Tiến bộ của ${second.alias}`,
    });
    await act(async () =>
      resolve(Response.json({ ...report, completed_sessions: 999 })),
    );
    expect(screen.queryByText("999 buổi")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: `Tiến bộ của ${second.alias}`,
      }),
    ).toBeInTheDocument();
  });

  it("renders at most one ReadingAssessmentSummary when both saved report and rolling AI assessment include reading_assessment", async () => {
    const assessmentBlock = {
      first_pass_correct: 40,
      first_pass_incorrect: 5,
      self_corrected_words: 3,
      unresolved_words: 2,
      retry_attempts: 6,
      skipped_after_retry_limit: 0,
      recognition_uncertain: 1,
    };
    current = {
      ...report,
      assessment: assessmentBlock,
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (
        url.includes("/tutor/children/") &&
        url.includes("progress-assessment")
      ) {
        return Response.json({
          child_id: TEST_CHILD_ID,
          period_start: "2026-09-02",
          period_end: "2026-10-01",
          days: 30,
          generated_at: "2026-10-01T10:00:00+07:00",
          data_status: "OK",
          score: {
            overall: 82,
            previous_overall: 76,
            delta: 6,
            grade: "GOOD",
            grade_label: "Tốt",
            components: [
              {
                key: "ACCURACY",
                label: "Đọc đúng",
                score: 88,
                previous_score: 82,
                detail: "Đọc tốt",
              },
            ],
          },
          metrics: {
            reading_assessment: assessmentBlock,
            sessions: 4,
            active_days: 3,
            reading_minutes: 30,
            books: 2,
            pages_compared: 6,
            words_read: 45,
            coverage_pct: 90,
            accuracy_pct: 88.9,
            skipped_rate_pct: 4,
            substitution_rate_pct: 6,
            hesitations: 2,
            repeated_words: 1,
            hesitations_per_100_words: 4.4,
            words_per_minute: 55,
            comprehension_answered: 4,
            comprehension_first_try_pct: 75,
            comprehension_by_type: [],
            retry_confirmed: 3,
            retry_failed: 2,
          },
          weekly: [],
          difficult_words: [],
          assessment: {
            source: "AI",
            model: "gemini-test",
            headline: "Bé đọc ổn định",
            summary: "Nhận xét tổng hợp 30 ngày.",
            strengths: ["Đều đặn"],
            weaknesses: [],
            actions: [],
            practice_words: [],
            encouragement: "Tiếp tục phát huy!",
          },
          ai_cached: true,
        });
      }
      return respond(url);
    });

    render(
      <AppServicesProvider scenario="default">
        <ProgressReportScreen />
      </AppServicesProvider>,
    );
    await screen.findByText("Bé đọc ổn định");
    expect(
      screen.getAllByRole("region", { name: "Kết quả lượt đầu và luyện lại" }),
    ).toHaveLength(1);
  });

  it("skips latest progress request when saved periods list is empty to avoid unnecessary 404", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/periods")
        ? Response.json({ items: [], next_cursor: null })
        : respond(url),
    );
    renderReport();
    await screen.findByText("Chưa có báo cáo đã lưu");
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith(`/system/progress/${TEST_CHILD_ID}`),
      ),
    ).toBe(false);
  });

  it("paginates large difficult words lists (6 per page) instead of expanding all at once", async () => {
    const user = userEvent.setup();
    const manyWords = Array.from({ length: 15 }, (_, idx) => ({
      normalized_word: `tu-${idx + 1}`,
      display_text: `Từ khó ${idx + 1}`,
      difficulty_score: 15 - idx,
      omission_count: 1,
      repetition_count: 0,
      long_pause_count: 0,
      read_example_count: 0,
      session_count: 2,
      last_seen_at: "2026-10-01T01:00:00Z",
      evidence_word_ids: [`word-${idx + 1}`],
    }));
    current = {
      ...report,
      difficult_words: manyWords,
    };

    renderReport();
    await screen.findByText("Từ khó 1");

    expect(screen.getByText("Từ khó 6")).toBeInTheDocument();
    expect(screen.queryByText("Từ khó 7")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Xem tất cả/ }),
    ).not.toBeInTheDocument();

    const pagination = screen.getByRole("navigation", {
      name: "Từ cần luyện nổi bật",
    });
    expect(within(pagination).getByText("Trang 1 / 3")).toBeInTheDocument();

    await user.click(within(pagination).getByRole("button", { name: /Tiếp/ }));
    expect(screen.getByText("Từ khó 7")).toBeInTheDocument();
    expect(screen.getByText("Từ khó 12")).toBeInTheDocument();
    expect(screen.queryByText("Từ khó 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Từ khó 13")).not.toBeInTheDocument();

    await user.click(within(pagination).getByRole("button", { name: /Tiếp/ }));
    expect(screen.getByText("Từ khó 13")).toBeInTheDocument();
    expect(screen.getByText("Từ khó 15")).toBeInTheDocument();
    expect(within(pagination).getByText("Trang 3 / 3")).toBeInTheDocument();
  });
});
