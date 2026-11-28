// @vitest-environment node

import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshSupabaseAuth: vi.fn(),
  preserveSupabaseAuthResponse: vi.fn(
    (_source: NextResponse, target: NextResponse) => target,
  ),
}));

vi.mock("@/lib/supabase/proxy", () => ({
  refreshSupabaseAuth: mocks.refreshSupabaseAuth,
  preserveSupabaseAuthResponse: mocks.preserveSupabaseAuthResponse,
}));

import {
  getProtectedRouteArea,
  getProtectedRouteRedirect,
  sanitizeNextPath,
} from "@/lib/auth/route-policy";
import { config, proxy } from "@/proxy";

const ANDROID_WEBVIEW_UA =
  "Mozilla/5.0 (Linux; Android 16; HONOR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/134.0.0.0 Mobile Safari/537.36 ViReadAndroid/1.0";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";

function webViewRequest(pathnameWithQuery: string): NextRequest {
  return new NextRequest(`https://viread.example${pathnameWithQuery}`, {
    headers: { "user-agent": ANDROID_WEBVIEW_UA },
  });
}

describe("ViReadAndroid/1.0 mobile WebView proxy and route-policy checks", () => {
  beforeEach(() => {
    mocks.refreshSupabaseAuth.mockReset();
    mocks.preserveSupabaseAuthResponse.mockClear();
  });

  it("matches WebView app routes and skips excluded API routes", () => {
    for (const appUrl of [
      "/",
      "/login",
      "/dashboard",
      `/sessions/${SESSION_ID}/report`,
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url: appUrl })).toBe(true);
    }

    for (const bypassedUrl of [
      "/api/cron/parent-emails",
      "/api/parent-email-relay",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url: bypassedUrl })).toBe(
        false,
      );
    }
  });

  it("handles / and /login in ViReadAndroid/1.0 WebView", async () => {
    mocks.refreshSupabaseAuth.mockResolvedValueOnce({
      response: NextResponse.next(),
      userId: null,
    });

    const guestRootReq = webViewRequest("/");
    const guestRootRes = await proxy(guestRootReq);
    expect(guestRootRes.status).toBe(307);
    expect(guestRootRes.headers.get("location")).toBe(
      "https://viread.example/login",
    );
    expect(guestRootReq.headers.get("x-viread-next")).toBe("/");

    mocks.refreshSupabaseAuth.mockResolvedValueOnce({
      response: NextResponse.next(),
      userId: "parent-1",
      role: "parent",
    });

    const authedRootRes = await proxy(webViewRequest("/"));
    expect(authedRootRes.status).toBe(307);
    expect(authedRootRes.headers.get("location")).toBe(
      "https://viread.example/dashboard",
    );

    const loginPass = NextResponse.next();
    mocks.refreshSupabaseAuth.mockResolvedValueOnce({
      response: loginPass,
      userId: null,
    });

    const reportNext = encodeURIComponent(`/sessions/${SESSION_ID}/report`);
    const loginPath = `/login?next=${reportNext}`;
    const loginReq = webViewRequest(loginPath);
    const loginRes = await proxy(loginReq);
    expect(loginRes).toBe(loginPass);
    expect(loginReq.headers.get("x-viread-next")).toBe(loginPath);
  });

  it("guards parent routes in ViReadAndroid/1.0 with deep links", async () => {
    const reportPath = `/sessions/${SESSION_ID}/report`;
    expect(getProtectedRouteArea("/dashboard")).toBe("parent");
    expect(getProtectedRouteArea(reportPath)).toBe("parent");
    expect(getProtectedRouteRedirect(reportPath, null)).toBe("/login");
    expect(getProtectedRouteRedirect(reportPath, "admin")).toBe("/admin/books");
    expect(sanitizeNextPath(reportPath, "parent")).toBe(reportPath);
    expect(sanitizeNextPath("/admin/books", "parent")).toBe("/dashboard");

    mocks.refreshSupabaseAuth.mockResolvedValue({
      response: NextResponse.next(),
      userId: null,
    });

    const dashRes = await proxy(webViewRequest("/dashboard"));
    expect(dashRes.status).toBe(307);
    expect(dashRes.headers.get("location")).toBe(
      "https://viread.example/login?next=%2Fdashboard",
    );

    const reportQueryPath = `${reportPath}?page=2`;
    const encodedReportQuery = encodeURIComponent(reportQueryPath);
    const reportRes = await proxy(webViewRequest(reportQueryPath));
    expect(reportRes.status).toBe(307);
    expect(reportRes.headers.get("location")).toBe(
      `https://viread.example/login?next=${encodedReportQuery}`,
    );

    const authedPass = NextResponse.next();
    mocks.refreshSupabaseAuth.mockResolvedValueOnce({
      response: authedPass,
      userId: "parent-1",
      role: "parent",
    });

    const authedReportReq = webViewRequest(reportQueryPath);
    const authedReportRes = await proxy(authedReportReq);
    expect(authedReportRes).toBe(authedPass);
    expect(authedReportReq.headers.get("x-viread-next")).toBe(reportQueryPath);
  });
});
