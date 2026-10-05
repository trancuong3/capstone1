import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  AuthServiceContext,
  AuthServiceProvider,
} from "@/components/auth/auth-service-provider";
import { LoginForm } from "@/components/auth/login-form";
import { AuthServiceError } from "@/lib/api/auth-service";
import { createMockAuthService } from "@/lib/mock/mock-auth-service";
import type { AuthMockScenario } from "@/types/auth";

const { refreshMock, replaceMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, replace: replaceMock }),
}));

function renderLoginForm(scenario: AuthMockScenario = "default") {
  return render(
    <AuthServiceProvider mode="mock" scenario={scenario}>
      <LoginForm scenario={scenario} />
    </AuthServiceProvider>,
  );
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

    await fillValidLogin(user);
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/dashboard");
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("routes an admin role to the fixed admin destination", async () => {
    const service = createMockAuthService("default");
    vi.spyOn(service, "getCurrentRole").mockResolvedValue("admin");
    const user = userEvent.setup();
    render(
      <AuthServiceContext.Provider value={service}>
        <LoginForm scenario="default" />
      </AuthServiceContext.Provider>,
    );

    await fillValidLogin(user);
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/admin/books");
    });
  });

  it("completes a verified signup callback using the profile role", async () => {
    const service = createMockAuthService("default");
    vi.spyOn(service, "getCurrentRole").mockResolvedValue("parent");

    render(
      <AuthRuntimeContext.Provider
        value={{
          initializationFailure: null,
          isPasswordRecovery: false,
          lastEvent: "SIGNED_IN",
          mode: "supabase",
          session: {
            expires_at: null,
            user: {
              display_name: "Nguyen Minh Anh",
              email: "minhanh@example.com",
              id: "10000000-0000-4000-8000-000000000001",
            },
          },
          status: "ready",
        }}
      >
        <AuthServiceContext.Provider value={service}>
          <LoginForm isAuthCallback scenario="default" />
        </AuthServiceContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/dashboard");
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("fails closed when a signup callback has no valid profile role", async () => {
    const service = createMockAuthService("default");
    vi.spyOn(service, "getCurrentRole").mockResolvedValue(null);
    const signOut = vi.spyOn(service, "signOut");

    render(
      <AuthRuntimeContext.Provider
        value={{
          initializationFailure: null,
          isPasswordRecovery: false,
          lastEvent: "SIGNED_IN",
          mode: "supabase",
          session: {
            expires_at: null,
            user: {
              display_name: "Nguyen Minh Anh",
              email: "minhanh@example.com",
              id: "10000000-0000-4000-8000-000000000001",
            },
          },
          status: "ready",
        }}
      >
        <AuthServiceContext.Provider value={service}>
          <LoginForm isAuthCallback scenario="default" />
        </AuthServiceContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(signOut).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Đăng nhập" })).toBeEnabled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("fails closed and clears the session when role lookup fails", async () => {
    const service = createMockAuthService("default");
    vi.spyOn(service, "getCurrentRole").mockRejectedValue(
      new AuthServiceError("unexpected", "Sensitive provider details"),
    );
    const signOut = vi.spyOn(service, "signOut");
    const user = userEvent.setup();
    render(
      <AuthServiceContext.Provider value={service}>
        <LoginForm scenario="default" />
      </AuthServiceContext.Provider>,
    );

    await fillValidLogin(user);
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    );
    expect(signOut).toHaveBeenCalledOnce();
    expect(replaceMock).not.toHaveBeenCalled();
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
      "/register?state=default",
    );
  });
});
