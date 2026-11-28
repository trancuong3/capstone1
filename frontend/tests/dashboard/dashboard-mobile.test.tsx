import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
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

function installMatchMediaController(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.add(listener);
      },
      removeEventListener: (
        _event: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => true,
    })),
  );

  return {
    setMobile(nextMatches: boolean) {
      matches = nextMatches;
      for (const listener of listeners) {
        listener({
          matches: nextMatches,
          media: "(max-width: 767px)",
        } as MediaQueryListEvent);
      }
    },
  };
}

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
      latest_sessions_by_child: {
        [childFixture.id]: {
          id: "session-finished-1",
          child_id: childFixture.id,
          book_id: "book-finished-1",
          book_title: "Dế Mèn Phiêu Lưu Ký",
          state: "FINISHED",
          started_at: "2026-11-24T09:00:00Z",
          ended_at: "2026-11-24T09:20:00Z",
          resumable: false,
        },
        [secondChild.id]: {
          id: "session-resume-2",
          child_id: secondChild.id,
          book_id: "book-resume-2",
          book_title: "Chú Mèo Đi Hia",
          state: "IN_PROGRESS",
          started_at: "2026-11-25T09:00:00Z",
          ended_at: null,
          resumable: true,
        },
      },
    });
  }
  throw new Error(`Unexpected dashboard route: ${path}`);
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

describe("MobileDashboard (< 768px)", () => {
  beforeEach(() => {
    clearUserCache();
    window.sessionStorage.clear();
    installApiFetchFixture();
    routerPushMock.mockReset();
    routerReplaceMock.mockReset();
    for (const key of [...searchParamsMock.keys()]) {
      searchParamsMock.delete(key);
    }
  });

  afterEach(() => {
    clearUserCache();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders a dedicated airy mobile layout with >=44px touch targets and zero desktop desk image chrome", async () => {
    installMatchMediaController(true);
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    const user = userEvent.setup();

    const { container } = renderDashboard();

    expect(
      await screen.findByRole("heading", { name: "Góc đọc gia đình" }),
    ).toBeInTheDocument();

    expect(container.querySelector(".family-dashboard")).toBeNull();
    expect(container.querySelector(".desk-illustration")).toBeNull();

    const manageProfiles = screen.getByRole("link", { name: "Quản lý hồ sơ" });
    expect(manageProfiles.className).toContain("min-h-11");

    const createChild = screen.getByRole("link", { name: "Tạo hồ sơ bé" });
    expect(createChild.className).toContain("min-h-11");

    const historyLink = screen.getByRole("link", { name: "Lịch sử đọc" });
    expect(historyLink.className).toContain("min-h-11");

    const scanBtn = screen.getByRole("button", { name: "Quét sách" });
    const entBtn = screen.getByRole("button", { name: "Trò chơi và âm nhạc" });
    expect(scanBtn.className).toContain("min-h-[68px]");
    expect(entBtn.className).toContain("min-h-[68px]");

    // Select first child (finished session -> touch-safe recent link)
    await user.click(
      screen.getByRole("button", {
        name: `${childFixture.alias}, lớp ${childFixture.grade}`,
      }),
    );
    const recentLink = await screen.findByRole("link", {
      name: /Lần đọc gần nhất · Dế Mèn Phiêu Lưu Ký/,
    });
    expect(recentLink.className).toContain("min-h-11");
    expect(recentLink).toHaveAttribute(
      "href",
      `/sessions/session-finished-1?childId=${encodeURIComponent(childFixture.id)}`,
    );

    // Select second child (resumable session -> primary CTA + touch-safe Chọn sách)
    await user.click(
      screen.getByRole("button", {
        name: `${secondChild.alias}, lớp ${secondChild.grade}`,
      }),
    );
    const resumeLink = screen.getByRole("link", { name: /Đọc tiếp/ });
    expect(resumeLink.className).toContain("min-h-12");
    expect(resumeLink).toHaveAttribute("href", "/reading/session-resume-2");
    const chooseBookBtn = screen.getByRole("button", { name: "Chọn sách" });
    expect(chooseBookBtn.className).toContain("min-h-11");

    await user.click(scanBtn);
    expect(routerPushMock).toHaveBeenCalledWith("/book-scanner");
    await user.click(entBtn);
    expect(routerPushMock).toHaveBeenCalledWith("/entertainment");
  });

  it("gates actions when no child is selected and keeps loading/empty/error states clean", async () => {
    installMatchMediaController(true);
    const user = userEvent.setup();

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    apiFetchFixture.mockImplementation(async (input) => {
      await gate;
      return readyResponse(input);
    });

    renderDashboard();
    expect(screen.getByRole("status")).toHaveTextContent("Đang tải");
    expect(
      screen.getByRole("region", { name: "Chọn hồ sơ trẻ" }),
    ).toHaveAttribute("aria-busy", "true");

    await act(async () => release());
    await screen.findByRole("button", {
      name: `${childFixture.alias}, lớp ${childFixture.grade}`,
    });

    await user.click(screen.getByRole("button", { name: "Chọn sách" }));
    expect(screen.getByRole("region", { name: "Chọn hồ sơ trẻ" })).toHaveClass(
      "family-profiles-prompt",
    );
    expect(routerPushMock).not.toHaveBeenCalled();

    // Error state retry button has explicit w-full sm:w-auto
    clearUserCache();
    apiFetchFixture.mockRejectedValueOnce(new Error("boom"));
    renderDashboard();
    const retryBtn = await screen.findByRole("button", { name: "Thử lại" });
    expect(retryBtn.className).toContain("w-full");
    expect(retryBtn.className).toContain("sm:w-auto");
  });

  it("switches cleanly between MobileDashboard and DesktopDashboard when matchMedia changes", async () => {
    const media = installMatchMediaController(true);
    const cachedSummary: DashboardSummaryDTO = {
      profile,
      children: [childFixture],
      latest_sessions_by_child: {},
      source: "dashboard-summary",
    };
    writeUserCache(profile.id, "dashboard-summary", cachedSummary);
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));

    const { container } = renderDashboard(profile.id);
    expect(container.querySelector(".family-dashboard")).toBeNull();
    expect(
      screen.getAllByRole("heading", { name: "Góc đọc gia đình" }),
    ).toHaveLength(1);

    act(() => {
      media.setMobile(false);
    });
    expect(container.querySelector(".family-dashboard")).not.toBeNull();
    expect(
      screen.getAllByRole("heading", { name: "Góc đọc gia đình" }),
    ).toHaveLength(1);
  });
});
