import { act, render, screen, waitFor } from "@testing-library/react";
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
    expect(
      screen.getByRole("button", { name: "Quét sách" }),
    ).toBeInTheDocument();
  });

  it("renders mobile shortcuts, responsive 640px grid overrides, and zero legacy sm:/max-sm: classes", async () => {
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    const user = userEvent.setup();
    const { container } = renderDashboard();

    const firstProfile = await screen.findByRole("button", {
      name: `${childFixture.alias}, lớp ${childFixture.grade}`,
    });
    await user.click(firstProfile);

    const progressLinks = screen.getAllByRole("link", { name: /Xem tiến bộ/ });
    const mobileProgressShortcut = progressLinks.find((el) =>
      el.closest(".md\\:hidden"),
    );
    const difficultShortcut = screen.getByRole("link", {
      name: "Từ cần luyện",
    });

    expect(mobileProgressShortcut).toBeDefined();
    expect(mobileProgressShortcut).toHaveAttribute(
      "href",
      `/reports?childId=${encodeURIComponent(childFixture.id)}`,
    );
    expect(mobileProgressShortcut?.className).toContain("min-h-11");
    expect(difficultShortcut).toHaveAttribute(
      "href",
      `/reports/difficult-words?childId=${encodeURIComponent(childFixture.id)}`,
    );
    expect(difficultShortcut.className).toContain("min-h-11");

    const profileList = container.querySelector(".family-profile-list");
    expect(profileList?.className).toContain("min-[640px]:max-md:grid!");
    expect(profileList?.className).toContain("min-[640px]:max-md:grid-cols-2!");
    expect(profileList?.className).not.toContain(
      "md:grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))]!",
    );
    expect(profileList?.className).not.toContain("min-[921px]:grid-cols-1!");

    const toolList = container.querySelector(".family-tool-list");
    expect(toolList?.className).toContain("min-[640px]:grid-cols-2!");
    expect(toolList?.className).toContain("md:grid-cols-3!");

    const createChildLink = screen.getByRole("link", {
      name: "Tạo hồ sơ bé",
    });
    expect(createChildLink.className).toContain("md:min-h-12!");

    expect(container.innerHTML).not.toMatch(/\b(?:max-)?sm:/);
  });
});
