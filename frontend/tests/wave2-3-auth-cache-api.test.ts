import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { createServerClientMock, getSessionMock, initializeMock } = vi.hoisted(
  () => ({
    createServerClientMock: vi.fn(),
    getSessionMock: vi.fn(),
    initializeMock: vi.fn(),
  }),
);

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: initializeMock,
      getSession: getSessionMock,
    },
  }),
}));

import { isAppShellNavItemActive } from "@/components/layout/app-shell";
import { requestApi } from "@/lib/api/api-client";
import { createChildService } from "@/lib/api/child-service";
import { createProfileService } from "@/lib/api/profile-service";
import {
  getCachedApiRead,
  invalidateApiReadCache,
  resetApiReadCacheForActorSwitch,
  runCoalescedApiGet,
  setApiReadCacheActorScope,
  setApiReadCacheEnabled,
} from "@/lib/api/read-cache";
import { createReadingService } from "@/lib/api/reading-service";
import {
  buildSpeechServiceError,
  isSttFallbackEligibleError,
  STT_FALLBACK_ELIGIBLE_CODES,
} from "@/lib/api/speech-error";
import {
  createSupportService,
  SupportFeedbackError,
} from "@/lib/api/support-service";
import {
  clearUserCache,
  readUserCache,
  sanitizeDashboardSummaryForCache,
  USER_CACHE_STORAGE_PREFIX,
  writeUserCache,
} from "@/lib/cache/user-query-cache";
import { createSupabaseAdminAuthService } from "@/lib/supabase/admin-auth-service";
import { refreshSupabaseAuth } from "@/lib/supabase/proxy";
import nextConfig from "@/next.config";
import { proxy } from "@/proxy";
import type { DashboardSummaryDTO } from "@/types/profile";

function mockSupabaseForProxy(params: {
  userId: string | null;
  role?: "parent" | "admin" | null;
}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: params.role ? { role: params.role, active: true } : null,
    error: null,
  });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));

  createServerClientMock.mockReturnValue({
    auth: {
      getClaims: vi.fn().mockResolvedValue({
        data: params.userId ? { claims: { sub: params.userId } } : null,
        error: null,
      }),
    },
    from,
  });

  return { from, maybeSingle };
}

describe("Wave 2-3 frontend core auth, cache, API, Next, and nav fixes", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://sampleid.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test");
    createServerClientMock.mockReset();
    initializeMock.mockReset().mockResolvedValue({ error: null });
    getSessionMock.mockReset().mockResolvedValue({
      data: { session: { access_token: "synthetic-bearer-token" } },
      error: null,
    });
    clearUserCache();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    clearUserCache();
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("proxy headers, ?next= preservation, and direct role routing", () => {
    it("strips untrusted client x-viread-* headers first and forwards real x-viread-next with query", async () => {
      mockSupabaseForProxy({ userId: "parent-1", role: "parent" });

      const request = new NextRequest(
        "https://app.example.test/books/book-42?page=3&childId=c1",
        {
          headers: {
            cookie: "sb-proj-auth-token=session-a",
            "x-viread-next": "https://evil.example/phish",
            "x-viread-ssr-auth": "forged.token",
            "x-viread-role": "admin",
          },
        },
      );

      const result = await refreshSupabaseAuth(request);
      expect(result.userId).toBe("parent-1");
      expect(result.role).toBe("parent");
      expect(
        result.response.headers.get("x-middleware-request-x-viread-next"),
      ).toBe("/books/book-42?page=3&childId=c1");
      expect(
        result.response.headers.get("x-middleware-request-x-viread-role"),
      ).toBeNull();
      expect(
        result.response.headers.get("x-middleware-request-x-viread-ssr-auth"),
      ).not.toBe("forged.token");
    });

    it("routes / and /admin directly to the user's role home without double-hop redirects", async () => {
      mockSupabaseForProxy({ userId: "admin-1", role: "admin" });
      const adminRootResp = await proxy(
        new NextRequest("https://app.example.test/"),
      );
      expect(adminRootResp.status).toBe(307);
      expect(adminRootResp.headers.get("location")).toBe(
        "https://app.example.test/admin/books",
      );

      mockSupabaseForProxy({ userId: "parent-1", role: "parent" });
      const parentRootResp = await proxy(
        new NextRequest("https://app.example.test/"),
      );
      expect(parentRootResp.status).toBe(307);
      expect(parentRootResp.headers.get("location")).toBe(
        "https://app.example.test/dashboard",
      );

      mockSupabaseForProxy({ userId: "parent-1", role: "parent" });
      const parentOnAdminResp = await proxy(
        new NextRequest("https://app.example.test/admin"),
      );
      expect(parentOnAdminResp.status).toBe(307);
      expect(parentOnAdminResp.headers.get("location")).toBe(
        "https://app.example.test/dashboard",
      );

      mockSupabaseForProxy({ userId: "admin-1", role: "admin" });
      const adminOnAdminResp = await proxy(
        new NextRequest("https://app.example.test/admin"),
      );
      expect(adminOnAdminResp.status).toBe(307);
      expect(adminOnAdminResp.headers.get("location")).toBe(
        "https://app.example.test/admin/books",
      );
    });
  });

  describe("read-cache invalidation vs actor-switch abort and epoch fencing", () => {
    it("invalidateApiReadCache clears cached entries without aborting in-flight reads and fences stale writes", async () => {
      setApiReadCacheEnabled(true);
      setApiReadCacheActorScope("parent-a");

      let capturedSignal: AbortSignal | undefined;
      let resolveInflight!: (value: { version: number }) => void;

      const inflight = runCoalescedApiGet(
        "/books/item-1",
        "token-a",
        undefined,
        (signal) => {
          capturedSignal = signal;
          return new Promise<{ version: number }>((resolve) => {
            resolveInflight = resolve;
          });
        },
      );

      invalidateApiReadCache();
      expect(capturedSignal?.aborted).toBe(false);

      // Resolving the pre-invalidation read still returns to its caller,
      // but epoch fencing prevents it from poisoning readCache.
      resolveInflight({ version: 1 });
      await expect(inflight).resolves.toEqual({ version: 1 });
      expect(getCachedApiRead("/books/item-1", "token-a")).toBeUndefined();
    });

    it("resetApiReadCacheForActorSwitch aborts in-flight reads and fences late writes even if loader ignores abort", async () => {
      setApiReadCacheEnabled(true);
      setApiReadCacheActorScope("parent-a");

      let capturedSignal: AbortSignal | undefined;
      let resolveLate!: (value: { owner: string }) => void;

      const inflight = runCoalescedApiGet(
        "/books/item-2",
        "token-a",
        undefined,
        (signal) => {
          capturedSignal = signal;
          return new Promise<{ owner: string }>((resolve) => {
            resolveLate = resolve;
          });
        },
      );

      resetApiReadCacheForActorSwitch();
      expect(capturedSignal?.aborted).toBe(true);

      // Even if a buggy loader ignores abort and resolves later, cache must stay clean.
      resolveLate({ owner: "parent-a" });
      await expect(inflight).resolves.toEqual({ owner: "parent-a" });
      expect(getCachedApiRead("/books/item-2", "token-a")).toBeUndefined();
    });
  });

  describe("user-query-cache signed query & studio asset blocking + PII stripping", () => {
    it("blocks ?token=, &token=, and /studio/assets/ payloads from being cached or read back", () => {
      writeUserCache("user-a", "signed-avatar", {
        avatar_url:
          "https://proj.supabase.co/storage/v1/object/sign/avatars/a.png?token=signed-secret",
      });
      writeUserCache("user-a", "ampersand-token", {
        url: "https://cdn.example.test/image.png?width=200&token=signed-secret",
      });
      writeUserCache("user-a", "studio-asset", {
        url: "https://api.example.test/studio/assets/draft-1.png",
      });

      expect(readUserCache("user-a", "signed-avatar")).toBeNull();
      expect(readUserCache("user-a", "ampersand-token")).toBeNull();
      expect(readUserCache("user-a", "studio-asset")).toBeNull();

      // Pre-existing legacy record with signed ?token= in localStorage is purged on read.
      const legacyKey = `${USER_CACHE_STORAGE_PREFIX}user-a:legacy-signed`;
      window.localStorage.setItem(
        legacyKey,
        JSON.stringify({
          userId: "user-a",
          key: "legacy-signed",
          updatedAt: Date.now(),
          data: { avatar_url: "https://proj.supabase.co/a.png?token=stale" },
        }),
      );
      expect(readUserCache("user-a", "legacy-signed")).toBeNull();
      expect(window.localStorage.getItem(legacyKey)).toBeNull();
    });

    it("strips parent contact_phone PII and signed ?token= avatar URLs before persisting summary", () => {
      const summary: DashboardSummaryDTO = {
        profile: {
          id: "parent-1",
          display_name: "Ba mẹ An",
          role: "parent",
          created_at: "2026-10-01T00:00:00Z",
          email: "parent@example.com",
          contact_phone: "+84901234567",
          pending_email: null,
          email_verified: true,
          contact_info_status: "available",
          avatar_url:
            "https://proj.supabase.co/storage/v1/object/sign/avatars/p1.png?token=secret-1",
          children: [
            {
              id: "child-1",
              alias: "Bé An",
              grade: 2,
              created_at: "2026-10-01T00:00:00Z",
              avatar_url:
                "https://proj.supabase.co/storage/v1/object/sign/avatars/c1.png?token=secret-2",
            },
          ],
        },
        children: [
          {
            id: "child-1",
            parent_id: "parent-1",
            alias: "Bé An",
            grade: 2,
            settings: {},
            created_at: "2026-10-01T00:00:00Z",
            avatar_url:
              "https://proj.supabase.co/storage/v1/object/sign/avatars/c1.png?token=secret-2",
          },
          {
            id: "child-2",
            parent_id: "parent-1",
            alias: "Bé Bình",
            grade: 3,
            settings: {},
            created_at: "2026-10-01T00:00:00Z",
            avatar_url: "https://cdn.example.test/public-avatar.webp",
          },
        ],
        latest_sessions_by_child: {},
        source: "dashboard-summary",
      };

      const sanitized = sanitizeDashboardSummaryForCache(summary);
      expect(sanitized.profile?.contact_phone).toBeNull();
      expect(sanitized.profile?.avatar_url).toBeNull();
      expect(sanitized.profile?.children[0]?.avatar_url).toBeNull();
      expect(sanitized.children[0]?.avatar_url).toBeNull();
      expect(sanitized.children[1]?.avatar_url).toBe(
        "https://cdn.example.test/public-avatar.webp",
      );

      writeUserCache("parent-1", "dashboard-summary", sanitized, {
        persist: "session",
      });
      expect(window.localStorage.length).toBe(0);
      const cached = readUserCache<DashboardSummaryDTO>(
        "parent-1",
        "dashboard-summary",
      );
      expect(cached?.profile?.contact_phone).toBeNull();
      expect(cached?.children).toHaveLength(2);
    });
  });

  describe("speech-error and api-client safe Vietnamese error mappings", () => {
    it("maps all Wave 2-3 STT and TTS codes cleanly and preserves Wave 1 fallback eligibility", () => {
      const sttInvalidCodes = [
        "UNSUPPORTED_AUDIO",
        "EMPTY_AUDIO",
        "AUDIO_TOO_LARGE",
        "GOOGLE_STT_AUDIO_TOO_LONG",
      ] as const;

      for (const providerCode of sttInvalidCodes) {
        const err = buildSpeechServiceError({
          capability: "STT_UNAVAILABLE",
          status: 422,
          providerCode,
        });
        expect(err.code).toBe("STT_INVALID_AUDIO");
        expect(err.retryable).toBe(false);
        expect(isSttFallbackEligibleError(err)).toBe(false);
      }

      const sttUnconfigured = buildSpeechServiceError({
        capability: "STT_UNAVAILABLE",
        status: 503,
        providerCode: "GOOGLE_STT_UNCONFIGURED",
      });
      expect(sttUnconfigured.code).toBe("STT_TEMPORARILY_UNAVAILABLE");
      expect(sttUnconfigured.retryable).toBe(true);
      expect(STT_FALLBACK_ELIGIBLE_CODES.has("GOOGLE_STT_UNCONFIGURED")).toBe(
        true,
      );
      expect(isSttFallbackEligibleError(sttUnconfigured)).toBe(true);

      for (const providerCode of [
        "TTS_QUOTA_EXCEEDED",
        "GOOGLE_TTS_DISABLED",
        "GOOGLE_TTS_UNCONFIGURED",
        "VOICE_NOT_FOUND",
      ] as const) {
        const err = buildSpeechServiceError({
          capability: "TTS_UNAVAILABLE",
          status: 503,
          providerCode,
        });
        expect(err.code).toBe("TTS_UNAVAILABLE");
        expect(err.retryable).toBe(false);
        expect(err.message).not.toContain(providerCode);
      }

      const invalidText = buildSpeechServiceError({
        capability: "TTS_UNAVAILABLE",
        status: 422,
        providerCode: "TTS_INVALID_TEXT",
      });
      expect(invalidText.code).toBe("VALIDATION_ERROR");
      expect(invalidText.retryable).toBe(false);
    });

    it("translates all 11 new api-client backend error codes to safe Vietnamese without leaking raw detail", async () => {
      const codes = [
        "BOOK_BLOCKED_BY_CHILD_SAFETY",
        "CONTENT_NOT_READY",
        "READING_RANGE_NOT_CONTIGUOUS",
        "INVALID_BOOK_METADATA",
        "PARENT_CONFLICT",
        "AUTH_PROVIDER_UNAVAILABLE",
        "DATABASE_OPERATION_FAILED",
        "PARENT_AUTH_OPERATION_FAILED",
        "PROCESSING_UNAVAILABLE",
        "PROVIDER_NOT_CONFIGURED",
        "REVISION_CONFLICT",
      ] as const;

      for (const code of codes) {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(
            new Response(
              JSON.stringify({
                detail: { code, message: "RAW_SQL_OR_STACKTRACE_LEAK" },
              }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            ),
          ),
        );

        let message = "";
        try {
          await requestApi("/books/test", z.object({ ok: z.boolean() }));
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }

        expect(message).not.toBe("Có lỗi xảy ra. Vui lòng thử lại sau.");
        expect(message).not.toContain("RAW_SQL_OR_STACKTRACE_LEAK");
        expect(message).not.toContain(code);
      }
    });
  });

  describe("reading-service 2147483647 retry timestamp clamp", () => {
    it("preserves timestamps above 32767 ms and clamps at 2147483647", async () => {
      const fetchMock = vi.fn().mockImplementation(async () =>
        Response.json({
          Id: "11111111-1111-4111-8111-111111111111",
          SessionId: "22222222-2222-4222-8222-222222222222",
          PageId: "33333333-3333-4333-8333-333333333333",
          PageRevisionId: "44444444-4444-4444-8444-444444444444",
          WordId: "55555555-5555-4555-8555-555555555555",
          Type: "WORD_RETRY",
          StartMs: 125_000,
          EndMs: 129_500,
          Confidence: null,
          Status: "CONFIRMED",
          Metadata: {},
          CreatedAt: "2026-11-26T00:00:00Z",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const service = createReadingService();
      await service.createRetryEvent({
        sessionId: "22222222-2222-4222-8222-222222222222",
        pageId: "33333333-3333-4333-8333-333333333333",
        pageRevisionId: "44444444-4444-4444-8444-444444444444",
        wordId: "55555555-5555-4555-8555-555555555555",
        status: "CONFIRMED",
        startMs: 125_000,
        endMs: 3_000_000_000,
      });

      const body = JSON.parse(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
      ) as { StartMs: number; EndMs: number };
      expect(body.StartMs).toBe(125_000);
      expect(body.EndMs).toBe(2_147_483_647);
    });
  });

  describe("child-service, profile-service, and support-service hardening", () => {
    it("blocks raw payload.detail reflection, validates schemas, and sets credentials: omit + redirect: error", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      // 1. child-service: raw error detail never leaks + fetch options enforced
      fetchMock.mockResolvedValueOnce(
        Response.json(
          { detail: "SELECT * FROM children WHERE secret='leak'" },
          { status: 500 },
        ),
      );
      await expect(createChildService().list()).rejects.toMatchObject({
        status: 500,
        message: "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
      });
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        credentials: "omit",
        redirect: "error",
      });

      // 2. child-service: invalid payload fails Zod validation cleanly
      fetchMock.mockResolvedValueOnce(Response.json({ unexpected: true }));
      await expect(createChildService().list()).rejects.toMatchObject({
        code: "NETWORK_ERROR",
        message: "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
      });

      // 3. profile-service: raw error detail never leaks + fetch options enforced
      fetchMock.mockResolvedValueOnce(
        Response.json(
          { detail: "psycopg.OperationalError: password auth failed" },
          { status: 500 },
        ),
      );
      await expect(createProfileService().get()).rejects.toMatchObject({
        status: 500,
        message: "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
      });
      expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
        credentials: "omit",
        redirect: "error",
      });

      // 4. profile-service: malformed JSON payload fails Zod validation cleanly
      fetchMock.mockResolvedValueOnce(Response.json({ id: 123, role: "root" }));
      await expect(createProfileService().get()).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });

      // 5. support-service: Zod validation + credentials: omit + redirect: error
      fetchMock.mockResolvedValueOnce(
        Response.json(
          { accepted: true, delivery_status: "invalid" },
          { status: 202 },
        ),
      );
      await expect(
        createSupportService().submitFeedback({
          category: "technical_issue",
          subject: "Test",
          message: "Test body",
          contact_email: "parent@example.com",
        }),
      ).rejects.toBeInstanceOf(SupportFeedbackError);
      expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
        credentials: "omit",
        redirect: "error",
      });
    });
  });

  describe("admin-auth-service initialization retry", () => {
    it("clears failed initialization promise so a subsequent signIn retries and succeeds", async () => {
      const adminUser = {
        id: "88000000-0000-4000-8000-000000000001",
        email: "admin@example.com",
      } as unknown as User;
      const adminSession = { user: adminUser } as unknown as Session;

      const initialize = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient network glitch"))
        .mockResolvedValueOnce({ error: null });
      const signInWithPassword = vi.fn().mockResolvedValue({
        data: { session: adminSession, user: adminUser },
        error: null,
      });
      const maybeSingle = vi.fn().mockResolvedValue({
        data: { displayname: "Admin ViRead", role: "admin", active: true },
        error: null,
      });
      const supabase = {
        auth: {
          initialize,
          signInWithPassword,
          signOut: vi.fn().mockResolvedValue({ error: null }),
        },
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle })),
          })),
        })),
      } as unknown as SupabaseClient;

      const service = createSupabaseAdminAuthService(supabase);

      await expect(
        service.signIn({
          email: "admin@example.com",
          password: "secret-password",
        }),
      ).rejects.toMatchObject({ reason: "safe-error" });

      await expect(
        service.signIn({
          email: "admin@example.com",
          password: "secret-password",
        }),
      ).resolves.toEqual({
        actor_id: adminUser.id,
        display_name: "Admin ViRead",
        role: "admin",
      });

      expect(initialize).toHaveBeenCalledTimes(2);
    });
  });

  describe("AppShell navigation active matching and Next.js CSP headers", () => {
    it("does not double-highlight /reports when visiting /reports/difficult-words", () => {
      expect(
        isAppShellNavItemActive("/reports/difficult-words", "/reports"),
      ).toBe(false);
      expect(
        isAppShellNavItemActive(
          "/reports/difficult-words",
          "/reports/difficult-words",
        ),
      ).toBe(true);
      expect(
        isAppShellNavItemActive(
          "/reports/difficult-words/practice",
          "/reports",
        ),
      ).toBe(false);
      expect(isAppShellNavItemActive("/reports", "/reports")).toBe(true);
      expect(isAppShellNavItemActive("/reports/child-1", "/reports")).toBe(
        true,
      );
    });

    it("gates localMediaOrigin strictly on isDev and includes supabaseOrigin in form-action", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_API_URL", "http://127.0.0.1:8000");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://auth.custom-viread.vn");

      const devHeaders = await nextConfig.headers?.();
      const devCsp = devHeaders
        ?.find((rule) => rule.source === "/:path*")
        ?.headers.find((h) => h.key === "Content-Security-Policy")?.value;

      expect(devCsp).toContain(
        "img-src 'self' https: blob: data: http://127.0.0.1:8000",
      );
      expect(devCsp).toContain(
        "media-src 'self' https: blob: data: http://127.0.0.1:8000",
      );
      expect(devCsp).toContain(
        "form-action 'self' https://*.supabase.co https://auth.custom-viread.vn",
      );

      // Production MUST deny plain HTTP loopback origins in img-src/media-src even when
      // NEXT_PUBLIC_API_URL is http://127.0.0.1:8000, while retaining supabaseOrigin in form-action.
      vi.stubEnv("NODE_ENV", "production");
      const prodLoopbackHeaders = await nextConfig.headers?.();
      const prodLoopbackCsp = prodLoopbackHeaders
        ?.find((rule) => rule.source === "/:path*")
        ?.headers.find((h) => h.key === "Content-Security-Policy")?.value;

      expect(prodLoopbackCsp).toContain("img-src 'self' https: blob: data:;");
      expect(prodLoopbackCsp).toContain("media-src 'self' https: blob: data:;");
      expect(prodLoopbackCsp).toContain(
        "form-action 'self' https://*.supabase.co https://auth.custom-viread.vn",
      );
    });
  });
});
