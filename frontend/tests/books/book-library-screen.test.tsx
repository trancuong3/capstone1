import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { BookLibraryScreen } from "@/components/books/book-library-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreProvider } from "@/components/providers/app-store-provider";
import type { AppMockScenario } from "@/types/ui-state";

const currentChildId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function renderLibrary(bookScenario: AppMockScenario = "default") {
  return render(
    <AppStoreProvider>
      <AppServicesProvider bookScenario={bookScenario} scenario="default">
        <BookLibraryScreen requestedChildId={currentChildId} />
      </AppServicesProvider>
    </AppStoreProvider>,
  );
}

describe("BookLibraryScreen", () => {
  it("shows the selected child's verified active grade catalog", async () => {
    renderLibrary();

    expect(
      await screen.findByRole("heading", {
        name: "Bé An muốn đọc gì hôm nay?",
      }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Chú Mèo Nhỏ")).toBeInTheDocument();
      expect(screen.getByText("Khu Vườn Của Em")).toBeInTheDocument();
      expect(screen.getByText("Chuyến Đi Đầu Tiên")).toBeInTheDocument();
      expect(screen.getByText("Cây Khế")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { level: 2, name: "Chú Mèo Nhỏ" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Sách đã ngừng phát hành"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Bản thảo đang duyệt")).not.toBeInTheDocument();
  });

  it("offers one complete, accessible grade filter at every viewport", async () => {
    const user = userEvent.setup();
    renderLibrary();

    const filters = await screen.findByRole("group", {
      name: "Lọc sách theo lớp",
    });
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

    const allGrades = within(filters).getByRole("button", { name: "Tất cả" });
    await user.click(allGrades);
    expect(allGrades).toHaveAttribute("aria-pressed", "true");
  });

  it("searches title and author and exposes a no-result recovery", async () => {
    const user = userEvent.setup();
    renderLibrary();

    const search = await screen.findByLabelText(
      "Tìm theo tên sách hoặc tác giả",
    );
    await user.clear(search);
    await user.type(search, "không tồn tại");

    expect(
      await screen.findByRole("heading", {
        name: "Không tìm thấy cuốn sách phù hợp",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xóa bộ lọc" }));
    expect(await screen.findByText("Chú Mèo Nhỏ")).toBeInTheDocument();
  });

  it("distinguishes an empty catalog from a search with no results", async () => {
    renderLibrary("empty");

    expect(
      await screen.findByRole("heading", {
        name: "Thư viện đang được cập nhật",
      }),
    ).toBeInTheDocument();
  });

  it("keeps catalog failures generic", async () => {
    renderLibrary("error");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(
      await screen.findByRole("button", { name: "Thử lại" }),
    ).toBeInTheDocument();
  });
});
