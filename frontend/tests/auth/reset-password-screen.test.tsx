import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ResetPasswordScreen } from "@/components/auth/reset-password-screen";
import { AuthServiceError } from "@/lib/api/auth-service";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";
import type { AuthMockScenario } from "@/types/auth";

function renderResetScreen(
  scenario: AuthMockScenario = "default",
  service = createAuthServiceFixture(),
) {
  return render(
    withAuthFixture(<ResetPasswordScreen scenario={scenario} />, service, {
      isPasswordRecovery: true,
      lastEvent: "PASSWORD_RECOVERY",
      session: authSessionFixture,
    }),
  );
}
async function fillValidReset(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Mật khẩu mới"), "matkhau123");
  await user.type(screen.getByLabelText("Nhập lại mật khẩu mới"), "matkhau123");
}

describe("ResetPasswordScreen", () => {
  it.each([
    ["invalid-token", "Liên kết không hợp lệ"],
    ["expired-token", "Liên kết đã hết hạn"],
  ] as const)("renders the %s recovery state", (scenario, heading) => {
    renderResetScreen(scenario);
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "không thể được sử dụng",
    );
  });

  it("validates password confirmation at the matching field", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    renderResetScreen("default", service);
    await user.type(screen.getByLabelText("Mật khẩu mới"), "matkhau123");
    await user.type(
      screen.getByLabelText("Nhập lại mật khẩu mới"),
      "khacmatkhau",
    );
    await user.click(screen.getByRole("button", { name: "Lưu mật khẩu mới" }));
    expect(
      await screen.findByText("Hai mật khẩu chưa khớp."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nhập lại mật khẩu mới")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(service.resetPassword).not.toHaveBeenCalled();
  });

  it("moves to success after a valid recovery service response", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    renderResetScreen("default", service);
    await fillValidReset(user);
    await user.click(screen.getByRole("button", { name: "Lưu mật khẩu mới" }));
    expect(
      await screen.findByRole("heading", { name: "Đã đổi mật khẩu" }),
    ).toBeInTheDocument();
    expect(service.resetPassword).toHaveBeenCalledWith({
      newPassword: "matkhau123",
    });
    expect(screen.getByRole("link", { name: /Đăng nhập/ })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it.each([
    ["invalid-recovery-context", "Liên kết không hợp lệ"],
    ["expired-recovery-context", "Liên kết đã hết hạn"],
  ] as const)(
    "maps a live %s failure to the recovery screen",
    async (reason, heading) => {
      const service = createAuthServiceFixture();
      service.resetPassword.mockRejectedValue(
        new AuthServiceError(reason, "Sensitive provider details"),
      );
      const user = userEvent.setup();
      renderResetScreen("default", service);
      await fillValidReset(user);
      await user.click(
        screen.getByRole("button", { name: "Lưu mật khẩu mới" }),
      );
      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Sensitive provider details"),
      ).not.toBeInTheDocument();
    },
  );

  it.each([
    [null, "Liên kết không hợp lệ"],
    ["expired-recovery-context", "Liên kết đã hết hạn"],
  ] as const)(
    "maps initialization state %s before rendering the form",
    (initializationFailure, heading) => {
      const service = createAuthServiceFixture();
      render(
        withAuthFixture(<ResetPasswordScreen scenario="default" />, service, {
          initializationFailure,
          isPasswordRecovery: false,
          lastEvent: "INITIAL_SESSION",
          session: null,
          status: initializationFailure ? "error" : "ready",
        }),
      );
      expect(
        screen.getByRole("heading", { name: heading }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Lưu mật khẩu mới" }),
      ).not.toBeInTheDocument();
      expect(service.resetPassword).not.toHaveBeenCalled();
    },
  );
});
