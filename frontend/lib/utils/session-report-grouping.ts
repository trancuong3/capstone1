import type {
  ComparisonResult,
  SavedReadingReport,
} from "@/lib/api/comparison-service";

export type ReportWordMetricKey =
  "correct" | "missing" | "substitution" | "extra" | "repeated" | "hesitation";

export interface ReportWordMetric {
  readonly key: ReportWordMetricKey;
  readonly label: string;
  readonly count: number;
  readonly words: readonly string[];
  readonly accentClassName: string;
}

export interface SessionPageReportGroup {
  readonly key: string;
  readonly pageId: string;
  readonly pageRevisionId: string;
  readonly primaryReport: SavedReadingReport;
  readonly additionalReports: readonly SavedReadingReport[];
  readonly allReports: readonly SavedReadingReport[];
}

export const REPORT_WORD_LEGEND = [
  {
    key: "correct",
    label: "Đọc đúng",
    swatchClassName: "border-emerald-300 bg-success-surface text-success-ink",
  },
  {
    key: "self-corrected",
    label: "Đã tự sửa đúng",
    swatchClassName: "border-green-600 bg-green-200 text-green-900",
  },
  {
    key: "missing",
    label: "Bỏ sót / Đọc nhầm",
    swatchClassName: "border-red-400 bg-red-200 text-red-900",
  },
  {
    key: "fluency",
    label: "Lặp từ / Ngập ngừng",
    swatchClassName: "border-purple-400 bg-purple-200 text-purple-900",
  },
  {
    key: "uncertain",
    label: "Chưa nghe rõ",
    swatchClassName: "border-slate-400 bg-slate-100 text-slate-700",
  },
] as const;

export function reportRevisionKey(
  pageId: string,
  pageRevisionId: string,
): string {
  return `${pageId}:${pageRevisionId}`;
}

export function isImmutableFirstPassReport(
  report: Pick<SavedReadingReport, "summary">,
): boolean {
  return report.summary.assessment_version === 1;
}

function compareIsoTimestamps(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs - rightMs;
  }
  return left.localeCompare(right);
}

/**
 * Groups session reports by `(page_id, page_revision_id)` without dropping valid
 * historical comparisons. Mirrors the backend invariant in `reading_assessment.py`:
 * the earliest finalized (`assessment_version === 1`) snapshot is canonical; if
 * none exists, the newest comparison is selected as primary and all remaining
 * entries are kept in `additionalReports` (newest first).
 */
export function groupSessionReportsByPageRevision(
  reports: readonly SavedReadingReport[],
): readonly SessionPageReportGroup[] {
  const buckets = new Map<string, SavedReadingReport[]>();

  for (const report of reports) {
    const key = reportRevisionKey(report.page_id, report.page_revision_id);
    const list = buckets.get(key);
    if (list) list.push(report);
    else buckets.set(key, [report]);
  }

  const groups: SessionPageReportGroup[] = [];
  for (const [key, items] of buckets.entries()) {
    const newestFirst = [...items].sort((left, right) =>
      compareIsoTimestamps(right.created_at, left.created_at),
    );

    const finalized = [...items]
      .filter((item) => isImmutableFirstPassReport(item))
      .sort((left, right) =>
        compareIsoTimestamps(left.created_at, right.created_at),
      );

    const primaryReport = finalized[0] ?? newestFirst[0]!;
    const additionalReports = newestFirst.filter(
      (item) => item.report_id !== primaryReport.report_id,
    );

    groups.push({
      key,
      pageId: primaryReport.page_id,
      pageRevisionId: primaryReport.page_revision_id,
      primaryReport,
      additionalReports,
      allReports: [primaryReport, ...additionalReports],
    });
  }

  return groups.sort((left, right) =>
    compareIsoTimestamps(
      left.primaryReport.created_at,
      right.primaryReport.created_at,
    ),
  );
}

export function buildReportWordMetrics(
  report: Pick<ComparisonResult, "alignment" | "summary">,
): readonly ReportWordMetric[] {
  const snapshot = report.summary.initial_assessment;
  const correct = snapshot
    ? snapshot
        .filter((word) => word.status === "CORRECT")
        .map((word) => word.text)
    : report.alignment
        .filter((item) => item.status === "MATCH")
        .map((item) => item.book_word ?? item.spoken_word ?? "")
        .filter(Boolean);
  const missing = snapshot
    ? snapshot
        .filter((word) => word.status === "OMISSION")
        .map((word) => word.text)
    : report.summary.missing_words;
  const substitutions = snapshot
    ? snapshot
        .filter((word) => word.status === "MISPRONUNCIATION")
        .map((word) => word.text)
    : report.summary.substitutions.map(
        (item) => `${item.book_word} → ${item.spoken_word}`,
      );
  const extra = report.summary.extra_words;
  const repeated = report.summary.repeated_words;
  const hesitation = report.summary.hesitations.map(
    (item) =>
      `${item.after_word} → ${item.before_word} · ${item.pause.toFixed(1)} giây`,
  );

  return [
    {
      key: "correct",
      label: "Đọc đúng",
      count: correct.length,
      words: correct,
      accentClassName: "text-success-ink",
    },
    {
      key: "missing",
      label: "Từ bỏ sót",
      count: missing.length,
      words: missing,
      accentClassName: "text-danger",
    },
    {
      key: "substitution",
      label: "Đọc nhầm",
      count: substitutions.length,
      words: substitutions,
      accentClassName: "text-danger",
    },
    {
      key: "extra",
      label: "Đọc thêm",
      count: extra.length,
      words: extra,
      accentClassName: "text-purple-ink",
    },
    {
      key: "repeated",
      label: "Lặp từ",
      count: report.summary.repeated_count,
      words: repeated,
      accentClassName: "text-purple-ink",
    },
    {
      key: "hesitation",
      label: "Ngập ngừng",
      count: report.summary.hesitations.length,
      words: hesitation,
      accentClassName: "text-purple-ink",
    },
  ];
}
