"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import {
  getReadingPage,
  getSessionReports,
  type ReadingPage,
  type SavedReadingReport,
} from "@/lib/api/comparison-service";
import { isServiceError } from "@/lib/api/service-error";
import { formatHistoryDateTime } from "@/lib/utils/report-mappers";

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

function reportKey(pageId: string, revisionId: string): string {
  return `${pageId}:${revisionId}`;
}

function renderAlignmentWords(
  report: SavedReadingReport,
  status: "MATCH" | "SUBSTITUTE" | "DELETE" | "INSERT",
): string[] {
  return report.alignment
    .filter((item) => item.status === status)
    .map((item) => {
      if (status === "SUBSTITUTE") {
        return `${item.book_word ?? "?"} → ${item.spoken_word ?? "?"}`;
      }
      return status === "DELETE"
        ? (item.book_word ?? "")
        : (item.spoken_word ?? item.book_word ?? "");
    })
    .filter(Boolean);
}

function ReportCard({
  report,
  page,
}: {
  readonly report: SavedReadingReport;
  readonly page?: ReadingPage;
}) {
  const referenceText =
    page?.text?.trim() || page?.words.map((word) => word.text).join(" ") || "";
  const matched = renderAlignmentWords(report, "MATCH");
  const substitutions = renderAlignmentWords(report, "SUBSTITUTE");
  const omitted = renderAlignmentWords(report, "DELETE");
  const extra = renderAlignmentWords(report, "INSERT");

  return (
    <article className="rounded-card border border-border bg-white p-5 sm:p-6">
      <header className="flex flex-col gap-1">
        <h3 className="text-xl font-extrabold text-ink">
          {page ? `Trang ${page.page_number}` : "Trang chưa tải được"}
        </h3>
        <p className="break-all text-sm text-muted">
          Revision đã đọc: <code>{report.page_revision_id}</code>
        </p>
        <p className="text-sm text-muted">
          Báo cáo được lưu: {formatHistoryDateTime(report.created_at)}
        </p>
      </header>

      <dl className="mt-4 grid gap-4">
        <div>
          <dt className="font-bold text-ink">Nội dung trang đã đọc</dt>
          <dd className="mt-1 whitespace-pre-wrap text-label text-muted">
            {referenceText ||
              "Không tải được nội dung của revision lịch sử này. ViRead không thay bằng trang mới hơn."}
          </dd>
        </div>
        <div>
          <dt className="font-bold text-ink">Lời bé đọc</dt>
          <dd className="mt-1 whitespace-pre-wrap text-label text-muted">
            {report.transcript || "Báo cáo không lưu transcript."}
          </dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <WordGroup
          title="Đọc đúng"
          words={matched}
          empty="Chưa ghi nhận từ đúng."
        />
        <WordGroup
          title="Đọc nhầm hoặc thay từ"
          words={substitutions}
          empty="Không ghi nhận từ thay thế."
        />
        <WordGroup
          title="Bỏ sót"
          words={omitted}
          empty="Không ghi nhận từ bị bỏ sót."
        />
        <WordGroup
          title="Đọc thêm"
          words={extra}
          empty="Không ghi nhận từ đọc thêm."
        />
      </div>

      <div className="mt-4 rounded-control bg-sky p-4 text-label text-ink">
        <p>
          Kết quả căn chỉnh: {report.alignment.length} mục · Khoảng cách:{" "}
          {report.distance}
        </p>
        <p className="mt-1">
          Tóm tắt đã lưu: {report.summary.missing_words.length} từ bỏ sót,{" "}
          {report.summary.extra_words.length} từ đọc thêm,{" "}
          {report.summary.substitutions.length} từ thay thế,{" "}
          {report.summary.repeated_count} lần lặp.
        </p>
        {report.summary.hesitation_seconds !== null ? (
          <p className="mt-1">
            Thời gian ngập ngừng đã lưu: {report.summary.hesitation_seconds}{" "}
            giây.
          </p>
        ) : null}
      </div>
    </article>
  );
}

function WordGroup({
  title,
  words,
  empty,
}: {
  readonly title: string;
  readonly words: readonly string[];
  readonly empty: string;
}) {
  return (
    <section className="rounded-control border border-border p-3">
      <h4 className="font-bold text-ink">{title}</h4>
      <p className="mt-1 text-label text-muted">
        {words.length > 0 ? words.join(", ") : empty}
      </p>
    </section>
  );
}

export function SessionReadingReports({
  sessionId,
}: {
  readonly sessionId: string;
}) {
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ReportsState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const result = await getSessionReports(sessionId);
        if (!active) return;
        if (result.reports.length === 0) {
          setState({ status: "empty" });
          return;
        }

        const pageEntries = await Promise.all(
          result.reports.map(async (report) => {
            try {
              const page = await getReadingPage(
                report.page_id,
                sessionId,
                report.page_revision_id,
              );
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
        setState({
          status: "ready",
          reports: result.reports,
          pages,
          partial:
            pages.size !== result.reports.length ||
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

  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="session-reading-reports-title"
    >
      <h2
        id="session-reading-reports-title"
        className="text-2xl font-extrabold text-ink"
      >
        Báo cáo đọc theo từng trang
      </h2>
      {state.status === "loading" ? (
        <div
          aria-busy="true"
          className="rounded-card border border-border p-5 text-muted"
        >
          Đang tải báo cáo đã lưu...
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
            <StatusMessage title="Báo cáo chỉ tải được một phần" tone="warning">
              Một số trang hoặc nội dung revision lịch sử chưa tải được. Các báo
              cáo đã lưu vẫn được giữ bên dưới.
            </StatusMessage>
          ) : null}
          <ol className="flex flex-col gap-4">
            {state.reports.map((report) => (
              <li key={report.report_id}>
                <ReportCard
                  report={report}
                  page={state.pages.get(
                    reportKey(report.page_id, report.page_revision_id),
                  )}
                />
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {state.status !== "loading" && state.status !== "empty" ? (
        <Button
          className="sm:self-start"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" /> Thử tải lại báo
          cáo
        </Button>
      ) : null}
    </section>
  );
}
