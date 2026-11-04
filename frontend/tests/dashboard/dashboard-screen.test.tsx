import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import { childFixture } from "@/test/fixtures/report-data-fixture";
import type { ParentProfileDTO } from "@/types/profile";

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
afterEach(() => vi.unstubAllGlobals());

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
  if (path === "/profiles/me") return Response.json(profile);
  if (path === "/profiles/children")
    return Response.json(empty ? [] : [childFixture, secondChild]);
  throw new Error("Unexpected isolated dashboard route");
}
function renderDashboard() {
  return render(
    <AppStoreProvider>
      <AppServicesProvider>
        <DashboardScreen />
      </AppServicesProvider>
    </AppStoreProvider>,
  );
}
describe("DashboardScreen with real API adapters", () => {
  it("selects exactly one child without navigating and exposes separate reading actions", async () => {
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    const user = userEvent.setup();
    renderDashboard();
    expect(
      await screen.findByRole("heading", { name: /Chào Ba mẹ kiểm thử/i }),
    ).toBeInTheDocument();

    const firstProfile = screen.getByRole("button", {
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
        `Đang chọn: ${childFixture.alias} – Lớp ${childFixture.grade}`,
      ),
    ).toBeInTheDocument();

    await user.click(secondProfile);
    expect(firstProfile).toHaveAttribute("aria-pressed", "false");
    expect(secondProfile).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        `Đang chọn: ${secondChild.alias} – Lớp ${secondChild.grade}`,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quét sách" }));
    await user.click(screen.getByRole("button", { name: "Chọn sách" }));
    expect(routerPushMock).toHaveBeenNthCalledWith(1, "/book-scanner");
    expect(routerPushMock).toHaveBeenNthCalledWith(2, "/books");
    expect(screen.getByRole("link", { name: "Tạo hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children/new",
    );
  });

  it("blocks both reading actions and guides the parent when no child is selected", async () => {
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByRole("heading", { name: /Chào Ba mẹ kiểm thử/i });

    await user.click(screen.getByRole("button", { name: "Quét sách" }));
    expect(
      screen.getByText("Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc sách."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Chạm vào hồ sơ của bé bên dưới để chọn người sẽ đọc."),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Chọn hồ sơ trẻ" })).toHaveClass(
      "ring-4",
    );
    expect(routerPushMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Chọn sách" }));
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("Vui lòng chọn hồ sơ trẻ trước khi bắt đầu đọc sách."),
    ).toBeInTheDocument();
  });

  it("shows the first-child action for a real empty account", async () => {
    apiFetchFixture.mockImplementation(async (input) =>
      readyResponse(input, true),
    );
    renderDashboard();
    expect(
      await screen.findByRole("heading", {
        name: "Gia đình mình chưa có hồ sơ bé",
      }),
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
    await screen.findByRole("heading", { name: /Chào Ba mẹ kiểm thử/i });
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

  it("exposes an accessible loading state until both responses arrive", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    apiFetchFixture.mockImplementation(async (input) => {
      await pending;
      return readyResponse(input);
    });
    renderDashboard();
    expect(screen.getByRole("status")).toHaveTextContent("Đang tải");
    await waitFor(() => expect(apiFetchFixture).toHaveBeenCalledTimes(2));
    await act(async () => release());
    expect(
      await screen.findByRole("heading", { name: /Chào Ba mẹ kiểm thử/i }),
    ).toBeInTheDocument();
  });
});
