import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
import { InstantScanReadAlongPanel } from "@/components/reading/instant-scan-readalong-panel";
import type { SpeechPlayer } from "@/hooks/use-speech-player";
import type { SpeechRecorder } from "@/hooks/use-speech-recorder";
import type { SpeechService } from "@/lib/api/speech-service";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";
import { WithSelectedChild } from "@/test/fixtures/selected-child-test-provider";

const { pushMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
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

function makeSpeechPlayerMock(
  overrides: Partial<SpeechPlayer> = {},
): SpeechPlayer {
  return {
    isPlaying: false,
    isPaused: false,
    state: "idle",
    fallbackNotice: null,
    play: vi.fn().mockResolvedValue(undefined),
    playPhonicsLesson: vi.fn().mockResolvedValue(undefined),
    playWithWordTimings: vi.fn().mockImplementation(async (_words, options) => {
      options.onWordChange?.(0);
      options.onEnded?.();
    }),
    pause: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    ...overrides,
  };
}

function makeSpeechRecorderMock(): {
  recorder: SpeechRecorder;
  setRecordingState: (recording: boolean) => void;
} {
  let recording = false;
  const recorder: SpeechRecorder = {
    get isRecording() {
      return recording;
    },
    isSpeaking: false,
    audioLevel: 0,
    prepare: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockImplementation(async () => {
      recording = true;
    }),
    stop: vi.fn().mockImplementation(async () => {
      recording = false;
      return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
    }),
    cancel: vi.fn().mockImplementation(() => {
      recording = false;
    }),
    getStream: () => null,
    getIsSpeaking: () => false,
  };
  return {
    recorder,
    setRecordingState: (next) => {
      recording = next;
    },
  };
}

function makePageFile(name = "trang-chup.png", type = "image/png") {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, {
    type,
  });
}

const unmatchedOcrPayload = {
  scan_job_id: "11111111-2222-4333-8444-555555555555",
  request_id: "req-unmatched-001",
  idempotency_key: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  status: "SUCCEEDED" as const,
  ocr_text: "Con mèo nhỏ ngồi bên cửa sổ.\nTrời mùa thu mát mẻ.",
  word_count: 12,
  words: [
    {
      word_index: 0,
      line_index: 0,
      text: "Con",
      normalized_text: "con",
      bbox: [0.1, 0.1, 0.1, 0.05] as [number, number, number, number],
      ocr_confidence: 0.96,
    },
    {
      word_index: 1,
      line_index: 0,
      text: "mèo",
      normalized_text: "mèo",
      bbox: [0.22, 0.1, 0.12, 0.05] as [number, number, number, number],
      ocr_confidence: 0.95,
    },
  ],
  provenance: {
    engine: "paddleocr_vietocr_dual",
    device: "cuda" as const,
    engine_statuses: { paddleocr: "success", vietocr: "success" },
    model_profile: "FLOW1_EXTERNAL_TRDG",
    checkpoint_sha256: null,
    model_load_status: "loaded",
    cloud_ocr_used: false,
    elapsed_ms: 1850,
  },
  matched: false,
  matched_book_id: null,
  matched_book_title: null,
  match_confidence: 0.18,
  matched_page: null,
  message:
    "Đã nhận diện tiếng Việt trên trang sách. Trang này chưa có sẵn trong thư viện chung.",
};

beforeEach(() => {
  installApiFetchFixture();
  pushMock.mockReset();
  replaceMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InstantScanReadAlongPanel", () => {
  it("plays AI model reading with private cache scope and opens PhonicsLessonCard when any word is tapped", async () => {
    const user = userEvent.setup();
    const playerMock = makeSpeechPlayerMock();
    const { recorder } = makeSpeechRecorderMock();
    const speechServiceMock: SpeechService = {
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    };

    render(
      <InstantScanReadAlongPanel
        child={childFixture}
        ocrText="Mèo con đi học."
        speechPlayerOverride={playerMock}
        speechRecorderOverride={recorder}
        speechServiceOverride={speechServiceMock}
      />,
    );

    // 1. Whole-passage AI model reading
    await user.click(screen.getByTestId("instant-scan-listen-ai-btn"));
    expect(playerMock.playWithWordTimings).toHaveBeenCalledTimes(1);
    const [wordList, timedOpts] = (
      playerMock.playWithWordTimings as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(wordList).toEqual(["Mèo", "con", "đi", "học."]);
    expect(timedOpts).toMatchObject({
      text: "Mèo con đi học.",
      isPrivateBook: true,
      cacheScope: "PRIVATE",
      bypassSessionLock: true,
    });

    // 2. Tap word "học." -> opens Vietnamese PhonicsLessonCard
    await user.click(screen.getByTestId("instant-scan-word-3"));
    const phonicsCard = await screen.findByTestId("phonics-lesson-card");
    expect(phonicsCard).toBeInTheDocument();
    expect(screen.getByTestId("phonics-focus-syllable")).toHaveTextContent(
      "học",
    );

    // Play single word sample & step-by-step phonics from card
    await user.click(screen.getByRole("button", { name: /Nghe từ/i }));
    expect(playerMock.play).toHaveBeenCalledWith(
      "học.",
      expect.objectContaining({
        wordSample: true,
        isPrivateBook: true,
        cacheScope: "PRIVATE",
      }),
    );

    await user.click(screen.getByRole("button", { name: /Nghe đánh vần/i }));
    expect(playerMock.playPhonicsLesson).toHaveBeenCalledTimes(1);
  });

  it("records child voice, aligns spoken words via RealtimeAlignmentEngine, and highlights matched vs practice words", async () => {
    const user = userEvent.setup();
    const playerMock = makeSpeechPlayerMock();
    const { recorder } = makeSpeechRecorderMock();
    const speechServiceMock: SpeechService = {
      synthesize: vi.fn(),
      transcribe: vi.fn().mockResolvedValue({
        text: "Mèo con đi ngủ",
        language_code: "vi",
        language_probability: 0.98,
        words: null,
      }),
    };

    const { rerender } = render(
      <InstantScanReadAlongPanel
        ocrText="Mèo con đi học"
        speechPlayerOverride={playerMock}
        speechRecorderOverride={recorder}
        speechServiceOverride={speechServiceMock}
      />,
    );

    await user.click(screen.getByTestId("instant-scan-mic-start-btn"));
    expect(recorder.start).toHaveBeenCalledTimes(1);

    // Rerender so component observes mock getter recorder.isRecording === true
    rerender(
      <InstantScanReadAlongPanel
        ocrText="Mèo con đi học"
        speechPlayerOverride={playerMock}
        speechRecorderOverride={recorder}
        speechServiceOverride={speechServiceMock}
      />,
    );

    await user.click(screen.getByTestId("instant-scan-mic-stop-btn"));
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(speechServiceMock.transcribe).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(
        screen.getByTestId("instant-scan-alignment-summary"),
      ).toHaveTextContent("Đã đọc khớp 3/4 từ (75%)");
    });

    expect(screen.getByTestId("instant-scan-word-0")).toHaveAttribute(
      "data-word-status",
      "matched",
    );
    expect(screen.getByTestId("instant-scan-word-1")).toHaveAttribute(
      "data-word-status",
      "matched",
    );
    expect(screen.getByTestId("instant-scan-word-2")).toHaveAttribute(
      "data-word-status",
      "matched",
    );
    expect(screen.getByTestId("instant-scan-word-3")).toHaveAttribute(
      "data-word-status",
      "needs-practice",
    );

    // Reset alignment
    await user.click(screen.getByTestId("instant-scan-reset-alignment-btn"));
    expect(
      screen.queryByTestId("instant-scan-alignment-summary"),
    ).not.toBeInTheDocument();
  });
});

describe("BookScannerScreen unmatched instant Read-Along & 1-tap private save integration", () => {
  it("enables inline OCR quick-edit, opens InstantScanReadAlongPanel, and saves 1-tap to Sách của tôi without re-uploading image", async () => {
    const user = userEvent.setup();
    const savedBookId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const savedPageId = "cccccccc-dddd-4eee-8fff-111111111111";
    let capturedSaveForm: FormData | null = null;

    apiFetchFixture.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr/jobs" && init?.method === "POST") {
        return Response.json(
          {
            job_id: unmatchedOcrPayload.scan_job_id,
            status: "SUCCEEDED",
            worker_online: true,
            created_at: "2026-11-28T07:00:00Z",
            updated_at: "2026-11-28T07:00:02Z",
            error_code: null,
            error_message: null,
            result: unmatchedOcrPayload,
          },
          { status: 202 },
        );
      }
      if (path === "/reading/scan-page-ocr/jobs" && init?.method === "GET") {
        return Response.json({ worker_online: true, jobs: [] });
      }
      if (
        path === "/books/my-books" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json([
          {
            id: "99999999-1111-4222-8333-444444444444",
            title: "Sách Tiếng Việt Ở Nhà",
            author: null,
            min_grade: 2,
            max_grade: 2,
            lifecycle_status: "ACTIVE",
            visibility_scope: "PARENT_PRIVATE",
            moderation_status: "ACTIVE",
            suspended_reason: null,
            source_declaration: "[OWNED_PHYSICAL_BOOK]",
            committed_page_count: 3,
            pending_submission_count: 0,
            flagged_submission_count: 0,
            failed_submission_count: 0,
            ready_to_add_count: 0,
            readable_for_children: true,
            has_held_multipage_batch: false,
            privacy_notice: "Riêng tư",
            created_at: "2026-11-27T10:00:00Z",
          },
        ]);
      }
      if (path === "/books/my-books/from-scan" && init?.method === "POST") {
        capturedSaveForm = init.body as FormData;
        return Response.json(
          {
            book_id: savedBookId,
            page_id: savedPageId,
            page_number: 1,
            revision_id: "22222222-3333-4444-8555-666666666666",
            title: String(capturedSaveForm.get("title") || "Con mèo nhỏ"),
            visibility_scope: "PARENT_PRIVATE",
            reader_href: `/books/${savedBookId}?pageId=${savedPageId}`,
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookScannerScreen />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    await screen.findByRole("button", { name: /Chọn ảnh trang sách/i });
    const fileInput = screen.getByTestId(
      "local-ocr-file-input",
    ) as HTMLInputElement;
    await user.upload(fileInput, makePageFile("trang-sach-meo.png"));

    // Calm notice + both new primary/secondary CTAs appear for unmatched scan
    expect(
      await screen.findByTestId("scanner-auto-ocr-calm-notice"),
    ).toBeInTheDocument();
    const readNowBtn = screen.getByTestId("instant-scan-readalong-cta");
    const saveBtn = screen.getByTestId("save-scan-to-my-books-cta");
    expect(readNowBtn).toHaveTextContent("Đọc ngay cùng AI");
    expect(saveBtn).toHaveTextContent("Lưu vào Sách của tôi");

    // Inline quick-edit OCR diacritic fix before reading/saving
    await user.click(screen.getByTestId("scanner-quick-edit-ocr-btn"));
    const textarea = screen.getByTestId(
      "scanner-inline-ocr-textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: "Chú mèo nhỏ ngồi bên cửa sổ.\nTrời mùa thu mát lành.",
      },
    });
    await user.click(screen.getByTestId("scanner-quick-edit-ocr-btn"));
    expect(screen.getByTestId("local-ocr-text")).toHaveTextContent(
      "Chú mèo nhỏ ngồi bên cửa sổ.",
    );

    // Click "Đọc ngay cùng AI" -> opens InstantScanReadAlongPanel with edited words
    await user.click(readNowBtn);
    expect(
      await screen.findByTestId("instant-scan-readalong-panel"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("instant-scan-word-0")).toHaveTextContent("Chú");

    // Click "Lưu vào Sách của tôi" -> opens modal with pre-filled title & attached file (no 2nd upload!)
    await user.click(saveBtn);
    const modal = await screen.findByTestId("save-scan-to-my-books-modal");
    expect(modal).toBeInTheDocument();
    expect(
      screen.getByTestId("save-scan-attached-file-chip"),
    ).toHaveTextContent("trang-sach-meo.png");

    const titleInput = screen.getByTestId(
      "save-scan-title-input",
    ) as HTMLInputElement;
    expect(titleInput.value).toBe("Chú mèo nhỏ ngồi bên cửa sổ");
    fireEvent.change(titleInput, {
      target: { value: "Truyện Chú Mèo Bên Cửa Sổ" },
    });

    await user.click(screen.getByTestId("save-scan-submit-btn"));

    const openSavedLink = await screen.findByTestId(
      "open-saved-scan-book-link",
    );
    expect(openSavedLink).toHaveAttribute(
      "href",
      `/books/${savedBookId}?pageId=${savedPageId}`,
    );

    expect(capturedSaveForm).not.toBeNull();
    expect(capturedSaveForm!.get("mode")).toBe("create_book");
    expect(capturedSaveForm!.get("title")).toBe("Truyện Chú Mèo Bên Cửa Sổ");
    expect(capturedSaveForm!.get("ocr_text")).toBe(
      "Chú mèo nhỏ ngồi bên cửa sổ.\nTrời mùa thu mát lành.",
    );
    expect(capturedSaveForm!.get("image")).toBeInstanceOf(File);
  });

  it("supports appending a scanned page to an existing book in Sách của tôi", async () => {
    const user = userEvent.setup();
    const existingBookId = "99999999-1111-4222-8333-444444444444";
    const appendedPageId = "dddddddd-eeee-4fff-8000-222222222222";
    let capturedAppendForm: FormData | null = null;

    apiFetchFixture.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === `/profiles/children/${TEST_CHILD_ID}`) {
        return Response.json(childFixture);
      }
      if (path === "/reading/scan-page-ocr/jobs" && init?.method === "POST") {
        return Response.json(
          {
            job_id: unmatchedOcrPayload.scan_job_id,
            status: "SUCCEEDED",
            worker_online: true,
            created_at: "2026-11-28T07:00:00Z",
            updated_at: "2026-11-28T07:00:02Z",
            error_code: null,
            error_message: null,
            result: unmatchedOcrPayload,
          },
          { status: 202 },
        );
      }
      if (path === "/reading/scan-page-ocr/jobs" && init?.method === "GET") {
        return Response.json({ worker_online: true, jobs: [] });
      }
      if (path === "/books/my-books") {
        return Response.json([
          {
            id: existingBookId,
            title: "Sách Đọc Thêm Lớp 2",
            author: null,
            min_grade: 2,
            max_grade: 2,
            lifecycle_status: "ACTIVE",
            visibility_scope: "PARENT_PRIVATE",
            moderation_status: "ACTIVE",
            suspended_reason: null,
            source_declaration: "[OWNED_PHYSICAL_BOOK]",
            committed_page_count: 4,
            pending_submission_count: 0,
            flagged_submission_count: 0,
            failed_submission_count: 0,
            ready_to_add_count: 0,
            readable_for_children: true,
            has_held_multipage_batch: false,
            privacy_notice: "Riêng tư",
            created_at: "2026-11-27T10:00:00Z",
          },
        ]);
      }
      if (path === "/books/my-books/from-scan" && init?.method === "POST") {
        capturedAppendForm = init.body as FormData;
        return Response.json(
          {
            book_id: existingBookId,
            page_id: appendedPageId,
            page_number: 5,
            revision_id: "33333333-4444-4555-8666-777777777777",
            title: "Sách Đọc Thêm Lớp 2",
            visibility_scope: "PARENT_PRIVATE",
            reader_href: `/books/${existingBookId}?pageId=${appendedPageId}`,
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <WithSelectedChild childId={TEST_CHILD_ID}>
        <AppServicesProvider>
          <BookScannerScreen />
        </AppServicesProvider>
      </WithSelectedChild>,
    );

    await screen.findByRole("button", { name: /Chọn ảnh trang sách/i });
    await user.upload(
      screen.getByTestId("local-ocr-file-input"),
      makePageFile("trang-5.png"),
    );

    await user.click(await screen.findByTestId("save-scan-to-my-books-cta"));
    await screen.findByTestId("save-scan-to-my-books-modal");

    await user.click(screen.getByTestId("save-scan-mode-append"));
    const select = await screen.findByTestId("save-scan-target-book-select");
    expect(select).toHaveValue(existingBookId);

    await user.click(screen.getByTestId("save-scan-submit-btn"));

    const openLink = await screen.findByTestId("open-saved-scan-book-link");
    expect(openLink).toHaveAttribute(
      "href",
      `/books/${existingBookId}?pageId=${appendedPageId}`,
    );
    expect(openLink).toHaveTextContent("Mở Trang 5 để đọc ngay");
    expect(capturedAppendForm!.get("mode")).toBe("append_page");
    expect(capturedAppendForm!.get("target_book_id")).toBe(existingBookId);
  });
});
