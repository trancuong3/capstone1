import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("deduplicates rapid clicks, reuses request_id on retry, prefetches next_round, and shows completion before /result resolves", async () => {
    const round2Id = "22000000-0000-4000-8000-000000000002";
    const round2 = {
      round_id: round2Id,
      round_number: 2,
      token_count: 3,
      tokens: [
        { id: tokenIds.first, text: "Bé" },
        { id: tokenIds.second, text: "vui" },
        { id: tokenIds.third, text: "học" },
      ],
    };
    const twoRoundSession = {
      ...session,
      total_rounds: 2,
      round: {
        ...round,
        tokens: [
          { id: tokenIds.first, text: "Bé" },
          { id: tokenIds.second, text: "đọc" },
          { id: tokenIds.third, text: "sách." },
        ],
      },
    };
    const deferred: {
      shot?: (r: Response) => void;
      result?: (r: Response) => void;
    } = {};
    let shotAttempt = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/sentence-shooter/books") {
        return Response.json([book]);
      }
      if (path === "/games/sentence-shooter/sessions") {
        return Response.json(twoRoundSession, { status: 201 });
      }
      if (
        path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/shots`
      ) {
        const body = JSON.parse(String(init?.body)) as {
          round_id: string;
          token_id: string;
          request_id: string;
        };
        shotAttempt += 1;
        // Shot 1: deferred to verify rapid double-click lock and immediate selection signal
        if (shotAttempt === 1) {
          return await new Promise<Response>((resolve) => {
            deferred.shot = resolve;
          });
        }
        // Shot 2: simulated transient failure, then shot 3 retries with identical request_id
        if (shotAttempt === 2) {
          throw new TypeError("Simulated transient failure");
        }
        if (body.round_id === roundId) {
          const isFinalInRound = body.token_id === tokenIds.third;
          return Response.json({
            is_correct: true,
            correct_count: isFinalInRound ? 3 : 2,
            token_count: 3,
            mistakes_total: 0,
            completed_rounds: isFinalInRound ? 1 : 0,
            total_stars: isFinalInRound ? 3 : 0,
            round_completed: isFinalInRound,
            session_completed: false,
            next_expected_position: isFinalInRound ? 3 : 2,
            stars_awarded: isFinalInRound ? 3 : 0,
            completed_sentence: isFinalInRound ? "Bé đọc sách." : null,
            next_round: isFinalInRound ? round2 : null,
            message: isFinalInRound ? "Hoàn thành câu!" : "Hay lắm!",
          });
        }
        const isLast = body.token_id === tokenIds.third;
        return Response.json({
          is_correct: true,
          correct_count: isLast ? 3 : 1,
          token_count: 3,
          mistakes_total: 0,
          completed_rounds: isLast ? 2 : 1,
          total_stars: isLast ? 6 : 3,
          round_completed: isLast,
          session_completed: isLast,
          next_expected_position: isLast ? 3 : 1,
          stars_awarded: isLast ? 3 : 0,
          completed_sentence: isLast ? "Bé vui học" : null,
          next_round: null,
          message: isLast ? "Hoàn thành!" : "Hay lắm!",
        });
      }
      if (
        path ===
        `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/next-round`
      ) {
        throw new Error(
          "Should not call /next-round when next_round is prefetched",
        );
      }
      if (
        path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/result`
      ) {
        return await new Promise<Response>((resolve) => {
          deferred.result = resolve;
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup();
    renderScreen();
    await user.click(
      await screen.findByRole("button", { name: /Sách xạ thủ/ }),
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));

    const firstTokenBtn = await screen.findByRole("button", { name: "Bé" });
    // Rapid double click on the same token: only 1 request should be dispatched
    await user.dblClick(firstTokenBtn);
    await waitFor(() => {
      const shots = fetchMock.mock.calls.filter(([u]) =>
        new URL(String(u)).pathname.endsWith("/shots"),
      );
      expect(shots).toHaveLength(1);
    });
    expect(screen.getByText(/Đang kiểm tra từ bé chọn/)).toBeInTheDocument();
    // Pause and Exit remain enabled while shot is in flight
    expect(screen.getByRole("button", { name: "Tạm dừng" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Thoát" })).toBeEnabled();

    deferred.shot?.(
      Response.json({
        is_correct: true,
        correct_count: 1,
        token_count: 3,
        mistakes_total: 0,
        completed_rounds: 0,
        total_stars: 0,
        round_completed: false,
        session_completed: false,
        next_expected_position: 1,
        stars_awarded: 0,
        completed_sentence: null,
        message: "Hay lắm!",
      }),
    );
    await screen.findByRole("listitem", { name: "Ô 1: Bé" });

    // Trigger transient error on token 2 ("đọc"), then click "đọc" again -> reuses request_id
    await user.click(screen.getByRole("button", { name: "đọc" }));
    await screen.findByText(/Chưa gửi được lượt bắn/);
    await user.click(screen.getByRole("button", { name: "đọc" }));
    await screen.findByRole("listitem", { name: "Ô 2: đọc" });

    const shotBodies = fetchMock.mock.calls
      .filter(([u]) => new URL(String(u)).pathname.endsWith("/shots"))
      .map(([, reqInit]) => JSON.parse(String(reqInit?.body)));
    expect(shotBodies[1].request_id).toBe(shotBodies[2].request_id);

    // Finish round 1 -> next_round comes bundled, 0 /next-round HTTP requests!
    await user.click(screen.getByRole("button", { name: "sách." }));
    await user.click(
      await screen.findByRole("button", { name: /Câu tiếp theo/ }),
    );
    await screen.findByRole("button", { name: "vui" });
    expect(
      fetchMock.mock.calls.some(([u]) =>
        new URL(String(u)).pathname.endsWith("/next-round"),
      ),
    ).toBe(false);

    // Finish round 2 -> immediately displays completion view before /result resolves
    await user.click(screen.getByRole("button", { name: "Bé" }));
    await screen.findByRole("listitem", { name: "Ô 1: Bé" });
    await user.click(screen.getByRole("button", { name: "vui" }));
    await screen.findByRole("listitem", { name: "Ô 2: vui" });
    await user.click(screen.getByRole("button", { name: "học" }));

    expect(
      await screen.findByRole("heading", {
        name: /Giỏi quá, bé đã hoàn thành!/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Đang tải chi tiết bảng tổng kết/),
    ).toBeInTheDocument();

    // Hydrate /result summary afterwards
    deferred.result?.(
      Response.json({
        session_id: TEST_SESSION_ID,
        book,
        difficulty: "easy",
        status: "COMPLETED",
        total_rounds: 2,
        completed_rounds: 2,
        correct_count: 6,
        mistakes_total: 0,
        hint_count: 0,
        total_stars: 6,
        duration_seconds: 12,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }),
    );
    expect(
      await screen.findByText("Thời gian chơi: 0 phút 12 giây"),
    ).toBeInTheDocument();
  });

  it("uses fresh request_id when switching tokens after network error, recovers /result on failure, and aborts in-flight shot cleanly on exit", async () => {
    let shotSignalAborted = false;
    let resolveHangingShot: ((r: Response) => void) | undefined;
    let phase: "switch-token-test" | "result-retry-test" = "switch-token-test";
    let shotCount = 0;
    let resultCount = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/sentence-shooter/books") {
        return Response.json([book]);
      }
      if (path === "/games/sentence-shooter/sessions") {
        return Response.json(
          phase === "result-retry-test"
            ? {
                ...session,
                total_rounds: 1,
                round: { ...round, token_count: 3 },
              }
            : session,
          { status: 201 },
        );
      }
      if (
        path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/shots`
      ) {
        shotCount += 1;
        if (phase === "switch-token-test") {
          if (shotCount === 1) throw new TypeError("Network drop");
          if (shotCount === 2) {
            // Different token should get fresh request_id; hold this request in flight for exit abort
            return await new Promise<Response>((resolve, reject) => {
              resolveHangingShot = resolve;
              init?.signal?.addEventListener(
                "abort",
                () => {
                  shotSignalAborted = true;
                  reject(new DOMException("Aborted", "AbortError"));
                },
                { once: true },
              );
            });
          }
        }
        const body = JSON.parse(String(init?.body)) as { token_id: string };
        const isLast = body.token_id === tokenIds.third;
        return Response.json({
          is_correct: true,
          correct_count: isLast ? 3 : 1,
          token_count: 3,
          mistakes_total: 0,
          completed_rounds: isLast ? 1 : 0,
          total_stars: isLast ? 3 : 0,
          round_completed: isLast,
          session_completed: isLast,
          next_expected_position: isLast ? 3 : 1,
          stars_awarded: isLast ? 3 : 0,
          completed_sentence: isLast ? "Bé đọc sách." : null,
          next_round: null,
          message: "Hay lắm!",
        });
      }
      if (
        path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/abandon`
      ) {
        return Response.json({
          session_id: TEST_SESSION_ID,
          status: "ABANDONED",
        });
      }
      if (
        path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/result`
      ) {
        resultCount += 1;
        if (resultCount === 1) {
          return Response.json(
            { detail: "Temporary DB error" },
            { status: 503 },
          );
        }
        return Response.json({
          session_id: TEST_SESSION_ID,
          book,
          difficulty: "easy",
          status: "COMPLETED",
          total_rounds: 1,
          completed_rounds: 1,
          correct_count: 3,
          mistakes_total: 0,
          hint_count: 0,
          total_stars: 3,
          duration_seconds: 8,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const user = userEvent.setup();
    const { unmount } = renderScreen();
    await user.click(
      await screen.findByRole("button", { name: /Sách xạ thủ/ }),
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));

    // Network fails on token "sách.", then user clicks a DIFFERENT token "Bé" -> fresh request_id!
    await user.click(await screen.findByRole("button", { name: "sách." }));
    await screen.findByText(/Chưa gửi được lượt bắn/);
    await user.click(screen.getByRole("button", { name: "Bé" }));
    await waitFor(() => expect(shotCount).toBe(2));

    const requests = fetchMock.mock.calls
      .filter(([u]) => new URL(String(u)).pathname.endsWith("/shots"))
      .map(([, reqInit]) => JSON.parse(String(reqInit?.body)));
    expect(requests[0].request_id).not.toBe(requests[1].request_id);

    // Click Thoát while 2nd shot is still in flight -> aborts request, calls /abandon, navigates
    await user.click(screen.getByRole("button", { name: "Thoát" }));
    await waitFor(() => expect(shotSignalAborted).toBe(true));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/entertainment"),
    );

    // Resolving the abandoned late promise afterward must not throw
    resolveHangingShot?.(
      Response.json({
        is_correct: true,
        correct_count: 1,
        token_count: 3,
        mistakes_total: 0,
        completed_rounds: 0,
        total_stars: 0,
        round_completed: false,
        session_completed: false,
        next_expected_position: 1,
        stars_awarded: 0,
        completed_sentence: null,
        message: "Late!",
      }),
    );
    unmount();

    // Part 2: Verify failed /result shows manual reload button on result screen & recovers cleanly
    phase = "result-retry-test";
    renderScreen();
    await user.click(
      await screen.findByRole("button", { name: /Sách xạ thủ/ }),
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));
    await user.click(await screen.findByRole("button", { name: "Bé" }));
    await user.click(screen.getByRole("button", { name: "đọc" }));
    await user.click(screen.getByRole("button", { name: "sách." }));

    expect(
      await screen.findByRole("button", { name: /Tải lại bảng tổng kết/ }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Tải lại bảng tổng kết/ }),
    );
    expect(
      await screen.findByText("Thời gian chơi: 0 phút 8 giây"),
    ).toBeInTheDocument();
  });

  it("never freezes UI under 500ms slow network, delivers <100ms tap-to-visible-feedback, preserves FIFO order, and avoids tap-time reflows", async () => {
    let activeRequests = 0;
    let maxConcurrentRequests = 0;
    const dispatchedTokenIds: string[] = [];
    const expectedOrder = [tokenIds.first, tokenIds.second, tokenIds.third];

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/sentence-shooter/books") {
        return Response.json([book]);
      }
      if (path === "/games/sentence-shooter/sessions") {
        return Response.json({ ...session, total_rounds: 2 }, { status: 201 });
      }
      if (
        path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/shots`
      ) {
        const body = JSON.parse(String(init?.body)) as {
          token_id: string;
          client_shot_id?: string;
        };
        activeRequests += 1;
        maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
        dispatchedTokenIds.push(body.token_id);

        await new Promise((resolve) => setTimeout(resolve, 500));
        activeRequests -= 1;

        const pos = expectedOrder.indexOf(body.token_id) + 1;
        const done = pos === 3;
        return Response.json({
          is_correct: true,
          correct_count: pos,
          token_count: 3,
          mistakes_total: 0,
          completed_rounds: done ? 1 : 0,
          total_stars: done ? 3 : 0,
          round_completed: done,
          session_completed: false,
          next_expected_position: pos,
          stars_awarded: done ? 3 : 0,
          score: pos * 10 + (done ? 15 : 0),
          completed_sentence: done ? "Bé đọc sách." : null,
          next_round: null,
          message: done ? "Hoàn thành câu! Tuyệt lắm!" : "Hay lắm!",
          client_shot_id: body.client_shot_id ?? null,
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup();
    renderScreen();
    await user.click(
      await screen.findByRole("button", { name: /Sách xạ thủ/ }),
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));

    const btnBe = await screen.findByRole("button", { name: "Bé" });
    const btnDoc = screen.getByRole("button", { name: "đọc" });
    const btnSach = screen.getByRole("button", { name: "sách." });

    // Allow initial ResizeObserver/rAF layout snapshot to populate before spying on reflows.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");

    const tapLatenciesMs: number[] = [];

    // Tap 1: "Bé" — must reflect visually immediately (<100ms) while 500ms HTTP is still pending!
    const t0 = performance.now();
    fireEvent.click(btnBe);
    expect(btnBe).toHaveAttribute("data-shot-state", "in-flight");
    expect(btnBe).toBeDisabled();
    expect(
      screen.getByRole("listitem", { name: "Ô 1: Bé (đang kiểm tra)" }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("shot-projectile").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("shot-particles").length).toBeGreaterThan(0);
    tapLatenciesMs.push(performance.now() - t0);

    // Other bubbles remain 100% enabled during the 500ms network RTT!
    expect(btnDoc).toBeEnabled();
    expect(btnSach).toBeEnabled();

    // Tap 2 & Tap 3 immediately while Shot 1 is STILL waiting on the 500ms network!
    const t1 = performance.now();
    fireEvent.click(btnDoc);
    expect(btnDoc).toHaveAttribute("data-shot-state", "in-flight");
    expect(
      screen.getByRole("listitem", { name: "Ô 2: đọc (đang kiểm tra)" }),
    ).toBeInTheDocument();
    tapLatenciesMs.push(performance.now() - t1);

    const t2 = performance.now();
    fireEvent.click(btnSach);
    expect(btnSach).toHaveAttribute("data-shot-state", "in-flight");
    expect(
      screen.getByRole("listitem", { name: "Ô 3: sách. (đang kiểm tra)" }),
    ).toBeInTheDocument();
    tapLatenciesMs.push(performance.now() - t2);

    // Zero forced synchronous getBoundingClientRect reflows during all 3 cached taps!
    expect(rectSpy).not.toHaveBeenCalled();
    rectSpy.mockRestore();

    // Log and verify actual measured tap-to-visible-feedback timings (<100ms budget).
    const maxLatency = Math.max(...tapLatenciesMs);
    console.info(
      `[SentenceShooter V4] Tap-to-visible-feedback timings (ms): ${tapLatenciesMs.map((v) => v.toFixed(2)).join(", ")} (max=${maxLatency.toFixed(2)}ms)`,
    );
    expect(maxLatency).toBeLessThan(100);

    // Only 1 request is in flight on the wire right now (strict FIFO).
    await waitFor(() => expect(dispatchedTokenIds).toEqual([tokenIds.first]));

    // Wait for all 3 500ms FIFO shots to reconcile cleanly.
    await waitFor(
      () => {
        expect(
          screen.getByText("Tuyệt vời! Bé đã ghép đúng cả câu."),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(dispatchedTokenIds).toEqual(expectedOrder);
    expect(maxConcurrentRequests).toBe(1);
    expect(screen.getByTestId("session-score")).toHaveTextContent("45 điểm");
  });

  it("rolls back only the wrong optimistic shot on server reconciliation while preserving queued FIFO shots", async () => {
    const resolvers: Array<(r: Response) => void> = [];
    const sentTokens: string[] = [];

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/sentence-shooter/books") {
        return Response.json([book]);
      }
      if (path === "/games/sentence-shooter/sessions") {
        return Response.json(session, { status: 201 });
      }
      if (
        path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/shots`
      ) {
        const body = JSON.parse(String(init?.body)) as { token_id: string };
        sentTokens.push(body.token_id);
        return await new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup();
    renderScreen();
    await user.click(
      await screen.findByRole("button", { name: /Sách xạ thủ/ }),
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));

    const btnSach = await screen.findByRole("button", { name: "sách." });
    const btnBe = screen.getByRole("button", { name: "Bé" });

    // Rapidly tap WRONG token "sách." followed immediately by RIGHT token "Bé"
    fireEvent.click(btnSach);
    fireEvent.click(btnBe);
    expect(
      screen.getByRole("listitem", { name: "Ô 1: sách. (đang kiểm tra)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: "Ô 2: Bé (đang kiểm tra)" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(sentTokens).toEqual([tokenIds.third]));

    // Server rejects "sách." -> must roll back ONLY "sách.", shake it, and advance FIFO to "Bé"
    resolvers[0]?.(
      Response.json({
        is_correct: false,
        correct_count: 0,
        token_count: 3,
        mistakes_total: 1,
        completed_rounds: 0,
        total_stars: 0,
        round_completed: false,
        session_completed: false,
        next_expected_position: 0,
        stars_awarded: 0,
        score: 0,
        completed_sentence: null,
        message: "Thử lại nhé! Bé làm được mà!",
      }),
    );

    await waitFor(() =>
      expect(sentTokens).toEqual([tokenIds.third, tokenIds.first]),
    );
    expect(btnSach).toHaveAttribute("data-shot-state", "wrong");
    expect(btnSach).toBeEnabled();
    expect(
      screen.getByRole("listitem", { name: "Ô 1: Bé (đang kiểm tra)" }),
    ).toBeInTheDocument();

    // Server confirms "Bé" -> cleanly placed in Ô 1 without double-scoring or corruption
    resolvers[1]?.(
      Response.json({
        is_correct: true,
        correct_count: 1,
        token_count: 3,
        mistakes_total: 1,
        completed_rounds: 0,
        total_stars: 0,
        round_completed: false,
        session_completed: false,
        next_expected_position: 1,
        stars_awarded: 0,
        score: 10,
        completed_sentence: null,
        message: "Hay lắm!",
      }),
    );

    expect(
      await screen.findByRole("listitem", { name: "Ô 1: Bé" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: "Ô 2 còn trống" }),
    ).toBeInTheDocument();
  });

  it("cancels stale-epoch queued shots when a round completes so trailing taps are never sent", async () => {
    let resolveFirstShot: ((r: Response) => void) | undefined;
    const sentTokens: string[] = [];

    const fillBlankSession = {
      ...session,
      learning_mode: "FILL_BLANK" as const,
      round: {
        round_id: roundId,
        round_number: 1,
        token_count: 1,
        learning_mode: "FILL_BLANK" as const,
        prompt_slots: [
          { position: 0, text: "Bé", is_blank: false },
          { position: 1, text: null, is_blank: true },
          { position: 2, text: "sách.", is_blank: false },
        ],
        tokens: [
          { id: tokenIds.second, text: "đọc" },
          { id: tokenIds.third, text: "mây" },
          { id: tokenIds.first, text: "hoa" },
        ],
      },
    };

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/sentence-shooter/books") {
        return Response.json([book]);
      }
      if (path === "/games/sentence-shooter/sessions") {
        return Response.json(fillBlankSession, { status: 201 });
      }
      if (
        path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/shots`
      ) {
        const body = JSON.parse(String(init?.body)) as { token_id: string };
        sentTokens.push(body.token_id);
        return await new Promise<Response>((resolve) => {
          resolveFirstShot = resolve;
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup();
    renderScreen();
    await user.click(
      await screen.findByRole("button", { name: /Sách xạ thủ/ }),
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));

    const btnDoc = await screen.findByRole("button", { name: "đọc" });
    const btnMay = screen.getByRole("button", { name: "mây" });
    fireEvent.click(btnDoc);
    fireEvent.click(btnMay);

    await waitFor(() => expect(resolveFirstShot).toBeDefined());
    resolveFirstShot?.(
      Response.json({
        is_correct: true,
        correct_count: 1,
        token_count: 1,
        mistakes_total: 0,
        completed_rounds: 1,
        total_stars: 3,
        round_completed: true,
        session_completed: false,
        next_expected_position: 1,
        stars_awarded: 3,
        score: 25,
        completed_sentence: "Bé đọc sách.",
        grammar_tip: 'Từ "đọc" giúp câu có nghĩa trọn vẹn và tự nhiên hơn.',
        practiced_difficult_words: ["đọc"],
        next_round: null,
        message: "Hoàn thành câu! Tuyệt lắm!",
      }),
    );

    expect(
      await screen.findByText("Tuyệt vời! Bé đã ghép đúng cả câu."),
    ).toBeInTheDocument();
    // Trailing queued shot "mây" was discarded by epoch advancement and NEVER sent!
    expect(sentTokens).toEqual([tokenIds.second]);
  });

  it("reuses a single lazy AudioContext across shots, respects mute, suspends on android-background, and closes on unmount", async () => {
    const suspendSpy = vi.fn().mockResolvedValue(undefined);
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const createOscillatorSpy = vi.fn(() => ({
      type: "sine",
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as null | (() => void),
    }));
    const createGainSpy = vi.fn(() => ({
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    const AudioContextSpy = vi.fn(function MockAudioContext(
      this: Record<string, unknown>,
    ) {
      this.state = "running";
      this.currentTime = 0;
      this.destination = {};
      this.resume = vi.fn().mockResolvedValue(undefined);
      this.suspend = suspendSpy;
      this.close = closeSpy;
      this.createOscillator = createOscillatorSpy;
      this.createGain = createGainSpy;
    });
    vi.stubGlobal("AudioContext", AudioContextSpy);

    const user = userEvent.setup();
    const { unmount } = renderScreen();
    await user.click(
      await screen.findByRole("button", { name: /Sách xạ thủ/ }),
    );
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));

    await user.click(await screen.findByRole("button", { name: "sách." }));
    await screen.findByText("Thử lại nhé! Bé làm được mà!");
    await user.click(screen.getByRole("button", { name: "Bé" }));
    await screen.findByRole("listitem", { name: "Ô 1: Bé" });

    // Singleton AudioContext constructed EXACTLY ONCE across all shot + verdict sounds!
    expect(AudioContextSpy).toHaveBeenCalledTimes(1);
    expect(createOscillatorSpy.mock.calls.length).toBeGreaterThanOrEqual(4);

    // Mute stops further Web Audio scheduling
    const countBeforeMute = createOscillatorSpy.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Tắt âm thanh" }));
    await user.click(screen.getByRole("button", { name: "đọc" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([u]) =>
          new URL(String(u)).pathname.endsWith("/shots"),
        ).length,
      ).toBe(3),
    );
    expect(createOscillatorSpy.mock.calls.length).toBe(countBeforeMute);

    // Android background event suspends the singleton context cleanly
    document.dispatchEvent(new Event("viread:android-background"));
    expect(suspendSpy).toHaveBeenCalledTimes(1);

    // Unmount closes the singleton context cleanly
    unmount();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("supports learning mode selector, renders GRAMMAR_FOCUS prompt slots, grammar_tip pill, difficult-word badge, and post-round readout", async () => {
    const grammarSession = {
      ...session,
      learning_mode: "GRAMMAR_FOCUS" as const,
      practiced_difficult_words: ["truyện"],
      round: {
        round_id: roundId,
        round_number: 1,
        token_count: 1,
        learning_mode: "GRAMMAR_FOCUS" as const,
        prompt_hint: "Chọn từ có dấu câu kết thúc phù hợp nhé!",
        practiced_difficult_words: ["truyện"],
        prompt_slots: [
          { position: 0, text: "Bé", is_blank: false },
          { position: 1, text: "đọc", is_blank: false },
          { position: 2, text: null, is_blank: true },
        ],
        tokens: [
          { id: tokenIds.first, text: "truyện!" },
          { id: tokenIds.second, text: "truyện?" },
          { id: tokenIds.third, text: "truyện," },
        ],
      },
    };

    let createBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/sentence-shooter/books") {
        return Response.json([book]);
      }
      if (path === "/games/sentence-shooter/sessions") {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(grammarSession, { status: 201 });
      }
      if (
        path === `/games/sentence-shooter/sessions/${TEST_SESSION_ID}/shots`
      ) {
        return Response.json({
          is_correct: true,
          correct_count: 1,
          token_count: 1,
          mistakes_total: 0,
          completed_rounds: 1,
          total_stars: 3,
          round_completed: true,
          session_completed: false,
          next_expected_position: 1,
          stars_awarded: 3,
          score: 25,
          completed_sentence: "Bé đọc truyện!",
          grammar_tip:
            "Dấu chấm than (!) đặt cuối câu thể hiện cảm xúc vui mừng hoặc ngạc nhiên.",
          practiced_difficult_words: ["truyện"],
          learning_mode: "GRAMMAR_FOCUS",
          next_round: null,
          message: "Hoàn thành câu! Tuyệt lắm!",
        });
      }
      if (path.startsWith("/speech")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup();
    renderScreen();

    // All 3 learning mode buttons are visible in lobby
    expect(
      await screen.findByRole("button", { name: /Xếp thứ tự từ/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Điền từ vào chỗ trống/ }),
    ).toBeInTheDocument();
    const grammarBtn = screen.getByRole("button", { name: /Luyện ngữ pháp/ });
    await user.click(grammarBtn);
    expect(grammarBtn).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: /Sách xạ thủ/ }));
    await user.click(screen.getByRole("button", { name: /Bắt đầu chơi/ }));

    expect(createBody).toMatchObject({
      learning_mode: "GRAMMAR_FOCUS",
      book_id: TEST_BOOK_ID,
      difficulty: "easy",
    });

    // Prompt slots + difficult-word badge render cleanly
    expect(
      await screen.findByText("Chọn từ có dấu câu kết thúc phù hợp nhé!"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("difficult-word-badge")).toHaveTextContent(
      "Có từ bé đang luyện",
    );

    // Shoot correct grammar token -> shows grammar_tip pill, practiced words, and readout button
    await user.click(screen.getByRole("button", { name: "truyện!" }));
    expect(await screen.findByTestId("grammar-tip-pill")).toHaveTextContent(
      "Dấu chấm than (!)",
    );
    expect(screen.getByTestId("practiced-difficult-words")).toHaveTextContent(
      "truyện",
    );
    const readAgainBtn = screen.getByRole("button", {
      name: /Nghe lại câu hoàn chỉnh/,
    });
    expect(readAgainBtn).toBeEnabled();
    await user.click(readAgainBtn);
  });
});
