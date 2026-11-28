import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import { requestApi } from "@/lib/api/api-client";
import {
  getBrowserAccessToken,
  resetBrowserAuthCache,
} from "@/lib/api/browser-auth";
import { z } from "zod";
import { createChildService } from "@/lib/api/child-service";
import { createProfileService } from "@/lib/api/profile-service";
import { ServiceError } from "@/lib/api/service-error";
import { createSpeechService } from "@/lib/api/speech-service";
import {
  createSupportService,
  SupportFeedbackError,
} from "@/lib/api/support-service";
import { createVoiceStudioService } from "@/lib/api/voice-studio-service";
import { fetchVoiceEngineHealth } from "@/lib/reading/voice-engine-status";

const { getSession, initialize, fetchMock } = vi.hoisted(() => ({
  getSession: vi.fn(),
  initialize: vi.fn(),
  fetchMock: vi.fn(),
}));

let reactiveOnAuthStateChange: ReturnType<typeof vi.fn> | undefined;

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize,
      getSession,
      ...(reactiveOnAuthStateChange
        ? { onAuthStateChange: reactiveOnAuthStateChange }
        : {}),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const CHILD_ID = "11000000-0000-4000-8000-000000000001";
const PARENT_ID = "10000000-0000-4000-8000-000000000001";

const VALID_CHILD = {
  id: CHILD_ID,
  parent_id: PARENT_ID,
  alias: "Bé An",
  grade: 2,
  settings: {},
  created_at: "2026-10-01T00:00:00Z",
};

const VALID_PROFILE = {
  id: PARENT_ID,
  display_name: "Phụ huynh An",
  role: "parent",
  created_at: "2026-10-01T00:00:00Z",
  email: "parent@example.com",
  contact_phone: null,
  pending_email: null,
  email_verified: true,
  contact_info_status: "available",
  children: [
    {
      id: CHILD_ID,
      alias: "Bé An",
      grade: 2,
      created_at: "2026-10-01T00:00:00Z",
    },
  ],
};

const VALID_RECOMMENDATIONS = {
  child_id: CHILD_ID,
  child_alias: "Bé An",
  child_grade: 2,
  mascot_greeting_vi: "Chào Bé An!",
  natural_break_reminder_vi: "Nghỉ mắt nhẹ nhé!",
  today_activities_count: 1,
  focus_difficult_words: ["nắng mai"],
  primary_recommendation: {
    game_key: "PICTURE_DESCRIPTION",
    zone_title_vi: "Thế giới kể chuyện",
    game_title_vi: "Kể chuyện qua tranh",
    reason_vi: "Gợi ý cho bé",
    suggested_mode: "OBSERVE",
    suggested_difficulty: 1,
    target_words: ["nắng mai"],
    href: "/entertainment/picture-description",
    priority: 1,
  },
  recommendations: [
    {
      game_key: "PICTURE_DESCRIPTION",
      zone_title_vi: "Thế giới kể chuyện",
      game_title_vi: "Kể chuyện qua tranh",
      reason_vi: "Gợi ý cho bé",
      suggested_mode: "OBSERVE",
      suggested_difficulty: 1,
      target_words: ["nắng mai"],
      href: "/entertainment/picture-description",
      priority: 1,
    },
  ],
};

const VALID_ANALYTICS = {
  child_id: CHILD_ID,
  child_alias: "Bé An",
  child_grade: 2,
  window_days: 30,
  is_diagnostic: false,
  disclaimer_vi: "Không phải chẩn đoán y khoa.",
  observed_skills_count: 1,
  estimated_skills_count: 0,
  unknown_skills_count: 15,
  skills: [],
  practiced_difficult_words: [],
  module_activities: [],
  karaoke_weak_segments: [],
  home_support_tips_vi: ["Đọc cùng bé mỗi ngày."],
  generated_at: "2026-11-28T00:00:00Z",
};

beforeEach(() => {
  reactiveOnAuthStateChange = undefined;
  resetBrowserAuthCache();
  initialize.mockReset().mockResolvedValue({ error: null });
  getSession.mockReset().mockResolvedValue({
    data: {
      session: {
        access_token: "isolated-test-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: PARENT_ID },
      },
    },
    error: null,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("child-service resilience (F9)", () => {
  it.each([502, 504, 520, 524, 530])(
    "retries GET /profiles/children once on status %i and recovers",
    async (status) => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(new Response("Cloudflare error", { status }))
        .mockResolvedValueOnce(Response.json([VALID_CHILD]));

      const pending = createChildService().list();
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toEqual([VALID_CHILD]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    },
  );

  it("retries GET once on transient network error", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(Response.json(VALID_CHILD));

    const pending = createChildService().get(CHILD_ID);
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toEqual(VALID_CHILD);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 422, 429, 503])(
    "never retries GET on HTTP %i",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ detail: "raw_secret_sql" }, { status }),
      );
      await expect(createChildService().list()).rejects.toMatchObject({
        status,
        retryable: status >= 500,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("never retries POST/PUT/DELETE mutations on 502 or 524", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Bad Gateway", { status: 502 }),
    );
    await expect(
      createChildService().create({ alias: "Bé Mới", grade: 1 }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response("Timeout", { status: 524 }));
    await expect(
      createChildService().update(CHILD_ID, { alias: "Bé Sửa", grade: 2 }),
    ).rejects.toMatchObject({ status: 524 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response("Bad Gateway", { status: 502 }),
    );
    await expect(createChildService().delete(CHILD_ID)).rejects.toMatchObject({
      status: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces bounded 30s timeout and invalidates token cache on 401", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = createChildService()
      .list()
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
    });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(
      true,
    );

    vi.useRealTimers();
    resetBrowserAuthCache();
    getSession.mockClear();
    reactiveOnAuthStateChange = vi.fn();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(Response.json([VALID_CHILD]));

    await expect(createChildService().list()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
    expect(getSession).toHaveBeenCalledTimes(1);

    await createChildService().list();
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});

describe("profile-service resilience (F9)", () => {
  it.each([502, 504, 522, 524, 530])(
    "retries GET /profiles/me once on status %i and recovers",
    async (status) => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(new Response("edge error", { status }))
        .mockResolvedValueOnce(Response.json(VALID_PROFILE));

      const pending = createProfileService().get();
      await vi.advanceTimersByTimeAsync(600);
      const profile = await pending;
      expect(profile.id).toBe(PARENT_ID);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("falls back immediately on /profiles/dashboard-summary 404 without retrying 404", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === "/profiles/dashboard-summary") {
        return new Response("Not Found", { status: 404 });
      }
      if (path === "/profiles/me") {
        return Response.json(VALID_PROFILE);
      }
      if (path === "/profiles/children") {
        return Response.json([VALID_CHILD]);
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const summary = await createProfileService().getDashboardSummary();
    expect(summary.source).toBe("fallback");
    expect(summary.children).toHaveLength(1);
    const summaryCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/profiles/dashboard-summary"),
    );
    expect(summaryCalls).toHaveLength(1);
  });

  it("never retries PUT/PATCH/POST/DELETE mutations on 502/524 and invalidates token on 401", async () => {
    reactiveOnAuthStateChange = vi.fn();

    // update() retries GET /profiles/me, never retries PUT /profiles/{id}
    fetchMock
      .mockResolvedValueOnce(Response.json(VALID_PROFILE))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }));
    await expect(
      createProfileService().update({ display_name: "Tên mới" }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // PATCH updateContactPhone never retries
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response("Timeout", { status: 524 }));
    await expect(
      createProfileService().updateContactPhone("0905123456"),
    ).rejects.toMatchObject({ status: 524 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 401 invalidates reactive token cache
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(Response.json(VALID_PROFILE));
    await expect(createProfileService().get()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
    expect(getSession).toHaveBeenCalledTimes(1);
    await createProfileService().get();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("enforces bounded 30s timeout on stalled profile requests", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = createProfileService()
      .get()
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
    });
  });
});

describe("adaptive-learning-service resilience & Zod validation (F9)", () => {
  it.each([502, 504, 520, 524, 530])(
    "retries GET recommendations once on status %i and enforces no-store/omit/error",
    async (status) => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(new Response("Cloudflare error", { status }))
        .mockResolvedValueOnce(Response.json(VALID_RECOMMENDATIONS));

      const pending =
        createAdaptiveLearningService().getRecommendations(CHILD_ID);
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toEqual(VALID_RECOMMENDATIONS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    },
  );

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "FORBIDDEN"],
    [404, "RESOURCE_NOT_FOUND"],
    [422, "VALIDATION_ERROR"],
    [429, "NETWORK_ERROR"],
    [503, "NETWORK_ERROR"],
  ])(
    "does not retry HTTP %i and maps to ServiceError(%s) without leaking backend details",
    async (status, code) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ detail: "internal_secret_sql_leak" }, { status }),
      );
      const err = await createAdaptiveLearningService()
        .getRecommendations(CHILD_ID)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect(err).toMatchObject({ code, status });
      expect((err as Error).message).not.toContain("internal_secret_sql_leak");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects malformed payloads with Zod validation and clamps windowDays to [7, 90]", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ broken: true }));
    await expect(
      createAdaptiveLearningService().getRecommendations(CHILD_ID),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: false,
    });

    fetchMock.mockResolvedValueOnce(Response.json(VALID_ANALYTICS));
    await createAdaptiveLearningService().getParentAnalytics(CHILD_ID, 2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("window_days=7");

    fetchMock.mockResolvedValueOnce(Response.json(VALID_ANALYTICS));
    await createAdaptiveLearningService().getParentAnalytics(CHILD_ID, 999);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("window_days=90");

    fetchMock.mockResolvedValueOnce(Response.json(VALID_ANALYTICS));
    await createAdaptiveLearningService().getParentAnalytics(
      CHILD_ID,
      Number.NaN,
    );
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("window_days=30");

    await expect(
      createAdaptiveLearningService().getRecommendations("   "),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 422 });
  });

  it("invalidates reactive token cache on 401 and enforces 30s timeout", async () => {
    reactiveOnAuthStateChange = vi.fn();
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(Response.json(VALID_RECOMMENDATIONS));

    await expect(
      createAdaptiveLearningService().getRecommendations(CHILD_ID),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
    expect(getSession).toHaveBeenCalledTimes(1);

    await createAdaptiveLearningService().getRecommendations(CHILD_ID);
    expect(getSession).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = createAdaptiveLearningService()
      .getParentAnalytics(CHILD_ID, 30)
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
    });
  });
});

describe("support-service resilience (F9)", () => {
  const payload = {
    category: "technical_issue" as const,
    subject: "Không mở được sách",
    message: "Vui lòng hỗ trợ.",
    contact_email: "parent@example.com",
  };

  it("enforces bounded 30s timeout and throws SupportFeedbackError(status=0)", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = createSupportService()
      .submitFeedback(payload)
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await pending;
    expect(err).toBeInstanceOf(SupportFeedbackError);
    expect(err).toMatchObject({ status: 0 });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(
      true,
    );
  });

  it.each([502, 524, 503])(
    "never retries POST /support/feedback on status %i",
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response("error", { status }));
      await expect(
        createSupportService().submitFeedback(payload),
      ).rejects.toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("invalidates reactive token cache on 401", async () => {
    reactiveOnAuthStateChange = vi.fn();
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            accepted: true,
            delivery_status: "accepted_by_smtp",
            detail: "ok",
          },
          { status: 202 },
        ),
      );

    await expect(
      createSupportService().submitFeedback(payload),
    ).rejects.toMatchObject({ status: 401 });
    expect(getSession).toHaveBeenCalledTimes(1);

    await createSupportService().submitFeedback(payload);
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});

describe("speech-service, voice-studio-service, voice-engine-status, and browser-auth resilience", () => {
  it("falls back to 30s timeout on invalid speech timeoutMs and wraps non-JSON/blob body failures", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>bad 200</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(
      createSpeechService().synthesizePhonics?.(
        [
          { id: "s1", spokenText: "m" },
          { id: "s2", spokenText: "e" },
          { id: "s3", spokenText: "o" },
        ],
        {
          timeoutMs: Number.NaN,
        },
      ),
    ).rejects.toMatchObject({
      code: "TTS_UNAVAILABLE",
      status: 200,
      retryable: false,
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "audio/mpeg",
        "x-request-id": "req-blob-fail",
      }),
      blob: () => Promise.reject(new Error("stream reset")),
    } as unknown as Response);
    await expect(
      createSpeechService().synthesize("Xin chào", { timeoutMs: -10 }),
    ).rejects.toMatchObject({
      code: "TTS_UNAVAILABLE",
      status: 0,
      request_id: "req-blob-fail",
      retryable: true,
    });
  });

  it("retries voice-studio-service GET /voice/voices on 524 without retrying POST", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response("Cloudflare 524", { status: 524 }))
      .mockResolvedValueOnce(
        Response.json({
          voices: [{ voice_id: "v1", name: "Trúc Ly" }],
          default_voice_id: "v1",
        }),
      );

    const listPromise = createVoiceStudioService().listVoices();
    await vi.advanceTimersByTimeAsync(600);
    await expect(listPromise).resolves.toMatchObject({
      default_voice_id: "v1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response("Cloudflare 524", { status: 524 }),
    );
    await expect(
      createVoiceStudioService().synthesizeTimed(["Bé"]),
    ).rejects.toMatchObject({ code: "TTS_UNAVAILABLE", status: 524 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries voice-engine-status on 524 and invalidates token cache on 401 without retrying 401", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response("Cloudflare 524", { status: 524 }))
      .mockResolvedValueOnce(
        Response.json({
          default_mode: "local_only",
          default_voice_id: "local_north_truc_ly",
          local: { available: true, stt_ready: true, tts_ready: true },
          google: {
            stt_configured: false,
            tts_configured: false,
            stt_cooldown: false,
            tts_cooldown: false,
          },
        }),
      );

    const pending = fetchVoiceEngineHealth();
    await vi.advanceTimersByTimeAsync(600);
    const snapshot = await pending;
    expect(snapshot?.local.available).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    resetBrowserAuthCache();
    getSession.mockClear();
    reactiveOnAuthStateChange = vi.fn();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );
    const authFail = await fetchVoiceEngineHealth();
    expect(authFail).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(1);

    // Token cache must be invalidated after 401
    fetchMock.mockResolvedValueOnce(
      Response.json({
        default_mode: "local_only",
        default_voice_id: "local_north_truc_ly",
        local: { available: true, stt_ready: true, tts_ready: true },
        google: {
          stt_configured: false,
          tts_configured: false,
          stt_cooldown: false,
          tts_cooldown: false,
        },
      }),
    );
    const recovered = await fetchVoiceEngineHealth();
    expect(recovered?.local.available).toBe(true);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("recovers browser-auth after a hung auth lookup times out and clears inflightTokenLookup", async () => {
    vi.useFakeTimers();
    initialize.mockReturnValueOnce(
      new Promise<{ error: null }>(() => {
        // Hung Supabase initialize()
      }),
    );

    const first = getBrowserAccessToken({
      onUnauthorized: () => new Error("AUTH_TIMEOUT"),
    }).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(10_000);
    const err = await first;
    expect((err as Error).message).toBe("AUTH_TIMEOUT");

    vi.useRealTimers();
    initialize.mockResolvedValueOnce({ error: null });
    const recoveredToken = await getBrowserAccessToken({
      onUnauthorized: () => new Error("AUTH_REQUIRED"),
    });
    expect(recoveredToken).toBe("isolated-test-token");
  });

  it("does not poison inflightTokenLookup after a short-timeout caller aborts during hung getSession", async () => {
    vi.useFakeTimers();
    getSession.mockImplementationOnce(
      () =>
        new Promise(() => {
          // Hung getSession for first attempt
        }),
    );

    const shortSpeech = createSpeechService()
      .synthesize("Xin chào", { timeoutMs: 40 })
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(41);
    await expect(shortSpeech).resolves.toMatchObject({ name: "TimeoutError" });

    // Restore healthy session immediately and verify next callers do NOT wait 10s
    vi.useRealTimers();
    getSession.mockResolvedValue({
      data: {
        session: {
          access_token: "healthy-token-after-timeout",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: PARENT_ID },
        },
      },
      error: null,
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response("audio-bytes", {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const blob = await createSpeechService().synthesize("Xin chào");
    expect(blob.size).toBeGreaterThan(0);

    const apiRes = await requestApi("/healthy", z.object({ ok: z.boolean() }));
    expect(apiRes).toEqual({ ok: true });
  });

  it("keeps shared auth lookup alive for healthy waiter when another short-timeout waiter aborts", async () => {
    vi.useFakeTimers();
    getSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              data: {
                session: {
                  access_token: "coalesced-token-80ms",
                  expires_at: Math.floor(Date.now() / 1000) + 3600,
                  user: { id: PARENT_ID },
                },
              },
              error: null,
            });
          }, 80);
        }),
    );
    fetchMock.mockResolvedValueOnce(Response.json([VALID_CHILD]));

    const fastTimeoutCaller = createVoiceStudioService()
      .synthesizeTimed(["Bé"], { timeoutMs: 40 })
      .catch((err: unknown) => err);
    const healthyCaller = requestApi(
      "/profiles/children",
      z.array(z.object({ id: z.string() })),
      undefined,
      { timeoutMs: 5_000 },
    );

    await vi.advanceTimersByTimeAsync(41);
    await expect(fastTimeoutCaller).resolves.toMatchObject({
      code: "TTS_UNAVAILABLE",
      retryable: true,
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(healthyCaller).resolves.toEqual([{ id: CHILD_ID }]);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly within timeoutMs when childService.list() or profileService.get() receives a 524 with stalled .clone().json()", async () => {
    vi.useFakeTimers();
    const stalled524 = () =>
      ({
        ok: false,
        status: 524,
        headers: new Headers(),
        body: { cancel: () => Promise.resolve() },
        clone: () => ({
          json: () =>
            new Promise(() => {
              // Never resolves
            }),
        }),
      }) as unknown as Response;

    fetchMock.mockResolvedValueOnce(stalled524());
    const childPending = createChildService()
      .list()
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(childPending).resolves.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
    });

    fetchMock.mockResolvedValueOnce(stalled524());
    const profilePending = createProfileService()
      .get()
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(profilePending).resolves.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
    });
  });

  it("aborts childService.list() and profileService.get() across getBrowserAccessToken microtask or resetApiReadCacheForActorSwitch without calling fetch", async () => {
    const { resetApiReadCacheForActorSwitch } =
      await import("@/lib/api/read-cache");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // 1) External AbortController aborts across getBrowserAccessToken microtask
      const childController = new AbortController();
      const childPromise = createChildService().list(childController.signal);
      childController.abort();
      await expect(childPromise).rejects.toMatchObject({ name: "AbortError" });

      const profileController = new AbortController();
      const profilePromise = createProfileService().get(
        profileController.signal,
      );
      profileController.abort();
      await expect(profilePromise).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetchMock).not.toHaveBeenCalled();

      // 2) resetApiReadCacheForActorSwitch() aborts in-flight cold-start retry before second fetch
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
      const switchedList = createChildService()
        .list()
        .catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(100);
      resetApiReadCacheForActorSwitch();
      await expect(switchedList).resolves.toMatchObject({ name: "AbortError" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
