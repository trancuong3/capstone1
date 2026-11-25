// @vitest-environment node

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  headersMock,
  redirectMock,
  createServerSupabaseClientMock,
  refreshSupabaseAuthMock,
  preserveSupabaseAuthResponseMock,
} = vi.hoisted(() => ({
  headersMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  createServerSupabaseClientMock: vi.fn(),
  refreshSupabaseAuthMock: vi.fn(),
  preserveSupabaseAuthResponseMock: vi.fn(
    (_source: NextResponse, target: NextResponse) => target,
  ),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: headersMock,
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: createServerSupabaseClientMock,
}));

vi.mock("@/lib/supabase/proxy", () => ({
  refreshSupabaseAuth: refreshSupabaseAuthMock,
  preserveSupabaseAuthResponse: preserveSupabaseAuthResponseMock,
}));

import { requireAppRole } from "@/lib/auth/server-authorization";
import { proxy } from "@/proxy";

describe("deep-link redirect preservation in proxy and server authorization", () => {
  beforeEach(() => {
    headersMock.mockReset();
    redirectMock.mockClear();
    createServerSupabaseClientMock.mockReset();
    refreshSupabaseAuthMock.mockReset();
    preserveSupabaseAuthResponseMock.mockClear();
  });

  it("proxy preserves pathname and query in ?next= when redirecting unauthenticated parent", async () => {
    refreshSupabaseAuthMock.mockResolvedValue({
      response: NextResponse.next(),
      userId: null,
    });

    const req = new NextRequest(
      "http://localhost:3000/books/book-1?page=2&childId=c1",
    );
    const resp = await proxy(req);

    expect(resp.status).toBe(307);
    expect(resp.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fbooks%2Fbook-1%3Fpage%3D2%26childId%3Dc1",
    );
  });

  it("proxy preserves pathname and query in ?next= when redirecting unauthenticated admin", async () => {
    refreshSupabaseAuthMock.mockResolvedValue({
      response: NextResponse.next(),
      userId: null,
    });

    const req = new NextRequest(
      "http://localhost:3000/admin/parents?page=2&search=an",
    );
    const resp = await proxy(req);

    expect(resp.status).toBe(307);
    expect(resp.headers.get("location")).toBe(
      "http://localhost:3000/admin/login?next=%2Fadmin%2Fparents%3Fpage%3D2%26search%3Dan",
    );
  });

  it("proxy sets x-viread-next from the real request URL", async () => {
    refreshSupabaseAuthMock.mockResolvedValue({
      response: NextResponse.next(),
      userId: "user-1",
    });

    const req = new NextRequest(
      "http://localhost:3000/reading/sess-1?childId=c2",
      {
        headers: { "x-viread-next": "https://evil.example" },
      },
    );
    await proxy(req);

    expect(req.headers.get("x-viread-next")).toBe("/reading/sess-1?childId=c2");
  });

  it("requireAppRole preserves x-viread-next when unauthenticated", async () => {
    headersMock.mockResolvedValue(
      new Headers({ "x-viread-next": "/reading/sess-1?childId=c2" }),
    );
    createServerSupabaseClientMock.mockResolvedValue({
      auth: {
        getClaims: vi.fn().mockResolvedValue({ data: null, error: null }),
      },
    });

    await expect(requireAppRole("parent")).rejects.toThrow(
      "NEXT_REDIRECT:/login?next=%2Freading%2Fsess-1%3FchildId%3Dc2",
    );
  });

  it("requireAppRole preserves admin x-viread-next and redirects cross-role safely", async () => {
    headersMock.mockResolvedValue(
      new Headers({ "x-viread-next": "/admin/books/b1?tab=ocr" }),
    );
    createServerSupabaseClientMock.mockResolvedValue({
      auth: {
        getClaims: vi.fn().mockResolvedValue({ data: null, error: null }),
      },
    });

    await expect(requireAppRole("admin")).rejects.toThrow(
      "NEXT_REDIRECT:/admin/login?next=%2Fadmin%2Fbooks%2Fb1%3Ftab%3Docr",
    );
  });
});
