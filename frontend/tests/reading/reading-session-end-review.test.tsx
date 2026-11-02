import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadingScreen } from "@/components/reading/reading-screen";
import type { ReadingServices } from "@/hooks/use-reading-services";
import {
  bookFixture,
  childFixture,
  sessionSummaryFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type { ReadingPageDTO, ReadingSessionPageProgressDTO } from "@/types/reading";

const mocks = vi.hoisted(() => ({
  services: null as unknown,
  recorder: {
    callback: null as ((audio: Blob) => void) | null,
    emitTailOnStop: false,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  },
  speech: {
    transcribe: vi.fn(),
  },
  player: {
    play: vi.fn(),
    stop: vi.fn(),
  },
  compareTranscript: vi.fn(),
}));

vi.mock("@/hooks/use-reading-services", () => ({
  useReadingServices: () => mocks.services,
}));
vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => ({
    audioLevel: 0,
    isSpeaking: false,
    isRecording: true,
    start: mocks.recorder.start,
    stop: mocks.recorder.stop,
    cancel: mocks.recorder.cancel,
  }),
}));
vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => ({
    isPlaying: false,
    play: mocks.player.play,
    stop: mocks.player.stop,
  }),
}));
vi.mock("@/lib/api/speech-service", () => ({
  createSpeechService: () => ({
    transcribe: mocks.speech.transcribe,
    synthesize: vi.fn(),
  }),
}));
vi.mock("@/lib/api/comparison-service", () => ({
  compareTranscript: mocks.compareTranscript,
}));

const pageFour: ReadingPageDTO = {
  page_id: "30000000-0000-4000-8000-000000000014",
  page_revision_id: "40000000-0000-4000-8000-000000000014",
  page_number: 4,
  confidence: 0.95,
  width: 600,
  height: 800,
  text: "Bé mèo nhỏ đang",
  words: ["Bé", "mèo", "nhỏ", "đang"].map((text, index) => ({
    word_id: `50000000-0000-4000-8000-00000000040${index}`,
    word_index: index,
    line_index: 0,
    text,
    bbox: [0.1 + index * 0.15, 0.2, 0.1, 0.05] as const,
  })),
};
const previews = [pageFour].map((page) => ({
  page_id: page.page_id,
  page_number: page.page_number,
  lifecycle_status: "ACTIVE" as const,
  current_verified_revision_id: page.page_revision_id,
  preview_url: "https://example.com/test-page.png",
}));
const pageProgress: ReadingSessionPageProgressDTO = {
  session_id: TEST_SESSION_ID,
  persisted: true,
  start_page_id: pageFour.page_id,
  end_page_id: pageFour.page_id,
  current_page_id: pageFour.page_id,
  start_page_number: pageFour.page_number,
  end_page_number: pageFour.page_number,
  current_page_number: pageFour.page_number,
  current_index: 0,
  total_pages: 1,
  completed_pages: 0,
  pages: [
    {
      page_id: pageFour.page_id,
      page_revision_id: pageFour.page_revision_id,
      page_number: pageFour.page_number,
      page_order: 0,
      status: "IN_PROGRESS",
      started_at: null,
      completed_at: null,
    },
  ],
};

let services: ReadingServices;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_READING_WORD_CONFIDENCE_THRESHOLD", "0.8");
  mocks.recorder.callback = null;
  mocks.recorder.emitTailOnStop = false;
  mocks.recorder.start.mockReset().mockImplementation(async (callback) => {
    mocks.recorder.callback = callback;
  });
  mocks.recorder.stop.mockReset().mockImplementation(async () => {
    if (mocks.recorder.emitTailOnStop && mocks.recorder.callback) {
      mocks.recorder.emitTailOnStop = false;
      mocks.recorder.callback(
        new Blob([new Uint8Array(1_000)], { type: "audio/webm" }),
      );
    }
    return null;
  });
  mocks.recorder.cancel.mockReset();

  mocks.speech.transcribe
    .mockReset()
    .mockResolvedValueOnce({
      text: "Bé mây",
      language_code: "vi",
      language_probability: 0.99,
      words: [
        { text: "Bé", start: 0, end: 0.2, logprob: Math.log(0.97) },
        { text: "mây", start: 0.21, end: 0.4, logprob: Math.log(0.96) },
      ],
    })
    .mockResolvedValueOnce({
      text: "mèo",
      language_code: "vi",
      language_probability: 0.99,
      words: [
        { text: "mèo", start: 0, end: 0.3, logprob: Math.log(0.98) },
      ],
    });

  mocks.player.play.mockReset().mockResolvedValue(undefined);
  mocks.player.stop.mockReset();
  mocks.compareTranscript.mockReset().mockResolvedValue({
    distance: 1,
    alignment: [],
  });

  const readingService = {
    createEvent: vi.fn<ReadingServices["readingService"]["createEvent"]>().mockResolvedValue(undefined),
    create: vi.fn(),
    get: vi.fn().mockResolvedValue({
      ...sessionSummaryFixture,
      state: "PAGE_READY",
      ended_at: null,
      duration_ms: null,
    }),
    getCurrentPage: vi.fn().mockResolvedValue(pageFour),
    getPageProgress: vi.fn().mockResolvedValue(pageProgress),
    navigateToPage: vi.fn().mockResolvedValue(pageProgress),
    completeCurrentPage: vi.fn().mockResolvedValue(pageProgress),
    getCompletionSummary: vi.fn().mockResolvedValue({
      duration_minutes: 2,
      pages_explored: 1,
      selected_range_pages: 1,
      practiced_words: null,
      spoken_words: null,
      transcripts: null,
    }),
    finish: vi.fn().mockResolvedValue({
      ...sessionSummaryFixture,
      duration_ms: 120_000,
      ended_at: "2026-11-02T04:20:00.000Z",
    }),
  };

  services = {
    bookService: {
      get: vi.fn().mockResolvedValue(bookFixture),
      listPages: vi.fn().mockResolvedValue(previews),
    },
    childService: {
      get: vi.fn().mockResolvedValue(childFixture),
    },
    comprehensionService: {
      getQuestion: vi.fn(),
      submitAnswer: vi.fn(),
    },
    devicePermissionService: {
      getSnapshot: vi.fn().mockResolvedValue({ camera: "ready", microphone: "ready" }),
      retry: vi.fn(),
    },
    pageMatchService: {
      retryCurrentPage: vi.fn().mockResolvedValue(pageFour),
      selectPage: vi.fn().mockResolvedValue(pageFour),
    },
    readingService,
    readingSocketAdapter: {
      subscribe: vi.fn().mockReturnValue(vi.fn()),
      sendControl: vi.fn().mockResolvedValue("LISTENING"),
      reconnect: vi.fn().mockResolvedValue("recovered"),
      getSafetySnapshot: vi.fn().mockReturnValue({
        connection: "connected",
        scoring_active: false,
        evidence_valid: false,
        child_error_events: [],
      }),
    },
    tutorService: {
      requestReadExample: vi.fn(),
      retryReadExample: vi.fn(),
    },
  } as unknown as ReadingServices;
  mocks.services = services;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ReadingScreen session-end word review", () => {
  it(
    "keeps uncalibrated recognition uncertain, persists it as ignored-by-gate, and does not force a whole-range reread",
    async () => {
      vi.stubEnv("NEXT_PUBLIC_READING_WORD_CONFIDENCE_THRESHOLD", "");
      const readingService = services.readingService;
      render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );

      await screen.findByRole("navigation", { name: "Điều khiển buổi đọc" });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
        );
      });
      await act(async () => {
        mocks.recorder.callback?.(
          new Blob([new Uint8Array(1_000)], { type: "audio/webm" }),
        );
      });
      await screen.findByText("Bé mây");

      fireEvent.click(screen.getByRole("button", { name: "Xong" }));
      await screen.findByRole("dialog", { name: "Bé muốn nghỉ hôm nay?" });
      fireEvent.click(screen.getByRole("button", { name: "Lưu và dừng" }));

      expect(
        await screen.findByRole("heading", { name: "Bé đọc xong rồi!" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("main", { name: "Luyện lại từ sau khi đọc" }),
      ).not.toBeInTheDocument();
      expect(readingService.finish).toHaveBeenCalledOnce();
      expect(readingService.createEvent).toHaveBeenCalledTimes(2);
      for (const [event] of readingService.createEvent.mock.calls) {
        expect(event).toMatchObject({
          Type: "MISPRONUNCIATION",
          Status: "IGNORED_BY_GATE",
        });
      }

      fireEvent.click(screen.getByRole("button", { name: /2 từ/i }));
      expect(
        screen.getByRole("button", { name: "Nghe mẫu từ Bé" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Nghe mẫu từ mèo" }),
      ).toBeInTheDocument();
    },
    12_000,
  );

  it(
    "defers word review until finish, then persists the exact self-corrected occurrence before finishing",
    async () => {
      render(
        <ReadingScreen
          initialUiState="reading"
          reconnectMode="recover"
          sessionId={TEST_SESSION_ID}
        />,
      );

      await screen.findByRole("navigation", { name: "Điều khiển buổi đọc" });

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Dừng nhận diện giọng nói" }),
        );
      });
      expect(mocks.recorder.start).toHaveBeenCalledTimes(1);
      expect(mocks.recorder.callback).not.toBeNull();

      await act(async () => {
        mocks.recorder.callback?.(
          new Blob([new Uint8Array(1_000)], { type: "audio/webm" }),
        );
      });
      await screen.findByText("Bé mây");

      // PROMPT 2 must not interrupt the child when a page's first pass ends.
      expect(
        screen.queryByRole("main", { name: "Luyện lại từ sau khi đọc" }),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Xong" }));
      await screen.findByRole("dialog", { name: "Bé muốn nghỉ hôm nay?" });
      fireEvent.click(screen.getByRole("button", { name: "Lưu và dừng" }));

      expect(
        await screen.findByRole("main", { name: "Luyện lại từ sau khi đọc" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("review-target-word")).toHaveTextContent("mèo");
      expect(services.readingService.finish).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Bắt đầu đọc" }));
      await waitFor(() => expect(mocks.recorder.start).toHaveBeenCalledTimes(2));
      mocks.recorder.emitTailOnStop = true;

      await waitFor(
        () =>
          expect(services.readingService.finish).toHaveBeenCalledTimes(1),
        { timeout: 6_000 },
      );

      expect(mocks.speech.transcribe).toHaveBeenCalledTimes(2);
      expect(services.readingService.createEvent).toHaveBeenCalledTimes(2);
      expect(services.readingService.createEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          Type: "MISPRONUNCIATION",
          Status: "DETECTED",
          WordId: pageFour.words[1].word_id,
          PageRevisionId: pageFour.page_revision_id,
        }),
      );
      expect(services.readingService.createEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          Type: "SELF_CORRECTION",
          Status: "FEEDBACK_GIVEN",
          WordId: pageFour.words[1].word_id,
          PageRevisionId: pageFour.page_revision_id,
          Confidence: 0.98,
        }),
      );
      expect(
        await screen.findByRole("heading", { name: "Bé đọc xong rồi!" }),
      ).toBeInTheDocument();
    },
    12_000,
  );
});
