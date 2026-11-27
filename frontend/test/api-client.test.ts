import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiQuery, requestApi } from "@/lib/api/api-client";
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
      requestApi("/books/", schema, undefined, { bypassCache: true }),
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
      message: expect.stringContaining("Google Drive"),
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
    } finally {
      vi.useRealTimers();
    }
  });
});
