import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST, maxDuration } from "@/app/api/cron/parent-emails/route";

describe("/api/cron/parent-emails route handler", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CRON_SECRET;
    delete process.env.PARENT_EMAIL_CRON_SECRET;
    delete process.env.BACKEND_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  it("fails closed with 503 when CRON_SECRET is missing or too short", async () => {
    const req = new NextRequest(
      "https://viread.vercel.app/api/cron/parent-emails",
    );
    const res = await GET(req);
    expect(res.status).toBe(503);

    process.env.CRON_SECRET = "too-short";
    const resShort = await GET(req);
    expect(resShort.status).toBe(503);
  });

  it("rejects missing or wrong bearer token with 401", async () => {
    process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

    const unauth = await GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails"),
    );
    expect(unauth.status).toBe(401);

    const wrong = await POST(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token-value-12345" },
      }),
    );
    expect(wrong.status).toBe(401);
  });

  it("forwards authorized cron call to backend dispatch endpoint", async () => {
    process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
    process.env.PARENT_EMAIL_CRON_SECRET = "backend-shared-secret-value-1234";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          scope: "engagement",
          delivery_configured: true,
          delivery_provider: "resend",
          presence_sent: 0,
          reminders_sent: 0,
          engagement_sent: 3,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = new NextRequest(
      "https://viread.vercel.app/api/cron/parent-emails?scope=engagement",
      {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      },
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.engagement_sent).toBe(3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      "https://capstone1-ssd8.onrender.com/parent-notifications/cron/dispatch?scope=engagement",
    );
    expect(
      (calledInit.headers as Record<string, string>)["X-Cron-Secret"],
    ).toBe("backend-shared-secret-value-1234");
  });

  it("returns 502 when upstream backend returns an error status", async () => {
    process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("error", { status: 503 })),
    );

    const req = new NextRequest(
      "https://viread.vercel.app/api/cron/parent-emails",
      {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      },
    );
    const res = await GET(req);
    expect(res.status).toBe(502);
  });

  it("falls back cleanly when BACKEND_API_URL or PARENT_EMAIL_CRON_SECRET is empty string", async () => {
    process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
    process.env.PARENT_EMAIL_CRON_SECRET = "   ";
    process.env.BACKEND_API_URL = "";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com/";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ engagement_sent: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = new NextRequest(
      "https://viread.vercel.app/api/cron/parent-emails",
      {
        headers: {
          authorization: "Bearer   a-very-strong-cron-secret-value  ",
        },
      },
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      "https://capstone1-ssd8.onrender.com/parent-notifications/cron/dispatch?scope=all",
    );
    expect(
      (calledInit.headers as Record<string, string>)["X-Cron-Secret"],
    ).toBe("a-very-strong-cron-secret-value");
  });

  it("retries once on transient 502 Render cold-start response after 1500ms backoff and succeeds", async () => {
    vi.useFakeTimers();
    process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("cold start", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ engagement_sent: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const req = new NextRequest(
      "https://viread.vercel.app/api/cron/parent-emails",
      {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      },
    );
    const pending = GET(req);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.summary.engagement_sent).toBe(2);
  });

  it("exports maxDuration = 60 and retries 504/network errors without retrying 401 or 503", async () => {
    vi.useFakeTimers();
    expect(maxDuration).toBe(60);

    process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

    // Must NOT retry 401
    const fetch401 = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetch401);
    const res401 = await GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      }),
    );
    expect(res401.status).toBe(502);
    expect(fetch401).toHaveBeenCalledTimes(1);

    // Must NOT retry 503
    const fetch503 = vi
      .fn()
      .mockResolvedValue(new Response("unconfigured", { status: 503 }));
    vi.stubGlobal("fetch", fetch503);
    const res503 = await GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      }),
    );
    expect(res503.status).toBe(502);
    expect(fetch503).toHaveBeenCalledTimes(1);

    // Must retry once on 504
    const fetch504 = vi
      .fn()
      .mockResolvedValueOnce(new Response("gateway timeout", { status: 504 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ engagement_sent: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetch504);
    const pending504 = GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      }),
    );
    await vi.waitFor(() => expect(fetch504).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    const res504 = await pending504;
    expect(res504.status).toBe(200);
    expect(fetch504).toHaveBeenCalledTimes(2);

    // Must retry once on transient network error
    const fetchNetwork = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ reminders_sent: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchNetwork);
    const pendingNet = GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      }),
    );
    await vi.waitFor(() => expect(fetchNetwork).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    const resNetwork = await pendingNet;
    expect(resNetwork.status).toBe(200);
    expect(fetchNetwork).toHaveBeenCalledTimes(2);
  });

  it.each([502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530])(
    "retries upstream status %i after 500ms backoff and recovers",
    async (status) => {
      vi.useFakeTimers();
      process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
      process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(`edge ${status}`, { status }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ engagement_sent: 4 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const pending = GET(
        new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
          headers: {
            authorization: "Bearer a-very-strong-cron-secret-value",
          },
        }),
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1_500);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const calledInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(calledInit.redirect).toBe("error");
    },
  );

  it.each([401, 403, 422, 429, 503])(
    "never retries upstream status %i",
    async (status) => {
      process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
      process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("no retry", { status }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await GET(
        new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
          headers: {
            authorization: "Bearer a-very-strong-cron-secret-value",
          },
        }),
      );
      expect(res.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("propagates X-Request-ID and emits secret-free failure diagnostics", async () => {
    vi.useFakeTimers();
    process.env.CRON_SECRET = "super-secret-cron-token-123456";
    process.env.PARENT_EMAIL_CRON_SECRET = "super-secret-backend-token-654321";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("edge error", {
          status: 524,
          headers: { "x-request-id": "render-req-524" },
        }),
      )
      .mockImplementation(
        async () =>
          new Response("still failing", {
            status: 524,
            headers: { "x-request-id": "render-req-524-b" },
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer super-secret-cron-token-123456",
          "x-request-id": "vercel-cron-req-1",
        },
      }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(56_000);
    const res = await pending;

    expect(res.status).toBe(502);
    expect(res.headers.get("x-request-id")).toBe("render-req-524-b");

    const sentHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit)
      .headers as Record<string, string>;
    expect(sentHeaders["X-Request-ID"]).toBe("vercel-cron-req-1");

    const json = await res.json();
    expect(json).toEqual({
      ok: false,
      error: "UPSTREAM_DISPATCH_FAILED",
      upstreamStatus: 524,
      requestId: "render-req-524-b",
    });

    const serializedResponse = JSON.stringify(json);
    const serializedLogs = JSON.stringify(consoleErrorSpy.mock.calls);
    for (const combined of [serializedResponse, serializedLogs]) {
      expect(combined).not.toContain("super-secret-cron-token-123456");
      expect(combined).not.toContain("super-secret-backend-token-654321");
      expect(combined).not.toContain("Bearer");
    }
    expect(serializedLogs).toContain("render-req-524-b");
  });

  it("sanitizes non-ISO-8859-1 and oversized/unsafe upstream x-request-id headers across retry and final paths", async () => {
    vi.useFakeTimers();
    process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const unicodeHeaders = new Headers();
    vi.spyOn(unicodeHeaders, "get").mockImplementation((name) =>
      name.toLowerCase() === "x-request-id" ? "req-\u0100-unicode" : null,
    );
    const oversizedUnsafeId = "evil value; " + "x".repeat(4096);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 524,
        headers: unicodeHeaders,
        body: null,
      } as unknown as Response)
      .mockImplementation(
        async () =>
          new Response("bad gateway", {
            status: 502,
            headers: { "x-request-id": oversizedUnsafeId },
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
          "x-request-id": "safe-caller-req-42",
        },
      }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(56_000);
    const res = await pending;

    expect(res.status).toBe(502);
    expect(res.headers.get("x-request-id")).toBe("safe-caller-req-42");
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "UPSTREAM_DISPATCH_FAILED",
      upstreamStatus: 502,
      requestId: "safe-caller-req-42",
    });

    const serializedLogs = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(serializedLogs).not.toContain("\u0100");
    expect(serializedLogs).not.toContain("evil value;");

    vi.useRealTimers();
    const fetchOkUnsafe = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ engagement_sent: 5 }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": oversizedUnsafeId,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchOkUnsafe);
    const okRes = await GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
          "x-request-id": "safe-caller-req-99",
        },
      }),
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("x-request-id")).toBe("safe-caller-req-99");
  });

  it("recovers from multi-attempt Render cold-start 502s within the 55s budget", async () => {
    vi.useFakeTimers();
    process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("cold-1", { status: 502 }))
      .mockResolvedValueOnce(new Response("cold-2", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ engagement_sent: 4 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(3_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = await res.json();
    expect(body.summary.engagement_sent).toBe(4);
  });

  it("retries immediately after a slow cold-start timeout without extra sleep and returns 504 if the 55s budget exhausts", async () => {
    vi.useFakeTimers();
    process.env.CRON_SECRET = "a-very-strong-cron-secret-value";
    process.env.NEXT_PUBLIC_API_URL = "https://capstone1-ssd8.onrender.com";

    // Slow first attempt (40s) followed by immediate recovery
    const slowRecoverFetch = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ reminders_sent: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", slowRecoverFetch);

    const slowRecoverPending = GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    const slowRecoverRes = await slowRecoverPending;
    expect(slowRecoverRes.status).toBe(200);
    expect(slowRecoverFetch).toHaveBeenCalledTimes(2);

    // Exhausting entire 55s budget returns 504 UPSTREAM_UNREACHABLE
    const alwaysHangFetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", alwaysHangFetch);

    const exhaustPending = GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(56_000);
    const exhaustRes = await exhaustPending;
    expect(exhaustRes.status).toBe(504);
    expect(await exhaustRes.json()).toEqual({
      ok: false,
      error: "UPSTREAM_UNREACHABLE",
      requestId: expect.any(String),
    });
  });
});
