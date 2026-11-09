import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createComprehensionService } from "@/lib/api/tutor-question-service";

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

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const QUESTION_ID = "80000000-0000-4000-8000-000000000001";
const REVISION_ID = "70000000-0000-4000-8000-000000000001";

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const nextBody = {
  question: {
    id: QUESTION_ID,
    type: "CLOZE",
    prompt: "Điền từ còn thiếu: Chú ____ thích nằm bên cửa sổ.",
    page_revision_id: REVISION_ID,
    source_span: {
      start_word_index: 0,
      end_word_index_exclusive: 7,
      sentence_index: null,
    },
    difficulty: 1,
    answered: false,
  },
  choices: [
    { id: "A", label: "mèo", value: "mèo" },
    { id: "B", label: "chó", value: "chó" },
    { id: "C", label: "gà", value: "gà" },
  ],
  progress_label: "Câu 2/3",
  position: 2,
  total: 3,
  completed: false,
};

describe("AI tutor question service", () => {
  it("asks the backend to generate questions for a finished session", async () => {
    fetchMock.mockResolvedValue(
      json({ session_id: SESSION_ID, total: 3, source: "AI", created: true }),
    );

    await expect(
      createComprehensionService().prepareQuestions?.(SESSION_ID),
    ).resolves.toBe(3);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8000/tutor/sessions/${SESSION_ID}/questions/generate`,
      expect.objectContaining({ method: "POST", credentials: "omit" }),
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer isolated-test-token");
  });

  it("maps the next question and progress without any expected answer", async () => {
    fetchMock.mockResolvedValue(json(nextBody));

    const view = await createComprehensionService().getQuestion(SESSION_ID);

    expect(view.question.id).toBe(QUESTION_ID);
    expect(view.progress_label).toBe("Câu 2/3");
    expect(view.position).toBe(2);
    expect(view.total).toBe(3);
    expect(view.choices.map((choice) => choice.value)).toEqual([
      "mèo",
      "chó",
      "gà",
    ]);
    expect(JSON.stringify(view)).not.toMatch(/expected/i);
  });

  it("raises a not-found error once every question is answered", async () => {
    fetchMock.mockResolvedValue(
      json({
        question: null,
        choices: [],
        progress_label: "Hoàn thành 3/3",
        position: 3,
        total: 3,
        completed: true,
      }),
    );

    await expect(
      createComprehensionService().getQuestion(SESSION_ID),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("posts the chosen answer and returns the server-side grading", async () => {
    fetchMock.mockResolvedValue(
      json({
        answer_id: "90000000-0000-4000-8000-000000000001",
        question_id: QUESTION_ID,
        submitted_answer: "mèo",
        is_correct: true,
        score: 1,
        feedback_code: "CORRECT",
      }),
    );

    const result = await createComprehensionService().submitAnswer(
      SESSION_ID,
      QUESTION_ID,
      "mèo",
    );

    expect(result.is_correct).toBe(true);
    expect(result.feedback_code).toBe("CORRECT");
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8000/tutor/sessions/${SESSION_ID}/questions/${QUESTION_ID}/answer`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ answer: "mèo" }),
      }),
    );
  });

  it("rejects malformed backend payloads instead of rendering them", async () => {
    fetchMock.mockResolvedValue(json({ ...nextBody, choices: "nope" }));

    await expect(
      createComprehensionService().getQuestion(SESSION_ID),
    ).rejects.toBeDefined();
  });
});
