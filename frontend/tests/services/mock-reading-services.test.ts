import { describe, expect, it } from "vitest";

import { isServiceError } from "@/lib/api/service-error";
import {
  createMockAppStore,
  MOCK_CURRENT_CHILD_ID,
  MOCK_FOREIGN_CHILD_ID,
} from "@/lib/mock/mock-app-store";
import {
  createMockBookService,
  MOCK_RETIRED_READING_BOOK_ID,
  MOCK_UNVERIFIED_READING_BOOK_ID,
} from "@/lib/mock/mock-book-service";
import { createMockComprehensionService } from "@/lib/mock/mock-comprehension-service";
import { createMockPageMatchService } from "@/lib/mock/mock-page-match-service";
import {
  MOCK_READING_BOOK_ID,
  MOCK_READING_PAGES,
  MOCK_READING_SESSION_ID,
} from "@/lib/mock/mock-reading-data";
import { createMockReadingService } from "@/lib/mock/mock-reading-service";
import { createMockReadingSocketAdapter } from "@/lib/mock/mock-reading-socket-adapter";
import { createMockTutorService } from "@/lib/mock/mock-tutor-service";

describe("Group 4 typed mock services", () => {
  function createReadingService() {
    return createMockReadingService(
      createMockAppStore(),
      createMockBookService("default"),
    );
  }

  it("returns normalized revision-bound word boxes", async () => {
    const page = await createReadingService().getCurrentPage(
      MOCK_READING_SESSION_ID,
    );

    expect(page.page_revision_id).toBe("40000000-0000-4000-8000-000000000014");
    expect(page.words.every((word) => word.word_id.length > 0)).toBe(true);
    expect(
      page.words.every((word) =>
        word.bbox.every((value) => value >= 0 && value <= 1),
      ),
    ).toBe(true);
  });

  it.each([
    "paused",
    "reconnecting",
    "stt-error",
    "camera-denied",
    "microphone-denied",
    "page-confidence-low",
    "tts-error",
  ] as const)("does not fabricate child evidence in %s", (state) => {
    const snapshot = createMockReadingSocketAdapter().getSafetySnapshot(state);

    expect(snapshot.scoring_active).toBe(false);
    expect(snapshot.evidence_valid).toBe(false);
    expect(snapshot.child_error_events).toHaveLength(0);
  });

  it("allows only a page belonging to the current verified session book", async () => {
    const service = createMockPageMatchService();
    const selected = await service.selectPage(
      MOCK_READING_SESSION_ID,
      MOCK_READING_PAGES[1].page_id,
    );

    expect(selected.page_number).toBe(5);
    await expect(
      service.selectPage(
        MOCK_READING_SESSION_ID,
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isServiceError(error) && error.code === "PAGE_NOT_IN_SESSION_BOOK",
    );
  });

  it("rebinds page turn words to the new immutable revision", async () => {
    const selected = await createMockPageMatchService().selectPage(
      MOCK_READING_SESSION_ID,
      MOCK_READING_PAGES[1].page_id,
    );

    expect(selected.page_revision_id).not.toBe(
      MOCK_READING_PAGES[0].page_revision_id,
    );
    expect(
      selected.words.every(
        (word) =>
          !MOCK_READING_PAGES[0].words.some(
            (previousWord) => previousWord.word_id === word.word_id,
          ),
      ),
    ).toBe(true);
  });

  it("finishes idempotently when called more than once", async () => {
    const service = createReadingService();
    const [first, duplicate] = await Promise.all([
      service.finish(MOCK_READING_SESSION_ID),
      service.finish(MOCK_READING_SESSION_ID),
    ]);

    expect(first).toEqual(duplicate);
    expect(first.state).toBe("FINISHED");
    expect(first.duration_ms).toBe(480_000);
  });

  it("returns the same safe 404 for a child owned by another parent", async () => {
    const service = createReadingService();

    await expect(
      service.create({
        child_id: MOCK_FOREIGN_CHILD_ID,
        book_id: MOCK_READING_BOOK_ID,
        mode: "realtime",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isServiceError(error) &&
        error.code === "RESOURCE_NOT_FOUND" &&
        error.status === 404,
    );
  });

  it.each([
    {
      name: "unknown",
      bookId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      code: "RESOURCE_NOT_FOUND",
      status: 404,
    },
    {
      name: "retired",
      bookId: MOCK_RETIRED_READING_BOOK_ID,
      code: "CONTENT_INACTIVE",
      status: 409,
    },
    {
      name: "unverified",
      bookId: MOCK_UNVERIFIED_READING_BOOK_ID,
      code: "CONTENT_INACTIVE",
      status: 409,
    },
  ])("rejects a $name book before creating a session", async (testCase) => {
    await expect(
      createReadingService().create({
        child_id: MOCK_CURRENT_CHILD_ID,
        book_id: testCase.bookId,
        mode: "realtime",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isServiceError(error) &&
        error.code === testCase.code &&
        error.status === testCase.status,
    );
  });

  it("rejects an unknown session before returning session-scoped data", async () => {
    const unknownSessionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const notFound = (error: unknown) =>
      isServiceError(error) &&
      error.code === "RESOURCE_NOT_FOUND" &&
      error.status === 404;

    await expect(
      createReadingService().get(unknownSessionId),
    ).rejects.toSatisfy(notFound);
    await expect(
      createMockComprehensionService().getQuestion(unknownSessionId),
    ).rejects.toSatisfy(notFound);
    await expect(
      createMockTutorService().requestReadExample(unknownSessionId, "word-id"),
    ).rejects.toSatisfy(notFound);
  });

  it("keeps child-error evidence unchanged when retrying TTS", async () => {
    const socket = createMockReadingSocketAdapter();
    const tutor = createMockTutorService();
    const before = socket.getSafetySnapshot("tts-error");
    const action = await tutor.requestReadExample(
      MOCK_READING_SESSION_ID,
      MOCK_READING_PAGES[0].words[0].word_id,
    );
    const replay = await tutor.retryReadExample(action);
    const after = socket.getSafetySnapshot("tts-error");

    expect(replay.action_id).toBe(action.action_id);
    expect(after.child_error_events).toEqual(before.child_error_events);
    expect(after.evidence_valid).toBe(false);
  });

  it("never exposes the expected answer in the question payload", async () => {
    const service = createMockComprehensionService();
    const payload = await service.getQuestion(MOCK_READING_SESSION_ID);

    expect(JSON.stringify(payload)).not.toContain("expected_answer");
    expect(JSON.stringify(payload)).not.toContain("EXPECTED_ANSWER");
    await expect(
      service.submitAnswer(
        MOCK_READING_SESSION_ID,
        payload.question.id,
        "Bên cửa sổ",
      ),
    ).resolves.toMatchObject({ is_correct: true, score: 1 });
  });
});
