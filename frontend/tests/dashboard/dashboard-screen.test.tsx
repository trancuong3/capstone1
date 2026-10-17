import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardScreen } from "@/components/dashboard/dashboard-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));
beforeEach(() => installApiFetchFixture());
afterEach(() => vi.unstubAllGlobals());

const profile: ParentProfileDTO = {
  id: childFixture.parent_id,
  display_name: "Ba mẹ kiểm thử",
  role: "parent",
  created_at: childFixture.created_at,
};
function readyResponse(input: RequestInfo | URL, empty = false) {
  const path = new URL(String(input)).pathname;
  if (path === "/profiles/me") return Response.json(profile);
  if (path === "/profiles/children")
    return Response.json(empty ? [] : [childFixture]);
  throw new Error("Unexpected isolated dashboard route");
}
function renderDashboard() {
  return render(
    <AppServicesProvider>
      <DashboardScreen />
    </AppServicesProvider>,
  );
}
describe("DashboardScreen with real API adapters", () => {
  it("shows the returned parent name, child profile and book navigation", async () => {
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    renderDashboard();
    expect(
      await screen.findByRole("heading", { name: /Chào Ba mẹ kiểm thử/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: `${childFixture.alias}, lớp ${childFixture.grade}`,
      }),
    ).toHaveAttribute("href", `/books?childId=${TEST_CHILD_ID}`);
    expect(screen.getByRole("link", { name: "Chọn sách" })).toHaveAttribute(
      "href",
      "/books",
    );
    expect(screen.getByRole("link", { name: "Tạo hồ sơ bé" })).toHaveAttribute(
      "href",
      "/children/new",
    );
    expect(apiFetchFixture).toHaveBeenCalledTimes(2);
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
    await act(async () => {
      release();
    });
    expect(
      await screen.findByRole("heading", { name: /Chào Ba mẹ kiểm thử/i }),
    ).toBeInTheDocument();
  });
});
