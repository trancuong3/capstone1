import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import { clearUserCache, writeUserCache } from "@/lib/cache/user-query-cache";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import { childFixture } from "@/test/fixtures/report-data-fixture";
import type { DashboardSummaryDTO, ParentProfileDTO } from "@/types/profile";

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
const { routerPushMock, routerReplaceMock, searchParamsMock } = vi.hoisted(
  () => ({
    routerPushMock: vi.fn(),
    routerReplaceMock: vi.fn(),
    searchParamsMock: new URLSearchParams(),
  }),
);
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: routerReplaceMock,
    prefetch: vi.fn(),
  }),
  useSearchParams: () => searchParamsMock,
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));
beforeEach(() => {
  clearUserCache();
  window.sessionStorage.clear();
  installApiFetchFixture();
  routerPushMock.mockReset();
  routerReplaceMock.mockReset();
  for (const key of [...searchParamsMock.keys()]) {
    searchParamsMock.delete(key);
  }
  routerReplaceMock.mockImplementation((href: string) => {
    const nextSearchParams = new URL(href, "http://localhost").searchParams;
    for (const key of [...searchParamsMock.keys()]) {
      searchParamsMock.delete(key);
    }
    nextSearchParams.forEach((value, key) => searchParamsMock.set(key, value));
  });
});
afterEach(() => {
  clearUserCache();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

const secondChild = {
  ...childFixture,
  id: "41ee0744-5a14-4d2c-bcbc-4cd566e1e4c5",
  alias: "Bé Na",
  grade: 2,
};
const profile: ParentProfileDTO = {
  id: childFixture.parent_id,
  display_name: "Ba mẹ kiểm thử",
  role: "parent",
  created_at: childFixture.created_at,
  email: "parent@example.com",
  contact_phone: null,
  pending_email: null,
  email_verified: null,
  contact_info_status: "not_configured",
  children: [],
};
function readyResponse(input: RequestInfo | URL, empty = false) {
  const path = new URL(String(input)).pathname;
  if (path === "/profiles/dashboard-summary") {
    return Response.json({
      profile,
      children: empty ? [] : [childFixture, secondChild],
      latest_sessions_by_child: {},
    });
  }
  if (path === "/profiles/me") return Response.json(profile);
  if (path === "/profiles/children")
    return Response.json(empty ? [] : [childFixture, secondChild]);
  throw new Error(`Unexpected isolated dashboard route: ${path}`);
}
function renderDashboard(userId?: string) {
  const tree = (
    <AppStoreProvider>
      <AppServicesProvider>
        <DashboardScreen />
      </AppServicesProvider>
    </AppStoreProvider>
  );
  if (!userId) return render(tree);
  return render(
    <AuthRuntimeContext.Provider
      value={{
        initializationFailure: null,
        isPasswordRecovery: false,
        lastEvent: "SIGNED_IN",
        mode: "supabase",
        status: "ready",
        session: {
          expires_at: null,
          user: {
            id: userId,
            email: "parent@example.com",
            display_name: "Ba mẹ kiểm thử",
          },
        },
      }}
    >
      {tree}
    </AuthRuntimeContext.Provider>,
  );
}

describe("DashboardScreen with real API adapters", () => {
  it("selects exactly one child without navigating and exposes separate reading actions", async () => {
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    const user = userEvent.setup();
    renderDashboard();
    expect(
      await screen.findByRole("heading", {
        name: "Góc đọc gia đình",
      }),
    ).toBeInTheDocument();

    const firstProfile = await screen.findByRole("button", {
      name: `${childFixture.alias}, lớp ${childFixture.grade}`,
    });
    const secondProfile = screen.getByRole("button", {
      name: `${secondChild.alias}, lớp ${secondChild.grade}`,
    });
    expect(firstProfile).toHaveAttribute("aria-pressed", "false");
    expect(secondProfile).toHaveAttribute("aria-pressed", "false");

    await user.click(firstProfile);
    expect(firstProfile).toHaveAttribute("aria-pressed", "true");
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        `Mở tủ sách và chọn một cuốn cho ${childFixture.alias}.`,
      ),
    ).toBeInTheDocument();

    await user.click(secondProfile);
    expect(firstProfile).toHaveAttribute("aria-pressed", "false");
    expect(secondProfile).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(`Mở tủ sách và chọn một cuốn cho ${secondChild.alias}.`),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quét sách" }));
    await user.click(screen.getByRole("button", { name: "Chọn sách" }));
    expect(routerPushMock).toHaveBeenNthCalledWith(1, "/book-scanner");
    expect(routerPushMock).toHaveBeenNthCalledWith(2, "/books");
    await user.click(
      screen.getByRole("button", { name: "Trò chơi và âm nhạc" }),
    );
    expect(routerPushMock).toHaveBeenNthCalledWith(3, "/entertainment");
    expect(screen.getByRole("link", { name: "Tạo hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children/new",
    );
  });

  it("blocks both reading actions and guides the parent when no child is selected", async () => {
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByRole("button", {
      name: `${childFixture.alias}, lớp ${childFixture.grade}`,
    });

    await user.click(screen.getByRole("button", { name: "Quét sách" }));
    expect(
      screen.getByText(
        "Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc hoặc chơi.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Chọn hồ sơ của bé để mở tủ sách riêng."),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Chọn hồ sơ trẻ" })).toHaveClass(
      "family-profiles-prompt",
    );
    expect(routerPushMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Chọn sách" }));
    expect(routerPushMock).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Trò chơi và âm nhạc" }),
    );
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc hoặc chơi.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the first-child action for a real empty account", async () => {
    apiFetchFixture.mockImplementation(async (input) =>
      readyResponse(input, true),
    );
    renderDashboard();
    expect(
      await screen.findByText(/Gia đình mình chưa có hồ sơ bé/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Tạo hồ sơ đầu tiên" }),
    ).toHaveAttribute("href", "/children/new");
  });

  it("clears a selected child that is no longer returned by the authenticated list", async () => {
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    function SeedMissingSelection() {
      const { selectChild } = useAppStore();
      useEffect(() => selectChild("missing-child"), [selectChild]);
      return null;
    }
    render(
      <AppStoreProvider>
        <SeedMissingSelection />
        <AppServicesProvider>
          <DashboardScreen />
        </AppServicesProvider>
      </AppStoreProvider>,
    );
    await screen.findByRole("heading", {
      name: "Góc đọc gia đình",
    });
    expect(
      await screen.findByText(/Hồ sơ đã thay đổi hoặc không còn khả dụng/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `${childFixture.alias}, lớp ${childFixture.grade}`,
      }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps service errors generic", async () => {
    apiFetchFixture.mockRejectedValue(new Error("Private database details"));
    renderDashboard();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(alert).not.toHaveTextContent("Private database details");
  });

  it("renders dashboard chrome immediately with an accessible inline loading status until summary arrives", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    apiFetchFixture.mockImplementation(async (input) => {
      await pending;
      return readyResponse(input);
    });
    renderDashboard();
    expect(
      screen.getByRole("heading", { name: "Góc đọc gia đình" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Đang tải");
    await waitFor(() => expect(apiFetchFixture).toHaveBeenCalledTimes(1));
    await act(async () => release());
    expect(
      await screen.findByRole("button", {
        name: `${childFixture.alias}, lớp ${childFixture.grade}`,
      }),
    ).toBeInTheDocument();
  });

  it("renders SWR-cached summary immediately and refreshes with 1 dashboard-summary call", async () => {
    const cachedSummary: DashboardSummaryDTO = {
      profile,
      children: [childFixture],
      latest_sessions_by_child: {
        [childFixture.id]: {
          id: "session-resume-1",
          child_id: childFixture.id,
          book_id: "book-1",
          book_title: "Chú Mèo Đi Hia",
          state: "IN_PROGRESS",
          started_at: "2026-11-25T09:00:00Z",
          ended_at: null,
          resumable: true,
        },
      },
      source: "dashboard-summary",
    };
    writeUserCache(profile.id, "dashboard-summary", cachedSummary);

    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    apiFetchFixture.mockImplementation(async (input) => {
      await refreshGate;
      return readyResponse(input);
    });

    const user = userEvent.setup();
    renderDashboard(profile.id);

    // Cached child profile is visible immediately without waiting for network.
    const cachedChildButton = screen.getByRole("button", {
      name: `${childFixture.alias}, lớp ${childFixture.grade}`,
    });
    expect(cachedChildButton).toBeInTheDocument();

    await user.click(cachedChildButton);
    expect(
      screen.getByRole("heading", { name: "Chú Mèo Đi Hia" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Đọc tiếp/ })).toHaveAttribute(
      "href",
      "/reading/session-resume-1",
    );

    await act(async () => releaseRefresh());
    await screen.findByRole("button", {
      name: `${secondChild.alias}, lớp ${secondChild.grade}`,
    });
    expect(apiFetchFixture).toHaveBeenCalledTimes(1);
    expect(new URL(String(apiFetchFixture.mock.calls[0]?.[0])).pathname).toBe(
      "/profiles/dashboard-summary",
    );
  });

  it("falls back cleanly to /profiles/me and /profiles/children when /profiles/dashboard-summary returns 404", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/profiles/dashboard-summary") {
        return Response.json({ detail: "Not Found" }, { status: 404 });
      }
      if (path === "/profiles/me") return Response.json(profile);
      if (path === "/profiles/children") {
        return Response.json([childFixture, secondChild]);
      }
      throw new Error(`Unexpected route: ${path}`);
    });

    renderDashboard();
    expect(
      await screen.findByRole("button", {
        name: `${childFixture.alias}, lớp ${childFixture.grade}`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `${secondChild.alias}, lớp ${secondChild.grade}`,
      }),
    ).toBeInTheDocument();
  });

  it("paginates 10 children at 4 per page, syncs to a pre-selected child's page, and lets parent browse other pages", async () => {
    const manyChildren = Array.from({ length: 10 }, (_, index) => ({
      ...childFixture,
      id: `41ee0744-5a14-4d2c-bcbc-${String(index + 1).padStart(12, "0")}`,
      alias: `Bé số ${index + 1}`,
      grade: (index % 5) + 1,
    }));

    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/profiles/dashboard-summary") {
        return Response.json({
          profile,
          children: manyChildren,
          latest_sessions_by_child: {},
        });
      }
      throw new Error(`Unexpected route: ${path}`);
    });

    const user = userEvent.setup();
    renderDashboard();

    // Page 1 shows children 1..4 only (never stretching the sidebar with all 10)
    expect(
      await screen.findByRole("button", { name: "Bé số 1, lớp 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Bé số 4, lớp 4" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Bé số 5, lớp 5" }),
    ).not.toBeInTheDocument();

    const pagination = screen.getByRole("navigation", {
      name: /Hồ sơ bé/i,
    });
    expect(pagination).toHaveTextContent("Trang 1 / 3");
    expect(pagination).toHaveTextContent("1–4 / 10");

    // Navigate to page 2 -> shows children 5..8, select child #6
    await user.click(within(pagination).getByRole("button", { name: /Tiếp/ }));
    expect(
      screen.getByRole("button", { name: "Bé số 5, lớp 5" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Bé số 1, lớp 1" }),
    ).not.toBeInTheDocument();
    expect(pagination).toHaveTextContent("Trang 2 / 3");

    const child6Btn = screen.getByRole("button", { name: "Bé số 6, lớp 1" });
    await user.click(child6Btn);
    expect(child6Btn).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("Mở tủ sách và chọn một cuốn cho Bé số 6."),
    ).toBeInTheDocument();

    // Navigate to page 3 -> shows children 9..10 and does not snap back to page 2
    await user.click(within(pagination).getByRole("button", { name: /Tiếp/ }));
    expect(pagination).toHaveTextContent("Trang 3 / 3");
    expect(
      screen.getByRole("button", { name: "Bé số 9, lớp 4" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Bé số 10, lớp 5" }),
    ).toBeInTheDocument();
  });

  it("opens on the page containing a pre-selected child and clamps safely if children shrink", async () => {
    const manyChildren = Array.from({ length: 10 }, (_, index) => ({
      ...childFixture,
      id: `52ee0744-5a14-4d2c-bcbc-${String(index + 1).padStart(12, "0")}`,
      alias: `Bé mẫu ${index + 1}`,
      grade: (index % 5) + 1,
    }));
    const preselected = manyChildren[8]!; // child #9 -> page 3

    const cachedSummary: DashboardSummaryDTO = {
      profile,
      children: manyChildren,
      latest_sessions_by_child: {},
      source: "dashboard-summary",
    };
    writeUserCache(profile.id, "dashboard-summary", cachedSummary);

    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/profiles/dashboard-summary") {
        await refreshGate;
        // Shrink list to first 2 children on network refresh (preselected removed? keep 3 children including none on page 3)
        return Response.json({
          profile,
          children: manyChildren.slice(0, 3),
          latest_sessions_by_child: {},
        });
      }
      throw new Error(`Unexpected route: ${path}`);
    });

    function SeedChild9() {
      const { selectChild } = useAppStore();
      useEffect(() => selectChild(preselected.id), [selectChild]);
      return null;
    }

    const user = userEvent.setup();
    render(
      <AuthRuntimeContext.Provider
        value={{
          initializationFailure: null,
          isPasswordRecovery: false,
          lastEvent: "SIGNED_IN",
          mode: "supabase",
          status: "ready",
          session: {
            expires_at: null,
            user: {
              id: profile.id,
              email: "parent@example.com",
              display_name: "Ba mẹ kiểm thử",
            },
          },
        }}
      >
        <AppStoreProvider>
          <SeedChild9 />
          <AppServicesProvider>
            <DashboardScreen />
          </AppServicesProvider>
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );

    // Opens directly on page 3 where child #9 lives
    expect(
      await screen.findByRole("button", { name: "Bé mẫu 9, lớp 4" }),
    ).toHaveAttribute("aria-pressed", "true");
    const pagination = screen.getByRole("navigation", { name: /Hồ sơ bé/i });
    expect(pagination).toHaveTextContent("Trang 3 / 3");

    // Parent can browse back to page 2 without snapping back to page 3
    await user.click(within(pagination).getByRole("button", { name: /Trước/ }));
    expect(pagination).toHaveTextContent("Trang 2 / 3");
    expect(
      screen.getByRole("button", { name: "Bé mẫu 5, lớp 5" }),
    ).toBeInTheDocument();

    // When refreshed list shrinks to 3 children, page clamps safely to page 1 and pagination hides
    await act(async () => releaseRefresh());
    expect(
      await screen.findByRole("button", { name: "Bé mẫu 1, lớp 1" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: /Hồ sơ bé/i }),
    ).not.toBeInTheDocument();
  });
});
