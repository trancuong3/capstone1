import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthServiceContext,
  AuthServiceProvider,
} from "@/components/auth/auth-service-provider";
import { RegisterForm } from "@/components/auth/register-form";
import type { AuthService } from "@/lib/api/auth-service";
import type { AuthMockScenario } from "@/types/auth";

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function renderRegisterForm(scenario: AuthMockScenario = "default") {
  return render(
    <AuthServiceProvider scenario={scenario}>
      <RegisterForm scenario={scenario} />
    </AuthServiceProvider>,
  );
}

async function fillValidRegistration(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Họ và tên ba mẹ"), "Nguyễn Minh Anh");
  await user.type(
    screen.getByLabelText("Email của ba mẹ"),
    "minhanh@example.com",
  );
  await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
}

describe("RegisterForm", () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  it("shows field-level validation for all three registration fields", async () => {
    const user = userEvent.setup();
    renderRegisterForm();

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(
      await screen.findByText("Ba mẹ vui lòng nhập họ và tên."),
    ).toBeInTheDocument();
    expect(screen.getByText("Ba mẹ vui lòng nhập email.")).toBeInTheDocument();
    expect(
      screen.getByText("Mật khẩu cần có ít nhất 8 ký tự."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Họ và tên ba mẹ")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("navigates to the first child profile step after registration", async () => {
    const user = userEvent.setup();
    renderRegisterForm();
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/children/new?from=register");
    });
  });

  it.each(["email-used", "safe-error"] as const)(
    "uses the same safe message for the %s scenario",
    async (scenario) => {
      const user = userEvent.setup();
      renderRegisterForm(scenario);
      await fillValidRegistration(user);

      await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Chưa thể tạo tài khoản lúc này. Ba mẹ vui lòng thử lại sau.",
      );
      expect(pushMock).not.toHaveBeenCalled();
    },
  );

  it("supports a safe provider validation-error scenario", async () => {
    const user = userEvent.setup();
    renderRegisterForm("validation-error");
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Thông tin đăng ký chưa hợp lệ",
    );
  });

  it("disables submission while the request is pending", async () => {
    const registerParent = vi.fn(() => new Promise<void>(() => undefined));
    const pendingService: AuthService = {
      registerParent,
      requestPasswordReset: async () => undefined,
      resetPassword: async () => undefined,
      signIn: async () => undefined,
    };
    const user = userEvent.setup();
    render(
      <AuthServiceContext.Provider value={pendingService}>
        <RegisterForm scenario="default" />
      </AuthServiceContext.Provider>,
    );
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(
      screen.getByRole("button", { name: "Đang tạo tài khoản…" }),
    ).toBeDisabled();
    expect(registerParent).toHaveBeenCalledTimes(1);
  });

  it("links back to login", () => {
    renderRegisterForm();

    expect(
      screen.getByRole("link", { name: "Đã có tài khoản? Đăng nhập" }),
    ).toHaveAttribute("href", "/login");
  });
});
