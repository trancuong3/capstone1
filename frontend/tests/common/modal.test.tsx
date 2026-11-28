import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "@/components/common/modal";

describe("Modal", () => {
  it("has dialog semantics, receives focus, and closes with Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <Modal isOpen onClose={onClose} title="Xác nhận">
        <button type="button">Tiếp tục</button>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Xác nhận" });
    expect(dialog).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps initial forward and reverse tab navigation inside the dialog", async () => {
    const user = userEvent.setup();

    render(
      <Modal isOpen onClose={vi.fn()} title="Xác nhận">
        <button type="button">Tiếp tục</button>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Xác nhận" });
    const close = screen.getByRole("button", { name: "Đóng hộp thoại" });
    const continueButton = screen.getByRole("button", { name: "Tiếp tục" });

    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(continueButton).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(continueButton).toHaveFocus();
  });

  it("renders bottom-sheet framing with drag handle and safe-area footer on mobile while preserving sm: desktop dialog classes", () => {
    render(
      <Modal
        footer={<button type="button">Lưu</button>}
        isOpen
        onClose={vi.fn()}
        title="Cài đặt"
      >
        <p>Nội dung</p>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Cài đặt" });
    const backdrop = dialog.parentElement as HTMLElement;
    const footer = dialog.querySelector<HTMLElement>("[data-modal-footer]");

    expect(backdrop.className).toContain("items-end");
    expect(backdrop.className).toContain("sm:items-center");
    expect(dialog.className).toContain("rounded-t-[20px]");
    expect(dialog.className).toContain("max-h-[88dvh]");
    expect(dialog.className).toContain("sm:rounded-card");
    expect(footer?.className).toContain("env(safe-area-inset-bottom)");
  });
});
