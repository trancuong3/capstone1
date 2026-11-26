import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";
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
    expect(
      await screen.findByText("Mật khẩu cần có ít nhất 8 ký tự."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Mật khẩu")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(service.signIn).not.toHaveBeenCalled();
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

  it("returns to a safe parent deep link after email/password login and signup callback", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    render(
      withAuthFixture(
        <LoginForm nextPath="/books/book-1?tab=preview" scenario="default" />,
        service,
      ),
    );
    await fillValidLogin(user);
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith("/books/book-1?tab=preview"),
    );

    replaceMock.mockClear();
    render(
      withAuthFixture(
        <LoginForm
          isAuthCallback
          nextPath="/reading/session-9?childId=c1"
          scenario="default"
        />,
        service,
        { lastEvent: "SIGNED_IN", session: authSessionFixture },
      ),
    );
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith("/reading/session-9?childId=c1"),
    );
  });

  it("blocks open redirects and cross-role next targets after login", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    render(
      withAuthFixture(
        <LoginForm nextPath="//evil.example/steal" scenario="default" />,
        service,
      ),
    );
    await fillValidLogin(user);
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));

    replaceMock.mockClear();
    const { unmount } = render(
      withAuthFixture(
        <LoginForm nextPath="/admin/parents" scenario="default" />,
        service,
      ),
    );
    const emailInputs = screen.getAllByLabelText("Email của ba mẹ");
    const passwordInputs = screen.getAllByLabelText("Mật khẩu");
    const submitButtons = screen.getAllByRole("button", { name: "Đăng nhập" });
    await user.type(emailInputs[1]!, "minhanh@example.com");
    await user.type(passwordInputs[1]!, "matkhau123");
    await user.click(submitButtons[1]!);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/dashboard"));
    unmount();
  });

  it("persists safe next path in cookie before OAuth and clears it on OAuth failure", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    render(
      withAuthFixture(
        <LoginForm nextPath="/books/book-2?page=3" scenario="default" />,
        service,
      ),
    );

    await user.click(
      screen.getByRole("button", { name: "Tiếp tục với Google" }),
    );
    await waitFor(() =>
      expect(service.signInWithOAuth).toHaveBeenCalledWith("google"),
    );
    expect(document.cookie).toContain(
      "viread_auth_next=%2Fbooks%2Fbook-2%3Fpage%3D3",
    );

    service.signInWithOAuth.mockRejectedValueOnce(new Error("oauth error"));
    await user.click(
      screen.getByRole("button", { name: "Tiếp tục với Facebook" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Không thể bắt đầu đăng nhập xã hội",
    );
    expect(document.cookie).not.toContain("viread_auth_next=");
  });
});
