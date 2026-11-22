"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw, Search } from "lucide-react";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { AdminUserBooksQualitySection } from "@/components/admin/admin-user-books-quality-section";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type {
  BookContentIssueType,
  BookContentReportDetailDTO,
  BookContentReportStatus,
  BookPageDiagnosticCode,
  BookQualityBookDetailDTO,
  BookQualityBookPageDTO,
  BookApprovalStatus,
  BookQualityFindingDTO,
  BookQualityFindingStatus,
  BookQualityReportAdminPageDTO,
  BookQualityScanDetailDTO,
  BookRightsStatus,
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

const rightsStatusLabels: Record<string, string> = {
  UNASSESSED: "Chưa rà soát quyền sử dụng",
  INSUFFICIENT_EVIDENCE: "Thiếu bằng chứng quyền sử dụng",
  CONCERN_FLAGGED: "Có nghi ngại bản quyền / quyền sử dụng",
  RIGHTS_REVIEWED: "Đã rà soát quyền sử dụng",
  STALE_RIGHTS_REVIEW: "Hồ sơ quyền cần rà soát lại (nội dung đã đổi)",
};

const pageDiagnosticLabels: Record<BookPageDiagnosticCode, string> = {
  OK: "Đạt",
  MISSING_IMAGE: "Thiếu ảnh",
  EMPTY_OCR: "OCR rỗng",
  OCR_ERROR: "Lỗi OCR / AI",
  DUPLICATE_PAGE: "Nghi trùng trang",
  SUSPECTED_MISSING_PAGE: "Nghi thiếu trang",
  UNVERIFIED_PAGE: "Chưa xác minh",
  IMAGE_ONLY_PAGE: "Chỉ có ảnh",
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

const approvalStatusLabels: Record<BookApprovalStatus, string> = {
  PROCESSING: "Đang kiểm tra",
  SCAN_FAILED: "Scan thất bại",
  PENDING_ADMIN_REVIEW: "Chờ Admin duyệt",
  READY_FOR_CHILDREN: "Đủ điều kiện theo scan",
  PUBLISHED: "Đã tự động xuất bản",
  APPROVED_BY_ADMIN: "Admin đã phê duyệt",
  REJECTED_FOR_CHILDREN: "Không được phép cho trẻ đọc",
  STALE: "Cần quét lại",
};

const approvalStatusStyles: Record<BookApprovalStatus, string> = {
  PROCESSING: "bg-sky text-primary-hover",
  SCAN_FAILED: "bg-rose-100 text-rose-800",
  PENDING_ADMIN_REVIEW: "bg-amber-100 text-amber-900",
  READY_FOR_CHILDREN: "bg-emerald-100 text-emerald-900",
  PUBLISHED: "bg-emerald-100 text-emerald-900",
  APPROVED_BY_ADMIN: "bg-emerald-100 text-emerald-900",
  REJECTED_FOR_CHILDREN: "bg-rose-100 text-rose-800",
  STALE: "bg-orange-100 text-orange-900",
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
  if (isServiceError(error) && (error.status === 409 || error.status === 422)) {
    return error.message;
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
      className="inline-flex min-h-10 items-center rounded-control border border-border px-3 text-sm font-semibold text-primary hover:bg-canvas"
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
        <div className="font-semibold text-ink">
          Trang {finding.page_number} · {finding.issue_type}
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
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
          Đề xuất:{" "}
          <span className="font-semibold">{finding.suggested_correction}</span>
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>
          Nguồn:{" "}
          {finding.detection_source === "RULE"
            ? "Quy tắc xác định"
            : "Ollama · chỉ phân tích văn bản"}
        </span>
        {finding.model_name ? <span>Model: {finding.model_name}</span> : null}
        {finding.confidence !== null ? (
          <span>Confidence: {(finding.confidence * 100).toFixed(0)}%</span>
        ) : null}
        {finding.page_revision_id ? (
          <span className="font-mono">
            Revision: {finding.page_revision_id}
          </span>
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
  const [statusFilter, setStatusFilter] = useState<
    BookContentReportStatus | ""
  >("");
  const [issueFilter, setIssueFilter] = useState<BookContentIssueType | "">("");
  const [activeTab, setActiveTab] = useState<"catalog" | "user-books">(
    "catalog",
  );
  const [bookFilter, setBookFilter] = useState("");
  const [reportOffset, setReportOffset] = useState(0);
  const [bookSearch, setBookSearch] = useState("");
  const [bookApprovalFilter, setBookApprovalFilter] = useState<
    BookApprovalStatus | ""
  >("");
  const [bookAlertFilter, setBookAlertFilter] = useState<
    "" | "CHILD_SAFETY" | "COPYRIGHT" | "BOTH"
  >("");
  const [bookOffset, setBookOffset] = useState(0);
  const [selectedReport, setSelectedReport] =
    useState<BookContentReportDetailDTO | null>(null);
  const [selectedBook, setSelectedBook] =
    useState<BookQualityBookDetailDTO | null>(null);
  const [selectedScan, setSelectedScan] =
    useState<BookQualityScanDetailDTO | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [bookDecisionReason, setBookDecisionReason] = useState("");
  const [falsePositiveCategory, setFalsePositiveCategory] = useState("");
  const [rightsStatus, setRightsStatus] =
    useState<BookRightsStatus>("UNASSESSED");
  const [rightsSource, setRightsSource] = useState("");
  const [rightsAuthor, setRightsAuthor] = useState("");
  const [rightsUsageBasis, setRightsUsageBasis] = useState("");
  const [rightsEvidenceRef, setRightsEvidenceRef] = useState("");
  const [rightsNotes, setRightsNotes] = useState("");
  const [rightsSavedNotice, setRightsSavedNotice] = useState<string | null>(
    null,
  );
  const [pageDiagnosticFilter, setPageDiagnosticFilter] = useState<
    "ALL" | "ISSUES" | "UNVERIFIED" | "MEDIA_OCR"
  >("ALL");
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
        approval_status: bookApprovalFilter || undefined,
        alert_filter: bookAlertFilter || undefined,
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
  }, [
    bookContentQuality,
    bookApprovalFilter,
    bookAlertFilter,
    bookOffset,
    bookSearch,
  ]);

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
    const activeScan =
      selectedBook?.latest_scan_detail?.status === "QUEUED" ||
      selectedBook?.latest_scan_detail?.status === "RUNNING";
    const activeWorkflow = selectedBook?.ai_workflows.some((workflow) =>
      ["QUEUED", "PROOFREADING", "CHILD_SAFETY_SCANNING"].includes(
        workflow.status,
      ),
    );
    const active = activeScan || activeWorkflow;
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

  const syncRightsForm = useCallback((detail: BookQualityBookDetailDTO) => {
    const r = detail.rights_evidence;
    setRightsStatus(r?.status ?? "UNASSESSED");
    setRightsSource(r?.source_description ?? "");
    setRightsAuthor(r?.author_or_rights_holder ?? "");
    setRightsUsageBasis(r?.usage_basis ?? "");
    setRightsEvidenceRef(r?.evidence_url_or_ref ?? "");
    setRightsNotes(r?.notes ?? "");
  }, []);

  async function openBook(bookId: string) {
    setBusyKey(`book:${bookId}`);
    setActionError(null);
    setRightsSavedNotice(null);
    try {
      const detail = await bookContentQuality.getBook(bookId);
      setSelectedBook(detail);
      setSelectedScan(detail.latest_scan_detail);
      syncRightsForm(detail);
      setBookDecisionReason("");
      setFalsePositiveCategory("");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function saveBookRights() {
    if (!selectedBook || !bookContentQuality.upsertBookRights) return;
    setBusyKey(`book-rights:${selectedBook.book_id}`);
    setActionError(null);
    setRightsSavedNotice(null);
    try {
      const saved = await bookContentQuality.upsertBookRights(
        selectedBook.book_id,
        {
          scope: "BOOK",
          status: rightsStatus,
          source_description: rightsSource.trim() || null,
          author_or_rights_holder: rightsAuthor.trim() || null,
          usage_basis: rightsUsageBasis.trim() || null,
          evidence_url_or_ref: rightsEvidenceRef.trim() || null,
          notes: rightsNotes.trim() || null,
        },
      );
      await refreshSelectedBook(selectedBook.book_id);
      await loadBooks();
      setRightsSavedNotice(
        `Đã lưu hồ sơ quyền sử dụng (phiên bản v${saved.version} · ${rightsStatusLabels[saved.effective_status] ?? saved.effective_status}).`,
      );
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyKey(null);
    }
  }

  async function decideBook(
    decision: "APPROVE" | "REJECT" | "REQUEST_RESCAN" | "FALSE_POSITIVE",
  ) {
    if (!selectedBook) return;
    setBusyKey(`book-decision:${selectedBook.book_id}`);
    setActionError(null);
    try {
      const result = await bookContentQuality.decideBook(selectedBook.book_id, {
        decision,
        reason: bookDecisionReason.trim(),
        rights_confirmed: selectedBook.assessment.rights_confirmed,
        category:
          decision === "FALSE_POSITIVE"
            ? falsePositiveCategory.trim()
            : undefined,
      });
      setSelectedBook((previous) =>
        previous?.book_id === result.book_id
          ? {
              ...previous,
              assessment: result.assessment,
              decision_history: result.decision_history,
            }
          : previous,
      );
      await loadBooks();
      setBookDecisionReason("");
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
  const aiAttentionCount =
    selectedBook?.ai_workflows.filter(
      (workflow) =>
        workflow.status === "FAILED" ||
        workflow.status === "READY_FOR_ADMIN_REVIEW" ||
        workflow.safety_status === "FAILED" ||
        workflow.safety_status === "STALE",
    ).length ?? 0;

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

      <div
        aria-label="Phân khu quản trị chất lượng sách"
        className="mb-6 flex flex-wrap gap-2"
        role="tablist"
      >
        <button
          aria-selected={activeTab === "catalog"}
          className={
            "inline-flex min-h-11 items-center gap-2 rounded-control border px-4 text-sm font-bold transition " +
            (activeTab === "catalog"
              ? "border-primary bg-primary text-white"
              : "border-border bg-white text-ink hover:bg-canvas")
          }
          id="quality-tab-catalog"
          onClick={() => setActiveTab("catalog")}
          role="tab"
          type="button"
        >
          Sách thư viện &amp; Báo cáo
        </button>
        <button
          aria-controls="quality-panel-user-books"
          aria-selected={activeTab === "user-books"}
          className={
            "inline-flex min-h-11 items-center gap-2 rounded-control border px-4 text-sm font-bold transition " +
            (activeTab === "user-books"
              ? "border-primary bg-primary text-white"
              : "border-border bg-white text-ink hover:bg-canvas")
          }
          id="quality-tab-user-books"
          onClick={() => setActiveTab("user-books")}
          role="tab"
          type="button"
        >
          Sách người dùng
        </button>
      </div>

      {activeTab === "user-books" ? <AdminUserBooksQualitySection /> : null}

      {activeTab === "catalog" ? (
        <>
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
                <div
                  className="rounded-card border border-border bg-white p-4"
                  key={key}
                >
                  <p className="text-sm text-muted">{label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
                    {reportSummary?.[key] ?? "—"}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-card border border-border bg-white p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-ink">
                  Báo cáo từ phụ huynh
                </h2>
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
                  <Search
                    aria-hidden
                    className="absolute left-3 top-3 size-4 text-muted"
                  />
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
                    setStatusFilter(
                      event.target.value as BookContentReportStatus | "",
                    );
                  }}
                  value={statusFilter}
                >
                  <option value="">Tất cả</option>
                  {Object.entries(reportStatusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-semibold text-ink">
                Loại lỗi
                <select
                  className="mt-1 min-h-11 w-full rounded-control border border-border px-3"
                  onChange={(event) => {
                    setReportOffset(0);
                    setIssueFilter(
                      event.target.value as BookContentIssueType | "",
                    );
                  }}
                  value={issueFilter}
                >
                  <option value="">Tất cả</option>
                  {Object.entries(issueLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
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
                    <option key={book.book_id} value={book.book_id}>
                      {book.book_title}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {loadingReports ? (
              <AdminLoading label="Đang tải báo cáo phụ huynh…" />
            ) : reportError ? (
              <StatusMessage
                tone="error"
                title="Không thể tải danh sách báo cáo"
              >
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
                  <article
                    className="rounded-control border border-border p-4"
                    key={report.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-ink">
                          {report.book_title}
                        </h3>
                        <p className="mt-1 text-sm text-muted">
                          {issueLabels[report.issue_type]}
                          {report.page_number !== null
                            ? ` · Trang ${report.page_number}`
                            : " · Toàn bộ sách"}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          Người gửi:{" "}
                          {report.reporter_name || "Tài khoản phụ huynh"}
                          {" · "}
                          {formatDate(report.created_at)}
                        </p>
                      </div>
                      <span className="rounded-full bg-sky px-3 py-1 text-xs font-semibold text-primary-hover">
                        {reportStatusLabels[report.status]}
                      </span>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink">
                      {report.description}
                    </p>
                    {report.reported_text ? (
                      <p className="mt-2 text-sm text-muted">
                        Đoạn nghi ngờ:{" "}
                        <span className="font-semibold text-ink">
                          {report.reported_text}
                        </span>
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                      <span className="break-all font-mono text-xs text-muted">
                        {report.id}
                      </span>
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
                    onClick={() =>
                      setReportOffset((value) =>
                        Math.max(0, value - reportLimit),
                      )
                    }
                    variant="secondary"
                  >
                    Trước
                  </Button>
                  <Button
                    className="h-10 w-auto px-3 text-sm"
                    disabled={
                      reportOffset + reportLimit >= reports.total ||
                      loadingReports
                    }
                    onClick={() =>
                      setReportOffset((value) => value + reportLimit)
                    }
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
                  <h2 className="text-xl font-semibold text-ink">
                    Chi tiết báo cáo
                  </h2>
                  <p className="mt-1 break-all font-mono text-xs text-muted">
                    {selectedReport.id}
                  </p>
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
                  <h3 className="font-semibold text-ink">
                    Snapshot lúc phụ huynh gửi
                  </h3>
                  <p className="mt-2 text-sm text-muted">
                    {selectedReport.book_title}
                    {selectedReport.page_number !== null
                      ? ` · Trang ${selectedReport.page_number}`
                      : " · Toàn bộ sách"}
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
                      className="mt-3 inline-flex min-h-10 items-center rounded-control border border-border px-3 text-sm font-semibold text-primary hover:bg-canvas"
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
                  <h3 className="font-semibold text-ink">Lịch sử xử lý</h3>
                  <ol className="mt-2 space-y-3 border-l-2 border-border pl-4">
                    {selectedReport.history.map((item, index) => (
                      <li key={`${item.created_at}-${index}`}>
                        <p className="text-sm font-semibold text-ink">
                          {item.from_status
                            ? `${reportStatusLabels[item.from_status]} → `
                            : ""}
                          {reportStatusLabels[item.to_status]}
                        </p>
                        <p className="text-xs text-muted">
                          {item.actor_name || "Hệ thống"} ·{" "}
                          {formatDate(item.created_at)}
                        </p>
                        {item.note ? (
                          <p className="mt-1 text-sm text-muted">{item.note}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  <h3 className="mt-5 font-semibold text-ink">
                    Findings liên quan
                  </h3>
                  {selectedReport.related_findings.length ? (
                    <div className="mt-2 grid gap-2">
                      {selectedReport.related_findings.map((finding) => (
                        <div
                          className="rounded-control bg-canvas p-3"
                          key={finding.id}
                        >
                          <p className="text-sm font-semibold text-ink">
                            Trang {finding.page_number} · {finding.issue_type}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            {findingStatusLabels[finding.status]} ·{" "}
                            {finding.detection_source}
                          </p>
                          <p className="mt-2 whitespace-pre-wrap text-sm text-ink">
                            {finding.original_excerpt}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-muted">
                      Chưa có finding được liên kết. Scan có thể đang chờ hoặc
                      đã hoàn tất trước khi báo cáo được gửi.
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-5 border-t border-border pt-4">
                <label
                  className="block text-sm font-semibold text-ink"
                  htmlFor="report-resolution-note"
                >
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
                      disabled={
                        busyKey === `report-status:${selectedReport.id}`
                      }
                      onClick={() =>
                        void changeReportStatus(
                          selectedReport.id,
                          "UNDER_REVIEW",
                        )
                      }
                      variant="secondary"
                    >
                      Tiếp nhận xử lý
                    </Button>
                  ) : null}
                  {selectedReport.status === "UNDER_REVIEW" ? (
                    <Button
                      className="h-11 w-auto px-4 text-sm"
                      disabled={
                        busyKey === `report-status:${selectedReport.id}`
                      }
                      onClick={() =>
                        void changeReportStatus(selectedReport.id, "OPEN")
                      }
                      variant="secondary"
                    >
                      Trả về mới tiếp nhận
                    </Button>
                  ) : null}
                  {["OPEN", "UNDER_REVIEW"].includes(selectedReport.status) ? (
                    <>
                      <Button
                        className="h-11 w-auto px-4 text-sm"
                        disabled={
                          !resolutionNote.trim() ||
                          busyKey === `report-status:${selectedReport.id}`
                        }
                        onClick={() =>
                          void changeReportStatus(selectedReport.id, "RESOLVED")
                        }
                        variant="secondary"
                      >
                        Giải quyết báo cáo
                      </Button>
                      <Button
                        className="h-11 w-auto px-4 text-sm"
                        disabled={
                          !resolutionNote.trim() ||
                          busyKey === `report-status:${selectedReport.id}`
                        }
                        onClick={() =>
                          void changeReportStatus(selectedReport.id, "REJECTED")
                        }
                        variant="secondary"
                      >
                        Từ chối có lý do
                      </Button>
                    </>
                  ) : (
                    <Button
                      className="h-11 w-auto px-4 text-sm"
                      disabled={
                        !resolutionNote.trim() ||
                        busyKey === `report-status:${selectedReport.id}`
                      }
                      onClick={() =>
                        void changeReportStatus(
                          selectedReport.id,
                          "UNDER_REVIEW",
                        )
                      }
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
                <h2 className="text-xl font-semibold text-ink">
                  Kiểm tra nội dung toàn sách
                </h2>
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
            {books ? (
              <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {Object.entries(approvalStatusLabels).map(([status, label]) => (
                  <div className="rounded-control bg-canvas p-3" key={status}>
                    <p className="text-xs text-muted">{label}</p>
                    <p className="mt-1 text-lg font-extrabold text-ink">
                      {books.summary[status] ?? 0}
                    </p>
                  </div>
                ))}
                {[
                  ["Sách có cảnh báo Child Safety", "CHILD_SAFETY"],
                  ["Sách có nghi vấn Copyright", "COPYRIGHT"],
                  ["Sách có cả hai nhóm", "BOTH"],
                ].map(([label, key]) => (
                  <div
                    className="rounded-control border border-amber-200 bg-amber-50 p-3"
                    key={key}
                  >
                    <p className="text-xs text-muted">{label}</p>
                    <p className="mt-1 text-lg font-extrabold text-ink">
                      {books.alert_summary[key] ?? 0}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
            <label className="mb-4 block max-w-lg text-sm font-semibold text-ink">
              Lọc theo đánh giá toàn sách
              <select
                className="mt-1 min-h-11 w-full rounded-control border border-border bg-white px-3"
                onChange={(event) => {
                  setBookOffset(0);
                  setBookApprovalFilter(
                    event.target.value as BookApprovalStatus | "",
                  );
                }}
                value={bookApprovalFilter}
              >
                <option value="">Tất cả trạng thái</option>
                {Object.entries(approvalStatusLabels).map(([status, label]) => (
                  <option key={status} value={status}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-4 block max-w-lg text-sm font-semibold text-ink">
              Lọc cảnh báo nội dung
              <select
                className="mt-1 min-h-11 w-full rounded-control border border-border bg-white px-3"
                onChange={(event) => {
                  setBookOffset(0);
                  setBookAlertFilter(
                    event.target.value as
                      "" | "CHILD_SAFETY" | "COPYRIGHT" | "BOTH",
                  );
                }}
                value={bookAlertFilter}
              >
                <option value="">Tất cả loại cảnh báo</option>
                <option value="CHILD_SAFETY">Có cảnh báo Child Safety</option>
                <option value="COPYRIGHT">Có nghi vấn Copyright</option>
                <option value="BOTH">Cả Child Safety và Copyright</option>
              </select>
            </label>
            <p className="mb-4 text-xs text-muted">
              Thống kê trạng thái tính trên toàn bộ kết quả tìm kiếm, không chỉ
              trang đang hiển thị. Copyright sẽ không có kết quả tự động cho đến
              khi dự án cấu hình được engine và dữ liệu quyền sử dụng.
            </p>
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
                  <article
                    className="rounded-control border border-border p-4"
                    key={book.book_id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-bold text-ink">
                          {book.book_title}
                        </h3>
                        <span
                          className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-extrabold ${approvalStatusStyles[book.assessment.status]}`}
                        >
                          {approvalStatusLabels[book.assessment.status]}
                        </span>
                        {book.assessment.finding_count > 0 ? (
                          <span className="ml-2 inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-900">
                            CẢNH BÁO CHILD SAFETY
                          </span>
                        ) : null}
                        {book.assessment.copyright_finding_count !== null &&
                        book.assessment.copyright_finding_count > 0 ? (
                          <span className="ml-2 inline-flex rounded-full bg-orange-100 px-3 py-1 text-xs font-extrabold text-orange-900">
                            NGHI VẤN COPYRIGHT
                          </span>
                        ) : null}
                        <p className="mt-2 text-sm text-muted">
                          Proofreading: {book.assessment.proofreading_status} ·
                          Child Safety: {book.assessment.child_safety_status} ·
                          Quyền sử dụng:{" "}
                          {rightsStatusLabels[
                            book.assessment.copyright_status
                          ] ?? book.assessment.copyright_status}
                        </p>
                        <p className="mt-1 text-xs font-semibold text-amber-900">
                          {book.assessment.finding_count} Child Safety findings
                          {` · HIGH ${book.assessment.high_finding_count}`}
                          {` · MEDIUM ${book.assessment.medium_finding_count}`}
                          {` · ${rightsStatusLabels[book.assessment.copyright_status] ?? book.assessment.copyright_status}`}
                        </p>
                        <p className="mt-1 text-sm text-muted">
                          {book.report_count} báo cáo · {book.finding_count}{" "}
                          findings · {book.needs_review_finding_count} cần xem
                          xét
                        </p>
                        {book.latest_scan ? (
                          <p className="mt-1 text-xs text-muted">
                            Lần quét gần nhất:{" "}
                            {scanStatusLabels[book.latest_scan.status]}
                            {" · "}
                            {book.latest_scan.completed_pages}/
                            {book.latest_scan.total_pages} trang đã kiểm tra
                            {" · "}
                            {formatDate(book.latest_scan.created_at)}
                          </p>
                        ) : (
                          <p className="mt-1 text-xs text-muted">
                            Chưa có lịch sử kiểm tra
                          </p>
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
                          disabled={
                            busyKey === `scan:${book.book_id}` ||
                            book.latest_scan?.status === "QUEUED" ||
                            book.latest_scan?.status === "RUNNING"
                          }
                          onClick={() => void enqueueBookScan(book.book_id)}
                          variant="secondary"
                        >
                          {book.latest_scan?.status === "QUEUED" ||
                          book.latest_scan?.status === "RUNNING"
                            ? "Đang quét…"
                            : "Quét toàn bộ sách"}
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
                    onClick={() =>
                      setBookOffset((value) => Math.max(0, value - bookLimit))
                    }
                    variant="secondary"
                  >
                    Trước
                  </Button>
                  <Button
                    className="h-10 w-auto px-3 text-sm"
                    disabled={
                      bookOffset + bookLimit >= books.total || loadingBooks
                    }
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
                  <h2 className="text-xl font-semibold text-ink">
                    {selectedBook.book_title}
                  </h2>
                  <p className="mt-1 text-sm text-muted">
                    Chất lượng sách, lịch sử AI, findings và review Admin
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    className="h-10 w-auto px-3 text-sm"
                    disabled={
                      busyKey === `scan:${selectedBook.book_id}` ||
                      selectedBook.scans.some(
                        (run) =>
                          run.status === "QUEUED" || run.status === "RUNNING",
                      )
                    }
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

              <section
                aria-label="Đánh giá và quyết định toàn sách"
                className="mt-5 rounded-control border border-border bg-canvas p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-lg font-extrabold text-ink">
                    Đánh giá toàn bộ sách
                  </h3>
                  <span
                    className={`rounded-full px-3 py-1 text-sm font-extrabold ${approvalStatusStyles[selectedBook.assessment.status]}`}
                  >
                    {approvalStatusLabels[selectedBook.assessment.status]}
                  </span>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    [
                      "Trang hiện hành",
                      `${selectedBook.assessment.ocr_completed_pages}/${selectedBook.assessment.page_count} OCR`,
                    ],
                    [
                      "OCR revision + Candidate hash hiện hành",
                      `${selectedBook.assessment.ocr_approval_valid_pages}/${selectedBook.assessment.page_count}`,
                    ],
                    [
                      "Proofreading",
                      `${selectedBook.assessment.proofreading_completed_pages}/${selectedBook.assessment.page_count} · ${selectedBook.assessment.proofreading_status}`,
                    ],
                    [
                      "Child Safety",
                      `${selectedBook.assessment.child_safety_completed_pages}/${selectedBook.assessment.page_count} · ${selectedBook.assessment.child_safety_status}`,
                    ],
                    [
                      "Đang xử lý",
                      `${selectedBook.assessment.processing_pages} trang`,
                    ],
                    [
                      "Quyền sử dụng nội dung",
                      rightsStatusLabels[
                        selectedBook.assessment.copyright_status
                      ] ?? selectedBook.assessment.copyright_status,
                    ],
                    [
                      "Findings",
                      `${selectedBook.assessment.finding_count} · HIGH ${selectedBook.assessment.high_finding_count} · MEDIUM ${selectedBook.assessment.medium_finding_count}`,
                    ],
                    [
                      "Trang có cảnh báo",
                      String(selectedBook.assessment.warning_page_count),
                    ],
                    [
                      "Lỗi / chưa quét",
                      `${selectedBook.assessment.failed_or_unscanned_page_count} · lỗi ${selectedBook.assessment.failed_pages}`,
                    ],
                    [
                      "Kết quả stale",
                      `${selectedBook.assessment.stale_pages} trang`,
                    ],
                    [
                      "Assessment hash",
                      selectedBook.assessment.assessment_hash.slice(0, 16),
                    ],
                  ].map(([label, value]) => (
                    <div className="rounded-control bg-white p-3" key={label}>
                      <p className="text-xs text-muted">{label}</p>
                      <p className="mt-1 break-all text-sm font-bold text-ink">
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-control border border-border bg-white p-3 text-sm text-muted">
                  Hệ thống không tự động xác minh trang và không tự động xuất
                  bản sách. Admin chỉ có thể phê duyệt sách sau khi mọi trang đã
                  có OCR VERIFIED khớp Candidate, Proofreading và Child Safety
                  (văn bản + hình ảnh) đạt yêu cầu, và hồ sơ bằng chứng quyền sử
                  dụng ở trạng thái <strong>Đã rà soát quyền sử dụng</strong>.
                </div>

                <section
                  aria-label="Hồ sơ bằng chứng quyền sử dụng nội dung"
                  className="mt-4 rounded-control border border-border bg-white p-4"
                  data-testid="book-rights-panel"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="font-extrabold text-ink">
                        Rà soát quyền sử dụng nội dung &amp; lưu bằng chứng (Tùy
                        chọn)
                      </h4>
                      <p className="mt-1 text-xs text-muted">
                        Ghi nhận nguồn tài liệu, cơ sở sử dụng và đường dẫn/mã
                        bằng chứng. Lưu ý: trạng thái &ldquo;Đã rà soát quyền sử
                        dụng&rdquo; là hồ sơ kiểm duyệt nội bộ có bằng chứng,
                        không phải xác nhận pháp lý tự động từ AI.
                      </p>
                    </div>
                    <span
                      className="rounded-full bg-canvas px-3 py-1 text-xs font-extrabold text-ink"
                      data-testid="book-rights-status"
                    >
                      {rightsStatusLabels[
                        selectedBook.rights_evidence?.effective_status ??
                          selectedBook.assessment.copyright_status
                      ] ?? selectedBook.assessment.copyright_status}
                      {selectedBook.rights_evidence?.version
                        ? ` · v${selectedBook.rights_evidence.version}`
                        : ""}
                    </span>
                  </div>
                  {selectedBook.rights_evidence?.is_stale ? (
                    <p className="mt-2 rounded-control border border-amber-400 bg-amber-50 p-2.5 text-xs font-semibold text-amber-950">
                      Nội dung hoặc nguồn trang sách đã thay đổi sau lần rà soát
                      quyền gần nhất. Cần rà soát và lưu lại hồ sơ quyền trước
                      khi phê duyệt.
                    </p>
                  ) : null}
                  {rightsSavedNotice ? (
                    <p
                      className="mt-2 rounded-control border border-emerald-300 bg-emerald-50 p-2.5 text-xs font-semibold text-emerald-900"
                      role="status"
                    >
                      {rightsSavedNotice}
                    </p>
                  ) : null}
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-xs font-bold text-ink">
                      Trạng thái quyền sử dụng
                      <select
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
                        onChange={(event) =>
                          setRightsStatus(
                            event.target.value as BookRightsStatus,
                          )
                        }
                        value={rightsStatus}
                      >
                        <option value="UNASSESSED">
                          Chưa rà soát quyền sử dụng (UNASSESSED)
                        </option>
                        <option value="INSUFFICIENT_EVIDENCE">
                          Thiếu bằng chứng (INSUFFICIENT_EVIDENCE)
                        </option>
                        <option value="CONCERN_FLAGGED">
                          Có nghi ngại bản quyền (CONCERN_FLAGGED)
                        </option>
                        <option value="RIGHTS_REVIEWED">
                          Đã rà soát quyền sử dụng (RIGHTS_REVIEWED)
                        </option>
                      </select>
                    </label>
                    <label className="text-xs font-bold text-ink">
                      Cơ sở sử dụng (bắt buộc khi Đã rà soát)
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
                        maxLength={120}
                        onChange={(event) =>
                          setRightsUsageBasis(event.target.value)
                        }
                        placeholder="Ví dụ: OPEN_LICENSE / PUBLIC_DOMAIN / PUBLISHER_PERMISSION"
                        type="text"
                        value={rightsUsageBasis}
                      />
                    </label>
                    <label className="text-xs font-bold text-ink">
                      Nguồn tài liệu (bắt buộc khi Đã rà soát)
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
                        maxLength={500}
                        onChange={(event) =>
                          setRightsSource(event.target.value)
                        }
                        placeholder="Ví dụ: Thư viện số giáo dục mở / NXB đã cấp phép"
                        type="text"
                        value={rightsSource}
                      />
                    </label>
                    <label className="text-xs font-bold text-ink">
                      Tác giả / Chủ sở hữu quyền
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
                        maxLength={300}
                        onChange={(event) =>
                          setRightsAuthor(event.target.value)
                        }
                        placeholder="Tên tác giả hoặc đơn vị giữ quyền"
                        type="text"
                        value={rightsAuthor}
                      />
                    </label>
                    <label className="sm:col-span-2 text-xs font-bold text-ink">
                      Đường dẫn / Mã hồ sơ bằng chứng (bắt buộc khi Đã rà soát)
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
                        maxLength={1000}
                        onChange={(event) =>
                          setRightsEvidenceRef(event.target.value)
                        }
                        placeholder="URL giấy phép hoặc mã văn bản lưu trữ nội bộ"
                        type="text"
                        value={rightsEvidenceRef}
                      />
                    </label>
                    <label className="sm:col-span-2 text-xs font-bold text-ink">
                      Ghi chú rà soát (bắt buộc khi gắn cờ nghi ngại)
                      <textarea
                        className="mt-1 min-h-16 w-full rounded-control border border-border bg-white p-2.5 text-sm font-normal"
                        maxLength={2000}
                        onChange={(event) => setRightsNotes(event.target.value)}
                        placeholder="Ghi rõ bằng chứng đối chiếu hoặc lý do nghi ngại bản quyền…"
                        value={rightsNotes}
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <Button
                      className="h-10 w-auto px-4 text-sm"
                      disabled={
                        busyKey === `book-rights:${selectedBook.book_id}` ||
                        (rightsStatus === "RIGHTS_REVIEWED" &&
                          (!rightsSource.trim() ||
                            !rightsUsageBasis.trim() ||
                            !rightsEvidenceRef.trim())) ||
                        (rightsStatus === "CONCERN_FLAGGED" &&
                          !rightsNotes.trim())
                      }
                      onClick={() => void saveBookRights()}
                      type="button"
                    >
                      Lưu hồ sơ quyền sử dụng
                    </Button>
                    {selectedBook.rights_evidence?.reviewed_at ? (
                      <span className="text-xs text-muted">
                        Cập nhật gần nhất:{" "}
                        {formatDate(selectedBook.rights_evidence.reviewed_at)}
                        {selectedBook.rights_evidence.reviewed_by_name
                          ? ` · ${selectedBook.rights_evidence.reviewed_by_name}`
                          : ""}
                      </span>
                    ) : null}
                  </div>
                  {selectedBook.rights_evidence?.history?.length ? (
                    <details className="mt-3 rounded-control border border-border bg-canvas/50 p-2.5">
                      <summary className="cursor-pointer text-xs font-bold text-ink">
                        Lịch sử thay đổi quyền sử dụng (
                        {selectedBook.rights_evidence.history.length})
                      </summary>
                      <ul className="mt-2 grid gap-2 text-xs">
                        {selectedBook.rights_evidence.history.map((entry) => (
                          <li
                            className="rounded-control bg-white p-2"
                            key={entry.id}
                          >
                            <span className="font-bold">
                              v{entry.version} ·{" "}
                              {rightsStatusLabels[entry.to_status] ??
                                entry.to_status}
                            </span>{" "}
                            · {formatDate(entry.created_at)}
                            {entry.actor_name ? ` · ${entry.actor_name}` : ""}
                            {entry.notes ? (
                              <p className="mt-1 text-muted">{entry.notes}</p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </section>

                {selectedBook.page_diagnostics?.length ? (
                  <section
                    aria-label="Chẩn đoán chất lượng từng trang"
                    className="mt-4 rounded-control border border-border bg-white p-4"
                    data-testid="book-page-diagnostics"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h4 className="font-extrabold text-ink">
                          Chẩn đoán chất lượng từng trang (
                          {selectedBook.page_diagnostics.length})
                        </h4>
                        <p className="mt-1 text-xs text-muted">
                          {selectedBook.completeness_disclaimer ??
                            "Hệ thống chỉ kiểm tra các trang đã tải lên; chưa thể khẳng định đủ số trang so với bản in gốc nếu chưa khai báo tổng số trang gốc."}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(
                          [
                            ["ALL", "Tất cả"],
                            ["ISSUES", "Trang có vấn đề"],
                            ["UNVERIFIED", "Chưa xác minh"],
                            ["MEDIA_OCR", "Lỗi ảnh / OCR"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            className={
                              "min-h-8 rounded-full border px-3 text-xs font-bold " +
                              (pageDiagnosticFilter === value
                                ? "border-primary bg-primary text-white"
                                : "border-border bg-canvas text-ink")
                            }
                            key={value}
                            onClick={() => setPageDiagnosticFilter(value)}
                            type="button"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <ul className="mt-3 grid max-h-72 gap-2 overflow-y-auto">
                      {selectedBook.page_diagnostics
                        .filter((item) => {
                          if (pageDiagnosticFilter === "ALL") return true;
                          if (pageDiagnosticFilter === "ISSUES") {
                            return item.codes.some((code) => code !== "OK");
                          }
                          if (pageDiagnosticFilter === "UNVERIFIED") {
                            return item.codes.includes("UNVERIFIED_PAGE");
                          }
                          return item.codes.some((code) =>
                            [
                              "MISSING_IMAGE",
                              "EMPTY_OCR",
                              "OCR_ERROR",
                              "IMAGE_ONLY_PAGE",
                            ].includes(code),
                          );
                        })
                        .map((item, idx) => (
                          <li
                            className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border bg-canvas/50 p-2.5 text-xs"
                            key={`${item.page_number}:${item.page_id ?? idx}`}
                          >
                            <div className="min-w-0">
                              <span className="font-extrabold text-ink">
                                Trang {item.page_number}
                              </span>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {item.codes.map((code) => (
                                  <span
                                    className={
                                      "rounded-full px-2 py-0.5 font-bold " +
                                      (code === "OK"
                                        ? "bg-emerald-100 text-emerald-900"
                                        : "bg-amber-100 text-amber-950")
                                    }
                                    key={code}
                                  >
                                    {pageDiagnosticLabels[code] ?? code}
                                  </span>
                                ))}
                              </div>
                              <p className="mt-1 text-muted">{item.summary}</p>
                            </div>
                            {item.page_id ? (
                              <Link
                                className="inline-flex min-h-8 items-center rounded-control border border-border bg-white px-2.5 font-bold text-primary hover:bg-canvas"
                                href={`/admin/books/${encodeURIComponent(selectedBook.book_id)}/pages/${encodeURIComponent(item.page_id)}`}
                              >
                                Mở trang OCR
                              </Link>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  </section>
                ) : null}
                {selectedBook.assessment.finding_groups.length ? (
                  <div className="mt-4 grid gap-3">
                    <h4 className="font-bold text-ink">
                      Tóm tắt Child Safety findings
                    </h4>
                    {selectedBook.assessment.finding_groups.map((group) => (
                      <article
                        className="rounded-control border border-border bg-white p-3"
                        key={`${group.category}:${group.severity}`}
                      >
                        <p className="font-bold text-ink">
                          {group.category} · {group.severity} ·{" "}
                          {group.finding_count} findings trên {group.page_count}{" "}
                          trang
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          Trang: {group.page_numbers.join(", ")}
                        </p>
                        {group.examples.map((example, index) => (
                          <div
                            className="mt-2 border-t border-border pt-2"
                            key={`${example.page_number}:${index}`}
                          >
                            <p className="text-xs font-bold text-muted">
                              Bằng chứng · trang {example.page_number}
                            </p>
                            <blockquote className="mt-1 whitespace-pre-wrap text-sm text-ink">
                              {example.evidence_text}
                            </blockquote>
                            <p className="mt-1 text-sm text-muted">
                              {example.explanation}
                            </p>
                            <p className="mt-1 text-sm text-ink">
                              {example.recommendation}
                            </p>
                          </div>
                        ))}
                      </article>
                    ))}
                  </div>
                ) : null}
                {selectedBook.assessment.blockers.length ? (
                  <p className="mt-3 text-xs text-muted">
                    Điều kiện còn lại:{" "}
                    {selectedBook.assessment.blockers.join(" · ")}
                  </p>
                ) : null}
                {selectedBook.assessment.admin_approved_at ? (
                  <p className="mt-2 text-sm text-emerald-900">
                    {selectedBook.assessment.publication_source ===
                    "AUTO_APPROVAL"
                      ? "Tự động xuất bản"
                      : "Admin phê duyệt"}{" "}
                    {formatDate(selectedBook.assessment.admin_approved_at)}
                    {selectedBook.assessment.admin_approved_by_name
                      ? ` · ${selectedBook.assessment.admin_approved_by_name}`
                      : ""}
                    {selectedBook.assessment.admin_reason
                      ? ` · ${selectedBook.assessment.admin_reason}`
                      : ""}
                  </p>
                ) : null}

                <div className="mt-4 grid gap-3 border-t border-border pt-4">
                  <label className="text-sm font-semibold text-ink">
                    Lý do / ghi chú quyết định
                    <textarea
                      className="mt-1 min-h-24 w-full rounded-control border border-border bg-white p-3"
                      maxLength={2000}
                      onChange={(event) =>
                        setBookDecisionReason(event.target.value)
                      }
                      value={bookDecisionReason}
                    />
                  </label>
                  {selectedBook.assessment.finding_count > 0 ||
                  selectedBook.ai_workflows.some(
                    (workflow) => workflow.suitability === "REVIEW_REQUIRED",
                  ) ||
                  selectedBook.ai_workflows.some(
                    (workflow) => workflow.suitability === "NOT_RECOMMENDED",
                  ) ? (
                    <p className="rounded-control bg-rose-50 p-3 text-sm font-semibold text-rose-900">
                      Cần xử lý hết Child Safety findings và trang
                      REVIEW_REQUIRED trước khi phê duyệt; NOT_RECOMMENDED luôn
                      bị chặn.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="h-10 w-auto px-3 text-sm"
                      disabled={
                        !bookDecisionReason.trim() ||
                        selectedBook.assessment.ocr_completed_pages !==
                          selectedBook.assessment.page_count ||
                        selectedBook.assessment.ocr_approval_valid_pages !==
                          selectedBook.assessment.page_count ||
                        !["COMPLETED", "COMPLETED_WITH_SUGGESTIONS"].includes(
                          selectedBook.assessment.proofreading_status,
                        ) ||
                        selectedBook.assessment.child_safety_status !==
                          "COMPLETED" ||
                        selectedBook.assessment.failed_or_unscanned_page_count >
                          0 ||
                        selectedBook.assessment.finding_count > 0 ||
                        selectedBook.ai_workflows.some(
                          (workflow) =>
                            workflow.suitability === "REVIEW_REQUIRED",
                        ) ||
                        selectedBook.ai_workflows.some(
                          (workflow) =>
                            workflow.suitability === "NOT_RECOMMENDED",
                        ) ||
                        selectedBook.ai_workflows.some(
                          (workflow) =>
                            workflow.image_safety_status ===
                            "ADMIN_FLAGGED_UNSAFE",
                        ) ||
                        busyKey === `book-decision:${selectedBook.book_id}`
                      }
                      onClick={() => void decideBook("APPROVE")}
                    >
                      Phê duyệt toàn bộ sách
                    </Button>
                    <Button
                      className="h-10 w-auto px-3 text-sm"
                      disabled={
                        !bookDecisionReason.trim() ||
                        busyKey === `book-decision:${selectedBook.book_id}`
                      }
                      onClick={() => void decideBook("REJECT")}
                      variant="secondary"
                    >
                      Từ chối sách
                    </Button>
                    <Button
                      className="h-10 w-auto px-3 text-sm"
                      disabled={
                        !bookDecisionReason.trim() ||
                        busyKey === `book-decision:${selectedBook.book_id}`
                      }
                      onClick={() => void decideBook("REQUEST_RESCAN")}
                      variant="secondary"
                    >
                      Yêu cầu quét lại stage cần thiết
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-48 text-sm font-semibold text-ink">
                      Category false positive
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3"
                        onChange={(event) =>
                          setFalsePositiveCategory(event.target.value)
                        }
                        value={falsePositiveCategory}
                      />
                    </label>
                    <Button
                      className="h-10 w-auto px-3 text-sm"
                      disabled={
                        !bookDecisionReason.trim() ||
                        !falsePositiveCategory.trim() ||
                        busyKey === `book-decision:${selectedBook.book_id}`
                      }
                      onClick={() => void decideBook("FALSE_POSITIVE")}
                      variant="secondary"
                    >
                      Ghi nhận false positive
                    </Button>
                  </div>
                  {selectedBook.decision_history.length ? (
                    <details className="rounded-control border border-border bg-white p-3">
                      <summary className="cursor-pointer text-sm font-bold">
                        Lịch sử quyết định (
                        {selectedBook.decision_history.length})
                      </summary>
                      <ul className="mt-2 grid gap-2">
                        {selectedBook.decision_history.map(
                          (decision, index) => (
                            <li
                              className="rounded-control bg-canvas p-3 text-sm"
                              key={`${decision.action}:${decision.created_at}:${index}`}
                            >
                              <p className="font-bold">
                                {decision.action} ·{" "}
                                {decision.created_at
                                  ? formatDate(decision.created_at)
                                  : ""}
                                {decision.actor_name
                                  ? ` · ${decision.actor_name}`
                                  : ""}
                              </p>
                              <p className="mt-1 text-muted">
                                {decision.reason ?? "Không có lý do"}
                              </p>
                            </li>
                          ),
                        )}
                      </ul>
                    </details>
                  ) : null}
                </div>
              </section>

              <div
                className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                aria-label="Tổng hợp AI toàn sách"
              >
                {[
                  ["Trang sách", "pages_total"],
                  ["Tổng workflow", "workflows_total"],
                  ["Có workflow", "pages_with_workflow"],
                  ["Chưa có workflow", "pages_without_workflow"],
                  ["Proofreading xong", "proofreading_completed"],
                  ["Safety xong · hash khớp", "safety_completed"],
                  ["Safety stale", "safety_stale"],
                  ["Safety chưa hoàn tất", "safety_unscanned"],
                  ["Đang xử lý", "active"],
                  ["Sẵn sàng Admin review", "ready_for_review"],
                  ["Lỗi cần xử lý", "failed"],
                  ["Cần Admin review · findings", "needs_admin_review"],
                ].map(([label, key]) => (
                  <div className="rounded-control bg-canvas p-3" key={key}>
                    <p className="text-xs text-muted">{label}</p>
                    <p className="mt-1 text-lg font-extrabold text-ink">
                      {selectedBook.ai_workflow_summary[key] ?? 0}
                      {key === "needs_admin_review"
                        ? ` · ${selectedBook.ai_workflow_summary.finding_count ?? 0}`
                        : ""}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <h3 className="font-semibold text-ink">Lịch sử scan</h3>
                {selectedBook.scans.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedBook.scans.map((scan) => (
                      <Button
                        className="h-10 w-auto px-3 text-xs"
                        key={scan.id}
                        onClick={() => void openScan(scan.id)}
                        variant={
                          selectedScan?.id === scan.id ? "primary" : "secondary"
                        }
                      >
                        {scanStatusLabels[scan.status]} ·{" "}
                        {formatDate(scan.created_at)}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted">
                    Sách chưa có lần kiểm tra nào.
                  </p>
                )}
              </div>

              <div className="mt-5 border-t border-border pt-4">
                <h3 className="font-bold text-ink">
                  Proofreading & Child Safety history
                </h3>
                {aiAttentionCount > 0 ? (
                  <div
                    aria-live="polite"
                    className="mt-3 rounded-control border border-amber-500 bg-amber-50 p-4 text-sm text-amber-950"
                    role="status"
                  >
                    Có {aiAttentionCount} workflow cần Admin xem xét hoặc xử lý
                    lỗi. Mở từng workflow bên dưới để kiểm tra evidence, trạng
                    thái Safety và retry stage thất bại. Trang chưa có kết quả
                    hợp lệ không được tính là an toàn.
                  </div>
                ) : null}
                {selectedBook.ai_workflows.length ? (
                  <div className="mt-3 grid gap-3">
                    {selectedBook.ai_workflows.map((workflow) => (
                      <article
                        className="rounded-control border border-border p-4"
                        key={workflow.workflow_id}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h4 className="font-bold text-ink">
                              {workflow.status} · {workflow.safety_status}
                            </h4>
                            <p className="mt-1 text-xs text-muted">
                              {workflow.suitability ?? "Chưa có suitability"} ·
                              Candidate v{workflow.candidate_version}
                              {workflow.hash_match
                                ? " · Safety hash khớp"
                                : " · Safety hash stale/chưa khớp"}
                            </p>
                            <p className="mt-1 break-all font-mono text-xs text-muted">
                              Workflow {workflow.workflow_id} · Revision{" "}
                              {workflow.page_revision_id}
                            </p>
                          </div>
                          <Link
                            className="inline-flex min-h-10 items-center rounded-control border border-border px-3 text-sm font-bold text-primary hover:bg-canvas"
                            href={`/admin/books/${encodeURIComponent(selectedBook.book_id)}/pages/${encodeURIComponent(workflow.page_id)}?revisionId=${encodeURIComponent(workflow.page_revision_id)}`}
                          >
                            Mở trang OCR Review
                          </Link>
                        </div>

                        {workflow.error_code ? (
                          <p className="mt-3 text-sm text-danger">
                            Lỗi workflow: {workflow.error_code}
                          </p>
                        ) : null}

                        {workflow.findings.length ? (
                          <div className="mt-3 grid gap-2">
                            {workflow.findings.map((finding, index) => (
                              <div
                                className="rounded-control bg-canvas p-3"
                                key={String(finding.finding_id ?? index)}
                              >
                                <p className="font-bold">
                                  {String(
                                    finding.category ?? "OTHER_SENSITIVE",
                                  )}{" "}
                                  · {String(finding.content_type ?? "MENTION")}{" "}
                                  · {String(finding.severity ?? "REVIEW")}
                                </p>
                                <p className="mt-1 text-xs text-muted">
                                  {String(
                                    finding.review_status ?? "PROVISIONAL",
                                  )}{" "}
                                  · {String(finding.evidence_start ?? "?")}–
                                  {String(finding.evidence_end ?? "?")}
                                </p>
                                <blockquote className="mt-2 whitespace-pre-wrap text-sm">
                                  {String(finding.evidence_text ?? "")}
                                </blockquote>
                                <p className="mt-1 text-sm text-muted">
                                  {String(finding.explanation ?? "")}
                                </p>
                                <p className="mt-1 text-sm text-ink">
                                  {String(finding.recommendation ?? "")}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-3 text-sm text-muted">
                            {workflow.safety_status === "PROVISIONAL" ||
                            workflow.safety_status === "CONFIRMED" ||
                            workflow.safety_status === "AUTO_CONFIRMED"
                              ? "Không có safety finding trong scan này."
                              : "Chưa có kết quả Child Safety hợp lệ."}
                          </p>
                        )}

                        {workflow.safety_history.length ? (
                          <details className="mt-3 rounded-control border border-border p-3">
                            <summary className="cursor-pointer text-sm font-bold">
                              Safety scans trước đây (
                              {workflow.safety_history.length})
                            </summary>
                            <ul className="mt-2 grid gap-2">
                              {workflow.safety_history.map((scan, index) => (
                                <li
                                  className="break-all rounded-control bg-canvas p-3 text-xs"
                                  key={`${String(scan.scan_id)}-${index}`}
                                >
                                  <p className="font-bold">
                                    {String(scan.status)} ·{" "}
                                    {String(
                                      scan.suitability ?? "Chưa có suitability",
                                    )}{" "}
                                    ·{" "}
                                    {Array.isArray(scan.findings)
                                      ? scan.findings.length
                                      : 0}{" "}
                                    findings
                                  </p>
                                  <p className="mt-1 font-mono text-muted">
                                    Hash: {String(scan.content_hash ?? "?")} ·
                                    Archived: {String(scan.archived_at ?? "")}
                                  </p>
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}

                        <div className="mt-3 grid gap-3 lg:grid-cols-3">
                          <div>
                            <h5 className="text-sm font-bold">
                              Candidate versions
                            </h5>
                            <ul className="mt-1 space-y-1 text-xs text-muted">
                              {workflow.candidate_history.map(
                                (version, index) => (
                                  <li
                                    className="break-all"
                                    key={`${String(version.version)}-${index}`}
                                  >
                                    v{String(version.version)} ·{" "}
                                    {String(version.changed_by ?? "unknown")} ·{" "}
                                    {String(version.content_hash ?? "")}
                                  </li>
                                ),
                              )}
                            </ul>
                          </div>
                          <div>
                            <h5 className="text-sm font-bold">
                              Workflow / Admin review history
                            </h5>
                            <ul className="mt-1 space-y-1 text-xs text-muted">
                              {workflow.review_history.map((event, index) => (
                                <li
                                  key={`${String(event.created_at)}-${index}`}
                                >
                                  {String(event.event)} ·{" "}
                                  {String(event.actor_id ?? "unknown")} ·{" "}
                                  {String(event.created_at ?? "")}
                                  {event.reason
                                    ? ` · Lý do: ${String(event.reason)}`
                                    : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <h5 className="text-sm font-bold">
                              Provider / model provenance
                            </h5>
                            <ul className="mt-1 space-y-1 text-xs text-muted">
                              {workflow.provider_events.map((event, index) => (
                                <li
                                  key={`${String(event.provider)}-${String(event.chunk_id)}-${index}`}
                                >
                                  {String(event.provider)} ·{" "}
                                  {String(event.model)} ·{" "}
                                  {event.availability
                                    ? "available"
                                    : "unavailable"}
                                  {event.http_status
                                    ? ` · HTTP ${String(event.http_status)}`
                                    : ""}
                                  {event.duration_ms !== undefined
                                    ? ` · ${String(event.duration_ms)} ms`
                                    : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted">
                    Sách chưa có Combined AI workflow history.
                  </p>
                )}
              </div>

              {selectedScan ? (
                <div className="mt-5 border-t border-border pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold text-ink">
                      Kết quả scan · {scanStatusLabels[selectedScan.status]}
                    </h3>
                    <span className="font-mono text-xs text-muted">
                      {selectedScan.id}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
                    {[
                      ["Tổng trang", selectedScan.total_pages],
                      ["Đã kiểm tra", selectedScan.completed_pages],
                      ["Không đủ điều kiện", selectedScan.skipped_pages],
                      ["Lỗi / stale", selectedScan.failed_pages],
                      ["AI unavailable", selectedScan.ai_unavailable_pages],
                    ].map(([label, value]) => (
                      <div
                        className="rounded-control bg-canvas p-3"
                        key={String(label)}
                      >
                        <p className="text-xs text-muted">{label}</p>
                        <p className="mt-1 text-lg font-semibold tabular-nums text-ink">
                          {value}
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-muted">
                    Trang có AI hoàn tất: {selectedScan.ai_completed_pages}.
                    &quot;Đã kiểm tra&quot; phản ánh rule checks; AI
                    unavailable/failed được tách riêng và không được coi là phân
                    tích AI thành công.
                  </p>
                  {selectedScan.error_summary ? (
                    <p className="mt-2 text-sm text-danger">
                      {selectedScan.error_summary}
                    </p>
                  ) : null}

                  <div className="mt-4 grid gap-4">
                    {selectedScan.pages.map((page) => (
                      <article
                        className="rounded-control border border-border p-4"
                        key={page.id}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h4 className="font-semibold text-ink">
                              Trang {page.page_number}
                            </h4>
                            <p className="mt-1 text-xs text-muted">
                              {pageStatusLabels[page.status] ?? page.status}
                              {" · Rule: "}
                              {page.rule_check_status}
                              {" · AI: "}
                              {aiStatusLabels[page.ai_analysis_status] ??
                                page.ai_analysis_status}
                            </p>
                            {page.page_revision_id ? (
                              <p className="mt-1 break-all font-mono text-xs text-muted">
                                Source revision: {page.page_revision_id}
                              </p>
                            ) : null}
                            {page.error_summary ? (
                              <p className="mt-2 text-sm text-danger">
                                {page.error_summary}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {page.page_id ? (
                              <Link
                                className="inline-flex min-h-10 items-center rounded-control border border-border px-3 text-sm font-semibold text-primary hover:bg-canvas"
                                href={`/admin/books/${encodeURIComponent(selectedBook.book_id)}/pages/${encodeURIComponent(page.page_id)}${page.page_revision_id ? `?revisionId=${encodeURIComponent(page.page_revision_id)}` : ""}`}
                              >
                                Kiểm tra và sửa trang
                              </Link>
                            ) : null}
                            {page.status === "FAILED" ||
                            page.status === "STALE" ||
                            page.ai_analysis_status === "UNAVAILABLE" ||
                            page.ai_analysis_status === "FAILED" ? (
                              <Button
                                className="h-10 w-auto px-3 text-sm"
                                disabled={busyKey === `retry:${page.id}`}
                                onClick={() =>
                                  void retryPage(selectedScan.id, page.id)
                                }
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
        </>
      ) : null}
    </section>
  );
}
