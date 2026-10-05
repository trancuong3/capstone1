import {
  AuthApiError,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { createSupabaseAdminAuthService } from "@/lib/supabase/admin-auth-service";

const adminUser = {
  id: "88000000-0000-4000-8000-000000000001",
  email: "admin@example.com",
  user_metadata: {},
} as unknown as User;

const adminSession = { user: adminUser } as unknown as Session;

function authError(code: string) {
  return new AuthApiError("Provider error", 400, code);
}

function createHarness() {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: { displayname: "Admin ReadAlong", role: "admin" },
    error: null,
  });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const initialize = vi.fn().mockResolvedValue({
    data: { session: null },
    error: null,
  });
  const signInWithPassword = vi.fn().mockResolvedValue({
    data: { session: adminSession, user: adminUser },
    error: null,
  });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const client = {
    auth: { initialize, signInWithPassword, signOut },
    from,
  } as unknown as SupabaseClient;

  return {
    client,
    eq,
    from,
    initialize,
    maybeSingle,
    select,
    signInWithPassword,
    signOut,
  };
}

describe("SupabaseAdminAuthService", () => {
  it("signs in only after reading the admin role from profiles", async () => {
    const harness = createHarness();

    await expect(
      createSupabaseAdminAuthService(harness.client).signIn({
        email: "admin@example.com",
        password: "password123",
      }),
    ).resolves.toEqual({
      actor_id: adminUser.id,
      display_name: "Admin ReadAlong",
      role: "admin",
    });

    expect(harness.initialize).toHaveBeenCalledOnce();
    expect(harness.from).toHaveBeenCalledWith("profiles");
    expect(harness.select).toHaveBeenCalledWith("role, displayname");
    expect(harness.eq).toHaveBeenCalledWith("id", adminUser.id);
  });

  it("fails closed and clears a parent session", async () => {
    const harness = createHarness();
    harness.maybeSingle.mockResolvedValue({
      data: { displayname: "Parent", role: "parent" },
      error: null,
    });

    await expect(
      createSupabaseAdminAuthService(harness.client).signIn({
        email: "parent@example.com",
        password: "password123",
      }),
    ).rejects.toMatchObject({ reason: "forbidden" });
    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("normalizes invalid credentials", async () => {
    const harness = createHarness();
    harness.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: authError("invalid_credentials"),
    });

    await expect(
      createSupabaseAdminAuthService(harness.client).signIn({
        email: "admin@example.com",
        password: "wrong-password",
      }),
    ).rejects.toMatchObject({ reason: "invalid-credentials" });
  });

  it("uses local sign-out scope", async () => {
    const harness = createHarness();

    await createSupabaseAdminAuthService(harness.client).signOut();

    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
