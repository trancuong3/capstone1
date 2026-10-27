// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseClientMock } = vi.hoisted(() => ({
  createServerSupabaseClientMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: createServerSupabaseClientMock,
}));

import { GET } from "@/app/auth/callback/route";

const APP_ORIGIN = "http://localhost:3000";
const CALLBACK_PATH = "/auth/callback?code=oauth-code";

function requestFor(path: string) {
  return new NextRequest(new URL(path, APP_ORIGIN));
}

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

  it("routes a parent to the dashboard", async () => {
    const harness = makeSupabase();
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(requestFor(CALLBACK_PATH));

    expect(response.headers.get("location")).toBe(`${APP_ORIGIN}/dashboard`);
    expect(harness.exchangeCodeForSession).toHaveBeenCalledWith("oauth-code");
    expect(harness.select).toHaveBeenCalledWith("role");
    expect(harness.eq).toHaveBeenCalledWith(
      "id",
      "10000000-0000-4000-8000-000000000001",
    );
  });

  it("allows a verified email-change callback to return to Profile", async () => {
    const harness = makeSupabase();
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(
      requestFor("/auth/callback?code=email-change-code&next=%2Fprofile"),
    );

    expect(response.headers.get("location")).toBe(`${APP_ORIGIN}/profile`);
    expect(harness.exchangeCodeForSession).toHaveBeenCalledWith(
      "email-change-code",
    );
  });

  it("does not allow an external callback redirect target", async () => {
    const harness = makeSupabase();
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(
      requestFor(
        "/auth/callback?code=oauth-code&next=https%3A%2F%2Fevil.example",
      ),
    );

    expect(response.headers.get("location")).toBe(`${APP_ORIGIN}/dashboard`);
  });

  it("routes an admin to the admin area", async () => {
    const harness = makeSupabase({ role: "admin" });
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(requestFor(CALLBACK_PATH));

    expect(response.headers.get("location")).toBe(`${APP_ORIGIN}/admin/books`);
  });

  it("rejects users without an email", async () => {
    const harness = makeSupabase({ email: null });
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(requestFor(CALLBACK_PATH));

    expect(response.headers.get("location")).toBe(
      `${APP_ORIGIN}/login?oauth_error=email_required`,
    );
    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(harness.from).not.toHaveBeenCalled();
  });

  it("rejects users without a valid role", async () => {
    const harness = makeSupabase({ role: null });
    createServerSupabaseClientMock.mockResolvedValue(harness.client);

    const response = await GET(requestFor(CALLBACK_PATH));

    expect(response.headers.get("location")).toBe(
      `${APP_ORIGIN}/login?oauth_error=oauth_failed`,
    );
    expect(harness.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("hides provider errors", async () => {
    const response = await GET(
      requestFor(
        "/auth/callback?error=access_denied&error_description=Sensitive",
      ),
    );

    expect(response.headers.get("location")).toBe(
      `${APP_ORIGIN}/login?oauth_error=oauth_failed`,
    );
    expect(createServerSupabaseClientMock).not.toHaveBeenCalled();
  });
});
