"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/common/button";
import { useBookContentReportService } from "@/hooks/use-book-content-report-service";
import type {
  BookContentIssueType,
  BookContentReportDetailDTO,
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

interface BookContentReportDialogProps {
  bookId: string;
  bookTitle: string;
  pageId: string | null;
  pageNumber: number | null;
  onClose: () => void;
}

export function BookContentReportDialog({
  bookId,
  bookTitle,
  pageId,
  pageNumber,
  onClose,
}: BookContentReportDialogProps) {
  const reportService = useBookContentReportService();
  const idempotencyKeyRef = useRef<string | null>(null);
  const [issueType, setIssueType] =
    useState<BookContentIssueType>("SPELLING_ERROR");
  const [description, setDescription] = useState("");
  const [reportedText, setReportedText] = useState("");
  const [suggestedCorrection, setSuggestedCorrection] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<BookContentReportDetailDTO | null>(
    null,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || created) return;
    const normalizedDescription = description.trim();
    if (!normalizedDescription) {
      setError("Vui lòng mô tả vấn đề để Admin có thể kiểm tra.");
      return;
    }
    if (!idempotencyKeyRef.current) {
      if (typeof globalThis.crypto?.randomUUID !== "function") {
        setError("Trình duyệt hiện tại không hỗ trợ gửi báo cáo an toàn.");
        return;
      }
      idempotencyKeyRef.current = globalThis.crypto.randomUUID();
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await reportService.create(bookId, {
        idempotency_key: idempotencyKeyRef.current,
        issue_type: issueType,
        description: normalizedDescription,
        page_id: pageId ?? undefined,
        reported_text: reportedText.trim() || undefined,
        suggested_correction: suggestedCorrection.trim() || undefined,
      });
      setCreated(result);
    } catch {
      setError(
        "Chưa thể gửi báo cáo. Dữ liệu chưa được xác nhận lưu thành công; vui lòng thử lại.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
      role="presentation"
    >
      <section
        aria-labelledby="book-content-report-title"
        aria-modal="true"
        className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-card bg-white p-5 shadow-2xl sm:rounded-card sm:p-7"
        role="dialog"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold text-primary">
              ViRead · Góp ý chất lượng
            </p>
            <h2
              className="mt-1 text-xl font-extrabold text-ink"
              id="book-content-report-title"
            >
              {pageId ? "Báo lỗi trang sách" : "Báo lỗi sách"}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {bookTitle}
              {pageNumber !== null
                ? ` · Trang ${pageNumber}`
                : " · Toàn bộ sách"}
            </p>
          </div>
          <button
            aria-label="Đóng biểu mẫu"
            className="min-h-10 rounded-control px-3 font-bold text-muted hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            Đóng
          </button>
        </div>

        {created ? (
          <div className="space-y-4" role="status">
            <div className="rounded-control border border-emerald-200 bg-emerald-50 p-4">
              <p className="font-bold text-emerald-900">
                Báo cáo đã được lưu thành công.
              </p>
              <p className="mt-1 text-sm text-emerald-800">
                ViRead đã ghi nhận yêu cầu kiểm tra toàn bộ cuốn sách. Admin sẽ
                xem báo cáo và kết quả kiểm tra trước khi quyết định chỉnh sửa.
              </p>
            </div>
            <dl className="grid gap-2 rounded-control border border-border p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted">Mã báo cáo</dt>
                <dd className="break-all font-mono font-bold text-ink">
                  {created.id}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Trạng thái</dt>
                <dd className="font-bold text-ink">{created.status}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted">Yêu cầu kiểm tra</dt>
                <dd className="break-all font-mono text-ink">
                  {created.scan_run_id ??
                    "Đã lưu báo cáo; chưa có mã scan trả về"}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-3">
              <Button onClick={onClose}>Hoàn tất</Button>
              <Link
                className="inline-flex min-h-12 items-center rounded-control border border-border px-4 font-bold text-primary hover:bg-canvas"
                href="/book-reports"
              >
                Xem báo cáo của tôi
              </Link>
            </div>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label
                className="mb-2 block text-sm font-bold text-ink"
                htmlFor="book-report-issue"
              >
                Loại vấn đề
              </label>
              <select
                className="min-h-12 w-full rounded-control border border-border bg-white px-3 text-ink focus-visible:outline-3 focus-visible:outline-primary"
                id="book-report-issue"
                onChange={(event) =>
                  setIssueType(event.target.value as BookContentIssueType)
                }
                value={issueType}
              >
                {Object.entries(issueLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                className="mb-2 block text-sm font-bold text-ink"
                htmlFor="book-report-description"
              >
                Mô tả vấn đề <span className="text-danger">*</span>
              </label>
              <textarea
                className="min-h-28 w-full rounded-control border border-border bg-white p-3 text-ink focus-visible:outline-3 focus-visible:outline-primary"
                id="book-report-description"
                maxLength={4000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Mô tả vị trí hoặc nội dung mà ba mẹ cho rằng chưa chính xác…"
                required
                value={description}
              />
              <p className="mt-1 text-right text-xs text-muted">
                {description.length}/4000
              </p>
            </div>

            <div>
              <label
                className="mb-2 block text-sm font-bold text-ink"
                htmlFor="book-report-text"
              >
                Đoạn nội dung nghi ngờ (không bắt buộc)
              </label>
              <textarea
                className="min-h-20 w-full rounded-control border border-border bg-white p-3 text-ink focus-visible:outline-3 focus-visible:outline-primary"
                id="book-report-text"
                maxLength={1200}
                onChange={(event) => setReportedText(event.target.value)}
                placeholder="Nhập từ hoặc câu có vấn đề…"
                value={reportedText}
              />
            </div>

            <div>
              <label
                className="mb-2 block text-sm font-bold text-ink"
                htmlFor="book-report-correction"
              >
                Nội dung đề xuất sửa (không bắt buộc)
              </label>
              <textarea
                className="min-h-20 w-full rounded-control border border-border bg-white p-3 text-ink focus-visible:outline-3 focus-visible:outline-primary"
                id="book-report-correction"
                maxLength={1200}
                onChange={(event) => setSuggestedCorrection(event.target.value)}
                placeholder="Đề xuất cách viết đúng nếu ba mẹ đã xác định được…"
                value={suggestedCorrection}
              />
            </div>

            {error ? (
              <p
                className="rounded-control bg-red-50 p-3 text-sm font-semibold text-danger"
                role="alert"
              >
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-4">
              <Button
                disabled={submitting}
                onClick={onClose}
                type="button"
                variant="secondary"
              >
                Hủy
              </Button>
              <Button
                disabled={submitting || !description.trim()}
                type="submit"
              >
                {submitting ? "Đang gửi báo cáo…" : "Gửi báo cáo"}
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
