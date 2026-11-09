import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChildProgressService } from "@/lib/api/child-progress-service";

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

const CHILD_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  initialize.mockReset().mockResolvedValue({ error: null });
  getSession.mockReset().mockResolvedValue({
    data: { session: { access_token: "isolated-test-token" } },
    error: null,
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

export const assessmentBody = {
  child_id: CHILD_ID,
  period_start: "2026-10-11",
  period_end: "2026-11-09",
  days: 30,
  generated_at: "2026-11-09T12:00:00+07:00",
  data_status: "OK",
  score: {
    overall: 63,
    previous_overall: 58,
    delta: 5,
    grade: "FAIR",
    grade_label: "Khá",
    components: [
      {
        key: "ACCURACY",
        label: "Đọc đúng",
        score: 76,
        previous_score: 70,
        detail: "Đọc đúng 596/780 từ.",
      },
      {
        key: "COMPREHENSION",
        label: "Hiểu bài",
        score: null,
        previous_score: null,
        detail: "Chưa đủ câu hỏi.",
      },
    ],
  },
  metrics: {
    sessions: 29,
    active_days: 8,
    reading_minutes: 148,
    books: 4,
    pages_compared: 28,
    words_read: 780,
    coverage_pct: 37.9,
    accuracy_pct: 76.4,
    skipped_rate_pct: 12.8,
    substitution_rate_pct: 10.8,
    hesitations: 62,
    repeated_words: 7,
    hesitations_per_100_words: 8.8,
    words_per_minute: null,
    comprehension_answered: 0,
    comprehension_first_try_pct: null,
    comprehension_by_type: [],
    retry_confirmed: 0,
    retry_failed: 0,
  },
  weekly: [
    { week_start: "2026-10-11", sessions: 1, minutes: 20, accuracy_pct: null },
    { week_start: "2026-10-18", sessions: 5, minutes: 90, accuracy_pct: 76.4 },
  ],
  difficult_words: [{ word: "dây", times: 20, heard_as: "dậy" }],
  assessment: {
    source: "RULE_BASED",
    model: null,
    headline: "Bé đang dần quen với việc đọc",
    summary: "Trong 30 ngày qua bé hoàn thành 29 buổi đọc.",
    strengths: ["Bé đã hoàn thành 29 buổi đọc."],
    weaknesses: [{ area: "Hay bỏ sót từ", detail: "Bỏ sót 12,8% số từ." }],
    actions: [
      {
        title: "Chỉ từng từ",
        detail: "Dùng ngón tay chỉ.",
        audience: "PARENT",
      },
    ],
    practice_words: ["dây"],
    encouragement: "Bé cố gắng lên nhé!",
  },
  ai_cached: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("child progress service", () => {
  it("loads scores with a GET and the user's token", async () => {
    fetchMock.mockResolvedValue(json(assessmentBody));

    const result = await createChildProgressService().get(CHILD_ID, 30);

    expect(result.score.overall).toBe(63);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8000/tutor/children/${CHILD_ID}/progress-assessment?days=30`,
      expect.objectContaining({ credentials: "omit" }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer isolated-test-token");
  });

  it("asks the AI with a POST body", async () => {
    fetchMock.mockResolvedValue(json(assessmentBody));

    await createChildProgressService().generate(CHILD_ID, 90, {
      refresh: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8000/tutor/children/${CHILD_ID}/progress-assessment`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ days: 90, refresh: true }),
      }),
    );
  });

  it("rejects malformed payloads and answers about another child", async () => {
    fetchMock.mockResolvedValue(
      json({
        ...assessmentBody,
        score: { ...assessmentBody.score, overall: 250 },
      }),
    );
    await expect(
      createChildProgressService().get(CHILD_ID, 30),
    ).rejects.toBeDefined();

    fetchMock.mockResolvedValue(
      json({
        ...assessmentBody,
        child_id: "44444444-4444-4444-8444-444444444444",
      }),
    );
    await expect(
      createChildProgressService().get(CHILD_ID, 30),
    ).rejects.toBeDefined();
  });
});
