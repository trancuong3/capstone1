// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookieStore, cookiesMock, createServerClientMock, serverClient } =
  vi.hoisted(() => ({
    cookieStore: {
      getAll: vi.fn(),
      set: vi.fn(),
    },
    cookiesMock: vi.fn(),
    createServerClientMock: vi.fn(),
    serverClient: { client: "server" },
  }));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

import { createServerSupabaseClient } from "@/lib/supabase/server";

interface TestedCookieAdapter {
  getAll(): unknown;
  setAll(
    cookies: Array<{
      name: string;
      value: string;
      options: Record<string, unknown>;
    }>,
  ): void;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  cookieStore.getAll.mockReset();
  cookieStore.set.mockReset();
  cookiesMock.mockReset();
  createServerClientMock.mockReset();
  cookiesMock.mockResolvedValue(cookieStore);
  createServerClientMock.mockReturnValue(serverClient);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server Supabase client", () => {
  it("adapts the asynchronous Next.js cookie store", async () => {
    const storedCookies = [{ name: "sb-session", value: "stored" }];
    cookieStore.getAll.mockReturnValue(storedCookies);

    await expect(createServerSupabaseClient()).resolves.toBe(serverClient);
    expect(cookiesMock).toHaveBeenCalledOnce();
    expect(createServerClientMock).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "sb_publishable_test",
      expect.objectContaining({ cookies: expect.any(Object) }),
    );

    const options = createServerClientMock.mock.calls[0]?.[2] as unknown as {
      cookies: TestedCookieAdapter;
    };

    expect(options.cookies.getAll()).toBe(storedCookies);

    options.cookies.setAll([
      {
        name: "sb-session",
        value: "updated",
        options: { path: "/" },
      },
    ]);

    expect(cookieStore.set).toHaveBeenCalledWith("sb-session", "updated", {
      path: "/",
    });
  });
});
