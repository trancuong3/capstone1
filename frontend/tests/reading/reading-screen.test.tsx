import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadingScreen } from "@/components/reading/reading-screen";
import { ServiceError } from "@/lib/api/service-error";
import type { ReadingServices } from "@/hooks/use-reading-services";
import {
  bookFixture,
  childFixture,
  sessionSummaryFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type { ReadingUiState } from "@/types/reading";
import type {
  ReadingPageDTO,
  ReadingSessionPageProgressDTO,
  TutorAction,
} from "@/types/reading";
const TEST_QUESTION_ID = "80000000-0000-4000-8000-000000000001";

interface TestMicrophoneTrack {
  stop: () => void;
  readonly readyState: MediaStreamTrackState;
}

class TestMediaRecorder extends EventTarget {
  static isTypeSupported = vi.fn(() => true);

  readonly stream: MediaStream;
  readonly mimeType: string;
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "audio/webm";
    testRecorderInstances.push(this);
  }

  start(): void {
    if (this.state !== "inactive") {
      throw new Error("The test recorder is already active.");
    }
    this.state = "recording";
    queueMicrotask(() => {
      if (this.state === "recording") this.emitDataAvailable();
    });
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.emitDataAvailable();
    const event = new Event("stop");
    this.onstop?.(event);
    this.dispatchEvent(event);
  }

  dispose(): void {
    this.state = "inactive";
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }

  private emitDataAvailable(): void {
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", {
      value: new Blob([], { type: this.mimeType }),
    });
    this.ondataavailable?.(event);
    this.dispatchEvent(event);
  }
}

const testRecorderInstances: TestMediaRecorder[] = [];
const testMicrophoneTracks: TestMicrophoneTrack[] = [];
let getUserMediaMock: ReturnType<typeof vi.fn>;
let originalMediaRecorderDescriptor: PropertyDescriptor | undefined;
let originalMediaDevicesDescriptor: PropertyDescriptor | undefined;

function createTestMicrophoneStream(): MediaStream {
  let stopped = false;
  const track: TestMicrophoneTrack = {
    stop: vi.fn(() => {
      stopped = true;
    }),
    get readyState(): MediaStreamTrackState {
      return stopped ? "ended" : "live";
    },
  };
  testMicrophoneTracks.push(track);
  return {
    getTracks: () => [track],
    get active() {
      return !stopped;
    },
  } as unknown as MediaStream;
}

function installRecordingTestEnvironment(): void {
  testRecorderInstances.length = 0;
  testMicrophoneTracks.length = 0;
  originalMediaRecorderDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "MediaRecorder",
  );
  originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices",
  );
  getUserMediaMock = vi.fn(async () => createTestMicrophoneStream());

  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    writable: true,
    value: TestMediaRecorder,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: getUserMediaMock } as unknown as MediaDevices,
  });
}

function cleanupRecordingTestEnvironment(): void {
  for (const recorder of testRecorderInstances) recorder.dispose();
  for (const track of testMicrophoneTracks) {
    if (track.readyState !== "ended") track.stop();
  }

  if (originalMediaRecorderDescriptor) {
    Object.defineProperty(
      globalThis,
      "MediaRecorder",
      originalMediaRecorderDescriptor,
    );
  } else {
    Reflect.deleteProperty(globalThis, "MediaRecorder");
  }
  if (originalMediaDevicesDescriptor) {
    Object.defineProperty(
      navigator,
      "mediaDevices",
      originalMediaDevicesDescriptor,
    );
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
}


const { servicesHook } = vi.hoisted(() => ({
  servicesHook: vi.fn<() => ReadingServices>(),
}));
vi.mock("@/hooks/use-reading-services", () => ({
  useReadingServices: servicesHook,
}));

// Typed, test-local responses only. The application provider still uses
// unavailable Reading/AI services; these fixtures exercise existing UI handlers.
const pageFour: ReadingPageDTO = {
  page_id: "30000000-0000-4000-8000-000000000014",
  page_revision_id: "40000000-0000-4000-8000-000000000014",
  page_number: 4,
  confidence: 0.95,
  width: 600,
  height: 800,
  words: ["Bé", "mèo", "nhỏ", "đang"].map((text, index) => ({
    word_id: `50000000-0000-4000-8000-00000000040${index}`,
    word_index: index,
    text,
    bbox: [0.1 + index * 0.15, 0.2, 0.1, 0.05] as const,
  })),
};
const pageFive: ReadingPageDTO = {
  ...pageFour,
  page_id: "30000000-0000-4000-8000-000000000015",
  page_revision_id: "40000000-0000-4000-8000-000000000015",
  page_number: 5,
  words: pageFour.words.map((word, index) => ({
    ...word,
    word_id: `50000000-0000-4000-8000-00000000050${index}`,
  })),
};
const previews = [pageFour, pageFive].map((page) => ({
  page_id: page.page_id,
  page_number: page.page_number,
  lifecycle_status: "ACTIVE" as const,
  current_verified_revision_id: page.page_revision_id,
  preview_url: "https://example.com/test-page.png",
}));
const pageProgressFixture: ReadingSessionPageProgressDTO = {
  session_id: TEST_SESSION_ID,
  persisted: true,
  start_page_id: pageFour.page_id,
  end_page_id: pageFive.page_id,
  current_page_id: pageFour.page_id,
  start_page_number: pageFour.page_number,
  end_page_number: pageFive.page_number,
  current_page_number: pageFour.page_number,
  current_index: 0,
  total_pages: 2,
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
    {
      page_id: pageFive.page_id,
      page_revision_id: pageFive.page_revision_id,
      page_number: pageFive.page_number,
      page_order: 1,
      status: "PENDING",
      started_at: null,
      completed_at: null,
    },
  ],
};
const tutorAction: TutorAction = {
  action: "READ_EXAMPLE",
  action_id: "70000000-0000-4000-8000-000000000001",
  page_revision_word_id: pageFour.words[0].word_id,
  tts_text: "Bé",
};
function createReadingFixtures() {
  return {
    bookService: {
      list: vi
        .fn<ReadingServices["bookService"]["list"]>()
        .mockResolvedValue([bookFixture]),
      get: vi
        .fn<ReadingServices["bookService"]["get"]>()
        .mockResolvedValue(bookFixture),
      listPages: vi
        .fn<ReadingServices["bookService"]["listPages"]>()
        .mockResolvedValue(previews),
    },
    childService: {
      list: vi
        .fn<ReadingServices["childService"]["list"]>()
        .mockResolvedValue([childFixture]),
      get: vi
        .fn<ReadingServices["childService"]["get"]>()
        .mockResolvedValue(childFixture),
      create: vi
        .fn<ReadingServices["childService"]["create"]>()
        .mockRejectedValue(new Error("Unused test write")),
      update: vi
        .fn<ReadingServices["childService"]["update"]>()
        .mockRejectedValue(new Error("Unused test write")),
      delete: vi
        .fn<ReadingServices["childService"]["delete"]>()
        .mockRejectedValue(new Error("Unused test write")),
    },
    comprehensionService: {
      getQuestion: vi
        .fn<ReadingServices["comprehensionService"]["getQuestion"]>()
        .mockResolvedValue({
          question: {
            id: TEST_QUESTION_ID,
            type: "FACTUAL",
            prompt: "Bé mèo nằm ở đâu?",
            page_revision_id: pageFour.page_revision_id,
            source_span: {
              start_word_index: 0,
              end_word_index_exclusive: 4,
              sentence_index: 0,
            },
            difficulty: 1,
            answered: false,
          },
          progress_label: "Câu 1",
          choices: [
            { id: "A", label: "Trên bàn", value: "Trên bàn" },
            { id: "B", label: "Bên cửa sổ", value: "Bên cửa sổ" },
          ],
        }),
      submitAnswer: vi
        .fn<ReadingServices["comprehensionService"]["submitAnswer"]>()
        .mockRejectedValue(
          new Error("Configure the answer response in its test"),
        ),
    },
    devicePermissionService: {
      getSnapshot: vi
        .fn<ReadingServices["devicePermissionService"]["getSnapshot"]>()
        .mockResolvedValue({ camera: "ready", microphone: "ready" }),
      retry: vi
        .fn<ReadingServices["devicePermissionService"]["retry"]>()
        .mockResolvedValue("ready"),
    },
    pageMatchService: {
      retryCurrentPage: vi
        .fn<ReadingServices["pageMatchService"]["retryCurrentPage"]>()
        .mockResolvedValue(pageFour),
      selectPage: vi
        .fn<ReadingServices["pageMatchService"]["selectPage"]>()
        .mockResolvedValue(pageFive),
    },
    readingService: {
      create: vi
        .fn<ReadingServices["readingService"]["create"]>()
        .mockRejectedValue(new Error("Unused test write")),
      get: vi.fn<ReadingServices["readingService"]["get"]>().mockResolvedValue({
        ...sessionSummaryFixture,
        state: "PAGE_READY",
        ended_at: null,
        duration_ms: null,
      }),
      getCurrentPage: vi
        .fn<ReadingServices["readingService"]["getCurrentPage"]>()
        .mockResolvedValue(pageFour),
      getPageProgress: vi
        .fn<ReadingServices["readingService"]["getPageProgress"]>()
        .mockResolvedValue(pageProgressFixture),
      navigateToPage: vi
        .fn<ReadingServices["readingService"]["navigateToPage"]>()
        .mockResolvedValue(pageProgressFixture),
      completeCurrentPage: vi
        .fn<ReadingServices["readingService"]["completeCurrentPage"]>()
        .mockResolvedValue({
          ...pageProgressFixture,
          completed_pages: 1,
          pages: [
            {
              ...pageProgressFixture.pages[0],
              status: "COMPLETED",
              completed_at: "2026-10-21T07:00:00Z",
            },
            pageProgressFixture.pages[1],
          ],
        }),
      getCompletionSummary: vi
        .fn<ReadingServices["readingService"]["getCompletionSummary"]>()
        .mockResolvedValue({
          duration_minutes: 8,
          pages_explored: 2,
          practiced_words: 0,
        }),
      finish: vi
        .fn<ReadingServices["readingService"]["finish"]>()
        .mockResolvedValue(sessionSummaryFixture),
      createEvent: vi
        .fn<
          NonNullable<ReadingServices["readingService"]["createEvent"]>
        >()
        .mockResolvedValue({
          id: "91000000-0000-4000-8000-000000000001",
          session_id: TEST_SESSION_ID,
          page_id: pageFour.page_id,
          page_revision_id: pageFour.page_revision_id,
          page_revision_word_id: pageFour.words[0].word_id,
          type: "SUBSTITUTION",
          start_ms: 100,
          end_ms: null,
          confidence: 0.9,
          status: "CONFIRMED",
          metadata: {},
        }),
    },
    readingSocketAdapter: {
      subscribe: vi
        .fn<ReadingServices["readingSocketAdapter"]["subscribe"]>()
        .mockReturnValue(vi.fn()),
      sendControl: vi
        .fn<ReadingServices["readingSocketAdapter"]["sendControl"]>()
        .mockResolvedValue("LISTENING"),
      reconnect: vi
        .fn<ReadingServices["readingSocketAdapter"]["reconnect"]>()
        .mockResolvedValue("recovered"),
      getSafetySnapshot: vi
        .fn<ReadingServices["readingSocketAdapter"]["getSafetySnapshot"]>()
        .mockReturnValue({
          connection: "connected",
          scoring_active: false,
          evidence_valid: false,
          child_error_events: [],
        }),
    },
    tutorService: {
      requestReadExample: vi
        .fn<ReadingServices["tutorService"]["requestReadExample"]>()
        .mockResolvedValue(tutorAction),
      retryReadExample: vi
        .fn<ReadingServices["tutorService"]["retryReadExample"]>()
        .mockResolvedValue(tutorAction),
    },
  } satisfies ReadingServices;
}

let services: ReturnType<typeof createReadingFixtures>;
beforeEach(() => {
  installRecordingTestEnvironment();
  services = createReadingFixtures();
  servicesHook.mockReset().mockReturnValue(services);
});
afterEach(cleanupRecordingTestEnvironment);
function renderReading(
  state: ReadingUiState,
  requestedSessionId = TEST_SESSION_ID,
) {
  return render(
    <ReadingScreen
      initialUiState={state}
      reconnectMode="recover"
      sessionId={requestedSessionId}
    />,
  );
}

describe("ReadingScreen presentation with typed test-local service responses", () => {
  it("starts the listening UI only after the control service resolves", async () => {
    const user = userEvent.setup();
    renderReading("ready");
    expect(
      await screen.findAllByRole("heading", { name: "Sẵn sàng đọc chưa nào?" }),
    ).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Bắt đầu đọc" }));
    expect(
      await screen.findByRole("navigation", { name: "Điều khiển buổi đọc" }),
    ).toBeInTheDocument();
    expect(services.readingSocketAdapter.sendControl).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      "start",
    );
    expect(
      screen.queryByText("Mình đang nghe bé đọc. Con cứ đọc tiếp nhé."),
    ).not.toBeInTheDocument();
    await waitFor(
      () => {
        expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
        expect(testRecorderInstances[0]?.state).toBe("recording");
      },
      { timeout: 5000 },
    );
    expect(
      await screen.findByText("Mình đang nghe bé đọc. Con cứ đọc tiếp nhé."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Trạng thái kết nối: đã kết nối\./),
    ).toBeInTheDocument();
  }, 8000);

  it("shows the selected range and navigates only to a saved next page", async () => {
    const user = userEvent.setup();
    renderReading("reading");

    expect(
      await screen.findByText(/Phạm vi đọc: Trang 4–5/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trang trước" })).toBeDisabled();
    const nextButton = screen.getByRole("button", { name: "Trang tiếp theo" });
    expect(nextButton).toBeEnabled();

    await user.click(nextButton);

    await waitFor(() => {
      expect(services.readingService.navigateToPage).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        pageFive.page_id,
      );
    });
  });

  it("lets the child explicitly confirm the current page completion", async () => {
    const user = userEvent.setup();
    services.readingService.getCurrentPage.mockResolvedValue(pageFive);
    services.readingService.getPageProgress.mockResolvedValue({
      ...pageProgressFixture,
      current_page_id: pageFive.page_id,
      current_page_number: pageFive.page_number,
      current_index: 1,
      pages: [
        {
          ...pageProgressFixture.pages[0],
          status: "COMPLETED",
          completed_at: "2026-10-21T07:00:00Z",
        },
        {
          ...pageProgressFixture.pages[1],
          status: "IN_PROGRESS",
          started_at: "2026-10-21T07:00:00Z",
        },
      ],
      completed_pages: 1,
    });
    renderReading("reading");

    const completePageButton = await screen.findByRole("button", {
      name: "Đánh dấu trang đã đọc xong",
    });
    await user.click(completePageButton);

    await waitFor(() => {
      expect(services.readingService.completeCurrentPage).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        pageFive.page_id,
      );
    });
  });

  it("displays supplied paused/reconnecting safety status without adding evidence", async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderReading("paused");
    expect(
      await screen.findByRole("dialog", { name: "Bé đang nghỉ một chút" }),
    ).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute(
      "data-child-error-count",
      "0",
    );
    expect(container.firstElementChild).toHaveAttribute(
      "data-scoring-active",
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Đọc tiếp" }));
    expect(
      await screen.findByText("Mình đang nghe bé đọc. Con cứ đọc tiếp nhé."),
    ).toBeInTheDocument();
    expect(services.readingSocketAdapter.sendControl).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      "resume",
    );
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
    expect(testRecorderInstances[0]?.state).toBe("recording");
    unmount();
    expect(testRecorderInstances[0]?.state).toBe("inactive");
    expect(
      testMicrophoneTracks.every((track) => track.readyState === "ended"),
    ).toBe(true);
    renderReading("reconnecting");
    expect(
      await screen.findByRole("dialog", { name: "Đợi mình một chút nhé…" }),
    ).toHaveTextContent("không tạo lỗi đọc");
  });

  it("shows permission recovery and forwards the requested device", async () => {
    const user = userEvent.setup();
    renderReading("camera-denied");
    expect(
      await screen.findByRole("dialog", { name: "Camera chưa sẵn sàng" }),
    ).toHaveTextContent("camera chưa được mở");
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(
      await screen.findByText("Mình đang nghe bé đọc. Con cứ đọc tiếp nhé."),
    ).toBeInTheDocument();
    expect(services.devicePermissionService.retry).toHaveBeenCalledWith(
      "camera",
    );
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
    expect(testRecorderInstances[0]?.state).toBe("recording");
  });

  it("does not claim active recording or persist pronunciation evidence when MediaRecorder is unsupported", async () => {
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const user = userEvent.setup();
    const { container } = renderReading("microphone-denied");

    await screen.findByRole("dialog", {
      name: "Mình chưa nghe thấy giọng bé",
    });
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    await waitFor(() => {
      expect(services.devicePermissionService.retry).toHaveBeenCalledWith(
        "microphone",
      );
    });
    const recoveryDialog = screen.getByRole("dialog", {
      name: "Mình chưa nghe thấy giọng bé",
    });

    expect(recoveryDialog).toHaveTextContent(
      "Hệ thống đang ngừng nghe và không kết luận bé đọc sai.",
    );
    expect(services.devicePermissionService.retry).toHaveBeenCalledWith(
      "microphone",
    );
    expect(getUserMediaMock).not.toHaveBeenCalled();
    expect(testRecorderInstances).toHaveLength(0);
    expect(services.readingService.createEvent).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Mình đang nghe bé đọc. Con cứ đọc tiếp nhé."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Bé đang đọc")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute(
      "data-evidence-valid",
      "false",
    );
    expect(container.firstElementChild).toHaveAttribute(
      "data-child-error-count",
      "0",
    );
    expect(container.firstElementChild).toHaveAttribute(
      "data-scoring-active",
      "false",
    );
  });

  it("offers safe-exit confirmation without immediately finishing the session", async () => {
    const user = userEvent.setup();
    renderReading("microphone-denied");
    await screen.findByRole("dialog", { name: "Mình chưa nghe thấy giọng bé" });
    await user.click(screen.getByRole("button", { name: "Kết thúc an toàn" }));
    expect(
      screen.getByRole("dialog", { name: "Bé muốn nghỉ hôm nay?" }),
    ).toBeInTheDocument();
    expect(services.readingService.finish).not.toHaveBeenCalled();
  });

  it("binds manual page selection to the revision returned by the service", async () => {
    const user = userEvent.setup();
    renderReading("manual-page");
    await screen.findByRole("dialog", { name: "Bé đang đọc trang nào?" });
    await user.click(screen.getByRole("button", { name: "Chọn trang 5" }));
    await user.click(screen.getByRole("button", { name: "Đúng trang này" }));
    expect(await screen.findByLabelText("Trang sách 5")).toHaveAttribute(
      "data-page-revision-id",
      pageFive.page_revision_id,
    );
    expect(services.pageMatchService.selectPage).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      pageFive.page_id,
    );
  });

  it("rebinds the highlighted word to the new immutable page revision", async () => {
    renderReading("page-turn");
    const page = await screen.findByLabelText("Trang sách 5");
    await waitFor(() =>
      expect(page).toHaveAttribute(
        "data-page-revision-id",
        pageFive.page_revision_id,
      ),
    );
    expect(page.querySelector('[data-word-id$="000000000503"]')).toBeTruthy();
    expect(page.querySelector('[data-word-id$="000000000403"]')).toBeNull();
  });

  it("displays question results from service responses without exposing an expected answer", async () => {
    const result = {
      answer_id: "90000000-0000-4000-8000-000000000001",
      question_id: TEST_QUESTION_ID,
      submitted_answer: "Trên bàn",
      is_correct: false,
      score: 0,
      feedback_code: null,
    };
    services.comprehensionService.submitAnswer
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce({
        ...result,
        submitted_answer: "Bên cửa sổ",
        is_correct: true,
        score: 1,
      });
    const user = userEvent.setup();
    renderReading("question");
    await screen.findByRole("heading", { name: "Mình cùng trả lời nhé!" });
    expect(document.body.textContent).not.toContain("expected_answer");
    await user.click(await screen.findByRole("button", { name: /Trên bàn/ }));
    expect(
      await screen.findByText("Gần đúng rồi, thử lại nhé."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Bên cửa sổ/ }));
    expect(
      await screen.findByText("Đúng rồi! Bé nhớ rất tốt."),
    ).toBeInTheDocument();
    expect(services.comprehensionService.submitAnswer).toHaveBeenLastCalledWith(
      TEST_SESSION_ID,
      TEST_QUESTION_ID,
      "Bên cửa sổ",
    );
  });

  it("renders safe not-found when the service rejects an inaccessible session", async () => {
    services.readingService.get.mockRejectedValueOnce(
      new ServiceError({
        code: "RESOURCE_NOT_FOUND",
        status: 404,
        message: "Private session details",
        request_id: "test",
        retryable: false,
      }),
    );
    renderReading("ready", "ffffffff-ffff-4fff-8fff-ffffffffffff");
    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy buổi đọc" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/không tồn tại hoặc không thuộc tài khoản hiện tại/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Private session details"),
    ).not.toBeInTheDocument();
    expect(services.readingService.getCurrentPage).not.toHaveBeenCalled();
  });

  it("shows a retryable error instead of a fabricated session for an unavailable service", async () => {
    services.readingService.get.mockRejectedValueOnce(
      new Error("ReadingService is not implemented yet."),
    );
    renderReading("ready");
    expect(
      await screen.findByRole("heading", { name: "Chưa mở được buổi đọc" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Về thư viện" })).toHaveAttribute(
      "href",
      "/books",
    );
    expect(
      screen.queryByText("ReadingService is not implemented yet."),
    ).not.toBeInTheDocument();
    expect(services.readingSocketAdapter.subscribe).not.toHaveBeenCalled();
  });
});
