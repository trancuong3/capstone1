import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiQuery,
  fetchAuthenticatedBlobUrl,
  requestApi,
  revokePrivateBlobUrl,
} from "@/lib/api/api-client";
import {
  resetAllApiCachesForTests,
  setApiReadCacheEnabled,
} from "@/lib/api/read-cache";
import { ServiceError } from "@/lib/api/service-error";

const { getSession, initialize, fetchMock } = vi.hoisted(() => ({
  getSession: vi.fn(),
  initialize: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({ auth: { initialize, getSession } }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const schema = z.object({ title: z.string() });

beforeEach(() => {
  initialize.mockReset().mockResolvedValue({ error: null });
  getSession.mockReset();
  getSession.mockResolvedValue({
    data: { session: { access_token: "isolated-test-token" } },
    error: null,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("real API client", () => {
  it("sends the session Bearer token, disables cache and validates JSON", async () => {
    fetchMock.mockResolvedValue(Response.json({ title: "Tên sách từ API" }));
    expect(await requestApi("/books/", schema)).toEqual({
      title: "Tên sách từ API",
    });
    expect(initialize).toHaveBeenCalledOnce();
    expect(getSession).toHaveBeenCalledOnce();
    expect(initialize.mock.invocationCallOrder[0]).toBeLessThan(
      getSession.mock.invocationCallOrder[0],
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/books/",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer isolated-test-token",
        },
      }),
    );
  });

  it("waits for session restoration and does not call FastAPI when initialization fails", async () => {
    initialize.mockResolvedValue({
      error: new Error("private initialization error"),
    });
    await expect(requestApi("/books/", schema)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call FastAPI when unauthenticated", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(requestApi("/books/", schema)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects session provider errors even if a token is present", async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: "not-valid" } },
      error: new Error("private"),
    });
    await expect(requestApi("/books/", schema)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "FORBIDDEN"],
    [404, "RESOURCE_NOT_FOUND"],
    [422, "VALIDATION_ERROR"],
    [500, "NETWORK_ERROR"],
  ])("maps HTTP %i without exposing server details", async (status, code) => {
    fetchMock.mockResolvedValue(
      Response.json(
        { detail: "password=private sql token" },
        {
          status,
          headers: { "x-request-id": "test-request" },
        },
      ),
    );
    await expect(requestApi("/books/", schema)).rejects.toMatchObject({
      code,
      status,
      request_id: "test-request",
      retryable: status >= 500,
    });
    await expect(requestApi("/books/", schema)).rejects.not.toThrow("private");
  });

  it("rejects invalid DTO rather than casting or returning mock fallback", async () => {
    fetchMock.mockResolvedValue(Response.json({ title: 12 }));
    await expect(requestApi("/books/", schema)).rejects.toBeInstanceOf(
      ServiceError,
    );
  });

  it("rejects non-JSON success responses", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Error</html>"));
    await expect(requestApi("/books/", schema)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: false,
    });
  });

  it("reports network failure without exposing diagnostics", async () => {
    fetchMock.mockRejectedValue(new Error("private endpoint"));
    await expect(requestApi("/books/", schema)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
    });
  });

  it("retries idempotent GET once on transient 502/504 or network cold start", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(
          Response.json({ detail: "Bad Gateway" }, { status: 502 }),
        )
        .mockResolvedValueOnce(Response.json({ title: "Recovered 502" }));

      const firstPromise = requestApi("/books/", schema, undefined, {
        bypassCache: true,
        maxRetries: 1,
        retryDelayMs: 600,
      });
      await vi.advanceTimersByTimeAsync(600);
      await expect(firstPromise).resolves.toEqual({ title: "Recovered 502" });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockReset();
      fetchMock
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(Response.json({ title: "Recovered net" }));

      const netPromise = requestApi("/books/", schema, undefined, {
        bypassCache: true,
        maxRetries: 1,
        retryDelayMs: 600,
      });
      await vi.advanceTimersByTimeAsync(600);
      await expect(netPromise).resolves.toEqual({ title: "Recovered net" });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response("Gateway Timeout", { status: 504 }))
        .mockResolvedValueOnce(Response.json({ title: "Recovered 504" }));

      const html504Promise = requestApi("/books/", schema, undefined, {
        bypassCache: true,
        maxRetries: 1,
        retryDelayMs: 600,
      });
      await vi.advanceTimersByTimeAsync(600);
      await expect(html504Promise).resolves.toEqual({ title: "Recovered 504" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry GET on structured backend 504 domain errors, 401/503, or POST on 502/network failures", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          detail:
            "Remote OCR worker did not finish before sync timeout; poll job status asynchronously.",
        },
        { status: 504 },
      ),
    );
    await expect(
      requestApi("/reading/scan-page-ocr", schema, undefined, {
        bypassCache: true,
        maxRetries: 1,
        retryDelayMs: 600,
      }),
    ).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("xếp hàng"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      Response.json({ detail: "unauthorized" }, { status: 401 }),
    );
    await expect(
      requestApi("/books/", schema, undefined, {
        bypassCache: true,
        maxRetries: 1,
        retryDelayMs: 600,
      }),
    ).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      Response.json({ detail: "voice offline" }, { status: 503 }),
    );
    await expect(
      requestApi("/books/", schema, undefined, { bypassCache: true }),
    ).rejects.toMatchObject({ status: 503, code: "NETWORK_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      Response.json({ detail: "Bad Gateway" }, { status: 502 }),
    );
    await expect(
      requestApi("/books/", schema, undefined, {
        method: "POST",
        body: { title: "Create" },
        maxRetries: 1,
        retryDelayMs: 600,
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(
      requestApi("/books/", schema, undefined, {
        method: "POST",
        body: { title: "Create" },
      }),
    ).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not produce a ready result while HTTP is pending", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const complete = vi.fn();
    const request = requestApi("/books/", schema).then(complete);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(complete).not.toHaveBeenCalled();
    resolveResponse?.(Response.json({ title: "Ready" }));
    await request;
    expect(complete).toHaveBeenCalledWith({ title: "Ready" });
  });

  it("encodes real filters and omits only undefined values", () => {
    expect(apiQuery({ search: "Mèo & em", grade: 0, cursor: undefined })).toBe(
      "?search=M%C3%A8o+%26+em&grade=0",
    );
    expect(apiQuery({})).toBe("");
  });

  it("rejects non-local route strings before loading the session", async () => {
    await expect(
      requestApi("https://other.example/books", schema),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      requestApi("//other.example/books", schema),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("sends authenticated JSON bodies for mutation requests", async () => {
    fetchMock.mockResolvedValue(Response.json({ title: "Updated" }));
    const body = { title: "Updated" };

    await expect(
      requestApi("/admin/parents", schema, undefined, {
        method: "PATCH",
        body,
      }),
    ).resolves.toEqual({ title: "Updated" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/admin/parents",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify(body),
        headers: {
          Accept: "application/json",
          Authorization: "Bearer isolated-test-token",
          "Content-Type": "application/json",
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
      }),
    );
  });

  it("sends DELETE without inventing a JSON body", async () => {
    fetchMock.mockResolvedValue(Response.json({ title: "Hidden" }));
    await requestApi("/admin/parents/parent-id", schema, undefined, {
      method: "DELETE",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/admin/parents/parent-id",
      expect.objectContaining({
        method: "DELETE",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer isolated-test-token",
        },
      }),
    );
  });

  it("maps prefixed Flow 2 and Google Drive error codes cleanly without leaking raw details", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          detail:
            "DRIVE_QUOTA_EXCEEDED: internal_bucket=secret_path 0 bytes left",
        },
        { status: 507 },
      ),
    );
    await expect(
      requestApi("/books/admin/viread-training/flow2/trigger", schema),
    ).rejects.toMatchObject({
      status: 507,
      message: expect.stringContaining("Không gian lưu trữ dữ liệu"),
    });

    fetchMock.mockResolvedValueOnce(
      Response.json(
        { detail: "UNKNOWN_RAW_EXCEPTION: SELECT * FROM private_secrets" },
        { status: 422 },
      ),
    );
    await expect(
      requestApi("/books/admin/viread-training/flow2/trigger", schema),
    ).rejects.toMatchObject({
      status: 422,
      message: "Có lỗi xảy ra. Vui lòng thử lại sau.",
    });
  });

  it("aborts stalled fetches after timeoutMs and surfaces a retryable ServiceError", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      );

      const pending = requestApi("/reading/scan-page-ocr", schema, undefined, {
        timeoutMs: 250,
      }).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(250);
      const caught = await pending;
      expect(caught).toBeInstanceOf(ServiceError);
      expect(caught).toMatchObject({
        code: "NETWORK_ERROR",
        status: 0,
        retryable: true,
      });
      const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(firstInit.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530])(
    "retries idempotent GET once on Cloudflare/Render status %i and recovers",
    async (status) => {
      vi.useFakeTimers();
      try {
        fetchMock
          .mockResolvedValueOnce(
            new Response(`<html>Edge error ${status}</html>`, {
              status,
              headers: { "content-type": "text/html" },
            }),
          )
          .mockResolvedValueOnce(
            Response.json({ title: `Recovered ${status}` }),
          );

        const promise = requestApi("/books/", schema, undefined, {
          bypassCache: true,
        });
        await vi.advanceTimersByTimeAsync(600);
        await expect(promise).resolves.toEqual({
          title: `Recovered ${status}`,
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([401, 403, 404, 422, 429, 503])(
    "does not retry idempotent GET on HTTP %i",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ detail: `status ${status}` }, { status }),
      );
      await expect(
        requestApi("/books/", schema, undefined, { bypassCache: true }),
      ).rejects.toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("caps total elapsed time across cold-start retries within timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(new Response("Bad Gateway", { status: 502 }));
            }, 500);
          }),
      );

      const pending = requestApi("/books/", schema, undefined, {
        bypassCache: true,
        timeoutMs: 800,
      }).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(500);
      const caught = await pending;
      // Remaining budget (300ms) <= 600ms backoff, so no second attempt is made.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(caught).toMatchObject({ status: 502, retryable: true });

      fetchMock.mockReset();
      fetchMock
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              setTimeout(() => {
                resolve(new Response("Gateway Timeout", { status: 524 }));
              }, 300);
            }),
        )
        .mockImplementationOnce(
          (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
            }),
        );

      const secondPending = requestApi("/books/", schema, undefined, {
        bypassCache: true,
        timeoutMs: 1_200,
      }).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(1_200);
      const secondCaught = await secondPending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(secondCaught).toMatchObject({
        code: "NETWORK_ERROR",
        status: 0,
        retryable: true,
      });
      const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
      expect(secondInit.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the underlying fetch signal on timeoutMs even when caller provides an AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      let underlyingSignal: AbortSignal | undefined;
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            underlyingSignal = init?.signal ?? undefined;
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      );

      const callerController = new AbortController();
      const pending = requestApi("/books/", schema, callerController.signal, {
        method: "POST",
        body: { title: "Slow AI" },
        timeoutMs: 300,
      }).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(300);
      const caught = await pending;
      expect(underlyingSignal?.aborted).toBe(true);
      expect(callerController.signal.aborted).toBe(false);
      expect(caught).toBeInstanceOf(ServiceError);
      expect(caught).toMatchObject({
        code: "NETWORK_ERROR",
        status: 0,
        retryable: true,
      });

      fetchMock.mockReset();
      let secondSignal: AbortSignal | undefined;
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            secondSignal = init?.signal ?? undefined;
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      );

      const cancelController = new AbortController();
      const cancelled = requestApi("/books/", schema, cancelController.signal, {
        method: "POST",
        body: { title: "Cancelled" },
        timeoutMs: 5_000,
      }).catch((err: unknown) => err);

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      cancelController.abort();
      const abortErr = await cancelled;
      expect(secondSignal?.aborted).toBe(true);
      expect(abortErr).not.toBeInstanceOf(ServiceError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries POST once when retryOnColdStart is true on 502/504/network, and never retries 401/429/503", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(
          Response.json({ detail: "Bad Gateway" }, { status: 502 }),
        )
        .mockResolvedValueOnce(Response.json({ title: "POST 502 ok" }));

      const retry502 = requestApi("/tutor/generate", schema, undefined, {
        method: "POST",
        body: { days: 30 },
        retryOnColdStart: true,
      });
      await vi.advanceTimersByTimeAsync(1_200);
      await expect(retry502).resolves.toEqual({ title: "POST 502 ok" });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response("Gateway Timeout", { status: 504 }))
        .mockResolvedValueOnce(Response.json({ title: "POST 504 ok" }));

      const retry504 = requestApi("/tutor/generate", schema, undefined, {
        method: "POST",
        body: { days: 30 },
        retryOnColdStart: true,
      });
      await vi.advanceTimersByTimeAsync(1_200);
      await expect(retry504).resolves.toEqual({ title: "POST 504 ok" });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockReset();
      fetchMock
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(Response.json({ title: "POST net ok" }));

      const retryNet = requestApi("/tutor/generate", schema, undefined, {
        method: "POST",
        body: { days: 30 },
        retryOnColdStart: true,
      });
      await vi.advanceTimersByTimeAsync(1_200);
      await expect(retryNet).resolves.toEqual({ title: "POST net ok" });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      for (const status of [401, 429, 503]) {
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(
          Response.json({ detail: `status-${status}` }, { status }),
        );
        await expect(
          requestApi("/tutor/generate", schema, undefined, {
            method: "POST",
            body: { days: 30 },
            retryOnColdStart: true,
          }),
        ).rejects.toMatchObject({ status });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fetchAuthenticatedBlobUrl", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:http://localhost/private-1");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.useRealTimers();
  });

  it("attaches Bearer token, no-store/omit/error flags, and resolves private API media URLs", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Blob(["img-bytes"], { type: "image/png" }), {
        status: 200,
      }),
    );

    const blobUrl = await fetchAuthenticatedBlobUrl("/books/my-books/b1/cover");
    expect(blobUrl).toBe("blob:http://localhost/private-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/books/my-books/b1/cover",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: "Bearer isolated-test-token",
        }),
      }),
    );
    revokePrivateBlobUrl(blobUrl);
  });

  it.each([502, 504, 520, 524, 530])(
    "retries GET once on status %i and recovers blob URL",
    async (status) => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(new Response("Edge error", { status }))
        .mockResolvedValueOnce(
          new Response(new Blob(["ok"], { type: "image/png" }), {
            status: 200,
          }),
        );

      const pending = fetchAuthenticatedBlobUrl("/books/my-books/b1/page-1");
      await vi.advanceTimersByTimeAsync(600);
      await expect(pending).resolves.toBe("blob:http://localhost/private-1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("retries once on transient network error and recovers", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        new Response(new Blob(["ok"], { type: "image/png" }), { status: 200 }),
      );

    const pending = fetchAuthenticatedBlobUrl("/books/my-books/b1/page-1");
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe("blob:http://localhost/private-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 422, 503])(
    "does not retry on HTTP %i and surfaces safe Vietnamese ServiceError",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          { detail: "SELECT * FROM private_assets WHERE secret=1" },
          { status, headers: { "x-request-id": "req-blob-err" } },
        ),
      );

      await expect(
        fetchAuthenticatedBlobUrl("/books/my-books/b1/page-1"),
      ).rejects.toMatchObject({
        status,
        request_id: "req-blob-err",
        retryable: status >= 500,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("invalidates cached reactive auth session on 401", async () => {
    const reactiveGetSession = vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: "reactive-token-1",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: "parent-1" },
        },
      },
      error: null,
    });
    const reactiveAuth = {
      initialize: vi.fn().mockResolvedValue({ error: null }),
      getSession: reactiveGetSession,
      onAuthStateChange: vi.fn(),
    };
    const supabaseClientModule = await import("@/lib/supabase/client");
    vi.spyOn(
      supabaseClientModule,
      "createBrowserSupabaseClient",
    ).mockReturnValue({ auth: reactiveAuth } as unknown as ReturnType<
      typeof supabaseClientModule.createBrowserSupabaseClient
    >);

    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(new Blob(["ok"], { type: "image/png" }), { status: 200 }),
      );

    await expect(
      fetchAuthenticatedBlobUrl("/books/my-books/b1/page-1"),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
      retryable: false,
    });
    expect(reactiveGetSession).toHaveBeenCalledTimes(1);

    // Next call must re-fetch session rather than reusing the invalidated token
    await fetchAuthenticatedBlobUrl("/books/my-books/b1/page-1");
    expect(reactiveGetSession).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("enforces bounded timeout and honors AbortSignal during response.blob() without creating an object URL", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const timedPending = fetchAuthenticatedBlobUrl(
      "/books/my-books/b1/page-1",
      undefined,
      200,
    ).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(200);
    await expect(timedPending).resolves.toMatchObject({
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
    });

    vi.useRealTimers();
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () =>
        new Promise<Blob>(() => {
          // Hang until caller aborts
        }),
    } as unknown as Response);

    const abortPending = fetchAuthenticatedBlobUrl(
      "/books/my-books/b1/page-1",
      controller.signal,
    ).catch((err: unknown) => err);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort();
    const abortErr = await abortPending;
    expect((abortErr as Error).name).toBe("AbortError");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([524, 500])(
    "bounds stalled .clone().json() on HTTP %i within timeoutMs and throws retryable NETWORK_ERROR",
    async (status) => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status,
        headers: new Headers(),
        body: { cancel: () => Promise.resolve() },
        clone: () => ({
          json: () =>
            new Promise(() => {
              // Stalled response stream decoupled from fetch signal
            }),
        }),
      } as unknown as Response);

      const pending = requestApi("/books/", schema, undefined, {
        timeoutMs: 300,
      }).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(300);
      await expect(pending).resolves.toMatchObject({
        code: "NETWORK_ERROR",
        status: 0,
        retryable: true,
      });
      vi.useRealTimers();
    },
  );

  it("rejects pre-aborted GET and POST calls immediately without auth, fetch, or cache invalidation", async () => {
    setApiReadCacheEnabled(true);
    try {
      fetchMock.mockResolvedValueOnce(
        Response.json({ title: "Cached Book Title" }),
      );
      await expect(requestApi("/books/cached", schema)).resolves.toEqual({
        title: "Cached Book Title",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      initialize.mockClear();
      getSession.mockClear();
      fetchMock.mockClear();

      const abortedController = new AbortController();
      abortedController.abort();

      await expect(
        requestApi("/books/other", schema, abortedController.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        requestApi("/books/cached", schema, abortedController.signal, {
          method: "POST",
          body: { title: "Should not run" },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(initialize).not.toHaveBeenCalled();
      expect(getSession).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      // Cached GET entry remains intact because pre-aborted POST did not invalidate cache
      await expect(requestApi("/books/cached", schema)).resolves.toEqual({
        title: "Cached Book Title",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      resetAllApiCachesForTests();
    }
  });

  it("does not retry GET on structured 504 LOCAL_OCR_TIMEOUT domain error", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ detail: { code: "LOCAL_OCR_TIMEOUT" } }, { status: 504 }),
    );

    await expect(
      requestApi("/books/catalog", schema, undefined, { bypassCache: true }),
    ).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("Nhận diện trang sách"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("avoids unhandledRejection when signal aborts across getBrowserAccessToken microtask or in raceWithSignal", async () => {
    const { raceWithSignal } = await import("@/lib/api/cold-start-retry");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // 1. Direct raceWithSignal with an already-aborted signal and rejecting promise
      const preAborted = new AbortController();
      preAborted.abort();
      const rejectingInner = Promise.reject(
        new DOMException("Aborted", "AbortError"),
      );
      await expect(
        raceWithSignal(rejectingInner, preAborted.signal),
      ).rejects.toMatchObject({ name: "AbortError" });

      // 2. fetchAuthenticatedBlobUrl aborted synchronously while getBrowserAccessToken awaits microtask
      fetchMock.mockImplementation(() =>
        Promise.reject(new DOMException("Aborted", "AbortError")),
      );
      const blobController = new AbortController();
      const blobPromise = fetchAuthenticatedBlobUrl(
        "/books/my-books/b1/pages/p1/image",
        blobController.signal,
      );
      blobController.abort();
      await expect(blobPromise).rejects.toMatchObject({ name: "AbortError" });

      // 3. requestApi aborted synchronously while getBrowserAccessToken awaits microtask
      const reqController = new AbortController();
      const reqPromise = requestApi(
        "/books/abort-microtask",
        schema,
        reqController.signal,
        { bypassCache: true },
      );
      reqController.abort();
      await expect(reqPromise).rejects.toMatchObject({ name: "AbortError" });

      expect(fetchMock).not.toHaveBeenCalled();

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
