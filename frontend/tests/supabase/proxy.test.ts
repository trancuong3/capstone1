// @vitest-environment node

import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClientMock, getClaimsMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(),
  getClaimsMock: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

import {
  preserveSupabaseAuthResponse,
  refreshSupabaseAuth,
} from "@/lib/supabase/proxy";

interface TestedCookieAdapter {
  setAll(
    cookies: Array<{
      name: string;
      options: { httpOnly: boolean; path: string };
      value: string;
    }>,
    headers: Record<string, string>,
  ): void;
}

let cookieAdapter: TestedCookieAdapter;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  createServerClientMock.mockReset();
  getClaimsMock.mockReset();

  createServerClientMock.mockImplementation(
    (_url: string, _key: string, options: { cookies: TestedCookieAdapter }) => {
      cookieAdapter = options.cookies;
      return { auth: { getClaims: getClaimsMock } };
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Supabase proxy auth refresh", () => {
  it("forwards refreshed cookies to the request and response with cache headers", async () => {
    getClaimsMock.mockImplementation(async () => {
      cookieAdapter.setAll(
        [
          {
            name: "sb-session",
            options: { httpOnly: true, path: "/" },
            value: "refreshed",
          },
        ],
        {
          "Cache-Control": "private, no-store",
          Expires: "0",
          Pragma: "no-cache",
        },
      );

      return { data: { claims: { sub: "user-id" } }, error: null };
    });

    const request = new NextRequest("https://app.example.com/dashboard");
    const result = await refreshSupabaseAuth(request);

    expect(result.userId).toBe("user-id");
    expect(request.cookies.get("sb-session")?.value).toBe("refreshed");
    expect(result.response.cookies.get("sb-session")?.value).toBe("refreshed");
    expect(result.response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(result.response.headers.get("expires")).toBe("0");
    expect(result.response.headers.get("pragma")).toBe("no-cache");
  });

  it("preserves refresh state when the final response is a redirect", () => {
    const source = NextResponse.next();
    source.cookies.set("sb-session", "refreshed", {
      httpOnly: true,
      path: "/",
    });
    source.headers.set("Cache-Control", "private, no-store");
    source.headers.set("Expires", "0");
    source.headers.set("Pragma", "no-cache");

    const response = preserveSupabaseAuthResponse(
      source,
      NextResponse.redirect("https://app.example.com/login"),
    );

    expect(response.status).toBe(307);
    expect(response.cookies.get("sb-session")?.value).toBe("refreshed");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("fails closed when verified claims are unavailable", async () => {
    getClaimsMock.mockResolvedValue({
      data: null,
      error: new Error("invalid token"),
    });

    await expect(
      refreshSupabaseAuth(new NextRequest("https://app.example.com/dashboard")),
    ).resolves.toMatchObject({ userId: null });
  });
});
