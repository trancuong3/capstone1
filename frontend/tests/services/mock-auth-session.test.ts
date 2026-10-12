import { createClient, type User } from "@supabase/supabase-js";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAuthService } from "@/lib/supabase/auth-service";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import type { AuthStateChangeListener } from "@/types/auth";

const providerUser: User = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "parent@example.com",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { display_name: "Test Parent" },
  aud: "authenticated",
  created_at: "2026-10-01T00:00:00Z",
  identities: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      user_id: "10000000-0000-4000-8000-000000000001",
      identity_id: "10000000-0000-4000-8000-000000000001",
      provider: "email",
    },
  ],
};
function sessionPayload() {
  return {
    access_token: "isolated-test-access-token",
    refresh_token: "isolated-test-refresh-token",
    expires_in: 3600,
    token_type: "bearer",
    user: providerUser,
  };
}
let clientNumber = 0;
function createService() {
  const client = createClient(
    "https://isolated.example.com",
    "isolated-test-key",
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        storageKey: `isolated-auth-session-${++clientNumber}`,
      },
      global: { fetch: apiFetchFixture },
    },
  );
  return createSupabaseAuthService(client, {
    getEmailConfirmationRedirectUrl: () =>
      "https://app.example.com/login?auth_callback=signup",
    getPasswordResetRedirectUrl: () => "https://app.example.com/reset-password",
  });
}
beforeEach(() => installApiFetchFixture());
afterEach(() => vi.unstubAllGlobals());

describe("Supabase AuthService session contract through isolated SDK transport", () => {
  it("starts signed out, signs in and resolves role from the profile endpoint", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/auth/v1/token"))
        return Response.json(sessionPayload());
      if (url.includes("/auth/v1/user")) return Response.json(providerUser);
      if (url.includes("/rest/v1/profiles"))
        return Response.json([{ role: "parent" }]);
      throw new Error("Unexpected isolated Auth route");
    });
    const service = createService();
    await service.initialize();
    expect(await service.getSession()).toBeNull();
    await service.signIn({
      email: "parent@example.com",
      password: "password123",
    });
    expect(await service.getCurrentUser()).toMatchObject({
      email: "parent@example.com",
    });
    expect(await service.getCurrentRole()).toBe("parent");
    const profileCall = apiFetchFixture.mock.calls.find(([input]) =>
      String(input).includes("/rest/v1/profiles"),
    );
    expect(profileCall).toBeDefined();
    expect(new URL(String(profileCall?.[0])).searchParams.get("id")).toBe(
      `eq.${providerUser.id}`,
    );
  });

  it("returns an authenticated registration result from a genuine session response", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(sessionPayload()));
    const service = createService();
    await expect(
      service.registerParent({
        displayName: "Test Parent",
        email: "parent@example.com",
        password: "password123",
      }),
    ).resolves.toMatchObject({
      status: "authenticated",
      session: { user: { email: "parent@example.com" } },
    });
    expect(String(apiFetchFixture.mock.calls[0][0])).toContain(
      "/auth/v1/signup",
    );
  });

  it("rejects a confirmed duplicate but preserves the pending confirmation outcome", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json(
        { code: "user_already_exists", msg: "Provider duplicate" },
        { status: 422 },
      ),
    );
    const service = createService();
    const input = {
      displayName: "Test Parent",
      email: "parent@example.com",
      password: "password123",
    };
    await expect(service.registerParent(input)).rejects.toMatchObject({
      reason: "unexpected",
    });
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({ user: providerUser }),
    );
    await expect(service.registerParent(input)).resolves.toEqual({
      status: "email-confirmation-required",
      session: null,
    });
  });

  it("notifies subscribers and stops delivering events after unsubscribe", async () => {
    apiFetchFixture.mockImplementation(async (input) => {
      if (String(input).includes("/auth/v1/token"))
        return Response.json(sessionPayload());
      if (String(input).includes("/auth/v1/logout"))
        return new Response(null, { status: 204 });
      throw new Error("Unexpected isolated Auth route");
    });
    const service = createService();
    const listener = vi.fn<AuthStateChangeListener>();
    const unsubscribe = service.onAuthStateChange(listener);
    try {
      await service.initialize();
      await waitFor(() =>
        expect(listener).toHaveBeenCalledWith("INITIAL_SESSION", null),
      );
      await service.signIn({
        email: "parent@example.com",
        password: "password123",
      });
      await service.signOut();
      expect(listener).toHaveBeenCalledWith(
        "SIGNED_IN",
        expect.objectContaining({
          user: expect.objectContaining({ id: providerUser.id }),
        }),
      );
      expect(listener).toHaveBeenCalledWith("SIGNED_OUT", null);
      expect(await service.getSession()).toBeNull();
      unsubscribe();
      const eventCount = listener.mock.calls.length;
      await service.signIn({
        email: "parent@example.com",
        password: "password123",
      });
      expect(listener).toHaveBeenCalledTimes(eventCount);
      await service.signOut();
    } finally {
      unsubscribe();
    }
  });
});
