import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { getSession, initialize, fetchMock } = vi.hoisted(() => ({
  getSession: vi.fn(),
  initialize: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({ auth: { initialize, getSession } }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "https://api.example.com",
}));

import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import { requestApi } from "@/lib/api/api-client";
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
    clearApiReadCache();
    setApiReadCacheEnabled(false);
    setApiReadCacheActorScope("parent-1");
    initialize.mockReset().mockResolvedValue({ error: null });
    getSession.mockReset().mockResolvedValue({
      data: { session: { access_token: "token-parent-1" } },
      error: null,
    });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearApiReadCache();
  });

  it("retries bounded idempotent GET on 502/503/504/network without re-calling Supabase auth", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");

    fetchMock
      .mockResolvedValueOnce(new Response("cold 1", { status: 502 }))
      .mockRejectedValueOnce(new TypeError("network reset"))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const pending = requestApi("/books/catalog", okSchema, undefined, {
      retryDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("retries timed-out GET attempt on cold start when total deadline allows", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");

    fetchMock
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const pending = requestApi("/profiles/me", okSchema, undefined, {
      retryDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(31_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("never retries POST/PUT/DELETE, 4xx, 500, 501, schema errors, or caller aborts", async () => {
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

    // 404 / 422 / 500 / 501 must not retry
    for (const status of [404, 422, 500, 501]) {
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
    fetchMock.mockResolvedValueOnce(new Response("cold", { status: 503 }));
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
});
