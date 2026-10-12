import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildrenListScreen } from "@/components/children/children-list-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
  requestedApiUrl,
} from "@/test/fixtures/api-test-fixture";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";

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
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));
beforeEach(() => installApiFetchFixture());
afterEach(() => vi.unstubAllGlobals());

function renderChildren() {
  return render(
    <AppServicesProvider>
      <ChildrenListScreen />
    </AppServicesProvider>,
  );
}
describe("ChildrenListScreen with real API responses", () => {
  it("shows the child profiles returned by the authenticated parent's endpoint", async () => {
    const second = {
      ...childFixture,
      id: "11000000-0000-4000-8000-000000000003",
      alias: "Bé thứ hai",
      grade: 4,
    };
    apiFetchFixture.mockResolvedValueOnce(
      Response.json([childFixture, second]),
    );
    renderChildren();
    expect(await screen.findByText(childFixture.alias)).toBeInTheDocument();
    expect(screen.getByText(second.alias)).toBeInTheDocument();
    expect(screen.getAllByText("Xem và chỉnh sửa")).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: new RegExp(childFixture.alias) }),
    ).toHaveAttribute("href", `/children/${TEST_CHILD_ID}`);
    expect(requestedApiUrl().pathname).toBe("/profiles/children");
  });
  it("shows the empty state and create action for an empty response", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json([]));
    renderChildren();
    expect(
      await screen.findByRole("heading", { name: "Chưa có hồ sơ bé" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Tạo hồ sơ đầu tiên" }),
    ).toHaveAttribute("href", "/children/new");
  });
  it("keeps service failures generic", async () => {
    apiFetchFixture.mockRejectedValueOnce(
      new Error("Private database details"),
    );
    renderChildren();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(alert).not.toHaveTextContent("Private database details");
  });
  it("exposes loading until the response arrives", async () => {
    let settle: (response: Response) => void = () => undefined;
    apiFetchFixture.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    renderChildren();
    expect(screen.getByRole("status")).toHaveTextContent("Đang tải");
    // Wait for authentication/header creation before completing the HTTP request.
    await waitFor(() => expect(apiFetchFixture).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
      settle(Response.json([]));
    });
    expect(
      await screen.findByRole("heading", { name: "Chưa có hồ sơ bé" }),
    ).toBeInTheDocument();
  });
});
