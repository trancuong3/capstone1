import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const childId = "11111111-1111-4111-8111-111111111111";
const child = {
  id: childId,
  parent_id: "99999999-9999-4999-8999-999999999999",
  alias: "Bé An",
  grade: 2,
  settings: {},
  created_at: "2026-10-01T00:00:00Z",
};
const fetchMock = vi.fn();
beforeEach(() => {
  replaceMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === `/profiles/children/${childId}`)
        return Response.json(child);
      if (url.pathname === "/books/catalog") return Response.json([]);
      if (
        url.pathname === "/reading-management/goals" &&
        init?.method === "POST"
      )
        return Response.json({ detail: "write failed" }, { status: 500 });
      if (url.pathname.startsWith("/reading-management/"))
        return Response.json([]);
      throw new Error("Unexpected API route: " + url.pathname);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderScreen() {
  return render(
    <WithSelectedChild childId={childId}>
      <AppServicesProvider>
        <ReadingManagementScreen />
      </AppServicesProvider>
    </WithSelectedChild>,
  );
}

describe("ReadingManagementScreen backed by HTTP API adapter", () => {
  it("loads goal, collection, and reminder data for the selected child and shows empty states", async () => {
    renderScreen();
    expect(
      await screen.findByRole("heading", { name: "Quản lý đọc sách" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Mục tiêu đọc" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Đang quản lý hồ sơ của/),
    ).toHaveTextContent("Bé An · Lớp 2");
    expect(
      screen.getByRole("link", { name: "Đổi hồ sơ tại Tổng quan" }),
    ).toHaveAttribute(
      "href",
      "/dashboard?focus=child-selection&reason=change",
    );
    expect(screen.queryByLabelText("Hồ sơ bé")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Kế hoạch đọc trong tuần" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Bé chưa có mục tiêu đọc nào."),
    ).toBeInTheDocument();
    expect(screen.getByText("Chưa có lịch nhắc nào.")).toBeInTheDocument();
    await waitFor(() => {
      const requests = fetchMock.mock.calls.map(
        ([url]) => new URL(String(url)).pathname,
      );
      expect(requests).toContain("/reading-management/goals");
      expect(requests).toContain("/reading-management/plans");
      expect(requests).toContain("/reading-management/collections");
      expect(requests).toContain("/reading-management/reminders");
    });
  });


  it("returns to Dashboard instead of selecting the first child when no profile is selected", async () => {
    render(
      <AppStoreProvider>
        <AppServicesProvider>
          <ReadingManagementScreen />
        </AppServicesProvider>
      </AppStoreProvider>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        "/dashboard?focus=child-selection&reason=missing",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Đang xác minh hồ sơ đã chọn…",
    );
    expect(screen.queryByLabelText("Hồ sơ bé")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => new URL(String(url)).pathname.startsWith("/reading-management/"),
      ),
    ).toBe(false);
  });

  it("does not show success when the backend rejects goal creation", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("heading", { name: "Mục tiêu đọc" });
    await user.click(screen.getByRole("button", { name: "Tạo mục tiêu" }));
    expect(
      await screen.findByText(/Không thực hiện được thao tác/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Đã lưu mục tiêu đọc.")).not.toBeInTheDocument();
  });
});
