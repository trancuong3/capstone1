import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookDetailScreen } from "@/components/books/book-detail-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  bookFixture,
  childFixture,
  pagePreviewFixture,
  TEST_BOOK_ID,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
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

const secondPage = {
  ...pagePreviewFixture,
  page_id: "15000000-0000-4000-8000-000000000002",
  page_number: 2,
};
function readyResponse(input: RequestInfo | URL) {
  const path = new URL(String(input)).pathname;
  if (path === `/profiles/children/${TEST_CHILD_ID}`)
    return Response.json(childFixture);
  if (path === `/books/catalog/${TEST_BOOK_ID}`)
    return Response.json(bookFixture);
  if (path === `/books/catalog/${TEST_BOOK_ID}/preview`)
    return Response.json([pagePreviewFixture, secondPage]);
  throw new Error("Unexpected isolated book detail route");
}
function renderDetail() {
  return render(
    <AppServicesProvider>
      <BookDetailScreen
        bookId={TEST_BOOK_ID}
        requestedChildId={TEST_CHILD_ID}
      />
    </AppServicesProvider>,
  );
}
beforeEach(() => pushMock.mockReset());
describe("BookDetailScreen with real API adapters", () => {
  it("selects stored verified previews but does not invent a session when Reading is unavailable", async () => {
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    const user = userEvent.setup();
    renderDetail();
    expect(
      await screen.findByRole("heading", { name: bookFixture.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Chọn trang 1" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Chọn trang 2" }));
    expect(
      screen.getByRole("button", { name: "Chọn trang 2" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: /Bắt đầu đọc/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chưa thể chuẩn bị buổi đọc",
    );
    expect(pushMock).not.toHaveBeenCalled();
    expect(
      apiFetchFixture.mock.calls.every(
        ([input]) => !String(input).includes("/reading/"),
      ),
    ).toBe(true);
  });

  it.each([
    [404, "Không tìm thấy sách"],
    [409, "Sách hiện chưa sẵn sàng"],
  ] as const)("shows the canonical HTTP %s state", async (status, heading) => {
    apiFetchFixture.mockImplementation(async (input) =>
      new URL(String(input)).pathname === `/profiles/children/${TEST_CHILD_ID}`
        ? Response.json(childFixture)
        : Response.json({ detail: "Private database details" }, { status }),
    );
    renderDetail();
    expect(
      await screen.findByRole("heading", { name: heading }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Private database details"),
    ).not.toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("keeps detail failures generic and retryable", async () => {
    apiFetchFixture.mockRejectedValue(new Error("Private database details"));
    renderDetail();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(alert).not.toHaveTextContent("Private database details");
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeInTheDocument();
  });
});
