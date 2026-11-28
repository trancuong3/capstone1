import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { getSession, initialize, refreshSession, fetchMock } = vi.hoisted(
  () => ({
    getSession: vi.fn(),
    initialize: vi.fn(),
    refreshSession: vi.fn(),
    fetchMock: vi.fn(),
  }),
);

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: { initialize, getSession, refreshSession },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "https://api.example.com",
}));

import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import { requestApi } from "@/lib/api/api-client";
import { resetBrowserAuthCache } from "@/lib/api/browser-auth";
import {
  clearApiReadCache,
  setApiReadCacheActorScope,
  setApiReadCacheEnabled,
} from "@/lib/api/read-cache";
import { ServiceError } from "@/lib/api/service-error";
import {
  createSupportService,
  SupportFeedbackError,
} from "@/lib/api/support-service";

const okSchema = z.object({ ok: z.boolean() });

describe("requestApi cold-start resilience, 204 support, scoped cache invalidation & migrated services", () => {
  beforeEach(() => {
    resetBrowserAuthCache();
    clearApiReadCache();
    setApiReadCacheEnabled(false);
    setApiReadCacheActorScope("parent-1");
    initialize.mockReset().mockResolvedValue({ error: null });
    getSession.mockReset().mockResolvedValue({
      data: { session: { access_token: "token-parent-1" } },
      error: null,
    });
    refreshSession.mockReset().mockResolvedValue({
      data: { session: null },
      error: null,
    });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetBrowserAuthCache();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearApiReadCache();
  });

  it("retries bounded idempotent GET on 502/504/network without re-calling Supabase auth", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");

    fetchMock
      .mockResolvedValueOnce(new Response("cold 1", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("network reset"))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const pending = requestApi("/books/catalog", okSchema, undefined, {
      maxRetries: 2,
      retryDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("retries 504 gateway timeout GET on cold start and surfaces retryable timeout when attempt hits full deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");

    fetchMock
      .mockResolvedValueOnce(new Response("Gateway Timeout", { status: 504 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const pending = requestApi("/profiles/me", okSchema, undefined, {
      retryDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getSession).toHaveBeenCalledTimes(1);

    // Full attempt timeout surfaces a retryable ServiceError without hanging past deadline
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const stalled = requestApi("/profiles/me", okSchema, undefined, {
      timeoutMs: 500,
      retryDelayMs: 50,
    }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(600);
    expect(await stalled).toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries POST/PUT/DELETE, 4xx, 500, 501, 503, schema errors, or caller aborts", async () => {
    vi.stubEnv("NODE_ENV", "production");

    // Mutation POST must not retry on 503
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    await expect(
      requestApi("/reading/sessions", okSchema, undefined, {
        method: "POST",
        body: {},
        retryDelayMs: 1,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 404 / 422 / 500 / 501 / 503 must not retry
    for (const status of [404, 422, 500, 501, 503]) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(new Response("err", { status }));
      await expect(
        requestApi("/books/catalog", okSchema, undefined, { retryDelayMs: 1 }),
      ).rejects.toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    // Schema mismatch must not retry
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(Response.json({ unexpected: true }));
    await expect(
      requestApi("/books/catalog", okSchema, undefined, { retryDelayMs: 1 }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Caller abort during retry backoff aborts without a second fetch
    vi.useFakeTimers();
    const controller = new AbortController();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(new Response("cold", { status: 502 }));
    const aborted = requestApi("/books/catalog", okSchema, controller.signal, {
      retryDelayMs: 5_000,
    }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const err = await aborted;
    expect((err as Error).name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports 204 No Content for z.void() while rejecting 204 for object schemas", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      requestApi("/profiles/children/c1", z.void(), undefined, {
        method: "DELETE",
      }),
    ).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      requestApi("/profiles/children/c1", okSchema),
    ).rejects.toMatchObject({ status: 204 });
  });

  it("scopes cache invalidation by mutation prefix while preserving unrelated cached reads", async () => {
    setApiReadCacheEnabled(true);
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true, path: new URL(input).pathname });
    });

    const anyObj = z.object({ ok: z.boolean() });
    await requestApi("/books/catalog", anyObj);
    await requestApi("/voice/voices", anyObj);
    await requestApi("/profiles/me", anyObj);
    await requestApi("/profiles/dashboard-summary", anyObj);
    await requestApi("/system/progress/c1", anyObj);
    await requestApi("/system/difficult-words/c1", anyObj);
    await requestApi("/learning/children/c1/recommendations", anyObj);
    expect(fetchMock).toHaveBeenCalledTimes(7);

    // Mutate /reading/sessions/1 -> invalidates progress, difficult-words, dashboard-summary, learning; preserves books/catalog, voice/voices, profiles/me
    await requestApi("/reading/sessions/1/complete", anyObj, undefined, {
      method: "POST",
      body: {},
    });
    fetchMock.mockClear();

    await requestApi("/books/catalog", anyObj);
    await requestApi("/voice/voices", anyObj);
    await requestApi("/profiles/me", anyObj);
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await requestApi("/profiles/dashboard-summary", anyObj);
    await requestApi("/system/progress/c1", anyObj);
    await requestApi("/system/difficult-words/c1", anyObj);
    await requestApi("/learning/children/c1/recommendations", anyObj);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Mutate /profiles/children/c1 -> invalidates /profiles/* without wiping /books/catalog
    fetchMock.mockClear();
    await requestApi("/profiles/children/c1", anyObj, undefined, {
      method: "PUT",
      body: { alias: "An" },
    });
    await requestApi("/books/catalog", anyObj);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await requestApi("/profiles/me", anyObj);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("validates adaptive-learning-service responses via Zod and preserves SupportFeedbackError mapping", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ broken: true }));
    await expect(
      createAdaptiveLearningService().getRecommendations("child-1"),
    ).rejects.toBeInstanceOf(ServiceError);

    fetchMock.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );
    await expect(
      createSupportService().submitFeedback({
        category: "technical_issue",
        subject: "Lỗi",
        message: "Chi tiết",
        contact_email: "parent@example.com",
      }),
    ).rejects.toBeInstanceOf(SupportFeedbackError);
  });

  it("preserves V4.1 quick_play_href and reading_misread_words_reinforced in adaptive-learning Zod schemas", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        child_id: "child-1",
        child_alias: "Bé An",
        child_grade: 2,
        mascot_greeting_vi: "Chào Bé An!",
        natural_break_reminder_vi: "Nghỉ 5 phút nhé.",
        today_activities_count: 1,
        focus_difficult_words: ["mèo mướp"],
        primary_recommendation: {
          game_key: "PICTURE_DESCRIPTION",
          zone_title_vi: "Kể chuyện",
          game_title_vi: "Kể chuyện qua tranh",
          reason_vi: "Ôn từ khó",
          suggested_mode: "VOCABULARY",
          suggested_difficulty: 2,
          target_words: ["mèo mướp"],
          href: "/entertainment/picture-description",
          quick_play_href: "/entertainment/picture-description?autoplay=1",
          priority: 1,
        },
        recommendations: [
          {
            game_key: "PICTURE_DESCRIPTION",
            zone_title_vi: "Kể chuyện",
            game_title_vi: "Kể chuyện qua tranh",
            reason_vi: "Ôn từ khó",
            suggested_mode: "VOCABULARY",
            suggested_difficulty: 2,
            target_words: ["mèo mướp"],
            href: "/entertainment/picture-description",
            quick_play_href: "/entertainment/picture-description?autoplay=1",
            priority: 1,
          },
        ],
      }),
    );
    const recs =
      await createAdaptiveLearningService().getRecommendations("child-1");
    expect(recs.primary_recommendation.quick_play_href).toBe(
      "/entertainment/picture-description?autoplay=1",
    );
    expect(recs.recommendations[0]?.quick_play_href).toBe(
      "/entertainment/picture-description?autoplay=1",
    );

    fetchMock.mockResolvedValueOnce(
      Response.json({
        child_id: "child-1",
        child_alias: "Bé An",
        child_grade: 2,
        window_days: 30,
        is_diagnostic: false,
        disclaimer_vi: "Không phải chẩn đoán y khoa.",
        observed_skills_count: 1,
        estimated_skills_count: 0,
        unknown_skills_count: 0,
        skills: [],
        practiced_difficult_words: [],
        module_activities: [],
        karaoke_weak_segments: [],
        home_support_tips_vi: [],
        reading_misread_words_reinforced: 6,
        generated_at: "2026-11-28T10:00:00Z",
      }),
    );
    const analytics = await createAdaptiveLearningService().getParentAnalytics(
      "child-1",
      30,
    );
    expect(analytics.reading_misread_words_reinforced).toBe(6);
  });

  it("refreshes the Supabase session once on 401 and retries with the refreshed Bearer token", async () => {
    refreshSession.mockResolvedValueOnce({
      data: { session: { access_token: "refreshed-token-2" } },
      error: null,
    });
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ detail: "expired" }, { status: 401 }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(requestApi("/books/catalog", okSchema)).resolves.toEqual({
      ok: true,
    });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer token-parent-1",
      }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer refreshed-token-2",
      }),
    });
  });

  it("rejects after a single refresh attempt when the retried request also returns 401 (no loop)", async () => {
    refreshSession.mockResolvedValueOnce({
      data: { session: { access_token: "refreshed-token-2" } },
      error: null,
    });
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ detail: "expired-1" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({ detail: "still-invalid" }, { status: 401 }),
      );

    await expect(
      requestApi("/profiles/me", okSchema, undefined, { bypassCache: true }),
    ).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent 401 refreshes into a single refreshSession() call", async () => {
    let resolveRefresh!: (value: {
      data: { session: { access_token: string } };
      error: null;
    }) => void;
    refreshSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    fetchMock.mockImplementation(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization === "Bearer refreshed-token-shared") {
        return Response.json({ ok: true });
      }
      return Response.json({ detail: "expired" }, { status: 401 });
    });

    const p1 = requestApi("/books/catalog", okSchema);
    const p2 = requestApi("/profiles/me", okSchema);
    const p3 = requestApi("/voice/voices", okSchema);

    await vi.waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
    resolveRefresh({
      data: { session: { access_token: "refreshed-token-shared" } },
      error: null,
    });

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
