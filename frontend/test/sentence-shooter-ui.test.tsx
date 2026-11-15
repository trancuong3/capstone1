import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { SentenceShooterScreen } from "@/components/entertainment/sentence-shooter/sentence-shooter-screen";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
import {
  childFixture,
  TEST_BOOK_ID,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
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

const tokenIds = {
  first: "21000000-0000-4000-8000-000000000001",
  second: "21000000-0000-4000-8000-000000000002",
  third: "21000000-0000-4000-8000-000000000003",
};
const roundId = "22000000-0000-4000-8000-000000000001";
const book = {
  id: TEST_BOOK_ID,
  name: "Sách xạ thủ",
  title: "Sách xạ thủ",
  author: "Tác giả kiểm thử",
  min_grade: 1,
  max_grade: 3,
  available_rounds: 3,
};
const round = {
  round_id: roundId,
  round_number: 1,
  token_count: 3,
  tokens: [
    { id: tokenIds.third, text: "sách." },
    { id: tokenIds.second, text: "đọc" },
    { id: tokenIds.first, text: "Bé" },
  ],
};
const session = {
  session_id: TEST_SESSION_ID,
  book,
  difficulty: "easy",
  total_rounds: 3,
  completed_rounds: 0,
  total_stars: 0,
  round,
};

const fetchMock = vi.fn();
function respond(url: string, init?: RequestInit): Response {
  const requestUrl = new URL(url);
  const path = requestUrl.pathname;
  if (path === `/profiles/children/${TEST_CHILD_ID}`) {
    return Response.json(childFixture);
  }
  if (path === "/games/sentence-shooter/books") {
    expect(requestUrl.searchParams.get("child_id")).toBe(TEST_CHILD_ID);
    expect(requestUrl.searchParams.get("difficulty")).toBe("easy");
    expect(requestUrl.searchParams.get("total_rounds")).toBe("3");
    return Response.json([book]);
  }
  if (path === "/games/sentence-shooter/sessions") {
    return Response.json(session, { status: 201 });
  }
  if (path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/shots`) {
    const body = JSON.parse(String(init?.body)) as {
      round_id: string;
      token_id: string;
      request_id: string;
    };
    expect(body.round_id).toBe(roundId);
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/i);
    const correct = body.token_id === tokenIds.first;
    return Response.json({
      is_correct: correct,
      correct_count: correct ? 1 : 0,
      token_count: 3,
      mistakes_total: correct ? 1 : 2,
      completed_rounds: 0,
      total_stars: 0,
      round_completed: false,
      session_completed: false,
      next_expected_position: correct ? 1 : 0,
      stars_awarded: 0,
      completed_sentence: null,
      message: correct
        ? "Hay lắm! Tiếp tục nhé!"
        : "Thử lại nhé! Bé làm được mà!",
    });
  }
  throw new Error(`Unexpected test route ${path}`);
}

beforeEach(() => {
  navigation.replace.mockReset();
  navigation.push.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    respond(url, init),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function renderScreen() {
  return render(
    <AppServicesProvider>
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <SentenceShooterScreen />
      </WithSelectedChild>
    </AppServicesProvider>,
  );
}

function renderScreenWithBook(bookId: string) {
  return render(
    <AppServicesProvider>
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <SentenceShooterScreen
          initialBookId={bookId}
          readingSessionId={TEST_SESSION_ID}
        />
      </WithSelectedChild>
    </AppServicesProvider>,
  );
}

describe("Sentence Shooter", () => {
  it("preselects a reading-flow book and still waits for the child to start", async () => {
    const user = userEvent.setup();
    renderScreenWithBook(TEST_BOOK_ID);

    const bookButton = await screen.findByRole("button", {
      name: /Sách xạ thủ/,
    });
    await waitFor(() =>
      expect(bookButton).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByText(/Đã chọn sách bé vừa đọc/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Quay lại: Kết quả đọc/ }),
    ).toHaveAttribute("href", `/reading/${TEST_SESSION_ID}`);
    expect(screen.getByRole("button", { name: /Bắt đầu chơi/ })).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(
        ([url]) =>
          new URL(String(url)).pathname === "/games/sentence-shooter/sessions",
      ),
    ).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));
    await screen.findByRole("button", { name: "sách." });
    const createRequest = fetchMock.mock.calls.find(
      ([url]) =>
        new URL(String(url)).pathname === "/games/sentence-shooter/sessions",
    );
    expect(createRequest).toBeDefined();
    expect(JSON.parse(String(createRequest?.[1]?.body))).toMatchObject({
      book_id: TEST_BOOK_ID,
      child_id: TEST_CHILD_ID,
      difficulty: "easy",
      total_rounds: 3,
    });
  });

  it("does not start a session when the requested book is unavailable", async () => {
    renderScreenWithBook("unknown-book-id");

    expect(
      await screen.findByText(/Cuốn sách bé vừa đọc chưa có đủ câu phù hợp/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bắt đầu chơi/ })).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(
        ([url]) =>
          new URL(String(url)).pathname === "/games/sentence-shooter/sessions",
      ),
    ).toHaveLength(0);
  });

  it("loads real game books, starts a server session, and only places server-confirmed words", async () => {
    const user = userEvent.setup();
    renderScreen();

    await screen.findByRole("heading", { name: "Chọn sách và bắt đầu chơi" });
    await user.click(
      await screen.findByRole("button", { name: /Sách xạ thủ/ }),
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));

    await screen.findByRole("button", { name: "sách." });
    await user.click(screen.getByRole("button", { name: "sách." }));
    await screen.findByText("Thử lại nhé! Bé làm được mà!");
    expect(
      screen.getByRole("listitem", { name: "Ô 1 còn trống" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Bé" }));
    await screen.findByRole("listitem", { name: "Ô 1: Bé" });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            new URL(String(url)).pathname ===
            "/games/sentence-shooter/sessions",
        ),
      ).toBe(true);
    });
    const shotRequests = fetchMock.mock.calls.filter(([url]) =>
      new URL(String(url)).pathname.endsWith("/shots"),
    );
    expect(shotRequests).toHaveLength(2);
    expect(JSON.parse(String(shotRequests[0]?.[1]?.body)).token_id).toBe(
      tokenIds.third,
    );
    expect(JSON.parse(String(shotRequests[1]?.[1]?.body)).token_id).toBe(
      tokenIds.first,
    );
  });
});
