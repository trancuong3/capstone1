import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AuthServiceProvider } from "@/components/auth/auth-service-provider";
import { ForgotPasswordScreen } from "@/components/auth/forgot-password-screen";

describe("ForgotPasswordScreen", () => {
  it("uses a non-enumerating recovery confirmation", async () => {
    const user = userEvent.setup();

    const { container } = render(
      <AuthServiceProvider mode="mock" scenario="default">
        <ForgotPasswordScreen scenario="default" />
      </AuthServiceProvider>,
    );

    await user.type(
      screen.getByLabelText("Email của ba mẹ"),
      "minhanh@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Gửi hướng dẫn" }));

    expect(
      await screen.findByRole("heading", { name: "Kiểm tra email nhé" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Nếu email này đã được đăng ký/),
    ).toBeInTheDocument();
    expect(screen.queryByText("minhanh@example.com")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Về đăng nhập" })).toHaveAttribute(
      "href",
      "/login?state=default",
    );
    expect(
      container.querySelector('a[href^="mailto:"]'),
    ).not.toBeInTheDocument();
  });

  it("renders a safe provider error", () => {
    render(
      <AuthServiceProvider mode="mock" scenario="safe-error">
        <ForgotPasswordScreen scenario="safe-error" />
      </AuthServiceProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("vui lòng thử lại sau");
  });
});
