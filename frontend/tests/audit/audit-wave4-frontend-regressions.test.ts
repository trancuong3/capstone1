// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const { createServerSupabaseClientMock } = vi.hoisted(() => ({
  createServerSupabaseClientMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: createServerSupabaseClientMock,
}));

import { GET as oauthCallbackGet } from "@/app/auth/callback/route";
import {
  getProtectedRouteArea,
  getProtectedRouteRedirect,
} from "@/lib/auth/route-policy";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import { createSupabaseAdminAuthService } from "@/lib/supabase/admin-auth-service";
import { createSupabaseAuthService } from "@/lib/supabase/auth-service";

describe("Audit Wave 4 regressions (AUD-010, AUD-012, AUD-014)", () => {
  it("AUD-010: rejects deactivated profiles (active = 0) across OAuth callback, parent auth, and admin auth", async () => {
    // 1. OAuth callback
    const signOutOAuth = vi.fn().mockResolvedValue({ error: null });
    createServerSupabaseClientMock.mockResolvedValue({
      auth: {
        exchangeCodeForSession: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: "10000000-0000-4000-8000-000000000001",
              email: "p@example.com",
            },
          },
          error: null,
        }),
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: "10000000-0000-4000-8000-000000000001",
              email: "p@example.com",
            },
          },
          error: null,
        }),
        signOut: signOutOAuth,
      },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { role: "parent", active: 0 },
              error: null,
            }),
          })),
        })),
      })),
    });

    const res = await oauthCallbackGet(
      new NextRequest(new URL("http://localhost:3000/auth/callback?code=ok")),
    );
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/login?oauth_error=oauth_failed",
    );
    expect(signOutOAuth).toHaveBeenCalled();

    // 2. Parent auth getCurrentRole()
    const signOutParent = vi.fn().mockResolvedValue({ error: null });
    const fakeParentClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: "10000000-0000-4000-8000-000000000001",
              email: "p@example.com",
            },
          },
          error: null,
        }),
        signOut: signOutParent,
      },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { role: "parent", active: 0 },
              error: null,
            }),
          })),
        })),
      })),
    };
    const parentAuth = createSupabaseAuthService(fakeParentClient as never, {
      getOAuthRedirectUrl: () => "http://localhost:3000/auth/callback",
      getPasswordResetRedirectUrl: () => "http://localhost:3000/reset-password",
      getEmailConfirmationRedirectUrl: () => "http://localhost:3000/login",
    });
    await expect(parentAuth.getCurrentRole()).rejects.toThrow();
    expect(signOutParent).toHaveBeenCalled();

    // 3. Admin auth signInWithPassword()
    const signOutAdmin = vi.fn().mockResolvedValue({ error: null });
    const fakeAdminClient = {
      auth: {
        initialize: vi.fn().mockResolvedValue({ error: null }),
        signInWithPassword: vi.fn().mockResolvedValue({
          data: {
            session: { user: { id: "88000000-0000-4000-8000-000000000001" } },
          },
          error: null,
        }),
        signOut: signOutAdmin,
      },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { role: "admin", displayname: "Admin Locked", active: 0 },
              error: null,
            }),
          })),
        })),
      })),
    };
    const adminAuth = createSupabaseAdminAuthService(fakeAdminClient as never);
    await expect(
      adminAuth.signIn({
        email: "admin@example.com",
        password: "secret-pass",
      }),
    ).rejects.toMatchObject({ reason: "forbidden" });
    expect(signOutAdmin).toHaveBeenCalled();
  });

  it("AUD-014: classifies all parent routes in route-policy and guards /sessions/[sessionId]/report on SSR", () => {
    const parentRoutes = [
      "/book-reports",
      "/book-scanner",
      "/device-permissions",
      "/entertainment",
      "/entertainment/story-image",
      "/help-support",
      "/reading-management",
      "/reading-preparation",
      "/settings",
    ];
    for (const route of parentRoutes) {
      expect(getProtectedRouteArea(route)).toBe("parent");
      expect(getProtectedRouteRedirect(route, null)).toBe("/login");
      expect(getProtectedRouteRedirect(route, "admin")).toBe("/admin/books");
    }

    const reportPagePath = path.resolve(
      process.cwd(),
      "app/(app)/sessions/[sessionId]/report/page.tsx",
    );
    const duplicateReportLayoutPath = path.resolve(
      process.cwd(),
      "app/sessions/[sessionId]/report/layout.tsx",
    );
    const parentAppLayoutPath = path.resolve(
      process.cwd(),
      "app/(app)/layout.tsx",
    );
    expect(fs.existsSync(reportPagePath)).toBe(true);
    expect(fs.existsSync(duplicateReportLayoutPath)).toBe(false);
    expect(fs.readFileSync(parentAppLayoutPath, "utf8")).toContain(
      'requireAppRole("parent")',
    );
  });

  it("AUD-012: RealtimeAlignmentEngine matches hyphenated Vietnamese compound words ('ô-tô', 'ra-đi-ô') spoken as syllables", () => {
    const engine = new RealtimeAlignmentEngine([
      {
        word_id: "w1",
        word_index: 0,
        text: "Chiếc",
        bbox: [0.1, 0.1, 0.1, 0.05],
      },
      {
        word_id: "w2",
        word_index: 1,
        text: "ô-tô",
        bbox: [0.22, 0.1, 0.12, 0.05],
      },
      {
        word_id: "w3",
        word_index: 2,
        text: "có",
        bbox: [0.36, 0.1, 0.08, 0.05],
      },
      {
        word_id: "w4",
        word_index: 3,
        text: "ra-đi-ô",
        bbox: [0.46, 0.1, 0.16, 0.05],
      },
      {
        word_id: "w5",
        word_index: 4,
        text: "đỏ.",
        bbox: [0.64, 0.1, 0.1, 0.05],
      },
    ]);

    expect(engine.isOffTopicText("Chiếc ô tô có ra đi ô đỏ")).toBe(false);
    const snap = engine.addFinalTranscript("Chiếc ô tô có ra đi ô đỏ");
    expect(snap.statusByWordId.get("w1")?.status).toBe("MATCH");
    expect(snap.statusByWordId.get("w2")?.status).toBe("MATCH");
    expect(snap.statusByWordId.get("w3")?.status).toBe("MATCH");
    expect(snap.statusByWordId.get("w4")?.status).toBe("MATCH");
    expect(snap.statusByWordId.get("w5")?.status).toBe("MATCH");
  });

  it("AUD-015: bounces Android external-browser OAuth callback to viread://auth/callback before consuming PKCE code", async () => {
    const exchangeSpy = vi.fn();
    createServerSupabaseClientMock.mockResolvedValue({
      auth: { exchangeCodeForSession: exchangeSpy },
    });

    const chromeRes = await oauthCallbackGet(
      new NextRequest(
        new URL(
          "http://localhost:3000/auth/callback?app_shell=android&code=pkce_code_999&next=/profile",
        ),
        {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36",
          },
        },
      ),
    );
    expect(chromeRes.headers.get("location")).toBe(
      "viread://auth/callback?code=pkce_code_999&next=%2Fprofile",
    );
    expect(exchangeSpy).not.toHaveBeenCalled();
  });
});
