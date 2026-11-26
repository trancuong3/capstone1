import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookLibraryScreen } from "@/components/books/book-library-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";
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
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
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
  if (url.pathname === "/reading-management/collections")
    return Response.json([]);
  if (url.pathname === "/books/catalog")
    return Response.json(
      empty || url.searchParams.get("search") ? [] : [bookFixture],
    );
  throw new Error("Unexpected isolated catalog route");
}
function renderLibrary() {
  return render(
    <WithSelectedChild childId={TEST_CHILD_ID}>
      <AppServicesProvider>
        <BookLibraryScreen />
      </AppServicesProvider>
    </WithSelectedChild>,
  );
}
describe("BookLibraryScreen with real API adapters", () => {
  it("renders the selected child's catalog returned by the backend", async () => {
    apiFetchFixture.mockImplementation(async (input) => catalogResponse(input));
    renderLibrary();
    expect(
      await screen.findByRole("heading", {
        name: `Tủ sách của ${childFixture.alias}`,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 2, name: bookFixture.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: `Đọc sách ${bookFixture.title}` }),
    ).toHaveAttribute("href", `/books/${TEST_BOOK_ID}`);
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
    apiFetchFixture.mockImplementation(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === `/profiles/children/${TEST_CHILD_ID}`)
        return Response.json(childFixture);
      if (pathname === "/reading-management/collections")
        return Response.json([]);
      return Response.json(
        { detail: "Private catalog details" },
        { status: 500 },
      );
    });
    renderLibrary();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(alert).not.toHaveTextContent("Private catalog details");
    expect(screen.getByRole("button", { name: "Thử lại" })).toBeInTheDocument();
  });

  it("renders responsive 640px grid/labels, multi-line h1, tap-safe buttons, and multi-page PaginationBar", async () => {
    const books = Array.from({ length: 13 }, (_, index) => ({
      ...bookFixture,
      id: `22000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      title: `Cuốn sách thiếu nhi tập ${index + 1}`,
    }));
    apiFetchFixture.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/profiles/children/${TEST_CHILD_ID}`)
        return Response.json(childFixture);
      if (url.pathname === "/reading-management/collections")
        return Response.json([]);
      if (url.pathname === "/books/catalog") return Response.json(books);
      throw new Error("Unexpected isolated catalog route");
    });

    const user = userEvent.setup();
    const { container } = renderLibrary();

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: `Tủ sách của ${childFixture.alias}`,
    });
    expect(heading.className).toContain("line-clamp-2");
    expect(heading.className).toContain("break-words");
    expect(heading.className).not.toContain("truncate");

    const filterGroup = screen.getByRole("group", {
      name: "Lọc sách theo lớp",
    });
    expect(filterGroup.querySelector("div")?.className).toContain(
      "min-[640px]:flex-wrap",
    );

    const viewBookLink = await screen.findByRole("link", {
      name: "Đọc sách Cuốn sách thiếu nhi tập 1",
    });
    expect(viewBookLink.className).toContain("min-h-11!");
    expect(viewBookLink.className).toContain("px-2.5!");

    const pagination = screen.getByRole("navigation", {
      name: "Phân trang thư viện sách",
    });
    expect(pagination).toHaveTextContent("Trang 1 / 2");
    await user.click(within(pagination).getByRole("button", { name: "Tiếp" }));
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Cuốn sách thiếu nhi tập 13",
      }),
    ).toBeInTheDocument();

    expect(heading.closest("div.border-b")?.outerHTML).not.toMatch(
      /\b(?:max-)?sm:/,
    );
    expect(filterGroup.outerHTML).not.toMatch(/\b(?:max-)?sm:/);
    expect(container.querySelector(".grid")?.outerHTML).not.toMatch(
      /\b(?:max-)?sm:/,
    );
  });
});
