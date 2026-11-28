import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SessionHistoryScreen } from "@/components/reports/session-history-screen";
import { SessionDetailScreen } from "@/components/reports/session-detail-screen";
import {
  bookFixture,
  childFixture,
  sessionDetailFixture,
  sessionSummaryFixture,
  TEST_CHILD_ID,
  TEST_FOREIGN_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";

const navigation = vi.hoisted(() => ({ push: vi.fn(), query: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sessions",
  useSearchParams: () => new URLSearchParams(navigation.query),
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

const secondChild = {
  ...childFixture,
  id: TEST_FOREIGN_CHILD_ID,
  alias: "Bé thứ hai",
};
let currentDetail = sessionDetailFixture;
const fetchMock = vi.fn();
function respond(url: string) {
  const path = new URL(url).pathname;
  if (path === "/profiles/children")
    return Response.json([childFixture, secondChild]);
  if (path === `/profiles/children/${TEST_CHILD_ID}`)
    return Response.json(childFixture);
  if (path === `/profiles/children/${TEST_FOREIGN_CHILD_ID}`)
    return Response.json(secondChild);
  if (path.endsWith("/book")) return Response.json(bookFixture);
  if (path === `/reading/history/${TEST_SESSION_ID}`)
    return Response.json(currentDetail);
  if (path === "/reading/history")
    return Response.json({
      sessions: [sessionSummaryFixture],
      next_cursor: null,
    });
  throw new Error(`Unexpected test route ${path}`);
}
beforeEach(() => {
  currentDetail = sessionDetailFixture;
  navigation.push.mockReset();
  navigation.query = "";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => respond(url));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Reading history list", () => {
  it("uses the server next cursor and preserves child/page on detail links", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/reading/history"
        ? Response.json({
            sessions: [sessionSummaryFixture],
            next_cursor: "page-5",
          })
        : respond(url),
    );
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={3} requestedChildId={TEST_CHILD_ID} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: bookFixture.title });
    expect(screen.getByRole("link", { name: "Trang sau" })).toHaveAttribute(
      "href",
      `/sessions?childId=${TEST_CHILD_ID}&page=5`,
    );
    expect(screen.getByRole("link", { name: "Trang trước" })).toHaveAttribute(
      "href",
      `/sessions?childId=${TEST_CHILD_ID}&page=2`,
    );
    expect(screen.getByRole("link", { name: "Xem chi tiết" })).toHaveAttribute(
      "href",
      `/sessions/${TEST_SESSION_ID}?childId=${TEST_CHILD_ID}&page=3`,
    );
  });
  it("reset page when selecting another child", async () => {
    navigation.query = `childId=${TEST_CHILD_ID}&page=3`;
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={3} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: bookFixture.title });
    await userEvent
      .setup()
      .selectOptions(screen.getByRole("combobox"), TEST_FOREIGN_CHILD_ID);
    expect(navigation.push).toHaveBeenCalledWith(
      `/sessions?childId=${TEST_FOREIGN_CHILD_ID}`,
    );
  });
  it("ignores late data from the previously selected child", async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (new URL(url).pathname !== "/reading/history") return respond(url);
      return new URL(url).searchParams.get("child_id") === TEST_CHILD_ID
        ? first
        : Response.json({ sessions: [], next_cursor: null });
    });
    const view = render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} requestedChildId={TEST_CHILD_ID} />
      </AppServicesProvider>,
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            new URL(String(url)).searchParams.get("child_id") === TEST_CHILD_ID,
        ),
      ).toBe(true),
    );
    view.rerender(
      <AppServicesProvider>
        <SessionHistoryScreen
          page={1}
          requestedChildId={TEST_FOREIGN_CHILD_ID}
        />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Chưa có buổi đọc" });
    await act(async () => {
      resolveFirst(
        Response.json({ sessions: [sessionSummaryFixture], next_cursor: null }),
      );
    });
    expect(screen.getByRole("combobox")).toHaveValue(TEST_FOREIGN_CHILD_ID);
    expect(
      screen.queryByRole("heading", { name: bookFixture.title }),
    ).not.toBeInTheDocument();
  });
  it("no children means no history request", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Chưa có hồ sơ bé" });
    expect(
      fetchMock.mock.calls.every(
        ([url]) => new URL(String(url)).pathname === "/profiles/children",
      ),
    ).toBe(true);
  });
  it("empty later page still allows returning to the previous page", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/reading/history"
        ? Response.json({ sessions: [], next_cursor: null })
        : respond(url),
    );
    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={2} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", {
      name: "Không còn buổi đọc ở trang này",
    });
    expect(screen.getByRole("link", { name: "Trang trước" })).toHaveAttribute(
      "href",
      `/sessions?childId=${TEST_CHILD_ID}&page=1`,
    );
    expect(
      screen.queryByRole("link", { name: "Trang sau" }),
    ).not.toBeInTheDocument();
  });
  it.each([401, 403, 500])(
    "failure %i is not an empty history and can retry",
    async (status) => {
      fetchMock.mockImplementation(async (url: string) =>
        new URL(url).pathname === "/reading/history"
          ? Response.json({ detail: "private sql token" }, { status })
          : respond(url),
      );
      render(
        <AppServicesProvider>
          <SessionHistoryScreen page={1} />
        </AppServicesProvider>,
      );
      await screen.findByText("Chưa tải được lịch sử");
      expect(screen.queryByText("Chưa có buổi đọc")).not.toBeInTheDocument();
      expect(screen.queryByText("private sql token")).not.toBeInTheDocument();
      fetchMock.mockImplementation(async (url: string) => respond(url));
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Thử lại" }));
      await screen.findByRole("heading", { name: bookFixture.title });
    },
  );
  it("deduplicates /book requests by book_id across multiple sessions on the same page", async () => {
    const secondBookId = "33000000-0000-4000-8000-000000000099";
    const secondBook = {
      ...bookFixture,
      id: secondBookId,
      title: "Cuốn sách thứ hai",
    };
    const sessions = [
      {
        ...sessionSummaryFixture,
        id: "12000000-0000-4000-8000-000000000101",
        started_at: "2026-10-02T03:00:00Z",
      },
      {
        ...sessionSummaryFixture,
        id: "12000000-0000-4000-8000-000000000102",
        started_at: "2026-10-02T01:00:00Z",
      },
      {
        ...sessionSummaryFixture,
        id: "12000000-0000-4000-8000-000000000103",
        book_id: secondBookId,
        started_at: "2026-10-01T01:00:00Z",
      },
    ];
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/reading/history") {
        return Response.json({ sessions, next_cursor: null });
      }
      if (
        path === "/reading/history/12000000-0000-4000-8000-000000000103/book"
      ) {
        return Response.json(secondBook);
      }
      return respond(url);
    });

    render(
      <AppServicesProvider>
        <SessionHistoryScreen page={1} requestedChildId={TEST_CHILD_ID} />
      </AppServicesProvider>,
    );

    expect(
      await screen.findAllByRole("heading", { name: bookFixture.title }),
    ).toHaveLength(2);
    expect(
      screen.getByRole("heading", { name: secondBook.title }),
    ).toBeInTheDocument();
    const bookRequests = fetchMock.mock.calls.filter(([url]) =>
      new URL(String(url)).pathname.endsWith("/book"),
    );
    // 3 sessions sharing 2 unique books -> only 2 /book requests!
    expect(bookRequests).toHaveLength(2);
  });
});

describe("Reading history detail", () => {
  it("keeps a valid stored score even when the metrics JSON is unsupported", async () => {
    currentDetail = {
      ...sessionDetailFixture,
      fluency_assessment: {
        metrics: null,
        score: 80,
        uncertainty: null,
        model_version: "stored",
      },
      availability: {
        ...sessionDetailFixture.availability,
        fluency: "partial",
      },
    };
    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Buổi đọc đã hoàn thành" });
    expect(screen.getByText("80", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/Có dữ liệu đánh giá đã lưu/)).toBeInTheDocument();
    expect(screen.queryByText("0 từ/phút")).not.toBeInTheDocument();
  });
  it("completed without an end stays completed, not unfinished or zero", async () => {
    currentDetail = {
      ...sessionDetailFixture,
      ended_at: null,
      duration_ms: null,
    };
    render(
      <AppServicesProvider>
        <SessionDetailScreen
          sessionId={TEST_SESSION_ID}
          requestedChildId={TEST_CHILD_ID}
          page={3}
        />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Buổi đọc đã hoàn thành" });
    expect(screen.getByText("Chưa có dữ liệu thời lượng")).toBeInTheDocument();
    expect(screen.getByText(/chưa lưu giờ kết thúc/)).toBeInTheDocument();
    expect(screen.queryByText("Dữ liệu đang dở dang")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lịch sử" })).toHaveAttribute(
      "href",
      `/sessions?childId=${TEST_CHILD_ID}&page=3`,
    );
  });
  it("direct links or foreign navigation context do not choose another child's history", async () => {
    render(
      <AppServicesProvider>
        <SessionDetailScreen
          sessionId={TEST_SESSION_ID}
          requestedChildId={TEST_FOREIGN_CHILD_ID}
          page={3}
        />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Buổi đọc đã hoàn thành" });
    expect(screen.getByRole("link", { name: "Lịch sử" })).toHaveAttribute(
      "href",
      `/sessions?childId=${TEST_CHILD_ID}`,
    );
  });
  it("shows actual detected events without calling them confirmed errors", async () => {
    currentDetail = {
      ...sessionDetailFixture,
      events: [
        {
          ...sessionDetailFixture.events[0],
          type: "MISPRONUNCIATION",
          status: "DETECTED",
        },
      ],
    };
    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />
      </AppServicesProvider>,
    );
    await screen.findByText("Ghi nhận phát âm");
    expect(screen.getByText("Đã phát hiện, chưa xác nhận")).toBeInTheDocument();
    expect(
      screen.queryByText("Bằng chứng lỗi đã xác nhận."),
    ).not.toBeInTheDocument();
  });
  it("unsupported groups are not described as empty", async () => {
    currentDetail = {
      ...sessionDetailFixture,
      events: [],
      comprehension: [],
      availability: {
        events: "unsupported",
        fluency: "unsupported",
        comprehension: "unsupported",
      },
    };
    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Buổi đọc đã hoàn thành" });
    expect(screen.getByText(/Có sự kiện đã lưu/)).toBeInTheDocument();
    expect(screen.getByText(/Có dữ liệu đánh giá đã lưu/)).toBeInTheDocument();
    expect(screen.getByText(/Có dữ liệu đọc hiểu đã lưu/)).toBeInTheDocument();
    expect(screen.getByText("Chưa có điểm hiển thị")).toBeInTheDocument();
    expect(
      screen.queryByText("Buổi đọc này chưa có sự kiện để hiển thị."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Buổi đọc này không có câu hỏi đọc hiểu."),
    ).not.toBeInTheDocument();
  });
  it("retains a stored question, text difficulty and ungraded answer in a partial group", async () => {
    currentDetail = {
      ...sessionDetailFixture,
      comprehension: [
        {
          question: {
            id: TEST_SESSION_ID,
            type: "FACTUAL",
            prompt: "Câu hỏi đã lưu",
            page_revision_id: bookFixture.id,
            source_span: null,
            difficulty: "EASY",
            answered: true,
          },
          answer: {
            answer_id: TEST_CHILD_ID,
            question_id: TEST_SESSION_ID,
            submitted_answer: "Câu trả lời đã lưu",
            is_correct: null,
            score: null,
            feedback_code: null,
          },
        },
      ],
      availability: {
        ...sessionDetailFixture.availability,
        comprehension: "partial",
      },
    };
    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />
      </AppServicesProvider>,
    );
    await screen.findByText("Câu hỏi đã lưu");
    expect(screen.getByText("Độ khó đã lưu: EASY")).toBeInTheDocument();
    expect(
      screen.getByText("Trả lời: Câu trả lời đã lưu · Chưa chấm"),
    ).toBeInTheDocument();
  });
  it("missing answers are distinct from stored but unsupported answers", async () => {
    currentDetail = {
      ...sessionDetailFixture,
      comprehension: [
        {
          question: {
            id: TEST_SESSION_ID,
            type: "FACTUAL",
            prompt: "Câu hỏi đã lưu",
            page_revision_id: bookFixture.id,
            source_span: null,
            difficulty: null,
            answered: true,
          },
          answer: null,
        },
      ],
      availability: {
        ...sessionDetailFixture.availability,
        comprehension: "partial",
      },
    };
    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />
      </AppServicesProvider>,
    );
    await screen.findByText(
      "Đã lưu câu trả lời nhưng định dạng chưa được hỗ trợ.",
    );
    expect(screen.queryByText("Chưa có câu trả lời")).not.toBeInTheDocument();
  });
  it("foreign session has a safe not-found state", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ detail: "private" }, { status: 404 }),
    );
    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />
      </AppServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Không tìm thấy buổi đọc" });
    expect(screen.queryByText(bookFixture.title)).not.toBeInTheDocument();
  });

  it("paginates comprehension questions (6 per page) and session events (8 per page)", async () => {
    const user = userEvent.setup();
    currentDetail = {
      ...sessionDetailFixture,
      comprehension: Array.from({ length: 8 }, (_, idx) => {
        const suffix = String(idx + 1).padStart(2, "0");
        const qId = `60000000-0000-4000-8000-0000000000${suffix}`;
        return {
          question: {
            id: qId,
            type: "FACTUAL" as const,
            prompt: `Câu hỏi đọc hiểu số ${idx + 1}`,
            page_revision_id: bookFixture.id,
            source_span: null,
            difficulty: "EASY",
            answered: true,
          },
          answer: {
            answer_id: `70000000-0000-4000-8000-0000000000${suffix}`,
            question_id: qId,
            submitted_answer: `Đáp án ${idx + 1}`,
            is_correct: true,
            score: 1,
            feedback_code: null,
          },
        };
      }),
      events: Array.from({ length: 10 }, (_, idx) => ({
        ...sessionDetailFixture.events[0],
        id: `80000000-0000-4000-8000-0000000000${String(idx + 1).padStart(2, "0")}`,
        start_ms: (idx + 1) * 1000,
        end_ms: (idx + 1) * 1000 + 500,
      })),
      availability: {
        ...sessionDetailFixture.availability,
        comprehension: "available",
      },
    };

    render(
      <AppServicesProvider>
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />
      </AppServicesProvider>,
    );

    await screen.findByText("Câu hỏi đọc hiểu số 1");
    expect(screen.getByText("Câu hỏi đọc hiểu số 6")).toBeInTheDocument();
    expect(screen.queryByText("Câu hỏi đọc hiểu số 7")).not.toBeInTheDocument();

    const qNav = screen.getByRole("navigation", {
      name: "Phân trang câu hỏi đọc hiểu",
    });
    await user.click(
      Array.from(qNav.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Tiếp"),
      )!,
    );
    expect(screen.getByText("Câu hỏi đọc hiểu số 7")).toBeInTheDocument();
    expect(screen.getByText("Câu hỏi đọc hiểu số 8")).toBeInTheDocument();
    expect(screen.queryByText("Câu hỏi đọc hiểu số 1")).not.toBeInTheDocument();

    const evNav = screen.getByRole("navigation", {
      name: "Phân trang sự kiện trong buổi đọc",
    });
    expect(evNav).toHaveTextContent("Trang 1 / 2");
    await user.click(
      Array.from(evNav.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Tiếp"),
      )!,
    );
    expect(evNav).toHaveTextContent("Trang 2 / 2");
  });
});
