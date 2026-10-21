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
import {
  formatHistoryDateTime,
  formatHistoryDuration,
  formatPercent,
  historyStateLabel,
} from "@/lib/utils/report-mappers";
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
  | { readonly status: "unavailable" }
  | { readonly status: "error" };

export function SessionDetailScreen({
  sessionId,
  requestedChildId,
  page = 1,
}: {
  readonly sessionId: string;
  readonly requestedChildId?: string;
  readonly page?: number;
}) {
  const { childService, sessionService } = useReportServices();
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
          sessionService.getBook(sessionId),
        ]);
        if (book.id !== detail.book_id || child.id !== detail.child_id)
          throw new Error("Invalid historical book response");
        if (active) setState({ status: "ready", detail, child, book });
      } catch (error) {
        if (active)
          setState({
            status:
              isServiceError(error) && error.status === 404
                ? "not-found"
                : isServiceError(error) &&
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
  }, [childService, requestKey, sessionId, sessionService]);

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
  if (state.status === "unavailable")
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <h1 className="text-heading font-extrabold text-ink">
          Dữ liệu đang chờ bổ sung
        </h1>
        <StatusMessage tone="info">
          Dữ liệu của mục này chưa sẵn sàng theo định dạng hiện tại. Không có dữ
          liệu mẫu thay thế.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" /> Thử lại
        </Button>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/children"
          variant="secondary"
        >
          Quản lý hồ sơ bé
        </ButtonLink>
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
  const rangeIsPartial =
    detail.selected_range_pages != null &&
    (detail.pages_completed == null ||
      detail.pages_completed < detail.selected_range_pages);
  const returnPage =
    requestedChildId === detail.child_id &&
    Number.isSafeInteger(page) &&
    page >= 1 &&
    page <= 100000
      ? page
      : null;
  const returnHref = `/sessions?childId=${encodeURIComponent(detail.child_id)}${returnPage === null ? "" : `&page=${returnPage}`}`;
  const availability = detail.availability;
  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 sm:gap-8">
      <ReportPageHeader
        action={
          <ButtonLink
            className="sm:w-auto"
            href={returnHref}
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
            ? rangeIsPartial
              ? "Buổi đọc đã lưu"
              : "Buổi đọc đã hoàn thành"
            : detail.state === "ABORTED"
              ? "Buổi đọc đã dừng"
              : `Buổi đọc: ${historyStateLabel(detail.state)}`
        }
      />
      {rangeIsPartial ? (
        <StatusMessage title="Một phần phạm vi chưa hoàn thành" tone="info">
          Phạm vi đã chọn có {detail.selected_range_pages} trang, nhưng mới có{" "}
          {detail.pages_completed ?? 0} trang được xác nhận hoàn thành. Lịch sử
          vẫn được giữ nguyên và không tính các trang chưa đọc là hoàn thành.
        </StatusMessage>
      ) : null}
      {detail.state !== "FINISHED" && detail.state !== "ABORTED" ? (
        <StatusMessage title="Dữ liệu đang dở dang" tone="warning">
          Buổi đọc chưa kết thúc nên thời lượng, chỉ số trôi chảy và báo cáo có
          thể chưa có.
        </StatusMessage>
      ) : null}
      {detail.state === "FINISHED" && detail.ended_at === null ? (
        <StatusMessage tone="info">
          Buổi đọc đã hoàn thành nhưng chưa lưu giờ kết thúc; chưa có dữ liệu
          thời lượng.
        </StatusMessage>
      ) : null}
      <dl className="grid gap-3 text-label text-muted sm:grid-cols-2">
        <div>
          <dt className="font-bold">Bắt đầu (giờ Việt Nam)</dt>
          <dd>{formatHistoryDateTime(detail.started_at)}</dd>
        </div>
        <div>
          <dt className="font-bold">Kết thúc (giờ Việt Nam)</dt>
          <dd>
            {detail.ended_at === null
              ? "Chưa lưu giờ kết thúc"
              : formatHistoryDateTime(detail.ended_at)}
          </dd>
        </div>
      </dl>
      {availability.fluency === "unsupported" ||
      availability.fluency === "partial" ? (
        <StatusMessage tone="info">
          Có dữ liệu đánh giá đã lưu nhưng định dạng chưa được hỗ trợ đầy đủ.
          Chỉ hiển thị điểm/chỉ số đọc được, không tự quy đổi dữ liệu thiếu.
        </StatusMessage>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ["Thời lượng phiên", formatHistoryDuration(detail.duration_ms)],
          [
            "Trang trong phạm vi",
            detail.selected_range_pages == null
              ? "Chưa ghi nhận"
              : `${detail.selected_range_pages} trang`,
          ],
          [
            "Trang đã xác nhận hoàn thành",
            detail.pages_completed == null
              ? "Chưa ghi nhận"
              : `${detail.pages_completed} trang`,
          ],
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
              ? availability.fluency === "absent"
                ? "Chưa đánh giá"
                : "Chưa có điểm hiển thị"
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
              ID đã chọn trong phiên và ID tham chiếu ghi nhận trong sự kiện;
              không thay bằng revision hiện tại của trang.
            </p>
          </div>
        </div>
        <dl className="grid gap-4 text-label sm:grid-cols-2">
          <div>
            <dt className="font-extrabold text-ink">Đã chọn</dt>
            {detail.selected_page_revision_ids.length === 0 ? (
              <dd className="mt-1 text-muted">Chưa ghi nhận</dd>
            ) : null}
            {detail.selected_page_revision_ids.map((id) => (
              <dd className="mt-1 break-all text-muted" key={id}>
                <code>{id}</code>
              </dd>
            ))}
          </div>
          <div>
            <dt className="font-extrabold text-ink">Tham chiếu</dt>
            {detail.reference_page_revision_ids.length === 0 ? (
              <dd className="mt-1 text-muted">Chưa ghi nhận</dd>
            ) : null}
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
        {availability.events === "unsupported" ||
        availability.events === "partial" ? (
          <StatusMessage tone="info">
            Có sự kiện đã lưu nhưng{" "}
            {availability.events === "partial" ? "một phần" : "định dạng"} chưa
            được hỗ trợ. Không tự coi đây là lỗi đọc đã xác nhận.
          </StatusMessage>
        ) : null}
        {detail.events.length > 0 || availability.events === "absent" ? (
          <SessionEventList events={detail.events} />
        ) : null}
      </Card>
      <Card className="bg-white">
        <h2 className="text-2xl font-extrabold text-ink">Câu hỏi đọc hiểu</h2>
        {availability.comprehension === "unsupported" ||
        availability.comprehension === "partial" ? (
          <StatusMessage tone="info">
            Có dữ liệu đọc hiểu đã lưu nhưng một phần định dạng chưa được hỗ
            trợ.{" "}
            {availability.comprehension === "partial"
              ? "Nội dung đọc được vẫn hiển thị bên dưới."
              : "Chưa thể hiển thị nội dung của nhóm này."}
          </StatusMessage>
        ) : null}
        {detail.comprehension.length === 0 &&
        availability.comprehension === "absent" ? (
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
                  Độ khó đã lưu: {question.difficulty ?? "Chưa ghi nhận"}
                </p>
                <p className="mt-2 text-label text-muted">
                  {answer
                    ? `Trả lời: ${answer.submitted_answer} · ${answer.is_correct === true ? "Đúng" : answer.is_correct === false ? "Chưa đúng" : "Chưa chấm"}`
                    : question.answered
                      ? "Đã lưu câu trả lời nhưng định dạng chưa được hỗ trợ."
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
