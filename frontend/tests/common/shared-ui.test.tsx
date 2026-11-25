import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button, ButtonLink } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { PaginationBar } from "@/components/common/pagination-bar";
import { ResponsiveTable } from "@/components/common/responsive-table";

describe("Button & ButtonLink width resolution", () => {
  it("defaults to w-full when neither fullWidth nor explicit width class is passed", () => {
    render(
      <>
        <Button>Lưu</Button>
        <ButtonLink href="/dashboard">Tổng quan</ButtonLink>
      </>,
    );
    expect(screen.getByRole("button", { name: "Lưu" }).className).toContain(
      "w-full",
    );
    expect(screen.getByRole("link", { name: "Tổng quan" }).className).toContain(
      "w-full",
    );
  });

  it("omits w-full when fullWidth={false} or an explicit width utility is passed", () => {
    render(
      <>
        <Button fullWidth={false}>Chỉnh sửa</Button>
        <Button className="w-auto px-3">Xóa</Button>
        <Button className="sm:w-auto">Tải lại</Button>
        <Button className="w-fit">Nhỏ</Button>
        <ButtonLink fullWidth={false} href="/books">
          Mở sách
        </ButtonLink>
      </>,
    );
    for (const name of ["Chỉnh sửa", "Xóa", "Tải lại", "Nhỏ"]) {
      expect(screen.getByRole("button", { name }).className).not.toContain(
        "w-full",
      );
    }
    expect(
      screen.getByRole("button", { name: "Chỉnh sửa" }).className,
    ).toContain("w-auto");
    expect(
      screen.getByRole("link", { name: "Mở sách" }).className,
    ).not.toContain("w-full");
  });
});

describe("PaginationBar", () => {
  it("returns null for 0 items, 1 item, or exact single page by default", () => {
    const onPageChange = vi.fn();
    const { container, rerender } = render(
      <PaginationBar
        itemLabel="sách"
        onPageChange={onPageChange}
        page={1}
        pageSize={9}
        total={0}
      />,
    );
    expect(container.firstChild).toBeNull();

    rerender(
      <PaginationBar
        itemLabel="sách"
        onPageChange={onPageChange}
        page={1}
        pageSize={9}
        total={1}
      />,
    );
    expect(container.firstChild).toBeNull();

    rerender(
      <PaginationBar
        itemLabel="sách"
        onPageChange={onPageChange}
        page={1}
        pageSize={9}
        total={9}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders summary only without prev/next when showSummaryWhenSinglePage is true", () => {
    render(
      <PaginationBar
        itemLabel="lịch nhắc"
        onPageChange={vi.fn()}
        page={1}
        pageSize={5}
        showSummaryWhenSinglePage
        total={3}
      />,
    );
    expect(screen.getByText("Đang xem 1–3 / 3 lịch nhắc")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Trước/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Tiếp/ }),
    ).not.toBeInTheDocument();
  });

  it("renders on pageSize + 1 and clamps prev/next across 100 items", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();

    const { rerender } = render(
      <PaginationBar
        itemLabel="sách"
        onPageChange={onPageChange}
        page={1}
        pageSize={9}
        total={10}
      />,
    );
    expect(screen.getByText("Đang xem 1–9 / 10 sách")).toBeInTheDocument();
    expect(screen.getByText("Trang 1 / 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Trước/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Tiếp/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /Tiếp/ }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    onPageChange.mockClear();
    rerender(
      <PaginationBar
        itemLabel="sách"
        onPageChange={onPageChange}
        page={12}
        pageSize={9}
        total={100}
      />,
    );
    expect(screen.getByText("Đang xem 100–100 / 100 sách")).toBeInTheDocument();
    expect(screen.getByText("Trang 12 / 12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tiếp/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Trước/ }));
    expect(onPageChange).toHaveBeenCalledWith(11);

    // Out-of-bounds page clamps safely to last page
    rerender(
      <PaginationBar
        itemLabel="sách"
        onPageChange={onPageChange}
        page={99}
        pageSize={9}
        total={100}
      />,
    );
    expect(screen.getByText("Trang 12 / 12")).toBeInTheDocument();
  });
});

describe("Modal upgraded accessibility & layout", () => {
  it("supports alertdialog role, sticky footer slot, body scroll lock, Escape, backdrop click, and focus restoration", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    const { rerender } = render(
      <>
        <button type="button">Mở hộp thoại</button>
        <Modal
          closeOnBackdropClick
          footer={<Button fullWidth={false}>Xác nhận xóa</Button>}
          isOpen={false}
          onClose={onClose}
          role="alertdialog"
          title="Xác nhận xóa"
        >
          <p>Nội dung cảnh báo</p>
        </Modal>
      </>,
    );

    const trigger = screen.getByRole("button", { name: "Mở hộp thoại" });
    trigger.focus();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");

    rerender(
      <>
        <button type="button">Mở hộp thoại</button>
        <Modal
          closeOnBackdropClick
          footer={<Button fullWidth={false}>Xác nhận xóa</Button>}
          isOpen
          onClose={onClose}
          role="alertdialog"
          title="Xác nhận xóa"
        >
          <p>Nội dung cảnh báo</p>
        </Modal>
      </>,
    );

    const dialog = screen.getByRole("alertdialog", { name: "Xác nhận xóa" });
    expect(dialog).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    expect(
      dialog.querySelector('[data-modal-footer="true"]'),
    ).toBeInTheDocument();

    // Focus traps across close button and footer button
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Đóng hộp thoại" }),
    ).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Xác nhận xóa" })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Đóng hộp thoại" }),
    ).toHaveFocus();

    // Escape triggers onClose
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    // Backdrop click triggers onClose
    const backdrop = document.querySelector('[data-modal-backdrop="true"]');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);

    // Closing unlocks body scroll and restores focus to trigger
    rerender(
      <>
        <button type="button">Mở hộp thoại</button>
        <Modal
          closeOnBackdropClick
          footer={<Button fullWidth={false}>Xác nhận xóa</Button>}
          isOpen={false}
          onClose={onClose}
          role="alertdialog"
          title="Xác nhận xóa"
        >
          <p>Nội dung cảnh báo</p>
        </Modal>
      </>,
    );
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
  });
});

describe("ResponsiveTable", () => {
  it("renders a keyboard-focusable horizontal scroll region", () => {
    render(
      <ResponsiveTable ariaLabel="Bảng kiểm tra chất lượng">
        <table>
          <tbody>
            <tr>
              <td>Ô dữ liệu</td>
            </tr>
          </tbody>
        </table>
      </ResponsiveTable>,
    );
    const region = screen.getByRole("region", {
      name: "Bảng kiểm tra chất lượng",
    });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.className).toContain("overflow-x-auto");
  });
});
