import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";
import { LoginScreen } from "@/components/auth/login-screen";
import { AuthServiceError } from "@/lib/api/auth-service";
import {
  authSessionFixture,
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";
import type { AuthMockScenario } from "@/types/auth";

const { refreshMock, replaceMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  replaceMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, replace: replaceMock }),
}));

function renderLoginForm(
  scenario: AuthMockScenario = "default",
  service = createAuthServiceFixture(),
) {
  return render(withAuthFixture(<LoginForm scenario={scenario} />, service));
}
async function fillValidLogin(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByLabelText("Email của ba mẹ"),
    "minhanh@example.com",
  );
  await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
}

describe("LoginForm", () => {
  beforeEach(() => {
    refreshMock.mockClear();
    replaceMock.mockClear();
  });

  it("shows field-level validation without submitting an invalid form", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    renderLoginForm("default", service);
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    const emailError = await screen.findByText("Ba mẹ vui lòng nhập email.");
    const passwordError = await screen.findByText(
      "Ba mẹ vui lòng nhập mật khẩu.",
    );
    expect(emailError).toHaveAttribute("aria-live", "polite");
    expect(passwordError).toHaveAttribute("aria-live", "polite");
    expect(screen.getByLabelText("Mật khẩu")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(service.signIn).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only 8-space password and distinguishes short passwords", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    renderLoginForm("default", service);
    await user.type(
      screen.getByLabelText("Email của ba mẹ"),
      "minhanh@example.com",
    );
    await user.type(screen.getByLabelText("Mật khẩu"), "        ");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    expect(
      await screen.findByText("Ba mẹ vui lòng nhập mật khẩu."),
    ).toBeInTheDocument();
    expect(service.signIn).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Mật khẩu"));
    await user.type(screen.getByLabelText("Mật khẩu"), "abc1234");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    expect(
      await screen.findByText("Mật khẩu cần có ít nhất 8 ký tự."),
    ).toBeInTheDocument();
    expect(service.signIn).not.toHaveBeenCalled();
  });

  it("toggles password visibility and renders clear placeholders and accessible login chrome", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    render(withAuthFixture(<LoginScreen scenario="default" />, service));

    const emailInput = screen.getByLabelText("Email của ba mẹ");
    const passwordInput = screen.getByLabelText("Mật khẩu");
    expect(emailInput).toHaveAttribute("placeholder", "vidu@email.com");
    expect(passwordInput).toHaveAttribute("placeholder", "Nhập mật khẩu");
    expect(passwordInput).toHaveAttribute("type", "password");

    const toggleBtn = screen.getByRole("button", { name: "Hiện mật khẩu" });
    expect(toggleBtn).toHaveAttribute("aria-pressed", "false");
    await user.click(toggleBtn);
    expect(passwordInput).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Ẩn mật khẩu" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Header/Footer accessibility checks
    expect(
      screen.getByRole("link", { name: "ViRead - Đăng nhập" }),
    ).toHaveAttribute("href", "/login");
    expect(
      screen.getByRole("link", { name: "ViRead - Về trang đăng nhập" }),
    ).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Đăng nhập" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const signupLink = screen.getByRole("link", { name: /Chưa có tài khoản/ });
    expect(signupLink.className).not.toContain("w-full");
  });

  it("navigates to the dashboard after a successful service response", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    renderLoginForm("default", service);
    await fillValidLogin(user);
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
    expect(service.signIn).toHaveBeenCalledWith({
      email: "minhanh@example.com",
      password: "matkhau123",
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("routes an admin role to the fixed admin destination", async () => {
    const service = createAuthServiceFixture();
    service.getCurrentRole.mockResolvedValue("admin");
    const user = userEvent.setup();
    renderLoginForm("default", service);
    await fillValidLogin(user);
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith("/admin/books"),
    );
  });

  it("completes a verified signup callback using the profile role", async () => {
    const service = createAuthServiceFixture();
    render(
      withAuthFixture(
        <LoginForm isAuthCallback scenario="default" />,
        service,
        { lastEvent: "SIGNED_IN", session: authSessionFixture },
      ),
    );
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
    expect(service.getCurrentRole).toHaveBeenCalledOnce();
    expect(service.signIn).not.toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("fails closed when a signup callback has no valid profile role", async () => {
    const service = createAuthServiceFixture();
    service.getCurrentRole.mockResolvedValue(null);
    render(
      withAuthFixture(
        <LoginForm isAuthCallback scenario="default" />,
        service,
        { lastEvent: "SIGNED_IN", session: authSessionFixture },
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(service.signOut).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Đăng nhập" })).toBeEnabled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("fails closed and signs out when role lookup fails", async () => {
    const service = createAuthServiceFixture();
    service.getCurrentRole.mockRejectedValue(
      new AuthServiceError("unexpected", "Sensitive provider details"),
    );
    const user = userEvent.setup();
    renderLoginForm("default", service);
    await fillValidLogin(user);
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(alert).not.toHaveTextContent("Sensitive provider details");
    expect(service.signOut).toHaveBeenCalledOnce();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it.each(["google", "facebook"] as const)(
    "starts social sign-in with %s",
    async (provider) => {
      const service = createAuthServiceFixture();
      const user = userEvent.setup();
      renderLoginForm("default", service);

      await user.click(
        screen.getByRole("button", {
          name: `Tiếp tục với ${provider === "google" ? "Google" : "Facebook"}`,
        }),
      );

      await waitFor(() =>
        expect(service.signInWithOAuth).toHaveBeenCalledWith(provider),
      );
    },
  );

  it("explains why Facebook sign-in is blocked when email is missing", () => {
    render(
      withAuthFixture(
        <LoginForm scenario="default" oauthError="email_required" />,
        createAuthServiceFixture(),
      ),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Facebook không cung cấp email",
    );
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
