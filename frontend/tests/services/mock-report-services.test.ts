import { describe, expect, it } from "vitest";

import { isServiceError } from "@/lib/api/service-error";
import {
  createMockAppStore,
  MOCK_CURRENT_CHILD_ID,
  MOCK_FOREIGN_CHILD_ID,
  MOCK_SECOND_CHILD_ID,
} from "@/lib/mock/mock-app-store";
import { createMockDifficultWordService } from "@/lib/mock/mock-difficult-word-service";
import {
  MOCK_FOREIGN_SESSION_ID,
  MOCK_REPORT_SESSION_ID,
} from "@/lib/mock/mock-report-data";
import { createMockReportService } from "@/lib/mock/mock-report-service";
import { createMockSessionService } from "@/lib/mock/mock-session-service";

describe("Group 5 typed mock services", () => {
  it("paginates history with an opaque cursor and canonical descending order", async () => {
    const service = createMockSessionService(createMockAppStore(), "default");
    const first = await service.list(MOCK_CURRENT_CHILD_ID, { limit: 2 });
    const second = await service.list(MOCK_CURRENT_CHILD_ID, {
      cursor: first.next_cursor ?? undefined,
      limit: 2,
    });

    expect(first.sessions).toHaveLength(2);
    expect(first.next_cursor).toBe("page-2");
    expect(second.sessions).toHaveLength(2);
    expect(first.sessions[0].started_at >= first.sessions[1].started_at).toBe(
      true,
    );
  });

  it("returns stored historical revision ids in session detail", async () => {
    const detail = await createMockSessionService(
      createMockAppStore(),
      "default",
    ).get(MOCK_REPORT_SESSION_ID);

    expect(detail.events).not.toHaveLength(0);
    expect(
      detail.events.every((event) =>
        detail.reference_page_revision_ids.includes(event.page_revision_id),
      ),
    ).toBe(true);
    expect(detail.fluency_assessment?.score).toBeNull();
  });

  it("uses the same safe 404 for foreign child and session resources", async () => {
    const store = createMockAppStore();
    const sessionService = createMockSessionService(store, "default");
    const reportService = createMockReportService(store, "default");

    await expect(sessionService.get(MOCK_FOREIGN_SESSION_ID)).rejects.toSatisfy(
      (error: unknown) =>
        isServiceError(error) &&
        error.code === "RESOURCE_NOT_FOUND" &&
        error.status === 404,
    );
    await expect(reportService.get(MOCK_FOREIGN_CHILD_ID)).rejects.toSatisfy(
      (error: unknown) =>
        isServiceError(error) &&
        error.code === "RESOURCE_NOT_FOUND" &&
        error.status === 404,
    );
  });

  it("does not manufacture prior-period trends or practice evidence", async () => {
    const store = createMockAppStore();
    const report = await createMockReportService(store, "no-prior-period").get(
      MOCK_CURRENT_CHILD_ID,
    );
    const wordsService = createMockDifficultWordService(store, "default");
    const words = await wordsService.list(MOCK_CURRENT_CHILD_ID);
    const before = words[0].evidence_word_ids.length;
    const practice = await wordsService.practice(
      MOCK_CURRENT_CHILD_ID,
      words[0].normalized_word,
    );

    expect(report.previous_period).toBeNull();
    expect(
      Object.values(report.trend_deltas).every((value) => value === null),
    ).toBe(true);
    expect(practice.evidence_count_unchanged).toBe(true);
    expect(
      (await wordsService.list(MOCK_CURRENT_CHILD_ID))[0].evidence_word_ids,
    ).toHaveLength(before);
    await expect(wordsService.list(MOCK_SECOND_CHILD_ID)).resolves.toEqual([]);
  });
});
