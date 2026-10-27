import { render } from "@testing-library/react";
import { createElement, useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppServicesContext,
  AppServicesProvider,
  type AppServices,
} from "@/components/providers/app-services-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  TEST_BOOK_ID,
  TEST_CHILD_ID,
  TEST_PAGE_ID,
  TEST_SESSION_ID,
  TEST_WORD_ID,
} from "@/test/fixtures/report-data-fixture";

beforeEach(() => installApiFetchFixture());
afterEach(() => vi.unstubAllGlobals());
function readServices(): AppServices {
  const captured: { current: AppServices | null } = { current: null };
  function Probe() {
    captured.current = useContext(AppServicesContext);
    return null;
  }
  render(createElement(AppServicesProvider, null, createElement(Probe)));
  if (!captured.current) throw new Error("Missing AppServices test context");
  return captured.current;
}

describe("Reading/AI unavailable boundaries (legacy mock behavior is not restored)", () => {
  it("does not create sessions, pages or completion results for unimplemented Reading", () => {
    const { readingService } = readServices();
    const operations = [
      () =>
        readingService.create({
          child_id: TEST_CHILD_ID,
          book_id: TEST_BOOK_ID,
          mode: "realtime",
        }),
      () => readingService.get(TEST_SESSION_ID),
      () => readingService.getCurrentPage(TEST_SESSION_ID),
      () => readingService.getPageProgress(TEST_SESSION_ID),
      () => readingService.navigateToPage(TEST_SESSION_ID, TEST_PAGE_ID),
      () => readingService.completeCurrentPage(TEST_SESSION_ID, TEST_PAGE_ID),
      () => readingService.getCompletionSummary(TEST_SESSION_ID),
      () => readingService.finish(TEST_SESSION_ID),
    ];
    for (const operation of operations)
      expect(operation).toThrow("ReadingService is not implemented yet.");
    expect(apiFetchFixture).not.toHaveBeenCalled();
  });

  it.each([
    "paused",
    "reconnecting",
    "stt-error",
    "camera-denied",
    "microphone-denied",
    "page-confidence-low",
    "tts-error",
  ] as const)(
    "does not return fabricated scoring or child evidence in %s",
    (state) => {
      const { readingSocketAdapter } = readServices();
      expect(() => readingSocketAdapter.getSafetySnapshot(state)).toThrow(
        "ReadingSocketAdapter is not implemented yet.",
      );
      expect(apiFetchFixture).not.toHaveBeenCalled();
    },
  );

  it("does not invent a page selection or revision binding", () => {
    const { pageMatchService } = readServices();
    expect(() =>
      pageMatchService.selectPage(TEST_SESSION_ID, TEST_PAGE_ID),
    ).toThrow("PageMatchService is not implemented yet.");
    expect(() => pageMatchService.retryCurrentPage(TEST_SESSION_ID)).toThrow(
      "PageMatchService is not implemented yet.",
    );
    expect(apiFetchFixture).not.toHaveBeenCalled();
  });

  it("does not deliver fake socket state or reconnect success", () => {
    const { readingSocketAdapter } = readServices();
    const listener = vi.fn();
    expect(() =>
      readingSocketAdapter.subscribe(TEST_SESSION_ID, listener),
    ).toThrow("ReadingSocketAdapter is not implemented yet.");
    expect(() =>
      readingSocketAdapter.sendControl(TEST_SESSION_ID, "finish"),
    ).toThrow("ReadingSocketAdapter is not implemented yet.");
    expect(() =>
      readingSocketAdapter.reconnect(TEST_SESSION_ID, "recover"),
    ).toThrow("ReadingSocketAdapter is not implemented yet.");
    expect(listener).not.toHaveBeenCalled();
    expect(apiFetchFixture).not.toHaveBeenCalled();
  });

  it("does not fabricate TTS playback or retry evidence", () => {
    const { tutorService } = readServices();
    expect(() =>
      tutorService.requestReadExample(TEST_SESSION_ID, TEST_WORD_ID),
    ).toThrow("TutorService is not implemented yet.");
    expect(() =>
      tutorService.retryReadExample({
        action: "READ_EXAMPLE",
        page_revision_word_id: TEST_WORD_ID,
      }),
    ).toThrow("TutorService is not implemented yet.");
    expect(apiFetchFixture).not.toHaveBeenCalled();
  });

  it("does not fabricate questions, expected answers or answer scores", () => {
    const { comprehensionService } = readServices();
    expect(() => comprehensionService.getQuestion(TEST_SESSION_ID)).toThrow(
      "ComprehensionService is not implemented yet.",
    );
    expect(() =>
      comprehensionService.submitAnswer(
        TEST_SESSION_ID,
        TEST_WORD_ID,
        "Câu trả lời",
      ),
    ).toThrow("ComprehensionService is not implemented yet.");
    expect(apiFetchFixture).not.toHaveBeenCalled();
  });
});
