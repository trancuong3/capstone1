import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: vi.fn().mockResolvedValue({ error: null }),
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "synthetic-jwt-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

import { requestApi } from "@/lib/api/api-client";

describe("api-client structured backend error code translation", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("translates allowlisted detail.code payloads into user-facing Vietnamese errors", async () => {
    const expectedCases = [
      ["AI_AUTO_VERIFY_DISABLED", "người kiểm duyệt trực tiếp rà soát"],
      ["IMAGE_SAFETY_UNASSESSED", "xác nhận an toàn"],
      ["RIGHTS_EVIDENCE_REQUIRED", "bằng chứng quyền sử dụng"],
      ["CANDIDATE_HASH_MISMATCH", "kiểm tra an toàn cho nội dung mới"],
      ["TEXT_SAFETY_HIGH_RISK_BLOCKED", "không phù hợp với trẻ em"],
      ["RIGHTS_CONCERN_BLOCKED", "nghi ngại bản quyền"],
    ] as const;

    for (const [code, expectedSnippet] of expectedCases) {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: { code, message: "Internal raw detail should not leak" },
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ) as typeof fetch;

      await expect(
        requestApi(
          "/books/admin/pages/test/verify",
          z.object({ ok: z.boolean() }),
        ),
      ).rejects.toThrow(expectedSnippet);
    }
  });

  it("never reflects unallowlisted internal diagnostic messages or raw SQL", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            code: "UNLISTED_INTERNAL_CODE",
            message: "SELECT * FROM secrets WHERE key='leak'",
          },
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ) as typeof fetch;

    let caughtMessage = "";
    try {
      await requestApi(
        "/books/admin/pages/test/verify",
        z.object({ ok: z.boolean() }),
      );
    } catch (error) {
      caughtMessage = error instanceof Error ? error.message : String(error);
    }

    expect(caughtMessage).toContain("Có lỗi xảy ra");
    expect(caughtMessage).not.toContain("SELECT");
    expect(caughtMessage).not.toContain("secrets");
  });
});
