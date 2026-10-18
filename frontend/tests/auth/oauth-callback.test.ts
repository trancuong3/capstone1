import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseClientMock } = vi.hoisted(() => ({
  createServerSupabaseClientMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: createServerSupabaseClientMock,
}));

import { GET } from "@/app/auth/callback/route";

function makeSupabase({
  email = "parent@example.com",
  role = "parent",
  exchangeError = null,
  userError = null,
  profileError = null,
}: {
  email?: string | null;
  role?: string | null;
  exchangeError?: unknown;
  userError?: unknown;
  profileError?: unknown;
} = {}) {
  const user = {
    id: "10000000-0000-4000-8000-000000000001",
    email,
  };
  const maybeSingle = vi.fn().mockResolvedValue({
    data: role ? { role } : null,
    error: profileError,
  });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const exchangeCodeForSession = vi.fn().mockResolvedValue({
    data: { user },
    error: exchangeError,
  });
  const getUser = vi.fn().mockResolvedValue({
    data: { user },
    error: userError,
  });
  const signOut = vi.fn().mockResolvedValue({ error: null });

  return {
    client: {
      auth: { exchangeCodeForSession, getUser, signOut },
      from,
    },
    exchangeCodeForSession,
    from,
    getUser,
    signOut,
    select,
    eq,
    maybeSingle,
  };
}

describe("OAuth callback", () => {
  beforeEach(() => {
    createServerSupabaseClientMock.mockReset();
  });

  it("routes a parent with an email to the dashboard", async () => {
    const harness = makeSupabase();
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/auth/callback?code=oauth-code",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/dashboard",
    );
    expect(harness.exchangeCodeForSession).toHaveBeenCalledWith("oauth-code");
    expect(harness.select).toHaveBeenCalledWith("role");
    expect(harness.eq).toHaveBeenCalledWith(
      "id",
      "10000000-0000-4000-8000-000000000001",
    );
  });

  it("routes an admin with an email to the fixed admin destination", async () => {
    const harness = makeSupabase({ role: "admin" });
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/callback?code=oauth-code"),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/admin/books",
    );
  });

  it("signs out and blocks an OAuth user whose email is missing", async () => {
    const harness = makeSupabase({ email: null });
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/callback?code=oauth-code"),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?oauth_error=email_required",
    );
    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(harness.from).not.toHaveBeenCalled();
  });

  it("fails closed if the database profile has no allowed role", async () => {
    const harness = makeSupabase({ role: null });
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/callback?code=oauth-code"),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?oauth_error=oauth_failed",
    );
    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("does not expose raw provider errors when OAuth is cancelled or rejected", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost:3000/auth/callback?error=access_denied&error_description=Sensitive",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?oauth_error=oauth_failed",
    );
    expect(createServerSupabaseClientMock).not.toHaveBeenCalled();
  });
});
