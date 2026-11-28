import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { createPictureDescriptionService } from "@/lib/api/picture-description-service";
import { isServiceError } from "@/lib/api/service-error";
import {
  childFixture,
  TEST_BOOK_ID,
  TEST_CHILD_ID,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const recorderMock = vi.hoisted(() => ({
  isRecording: false,
  isSpeaking: false,
  audioLevel: 0,
  prepare: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => new Blob(["fake-audio"], { type: "audio/webm" })),
  cancel: vi.fn(),
  getStream: vi.fn(() => null),
  getIsSpeaking: vi.fn(() => false),
  getQuality: vi.fn(() => null),
  getSettings: vi.fn(() => ({})),
}));
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => recorderMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));
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

const PAGE_ID = "31000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "41000000-0000-4000-8000-000000000001";

const catalogPayload = {
  samples: [
    {
      sample_key: "sunny-garden",
      title: "Khu vườn đầy nắng",
      theme: "Thiên nhiên",
      description: "Chú mèo cam ngủ trưa trên ghế gỗ giữa vườn hoa.",
      image_url: "/images/picture-description/sunny-garden.jpg",
    },
  ],
  book_pages: [
    {
      book_id: TEST_BOOK_ID,
      book_title: "Khu vườn buổi sáng",
      page_id: PAGE_ID,
      page_number: 3,
      image_url: "https://signed.example/book-page-3.png",
    },
  ],
};

const baseSession = {
  session_id: TEST_SESSION_ID,
  child_id: TEST_CHILD_ID,
  child_grade: 2,
  source_type: "SAMPLE",
  sample_key: "sunny-garden",
  book_id: null,
  book_page_id: null,
  image_url: "/images/picture-description/sunny-garden.jpg",
  scene_title: "Chú mèo ngủ trưa trong vườn nắng",
  status: "ACTIVE",
  best_stars: 0,
  best_score: 0,
  attempts_count: 0,
  guide: {
    is_child_safe: true,
    scene_title: "Chú mèo ngủ trưa trong vườn nắng",
    scene_summary:
      "Chú mèo cam đang nằm ngủ trên ghế gỗ giữa khu vườn đầy nắng.",
    guiding_questions: [
      "Bé thấy con vật nào đang nằm ngủ trên ghế gỗ?",
      "Xung quanh ghế có những bông hoa gì?",
      "Mặt trời hôm nay trông như thế nào?",
    ],
    suggested_vocabulary: [
      { word: "nằm cuộn tròn", hint: "Tư thế ngủ ngoan của chú mèo" },
      { word: "hướng dương", hint: "Loài hoa màu vàng tươi" },
    ],
    model_sample_sentences: [
      "Chú mèo cam đang ngủ ngon lành trên chiếc ghế gỗ giữa vườn hoa.",
    ],
  },
  attempts: [],
  created_at: "2026-11-15T08:00:00Z",
  updated_at: "2026-11-15T08:00:00Z",
};

const evaluatedFeedback = {
  is_relevant: true,
  score_out_of_10: 9,
  stars: 3,
  matched_details: ["Chú mèo màu cam ngủ trên ghế gỗ", "Hoa hướng dương vàng"],
  missed_details: ["Chiếc bình tưới nước màu xanh"],
  praise_message: "Cô khen bé quan sát rất tinh mắt và viết câu trọn ý!",
  improvement_tip: "Lần sau bé kể thêm chiếc bình tưới cây bên góc cỏ nữa nhé.",
  upgraded_sentences: [
    "Dưới nắng mai ấm áp, chú mèo cam đang cuộn tròn ngủ ngon trên ghế gỗ.",
  ],
  vocabulary_highlights: ["cuộn tròn", "ấm áp"],
};

const fetchMock = vi.fn();

beforeEach(() => {
  navigation.replace.mockReset();
  navigation.push.mockReset();
  recorderMock.start.mockClear();
  recorderMock.stop.mockClear();
  recorderMock.cancel.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      writable: true,
      value: vi.fn(() => "blob:preview-picture"),
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      writable: true,
      value: vi.fn(),
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setupDefaultResponses() {
  let completed = false;
  const ttsTexts: string[] = [];
  let sttCallCount = 0;

  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const reqUrl = new URL(url);
    const path = reqUrl.pathname;
    if (path === `/profiles/children/${TEST_CHILD_ID}`) {
      return Response.json(childFixture);
    }
    if (path === "/voice/text-to-speech") {
      if (init?.body) {
        try {
          const parsed = JSON.parse(String(init.body)) as { text?: string };
          if (parsed.text) ttsTexts.push(parsed.text);
        } catch {
          // Ignore invalid JSON body in test.
        }
      }
      return new Response(null, { status: 503 });
    }
    if (path === "/voice/speech-to-text") {
      sttCallCount += 1;
      return Response.json({
        text: "Cô giáo đang đọc sách cùng học sinh.",
        language_code: "vie",
        language_probability: 0.99,
        words: [],
      });
    }
    if (path === "/games/picture-description/catalog") {
      return Response.json(catalogPayload);
    }
    if (
      path === "/games/picture-description/sessions" &&
      (!init?.method || init.method === "GET")
    ) {
      return Response.json(
        completed
          ? [
              {
                session_id: TEST_SESSION_ID,
                child_id: TEST_CHILD_ID,
                source_type: "SAMPLE",
                scene_title: baseSession.scene_title,
                image_url: baseSession.image_url,
                status: "COMPLETED",
                best_stars: 3,
                best_score: 9,
                attempts_count: 1,
                created_at: baseSession.created_at,
                updated_at: "2026-11-15T08:05:00Z",
              },
            ]
          : [],
      );
    }
    if (
      path === "/games/picture-description/sessions" &&
      init?.method === "POST"
    ) {
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      const sourceType = form.get("source_type");
      return Response.json(
        {
          ...baseSession,
          source_type: sourceType,
        },
        { status: 201 },
      );
    }
    if (
      path === `/games/picture-description/sessions/${TEST_SESSION_ID}/evaluate`
    ) {
      completed = true;
      const body = JSON.parse(String(init?.body)) as {
        transcript_text: string;
        input_mode: string;
      };
      const attempt = {
        attempt_id: ATTEMPT_ID,
        attempt_number: 1,
        input_mode: body.input_mode,
        transcript_text: body.transcript_text,
        score_out_of_10: 9,
        stars: 3,
        feedback: evaluatedFeedback,
        created_at: "2026-11-15T08:05:00Z",
      };
      return Response.json({
        session: {
          ...baseSession,
          status: "COMPLETED",
          best_stars: 3,
          best_score: 9,
          attempts_count: 1,
          attempts: [attempt],
        },
        latest_attempt: attempt,
      });
    }
    throw new Error(`Unexpected test route ${path}`);
  });
  return {
    ttsTexts,
    getSttCallCount: () => sttCallCount,
  };
}

function renderScreen() {
  return render(
    <AppServicesProvider>
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <PictureDescriptionScreen />
      </WithSelectedChild>
    </AppServicesProvider>,
  );
}

describe("PictureDescriptionScreen", () => {
  it("loads catalog samples without spoilers, hides hints initially, and evaluates child's description", async () => {
    setupDefaultResponses();
    const user = userEvent.setup({ delay: null });
    renderScreen();

    expect(
      await screen.findByRole("heading", { name: "Kể chuyện qua tranh" }),
    ).toBeInTheDocument();

    expect(await screen.findByText("Khu vườn đầy nắng")).toBeInTheDocument();
    expect(
      screen.queryByText(catalogPayload.samples[0].description),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Khám phá tranh này" }),
    );

    expect(
      await screen.findByText("Chú mèo ngủ trưa trong vườn nắng"),
    ).toBeInTheDocument();
    // Scene summary spoiler and guiding questions stay hidden until the child opens hints
    expect(
      screen.queryByText(baseSession.guide.scene_summary),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Bé thấy con vật nào đang nằm ngủ trên ghế gỗ?"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Mở gợi ý câu hỏi/i }));
    expect(
      await screen.findByText("Bé thấy con vật nào đang nằm ngủ trên ghế gỗ?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Câu mẫu tham khảo sẽ mở sau khi bé tự kể và gửi lượt đầu tiên nhé!",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Xem câu mẫu tham khảo/i }),
    ).not.toBeInTheDocument();

    // Tap suggested vocab chip to view definition hint
    await user.click(screen.getByRole("button", { name: /nằm cuộn tròn/i }));
    expect(
      await screen.findByText(/Tư thế ngủ ngoan của chú mèo/),
    ).toBeInTheDocument();

    const textarea = screen.getByLabelText("Nội dung bé mô tả bức tranh");
    await user.type(
      textarea,
      "Chú mèo màu cam đang ngủ ngon trên ghế gỗ giữa vườn hoa hướng dương.",
    );

    await user.click(
      screen.getByRole("button", { name: /Gửi cô giáo AI chấm bài/i }),
    );

    expect(
      await screen.findByText(
        "Cô khen bé quan sát rất tinh mắt và viết câu trọn ý!",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Kết quả chấm điểm/i }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("9/10 điểm")).toBeInTheDocument();
    expect(
      screen.getByText("• Chú mèo màu cam ngủ trên ghế gỗ"),
    ).toBeInTheDocument();
    // Evaluation result shows on its own tab without mixing with the input/hints panel
    expect(
      screen.queryByLabelText("Nội dung bé mô tả bức tranh"),
    ).not.toBeInTheDocument();

    // Switch back to the practice tab -> input & unlocked model sentences return, result card hides
    await user.click(screen.getByRole("tab", { name: /Mô tả tranh/i }));
    expect(screen.getByRole("tab", { name: /Mô tả tranh/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByLabelText("Nội dung bé mô tả bức tranh"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Xem câu mẫu tham khảo/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("9/10 điểm")).not.toBeInTheDocument();
  }, 25_000);

  it("supports custom upload tab validation and book page selection", async () => {
    setupDefaultResponses();
    const user = userEvent.setup({ delay: null });
    renderScreen();

    await screen.findByText("Khu vườn đầy nắng");

    // Switch to Book Page tab
    await user.click(
      screen.getByRole("tab", { name: /Tranh từ sách ViRead/i }),
    );
    expect(await screen.findByText("Khu vườn buổi sáng")).toBeInTheDocument();

    // Switch to Custom Upload tab and upload a valid PNG file
    await user.click(screen.getByRole("tab", { name: /Tải ảnh từ máy/i }));
    const fileInput = screen.getByLabelText("Chọn tệp ảnh để mô tả");
    const validFile = new File(["fake-png"], "tranh-ve.png", {
      type: "image/png",
    });
    await user.upload(fileInput, validFile);

    await waitFor(() => {
      expect(screen.getByText("Đã chọn: tranh-ve.png")).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /Phân tích tranh & Bắt đầu/i }),
    );

    expect(
      await screen.findByText("Chú mèo ngủ trưa trong vườn nắng"),
    ).toBeInTheDocument();
  });

  it("shows a safe Vietnamese error when Gemini rejects an unsafe image", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/picture-description/catalog") {
        return Response.json(catalogPayload);
      }
      if (
        path === "/games/picture-description/sessions" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json([]);
      }
      if (
        path === "/games/picture-description/sessions" &&
        init?.method === "POST"
      ) {
        return Response.json({ detail: "UNSAFE_PICTURE" }, { status: 422 });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup({ delay: null });
    renderScreen();
    await screen.findByText("Khu vườn đầy nắng");

    await user.click(
      screen.getByRole("button", { name: "Khám phá tranh này" }),
    );

    expect(
      await screen.findByText(/Bức tranh này chưa phù hợp cho trẻ tiểu học/i),
    ).toBeInTheDocument();
  });

  it("displays realtime spoken words while recording and prefers ElevenLabs STT & TTS", async () => {
    const { ttsTexts, getSttCallCount } = setupDefaultResponses();
    const recognitionState = {
      createdCount: 0,
      lang: "",
      continuous: false,
      interimResults: false,
      onresult: null as ((event: unknown) => void) | null,
      onend: null as (() => void) | null,
      onerror: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
      abort: vi.fn(),
    };

    class MockSpeechRecognition {
      constructor() {
        recognitionState.createdCount += 1;
      }

      get lang() {
        return recognitionState.lang;
      }

      set lang(value: string) {
        recognitionState.lang = value;
      }

      get continuous() {
        return recognitionState.continuous;
      }

      set continuous(value: boolean) {
        recognitionState.continuous = value;
      }

      get interimResults() {
        return recognitionState.interimResults;
      }

      set interimResults(value: boolean) {
        recognitionState.interimResults = value;
      }

      get onresult() {
        return recognitionState.onresult;
      }

      set onresult(fn: ((event: unknown) => void) | null) {
        recognitionState.onresult = fn;
      }

      get onend() {
        return recognitionState.onend;
      }

      set onend(fn: (() => void) | null) {
        recognitionState.onend = fn;
      }

      get onerror() {
        return recognitionState.onerror;
      }

      set onerror(fn: (() => void) | null) {
        recognitionState.onerror = fn;
      }

      start = recognitionState.start;
      stop = recognitionState.stop;
      abort = recognitionState.abort;
    }

    vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);

    const user = userEvent.setup({ delay: null });
    renderScreen();

    await screen.findByText("Khu vườn đầy nắng");
    await user.click(
      screen.getByRole("button", { name: "Khám phá tranh này" }),
    );
    await screen.findByText("Chú mèo ngủ trưa trong vườn nắng");

    await user.click(screen.getByRole("button", { name: /Nói bằng Micro/i }));

    expect(recorderMock.start).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(recognitionState.createdCount).toBe(1);
    });
    expect(recognitionState.lang).toBe("vi-VN");
    expect(recognitionState.interimResults).toBe(true);
    expect(screen.getByText("Bé đang nói:")).toBeInTheDocument();

    // Emit duplicate Chrome final phrases + interim words -> realtime preview deduplicates them
    act(() => {
      recognitionState.onresult?.({
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: "Cô giáo.", confidence: 0.92 } },
          { isFinal: true, 0: { transcript: "Cô giáo.", confidence: 0.91 } },
          {
            isFinal: false,
            0: { transcript: "đang đọc sách", confidence: 0.7 },
          },
        ],
      });
    });

    expect(screen.getByTestId("live-voice-transcript")).toHaveTextContent(
      /Cô giáo\. đang đọc sách/,
    );

    await user.click(screen.getByRole("button", { name: /Dừng ghi âm/i }));

    await waitFor(() => {
      expect(getSttCallCount()).toBe(1);
    });
    const textarea = screen.getByLabelText(
      "Nội dung bé mô tả bức tranh",
    ) as HTMLTextAreaElement;
    // ElevenLabs scribe_v2 response takes precedence over noisy browser recognition
    expect(textarea.value).toBe("Cô giáo đang đọc sách cùng học sinh.");

    // ElevenLabs TTS replay button appears for the drafted child story
    await user.click(screen.getByRole("button", { name: /Nghe lại/i }));
    await waitFor(() => {
      expect(ttsTexts).toContain("Cô giáo đang đọc sách cùng học sinh.");
    });
  });

  it("supports multi-attempt history, coaching reminder, and fresh/edit retry actions", async () => {
    const attempt1 = {
      attempt_id: "41000000-0000-4000-8000-000000000011",
      attempt_number: 1,
      input_mode: "TEXT",
      transcript_text: "Chú mèo đang ngủ.",
      score_out_of_10: 6,
      stars: 2,
      feedback: {
        ...evaluatedFeedback,
        score_out_of_10: 6,
        stars: 2,
        praise_message: "Bé đã kể đúng chú mèo rồi!",
        improvement_tip:
          "Hãy kể thêm màu lông cam và vườn hoa hướng dương nhé.",
      },
      created_at: "2026-11-15T08:05:00Z",
    };
    const attempt2 = {
      attempt_id: "41000000-0000-4000-8000-000000000012",
      attempt_number: 2,
      input_mode: "TEXT",
      transcript_text:
        "Chú mèo màu cam đang ngủ ngon trên ghế gỗ cạnh hoa hướng dương.",
      score_out_of_10: 9,
      stars: 3,
      feedback: evaluatedFeedback,
      created_at: "2026-11-15T08:08:00Z",
    };

    let getSessionCalls = 0;
    let createSessionCalls = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/picture-description/catalog") {
        return Response.json(catalogPayload);
      }
      if (
        path === "/games/picture-description/sessions" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json([
          {
            session_id: TEST_SESSION_ID,
            child_id: TEST_CHILD_ID,
            source_type: "SAMPLE",
            sample_key: "sunny-garden",
            scene_title: baseSession.scene_title,
            image_url: baseSession.image_url,
            status: "COMPLETED",
            best_stars: 3,
            best_score: 9,
            attempts_count: 2,
            created_at: baseSession.created_at,
            updated_at: "2026-11-15T08:08:00Z",
          },
        ]);
      }
      if (
        path === "/games/picture-description/sessions" &&
        init?.method === "POST"
      ) {
        createSessionCalls += 1;
        return Response.json(baseSession, { status: 201 });
      }
      if (path === `/games/picture-description/sessions/${TEST_SESSION_ID}`) {
        getSessionCalls += 1;
        return Response.json({
          ...baseSession,
          status: "COMPLETED",
          best_stars: 3,
          best_score: 9,
          attempts_count: 2,
          attempts: [attempt2, attempt1],
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup({ delay: null });
    renderScreen();

    // Sample card detects prior session and offers resume without duplicating sessions
    const resumeBtn = await screen.findByRole("button", {
      name: "Xem kết quả & Kể tiếp",
    });
    await user.click(resumeBtn);

    expect(getSessionCalls).toBe(1);
    expect(createSessionCalls).toBe(0);

    // Opens directly on RESULT tab with score improvement delta & vocabulary_highlights
    expect(
      await screen.findByText("+3 điểm so với lượt trước!"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "cuộn tròn" }),
    ).toBeInTheDocument();

    // Can switch back to Attempt #1 in attempt history selector
    await user.click(screen.getByRole("button", { name: /Lượt #1 • 6\/10/i }));
    expect(screen.getByText("Bé đã kể đúng chú mèo rồi!")).toBeInTheDocument();

    // "Sửa & bổ sung bài vừa kể" loads selected attempt text into PRACTICE tab with coaching reminder
    await user.click(
      screen.getByRole("button", { name: /Sửa & bổ sung bài vừa kể/i }),
    );
    const textarea = screen.getByLabelText(
      "Nội dung bé mô tả bức tranh",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Chú mèo đang ngủ.");
    expect(
      screen.getByText(/Lời dặn của cô giáo từ Lượt #2/i),
    ).toBeInTheDocument();

    // Return to RESULT tab and click "Kể lại từ đầu (lượt mới)" -> clears input cleanly
    await user.click(screen.getByRole("tab", { name: /Kết quả chấm điểm/i }));
    await user.click(
      screen.getByRole("button", { name: /Kể lại từ đầu \(lượt mới\)/i }),
    );
    expect(
      (
        screen.getByLabelText(
          "Nội dung bé mô tả bức tranh",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  it("shows inline evaluation error with retry and supports re-grading FALLBACK attempts with AI", async () => {
    let evaluateCalls = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/picture-description/catalog") {
        return Response.json(catalogPayload);
      }
      if (
        path === "/games/picture-description/sessions" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json([]);
      }
      if (
        path === "/games/picture-description/sessions" &&
        init?.method === "POST"
      ) {
        return Response.json(baseSession, { status: 201 });
      }
      if (
        path ===
        `/games/picture-description/sessions/${TEST_SESSION_ID}/evaluate`
      ) {
        evaluateCalls += 1;
        const body = JSON.parse(String(init?.body)) as {
          transcript_text: string;
          input_mode: string;
        };
        if (evaluateCalls === 1) {
          return Response.json({ detail: "AI_TIMEOUT" }, { status: 504 });
        }
        if (evaluateCalls === 2) {
          const fallbackAttempt = {
            attempt_id: "41000000-0000-4000-8000-000000000021",
            attempt_number: 1,
            input_mode: body.input_mode,
            transcript_text: body.transcript_text,
            score_out_of_10: 8,
            stars: 3,
            evaluation_source: "FALLBACK",
            feedback: {
              ...evaluatedFeedback,
              score_out_of_10: 8,
              praise_message: "Chấm nhanh theo gợi ý tranh thành công!",
            },
            created_at: "2026-11-19T14:00:00Z",
          };
          return Response.json({
            session: {
              ...baseSession,
              status: "COMPLETED",
              best_stars: 3,
              best_score: 8,
              attempts_count: 1,
              attempts: [fallbackAttempt],
            },
            latest_attempt: fallbackAttempt,
          });
        }
        const aiAttempt = {
          attempt_id: "41000000-0000-4000-8000-000000000022",
          attempt_number: 2,
          input_mode: body.input_mode,
          transcript_text: body.transcript_text,
          score_out_of_10: 9,
          stars: 3,
          evaluation_source: "AI",
          feedback: evaluatedFeedback,
          created_at: "2026-11-19T14:01:00Z",
        };
        return Response.json({
          session: {
            ...baseSession,
            status: "COMPLETED",
            best_stars: 3,
            best_score: 9,
            attempts_count: 2,
            attempts: [aiAttempt],
          },
          latest_attempt: aiAttempt,
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup({ delay: null });
    renderScreen();

    await screen.findByText("Khu vườn đầy nắng");
    await user.click(
      screen.getByRole("button", { name: "Khám phá tranh này" }),
    );
    await screen.findByText("Chú mèo ngủ trưa trong vườn nắng");

    const textarea = screen.getByLabelText("Nội dung bé mô tả bức tranh");
    await user.type(
      textarea,
      "Chú mèo cam ngủ ngon trên ghế gỗ giữa vườn hoa hướng dương.",
    );

    // 1st click hits 504 AI_TIMEOUT -> inline error + draft preserved + retry button shown
    await user.click(
      screen.getByRole("button", { name: /Gửi cô giáo AI chấm bài/i }),
    );
    expect(
      await screen.findByText(/Trợ lý AI suy nghĩ hơi lâu một chút/i),
    ).toBeInTheDocument();
    expect((textarea as HTMLTextAreaElement).value).toContain("Chú mèo cam");

    // 2nd click via inline "Thử chấm lại ngay" -> succeeds with FALLBACK badge & re-grade button
    await user.click(
      screen.getByRole("button", { name: /Thử chấm lại ngay/i }),
    );
    expect(
      await screen.findByText("Chấm nhanh theo gợi ý tranh thành công!"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/hệ thống đã chấm nhanh theo gợi ý của bức tranh/i),
    ).toBeInTheDocument();

    // 3rd click via "Chấm lại bằng cô giáo AI" -> upgrades to full AI evaluation
    await user.click(
      screen.getByRole("button", { name: /Chấm lại bằng cô giáo AI/i }),
    );
    expect(
      await screen.findByText(
        "Cô khen bé quan sát rất tinh mắt và viết câu trọn ý!",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/hệ thống đã chấm nhanh theo gợi ý của bức tranh/i),
    ).not.toBeInTheDocument();
    expect(evaluateCalls).toBe(3);
  });

  it("enforces request deadline and throws friendly Vietnamese 504 ServiceError on slow AI", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );
      const service = createPictureDescriptionService();
      const pending = service
        .createSession({
          child_id: TEST_CHILD_ID,
          source_type: "SAMPLE",
          sample_key: "sunny-garden",
        })
        .catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(45_050);
      const caught = await pending;
      expect(isServiceError(caught)).toBe(true);
      if (isServiceError(caught)) {
        expect(caught.status).toBe(504);
        expect(caught.retryable).toBe(true);
        expect(caught.message).toMatch(/phản hồi hơi lâu/i);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports all 6 teaching modes, target difficult-word badges, and PEER/CROWD follow-up question flow", async () => {
    const evaluateBodies: Array<{
      transcript_text: string;
      input_mode: string;
      teaching_mode?: string;
      target_words?: string[];
    }> = [];

    const sessionWithTargets = {
      ...baseSession,
      teaching_mode: "OBSERVE",
      target_words: ["hướng dương", "cuộn tròn"],
      guide: {
        ...baseSession.guide,
        teaching_mode: "OBSERVE",
        target_words: ["hướng dương", "cuộn tròn"],
      },
    };

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/picture-description/catalog") {
        return Response.json(catalogPayload);
      }
      if (
        path === "/games/picture-description/sessions" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json([]);
      }
      if (
        path === "/games/picture-description/sessions" &&
        init?.method === "POST"
      ) {
        return Response.json(sessionWithTargets, { status: 201 });
      }
      if (
        path ===
        `/games/picture-description/sessions/${TEST_SESSION_ID}/evaluate`
      ) {
        const body = JSON.parse(String(init?.body)) as {
          transcript_text: string;
          input_mode: string;
          teaching_mode?: string;
          target_words?: string[];
        };
        evaluateBodies.push(body);
        const attempt = {
          attempt_id: ATTEMPT_ID,
          attempt_number: 1,
          input_mode: body.input_mode,
          transcript_text: body.transcript_text,
          score_out_of_10: 9,
          stars: 3,
          evaluation_source: "AI",
          provider_tier: "GEMINI_PRIMARY",
          feedback: {
            ...evaluatedFeedback,
            teaching_mode: body.teaching_mode ?? "STORY",
            scaffolding_step: "NEXT_CHALLENGE",
            next_prompt_question:
              "Nếu chú mèo cam tỉnh dậy, bé nghĩ chú sẽ nói gì với những bông hoa hướng dương?",
            used_target_words: ["hướng dương"],
            provider_tier: "GEMINI_PRIMARY",
          },
          created_at: "2026-11-25T08:05:00Z",
        };
        return Response.json({
          session: {
            ...sessionWithTargets,
            status: "COMPLETED",
            best_stars: 3,
            best_score: 9,
            attempts_count: 1,
            attempts: [attempt],
          },
          latest_attempt: attempt,
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup({ delay: null });
    renderScreen();

    await screen.findByText("Khu vườn đầy nắng");
    await user.click(
      screen.getByRole("button", { name: "Khám phá tranh này" }),
    );
    await screen.findByText("Chú mèo ngủ trưa trong vườn nắng");

    // All 6 teaching mode pills render cleanly
    for (const label of [
      "Quan sát",
      "Từ vựng",
      "Ghép câu",
      "Kể chuyện",
      "Suy luận",
      "Sáng tạo",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }

    // Target difficult words panel is visible
    expect(screen.getByTestId("target-words-panel")).toBeInTheDocument();
    expect(
      screen.getByText(/Từ khó mục tiêu bé đang luyện/i),
    ).toBeInTheDocument();

    // Switch to "Kể chuyện" (STORY) mode and submit
    const storyPill = screen.getByRole("button", { name: "Kể chuyện" });
    await user.click(storyPill);
    expect(storyPill).toHaveAttribute("aria-pressed", "true");

    const textarea = screen.getByLabelText("Nội dung bé mô tả bức tranh");
    await user.type(
      textarea,
      "Một buổi sáng đầy nắng, chú mèo cam ngủ ngon bên những bông hoa hướng dương rực rỡ.",
    );
    await user.click(
      screen.getByRole("button", { name: /Gửi cô giáo AI chấm bài/i }),
    );

    expect(
      await screen.findByTestId("ai-followup-question"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Nếu chú mèo cam tỉnh dậy, bé nghĩ chú sẽ nói gì với những bông hoa hướng dương?",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Thử thách tiếp theo")).toBeInTheDocument();
    expect(screen.getByTestId("used-target-words-result")).toHaveTextContent(
      "hướng dương",
    );
    expect(evaluateBodies).toHaveLength(1);
    expect(evaluateBodies[0].teaching_mode).toBe("STORY");
    expect(evaluateBodies[0].target_words).toEqual([
      "hướng dương",
      "cuộn tròn",
    ]);

    // Click "Trả lời câu hỏi này" -> switches to Practice tab with follow-up prompt visible
    await user.click(
      screen.getByRole("button", { name: "Trả lời câu hỏi này" }),
    );
    expect(
      await screen.findByTestId("practice-followup-banner"),
    ).toHaveTextContent("chú mèo cam tỉnh dậy");
  });

  it("adapts scaffolding hints by grade: prominent audio-first for Grades 1-2, collapsed by default for Grades 4-5", async () => {
    const grade5Child = { ...childFixture, grade: 5 };
    const grade5Session = { ...baseSession, child_grade: 5 };

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(grade5Child);
      }
      if (path === "/games/picture-description/catalog") {
        return Response.json(catalogPayload);
      }
      if (
        path === "/games/picture-description/sessions" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json([]);
      }
      if (
        path === "/games/picture-description/sessions" &&
        init?.method === "POST"
      ) {
        return Response.json(grade5Session, { status: 201 });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup({ delay: null });
    renderScreen();

    await screen.findByText("Khu vườn đầy nắng");
    await user.click(
      screen.getByRole("button", { name: "Khám phá tranh này" }),
    );
    await screen.findByText("Chú mèo ngủ trưa trong vườn nắng");

    // Grade 5 collapses hint chips by default with 1-tap expand toggle
    const toggleBtn = screen.getByTestId("toggle-grade-hint-chips");
    expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("grade-hint-chips")).not.toBeInTheDocument();

    // 1 tap expands hint chips immediately
    await user.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("grade-hint-chips")).toBeInTheDocument();
  });

  it("enforces G10 anti-TTS-self-capture, background mic/TTS release with draft preservation, and duplicate submit guard", async () => {
    setupDefaultResponses();

    const synthesisMock = {
      speaking: false,
      cancel: vi.fn(() => {
        synthesisMock.speaking = false;
      }),
      speak: vi.fn(),
    };
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      writable: true,
      value: synthesisMock,
    });

    const recognitionState = {
      onresult: null as ((event: unknown) => void) | null,
      onend: null as (() => void) | null,
      onerror: null as (() => void) | null,
      start: vi.fn(),
      stop: vi.fn(),
      abort: vi.fn(),
    };
    class MockSpeechRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      set onresult(fn: ((event: unknown) => void) | null) {
        recognitionState.onresult = fn;
      }
      get onresult() {
        return recognitionState.onresult;
      }
      set onend(fn: (() => void) | null) {
        recognitionState.onend = fn;
      }
      get onend() {
        return recognitionState.onend;
      }
      set onerror(fn: (() => void) | null) {
        recognitionState.onerror = fn;
      }
      get onerror() {
        return recognitionState.onerror;
      }
      start = recognitionState.start;
      stop = recognitionState.stop;
      abort = recognitionState.abort;
    }
    vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);

    const user = userEvent.setup({ delay: null });
    renderScreen();

    await screen.findByText("Khu vườn đầy nắng");
    await user.click(
      screen.getByRole("button", { name: "Khám phá tranh này" }),
    );
    await screen.findByText("Chú mèo ngủ trưa trong vườn nắng");

    // Grade 2 shows audio-first visual hints prominently
    expect(screen.getByTestId("grade-hint-chips")).toBeInTheDocument();

    // 1. Start mic recording and emit partial speech
    await user.click(screen.getByRole("button", { name: /Nói bằng Micro/i }));
    await waitFor(() => {
      expect(recognitionState.start).toHaveBeenCalledTimes(1);
    });
    act(() => {
      recognitionState.onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal: true,
            0: { transcript: "Chú mèo cam nằm ngủ", confidence: 0.9 },
          },
        ],
      });
    });

    // 2. Starting TTS immediately aborts active SpeechRecognition + recorder & preserves spoken draft
    await user.click(screen.getByRole("button", { name: /Nghe chế độ/i }));
    expect(recognitionState.abort).toHaveBeenCalled();
    expect(recorderMock.cancel).toHaveBeenCalled();
    const textarea = screen.getByLabelText(
      "Nội dung bé mô tả bức tranh",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toContain("Chú mèo cam nằm ngủ");

    // Stray SpeechRecognition event during TTS MUST be ignored (never self-captured)
    synthesisMock.speaking = true;
    act(() => {
      recognitionState.onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal: true,
            0: { transcript: "Giọng cô giáo TTS giả", confidence: 0.99 },
          },
        ],
      });
    });
    expect(screen.queryByText(/Giọng cô giáo TTS giả/)).not.toBeInTheDocument();

    // 3. Clicking Record while speechSynthesis.speaking=true immediately cancels TTS and cools down before arming mic
    synthesisMock.cancel.mockClear();
    recorderMock.start.mockClear();
    await user.click(screen.getByRole("button", { name: /Nói bằng Micro/i }));
    expect(synthesisMock.cancel).toHaveBeenCalled();
    await waitFor(
      () => {
        expect(recorderMock.start).toHaveBeenCalledTimes(1);
      },
      { timeout: 1500 },
    );

    // 4. Android background event releases mic & cancels TTS safely without losing spoken draft
    synthesisMock.cancel.mockClear();
    recorderMock.cancel.mockClear();
    act(() => {
      recognitionState.onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal: true,
            0: { transcript: "trên ghế gỗ", confidence: 0.92 },
          },
        ],
      });
      document.dispatchEvent(new Event("viread:android-background"));
    });
    expect(synthesisMock.cancel).toHaveBeenCalled();
    expect(recorderMock.cancel).toHaveBeenCalled();
    expect(textarea.value).toContain("trên ghế gỗ");

    // 5. Offline submission preserves text draft cleanly with helpful message
    const originalOnLine = navigator.onLine;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    await user.click(
      screen.getByRole("button", { name: /Gửi cô giáo AI chấm bài/i }),
    );
    expect(
      await screen.findByText(/Bài kể của bé vẫn được giữ nguyên/i),
    ).toBeInTheDocument();
    expect(textarea.value).toContain("Chú mèo cam nằm ngủ");
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => originalOnLine,
    });

    // 6. Rapid double-click on Evaluate suppresses duplicate submissions
    let evalPosts = 0;
    const prevImpl = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        new URL(url).pathname ===
        `/games/picture-description/sessions/${TEST_SESSION_ID}/evaluate`
      ) {
        evalPosts += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return prevImpl!(url, init);
    });
    const submitBtn = screen.getByRole("button", {
      name: /Gửi cô giáo AI chấm bài/i,
    });
    await Promise.all([user.click(submitBtn), user.click(submitBtn)]);
    await screen.findByText("9/10 điểm");
    expect(evalPosts).toBe(1);
  });

  it("paginates samples, recent sessions, and multi-attempt history at 6 per page", async () => {
    const manySamples = Array.from({ length: 8 }, (_, index) => ({
      sample_key: `sample-${index + 1}`,
      title: `Tranh mẫu số ${index + 1}`,
      theme: "Thiên nhiên",
      description: `Mô tả tranh ${index + 1}`,
      image_url: "/images/picture-description/sunny-garden.jpg",
    }));
    const manySessions = Array.from({ length: 8 }, (_, index) => ({
      session_id: `51000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      child_id: TEST_CHILD_ID,
      source_type: "SAMPLE" as const,
      sample_key: index === 0 ? "sample-1" : `other-${index + 1}`,
      scene_title: `Phiên kể chuyện ${index + 1}`,
      image_url: "/images/picture-description/sunny-garden.jpg",
      status: "COMPLETED" as const,
      best_stars: 3,
      best_score: 9,
      attempts_count: 8,
      created_at: baseSession.created_at,
      updated_at: "2026-11-15T08:08:00Z",
    }));
    const manyAttempts = Array.from({ length: 8 }, (_, index) => ({
      attempt_id: `41000000-0000-4000-8000-${String(8 - index).padStart(12, "0")}`,
      attempt_number: 8 - index,
      input_mode: "TEXT" as const,
      transcript_text: `Bài kể lượt ${8 - index}.`,
      score_out_of_10: 9,
      stars: 3,
      feedback: evaluatedFeedback,
      created_at: "2026-11-15T08:05:00Z",
    }));

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/games/picture-description/catalog") {
        return Response.json({
          ...catalogPayload,
          samples: manySamples,
        });
      }
      if (
        path === "/games/picture-description/sessions" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json(manySessions);
      }
      if (
        path ===
        `/games/picture-description/sessions/${manySessions[0]!.session_id}`
      ) {
        return Response.json({
          ...baseSession,
          session_id: manySessions[0]!.session_id,
          status: "COMPLETED",
          best_stars: 3,
          best_score: 9,
          attempts_count: manyAttempts.length,
          attempts: manyAttempts,
        });
      }
      throw new Error(`Unexpected test route ${path}`);
    });

    const user = userEvent.setup({ delay: null });
    renderScreen();

    expect(await screen.findByText("Tranh mẫu số 1")).toBeInTheDocument();
    expect(screen.getByText("Tranh mẫu số 6")).toBeInTheDocument();
    expect(screen.queryByText("Tranh mẫu số 7")).not.toBeInTheDocument();
    expect(screen.getByText("Phiên kể chuyện 1")).toBeInTheDocument();
    expect(screen.getByText("Phiên kể chuyện 6")).toBeInTheDocument();
    expect(screen.queryByText("Phiên kể chuyện 7")).not.toBeInTheDocument();

    // Open first recent session -> RESULT tab paginates 8 attempts at 6/page
    await user.click(screen.getByRole("button", { name: /Phiên kể chuyện 1/ }));
    expect(
      await screen.findByRole("button", { name: /Lượt #8/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Lượt #3/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Lượt #2/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Tiếp/i }));
    expect(
      await screen.findByRole("button", { name: /Lượt #2/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Lượt #1/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Lượt #8/ }),
    ).not.toBeInTheDocument();
  });
});
