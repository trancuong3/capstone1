import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookDetailScreen } from "@/components/books/book-detail-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
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

const { pushMock, replaceMock, searchParamsMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  searchParamsMock: vi.fn(() => new URLSearchParams()),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => searchParamsMock(),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
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
    <WithSelectedChild childId={TEST_CHILD_ID}>
      <AppServicesProvider>
        <BookDetailScreen bookId={TEST_BOOK_ID} />
      </AppServicesProvider>
    </WithSelectedChild>,
  );
}
beforeEach(() => {
  pushMock.mockReset();
  replaceMock.mockReset();
  searchParamsMock.mockReset().mockReturnValue(new URLSearchParams());
});
describe("BookDetailScreen with real API adapters", () => {
  it("preserves page selection and opens shared preparation without creating a session", async () => {
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
    expect(screen.getByLabelText("Trang kết thúc")).toHaveValue(
      secondPage.page_id,
    );
    expect(screen.getByText(/Phạm vi đọc: Trang 2–2/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Chuẩn bị đọc" }));
    expect(pushMock).toHaveBeenCalledWith(
      `/reading-preparation?bookId=${TEST_BOOK_ID}&pageId=${secondPage.page_id}&endPageId=${secondPage.page_id}`,
    );
    expect(
      apiFetchFixture.mock.calls.every(
        ([input]) => !String(input).includes("/reading/sessions"),
      ),
    ).toBe(true);
  });

  it("selects and preserves the exact OCR page without trusting childId query input", async () => {
    const otherChildId = "41ee0744-5a14-4d2c-bcbc-4cd566e1e4c5";
    searchParamsMock.mockReturnValue(
      new URLSearchParams({
        pageId: secondPage.page_id,
        childId: otherChildId,
        confidence: "0.91",
      }),
    );
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: bookFixture.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Chọn trang 2" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Độ tin cậy 91%/)).toBeInTheDocument();
    expect(screen.getByText(`${childFixture.alias}`)).toBeInTheDocument();
    const requestedChildren = apiFetchFixture.mock.calls
      .map(([input]) => new URL(String(input)).pathname)
      .filter((path) => path.includes("/profiles/children/"));
    expect(requestedChildren).toContain(`/profiles/children/${TEST_CHILD_ID}`);
    expect(requestedChildren).not.toContain(
      `/profiles/children/${otherChildId}`,
    );
  });

  it("does not silently fall back to page one when OCR pageId is invalid", async () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams({ pageId: "15000000-0000-4000-8000-000000000099" }),
    );
    apiFetchFixture.mockImplementation(async (input) => readyResponse(input));
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: bookFixture.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Trang OCR trả về không nằm trong danh sách trang/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Chọn trang 1" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Chuẩn bị đọc" })).toBeDisabled();
    expect(pushMock).not.toHaveBeenCalled();
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
    apiFetchFixture.mockImplementation(async (input) =>
      new URL(String(input)).pathname === `/profiles/children/${TEST_CHILD_ID}`
        ? Response.json(childFixture)
        : Promise.reject(new Error("Private database details")),
    );
    renderDetail();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(alert).not.toHaveTextContent("Private database details");
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeInTheDocument();
  });
});
