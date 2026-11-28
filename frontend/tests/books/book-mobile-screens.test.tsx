import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookCover } from "@/components/books/book-cover";
import { BookDetailScreen } from "@/components/books/book-detail-screen";
import { BookLibraryScreen } from "@/components/books/book-library-screen";
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
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

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

function installMobileMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const originalMatchMedia = window.matchMedia;

const secondPage = {
  ...pagePreviewFixture,
  page_id: "15000000-0000-4000-8000-000000000002",
  page_number: 2,
};

beforeEach(() => {
  installMobileMatchMedia();
  installApiFetchFixture();
  pushMock.mockReset();
  replaceMock.mockReset();
  searchParamsMock.mockReset().mockReturnValue(new URLSearchParams());
});

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: originalMatchMedia,
  });
  vi.unstubAllGlobals();
});

describe("F10 mobile screens (< 768px)", () => {
  it("renders BookLibraryScreen with airy mobile cards, >= 44px targets, and single-mounted controls", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (url.pathname === "/reading-management/collections") {
        return Response.json([]);
      }
      if (url.pathname === "/books/catalog") {
        return Response.json([bookFixture]);
      }
      throw new Error(`Unexpected route: ${url.pathname}`);
    });

    const { container } = render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookLibraryScreen />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: `Tủ sách của ${childFixture.alias}`,
    });
    expect(heading.className).not.toContain("truncate");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    await screen.findByRole("heading", {
      level: 2,
      name: bookFixture.title,
    });

    // Concise mobile header label (no 12-word subtitle)
    expect(
      screen.getByRole("link", { name: "Quay lại: Thư viện sách" }),
    ).toBeInTheDocument();

    // Single search input with 48px touch height
    const searchInputs = screen.getAllByLabelText(
      "Tìm theo tên sách hoặc tác giả",
    );
    expect(searchInputs).toHaveLength(1);
    expect(searchInputs[0].className).toContain("h-12");

    // My Books button uses >= 44px height without !important overrides
    const myBooksLink = screen.getByRole("link", { name: "Sách của tôi" });
    expect(myBooksLink.className).toContain("min-h-11");
    expect(myBooksLink.className).not.toContain("!");

    // Single grade filter fieldset with >= 44px pills
    const filterGroups = screen.getAllByRole("group", {
      name: "Lọc sách theo lớp",
    });
    expect(filterGroups).toHaveLength(1);
    const allPill = within(filterGroups[0]).getByRole("button", {
      name: "Tất cả",
    });
    expect(allPill.className).toContain("min-h-11");
    expect(allPill.className).toContain("min-w-11");

    // Mobile BookCard omits desktop .catalog-volume/.catalog-jacket compression
    expect(container.querySelector(".catalog-volume")).toBeNull();
    expect(container.querySelector(".catalog-jacket")).toBeNull();

    const viewBookLink = screen.getByRole("link", {
      name: `Đọc sách ${bookFixture.title}`,
    });
    expect(viewBookLink.className).toContain("min-h-11");

    const favoriteBtn = screen.getByRole("button", {
      name: `Thêm ${bookFixture.title} yêu thích`,
    });
    const readingListBtn = screen.getByRole("button", {
      name: `Thêm ${bookFixture.title} vào danh sách muốn đọc`,
    });
    expect(favoriteBtn.className).toContain("size-11");
    expect(readingListBtn.className).toContain("size-11");
  });

  it("renders BookDetailScreen on mobile with single-mounted controls, bottom-sheet report modal, and >= 44px targets", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === `/books/catalog/${TEST_BOOK_ID}`) {
        return Response.json(bookFixture);
      }
      if (path === `/books/catalog/${TEST_BOOK_ID}/preview`) {
        return Response.json([pagePreviewFixture, secondPage]);
      }
      throw new Error(`Unexpected route: ${path}`);
    });

    const user = userEvent.setup();
    const { container } = render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookDetailScreen bookId={TEST_BOOK_ID} />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: bookFixture.title }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    // Mobile header uses concise label so book title is not duplicated in top bar
    expect(
      screen.getByRole("link", { name: "Quay lại: Chi tiết sách" }),
    ).toBeInTheDocument();

    // Omits desktop .detail-cover-jacket compression
    expect(container.querySelector(".detail-cover-jacket")).toBeNull();

    // Single #reading-end-page >= 44px and single #start-reading-button w-full
    const endSelects = container.querySelectorAll("#reading-end-page");
    expect(endSelects).toHaveLength(1);
    expect(endSelects[0].className).toContain("min-h-11");

    const startButtons = container.querySelectorAll("#start-reading-button");
    expect(startButtons).toHaveLength(1);
    expect(startButtons[0].className).toContain("w-full");
    expect(startButtons[0].className).toContain("min-h-12");

    // Report actions all >= 44px
    const myReportsLink = screen.getByRole("link", { name: "Báo cáo của tôi" });
    const reportBookBtn = screen.getByRole("button", { name: "Báo lỗi sách" });
    const reportPageBtn = screen.getByRole("button", {
      name: "Báo lỗi trang này",
    });
    expect(myReportsLink.className).toContain("min-h-11");
    expect(reportBookBtn.className).toContain("min-h-11");
    expect(reportPageBtn.className).toContain("min-h-11");

    // Open BookContentReportDialog -> bottom sheet Modal
    await user.click(reportBookBtn);
    const dialog = await screen.findByRole("dialog", { name: "Báo lỗi sách" });
    expect(dialog.className).toContain("rounded-t-[20px]");
    expect(
      within(dialog).getByRole("button", { name: "Gửi báo cáo" }).className,
    ).toContain("min-h-11");
  });

  it("avoids emitting conflicting default dimensions on BookCover when explicit size classes are passed", () => {
    const { container } = render(
      <BookCover book={bookFixture} className="h-[136px] w-[104px]" hero />,
    );
    const coverEl = container.firstElementChild;
    expect(coverEl).not.toBeNull();
    expect(coverEl?.className).toContain("h-[136px]");
    expect(coverEl?.className).toContain("w-[104px]");
    expect(coverEl?.className).not.toContain("h-[205px]");
    expect(coverEl?.className).not.toContain("w-full");
  });
});
