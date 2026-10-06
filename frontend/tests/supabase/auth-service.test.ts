import {
  AuthApiError,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { AuthServiceError } from "@/lib/api/auth-service";
import { createSupabaseAuthService } from "@/lib/supabase/auth-service";

const providerUser = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "parent@example.com",
  user_metadata: { display_name: "Nguyen Minh Anh" },
} as unknown as User;

const providerSession = {
  expires_at: 1_800_000_000,
  user: providerUser,
} as unknown as Session;

function authError(code: string, name?: string) {
  const error = new AuthApiError("Provider error", 400, code);
  if (name) error.name = name;
  return error;
}

function createHarness() {
  let authListener:
    ((event: AuthChangeEvent, session: Session | null) => void) | undefined;

  const unsubscribe = vi.fn();
  const maybeSingle = vi.fn().mockResolvedValue({
    data: { role: "parent" },
    error: null,
  });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const signUp = vi.fn().mockResolvedValue({
    data: { session: providerSession, user: providerUser },
    error: null,
  });
  const signInWithPassword = vi.fn().mockResolvedValue({
    data: { session: providerSession, user: providerUser },
    error: null,
  });
  const resetPasswordForEmail = vi.fn().mockResolvedValue({
    data: {},
    error: null,
  });
  const updateUser = vi.fn().mockResolvedValue({
    data: { user: providerUser },
    error: null,
  });
  const getSession = vi.fn().mockResolvedValue({
    data: { session: providerSession },
    error: null,
  });
  const getUser = vi.fn().mockResolvedValue({
    data: { user: providerUser },
    error: null,
  });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const initialize = vi.fn().mockResolvedValue({
    data: { session: providerSession },
    error: null,
  });
  const onAuthStateChange = vi.fn(
    (listener: (event: AuthChangeEvent, session: Session | null) => void) => {
      authListener = listener;
      return { data: { subscription: { unsubscribe } } };
    },
  );

  const client = {
    auth: {
      getSession,
      getUser,
      initialize,
      onAuthStateChange,
      resetPasswordForEmail,
      signInWithPassword,
      signOut,
      signUp,
      updateUser,
    },
    from,
  } as unknown as SupabaseClient;

  return {
    client,
    emit(event: AuthChangeEvent, session: Session | null) {
      authListener?.(event, session);
    },
    eq,
    from,
    getSession,
    getUser,
    initialize,
    maybeSingle,
    onAuthStateChange,
    resetPasswordForEmail,
    select,
    signInWithPassword,
    signOut,
    signUp,
    unsubscribe,
    updateUser,
  };
}

function createService(harness: ReturnType<typeof createHarness>) {
  return createSupabaseAuthService(harness.client, {
    getEmailConfirmationRedirectUrl: () =>
      "https://app.example.com/login?auth_callback=signup",
    getPasswordResetRedirectUrl: () => "https://app.example.com/reset-password",
  });
}

describe("SupabaseAuthService", () => {
  it("initializes the provider only after listeners can be registered", async () => {
    const harness = createHarness();

    await createService(harness).initialize();

    expect(harness.initialize).toHaveBeenCalledOnce();
  });

  it("registers a parent without accepting a role from the client", async () => {
    const harness = createHarness();
    const service = createService(harness);

    await expect(
      service.registerParent({
        displayName: "Nguyen Minh Anh",
        email: "parent@example.com",
        password: "password123",
      }),
    ).resolves.toEqual({
      status: "authenticated",
      session: {
        expires_at: 1_800_000_000,
        user: {
          display_name: "Nguyen Minh Anh",
          email: "parent@example.com",
          id: "10000000-0000-4000-8000-000000000001",
        },
      },
    });
    expect(harness.signUp).toHaveBeenCalledWith({
      email: "parent@example.com",
      password: "password123",
      options: {
        data: { display_name: "Nguyen Minh Anh" },
        emailRedirectTo: "https://app.example.com/login?auth_callback=signup",
      },
    });
  });

  it("returns the email confirmation outcome when signup has no session", async () => {
    const harness = createHarness();
    harness.signUp.mockResolvedValue({
      data: { session: null, user: providerUser },
      error: null,
    });

    await expect(
      createService(harness).registerParent({
        displayName: "Nguyen Minh Anh",
        email: "parent@example.com",
        password: "password123",
      }),
    ).resolves.toEqual({
      status: "email-confirmation-required",
      session: null,
    });
  });

  it("normalizes duplicate signup without exposing account existence", async () => {
    const harness = createHarness();
    harness.signUp.mockResolvedValue({
      data: { session: null, user: null },
      error: authError("email_exists"),
    });

    await expect(
      createService(harness).registerParent({
        displayName: "Nguyen Minh Anh",
        email: "parent@example.com",
        password: "password123",
      }),
    ).resolves.toEqual({
      status: "email-confirmation-required",
      session: null,
    });
  });

  it("maps provider registration validation without exposing raw errors", async () => {
    const harness = createHarness();
    harness.signUp.mockResolvedValue({
      data: { session: null, user: null },
      error: authError("weak_password"),
    });

    await expect(
      createService(harness).registerParent({
        displayName: "Nguyen Minh Anh",
        email: "parent@example.com",
        password: "short",
      }),
    ).rejects.toMatchObject({ reason: "registration-validation" });
  });

  it.each(["invalid_credentials", "email_not_confirmed", "user_not_found"])(
    "maps %s to the same safe sign-in failure",
    async (code) => {
      const harness = createHarness();
      harness.signInWithPassword.mockResolvedValue({
        data: { session: null, user: null },
        error: authError(code),
      });

      await expect(
        createService(harness).signIn({
          email: "parent@example.com",
          password: "wrong-password",
        }),
      ).rejects.toMatchObject({ reason: "invalid-credentials" });
    },
  );

  it("signs in with password and returns a safe session snapshot", async () => {
    const harness = createHarness();

    await expect(
      createService(harness).signIn({
        email: "parent@example.com",
        password: "password123",
      }),
    ).resolves.toMatchObject({ user: { id: providerUser.id } });
    expect(harness.signInWithPassword).toHaveBeenCalledWith({
      email: "parent@example.com",
      password: "password123",
    });
  });

  it("maps the current session and verified current user", async () => {
    const harness = createHarness();
    const service = createService(harness);

    await expect(service.getSession()).resolves.toMatchObject({
      user: { id: providerUser.id },
    });
    await expect(service.getCurrentUser()).resolves.toEqual({
      display_name: "Nguyen Minh Anh",
      email: "parent@example.com",
      id: providerUser.id,
    });
  });

  it("returns null when there is no current session or authenticated user", async () => {
    const harness = createHarness();
    harness.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    harness.getUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });
    const service = createService(harness);

    await expect(service.getSession()).resolves.toBeNull();
    await expect(service.getCurrentUser()).resolves.toBeNull();
    await expect(service.getCurrentRole()).resolves.toBeNull();
  });

  it("reads and validates the application role from the authenticated profile", async () => {
    const harness = createHarness();

    await expect(createService(harness).getCurrentRole()).resolves.toBe(
      "parent",
    );
    expect(harness.from).toHaveBeenCalledWith("profiles");
    expect(harness.select).toHaveBeenCalledWith("role");
    expect(harness.eq).toHaveBeenCalledWith("id", providerUser.id);
  });

  it("fails closed and signs out locally when the profile role is missing", async () => {
    const harness = createHarness();
    harness.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(
      createService(harness).getCurrentRole(),
    ).rejects.toBeInstanceOf(AuthServiceError);
    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("sends a non-enumerating password recovery request to the configured URL", async () => {
    const harness = createHarness();

    await createService(harness).requestPasswordReset({
      email: "parent@example.com",
    });

    expect(harness.resetPasswordForEmail).toHaveBeenCalledWith(
      "parent@example.com",
      { redirectTo: "https://app.example.com/reset-password" },
    );
  });

  it.each([
    ["session_expired", "expired-recovery-context"],
    ["bad_code_verifier", "invalid-recovery-context"],
  ] as const)("maps %s during password reset", async (code, reason) => {
    const harness = createHarness();
    const service = createService(harness);
    service.onAuthStateChange(() => undefined);
    harness.emit("PASSWORD_RECOVERY", providerSession);
    harness.updateUser.mockResolvedValue({
      data: { user: null },
      error: authError(code),
    });

    await expect(
      service.resetPassword({ newPassword: "new-password" }),
    ).rejects.toMatchObject({ reason });
  });

  it("clears recovery authority after a failed password update", async () => {
    const harness = createHarness();
    const service = createService(harness);
    service.onAuthStateChange(() => undefined);
    harness.emit("PASSWORD_RECOVERY", providerSession);
    harness.updateUser.mockResolvedValue({
      data: { user: null },
      error: authError("bad_code_verifier"),
    });

    await expect(
      service.resetPassword({ newPassword: "new-password" }),
    ).rejects.toMatchObject({ reason: "invalid-recovery-context" });
    harness.updateUser.mockResolvedValue({
      data: { user: providerUser },
      error: null,
    });
    await expect(
      service.resetPassword({ newPassword: "another-password" }),
    ).rejects.toMatchObject({ reason: "invalid-recovery-context" });
    expect(harness.updateUser).toHaveBeenCalledOnce();
  });

  it("maps an expired recovery session while verifying the current user", async () => {
    const harness = createHarness();
    const service = createService(harness);
    service.onAuthStateChange(() => undefined);
    harness.emit("PASSWORD_RECOVERY", providerSession);
    harness.getUser.mockResolvedValue({
      data: { user: null },
      error: authError("session_expired"),
    });

    await expect(
      service.resetPassword({ newPassword: "new-password" }),
    ).rejects.toMatchObject({ reason: "expired-recovery-context" });
    expect(harness.updateUser).not.toHaveBeenCalled();
  });

  it("blocks password updates without a verified recovery event", async () => {
    const harness = createHarness();

    await expect(
      createService(harness).resetPassword({ newPassword: "new-password" }),
    ).rejects.toMatchObject({ reason: "invalid-recovery-context" });
    expect(harness.updateUser).not.toHaveBeenCalled();
  });

  it("binds password recovery to the user from the recovery event", async () => {
    const harness = createHarness();
    const service = createService(harness);
    service.onAuthStateChange(() => undefined);
    harness.emit("PASSWORD_RECOVERY", providerSession);

    await expect(
      service.resetPassword({ newPassword: "new-password" }),
    ).resolves.toBeUndefined();
    expect(harness.getUser).toHaveBeenCalled();
    expect(harness.updateUser).toHaveBeenCalledWith({
      password: "new-password",
    });
    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("keeps reset successful when post-update local sign-out fails", async () => {
    const harness = createHarness();
    const service = createService(harness);
    service.onAuthStateChange(() => undefined);
    harness.emit("PASSWORD_RECOVERY", providerSession);
    harness.signOut.mockResolvedValue({
      error: authError("unexpected_failure"),
    });

    await expect(
      service.resetPassword({ newPassword: "new-password" }),
    ).resolves.toBeUndefined();
    expect(harness.updateUser).toHaveBeenCalledWith({
      password: "new-password",
    });
  });

  it("rejects recovery when the current session belongs to another user", async () => {
    const harness = createHarness();
    const service = createService(harness);
    service.onAuthStateChange(() => undefined);
    harness.emit("PASSWORD_RECOVERY", providerSession);
    harness.getUser.mockResolvedValue({
      data: {
        user: { ...providerUser, id: "another-user-id" },
      },
      error: null,
    });

    await expect(
      service.resetPassword({ newPassword: "new-password" }),
    ).rejects.toMatchObject({ reason: "invalid-recovery-context" });
    expect(harness.updateUser).not.toHaveBeenCalled();
  });

  it("clears recovery authority after an ordinary sign-in event", async () => {
    const harness = createHarness();
    const service = createService(harness);
    service.onAuthStateChange(() => undefined);
    harness.emit("PASSWORD_RECOVERY", providerSession);
    harness.emit("SIGNED_IN", providerSession);

    await expect(
      service.resetPassword({ newPassword: "new-password" }),
    ).rejects.toMatchObject({ reason: "invalid-recovery-context" });
    expect(harness.updateUser).not.toHaveBeenCalled();
  });

  it("clears recovery authority on explicit sign-out", async () => {
    const harness = createHarness();
    const service = createService(harness);
    service.onAuthStateChange(() => undefined);
    harness.emit("PASSWORD_RECOVERY", providerSession);

    await service.signOut();

    await expect(
      service.resetPassword({ newPassword: "new-password" }),
    ).rejects.toMatchObject({ reason: "invalid-recovery-context" });
    expect(harness.updateUser).not.toHaveBeenCalled();
  });

  it("uses local sign-out scope", async () => {
    const harness = createHarness();

    await createService(harness).signOut();

    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("sanitizes thrown provider failures", async () => {
    const harness = createHarness();
    harness.signInWithPassword.mockRejectedValue(
      new Error("sensitive transport details"),
    );

    await expect(
      createService(harness).signIn({
        email: "parent@example.com",
        password: "password123",
      }),
    ).rejects.toMatchObject({
      reason: "unexpected",
      message: "The authentication provider could not complete the request.",
    });
  });

  it("maps auth-state sessions synchronously and exposes cleanup", () => {
    const harness = createHarness();
    const listener = vi.fn();
    const unsubscribe = createService(harness).onAuthStateChange(listener);

    harness.emit("SIGNED_IN", providerSession);
    expect(listener).toHaveBeenCalledWith(
      "SIGNED_IN",
      expect.objectContaining({
        user: expect.objectContaining({ id: providerUser.id }),
      }),
    );

    harness.emit("PASSWORD_RECOVERY", providerSession);
    expect(listener).toHaveBeenLastCalledWith(
      "PASSWORD_RECOVERY",
      expect.any(Object),
    );

    unsubscribe();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });
});
