"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { RefreshCw, Search } from "lucide-react";

import {
  AdminLoading,
  AdminPageHeader,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type {
  BookContentIssueType,
  BookContentReportDetailDTO,
  BookContentReportStatus,
  BookQualityBookDetailDTO,
  BookQualityBookPageDTO,
  BookQualityFindingDTO,
  BookQualityFindingStatus,
  BookQualityReportAdminPageDTO,
  BookQualityScanDetailDTO,
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

const reportStatusLabels: Record<BookContentReportStatus, string> = {
  OPEN: "Mới tiếp nhận",
  UNDER_REVIEW: "Đang kiểm tra",
  RESOLVED: "Đã giải quyết",
  REJECTED: "Đã từ chối",
};

const findingStatusLabels: Record<BookQualityFindingStatus, string> = {
  NEEDS_REVIEW: "Cần xem xét",
  CONFIRMED: "Đã xác nhận",
  DISMISSED: "Đã bỏ qua",
  RESOLVED: "Đã sửa",
  STALE: "Revision đã cũ",
};

const scanStatusLabels: Record<string, string> = {
  QUEUED: "Đang chờ",
  RUNNING: "Đang quét",
  COMPLETED: "Hoàn tất",
  PARTIAL: "Hoàn tất một phần",
  FAILED: "Thất bại",
};

const pageStatusLabels: Record<string, string> = {
  QUEUED: "Đang chờ",
  RUNNING: "Đang kiểm tra",
  COMPLETED: "Đã kiểm tra",
  NOT_SCANNABLE: "Không đủ điều kiện",
  STALE: "Revision đã thay đổi",
  FAILED: "Lỗi kiểm tra",
};

const aiStatusLabels: Record<string, string> = {
  PENDING: "Chưa chạy",
  COMPLETED: "Đã phân tích văn bản",
  UNAVAILABLE: "Ollama không khả dụng",
  FAILED: "AI kiểm tra thất bại",
  SKIPPED: "Không áp dụng",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  if (isServiceError(error) && error.code === "AUTH_REQUIRED") {
    return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  }
  if (isServiceError(error) && error.code === "FORBIDDEN") {
    return "Tài khoản hiện tại không có quyền Admin.";
  }
  return "Không thể hoàn tất thao tác. Vui lòng tải lại dữ liệu và thử lại.";
}

function OcrLink({
  bookId,
  finding,
  children,
}: {
  bookId: string | null;
  finding: Pick<BookQualityFindingDTO, "page_id" | "page_revision_id">;
  children: React.ReactNode;
}) {
  if (!bookId || !finding.page_id) {
    return <span className="text-sm text-muted">Trang không còn khả dụng</span>;
  }
  const query = finding.page_revision_id
    ? `?revisionId=${encodeURIComponent(finding.page_revision_id)}`
    : "";
  return (
    <Link
      className="inline-flex min-h-10 items-center rounded-control border border-border px-3 text-sm font-bold text-primary hover:bg-canvas"
      href={`/admin/books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(finding.page_id)}${query}`}
    >
      {children}
    </Link>
  );
}

function FindingCard({
  finding,
  bookId,
  busy,
  onUpdate,
}: {
  finding: BookQualityFindingDTO;
  bookId: string | null;
  busy: boolean;
  onUpdate: (
    finding: BookQualityFindingDTO,
    status: Exclude<BookQualityFindingStatus, "STALE">,
  ) => void;
}) {
  return (
    <article className="rounded-control border border-border bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="font-bold text-ink">
          Trang {finding.page_number} · {finding.issue_type}
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-bold">
          <span className="rounded-full bg-canvas px-3 py-1">
            {finding.severity}
          </span>
          <span className="rounded-full bg-sky px-3 py-1 text-primary-hover">
            {findingStatusLabels[finding.status]}
          </span>
        </div>
      </div>
      <blockquote className="mt-3 whitespace-pre-wrap rounded-control bg-canvas p-3 text-sm leading-6 text-ink">
        {finding.original_excerpt || "(Văn bản trống)"}
      </blockquote>
      <p className="mt-2 text-sm leading-6 text-muted">{finding.explanation}</p>
      {finding.suggested_correction ? (
        <p className="mt-2 text-sm text-ink">
          Đề xuất: <span className="font-semibold">{finding.suggested_correction}</span>
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>
          Nguồn: {finding.detection_source === "RULE" ? "Quy tắc xác định" : "Ollama · chỉ phân tích văn bản"}
        </span>
        {finding.model_name ? <span>Model: {finding.model_name}</span> : null}
        {finding.confidence !== null ? (
          <span>Confidence: {(finding.confidence * 100).toFixed(0)}%</span>
        ) : null}
        {finding.page_revision_id ? (
          <span className="font-mono">Revision: {finding.page_revision_id}</span>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <OcrLink bookId={bookId} finding={finding}>
          Kiểm tra trang trong OCR
        </OcrLink>
        {finding.status === "NEEDS_REVIEW" ? (
          <>
            <Button
              className="h-10 w-auto px-3 text-sm"
              disabled={busy}
              onClick={() => onUpdate(finding, "CONFIRMED")}
              variant="secondary"
            >
              Xác nhận cảnh báo
            </Button>
            <Button
              className="h-10 w-auto px-3 text-sm"
              disabled={busy}
              onClick={() => onUpdate(finding, "DISMISSED")}
              variant="secondary"
            >
              Bỏ qua
            </Button>
          </>
        ) : finding.status === "CONFIRMED" ? (
          <Button
            className="h-10 w-auto px-3 text-sm"
            disabled={busy}
            onClick={() => onUpdate(finding, "RESOLVED")}
            variant="secondary"
          >
            Đã sửa và xác minh revision
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function AdminBookContentQualityScreen() {
  const { bookContentQuality } = useAdminServices();
  const [reports, setReports] = useState<BookQualityReportAdminPageDTO | null>(
    null,
  );
  const [books, setBooks] = useState<BookQualityBookPageDTO | null>(null);
  const [loadingReports, setLoadingReports] = useState(true);
  const [loadingBooks, setLoadingBooks] = useState(true);
  const [reportError, setReportError] = useState<string | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [createdAfter, setCreatedAfter] = useState("");
  const [createdBefore, setCreatedBefore] = useState("");
  const [statusFilter, setStatusFilter] = useState<BookContentReportStatus | "">("");
  const [issueFilter, setIssueFilter] = useState<BookContentIssueType | "">("");
  const [bookFilter, setBookFilter] = useState("");
  const [reportOffset, setReportOffset] = useState(0);
  const [bookSearch, setBookSearch] = useState("");
  const [bookOffset, setBookOffset] = useState(0);
  const [selectedReport, setSelectedReport] =
    useState<BookContentReportDetailDTO | null>(null);
  const [selectedBook, setSelectedBook] =
    useState<BookQualityBookDetailDTO | null>(null);
  const [selectedScan, setSelectedScan] =
    useState<BookQualityScanDetailDTO | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const reportRequestId = useRef(0);
  const bookRequestId = useRef(0);
  const reportLimit = 10;
  const bookLimit = 10;

  const loadReports = useCallback(async () => {
    const requestId = ++reportRequestId.current;
    setLoadingReports(true);
    setReportError(null);
    try {
      const next = await bookContentQuality.listReports({
        status: statusFilter || undefined,
        issue_type: issueFilter || undefined,
        book_id: bookFilter || undefined,
        search: search.trim() || undefined,
        created_after: createdAfter
          ? new Date(`${createdAfter}T00:00:00`).toISOString()
          : undefined,
        created_before: createdBefore
          ? new Date(`${createdBefore}T23:59:59.999`).toISOString()
          : undefined,
        limit: reportLimit,
        offset: reportOffset,
      });
      if (requestId === reportRequestId.current) setReports(next);
    } catch (error) {
      if (requestId === reportRequestId.current) {
        setReports(null);
        setReportError(errorMessage(error));
      }
    } finally {
      if (requestId === reportRequestId.current) setLoadingReports(false);
    }
  }, [
    bookContentQuality,
    bookFilter,
    createdAfter,
    createdBefore,
    issueFilter,
    reportOffset,
    search,
    statusFilter,
  ]);

  const loadBooks = useCallback(async () => {
    const requestId = ++bookRequestId.current;
    setLoadingBooks(true);
    setBookError(null);
    try {
      const next = await bookContentQuality.listBooks({
        search: bookSearch.trim() || undefined,
        limit: bookLimit,
        offset: bookOffset,
      });
      if (requestId === bookRequestId.current) setBooks(next);
    } catch (error) {
      if (requestId === bookRequestId.current) {
        setBooks(null);
        setBookError(errorMessage(error));
      }
    } finally {
      if (requestId === bookRequestId.current) setLoadingBooks(false);
    }
  }, [bookContentQuality, bookOffset, bookSearch]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void loadReports(), 180);
    return () => {
      globalThis.clearTimeout(timeout);
      reportRequestId.current += 1;
    };
  }, [loadReports]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void loadBooks(), 180);
    return () => {
      globalThis.clearTimeout(timeout);
      bookRequestId.current += 1;
    };
  }, [loadBooks]);

  const refreshSelectedBook = useCallback(
    async (bookId: string) => {
      const detail = await bookContentQuality.getBook(bookId);
      setSelectedBook(detail);
      setSelectedScan(detail.latest_scan_detail);
    },
    [bookContentQuality],
  );

  useEffect(() => {
    const active =
      selectedBook?.latest_scan_detail?.status === "QUEUED" ||
      selectedBook?.latest_scan_detail?.status === "RUNNING";
    if (!selectedBook || !active) return;
    const timeout = globalThis.setTimeout(() => {
      void refreshSelectedBook(selectedBook.book_id).catch(() =>
        setActionError("Không thể cập nhật tiến trình scan. Vui lòng tải lại."),
      );
    }, 3000);
    return () => globalThis.clearTimeout(timeout);
  }, [refreshSelectedBook, selectedBook]);

  async function openReport(reportId: string) {
    setBusyKey(`report:${reportId}`);
    setActionError(null);
    try {
      const detail = await bookContentQuality.getReport(reportId);
      setSelectedReport(detail);
      setResolutionNote(detail.admin_resolution_note ?? "");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function changeReportStatus(
    reportId: string,
    nextStatus: BookContentReportStatus,
  ) {
    setBusyKey(`report-status:${reportId}`);
    setActionError(null);
    try {
      const detail = await bookContentQuality.updateReportStatus(
        reportId,
        nextStatus,
        resolutionNote,
      );
      setSelectedReport(detail);
      await loadReports();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function openBook(bookId: string) {
    setBusyKey(`book:${bookId}`);
    setActionError(null);
    try {
      const detail = await bookContentQuality.getBook(bookId);
      setSelectedBook(detail);
      setSelectedScan(detail.latest_scan_detail);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function enqueueBookScan(bookId: string) {
    setBusyKey(`scan:${bookId}`);
    setActionError(null);
    try {
      const scan = await bookContentQuality.enqueueScan(bookId);
      await Promise.all([loadBooks(), refreshSelectedBook(bookId)]);
      setSelectedScan(await bookContentQuality.getScan(scan.id));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function openScan(scanId: string) {
    setBusyKey(`scan-detail:${scanId}`);
    setActionError(null);
    try {
      setSelectedScan(await bookContentQuality.getScan(scanId));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function updateFinding(
    finding: BookQualityFindingDTO,
    nextStatus: Exclude<BookQualityFindingStatus, "STALE">,
  ) {
    setBusyKey(`finding:${finding.id}`);
    setActionError(null);
    try {
      await bookContentQuality.updateFinding(
        finding.id,
        nextStatus,
        nextStatus === "DISMISSED"
          ? "Admin đã xem xét và xác định cảnh báo không cần xử lý."
          : undefined,
      );
      if (selectedBook) {
        await refreshSelectedBook(selectedBook.book_id);
        if (selectedScan) {
          setSelectedScan(await bookContentQuality.getScan(selectedScan.id));
        }
      }
      await loadBooks();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function retryPage(scanId: string, pageScanId: string) {
    setBusyKey(`retry:${pageScanId}`);
    setActionError(null);
    try {
      const nextRun = await bookContentQuality.retryPage(scanId, pageScanId);
      if (selectedBook) await refreshSelectedBook(selectedBook.book_id);
      setSelectedScan(await bookContentQuality.getScan(nextRun.id));
      await loadBooks();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  const reportSummary = reports?.summary;
  const reportLast = reports
    ? Math.min(reports.offset + reports.limit, reports.total)
    : 0;
  const bookLast = books
    ? Math.min(books.offset + books.limit, books.total)
    : 0;

  return (
    <section className="mt-10 border-t border-border pt-8">
      <AdminPageHeader
        eyebrow="Quản trị chất lượng sách"
        title="Báo cáo phụ huynh và kiểm tra nội dung"
        description="Theo dõi báo cáo, kết quả rà soát toàn bộ sách và các finding gắn với revision nguồn. AI chỉ đưa ra cảnh báo; Admin quyết định nội dung được sửa và xác minh."
        actions={
          <Button
            className="h-12 w-auto"
            disabled={loadingReports || loadingBooks}
            onClick={() => void Promise.all([loadReports(), loadBooks()])}
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-4" />
            Tải lại
          </Button>
        }
      />

      {actionError ? (
        <StatusMessage tone="error" title="Thao tác chưa hoàn tất">
          {actionError}
        </StatusMessage>
      ) : null}

      <section aria-label="Thống kê báo cáo phụ huynh" className="mb-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {(
            [
              ["OPEN", "Mới tiếp nhận"],
              ["UNDER_REVIEW", "Đang kiểm tra"],
              ["RESOLVED", "Đã giải quyết"],
              ["REJECTED", "Đã từ chối"],
              ["REPORTED_BOOKS", "Sách được báo cáo"],
              ["REPORTED_PAGES", "Trang được báo cáo"],
            ] as const
          ).map(([key, label]) => (
            <div className="rounded-card border border-border bg-white p-4" key={key}>
              <p className="text-sm text-muted">{label}</p>
              <p className="mt-1 text-2xl font-extrabold tabular-nums text-ink">
                {reportSummary?.[key] ?? "—"}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-card border border-border bg-white p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-extrabold text-ink">Báo cáo từ phụ huynh</h2>
            <p className="mt-1 text-sm text-muted">
              Lọc, xem snapshot lịch sử và cập nhật trạng thái xử lý.
            </p>
          </div>
          <span className="text-sm font-semibold text-muted">
            {reports?.total ?? 0} báo cáo
          </span>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="block text-sm font-semibold text-ink">
            Tìm kiếm
            <span className="relative mt-1 block">
              <Search aria-hidden className="absolute left-3 top-3 size-4 text-muted" />
              <input
                className="min-h-11 w-full rounded-control border border-border pl-9 pr-3"
                onChange={(event) => {
                  setReportOffset(0);
                  setSearch(event.target.value);
                }}
                placeholder="Tên sách, nội dung, phụ huynh…"
                value={search}
              />
            </span>
          </label>
          <label className="block text-sm font-semibold text-ink">
            Từ ngày
            <input
              className="mt-1 min-h-11 w-full rounded-control border border-border px-3"
              onChange={(event) => {
                setReportOffset(0);
                setCreatedAfter(event.target.value);
              }}
              type="date"
              value={createdAfter}
            />
          </label>
          <label className="block text-sm font-semibold text-ink">
            Đến ngày
            <input
              className="mt-1 min-h-11 w-full rounded-control border border-border px-3"
              onChange={(event) => {
                setReportOffset(0);
                setCreatedBefore(event.target.value);
              }}
              type="date"
              value={createdBefore}
            />
          </label>
          <label className="block text-sm font-semibold text-ink">
            Trạng thái
            <select
              className="mt-1 min-h-11 w-full rounded-control border border-border px-3"
              onChange={(event) => {
                setReportOffset(0);
                setStatusFilter(event.target.value as BookContentReportStatus | "");
              }}
              value={statusFilter}
            >
              <option value="">Tất cả</option>
              {Object.entries(reportStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-ink">
            Loại lỗi
            <select
              className="mt-1 min-h-11 w-full rounded-control border border-border px-3"
              onChange={(event) => {
                setReportOffset(0);
                setIssueFilter(event.target.value as BookContentIssueType | "");
              }}
              value={issueFilter}
            >
              <option value="">Tất cả</option>
              {Object.entries(issueLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold text-ink">
            Sách
            <select
              className="mt-1 min-h-11 w-full rounded-control border border-border px-3"
              onChange={(event) => {
                setReportOffset(0);
                setBookFilter(event.target.value);
              }}
              value={bookFilter}
            >
              <option value="">Tất cả sách</option>
              {(books?.items ?? []).map((book) => (
                <option key={book.book_id} value={book.book_id}>{book.book_title}</option>
              ))}
            </select>
          </label>
        </div>

        {loadingReports ? (
          <AdminLoading label="Đang tải báo cáo phụ huynh…" />
        ) : reportError ? (
          <StatusMessage tone="error" title="Không thể tải danh sách báo cáo">
            {reportError}
          </StatusMessage>
        ) : !reports || reports.items.length === 0 ? (
          <EmptyState
            title="Không có báo cáo phù hợp"
            description="Thử bỏ bớt bộ lọc hoặc chọn trạng thái khác."
          />
        ) : (
          <div className="mt-4 grid gap-3">
            {reports.items.map((report) => (
              <article className="rounded-control border border-border p-4" key={report.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-bold text-ink">{report.book_title}</h3>
                    <p className="mt-1 text-sm text-muted">
                      {issueLabels[report.issue_type]}
                      {report.page_number !== null ? ` · Trang ${report.page_number}` : " · Toàn bộ sách"}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Người gửi: {report.reporter_name || "Tài khoản phụ huynh"}
                      {" · "}{formatDate(report.created_at)}
                    </p>
                  </div>
                  <span className="rounded-full bg-sky px-3 py-1 text-xs font-bold text-primary-hover">
                    {reportStatusLabels[report.status]}
                  </span>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink">
                  {report.description}
                </p>
                {report.reported_text ? (
                  <p className="mt-2 text-sm text-muted">
                    Đoạn nghi ngờ: <span className="font-semibold text-ink">{report.reported_text}</span>
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                  <span className="break-all font-mono text-xs text-muted">{report.id}</span>
                  <Button
                    className="h-10 w-auto px-3 text-sm"
                    disabled={busyKey === `report:${report.id}`}
                    onClick={() => void openReport(report.id)}
                    variant="secondary"
                  >
                    Xem chi tiết
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}

        {reports && reports.total > reportLimit ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {reports.offset + 1}–{reportLast} / {reports.total}
            </p>
            <div className="flex gap-2">
              <Button
                className="h-10 w-auto px-3 text-sm"
                disabled={reportOffset === 0 || loadingReports}
                onClick={() => setReportOffset((value) => Math.max(0, value - reportLimit))}
                variant="secondary"
              >
                Trước
              </Button>
              <Button
                className="h-10 w-auto px-3 text-sm"
                disabled={reportOffset + reportLimit >= reports.total || loadingReports}
                onClick={() => setReportOffset((value) => value + reportLimit)}
                variant="secondary"
              >
                Tiếp
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      {selectedReport ? (
        <section className="mt-6 rounded-card border border-border bg-white p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-extrabold text-ink">Chi tiết báo cáo</h2>
              <p className="mt-1 break-all font-mono text-xs text-muted">{selectedReport.id}</p>
            </div>
            <Button
              className="h-10 w-auto px-3 text-sm"
              onClick={() => setSelectedReport(null)}
              variant="secondary"
            >
              Đóng chi tiết
            </Button>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="font-bold text-ink">Snapshot lúc phụ huynh gửi</h3>
              <p className="mt-2 text-sm text-muted">
                {selectedReport.book_title}
                {selectedReport.page_number !== null ? ` · Trang ${selectedReport.page_number}` : " · Toàn bộ sách"}
              </p>
              <p className="mt-2 text-sm font-semibold text-ink">
                {issueLabels[selectedReport.issue_type]}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">
                {selectedReport.description}
              </p>
              {selectedReport.verified_text_snapshot ? (
                <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-control bg-canvas p-3 text-xs leading-5 text-ink">
                  {selectedReport.verified_text_snapshot}
                </pre>
              ) : (
                <p className="mt-3 text-sm text-muted">
                  Không có snapshot VerifiedText tại thời điểm gửi.
                </p>
              )}
              {selectedReport.page_id && selectedReport.book_id ? (
                <Link
                  className="mt-3 inline-flex min-h-10 items-center rounded-control border border-border px-3 text-sm font-bold text-primary hover:bg-canvas"
                  href={`/admin/books/${encodeURIComponent(selectedReport.book_id)}/pages/${encodeURIComponent(selectedReport.page_id)}${selectedReport.page_revision_id ? `?revisionId=${encodeURIComponent(selectedReport.page_revision_id)}` : ""}`}
                >
                  Mở trang và ảnh gốc trong OCR Review
                </Link>
              ) : null}
              {selectedReport.content_hash_snapshot ? (
                <p className="mt-2 break-all font-mono text-xs text-muted">
                  Content hash: {selectedReport.content_hash_snapshot}
                </p>
              ) : null}
            </div>
            <div>
              <h3 className="font-bold text-ink">Lịch sử xử lý</h3>
              <ol className="mt-2 space-y-3 border-l-2 border-border pl-4">
                {selectedReport.history.map((item, index) => (
                  <li key={`${item.created_at}-${index}`}>
                    <p className="text-sm font-bold text-ink">
                      {item.from_status ? `${reportStatusLabels[item.from_status]} → ` : ""}
                      {reportStatusLabels[item.to_status]}
                    </p>
                    <p className="text-xs text-muted">
                      {item.actor_name || "Hệ thống"} · {formatDate(item.created_at)}
                    </p>
                    {item.note ? <p className="mt-1 text-sm text-muted">{item.note}</p> : null}
                  </li>
                ))}
              </ol>
              <h3 className="mt-5 font-bold text-ink">Findings liên quan</h3>
              {selectedReport.related_findings.length ? (
                <div className="mt-2 grid gap-2">
                  {selectedReport.related_findings.map((finding) => (
                    <div className="rounded-control bg-canvas p-3" key={finding.id}>
                      <p className="text-sm font-bold text-ink">
                        Trang {finding.page_number} · {finding.issue_type}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {findingStatusLabels[finding.status]} · {finding.detection_source}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-ink">
                        {finding.original_excerpt}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted">
                  Chưa có finding được liên kết. Scan có thể đang chờ hoặc đã hoàn tất trước khi báo cáo được gửi.
                </p>
              )}
            </div>
          </div>
          <div className="mt-5 border-t border-border pt-4">
            <label className="block text-sm font-bold text-ink" htmlFor="report-resolution-note">
              Ghi chú xử lý của Admin
              <textarea
                className="mt-2 min-h-20 w-full rounded-control border border-border p-3 font-normal"
                id="report-resolution-note"
                maxLength={2000}
                onChange={(event) => setResolutionNote(event.target.value)}
                placeholder="Nêu căn cứ kiểm tra, lý do từ chối hoặc nội dung đã xử lý…"
                value={resolutionNote}
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedReport.status === "OPEN" ? (
                <Button
                  className="h-11 w-auto px-4 text-sm"
                  disabled={busyKey === `report-status:${selectedReport.id}`}
                  onClick={() => void changeReportStatus(selectedReport.id, "UNDER_REVIEW")}
                  variant="secondary"
                >
                  Tiếp nhận xử lý
                </Button>
              ) : null}
              {selectedReport.status === "UNDER_REVIEW" ? (
                <Button
                  className="h-11 w-auto px-4 text-sm"
                  disabled={busyKey === `report-status:${selectedReport.id}`}
                  onClick={() => void changeReportStatus(selectedReport.id, "OPEN")}
                  variant="secondary"
                >
                  Trả về mới tiếp nhận
                </Button>
              ) : null}
              {["OPEN", "UNDER_REVIEW"].includes(selectedReport.status) ? (
                <>
                  <Button
                    className="h-11 w-auto px-4 text-sm"
                    disabled={!resolutionNote.trim() || busyKey === `report-status:${selectedReport.id}`}
                    onClick={() => void changeReportStatus(selectedReport.id, "RESOLVED")}
                    variant="secondary"
                  >
                    Giải quyết báo cáo
                  </Button>
                  <Button
                    className="h-11 w-auto px-4 text-sm"
                    disabled={!resolutionNote.trim() || busyKey === `report-status:${selectedReport.id}`}
                    onClick={() => void changeReportStatus(selectedReport.id, "REJECTED")}
                    variant="secondary"
                  >
                    Từ chối có lý do
                  </Button>
                </>
              ) : (
                <Button
                  className="h-11 w-auto px-4 text-sm"
                  disabled={!resolutionNote.trim() || busyKey === `report-status:${selectedReport.id}`}
                  onClick={() => void changeReportStatus(selectedReport.id, "UNDER_REVIEW")}
                  variant="secondary"
                >
                  Mở lại báo cáo
                </Button>
              )}
            </div>
          </div>
        </section>
      ) : null}

      <section className="mt-8 rounded-card border border-border bg-white p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-extrabold text-ink">Kiểm tra nội dung toàn sách</h2>
            <p className="mt-1 text-sm text-muted">
              Số liệu thực lấy từ scan runs và findings trong PostgreSQL.
            </p>
          </div>
          <span className="text-sm font-semibold text-muted">
            {books?.total ?? 0} sách
          </span>
        </div>
        <label className="mb-4 block max-w-lg text-sm font-semibold text-ink">
          Tìm sách
          <input
            className="mt-1 min-h-11 w-full rounded-control border border-border px-3"
            onChange={(event) => {
              setBookOffset(0);
              setBookSearch(event.target.value);
            }}
            placeholder="Nhập tên hoặc tiêu đề sách…"
            value={bookSearch}
          />
        </label>
        {loadingBooks ? (
          <AdminLoading label="Đang tải danh sách sách…" />
        ) : bookError ? (
          <StatusMessage tone="error" title="Không thể tải danh sách sách">
            {bookError}
          </StatusMessage>
        ) : !books || books.items.length === 0 ? (
          <EmptyState
            title="Không tìm thấy sách"
            description="Kiểm tra lại từ khóa tìm kiếm."
          />
        ) : (
          <div className="grid gap-3">
            {books.items.map((book) => (
              <article className="rounded-control border border-border p-4" key={book.book_id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-bold text-ink">{book.book_title}</h3>
                    <p className="mt-1 text-sm text-muted">
                      {book.report_count} báo cáo · {book.finding_count} findings · {book.needs_review_finding_count} cần xem xét
                    </p>
                    {book.latest_scan ? (
                      <p className="mt-1 text-xs text-muted">
                        Lần quét gần nhất: {scanStatusLabels[book.latest_scan.status]}
                        {" · "}{book.latest_scan.completed_pages}/{book.latest_scan.total_pages} trang đã kiểm tra
                        {" · "}{formatDate(book.latest_scan.created_at)}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-muted">Chưa có lịch sử kiểm tra</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="h-10 w-auto px-3 text-sm"
                      disabled={busyKey === `book:${book.book_id}`}
                      onClick={() => void openBook(book.book_id)}
                      variant="secondary"
                    >
                      Xem kết quả
                    </Button>
                    <Button
                      className="h-10 w-auto px-3 text-sm"
                      disabled={busyKey === `scan:${book.book_id}` || book.latest_scan?.status === "QUEUED" || book.latest_scan?.status === "RUNNING"}
                      onClick={() => void enqueueBookScan(book.book_id)}
                      variant="secondary"
                    >
                      {book.latest_scan?.status === "QUEUED" || book.latest_scan?.status === "RUNNING" ? "Đang quét…" : "Quét toàn bộ sách"}
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {books && books.total > bookLimit ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {books.offset + 1}–{bookLast} / {books.total}
            </p>
            <div className="flex gap-2">
              <Button
                className="h-10 w-auto px-3 text-sm"
                disabled={bookOffset === 0 || loadingBooks}
                onClick={() => setBookOffset((value) => Math.max(0, value - bookLimit))}
                variant="secondary"
              >
                Trước
              </Button>
              <Button
                className="h-10 w-auto px-3 text-sm"
                disabled={bookOffset + bookLimit >= books.total || loadingBooks}
                onClick={() => setBookOffset((value) => value + bookLimit)}
                variant="secondary"
              >
                Tiếp
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      {selectedBook ? (
        <section className="mt-6 rounded-card border border-border bg-white p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-extrabold text-ink">{selectedBook.book_title}</h2>
              <p className="mt-1 text-sm text-muted">Chi tiết báo cáo và lịch sử scan</p>
            </div>
            <div className="flex gap-2">
              <Button
                className="h-10 w-auto px-3 text-sm"
                disabled={busyKey === `scan:${selectedBook.book_id}` || selectedBook.scans.some((run) => run.status === "QUEUED" || run.status === "RUNNING")}
                onClick={() => void enqueueBookScan(selectedBook.book_id)}
                variant="secondary"
              >
                Quét lại sách
              </Button>
              <Button
                className="h-10 w-auto px-3 text-sm"
                onClick={() => setSelectedBook(null)}
                variant="secondary"
              >
                Đóng
              </Button>
            </div>
          </div>

          <div className="mt-4">
            <h3 className="font-bold text-ink">Lịch sử scan</h3>
            {selectedBook.scans.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {selectedBook.scans.map((scan) => (
                  <Button
                    className="h-10 w-auto px-3 text-xs"
                    key={scan.id}
                    onClick={() => void openScan(scan.id)}
                    variant={selectedScan?.id === scan.id ? "primary" : "secondary"}
                  >
                    {scanStatusLabels[scan.status]} · {formatDate(scan.created_at)}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">Sách chưa có lần kiểm tra nào.</p>
            )}
          </div>

          {selectedScan ? (
            <div className="mt-5 border-t border-border pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-bold text-ink">Kết quả scan · {scanStatusLabels[selectedScan.status]}</h3>
                <span className="font-mono text-xs text-muted">{selectedScan.id}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
                {[
                  ["Tổng trang", selectedScan.total_pages],
                  ["Đã kiểm tra", selectedScan.completed_pages],
                  ["Không đủ điều kiện", selectedScan.skipped_pages],
                  ["Lỗi / stale", selectedScan.failed_pages],
                  ["AI unavailable", selectedScan.ai_unavailable_pages],
                ].map(([label, value]) => (
                  <div className="rounded-control bg-canvas p-3" key={String(label)}>
                    <p className="text-xs text-muted">{label}</p>
                    <p className="mt-1 text-lg font-extrabold tabular-nums text-ink">{value}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted">
                Trang có AI hoàn tất: {selectedScan.ai_completed_pages}. "Đã kiểm tra" phản ánh rule checks; AI unavailable/failed được tách riêng và không được coi là phân tích AI thành công.
              </p>
              {selectedScan.error_summary ? (
                <p className="mt-2 text-sm text-danger">{selectedScan.error_summary}</p>
              ) : null}

              <div className="mt-4 grid gap-4">
                {selectedScan.pages.map((page) => (
                  <article className="rounded-control border border-border p-4" key={page.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h4 className="font-bold text-ink">Trang {page.page_number}</h4>
                        <p className="mt-1 text-xs text-muted">
                          {pageStatusLabels[page.status] ?? page.status}
                          {" · Rule: "}{page.rule_check_status}
                          {" · AI: "}{aiStatusLabels[page.ai_analysis_status] ?? page.ai_analysis_status}
                        </p>
                        {page.page_revision_id ? (
                          <p className="mt-1 break-all font-mono text-xs text-muted">
                            Source revision: {page.page_revision_id}
                          </p>
                        ) : null}
                        {page.error_summary ? (
                          <p className="mt-2 text-sm text-danger">{page.error_summary}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {page.page_id ? (
                          <Link
                            className="inline-flex min-h-10 items-center rounded-control border border-border px-3 text-sm font-bold text-primary hover:bg-canvas"
                            href={`/admin/books/${encodeURIComponent(selectedBook.book_id)}/pages/${encodeURIComponent(page.page_id)}${page.page_revision_id ? `?revisionId=${encodeURIComponent(page.page_revision_id)}` : ""}`}
                          >
                            Kiểm tra và sửa trang
                          </Link>
                        ) : null}
                        {(page.status === "FAILED" || page.status === "STALE" || page.ai_analysis_status === "UNAVAILABLE" || page.ai_analysis_status === "FAILED") ? (
                          <Button
                            className="h-10 w-auto px-3 text-sm"
                            disabled={busyKey === `retry:${page.id}`}
                            onClick={() => void retryPage(selectedScan.id, page.id)}
                            variant="secondary"
                          >
                            Quét lại trang này
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {page.findings.length ? (
                      <div className="mt-4 grid gap-3">
                        {page.findings.map((finding) => (
                          <FindingCard
                            bookId={selectedBook.book_id}
                            busy={busyKey === `finding:${finding.id}`}
                            finding={finding}
                            key={finding.id}
                            onUpdate={updateFinding}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-muted">
                        {page.status === "COMPLETED"
                          ? "Không có finding trong lần kiểm tra này."
                          : "Trang chưa có kết quả kiểm tra; xem trạng thái và lý do ở trên."}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
