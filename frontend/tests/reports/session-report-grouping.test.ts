import { describe, expect, it } from "vitest";

import type { SavedReadingReport } from "@/lib/api/comparison-service";
import {
  buildReportWordMetrics,
  groupSessionReportsByPageRevision,
  isImmutableFirstPassReport,
  reportRevisionKey,
} from "@/lib/utils/session-report-grouping";

function makeReport(
  overrides: Partial<SavedReadingReport> & {
    report_id: string;
    page_id: string;
    page_revision_id: string;
    created_at: string;
  },
): SavedReadingReport {
  return {
    transcript: "Bé đọc bài",
    distance: 0,
    alignment: [],
    summary: {
      missing_words: [],
      extra_words: [],
      substitutions: [],
      repeated_count: 0,
      repeated_words: [],
      hesitations: [],
      hesitation_seconds: null,
    },
    ...overrides,
  };
}

describe("session-report-grouping", () => {
  it("groups multiple comparisons on the same page+revision and prioritizes earliest finalized v1 report", () => {
    const legacyRetry = makeReport({
      report_id: "rep-retry-latest",
      page_id: "page-1",
      page_revision_id: "rev-1",
      created_at: "2026-11-25T09:18:10+07:00",
      transcript: "Lượt đọc lại mới hơn",
    });
    const firstPassV1 = makeReport({
      report_id: "rep-v1-earliest",
      page_id: "page-1",
      page_revision_id: "rev-1",
      created_at: "2026-11-25T09:17:00+07:00",
      transcript: "Lượt đầu bất biến",
      summary: {
        assessment_version: 1,
        missing_words: ["qua"],
        extra_words: [],
        substitutions: [],
        repeated_count: 0,
        repeated_words: [],
        hesitations: [],
        hesitation_seconds: null,
      },
    });
    const laterV1 = makeReport({
      report_id: "rep-v1-later",
      page_id: "page-1",
      page_revision_id: "rev-1",
      created_at: "2026-11-25T09:17:30+07:00",
      transcript: "Bản v1 sau đó",
      summary: {
        assessment_version: 1,
        missing_words: [],
        extra_words: [],
        substitutions: [],
        repeated_count: 0,
        repeated_words: [],
        hesitations: [],
        hesitation_seconds: null,
      },
    });
    const page2Report = makeReport({
      report_id: "rep-page-2",
      page_id: "page-2",
      page_revision_id: "rev-2",
      created_at: "2026-11-25T09:20:00+07:00",
      transcript: "Trang hai",
    });

    const groups = groupSessionReportsByPageRevision([
      page2Report,
      legacyRetry,
      laterV1,
      firstPassV1,
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe(reportRevisionKey("page-1", "rev-1"));
    expect(groups[0].primaryReport.report_id).toBe("rep-v1-earliest");
    expect(groups[0].additionalReports.map((item) => item.report_id)).toEqual([
      "rep-retry-latest",
      "rep-v1-later",
    ]);
    expect(groups[0].allReports).toHaveLength(3);

    expect(groups[1].key).toBe(reportRevisionKey("page-2", "rev-2"));
    expect(groups[1].primaryReport.report_id).toBe("rep-page-2");
    expect(groups[1].additionalReports).toEqual([]);
  });

  it("falls back to newest report when no v1 assessment exists and preserves API order on equal timestamps", () => {
    const first = makeReport({
      report_id: "rep-a",
      page_id: "page-1",
      page_revision_id: "rev-1",
      created_at: "2026-11-25T10:00:00Z",
    });
    const second = makeReport({
      report_id: "rep-b",
      page_id: "page-1",
      page_revision_id: "rev-1",
      created_at: "2026-11-25T10:00:00Z",
    });
    const tied = groupSessionReportsByPageRevision([first, second]);
    expect(tied).toHaveLength(1);
    expect(tied[0].primaryReport.report_id).toBe("rep-a");
    expect(tied[0].additionalReports.map((item) => item.report_id)).toEqual([
      "rep-b",
    ]);

    const newer = makeReport({
      report_id: "rep-c",
      page_id: "page-1",
      page_revision_id: "rev-1",
      created_at: "2026-11-25T10:05:00Z",
    });
    const ordered = groupSessionReportsByPageRevision([first, newer]);
    expect(ordered[0].primaryReport.report_id).toBe("rep-c");
    expect(ordered[0].additionalReports.map((item) => item.report_id)).toEqual([
      "rep-a",
    ]);
  });

  it("uses immutable initial_assessment snapshot without miscounting UNCERTAIN words as errors", () => {
    const report = makeReport({
      report_id: "rep-snapshot",
      page_id: "page-1",
      page_revision_id: "rev-1",
      created_at: "2026-11-25T09:17:00+07:00",
      self_corrected_word_ids: ["w2"],
      summary: {
        assessment_version: 1,
        initial_assessment: [
          { word_id: "w1", word_index: 0, text: "Bé", status: "CORRECT" },
          {
            word_id: "w2",
            word_index: 1,
            text: "vườn",
            status: "MISPRONUNCIATION",
          },
          { word_id: "w3", word_index: 2, text: "qua", status: "OMISSION" },
          { word_id: "w4", word_index: 3, text: "mát", status: "UNCERTAIN" },
        ],
        missing_words: ["stale"],
        extra_words: ["thêm"],
        substitutions: [],
        repeated_count: 1,
        repeated_words: ["Bé"],
        hesitations: [{ after_word: "Bé", before_word: "vườn", pause: 2.1 }],
        hesitation_seconds: 2.1,
      },
    });

    expect(isImmutableFirstPassReport(report)).toBe(true);
    const metrics = buildReportWordMetrics(report);
    const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
    expect(byKey.correct.count).toBe(1);
    expect(byKey.missing.count).toBe(1);
    expect(byKey.missing.words).toEqual(["qua"]);
    expect(byKey.substitution.count).toBe(1);
    expect(byKey.substitution.words).toEqual(["vườn"]);
    expect(byKey.extra.count).toBe(1);
    expect(byKey.repeated.count).toBe(1);
    expect(byKey.hesitation.count).toBe(1);
  });
});
