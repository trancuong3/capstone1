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

  it("retries once on transient 502 Render cold-start response and succeeds", async () => {
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
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.summary.engagement_sent).toBe(2);
  });

  it("exports maxDuration = 60 and retries 504/network errors without retrying 401 or 503", async () => {
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
    const res504 = await GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      }),
    );
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
    const resNetwork = await GET(
      new NextRequest("https://viread.vercel.app/api/cron/parent-emails", {
        headers: {
          authorization: "Bearer a-very-strong-cron-secret-value",
        },
      }),
    );
    expect(resNetwork.status).toBe(200);
    expect(fetchNetwork).toHaveBeenCalledTimes(2);
  });
});
