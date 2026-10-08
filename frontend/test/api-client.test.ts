import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import { ServiceError } from "@/lib/api/service-error";

const { getSession, fetchMock } = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({ auth: { getSession } }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const schema = z.object({ title: z.string() });

beforeEach(() => {
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
});
