import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookLibraryScreen } from "@/components/books/book-library-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  bookFixture,
  childFixture,
  TEST_CHILD_ID,
  TEST_BOOK_ID,
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

function catalogResponse(input: RequestInfo | URL, empty = false) {
  const url = new URL(String(input));
  if (url.pathname === `/profiles/children/${TEST_CHILD_ID}`)
    return Response.json(childFixture);
  if (url.pathname === "/reading-management/collections") return Response.json([]);
  if (url.pathname === "/books/catalog")
    return Response.json(
      empty || url.searchParams.get("search") ? [] : [bookFixture],
    );
  throw new Error("Unexpected isolated catalog route");
}
function renderLibrary() {
  return render(
    <AppServicesProvider>
      <BookLibraryScreen requestedChildId={TEST_CHILD_ID} />
    </AppServicesProvider>,
  );
}
describe("BookLibraryScreen with real API adapters", () => {
  it("renders the selected child's catalog returned by the backend", async () => {
    apiFetchFixture.mockImplementation(async (input) => catalogResponse(input));
    renderLibrary();
    expect(
      await screen.findByRole("heading", {
        name: `${childFixture.alias} muốn đọc gì hôm nay?`,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 2, name: bookFixture.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: `Đọc sách ${bookFixture.title}` }),
    ).toHaveAttribute(
      "href",
      `/books/${TEST_BOOK_ID}?childId=${TEST_CHILD_ID}`,
    );
    const catalogs = apiFetchFixture.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === "/books/catalog",
    );
    expect(catalogs.length).toBeGreaterThan(0);
    expect(
      new URL(String(catalogs.at(-1)?.[0])).searchParams.get("grade"),
    ).toBe(String(childFixture.grade));
  });

  it("offers one complete accessible grade filter and forwards its selection", async () => {
    apiFetchFixture.mockImplementation(async (input) => catalogResponse(input));
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByRole("heading", { level: 2, name: bookFixture.title });
    const filters = screen.getByRole("group", { name: "Lọc sách theo lớp" });
    expect(
      screen.getAllByRole("group", { name: "Lọc sách theo lớp" }),
    ).toHaveLength(1);
    for (const label of [
      "Tất cả",
      "Lớp 1",
      "Lớp 2",
      "Lớp 3",
      "Lớp 4",
      "Lớp 5",
    ]) {
      expect(
        within(filters).getByRole("button", { name: label }),
      ).toBeInTheDocument();
    }
    const all = within(filters).getByRole("button", { name: "Tất cả" });
    await user.click(all);
    expect(all).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      const requests = apiFetchFixture.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === "/books/catalog",
      );
      expect(
        new URL(String(requests.at(-1)?.[0])).searchParams.has("grade"),
      ).toBe(false);
    });
  });

  it("forwards search text and exposes a no-result recovery", async () => {
    apiFetchFixture.mockImplementation(async (input) => catalogResponse(input));
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByRole("heading", { level: 2, name: bookFixture.title });
    await user.type(
      screen.getByLabelText("Tìm theo tên sách hoặc tác giả"),
      "không tồn tại",
    );
    expect(
      await screen.findByRole("heading", {
        name: "Không tìm thấy cuốn sách phù hợp",
      }),
    ).toBeInTheDocument();
    expect(
      apiFetchFixture.mock.calls.some(
        ([input]) =>
          new URL(String(input)).searchParams.get("search") === "không tồn tại",
      ),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Xóa bộ lọc" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: bookFixture.title }),
    ).toBeInTheDocument();
  });

  it("distinguishes a real empty catalog from an empty filtered result", async () => {
    apiFetchFixture.mockImplementation(async (input) =>
      catalogResponse(input, true),
    );
    renderLibrary();
    expect(
      await screen.findByRole("heading", {
        name: "Thư viện đang được cập nhật",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "Không tìm thấy cuốn sách phù hợp",
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps catalog failures generic after child loading succeeds", async () => {
    apiFetchFixture.mockImplementation(async (input) =>
      new URL(String(input)).pathname === `/profiles/children/${TEST_CHILD_ID}`
        ? Response.json(childFixture)
        : Response.json({ detail: "Private catalog details" }, { status: 500 }),
    );
    renderLibrary();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(alert).not.toHaveTextContent("Private catalog details");
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeInTheDocument();
  });
});
