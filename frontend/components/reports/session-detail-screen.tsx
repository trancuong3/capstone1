"use client";

import { ArrowLeft, BookOpenText, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ReportPageHeader } from "@/components/reports/report-page-header";
import { SessionEventList } from "@/components/reports/session-event-list";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import { formatDuration, formatPercent } from "@/lib/utils/report-mappers";
import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type { ReadingSessionDetailDTO } from "@/types/reading";

type DetailState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly detail: ReadingSessionDetailDTO;
      readonly child: ChildProfileDTO;
      readonly book: BookDetailDTO;
    }
  | { readonly status: "not-found" }
  | { readonly status: "error" };

export function SessionDetailScreen({
  sessionId,
}: {
  readonly sessionId: string;
}) {
  const { bookService, childService, sessionService } = useReportServices();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<DetailState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const detail = await sessionService.get(sessionId);
        const [child, book] = await Promise.all([
          childService.get(detail.child_id),
          bookService.get(detail.book_id),
        ]);
        if (active) setState({ status: "ready", detail, child, book });
      } catch (error) {
        if (active)
          setState({
            status:
              isServiceError(error) && error.status === 404
                ? "not-found"
                : "error",
          });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [bookService, childService, requestKey, sessionId, sessionService]);

  if (state.status === "loading")
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải chi tiết buổi đọc"
        className="mx-auto flex max-w-[1120px] flex-col gap-6"
      >
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-72 rounded-card" />
      </section>
    );
  if (state.status === "not-found")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          Không tìm thấy buổi đọc
        </h1>
        <StatusMessage tone="error">
          Buổi đọc không tồn tại hoặc không thuộc tài khoản hiện tại.
        </StatusMessage>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/sessions"
          variant="secondary"
        >
          <ArrowLeft aria-hidden="true" className="size-5" />
          Về lịch sử
        </ButtonLink>
      </div>
    );
  if (state.status === "error")
    return (
      <div className="mx-auto flex max-w-[960px] flex-col gap-4">
        <StatusMessage title="Chưa tải được chi tiết" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </div>
    );

  const { detail } = state;
  const metrics = detail.fluency_assessment?.metrics;
  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 sm:gap-8">
      <ReportPageHeader
        action={
          <ButtonLink
            className="sm:w-auto"
            href={`/sessions?childId=${encodeURIComponent(state.child.id)}`}
            variant="secondary"
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
            Lịch sử
          </ButtonLink>
        }
        description={`${state.child.alias} · ${state.book.title}`}
        eyebrow="Chi tiết buổi đọc"
        title={
          detail.state === "FINISHED"
            ? "Buổi đọc đã hoàn thành"
            : "Buổi đọc chưa hoàn tất"
        }
      />
      {detail.state !== "FINISHED" ? (
        <StatusMessage title="Dữ liệu đang dở dang" tone="warning">
          Buổi đọc chưa kết thúc nên thời lượng, chỉ số trôi chảy và báo cáo có
          thể chưa có.
        </StatusMessage>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Thời lượng", formatDuration(detail.duration_ms)],
          ["Độ chính xác", formatPercent(metrics?.accuracy_percent ?? null)],
          [
            "Tốc độ đọc",
            metrics?.reading_wpm == null
              ? "Chưa đủ dữ liệu"
              : `${metrics.reading_wpm} từ/phút`,
          ],
          [
            "Điểm trôi chảy",
            detail.fluency_assessment?.score == null
              ? "Chưa đánh giá"
              : String(detail.fluency_assessment.score),
          ],
        ].map(([label, value]) => (
          <Card className="gap-2 bg-white p-5 sm:p-6" key={label}>
            <p className="text-label font-bold text-muted">{label}</p>
            <p className="text-2xl font-extrabold text-ink">{value}</p>
          </Card>
        ))}
      </div>
      <Card className="bg-white">
        <div className="flex items-start gap-3">
          <BookOpenText
            aria-hidden="true"
            className="mt-1 size-6 text-primary"
          />
          <div>
            <h2 className="text-2xl font-extrabold text-ink">
              Revision đã dùng trong buổi đọc
            </h2>
            <p className="mt-1 text-label text-muted">
              Giữ nguyên bản lịch sử, không thay bằng revision hiện tại của
              trang.
            </p>
          </div>
        </div>
        <dl className="grid gap-4 text-label sm:grid-cols-2">
          <div>
            <dt className="font-extrabold text-ink">Đã chọn</dt>
            {detail.selected_page_revision_ids.map((id) => (
              <dd className="mt-1 break-all text-muted" key={id}>
                <code>{id}</code>
              </dd>
            ))}
          </div>
          <div>
            <dt className="font-extrabold text-ink">Tham chiếu</dt>
            {detail.reference_page_revision_ids.map((id) => (
              <dd className="mt-1 break-all text-muted" key={id}>
                <code>{id}</code>
              </dd>
            ))}
          </div>
        </dl>
      </Card>
      <Card className="bg-white">
        <h2 className="text-2xl font-extrabold text-ink">
          Sự kiện trong buổi đọc
        </h2>
        <SessionEventList events={detail.events} />
      </Card>
      <Card className="bg-white">
        <h2 className="text-2xl font-extrabold text-ink">Câu hỏi đọc hiểu</h2>
        {detail.comprehension.length === 0 ? (
          <p className="rounded-control bg-sky p-5 text-body text-muted">
            Buổi đọc này không có câu hỏi đọc hiểu.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {detail.comprehension.map(({ answer, question }) => (
              <li
                className="rounded-control border border-border p-4"
                key={question.id}
              >
                <p className="font-extrabold text-ink">{question.prompt}</p>
                <p className="mt-2 text-label text-muted">
                  {answer
                    ? `Trả lời: ${answer.submitted_answer} · ${answer.is_correct === true ? "Đúng" : answer.is_correct === false ? "Chưa đúng" : "Chưa chấm"}`
                    : "Chưa có câu trả lời"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
