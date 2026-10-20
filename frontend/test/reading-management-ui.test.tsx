import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReadingManagementScreen } from "@/components/reading-management/reading-management-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
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
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/profiles/children") return Response.json([child]);
      if (url.pathname === "/books/catalog") return Response.json([]);
      if (url.pathname === "/reading-management/reminders/email-status")
        return Response.json({ provider_configured: false, sender_configured: false, app_url_configured: false, auth_admin_configured: false, email_available: false, email_verified: null, ready: false });
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
    <AppServicesProvider>
      <ReadingManagementScreen />
    </AppServicesProvider>,
  );
}

describe("ReadingManagementScreen backed by HTTP API adapter", () => {
  it("loads goal, collection, and reminder data for the selected child and shows empty states", async () => {
    renderScreen();
    expect(
      await screen.findByRole("heading", { name: "Quản lý đọc sách" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Kế hoạch và mục tiêu đọc" }),
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
      expect(requests).toContain("/reading-management/collections");
      expect(requests).toContain("/reading-management/reminders");
    });
  });

  it("does not show success when the backend rejects goal creation", async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("heading", { name: "Kế hoạch và mục tiêu đọc" });
    await user.click(screen.getByRole("button", { name: "Tạo mục tiêu" }));
    expect(
      await screen.findByText(/Không thực hiện được thao tác/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Đã lưu mục tiêu đọc.")).not.toBeInTheDocument();
  });
});
