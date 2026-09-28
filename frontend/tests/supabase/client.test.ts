import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { browserClient, createBrowserClientMock } = vi.hoisted(() => ({
  browserClient: { client: "browser" },
  createBrowserClientMock: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: createBrowserClientMock,
}));

import { createBrowserSupabaseClient } from "@/lib/supabase/client";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  createBrowserClientMock.mockReset();
  createBrowserClientMock.mockReturnValue(browserClient);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("browser Supabase client", () => {
  it("uses only the public project configuration", () => {
    expect(createBrowserSupabaseClient()).toBe(browserClient);
    expect(createBrowserClientMock).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "sb_publishable_test",
      { auth: { skipAutoInitialize: true } },
    );
  });
});
