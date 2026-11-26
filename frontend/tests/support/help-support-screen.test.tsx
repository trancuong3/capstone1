import fs from "node:fs";
import path from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HelpSupportScreen } from "@/components/support/help-support-screen";
import {
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";

const { submitFeedbackMock } = vi.hoisted(() => ({
  submitFeedbackMock: vi.fn(),
}));

vi.mock("@/lib/api/support-service", () => ({
  createSupportService: () => ({ submitFeedback: submitFeedbackMock }),
  SupportFeedbackError: class SupportFeedbackError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

describe("HelpSupportScreen", () => {
  beforeEach(() => {
    submitFeedbackMock.mockReset();
  });

  it("prefills the parent's email and clears the message after an accepted submission", async () => {
    const user = userEvent.setup();
    submitFeedbackMock.mockResolvedValue({
      accepted: true,
      delivery_status: "accepted_by_smtp",
      detail: "SMTP accepted",
    });

    render(withAuthFixture(<HelpSupportScreen />, createAuthServiceFixture()));

    expect(
      screen.getByRole("link", { name: "vireadforyou@gmail.com" }),
    ).toHaveAttribute("href", "mailto:vireadforyou@gmail.com");

    await user.click(screen.getByRole("button", { name: "Gửi phản hồi" }));
    const subject = screen.getByRole("textbox", { name: "Tiêu đề" });
    const message = screen.getByRole("textbox", { name: "Nội dung" });
    const contactEmail = screen.getByRole("textbox", { name: "Email liên hệ" });

    await waitFor(() => expect(contactEmail).toHaveValue("parent@example.com"));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Loại yêu cầu" }),
      "account_support",
    );
    await user.type(subject, "Không thể cập nhật hồ sơ");
    await user.type(message, "Tôi gặp lỗi khi lưu thông tin phụ huynh.");

    await user.click(screen.getByRole("button", { name: "Gửi phản hồi" }));

    await waitFor(() =>
      expect(submitFeedbackMock).toHaveBeenCalledWith({
        category: "account_support",
        subject: "Không thể cập nhật hồ sơ",
        message: "Tôi gặp lỗi khi lưu thông tin phụ huynh.",
        contact_email: "parent@example.com",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "đã tiếp nhận phản hồi",
    );
    expect(subject).toHaveValue("");
    expect(message).toHaveValue("");
    expect(contactEmail).toHaveValue("parent@example.com");
  });

  it("preserves entered values when feedback submission fails", async () => {
    const user = userEvent.setup();
    submitFeedbackMock.mockRejectedValue(new Error("Temporary error"));

    render(withAuthFixture(<HelpSupportScreen />, createAuthServiceFixture()));

    await user.click(screen.getByRole("button", { name: "Gửi phản hồi" }));
    const subject = screen.getByRole("textbox", { name: "Tiêu đề" });
    const message = screen.getByRole("textbox", { name: "Nội dung" });
    const contactEmail = screen.getByRole("textbox", { name: "Email liên hệ" });

    await waitFor(() => expect(contactEmail).toHaveValue("parent@example.com"));
    await user.type(subject, "Không nhận được mã");
    await user.type(message, "Vui lòng kiểm tra giúp.");
    await user.click(screen.getByRole("button", { name: "Gửi phản hồi" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chưa gửi được phản hồi",
    );
    expect(subject).toHaveValue("Không nhận được mã");
    expect(message).toHaveValue("Vui lòng kiểm tra giúp.");
  });

  it("rejects whitespace-only required content without calling the API", async () => {
    const user = userEvent.setup();

    render(withAuthFixture(<HelpSupportScreen />, createAuthServiceFixture()));

    await user.click(screen.getByRole("button", { name: "Gửi phản hồi" }));
    const subject = screen.getByRole("textbox", { name: "Tiêu đề" });
    const message = screen.getByRole("textbox", { name: "Nội dung" });
    const contactEmail = screen.getByRole("textbox", { name: "Email liên hệ" });
    await waitFor(() => expect(contactEmail).toHaveValue("parent@example.com"));

    fireEvent.change(subject, { target: { value: "   " } });
    fireEvent.change(message, { target: { value: "   " } });
    await user.click(screen.getByRole("button", { name: "Gửi phản hồi" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("điền tiêu đề");
    expect(submitFeedbackMock).not.toHaveBeenCalled();
  });

  it("toggles FAQ group accordions, keeps >=44px tap targets, and uses 640px feedback form layout", async () => {
    const user = userEvent.setup();
    render(withAuthFixture(<HelpSupportScreen />, createAuthServiceFixture()));

    const groupToggle = screen.getByRole("button", { name: "Tài khoản" });
    expect(groupToggle).toHaveAttribute("aria-expanded", "false");
    expect(groupToggle).toHaveClass(
      "min-h-11",
      "md:pointer-events-none",
      "md:min-h-0",
    );

    const faqItemsBox = groupToggle.closest("h3")?.nextElementSibling;
    expect(faqItemsBox).toHaveClass("hidden", "md:flex");

    await user.click(groupToggle);
    expect(groupToggle).toHaveAttribute("aria-expanded", "true");
    expect(faqItemsBox).not.toHaveClass("hidden");

    const questionSummary = screen
      .getByText("Làm thế nào để đổi mật khẩu?")
      .closest("summary");
    expect(questionSummary).toHaveClass("min-h-11");

    const mailLink = screen.getByRole("link", {
      name: "vireadforyou@gmail.com",
    });
    expect(mailLink).toHaveClass("min-h-11");

    await user.click(screen.getByRole("button", { name: "Gửi phản hồi" }));
    const messageBox = screen
      .getByRole("textbox", { name: "Nội dung" })
      .closest("div");
    expect(messageBox).toHaveClass("min-w-0", "min-[640px]:col-span-2");
    expect(messageBox?.closest("form")).toHaveClass("min-[640px]:grid-cols-2");

    const submitBtn = screen.getByRole("button", { name: "Gửi phản hồi" });
    expect(submitBtn).toHaveClass(
      "w-full",
      "min-[640px]:col-span-2",
      "min-[640px]:w-auto",
    );

    const supportSource = fs.readFileSync(
      path.resolve(process.cwd(), "components/support/help-support-screen.tsx"),
      "utf8",
    );
    expect(supportSource).not.toMatch(
      /(?<![\w-])(sm:|max-sm:|max-\[639px\]:|max-\[767px\]:)/,
    );
  });
});
