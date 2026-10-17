import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReadingScreen } from "@/components/reading/reading-screen";
import type { ReadingServices } from "@/hooks/use-reading-services";
import {
  bookFixture,
  childFixture,
  sessionSummaryFixture,
  TEST_SESSION_ID,
} from "@/test/fixtures/report-data-fixture";
import type { ReadingPageDTO, TutorAction } from "@/types/reading";
const TEST_QUESTION_ID = "80000000-0000-4000-8000-000000000001";
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
const tutorAction: TutorAction = {
  action: "READ_EXAMPLE",
  action_id: "70000000-0000-4000-8000-000000000001",
  page_revision_word_id: pageFour.words[3].word_id,
  tts_text: "đang",
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
      explainWord: vi
        .fn<ReadingServices["tutorService"]["explainWord"]>()
        .mockRejectedValue(new Error("Unused tutor explanation")),
      requestReadExample: vi
        .fn<ReadingServices["tutorService"]["requestReadExample"]>()
        .mockResolvedValue(tutorAction),
      retryReadExample: vi
        .fn<ReadingServices["tutorService"]["retryReadExample"]>()
        .mockResolvedValue(tutorAction),
    },
  } satisfies ReadingServices;
}

describe("Reading action cleanup with a typed service boundary", () => {
  it("does not continue a delayed tutor retry after unmount", async () => {
    const services = createReadingFixtures();
    servicesHook.mockReset().mockReturnValue(services);
    let settle: (action: TutorAction) => void = () => undefined;
    services.tutorService.requestReadExample.mockImplementationOnce(
      () =>
        new Promise<TutorAction>((resolve) => {
          settle = resolve;
        }),
    );
    const unsubscribe = vi.fn();
    services.readingSocketAdapter.subscribe.mockReturnValue(unsubscribe);
    const view = render(
      <ReadingScreen
        initialUiState="tts-error"
        reconnectMode="recover"
        sessionId={TEST_SESSION_ID}
      />,
    );
    const retry = await screen.findByRole("button", { name: "Thử nghe lại" });
    fireEvent.click(retry);
    expect(services.tutorService.requestReadExample).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      pageFour.words[3].word_id,
    );
    view.unmount();
    await act(async () => {
      settle(tutorAction);
    });
    expect(services.tutorService.retryReadExample).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(view.container).toBeEmptyDOMElement();
  });
});
