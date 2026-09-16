import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { LoginForm } from "@/components/auth/login-form";
import type { AuthMockScenario } from "@/types/auth";

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function renderLoginForm(scenario: AuthMockScenario = "default") {
  return render(
    <AuthServiceProvider scenario={scenario}>
      <LoginForm scenario={scenario} />
    </AuthServiceProvider>,
  );
}

describe("LoginForm", () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  it("shows field-level validation and does not submit an invalid form", async () => {
    const user = userEvent.setup();
    renderLoginForm();

    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));

    expect(
      await screen.findByText("Mật khẩu cần có ít nhất 8 ký tự."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Mật khẩu")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("navigates to the dashboard after a successful mock login", async () => {
    const user = userEvent.setup();
    renderLoginForm();

    await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("renders the safe invalid-credentials message", () => {
    renderLoginForm("invalid-credentials");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Email hoặc mật khẩu chưa đúng",
    );
  });

  it("links the registration action to /register", () => {
    renderLoginForm();

    expect(screen.getByRole("link", { name: /Đăng ký/ })).toHaveAttribute(
      "href",
      "/register",
    );
  });
});
