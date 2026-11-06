"use client";

import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { BookPageContent } from "@/components/reading/book-page-content";
import {
  getReadingPage,
  getSessionReports,
  type ReadingPage,
  type SavedReadingReport,
} from "@/lib/api/comparison-service";
import { isServiceError } from "@/lib/api/service-error";

type ReportsState =
  | { readonly status: "loading" }
  | { readonly status: "empty" }
  | {
      readonly status: "ready";
      readonly reports: readonly SavedReadingReport[];
      readonly pages: ReadonlyMap<string, ReadingPage>;
      readonly partial: boolean;
    }
  | { readonly status: "unavailable" }
  | { readonly status: "error" };

type MetricKey =
  "correct" | "missing" | "substitution" | "extra" | "repeated" | "hesitation";

interface ReportMetric {
  readonly key: MetricKey;
  readonly label: string;
  readonly count: number;
  readonly words: readonly string[];
  readonly color: string;
}

function reportKey(pageId: string, revisionId: string): string {
  return `${pageId}:${revisionId}`;
}

function reportMetrics(report: SavedReadingReport): readonly ReportMetric[] {
  const correct = report.alignment
    .filter((item) => item.status === "MATCH")
    .map((item) => item.book_word ?? item.spoken_word ?? "")
    .filter(Boolean);
  const missing = report.summary.missing_words;
  const substitutions = report.summary.substitutions.map(
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
      color: "text-emerald-700",
    },
    {
      key: "missing",
      label: "Từ bỏ",
      count: missing.length,
      words: missing,
      color: "text-red-700",
    },
    {
      key: "substitution",
      label: "Đọc nhầm",
      count: substitutions.length,
      words: substitutions,
      color: "text-orange-700",
    },
    {
      key: "extra",
      label: "Đọc thêm",
      count: extra.length,
      words: extra,
      color: "text-violet-700",
    },
    {
      key: "repeated",
      label: "Lặp từ",
      count: report.summary.repeated_count,
      words: repeated,
      color: "text-purple-700",
    },
    {
      key: "hesitation",
      label: "Ngập ngừng",
      count: report.summary.hesitations.length,
      words: hesitation,
      color: "text-blue-700",
    },
  ];
}

function ReportCard({
  report,
  page,
  reportNumber,
  reportCount,
  selectedMetric,
  onSelectMetric,
  onPrevious,
  onNext,
}: {
  readonly report: SavedReadingReport;
  readonly page?: ReadingPage;
  readonly reportNumber: number;
  readonly reportCount: number;
  readonly selectedMetric: MetricKey | null;
  readonly onSelectMetric: (key: MetricKey) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  const metrics = reportMetrics(report);
  const activeMetric = metrics.find((metric) => metric.key === selectedMetric);

  return (
    <article className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xl font-extrabold text-ink">
            {page ? `Trang ${page.page_number}` : "Báo cáo trang"}
          </h3>
          <p className="text-sm text-muted">
            {reportNumber} / {reportCount} trang có báo cáo
          </p>
        </div>
        {reportCount > 1 ? (
          <nav aria-label="Chuyển báo cáo trang" className="flex gap-2">
            <button
              aria-label="Báo cáo trang trước"
              className="inline-flex size-11 items-center justify-center rounded-control border border-border bg-white text-primary hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
              disabled={reportNumber <= 1}
              onClick={onPrevious}
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="size-5" />
            </button>
            <button
              aria-label="Báo cáo trang tiếp theo"
              className="inline-flex size-11 items-center justify-center rounded-control border border-border bg-white text-primary hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40"
              disabled={reportNumber >= reportCount}
              onClick={onNext}
              type="button"
            >
              <ChevronRight aria-hidden="true" className="size-5" />
            </button>
          </nav>
        ) : null}
      </div>

      <div
        className="rounded-card border border-[#e3d7bf] bg-[#fff8ea] p-3 sm:p-5"
      >
        {page ? (
          <article
            className="relative mx-auto flex aspect-[3/2] min-h-[280px] w-full max-w-[1008px] flex-col overflow-hidden rounded-control bg-[#fffdfa] p-3 sm:min-h-[360px] sm:p-6"
            data-page-id={page.page_id}
            data-page-revision-id={page.page_revision_id}
          >
            <header className="flex items-center justify-between gap-2">
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800"
              >
                <span className="size-2 rounded-full bg-emerald-500" />
                Nội dung OCR đã xác minh
              </span>
              <span className="text-sm font-semibold text-muted">
                Trang {page.page_number}
              </span>
            </header>
            <BookPageContent comparisonResult={report} page={page} readOnly />
            <p className="mt-2 text-right text-sm text-muted">
              {page.page_number}
            </p>
          </article>
        ) : (
          <div
            className="flex min-h-48 items-center justify-center rounded-control bg-white/70 p-5 text-center text-sm text-muted"
          >
            Không tải được nội dung của đúng revision đã đọc. Báo cáo và thống
            kê vẫn được giữ nguyên.
          </div>
        )}
      </div>

      <div className="rounded-control border border-border bg-white p-4">
        <p className="text-sm font-bold text-muted">Lời đọc đã lưu</p>
        <p className="mt-1 text-base text-ink">
          {report.transcript.trim() || "Chưa ghi nhận"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
        {metrics.map((metric) => (
          <button
            aria-expanded={selectedMetric === metric.key}
            className={`min-h-20 rounded-control border p-3 text-left transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary ${
              selectedMetric === metric.key
                ? "border-primary bg-sky"
                : "border-border bg-white hover:bg-surface"
            }`}
            key={metric.key}
            onClick={() => onSelectMetric(metric.key)}
            type="button"
          >
            <span className={`block text-sm font-semibold ${metric.color}`}>
              {metric.label}
            </span>
            <span className="mt-1 block text-2xl font-extrabold text-ink">
              {metric.count}
            </span>
          </button>
        ))}
      </div>

      {activeMetric ? (
        <section
          aria-live="polite"
          className="rounded-card border border-border bg-white p-4"
        >
          <h4 className={`font-extrabold ${activeMetric.color}`}>
            {activeMetric.label} · {activeMetric.count}
          </h4>
          {activeMetric.words.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {activeMetric.words.map((word, index) => (
                <li
                  className="rounded-full bg-surface px-3 py-1.5 text-sm font-semibold text-ink"
                  key={`${word}-${index}`}
                >
                  {word}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Không có từ nào trong mục này.
            </p>
          )}
        </section>
      ) : null}
    </article>
  );
}

export function SessionReadingReports({
  sessionId,
}: {
  readonly sessionId: string;
}) {
  const [requestKey, setRequestKey] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedMetric, setSelectedMetric] = useState<MetricKey | null>(null);
  const [state, setState] = useState<ReportsState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      setSelectedIndex(0);
      setSelectedMetric(null);
      try {
        const result = await getSessionReports(sessionId);
        if (!active) return;
        if (result.reports.length === 0) {
          setState({ status: "empty" });
          return;
        }

        // Keep the newest saved comparison for each page revision instead of
        // showing repeated attempts as a long list of separate reports.
        const latestReports = new Map<string, SavedReadingReport>();
        for (const report of [...result.reports].sort((left, right) =>
          right.created_at.localeCompare(left.created_at),
        )) {
          const key = reportKey(report.page_id, report.page_revision_id);
          if (!latestReports.has(key)) latestReports.set(key, report);
        }
        const reportsToShow = [...latestReports.values()];

        const pageEntries = await Promise.all(
          reportsToShow.map(async (report) => {
            try {
              const page = await getReadingPage(
                report.page_id,
                sessionId,
                report.page_revision_id,
              );
              if (
                page.page_id !== report.page_id ||
                page.page_revision_id !== report.page_revision_id
              ) {
                throw new Error(
                  "The API returned a different historical page revision.",
                );
              }
              return [
                reportKey(report.page_id, report.page_revision_id),
                page,
              ] as const;
            } catch {
              return null;
            }
          }),
        );
        if (!active) return;
        const pages = new Map(
          pageEntries.filter(
            (entry): entry is readonly [string, ReadingPage] => entry !== null,
          ),
        );
        const reports = [...reportsToShow].sort((left, right) => {
          const leftPage = pages.get(
            reportKey(left.page_id, left.page_revision_id),
          );
          const rightPage = pages.get(
            reportKey(right.page_id, right.page_revision_id),
          );
          if (
            leftPage &&
            rightPage &&
            leftPage.page_number !== rightPage.page_number
          ) {
            return leftPage.page_number - rightPage.page_number;
          }
          if (leftPage && !rightPage) return -1;
          if (!leftPage && rightPage) return 1;
          return left.created_at.localeCompare(right.created_at);
        });

        setState({
          status: "ready",
          reports,
          pages,
          partial:
            pages.size !== reports.length ||
            result.total > result.reports.length,
        });
      } catch (error) {
        if (!active) return;
        setState({
          status:
            isServiceError(error) &&
            (error.status === 501 || error.status === 503)
              ? "unavailable"
              : "error",
        });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [requestKey, sessionId]);

  function selectMetric(key: MetricKey): void {
    setSelectedMetric((current) => (current === key ? null : key));
  }

  return (
    <section
      aria-labelledby="session-reading-reports-title"
      className="flex flex-col gap-4"
    >
      <h2
        className="text-2xl font-extrabold text-ink"
        id="session-reading-reports-title"
      >
        Báo cáo đọc
      </h2>
      {state.status === "loading" ? (
        <div
          aria-busy="true"
          className="rounded-card border border-border p-5 text-muted"
        >
          Đang tải báo cáo...
        </div>
      ) : null}
      {state.status === "empty" ? (
        <p className="rounded-control bg-sky p-5 text-label text-muted">
          Buổi đọc này chưa có báo cáo đối chiếu được lưu.
        </p>
      ) : null}
      {state.status === "unavailable" ? (
        <StatusMessage title="Chưa tải được báo cáo" tone="info">
          Dịch vụ báo cáo hiện chưa sẵn sàng. Thông tin còn thiếu không được
          thay bằng dữ liệu ước tính.
        </StatusMessage>
      ) : null}
      {state.status === "error" ? (
        <StatusMessage title="Có lỗi khi tải báo cáo" tone="error">
          Báo cáo chưa tải được. Vui lòng thử lại.
        </StatusMessage>
      ) : null}
      {state.status === "ready" ? (
        <>
          {state.partial ? (
            <StatusMessage
              title="Báo cáo chỉ tải được một phần"
              tone="warning"
            >
              Một số nội dung trang hoặc revision lịch sử chưa tải được; không
              thay bằng trang mới hơn. Transcript, alignment và thống kê đã lưu
              vẫn được giữ bên dưới.
            </StatusMessage>
          ) : null}
          {(() => {
            const activeIndex = Math.min(
              selectedIndex,
              state.reports.length - 1,
            );
            const report = state.reports[activeIndex];
            return report ? (
              <ReportCard
                onNext={() => {
                  setSelectedIndex((index) =>
                    Math.min(index + 1, state.reports.length - 1),
                  );
                  setSelectedMetric(null);
                }}
                onPrevious={() => {
                  setSelectedIndex((index) => Math.max(index - 1, 0));
                  setSelectedMetric(null);
                }}
                onSelectMetric={selectMetric}
                page={state.pages.get(
                  reportKey(report.page_id, report.page_revision_id),
                )}
                report={report}
                reportCount={state.reports.length}
                reportNumber={activeIndex + 1}
                selectedMetric={selectedMetric}
              />
            ) : null;
          })()}
        </>
      ) : null}
      {state.status !== "loading" && state.status !== "empty" ? (
        <Button
          className="h-12 sm:self-start"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử tải lại báo cáo
        </Button>
      ) : null}
    </section>
  );
}
