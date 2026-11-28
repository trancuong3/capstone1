import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(
      screen.getByRole("link", {
        name: `${second.alias}, lớp ${second.grade}`,
      }),
    ).toHaveAttribute("href", `/children/${second.id}`);
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

  it("paginates 10 child profiles at 6 per page and preserves profile links", async () => {
    const manyChildren = Array.from({ length: 10 }, (_, index) => ({
      ...childFixture,
      id: `11000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      alias: `Bé thứ ${index + 1}`,
      grade: (index % 5) + 1,
    }));
    apiFetchFixture.mockResolvedValueOnce(Response.json(manyChildren));

    const user = userEvent.setup();
    renderChildren();

    expect(await screen.findByText("Bé thứ 1")).toBeInTheDocument();
    expect(screen.getByText("Bé thứ 6")).toBeInTheDocument();
    expect(screen.queryByText("Bé thứ 7")).not.toBeInTheDocument();

    const pagination = screen.getByRole("navigation", { name: /Hồ sơ bé/i });
    expect(pagination).toHaveTextContent("Trang 1 / 2");
    expect(pagination).toHaveTextContent("1–6 / 10");

    await user.click(within(pagination).getByRole("button", { name: /Tiếp/ }));
    expect(screen.getByText("Bé thứ 7")).toBeInTheDocument();
    expect(screen.getByText("Bé thứ 10")).toBeInTheDocument();
    expect(screen.queryByText("Bé thứ 1")).not.toBeInTheDocument();
    expect(pagination).toHaveTextContent("Trang 2 / 2");
    expect(
      screen.getByRole("link", { name: "Bé thứ 10, lớp 5" }),
    ).toHaveAttribute("href", `/children/${manyChildren[9]!.id}`);

    await user.click(within(pagination).getByRole("button", { name: /Trước/ }));
    expect(screen.getByText("Bé thứ 1")).toBeInTheDocument();
    expect(screen.queryByText("Bé thứ 10")).not.toBeInTheDocument();
  });
});
