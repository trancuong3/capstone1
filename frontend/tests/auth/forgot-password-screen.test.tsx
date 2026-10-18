import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ForgotPasswordScreen } from "@/components/auth/forgot-password-screen";
import {
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";

describe("ForgotPasswordScreen", () => {
  it("uses a non-enumerating recovery confirmation", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    const { container } = render(
      withAuthFixture(<ForgotPasswordScreen scenario="default" />, service),
    );
    await user.type(
      screen.getByLabelText("Email hoặc số điện thoại"),
      "minhanh@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Gửi hướng dẫn" }));
    expect(
      await screen.findByRole("heading", { name: "Kiểm tra email nhé" }),
    ).toBeInTheDocument();
    expect(service.requestPasswordReset).toHaveBeenCalledWith({
      email: "minhanh@example.com",
    });
    expect(
      screen.getByText(/Nếu email này đã được đăng ký/),
    ).toBeInTheDocument();
    expect(screen.queryByText("minhanh@example.com")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Về đăng nhập" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(
      container.querySelector('a[href^="mailto:"]'),
    ).not.toBeInTheDocument();
  });
  it("renders a safe initial provider error", () => {
    render(
      withAuthFixture(
        <ForgotPasswordScreen scenario="safe-error" />,
        createAuthServiceFixture(),
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("vui lòng thử lại sau");
  });
  it("keeps rejected requests generic and permits retry", async () => {
    const service = createAuthServiceFixture();
    service.requestPasswordReset.mockRejectedValueOnce(
      new Error("Private provider details"),
    );
    const user = userEvent.setup();
    render(
      withAuthFixture(<ForgotPasswordScreen scenario="default" />, service),
    );
    await user.type(
      screen.getByLabelText("Email hoặc số điện thoại"),
      "parent@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Gửi hướng dẫn" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("vui lòng thử lại sau");
    expect(alert).not.toHaveTextContent("Private provider details");
    expect(
      screen.queryByRole("heading", { name: "Kiểm tra email nhé" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gửi hướng dẫn" })).toBeEnabled();
  });
});
