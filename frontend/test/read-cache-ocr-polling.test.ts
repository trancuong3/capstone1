import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import {
  isCacheableApiGetPath,
  resetAllApiCachesForTests,
  setApiReadCacheActorScope,
  setApiReadCacheEnabled,
} from "@/lib/api/read-cache";

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

const statusSchema = z.object({ status: z.string() });

beforeEach(() => {
  resetAllApiCachesForTests();
  setApiReadCacheEnabled(true);
  setApiReadCacheActorScope("parent-1");
  initialize.mockReset().mockResolvedValue({ error: null });
  getSession.mockReset().mockResolvedValue({
    data: { session: { access_token: "test-jwt-token" } },
    error: null,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  resetAllApiCachesForTests();
  vi.unstubAllGlobals();
});

describe("OCR job & /my-books read-cache bypass protection", () => {
  it("marks all OCR job polling, my-books, and global-tasks endpoints as non-cacheable", () => {
    expect(isCacheableApiGetPath("/reading/scan-page-ocr/jobs/job-123")).toBe(
      false,
    );
    expect(isCacheableApiGetPath("/books/admin/ocr-jobs/job-456")).toBe(false);
    expect(isCacheableApiGetPath("/books/my-books/book-1")).toBe(false);
    expect(
      isCacheableApiGetPath("/books/my-books/book-1/submissions/sub-1"),
    ).toBe(false);
    expect(isCacheableApiGetPath("/studio/global-tasks?limit=20")).toBe(false);
    expect(isCacheableApiGetPath("/health")).toBe(false);

    // Static book metadata remains cacheable so normal child reading stays fast.
    expect(isCacheableApiGetPath("/books/book-1")).toBe(true);
  });

  it("never serves stale 15s cached status when polling scan-page-ocr, admin ocr-jobs, or my-books", async () => {
    for (const pollPath of [
      "/reading/scan-page-ocr/jobs/job-1",
      "/books/admin/ocr-jobs/job-1",
      "/books/my-books/book-1",
    ]) {
      fetchMock
        .mockResolvedValueOnce(Response.json({ status: "QUEUED" }))
        .mockResolvedValueOnce(Response.json({ status: "SUCCEEDED" }));

      const first = await requestApi(pollPath, statusSchema);
      const second = await requestApi(pollPath, statusSchema);

      expect(first.status).toBe("QUEUED");
      expect(second.status).toBe("SUCCEEDED");
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
