"use client";

import { useCallback, useEffect, useState } from "react";

import { RefreshCw } from "lucide-react";

import { AdminLoading } from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useBookContentReportService } from "@/hooks/use-book-content-report-service";
import { isServiceError } from "@/lib/api/service-error";
import type {
  BookContentIssueType,
  BookContentReportDetailDTO,
  BookContentReportDTO,
  BookContentReportStatus,
} from "@/types/book-content-quality";

const issueLabels: Record<BookContentIssueType, string> = {
  BOOK_METADATA_ERROR: "Sai thông tin sách",
  SPELLING_ERROR: "Sai chính tả",
  MISSING_CONTENT: "Thiếu từ hoặc câu",
  OCR_MISMATCH: "Nội dung không khớp ảnh gốc",
  IMAGE_QUALITY_ERROR: "Ảnh trang sách bị lỗi",
  DUPLICATE_PAGE: "Trang có dấu hiệu bị trùng",
  PAGE_ORDER_ERROR: "Trang sai thứ tự",
  CHILD_SAFETY_CONCERN: "Nội dung có dấu hiệu không phù hợp cho trẻ em",
  COPYRIGHT_CONCERN: "Nghi ngại bản quyền / quyền sử dụng",
  OTHER: "Lỗi khác",
};

const statusLabels: Record<BookContentReportStatus, string> = {
  OPEN: "Đã tiếp nhận",
  UNDER_REVIEW: "Đang kiểm tra",
  RESOLVED: "Đã xử lý",
  REJECTED: "Không đủ căn cứ",
};

const statusBadgeClasses: Record<BookContentReportStatus, string> = {
  OPEN: "border border-sky-200 bg-sky text-primary-hover",
  UNDER_REVIEW: "border border-amber-300 bg-amber-50 text-amber-950",
  RESOLVED: "border border-emerald-200 bg-emerald-50 text-emerald-900",
  REJECTED: "border border-rose-200 bg-rose-50 text-rose-900",
};

export function ParentBookReportsScreen() {
  const reportService = useBookContentReportService();
  const [items, setItems] = useState<BookContentReportDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"auth" | "forbidden" | "safe" | null>(
    null,
  );
  const [selectedDetail, setSelectedDetail] =
    useState<BookContentReportDetailDTO | null>(null);
  const [detailError, setDetailError] = useState<{
    reportId: string;
    message: string;
  } | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const limit = 20;

  async function toggleDetail(reportId: string) {
    if (selectedDetail?.id === reportId) {
      setSelectedDetail(null);
      setDetailError(null);
      return;
    }
    setLoadingDetailId(reportId);
    setDetailError(null);
    try {
      setSelectedDetail(await reportService.getMine(reportId));
    } catch {
      setDetailError({
        reportId,
        message: "Không thể tải chi tiết phản hồi của báo cáo này.",
      });
    } finally {
      setLoadingDetailId(null);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await reportService.listMine({ limit, offset });
      setItems(page.items);
      setTotal(page.total);
    } catch (cause) {
      setItems([]);
      setTotal(0);
      setError(
        isServiceError(cause) && cause.code === "AUTH_REQUIRED"
          ? "auth"
          : isServiceError(cause) && cause.code === "FORBIDDEN"
            ? "forbidden"
            : "safe",
      );
    } finally {
      setLoading(false);
    }
  }, [offset, reportService]);

  useEffect(() => {
    // Defer the fetch kickoff so the effect does not synchronously schedule
    // state updates during the effect phase.
    const timer = globalThis.setTimeout(() => {
      void load();
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [load]);

  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-3.5 md:gap-6">
      <PageHeader
        action={
          <>
            <Button
              className="min-h-11! w-auto px-3! text-xs md:px-4! md:text-sm"
              fullWidth={false}
              onClick={() => void load()}
              size="compact"
              variant="secondary"
            >
              <RefreshCw aria-hidden className="size-4" />
              Tải lại
            </Button>
            <ButtonLink
              className="min-h-11! w-auto px-3! text-xs md:px-4! md:text-sm"
              fullWidth={false}
              href="/books"
              size="compact"
            >
              Thư viện sách
            </ButtonLink>
          </>
        }
        actionClassName="md:w-auto"
        description="Theo dõi các vấn đề ba mẹ đã gửi và trạng thái xử lý của Admin."
        eyebrow="ViRead · Phụ huynh"
        title="Báo cáo chất lượng sách"
      />

      {loading ? (
        <AdminLoading label="Đang tải báo cáo của ba mẹ…" />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? "Phiên đăng nhập đã hết hạn"
              : error === "forbidden"
                ? "Tài khoản không có quyền xem báo cáo"
                : "Không thể tải báo cáo"
          }
        >
          Vui lòng tải lại trang hoặc đăng nhập lại trước khi tiếp tục.
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          title="Chưa có báo cáo nào"
          description="Khi phát hiện thông tin sách hoặc nội dung trang chưa chính xác, ba mẹ có thể gửi báo cáo từ trang chi tiết sách."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 min-[640px]:grid-cols-2 min-[640px]:gap-4 md:grid-cols-1 md:gap-4">
          {items.map((item) => (
            <article
              className="rounded-card border border-border bg-white p-3.5 min-[640px]:p-4 md:p-5"
              key={item.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-2.5 md:gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="break-words text-base font-bold text-ink md:text-lg">
                    {item.book_title}
                  </h2>
                  <p className="mt-1 text-xs text-muted md:text-sm">
                    {issueLabels[item.issue_type]}
                    {item.page_number !== null
                      ? ` · Trang ${item.page_number}`
                      : " · Toàn bộ sách"}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold md:px-3 md:py-1 md:text-sm ${statusBadgeClasses[item.status]}`}
                >
                  {statusLabels[item.status]}
                </span>
              </div>
              <p className="mt-2 break-words whitespace-pre-wrap text-xs leading-5 text-ink md:mt-3 md:text-sm md:leading-6">
                {item.description}
              </p>
              {item.reported_text ? (
                <p className="mt-2 break-words text-xs text-muted md:text-sm">
                  Nội dung nghi ngờ:{" "}
                  <span className="font-semibold text-ink">
                    {item.reported_text}
                  </span>
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5 text-xs text-muted md:mt-4 md:pt-3">
                <span className="min-w-0 max-w-full truncate" title={item.id}>
                  Mã báo cáo: <span className="font-mono">{item.id}</span>
                </span>
                <time className="shrink-0" dateTime={item.created_at}>
                  {new Intl.DateTimeFormat("vi-VN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(item.created_at))}
                </time>
              </div>
              {item.scan_run_id ? (
                <p
                  className="mt-1.5 truncate text-xs text-muted md:mt-2"
                  title={item.scan_run_id}
                >
                  Mã yêu cầu kiểm tra toàn sách:{" "}
                  <span className="font-mono">{item.scan_run_id}</span>
                </p>
              ) : null}
              <div className="mt-3">
                <Button
                  className="min-h-11! px-3! text-xs"
                  disabled={loadingDetailId === item.id}
                  fullWidth={false}
                  onClick={() => void toggleDetail(item.id)}
                  type="button"
                  variant="secondary"
                >
                  {selectedDetail?.id === item.id
                    ? "Ẩn phản hồi Admin"
                    : "Xem chi tiết & phản hồi Admin"}
                </Button>
              </div>
              {detailError?.reportId === item.id && loadingDetailId === null ? (
                <p className="mt-2 text-xs text-danger" role="alert">
                  {detailError.message}
                </p>
              ) : null}
              {selectedDetail?.id === item.id ? (
                <div
                  className="mt-3 rounded-control border border-border bg-canvas p-3 text-sm"
                  data-testid="parent-report-detail"
                >
                  <p className="font-bold text-ink">Phản hồi từ Admin</p>
                  <p className="mt-1 text-muted">
                    {selectedDetail.admin_resolution_note ??
                      "Admin đang tiếp nhận và chưa có ghi chú xử lý cuối cùng."}
                  </p>
                  {selectedDetail.history.length ? (
                    <ul className="mt-2 grid gap-1 border-t border-border pt-2 text-xs text-muted">
                      {selectedDetail.history.map((entry, idx) => (
                        <li key={`${entry.created_at}:${idx}`}>
                          <span className="font-semibold text-ink">
                            {statusLabels[entry.to_status]}
                          </span>
                          {entry.note ? ` · ${entry.note}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

      <PaginationBar
        ariaLabel="Phân trang báo cáo chất lượng sách"
        compact
        disabled={loading}
        itemLabel="báo cáo"
        onPageChange={(nextPage) => setOffset((nextPage - 1) * limit)}
        page={currentPage}
        pageSize={limit}
        total={total}
      />
    </section>
  );
}
