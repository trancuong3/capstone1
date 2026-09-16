import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { ResetPasswordScreen } from "@/components/auth/reset-password-screen";
import type { AuthMockScenario } from "@/types/auth";

function renderResetScreen(scenario: AuthMockScenario = "default") {
  return render(
    <AuthServiceProvider scenario={scenario}>
      <ResetPasswordScreen scenario={scenario} />
    </AuthServiceProvider>,
  );
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
    renderResetScreen();

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
  });

  it("moves to the success state after a valid mock reset", async () => {
    const user = userEvent.setup();
    renderResetScreen();

    await user.type(screen.getByLabelText("Mật khẩu mới"), "matkhau123");
    await user.type(
      screen.getByLabelText("Nhập lại mật khẩu mới"),
      "matkhau123",
    );
    await user.click(screen.getByRole("button", { name: "Lưu mật khẩu mới" }));

    expect(
      await screen.findByRole("heading", { name: "Đã đổi mật khẩu" }),
    ).toBeInTheDocument();
  });
});
