"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";

import { AdminLoading } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useBookContentReportService } from "@/hooks/use-book-content-report-service";
import { isServiceError } from "@/lib/api/service-error";
import type {
  BookContentIssueType,
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
  OTHER: "Lỗi khác",
};

const statusLabels: Record<BookContentReportStatus, string> = {
  OPEN: "Đã tiếp nhận",
  UNDER_REVIEW: "Đang kiểm tra",
  RESOLVED: "Đã xử lý",
  REJECTED: "Không đủ căn cứ",
};

export function ParentBookReportsScreen() {
  const reportService = useBookContentReportService();
  const [items, setItems] = useState<BookContentReportDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"auth" | "forbidden" | "safe" | null>(null);
  const limit = 20;

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
    void load();
  }, [load]);

  const first = total > 0 ? offset + 1 : 0;
  const last = Math.min(offset + limit, total);

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-primary">ViRead · Phụ huynh</p>
          <h1 className="mt-1 text-heading font-extrabold text-ink">
            Báo cáo chất lượng sách
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Theo dõi các vấn đề ba mẹ đã gửi và trạng thái xử lý của Admin.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void load()} variant="secondary">
            <RefreshCw aria-hidden className="size-4" />
            Tải lại
          </Button>
          <Link
            className="inline-flex min-h-12 items-center rounded-control bg-primary px-4 font-bold text-white hover:bg-primary-hover"
            href="/books"
          >
            Thư viện sách
          </Link>
        </div>
      </header>

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
        <div className="grid gap-4">
          {items.map((item) => (
            <article
              className="rounded-card border border-border bg-white p-4 sm:p-5"
              key={item.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-bold text-ink">{item.book_title}</h2>
                  <p className="mt-1 text-sm text-muted">
                    {issueLabels[item.issue_type]}
                    {item.page_number !== null
                      ? ` · Trang ${item.page_number}`
                      : " · Toàn bộ sách"}
                  </p>
                </div>
                <span className="rounded-full bg-sky px-3 py-1 text-sm font-bold text-primary-hover">
                  {statusLabels[item.status]}
                </span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink">
                {item.description}
              </p>
              {item.reported_text ? (
                <p className="mt-2 text-sm text-muted">
                  Nội dung nghi ngờ: <span className="font-semibold text-ink">{item.reported_text}</span>
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
                <span>
                  Mã báo cáo: <span className="font-mono">{item.id}</span>
                </span>
                <time dateTime={item.created_at}>
                  {new Intl.DateTimeFormat("vi-VN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(item.created_at))}
                </time>
              </div>
              {item.scan_run_id ? (
                <p className="mt-2 break-all text-xs text-muted">
                  Mã yêu cầu kiểm tra toàn sách: <span className="font-mono">{item.scan_run_id}</span>
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}

      {total > limit ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            Đang hiển thị {first}–{last} / {total} báo cáo
          </p>
          <div className="flex gap-2">
            <Button
              disabled={offset === 0 || loading}
              onClick={() => setOffset((value) => Math.max(0, value - limit))}
              variant="secondary"
            >
              Trước
            </Button>
            <Button
              disabled={offset + limit >= total || loading}
              onClick={() => setOffset((value) => value + limit)}
              variant="secondary"
            >
              Tiếp
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
