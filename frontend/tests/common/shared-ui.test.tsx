import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button, ButtonLink } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { PageHeader } from "@/components/common/page-header";
import { PaginationBar } from "@/components/common/pagination-bar";
import { ResponsiveTable } from "@/components/common/responsive-table";
import { SelectField } from "@/components/common/select-field";

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
        <Button className="min-[640px]:w-auto">Hợp lệ</Button>
        <Button className="w-fit">Nhỏ</Button>
        <ButtonLink fullWidth={false} href="/books">
          Mở sách
        </ButtonLink>
        <ButtonLink className="min-[640px]:w-auto" href="/reports">
          Báo cáo
        </ButtonLink>
      </>,
    );
    for (const name of ["Chỉnh sửa", "Xóa", "Tải lại", "Hợp lệ", "Nhỏ"]) {
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
    expect(
      screen.getByRole("link", { name: "Báo cáo" }).className,
    ).not.toContain("w-full");
  });

  it("handles responsive, max-*, arbitrary, and size-* width utilities with token boundaries", () => {
    render(
      <>
        <Button className="min-[640px]:w-fit">A</Button>
        <Button className="min-[640px]:w-[200px]">B</Button>
        <Button className="min-[640px]:w-full">C</Button>
        <Button className="md:w-fit">D</Button>
        <Button className="md:w-40">E</Button>
        <Button className="max-md:w-auto">F</Button>
        <Button className="max-sm:w-auto">G</Button>
        <Button className="min-[640px]:size-11">H</Button>
        <Button className="w-px">I</Button>
        <Button className="w-screen">J</Button>
        <Button className="w-auto!">L</Button>
        <Button className="md:w-auto!">M</Button>
        <Button className="w-[180px]!">N</Button>
        <Button className="w-prose">O</Button>
        <Button className="w-3xs">P</Button>
        <Button className="w-auto-something">K</Button>
      </>,
    );

    for (const name of [
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "L",
      "M",
      "N",
      "O",
      "P",
    ]) {
      const tokens = screen
        .getByRole("button", { name })
        .className.split(/\s+/);
      expect(tokens).not.toContain("w-full");
    }

    expect(
      screen.getByRole("button", { name: "K" }).className.split(/\s+/),
    ).toContain("w-full");
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

  it("keeps >=44px (min-h-11) touch targets on Prev and Next buttons when compact is true", () => {
    render(
      <PaginationBar
        compact
        itemLabel="sách"
        onPageChange={vi.fn()}
        page={2}
        pageSize={9}
        total={27}
      />,
    );
    const prevBtn = screen.getByRole("button", { name: /Trước/ });
    const nextBtn = screen.getByRole("button", { name: /Tiếp/ });
    expect(prevBtn.className).toContain("min-h-11");
    expect(prevBtn.className).not.toContain("min-h-10");
    expect(nextBtn.className).toContain("min-h-11");
    expect(nextBtn.className).not.toContain("min-h-10");
  });
});

describe("PageHeader", () => {
  it("renders compact mobile wrapping and clamping while preserving desktop eyebrow, description, and action rules", () => {
    render(
      <PageHeader
        action={<ButtonLink href="/reports">Báo cáo</ButtonLink>}
        description="Theo dõi tiến độ đọc của bé theo từng tuần."
        eyebrow="Báo cáo gia đình"
        title="Từ cần luyện của Bé An trong học kỳ này"
      />,
    );

    const header = screen.getByRole("banner");
    expect(header.className).toContain("flex-wrap");
    expect(header.className).toContain("md:flex-nowrap");

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Từ cần luyện của Bé An trong học kỳ này",
    });
    expect(heading.className).toContain("line-clamp-2");
    expect(heading.className).toContain("break-words");
    expect(heading.className).toContain("md:line-clamp-none");
    expect(heading.parentElement?.className).toContain(
      "min-w-[min(100%,11rem)]",
    );
    expect(heading.parentElement?.className).toContain("md:min-w-0");

    const eyebrow = screen.getByText("Báo cáo gia đình");
    expect(eyebrow.className).toContain("hidden");
    expect(eyebrow.className).toContain("md:block");

    const description = screen.getByText(
      "Theo dõi tiến độ đọc của bé theo từng tuần.",
    );
    expect(description.className).toContain("hidden");
    expect(description.className).toContain("md:block");

    const actionLink = screen.getByRole("link", { name: "Báo cáo" });
    const actionWrapper = actionLink.parentElement;
    expect(actionWrapper?.className).toContain("max-w-full");
    expect(actionWrapper?.className).toContain("md:w-full");
    expect(actionWrapper?.className).toContain("[&>a]:min-h-11");
    expect(actionWrapper?.className).toContain("[&>button]:min-h-11");
  });

  it("omits md:w-full from the action wrapper when actionClassName specifies md:w-*", () => {
    render(
      <PageHeader
        action={<ButtonLink href="/reports">Xuất CSV</ButtonLink>}
        actionClassName="w-auto md:w-auto"
        title="Báo cáo sách"
      />,
    );

    const actionWrapper = screen.getByRole("link", {
      name: "Xuất CSV",
    }).parentElement;
    const tokens = actionWrapper?.className.split(/\s+/) ?? [];
    expect(tokens).toContain("w-auto");
    expect(tokens).toContain("md:w-auto");
    expect(tokens).not.toContain("md:w-full");
  });
});

describe("SelectField", () => {
  it("truncates long labels within the field padding", () => {
    render(
      <SelectField label="Chọn lớp học hiện tại của bé">
        <option value="1">Lớp 1</option>
      </SelectField>,
    );
    const label = screen.getByText("Chọn lớp học hiện tại của bé");
    expect(label.className).toContain("max-w-[calc(100%-2rem)]");
    expect(label.className).toContain("truncate");
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
