import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ForgotPasswordScreen } from "@/components/auth/forgot-password-screen";
import { LoginScreen } from "@/components/auth/login-screen";
import { RegisterScreen } from "@/components/auth/register-screen";
import { ResetPasswordScreen } from "@/components/auth/reset-password-screen";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";

vi.mock("next/navigation", () => ({
  usePathname: () => "/login",
  useRouter: () => ({
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

describe("F3 auth mobile-native layout and touch targets", () => {
  it("renders LoginScreen unboxed on mobile canvas with >=44px password toggle and single-mounted form", () => {
    const { container } = render(
      withAuthFixture(
        <LoginScreen scenario="default" />,
        createAuthServiceFixture(),
      ),
    );

    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    const main = screen.getByRole("main");
    expect(main.className).not.toContain("max-sm:py-3!");

    const spreadInner = container.querySelector(".account-spread-inner");
    expect(spreadInner).not.toBeNull();
    expect(spreadInner?.className).toContain("sm:border");
    expect(spreadInner?.className).toContain("sm:bg-white");
    expect(spreadInner?.className).toContain("sm:rounded-card");
    expect(spreadInner?.className.split(/\s+/)).not.toContain("border");
    expect(spreadInner?.className.split(/\s+/)).not.toContain("bg-white");

    const toggle = screen.getByRole("button", { name: "Hiện mật khẩu" });
    expect(toggle.className).toContain("size-11");
    expect(toggle.className).not.toContain("size-9");

    const dividerText = screen.getByText("Hoặc tiếp tục với");
    expect(dividerText.className).toContain("bg-canvas");
    expect(dividerText.className).toContain("sm:bg-white");

    const googleButton = screen.getByRole("button", {
      name: "Tiếp tục với Google",
    });
    const googleClasses = googleButton.className.split(/\s+/);
    expect(googleClasses.filter((cls) => cls === "bg-white")).toHaveLength(1);
  });

  it("renders RegisterScreen with >=44px password toggle and no Card stripping hacks", () => {
    const { container } = render(
      withAuthFixture(
        <RegisterScreen scenario="default" />,
        createAuthServiceFixture(),
      ),
    );

    expect(container.querySelectorAll("form")).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: "Hiện mật khẩu" });
    expect(toggle.className).toContain("size-11");
    expect(toggle.className).not.toContain("size-9");
  });

  it("renders ForgotPasswordScreen and ResetPasswordScreen cleanly across states", () => {
    const { rerender } = render(
      withAuthFixture(
        <ForgotPasswordScreen scenario="default" />,
        createAuthServiceFixture(),
      ),
    );
    expect(
      screen.getByRole("heading", { name: "Khôi phục mật khẩu" }),
    ).toBeInTheDocument();

    rerender(
      withAuthFixture(
        <ResetPasswordScreen scenario="success" />,
        createAuthServiceFixture(),
        {
          isPasswordRecovery: true,
          lastEvent: "PASSWORD_RECOVERY",
          session: authSessionFixture,
        },
      ),
    );
    const successHeading = screen.getByRole("heading", {
      name: "Đã đổi mật khẩu",
    });
    expect(successHeading.closest("div")?.parentElement?.className).toContain(
      "bg-success-surface",
    );
  });
});
