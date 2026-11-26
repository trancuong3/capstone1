"use client";

import { useEffect, useState } from "react";

import { BookPageContent } from "@/components/reading/book-page-content";
import { Skeleton } from "@/components/common/skeleton";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import {
  getReadingPage,
  type ComparisonResult,
  type ReadingPage,
} from "@/lib/api/comparison-service";
import {
  buildReportWordMetrics,
  REPORT_WORD_LEGEND,
} from "@/lib/utils/session-report-grouping";

type Props = {
  result: Pick<
    ComparisonResult,
    "alignment" | "summary" | "page_id" | "page_revision_id"
  > & {
    self_corrected_word_ids?: readonly string[];
    transcript?: string;
  };
  sessionId: string;
};

type Hesitation = {
  after_word: string;
  before_word: string;
  pause: number;
};

function isHesitation(value: unknown): value is Hesitation {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.after_word === "string" &&
    typeof item.before_word === "string" &&
    typeof item.pause === "number"
  );
}

export function ReadingReport({ result, sessionId }: Props) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reading");
  const tp = useTranslations("reports");
  const [page, setPage] = useState<ReadingPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPage() {
      try {
        setPageError(null);
        const data = await getReadingPage(
          result.page_id,
          sessionId,
          result.page_revision_id,
        );
        if (!cancelled) {
          if (
            data.page_id !== result.page_id ||
            data.page_revision_id !== result.page_revision_id
          ) {
            setPageError(t("report.versionLoadError"));
            setPage(null);
            return;
          }
          setPage(data);
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(
            error instanceof Error ? error.message : t("report.pageLoadError"),
          );
        }
      }
    }

    void loadPage();

    return () => {
      cancelled = true;
    };
  }, [result.page_id, result.page_revision_id, sessionId, t]);

  const metrics = buildReportWordMetrics(result);
  const snapshot = result.summary.initial_assessment;
  const missingCount =
    metrics.find((metric) => metric.key === "missing")?.count ?? 0;
  const wrongCount =
    metrics.find((metric) => metric.key === "substitution")?.count ?? 0;
  const uncertainCount =
    snapshot?.filter((word) => word.status === "UNCERTAIN").length ?? 0;

  const repeatedWordCounts = result.summary.repeated_words.reduce<
    Record<string, number>
  >((counts, word) => {
    counts[word] = (counts[word] ?? 0) + 1;
    return counts;
  }, {});
  const repeatedWords = Object.entries(repeatedWordCounts);
  const repeatedCount = result.summary.repeated_words.length;

  const hesitations = result.summary.hesitations.filter(isHesitation);
  const hesitationSeconds = result.summary.hesitation_seconds;

  return (
    <div className="space-y-5 rounded-card border border-border bg-white p-4 sm:p-6">
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
        <div className="space-y-3">
          <div className="rounded-card border border-border bg-cream p-3 sm:p-5">
            {pageError ? (
              <p className="rounded-control bg-white/80 p-4 text-sm text-danger">
                {pageError}
              </p>
            ) : !page ? (
              <div
                aria-busy="true"
                aria-label={t("report.loadingAria")}
                className="space-y-3 p-2"
              >
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-32 rounded-control" />
              </div>
            ) : (
              <article
                className="relative flex min-h-[200px] w-full flex-col rounded-control bg-[#fffdfa] p-3.5 sm:min-h-[260px] sm:p-5"
                data-page-id={page.page_id}
                data-page-revision-id={page.page_revision_id}
              >
                <header className="mb-2 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-control bg-success-surface px-2.5 py-1 text-xs font-bold text-success-ink">
                    <span className="size-1.5 rounded-full bg-success-ink" />
                    {t("report.verifiedContentTitle")}
                  </span>
                  <span className="text-xs font-bold tabular-nums text-muted">
                    {t("progress.pageLabel", {
                      page: formatNumber(page.page_number),
                    })}
                  </span>
                </header>

                <BookPageContent
                  comparisonResult={result}
                  page={page}
                  readOnly
                  selfCorrectedWordIds={
                    new Set(result.self_corrected_word_ids ?? [])
                  }
                />
              </article>
            )}
          </div>

          <ul
            aria-label={t("report.legendAria")}
            className="flex flex-wrap gap-1.5 text-xs font-semibold"
          >
            {REPORT_WORD_LEGEND.map((legend) => (
              <li
                className={`rounded-control border px-2.5 py-1 ${legend.swatchClassName}`}
                key={legend.key}
              >
                {tp(`sessions.readingReports.legend.${legend.key}`)}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-2.5">
            {metrics.map((metric) => (
              <div
                className="rounded-control border border-border bg-canvas/50 p-3"
                key={metric.key}
              >
                <dt className={`text-xs font-bold ${metric.accentClassName}`}>
                  {metric.key === "correct"
                    ? t("report.correctLabel")
                    : metric.key === "substitution"
                      ? t("report.substitutionLabel")
                      : tp(`sessions.readingReports.wordMetrics.${metric.key}`)}
                </dt>
                <dd className="mt-1 text-2xl font-extrabold tabular-nums text-ink">
                  {formatNumber(metric.count)}
                </dd>
              </div>
            ))}
          </dl>

          {typeof result.transcript === "string" ? (
            <div className="rounded-control border border-border bg-canvas/70 p-3.5">
              <p className="text-xs font-bold text-muted">
                {t("report.recordedTranscriptLabel")}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink">
                {result.transcript.trim() ? (
                  <span className="viread-learning-content" dir="ltr" lang="vi">
                    {result.transcript.trim()}
                  </span>
                ) : (
                  t("report.notRecorded")
                )}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      {repeatedWords.length > 0 || hesitations.length > 0 ? (
        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <div className="space-y-1.5 text-sm">
            <h3 className="font-extrabold text-ink">
              {t("report.repetitionsTitle", {
                count: formatNumber(repeatedCount),
              })}
            </h3>
            {repeatedWords.length > 0 ? (
              <ul className="list-disc space-y-1 ps-5 text-muted">
                {repeatedWords.map(([word, count]) => (
                  <li key={word}>
                    <span
                      className="viread-learning-content font-bold text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {word}
                    </span>{" "}
                    — {formatNumber(count)} {t("report.timesUnit")}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">{t("report.noRepetitions")}</p>
            )}
          </div>

          <div className="space-y-1.5 text-sm">
            <h3 className="font-extrabold text-ink">
              {t("report.hesitationsTitle", {
                count: formatNumber(hesitations.length),
              })}
            </h3>
            {hesitationSeconds != null ? (
              <p className="text-xs font-semibold text-muted tabular-nums">
                {t("report.totalPauseSummary", {
                  seconds: hesitationSeconds.toFixed(1),
                })}
              </p>
            ) : null}
            {hesitations.length > 0 ? (
              <ul className="list-disc space-y-1 ps-5 text-muted">
                {hesitations.map((item, index) => (
                  <li key={`${item.after_word}-${item.before_word}-${index}`}>
                    <span
                      className="viread-learning-content"
                      dir="ltr"
                      lang="vi"
                    >
                      {item.after_word}
                    </span>{" "}
                    →{" "}
                    <span
                      className="viread-learning-content font-bold text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {item.before_word}
                    </span>
                    :{" "}
                    {t("report.pauseDetail", {
                      seconds: item.pause.toFixed(1),
                    })}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">{t("report.noHesitations")}</p>
            )}
          </div>
        </div>
      ) : null}

      <p className="border-t border-border pt-3 text-sm font-semibold text-muted">
        {uncertainCount > 0
          ? t("report.uncertainSummary")
          : missingCount === 0 && wrongCount === 0
            ? t("report.allCorrectSummary")
            : t("report.partialSummary")}
      </p>
    </div>
  );
}
