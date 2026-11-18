import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionService } from "@/lib/api/session-service";
import { createReportService } from "@/lib/api/report-service";
import {
  createDifficultWordService,
  groupDifficultWordsByBook,
} from "@/lib/api/difficult-word-service";
import { parseHistoryPage } from "@/lib/utils/report-state";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const childId = "22222222-2222-4222-8222-222222222222";
const sessionId = "44444444-4444-4444-8444-444444444444";
const bookId = "33333333-3333-4333-8333-333333333333";
const summary = {
  id: sessionId,
  child_id: childId,
  book_id: bookId,
  state: "ABORTED",
  started_at: "2026-10-08T01:00:00Z",
  ended_at: null,
  duration_ms: null,
};
const detail = {
  ...summary,
  selected_page_revision_ids: [],
  reference_page_revision_ids: [],
  events: [],
  fluency_assessment: null,
  comprehension: [],
  report_id: null,
  availability: {
    events: "absent",
    fluency: "absent",
    comprehension: "absent",
  },
};
const report = {
  id: sessionId,
  generated_at: "2026-10-08T01:00:00Z",
  legacy: null,
  data_status: "complete",
  availability: {
    metrics: "available",
    difficult_words: "available",
    comparison: "absent",
  },
  child_id: childId,
  period_start: "2026-09-09",
  period_end: "2026-10-08",
  completed_sessions: 2,
  reading_duration_ms: 120000,
  omission_count: 1,
  repetition_count: 0,
  long_pause_count: 0,
  omission_rate: null,
  repetition_rate: null,
  long_pause_rate: null,
  comprehension_accuracy: null,
  difficult_words: [],
  previous_period: null,
  trend_deltas: {
    completed_sessions: null,
    reading_duration_ms: null,
    omission_rate: null,
    repetition_rate: null,
    long_pause_rate: null,
    comprehension_accuracy: null,
  },
};
const window = {
  period_start: "2026-09-09",
  period_end: "2026-10-08",
  days: 30,
  timezone: "Asia/Ho_Chi_Minh" as const,
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("real Parent report services", () => {
  it("encodes child/cursor/limit and preserves null duration", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ sessions: [summary], next_cursor: "page-3" }),
    );
    const result = await createSessionService().list(childId, {
      cursor: "page-2",
      limit: 2,
    });
    expect(result.sessions[0].duration_ms).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:8000/reading/history?child_id=${childId}&cursor=page-2&limit=2`,
    );
  });
  it("accepts an actual empty history", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ sessions: [], next_cursor: null }),
    );
    expect(await createSessionService().list(childId)).toEqual({
      sessions: [],
      next_cursor: null,
    });
  });
  it("rejects records for a different child", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        sessions: [{ ...summary, child_id: bookId }],
        next_cursor: null,
      }),
    );
    await expect(createSessionService().list(childId)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("rejects legacy session enums instead of remapping", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        sessions: [{ ...summary, state: "COMPLETED" }],
        next_cursor: null,
      }),
    );
    await expect(createSessionService().list(childId)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("keeps optional assessment/report unknown", async () => {
    fetchMock.mockResolvedValue(Response.json(detail));
    expect(await createSessionService().get(sessionId)).toEqual(detail);
  });
  it("rejects a different session detail", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...detail, id: bookId }));
    await expect(createSessionService().get(sessionId)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
  it("loads a retired historical book only through the owned session endpoint", async () => {
    const book = {
      id: bookId,
      title: "Sách lịch sử",
      author: null,
      min_grade: 1,
      max_grade: 3,
      lifecycle_status: "RETIRED",
    };
    fetchMock.mockResolvedValue(Response.json(book));
    expect(await createSessionService().getBook(sessionId)).toEqual(book);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:8000/reading/history/${sessionId}/book`,
    );
  });
  it("reads exact report period without inventing previous metrics", async () => {
    fetchMock.mockResolvedValue(Response.json(report));
    expect(await createReportService().get(childId, window)).toEqual(report);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "period_start=2026-09-09&period_end=2026-10-08",
    );
  });
  it.each([
    { ...report, child_id: bookId },
    { ...report, period_start: "2026-09-01" },
    { avg_fluency: 80, total_books: 2 },
  ])("rejects mismatched or incomplete reports", async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(
      createReportService().get(childId, window),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
  it("reads actual empty word evidence through its scoped endpoint", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    expect(await createDifficultWordService().list(childId, window)).toEqual(
      [],
    );
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/system/difficult-words/${childId}?period_start=`,
    );
  });
  it("starts, evaluates audio, completes, and fetches practice history cleanly", async () => {
    const attemptId = "55555555-5555-4555-8555-555555555555";
    const requestId = "66666666-6666-4666-8666-666666666666";
    const completionId = "77777777-7777-4777-8777-777777777777";
    const attemptPayload = {
      attempt_id: attemptId,
      child_id: childId,
      normalized_word: "mèo",
      display_text: "Mèo",
      attempt_number: 1,
      state: "STARTED",
      assessment_status: null,
      recognition_source: null,
      spoken_transcript: null,
      confidence: null,
      audio_duration_ms: null,
      assessment_version: 1,
      evidence_word_ids: [bookId],
      started_at: "2026-11-18T02:00:00Z",
      completed_at: null,
      feedback_message: null,
      word_progress: {
        normalized_word: "mèo",
        practice_status: "IN_PROGRESS",
        practice_attempts_count: 0,
        practice_correct_count: 0,
        practice_incorrect_count: 0,
        practice_uncertain_count: 0,
        consecutive_correct_count: 0,
        required_consecutive_correct: 2,
        last_practiced_at: null,
        last_practice_status: null,
      },
      next_recommended_word: null,
      evidence_count_unchanged: true,
    };
    fetchMock.mockResolvedValueOnce(Response.json(attemptPayload));
    const started = await createDifficultWordService().startPractice(childId, {
      request_id: requestId,
      normalized_word: "mèo",
      display_text: "Mèo",
      evidence_word_ids: [bookId],
    });
    expect(started.attempt_id).toBe(attemptId);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:8000/system/difficult-words/${childId}/practice/start`,
    );

    const completedPayload = {
      ...attemptPayload,
      state: "COMPLETED",
      assessment_status: "CORRECT",
      recognition_source: "SERVER_STT",
      spoken_transcript: "mèo",
      audio_duration_ms: 800,
      completed_at: "2026-11-18T02:00:05Z",
      feedback_message: "Giỏi lắm! Con đọc đúng từ này rồi!",
      word_progress: {
        ...attemptPayload.word_progress,
        practice_attempts_count: 1,
        practice_correct_count: 1,
        consecutive_correct_count: 1,
        last_practiced_at: "2026-11-18T02:00:05Z",
        last_practice_status: "CORRECT",
      },
    };
    fetchMock.mockResolvedValueOnce(Response.json(completedPayload));
    const evaluated = await createDifficultWordService().evaluateAudio(
      childId,
      attemptId,
      {
        completion_request_id: completionId,
        audio: new Blob(["fake-webm"], { type: "audio/webm" }),
        audio_duration_ms: 800,
        audio_quality_status: "SPEECH_DETECTED",
      },
    );
    expect(evaluated.assessment_status).toBe("CORRECT");
    expect(fetchMock.mock.calls[1][0]).toBe(
      `http://127.0.0.1:8000/system/difficult-words/${childId}/practice/${attemptId}/evaluate-audio`,
    );
    expect(fetchMock.mock.calls[1][1]?.body).toBeInstanceOf(FormData);

    fetchMock.mockResolvedValueOnce(
      Response.json({
        storage_ready: true,
        items: [
          {
            attempt_id: attemptId,
            normalized_word: "mèo",
            display_text: "Mèo",
            attempt_number: 1,
            state: "COMPLETED",
            assessment_status: "CORRECT",
            recognition_source: "SERVER_STT",
            spoken_transcript: "mèo",
            confidence: null,
            audio_duration_ms: 800,
            assessment_version: 1,
            started_at: "2026-11-18T02:00:00Z",
            completed_at: "2026-11-18T02:00:05Z",
          },
        ],
      }),
    );
    const history = await createDifficultWordService().getPracticeHistory(
      childId,
      { normalizedWord: "mèo", limit: 5 },
    );
    expect(history.storage_ready).toBe(true);
    expect(history.items).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(
      Response.json(
        { detail: "DIFFICULT_WORD_PRACTICE_STORAGE_UNAVAILABLE" },
        { status: 503 },
      ),
    );
    await expect(
      createDifficultWordService().practice(childId, "mèo", "Mèo"),
    ).rejects.toMatchObject({ status: 503 });

    // Single-roundtrip direct evaluation endpoint (/practice/evaluate)
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...completedPayload,
        normalized_word: "có",
        display_text: "có",
        persistence_backend: "READING_EVENT",
        resolved_in_session: true,
        word_progress: {
          ...completedPayload.word_progress,
          normalized_word: "có",
          practice_status: "COMPLETED",
          required_consecutive_correct: 1,
        },
      }),
    );
    const directRes = await createDifficultWordService().evaluatePracticeWord!(
      childId,
      {
        request_id: completionId,
        normalized_word: "có",
        display_text: "có",
        audio: new Blob(["webm-co"], { type: "audio/webm" }),
        audio_duration_ms: 680,
        book_id: bookId,
        session_id: sessionId,
      },
    );
    expect(directRes.persistence_backend).toBe("READING_EVENT");
    expect(directRes.word_progress.practice_status).toBe("COMPLETED");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      `http://127.0.0.1:8000/system/difficult-words/${childId}/practice/evaluate`,
    );

    const groups = groupDifficultWordsByBook([
      {
        normalized_word: "có",
        display_text: "có",
        difficulty_score: 4,
        omission_count: 1,
        repetition_count: 0,
        long_pause_count: 0,
        read_example_count: 0,
        session_count: 1,
        last_seen_at: "2026-11-18T02:00:00Z",
        evidence_word_ids: [bookId],
        practice_status: "NOT_PRACTICED",
        sources: [
          {
            book_id: bookId,
            book_title: "Chào ngày mới",
            page_number: 2,
            last_seen_at: "2026-11-18T02:00:00Z",
          },
        ],
      },
      {
        normalized_word: "mèo",
        display_text: "Mèo",
        difficulty_score: 2,
        omission_count: 1,
        repetition_count: 0,
        long_pause_count: 0,
        read_example_count: 0,
        session_count: 1,
        last_seen_at: "2026-11-17T02:00:00Z",
        evidence_word_ids: [bookId],
        practice_status: "COMPLETED",
      },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].bookTitle).toBe("Chào ngày mới");
    expect(groups[0].completedWords).toBe(0);
    expect(groups[1].bookTitle).toBe("Chưa xác định nguồn sách");
    expect(groups[1].completedWords).toBe(1);
  });
  it.each([401, 403, 404, 501, 503])(
    "preserves safe failure status %i",
    async (status) => {
      fetchMock.mockImplementation(async () =>
        Response.json({ detail: "private sql token" }, { status }),
      );
      await expect(createSessionService().list(childId)).rejects.toMatchObject({
        status,
      });
      await expect(createReportService().get(childId)).rejects.not.toThrow(
        "private sql token",
      );
    },
  );
  it("allows a valid bounded page", () =>
    expect(parseHistoryPage("2")).toBe(2));
});
