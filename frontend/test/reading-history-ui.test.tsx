import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
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

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  query: "",
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sessions",
  useSearchParams: () => new URLSearchParams(navigation.query),
  useRouter: () => ({
    push: navigation.push,
    replace: navigation.replace,
  }),
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
  navigation.replace.mockReset();
  navigation.query = "";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => respond(url));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function withSelectedChild(childId: string, content: React.ReactNode) {
  return (
    <WithSelectedChild childId={childId}>
      <AppServicesProvider>{content}</AppServicesProvider>
    </WithSelectedChild>
  );
}


describe("Reading history list", () => {
  it("uses the server next cursor and preserves page context on detail links", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/reading/history"
        ? Response.json({
            sessions: [sessionSummaryFixture],
            next_cursor: "page-5",
          })
        : respond(url),
    );
    render(withSelectedChild(TEST_CHILD_ID, <SessionHistoryScreen page={3} />));
    await screen.findByRole("heading", { name: bookFixture.title });
    expect(screen.getByRole("link", { name: "Trang sau" })).toHaveAttribute(
      "href",
      "/sessions?page=5",
    );
    expect(screen.getByRole("link", { name: "Trang trước" })).toHaveAttribute(
      "href",
      "/sessions?page=2",
    );
    expect(screen.getByRole("link", { name: "Xem chi tiết" })).toHaveAttribute(
      "href",
      `/sessions/${TEST_SESSION_ID}?page=3`,
    );
  });
  it("does not offer a duplicate child selector and links to Dashboard to change child", async () => {
    render(withSelectedChild(TEST_CHILD_ID, <SessionHistoryScreen page={1} />));
    await screen.findByRole("heading", { name: bookFixture.title });
    expect(
      screen.queryByRole("combobox", { name: "Chọn hồ sơ bé để xem dữ liệu" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Đổi hồ sơ" })).toHaveAttribute(
      "href",
      "/dashboard?focus=child-selection",
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
    const historyTree = (selectedChildId: string) =>
      withSelectedChild(selectedChildId, <SessionHistoryScreen page={1} />);
    const view = render(historyTree(TEST_CHILD_ID));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            new URL(String(url)).searchParams.get("child_id") === TEST_CHILD_ID,
        ),
      ).toBe(true),
    );
    view.rerender(historyTree(TEST_FOREIGN_CHILD_ID));
    await screen.findByRole("heading", { name: "Chưa có buổi đọc" });
    await act(async () => {
      resolveFirst(
        Response.json({ sessions: [sessionSummaryFixture], next_cursor: null }),
      );
    });
    expect(screen.getByText("Bé thứ hai")).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Chọn hồ sơ bé để xem dữ liệu" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: bookFixture.title }),
    ).not.toBeInTheDocument();
  });
  it("redirects to Dashboard when no child is selected before requesting history", async () => {
    render(
      <AppStoreProvider>
        <AppServicesProvider>
          <SessionHistoryScreen page={1} />
        </AppServicesProvider>
      </AppStoreProvider>,
    );
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/dashboard?focus=child-selection&reason=missing",
      ),
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        new URL(String(url)).pathname === "/reading/history",
      ),
    ).toBe(false);
  });
  it("empty later page still allows returning to the previous page", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/reading/history"
        ? Response.json({ sessions: [], next_cursor: null })
        : respond(url),
    );
    render(withSelectedChild(TEST_CHILD_ID, <SessionHistoryScreen page={2} />));
    await screen.findByRole("heading", {
      name: "Không còn buổi đọc ở trang này",
    });
    expect(screen.getByRole("link", { name: "Trang trước" })).toHaveAttribute(
      "href",
      "/sessions?page=1",
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
      render(withSelectedChild(TEST_CHILD_ID, <SessionHistoryScreen page={1} />));
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
      withSelectedChild(
        TEST_CHILD_ID,
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />,
      ),
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
      withSelectedChild(
        TEST_CHILD_ID,
        <SessionDetailScreen sessionId={TEST_SESSION_ID} page={3} />,
      ),
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
  it("does not expose a detail belonging to another child selected from Dashboard", async () => {
    render(
      withSelectedChild(
        TEST_FOREIGN_CHILD_ID,
        <SessionDetailScreen sessionId={TEST_SESSION_ID} page={3} />,
      ),
    );
    await screen.findByRole("heading", { name: "Không tìm thấy buổi đọc" });
    expect(screen.queryByRole("heading", { name: "Buổi đọc đã hoàn thành" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Về lịch sử" })).toHaveAttribute(
      "href",
      "/sessions",
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
      withSelectedChild(
        TEST_CHILD_ID,
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />,
      ),
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
      withSelectedChild(
        TEST_CHILD_ID,
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />,
      ),
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
      withSelectedChild(
        TEST_CHILD_ID,
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />,
      ),
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
      withSelectedChild(
        TEST_CHILD_ID,
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />,
      ),
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
      withSelectedChild(
        TEST_CHILD_ID,
        <SessionDetailScreen sessionId={TEST_SESSION_ID} />,
      ),
    );
    await screen.findByRole("heading", { name: "Không tìm thấy buổi đọc" });
    expect(screen.queryByText(bookFixture.title)).not.toBeInTheDocument();
  });
});
