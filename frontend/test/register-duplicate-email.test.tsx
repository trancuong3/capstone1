import {
  AuthApiError,
  type AuthResponse,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  AuthServiceContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import { RegisterForm } from "@/components/auth/register-form";
import { RegisterScreen } from "@/components/auth/register-screen";
import type { AuthService } from "@/lib/api/auth-service";
import { createSupabaseAuthService } from "@/lib/supabase/auth-service";

const { replace, refresh } = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => {
    throw new Error("Live Supabase clients are forbidden in this test.");
  },
}));

const safeError =
  "Không thể hoàn tất đăng ký. Ba mẹ vui lòng kiểm tra thông tin hoặc đăng nhập nếu đã có tài khoản.";
const pendingUser: User = {
  id: "10000000-0000-4000-8000-000000000001",
  aud: "authenticated",
  email: "parent@example.com",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { display_name: "Ba mẹ kiểm thử" },
  created_at: "2026-10-12T00:00:00Z",
  identities: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      user_id: "10000000-0000-4000-8000-000000000001",
      identity_id: "20000000-0000-4000-8000-000000000001",
      provider: "email",
    },
  ],
};
const session: Session = {
  user: pendingUser,
  access_token: "isolated-test-access-token",
  refresh_token: "isolated-test-refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 1_800_000_000,
};
const readyRuntime: AuthRuntimeState = {
  initializationFailure: null,
  isPasswordRecovery: false,
  lastEvent: null,
  mode: "supabase",
  session: null,
  status: "ready",
};
const fetchGuard = vi.fn<typeof fetch>();

function duplicateResponse(code = "email_exists"): AuthResponse {
  return {
    data: { user: null, session: null },
    error: new AuthApiError("Private provider detail", 422, code),
  };
}

function createHarness() {
  const signUp = vi.fn<SupabaseClient["auth"]["signUp"]>().mockResolvedValue({
    data: { user: pendingUser, session: null },
    error: null,
  });
  // The actual adapter only uses signUp here. No live SDK client is created.
  const auth: Pick<SupabaseClient["auth"], "signUp"> = { signUp };
  const client = { auth } as unknown as SupabaseClient;
  const getCurrentRole = vi
    .fn<AuthService["getCurrentRole"]>()
    .mockResolvedValue("parent");
  const signOut = vi.fn<AuthService["signOut"]>().mockResolvedValue(undefined);
  const service: AuthService = {
    ...createSupabaseAuthService(client, {
      getEmailConfirmationRedirectUrl: () =>
        "https://app.example.com/login?auth_callback=signup",
    }),
    getCurrentRole,
    signOut,
  };
  return { service, signUp, getCurrentRole, signOut };
}

function renderRegistration(
  harness: ReturnType<typeof createHarness>,
  { fullScreen = false, initializing = false } = {},
) {
  const confirmation = vi.fn();
  render(
    <AuthServiceContext.Provider value={harness.service}>
      <AuthRuntimeContext.Provider
        value={{
          ...readyRuntime,
          status: initializing ? "initializing" : "ready",
        }}
      >
        {fullScreen ? (
          <RegisterScreen scenario="default" />
        ) : (
          <RegisterForm
            onEmailConfirmationRequired={confirmation}
            scenario="default"
          />
        )}
      </AuthRuntimeContext.Provider>
    </AuthServiceContext.Provider>,
  );
  return confirmation;
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Họ và tên ba mẹ"), "Ba mẹ kiểm thử");
  await user.type(
    screen.getByLabelText("Email của ba mẹ (không bắt buộc)"),
    "parent@example.com",
  );
  await user.type(screen.getByLabelText("Mật khẩu"), "test-password-123");
}

describe("Registration duplicate-email regression", () => {
  beforeEach(() => {
    replace.mockClear();
    refresh.mockClear();
    fetchGuard.mockReset();
    fetchGuard.mockRejectedValue(new Error("Live network is forbidden."));
    vi.stubGlobal("fetch", fetchGuard);
  });

  afterEach(() => {
    try {
      expect(fetchGuard).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["email_exists", "user_already_exists"])(
    "keeps %s on the form without confirmation or child-profile navigation",
    async (code) => {
      const harness = createHarness();
      harness.signUp.mockResolvedValue(duplicateResponse(code));
      const confirmation = renderRegistration(harness);
      const user = userEvent.setup();
      await fillValidForm(user);
      await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(safeError);
      expect(screen.getByRole("alert")).not.toHaveTextContent(
        "Private provider detail",
      );
      expect(confirmation).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(harness.getCurrentRole).not.toHaveBeenCalled();
      expect(harness.signOut).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Email của ba mẹ (không bắt buộc)")).toHaveValue(
        "parent@example.com",
      );
      expect(
        screen.getByRole("link", { name: "Đã có tài khoản? Đăng nhập" }),
      ).toHaveAttribute("href", "/login");
    },
  );

  it("does not show the check-email screen for an obfuscated confirmed user", async () => {
    const harness = createHarness();
    harness.signUp.mockResolvedValue({
      data: { user: { ...pendingUser, identities: [] }, session: null },
      error: null,
    });
    renderRegistration(harness, { fullScreen: true });
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(safeError);
    expect(
      screen.queryByRole("heading", { name: "Kiểm tra email nhé" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email của ba mẹ (không bắt buộc)")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    { label: "new email", createdAt: "2026-10-12T00:00:00Z" },
    { label: "existing unconfirmed email", createdAt: "2026-09-01T00:00:00Z" },
  ])("preserves check-email for $label", async ({ createdAt }) => {
    const harness = createHarness();
    harness.signUp.mockResolvedValue({
      data: {
        user: { ...pendingUser, created_at: createdAt },
        session: null,
      },
      error: null,
    });
    renderRegistration(harness, { fullScreen: true });
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(
      await screen.findByRole("heading", { name: "Kiểm tra email nhé" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(harness.getCurrentRole).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("preserves child-profile navigation for a valid new authenticated parent", async () => {
    const harness = createHarness();
    harness.signUp.mockResolvedValue({
      data: { user: pendingUser, session },
      error: null,
    });
    const confirmation = renderRegistration(harness);
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/children/new?from=register"),
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(harness.getCurrentRole).toHaveBeenCalledOnce();
    expect(confirmation).not.toHaveBeenCalled();
    expect(harness.signOut).not.toHaveBeenCalled();
  });

  it("rejects a missing provider user without showing confirmation", async () => {
    const harness = createHarness();
    harness.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    });
    const confirmation = renderRegistration(harness);
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(safeError);
    expect(confirmation).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: "weak_password",
      message:
        "Thông tin đăng ký chưa hợp lệ. Ba mẹ vui lòng kiểm tra và thử lại.",
    },
    { code: "unexpected_failure", message: safeError },
  ])("keeps provider failure $code safe", async ({ code, message }) => {
    const harness = createHarness();
    harness.signUp.mockResolvedValue(duplicateResponse(code));
    const confirmation = renderRegistration(harness);
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "Private provider detail",
    );
    expect(confirmation).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps a network rejection safe and permits retry", async () => {
    const harness = createHarness();
    harness.signUp.mockRejectedValueOnce(
      new Error("sensitive transport details"),
    );
    const confirmation = renderRegistration(harness);
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(safeError);
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "sensitive transport details",
    );
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    await waitFor(() => expect(confirmation).toHaveBeenCalledOnce());
    expect(harness.signUp).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps field validation and does not call signup for an empty form", async () => {
    const harness = createHarness();
    renderRegistration(harness);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(
      await screen.findByText("Ba mẹ vui lòng nhập họ và tên."),
    ).toBeInTheDocument();
    expect(screen.getByText("Ba mẹ vui lòng nhập email hoặc số điện thoại.")).toBeInTheDocument();
    expect(
      screen.getByText("Mật khẩu cần có ít nhất 8 ký tự."),
    ).toBeInTheDocument();
    expect(harness.signUp).not.toHaveBeenCalled();
  });

  it("blocks repeated button clicks while pending and re-enables after rejection", async () => {
    const harness = createHarness();
    const pending = Promise.withResolvers<AuthResponse>();
    harness.signUp.mockReturnValueOnce(pending.promise);
    const confirmation = renderRegistration(harness);
    const user = userEvent.setup();
    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    const button = await screen.findByRole("button", {
      name: "Đang tạo tài khoản…",
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await user.click(button);
    expect(harness.signUp).toHaveBeenCalledOnce();

    await act(async () => pending.resolve(duplicateResponse()));
    expect(await screen.findByRole("alert")).toHaveTextContent(safeError);
    expect(screen.getByRole("button", { name: "Tạo tài khoản" })).toBeEnabled();
    expect(harness.signUp).toHaveBeenCalledOnce();
    expect(confirmation).not.toHaveBeenCalled();
  });

  it("does not submit while auth is initializing", () => {
    const harness = createHarness();
    renderRegistration(harness, { initializing: true });
    expect(
      screen.getByRole("button", { name: "Tạo tài khoản" }),
    ).toBeDisabled();
    expect(harness.signUp).not.toHaveBeenCalled();
  });
});
