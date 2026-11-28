"use client";

import {
  AlertTriangle,
  BookCheck,
  CheckCircle2,
  Clock,
  Flag,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AdminBadge,
  AdminDrawer,
  AdminKpiCard,
  AdminKpiGrid,
  AdminLoading,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminToolbar,
  type AdminBadgeTone,
} from "@/components/admin/admin-ui";
import { AdminUserBooksQualitySection } from "@/components/admin/admin-user-books-quality-section";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { TranslateFn } from "@/lib/i18n/types";
import { cn } from "@/lib/utils/cn";
import type {
  BookApprovalStatus,
  BookContentIssueType,
  BookContentReportDetailDTO,
  BookContentReportStatus,
  BookQualityBookDetailDTO,
  BookQualityBookPageDTO,
  BookQualityFindingDTO,
  BookQualityFindingStatus,
  BookQualityReportAdminPageDTO,
  BookQualityScanDetailDTO,
  BookRightsStatus,
} from "@/types/book-content-quality";

export type ContentQualitySection = "all" | "reports" | "approval";

export interface AdminBookContentQualityScreenProps {
  readonly embedded?: boolean;
  readonly refreshSignal?: number;
  readonly section?: ContentQualitySection;
}

const REPORT_STATUS_KEYS: readonly BookContentReportStatus[] = [
  "OPEN",
  "UNDER_REVIEW",
  "RESOLVED",
  "REJECTED",
];

const ISSUE_TYPE_KEYS: readonly BookContentIssueType[] = [
  "BOOK_METADATA_ERROR",
  "SPELLING_ERROR",
  "MISSING_CONTENT",
  "OCR_MISMATCH",
  "IMAGE_QUALITY_ERROR",
  "DUPLICATE_PAGE",
  "PAGE_ORDER_ERROR",
  "CHILD_SAFETY_CONCERN",
  "COPYRIGHT_CONCERN",
  "OTHER",
];

function formatQualitySeverity(value: unknown): string {
  const key = String(value ?? "REVIEW").toUpperCase();
  const map: Record<string, string> = {
    HIGH: "Nghiêm trọng",
    MEDIUM: "Trung bình",
    LOW: "Nhẹ",
    REVIEW: "Cần xem xét",
  };
  return map[key] ?? "Cần xem xét";
}

function formatQualityEnum(value: unknown): string {
  const key = String(value ?? "").toUpperCase();
  const map: Record<string, string> = {
    COMPLETED: "Hoàn tất",
    IN_PROGRESS: "Đang xử lý",
    PENDING: "Đang chờ",
    FAILED: "Gặp lỗi",
    STALE: "Cần quét lại",
    NOT_STARTED: "Chưa quét",
    PROVISIONAL: "Tạm tính",
    CONFIRMED: "Đã xác nhận",
    AUTO_CONFIRMED: "Tự động xác nhận",
    READY_FOR_ADMIN_REVIEW: "Chờ quản trị viên duyệt",
    SUITABLE: "Phù hợp",
    SUITABLE_WITH_GUIDANCE: "Phù hợp (cần lưu ý)",
    REVIEW_REQUIRED: "Cần kiểm tra",
    NOT_RECOMMENDED: "Không khuyến nghị",
    PASSED: "Đạt",
    WARN: "Cảnh báo",
    BLOCKED: "Bị chặn",
    SKIPPED: "Đã bỏ qua",
    APPROVE: "Phê duyệt",
    REJECT: "Từ chối",
    REQUEST_CHANGES: "Yêu cầu sửa",
    SEXUAL_CONTENT: "Nội dung nhạy cảm",
    VIOLENCE: "Bạo lực",
    HATE_SPEECH: "Ngôn từ thù ghét",
    SELF_HARM: "Tự hại",
    PROFANITY: "Ngôn từ thô tục",
    AGE_INAPPROPRIATE: "Chưa phù hợp độ tuổi",
    OTHER_SENSITIVE: "Nội dung nhạy cảm khác",
    MENTION: "Đề cập",
    DEPICTION: "Mô tả",
    INSTRUCTION: "Hướng dẫn",
    SPELLING_ERROR: "Lỗi chính tả",
    MISSING_CONTENT: "Thiếu nội dung",
    OCR_MISMATCH: "Sai lệch nội dung nhận diện",
    IMAGE_QUALITY_ERROR: "Chất lượng hình ảnh",
    DUPLICATE_PAGE: "Trùng trang",
    PAGE_ORDER_ERROR: "Sai thứ tự trang",
    CHILD_SAFETY_CONCERN: "Cảnh báo an toàn trẻ em",
    COPYRIGHT_CONCERN: "Vấn đề bản quyền",
    BOOK_METADATA_ERROR: "Lỗi thông tin sách",
    OTHER: "Khác",
    RULE: "Quy tắc tự động",
    CLOUD_AI: "Kiểm tra AI",
    LOCAL_AI: "AI cục bộ",
    OLLAMA: "AI cục bộ",
  };
  if (!key) return "Không rõ";
  return map[key] ?? "Cần kiểm tra";
}

const APPROVAL_STATUS_KEYS: readonly BookApprovalStatus[] = [
  "PROCESSING",
  "SCAN_FAILED",
  "PENDING_ADMIN_REVIEW",
  "READY_FOR_CHILDREN",
  "PUBLISHED",
  "APPROVED_BY_ADMIN",
  "REJECTED_FOR_CHILDREN",
  "STALE",
];

const approvalStatusTones: Record<BookApprovalStatus, AdminBadgeTone> = {
  PROCESSING: "info",
  SCAN_FAILED: "danger",
  PENDING_ADMIN_REVIEW: "warning",
  READY_FOR_CHILDREN: "success",
  PUBLISHED: "success",
  APPROVED_BY_ADMIN: "success",
  REJECTED_FOR_CHILDREN: "danger",
  STALE: "warning",
};

const reportStatusTones: Record<BookContentReportStatus, AdminBadgeTone> = {
  OPEN: "warning",
  UNDER_REVIEW: "info",
  RESOLVED: "success",
  REJECTED: "neutral",
};

const findingStatusTones: Record<BookQualityFindingStatus, AdminBadgeTone> = {
  NEEDS_REVIEW: "warning",
  CONFIRMED: "danger",
  DISMISSED: "neutral",
  RESOLVED: "success",
  STALE: "neutral",
};

const rightsStatusTones: Record<string, AdminBadgeTone> = {
  UNASSESSED: "neutral",
  INSUFFICIENT_EVIDENCE: "warning",
  CONCERN_FLAGGED: "danger",
  RIGHTS_REVIEWED: "success",
  STALE_RIGHTS_REVIEW: "warning",
};

function errorMessage(error: unknown, t: TranslateFn): string {
  if (isServiceError(error) && error.code === "AUTH_REQUIRED") {
    return t("contentQuality.errors.sessionExpired");
  }
  if (isServiceError(error) && error.code === "FORBIDDEN") {
    return t("contentQuality.errors.forbidden");
  }
  if (isServiceError(error) && (error.status === 409 || error.status === 422)) {
    return error.message;
  }
  return t("contentQuality.errors.genericAction");
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
  const t = useTranslations("admin");
  if (!bookId || !finding.page_id) {
    return (
      <span className="text-xs text-muted">
        {t("contentQuality.findingCard.pageUnavailable")}
      </span>
    );
  }
  const query = finding.page_revision_id
    ? `?revisionId=${encodeURIComponent(finding.page_revision_id)}`
    : "";
  return (
    <ButtonLink
      href={`/admin/books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(finding.page_id)}${query}`}
      size="admin"
      variant="outline"
    >
      {children}
    </ButtonLink>
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
  const t = useTranslations("admin");
  return (
    <article className="rounded-xl border border-border bg-white p-3.5 shadow-2xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-sm font-bold text-ink">
          {t("contentQuality.findingCard.pageIssue", {
            pageNumber: finding.page_number,
            issueType: formatQualityEnum(finding.issue_type),
          })}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <AdminBadge tone={finding.severity === "HIGH" ? "danger" : "warning"}>
            {formatQualitySeverity(finding.severity)}
          </AdminBadge>
          <AdminBadge tone={findingStatusTones[finding.status] ?? "neutral"}>
            {t(`contentQuality.findingStatuses.${finding.status}`)}
          </AdminBadge>
        </div>
      </div>
      <blockquote className="mt-2.5 whitespace-pre-wrap rounded-control border border-border bg-surface-subtle p-2.5 text-sm leading-6 text-ink">
        {finding.original_excerpt ? (
          <span className="viread-learning-content" dir="ltr" lang="vi">
            {finding.original_excerpt}
          </span>
        ) : (
          t("contentQuality.findingCard.emptyExcerpt")
        )}
      </blockquote>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        {finding.explanation}
      </p>
      {finding.suggested_correction ? (
        <p className="mt-1.5 text-xs text-ink">
          {t("contentQuality.findingCard.suggestionPrefix")}{" "}
          <span
            className="viread-learning-content font-semibold"
            dir="ltr"
            lang="vi"
          >
            {finding.suggested_correction}
          </span>
        </p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span>
          {t("contentQuality.findingCard.sourcePrefix")}{" "}
          {finding.detection_source === "RULE"
            ? t("contentQuality.findingCard.sourceDeterministic")
            : finding.detection_source === "CLOUD_AI"
              ? t("contentQuality.findingCard.sourceCloudAi")
              : t("contentQuality.findingCard.sourceOllama")}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 border-t border-border/70 pt-3">
        <OcrLink bookId={bookId} finding={finding}>
          {t("contentQuality.findingCard.openInOcr")}
        </OcrLink>
        {finding.status === "NEEDS_REVIEW" ? (
          <>
            <Button
              disabled={busy}
              onClick={() => onUpdate(finding, "CONFIRMED")}
              size="admin"
              variant="secondary"
            >
              {t("contentQuality.findingCard.confirmWarning")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => onUpdate(finding, "DISMISSED")}
              size="admin"
              variant="outline"
            >
              {t("contentQuality.findingCard.dismiss")}
            </Button>
          </>
        ) : finding.status === "CONFIRMED" ? (
          <Button
            disabled={busy}
            onClick={() => onUpdate(finding, "RESOLVED")}
            size="admin"
            variant="secondary"
          >
            {t("contentQuality.findingCard.markResolved")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

const DRAWER_LIST_PAGE_SIZE = 5;
const PAGE_DIAGNOSTICS_PAGE_SIZE = 8;

function ScanPageFindingsList({
  findings,
  bookId,
  busyKey,
  onUpdate,
}: {
  findings: readonly BookQualityFindingDTO[];
  bookId: string;
  busyKey: string | null;
  onUpdate: (
    finding: BookQualityFindingDTO,
    status: Exclude<BookQualityFindingStatus, "STALE">,
  ) => void;
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(
    1,
    Math.ceil(findings.length / DRAWER_LIST_PAGE_SIZE),
  );
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visibleFindings = findings.slice(
    (safePage - 1) * DRAWER_LIST_PAGE_SIZE,
    safePage * DRAWER_LIST_PAGE_SIZE,
  );

  return (
    <div className="mt-3 grid gap-2.5">
      {visibleFindings.map((finding) => (
        <FindingCard
          bookId={bookId}
          busy={busyKey === `finding:${finding.id}`}
          finding={finding}
          key={finding.id}
          onUpdate={onUpdate}
        />
      ))}
      <PaginationBar
        compact
        onPageChange={setPage}
        page={safePage}
        pageSize={DRAWER_LIST_PAGE_SIZE}
        total={findings.length}
      />
    </div>
  );
}

function QualityScanProgressBar({
  scan,
  enqueuing = false,
  testId,
}: {
  scan: {
    status: string;
    progress_pct?: number | null;
    total_pages: number;
    completed_pages: number;
  } | null;
  enqueuing?: boolean;
  testId?: string;
}) {
  const tCommon = useTranslations("common");
  const { formatNumber } = useI18n();
  const isScanActive =
    enqueuing || scan?.status === "QUEUED" || scan?.status === "RUNNING";
  const hasMeasuredPages = Boolean(scan && scan.total_pages > 0);
  const derivedPct =
    enqueuing && !scan
      ? 10
      : typeof scan?.progress_pct === "number" &&
          Number.isFinite(scan.progress_pct)
        ? scan.progress_pct
        : hasMeasuredPages
          ? Math.round((scan!.completed_pages / scan!.total_pages) * 100)
          : scan?.status === "RUNNING"
            ? 35
            : 10;

  const stages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 20, label: tCommon("aiProgress.analyzing") },
      { atPct: 55, label: tCommon("aiProgress.safetyChecking") },
      { atPct: 85, label: tCommon("aiProgress.finalizing") },
    ],
    [tCommon],
  );

  const progress = useAiProgress({
    active: isScanActive,
    realPercent: derivedPct,
    progressMode: "staged",
    stages,
    expectedDurationMs: 18_000,
  });

  if (!isScanActive) return null;

  return (
    <AiProgressBar
      active
      className="mt-2.5"
      detail={
        hasMeasuredPages
          ? `${formatNumber(scan!.completed_pages)}/${formatNumber(scan!.total_pages)}`
          : undefined
      }
      elapsedSeconds={progress.elapsedSeconds}
      label={progress.stageLabel ?? tCommon("aiProgress.safetyChecking")}
      percent={progress.percent}
      size="sm"
      testId={testId}
    />
  );
}

function WorkflowInlineProgressBar({
  status,
  completedChunks,
  totalChunks,
  progressPct,
}: {
  status: string;
  completedChunks: number;
  totalChunks: number;
  progressPct?: number | null;
}) {
  const tCommon = useTranslations("common");
  const { formatNumber } = useI18n();
  const isActive =
    status === "QUEUED" ||
    status === "PROOFREADING" ||
    status === "CHILD_SAFETY_SCANNING";
  const derivedPct =
    typeof progressPct === "number" && Number.isFinite(progressPct)
      ? progressPct
      : status === "CHILD_SAFETY_SCANNING"
        ? totalChunks > 0
          ? Math.round(55 + (completedChunks / totalChunks) * 38)
          : 65
        : status === "PROOFREADING"
          ? totalChunks > 0
            ? Math.round(10 + (completedChunks / totalChunks) * 45)
            : 18
          : 8;
  const progress = useAiProgress({
    active: isActive,
    realPercent: derivedPct,
    progressMode: "staged",
    expectedDurationMs: 14_000,
  });
  if (!isActive) return null;
  const label =
    status === "CHILD_SAFETY_SCANNING"
      ? tCommon("aiProgress.safetyChecking")
      : status === "PROOFREADING"
        ? tCommon("aiProgress.proofreading")
        : tCommon("aiProgress.preparing");
  return (
    <AiProgressBar
      active
      className="mt-2.5"
      detail={
        totalChunks > 0
          ? `${formatNumber(completedChunks)}/${formatNumber(totalChunks)}`
          : undefined
      }
      elapsedSeconds={progress.elapsedSeconds}
      label={label}
      percent={progress.percent}
      size="compact"
    />
  );
}

export function AdminBookContentQualityScreen({
  embedded = false,
  refreshSignal = 0,
  section = "all",
}: AdminBookContentQualityScreenProps = {}) {
  const { bookContentQuality } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDateTime, formatNumber } = useI18n();
  const formatDate = formatDateTime;

  const showReports = section === "all" || section === "reports";
  const showBooks = section === "all" || section === "approval";

  const [reports, setReports] = useState<BookQualityReportAdminPageDTO | null>(
    null,
  );
  const [books, setBooks] = useState<BookQualityBookPageDTO | null>(null);
  const [loadingReports, setLoadingReports] = useState(showReports);
  const [loadingBooks, setLoadingBooks] = useState(showBooks);
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
  const [reportHistoryPage, setReportHistoryPage] = useState(1);
  const [reportRelatedFindingsPage, setReportRelatedFindingsPage] = useState(1);
  const [pageDiagnosticsPage, setPageDiagnosticsPage] = useState(1);
  const [findingGroupsPage, setFindingGroupsPage] = useState(1);
  const [aiWorkflowsPage, setAiWorkflowsPage] = useState(1);
  const [scanPagesPage, setScanPagesPage] = useState(1);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const reportRequestId = useRef(0);
  const bookRequestId = useRef(0);
  const reportLimit = 10;
  const bookLimit = 10;

  const isCatalogVisible = section !== "all" || activeTab === "catalog";

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
        setReportError(errorMessage(error, t));
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
    t,
  ]);

  const loadBooks = useCallback(
    async (options?: { silent?: boolean }) => {
      const requestId = ++bookRequestId.current;
      if (!options?.silent) {
        setLoadingBooks(true);
        setBookError(null);
      }
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
        if (requestId === bookRequestId.current && !options?.silent) {
          setBooks(null);
          setBookError(errorMessage(error, t));
        }
      } finally {
        if (requestId === bookRequestId.current && !options?.silent) {
          setLoadingBooks(false);
        }
      }
    },
    [
      bookContentQuality,
      bookApprovalFilter,
      bookAlertFilter,
      bookOffset,
      bookSearch,
      t,
    ],
  );

  useEffect(() => {
    void refreshSignal;
    if (!showReports || !isCatalogVisible) return;
    const requestId = reportRequestId;
    if (!search.trim()) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) void loadReports();
      });
      return () => {
        cancelled = true;
        requestId.current += 1;
      };
    }
    const timeout = globalThis.setTimeout(() => void loadReports(), 180);
    return () => {
      globalThis.clearTimeout(timeout);
      requestId.current += 1;
    };
  }, [isCatalogVisible, loadReports, refreshSignal, search, showReports]);

  useEffect(() => {
    void refreshSignal;
    if (!isCatalogVisible) return;
    if (!showBooks && !showReports) return;
    const requestId = bookRequestId;
    const silent = !showBooks;
    if (!bookSearch.trim()) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) void loadBooks({ silent });
      });
      return () => {
        cancelled = true;
        requestId.current += 1;
      };
    }
    const timeout = globalThis.setTimeout(
      () => void loadBooks({ silent }),
      180,
    );
    return () => {
      globalThis.clearTimeout(timeout);
      requestId.current += 1;
    };
  }, [
    bookSearch,
    isCatalogVisible,
    loadBooks,
    refreshSignal,
    showBooks,
    showReports,
  ]);

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
        setActionError(t("contentQuality.errors.scanPollFailed")),
      );
    }, 3000);
    return () => globalThis.clearTimeout(timeout);
  }, [refreshSelectedBook, selectedBook, t]);

  const closeReportDrawer = useCallback(() => {
    setSelectedReport(null);
  }, []);

  const closeBookDrawer = useCallback(() => {
    setSelectedBook(null);
  }, []);

  async function openReport(reportId: string) {
    setBusyKey(`report:${reportId}`);
    setActionError(null);
    try {
      const detail = await bookContentQuality.getReport(reportId);
      setSelectedReport(detail);
      setReportHistoryPage(1);
      setReportRelatedFindingsPage(1);
      setResolutionNote(detail.admin_resolution_note ?? "");
    } catch (error) {
      setActionError(errorMessage(error, t));
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
      setActionError(errorMessage(error, t));
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
      setPageDiagnosticFilter("ALL");
      setPageDiagnosticsPage(1);
      setFindingGroupsPage(1);
      setAiWorkflowsPage(1);
      setScanPagesPage(1);
      syncRightsForm(detail);
      setBookDecisionReason("");
      setFalsePositiveCategory("");
    } catch (error) {
      setActionError(errorMessage(error, t));
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
        t("contentQuality.notices.rightsSaved", {
          version: saved.version,
          status: t(
            `contentQuality.rightsStatuses.${saved.effective_status}`,
            undefined,
            saved.effective_status,
          ),
        }),
      );
    } catch (error) {
      setActionError(errorMessage(error, t));
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
      setActionError(errorMessage(error, t));
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
      setActionError(errorMessage(error, t));
    } finally {
      setBusyKey(null);
    }
  }

  async function openScan(scanId: string) {
    setBusyKey(`scan-detail:${scanId}`);
    setActionError(null);
    try {
      setSelectedScan(await bookContentQuality.getScan(scanId));
      setScanPagesPage(1);
    } catch (error) {
      setActionError(errorMessage(error, t));
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
          ? t("contentQuality.notices.findingDismissDefaultReason")
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
      setActionError(errorMessage(error, t));
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
      setActionError(errorMessage(error, t));
    } finally {
      setBusyKey(null);
    }
  }

  const reportSummary = reports?.summary;
  const aiAttentionCount =
    selectedBook?.ai_workflows.filter(
      (workflow) =>
        workflow.status === "FAILED" ||
        workflow.status === "READY_FOR_ADMIN_REVIEW" ||
        workflow.safety_status === "FAILED" ||
        workflow.safety_status === "STALE",
    ).length ?? 0;

  const reportHistoryItems = selectedReport?.history ?? [];
  const safeReportHistoryPage = Math.min(
    Math.max(1, reportHistoryPage),
    Math.max(1, Math.ceil(reportHistoryItems.length / DRAWER_LIST_PAGE_SIZE)),
  );
  const visibleReportHistory = reportHistoryItems.slice(
    (safeReportHistoryPage - 1) * DRAWER_LIST_PAGE_SIZE,
    safeReportHistoryPage * DRAWER_LIST_PAGE_SIZE,
  );

  const reportRelatedFindings = selectedReport?.related_findings ?? [];
  const safeReportRelatedFindingsPage = Math.min(
    Math.max(1, reportRelatedFindingsPage),
    Math.max(
      1,
      Math.ceil(reportRelatedFindings.length / DRAWER_LIST_PAGE_SIZE),
    ),
  );
  const visibleReportRelatedFindings = reportRelatedFindings.slice(
    (safeReportRelatedFindingsPage - 1) * DRAWER_LIST_PAGE_SIZE,
    safeReportRelatedFindingsPage * DRAWER_LIST_PAGE_SIZE,
  );

  const filteredPageDiagnostics = (selectedBook?.page_diagnostics ?? []).filter(
    (item) => {
      if (pageDiagnosticFilter === "ALL") return true;
      if (pageDiagnosticFilter === "ISSUES") {
        return item.codes.some((code) => code !== "OK");
      }
      if (pageDiagnosticFilter === "UNVERIFIED") {
        return item.codes.includes("UNVERIFIED_PAGE");
      }
      return item.codes.some((code) =>
        ["MISSING_IMAGE", "EMPTY_OCR", "OCR_ERROR", "IMAGE_ONLY_PAGE"].includes(
          code,
        ),
      );
    },
  );
  const safePageDiagnosticsPage = Math.min(
    Math.max(1, pageDiagnosticsPage),
    Math.max(
      1,
      Math.ceil(filteredPageDiagnostics.length / PAGE_DIAGNOSTICS_PAGE_SIZE),
    ),
  );
  const visiblePageDiagnostics = filteredPageDiagnostics.slice(
    (safePageDiagnosticsPage - 1) * PAGE_DIAGNOSTICS_PAGE_SIZE,
    safePageDiagnosticsPage * PAGE_DIAGNOSTICS_PAGE_SIZE,
  );

  const findingGroupItems = selectedBook?.assessment.finding_groups ?? [];
  const safeFindingGroupsPage = Math.min(
    Math.max(1, findingGroupsPage),
    Math.max(1, Math.ceil(findingGroupItems.length / DRAWER_LIST_PAGE_SIZE)),
  );
  const visibleFindingGroups = findingGroupItems.slice(
    (safeFindingGroupsPage - 1) * DRAWER_LIST_PAGE_SIZE,
    safeFindingGroupsPage * DRAWER_LIST_PAGE_SIZE,
  );

  const aiWorkflowItems = selectedBook?.ai_workflows ?? [];
  const safeAiWorkflowsPage = Math.min(
    Math.max(1, aiWorkflowsPage),
    Math.max(1, Math.ceil(aiWorkflowItems.length / DRAWER_LIST_PAGE_SIZE)),
  );
  const visibleAiWorkflows = aiWorkflowItems.slice(
    (safeAiWorkflowsPage - 1) * DRAWER_LIST_PAGE_SIZE,
    safeAiWorkflowsPage * DRAWER_LIST_PAGE_SIZE,
  );

  const scanPageItems = selectedScan?.pages ?? [];
  const safeScanPagesPage = Math.min(
    Math.max(1, scanPagesPage),
    Math.max(1, Math.ceil(scanPageItems.length / DRAWER_LIST_PAGE_SIZE)),
  );
  const visibleScanPages = scanPageItems.slice(
    (safeScanPagesPage - 1) * DRAWER_LIST_PAGE_SIZE,
    safeScanPagesPage * DRAWER_LIST_PAGE_SIZE,
  );

  const hasReportFilters = Boolean(
    search.trim() ||
    createdAfter ||
    createdBefore ||
    statusFilter ||
    issueFilter ||
    bookFilter,
  );
  const hasBookFilters = Boolean(
    bookSearch.trim() || bookApprovalFilter || bookAlertFilter,
  );

  function clearReportFilters() {
    setSearch("");
    setCreatedAfter("");
    setCreatedBefore("");
    setStatusFilter("");
    setIssueFilter("");
    setBookFilter("");
    setReportOffset(0);
  }

  function clearBookFilters() {
    setBookSearch("");
    setBookApprovalFilter("");
    setBookAlertFilter("");
    setBookOffset(0);
  }

  const bookSummary = books?.summary ?? {};
  const bookAlerts = books?.alert_summary ?? {};
  const approvedGroupTotal =
    (bookSummary.READY_FOR_CHILDREN ?? 0) +
    (bookSummary.APPROVED_BY_ADMIN ?? 0) +
    (bookSummary.PUBLISHED ?? 0);
  const processingGroupTotal =
    (bookSummary.PROCESSING ?? 0) +
    (bookSummary.STALE ?? 0) +
    (bookSummary.SCAN_FAILED ?? 0);

  const reportsSectionNode = showReports ? (
    <div className="space-y-4">
      <AdminKpiGrid
        ariaLabel={t("contentQuality.reportSummaryAria")}
        columns={4}
      >
        <AdminKpiCard
          active={statusFilter === "OPEN"}
          icon={<Flag className="size-4" />}
          label={t("contentQuality.summaryCards.OPEN")}
          onClick={() => {
            setReportOffset(0);
            setStatusFilter((prev) => (prev === "OPEN" ? "" : "OPEN"));
          }}
          tone={(reportSummary?.OPEN ?? 0) > 0 ? "warning" : "neutral"}
          value={
            reportSummary?.OPEN !== undefined
              ? formatNumber(reportSummary.OPEN)
              : t("common.emptyDash")
          }
        />
        <AdminKpiCard
          active={statusFilter === "UNDER_REVIEW"}
          icon={<Clock className="size-4" />}
          label={t("contentQuality.summaryCards.UNDER_REVIEW")}
          onClick={() => {
            setReportOffset(0);
            setStatusFilter((prev) =>
              prev === "UNDER_REVIEW" ? "" : "UNDER_REVIEW",
            );
          }}
          tone={(reportSummary?.UNDER_REVIEW ?? 0) > 0 ? "info" : "neutral"}
          value={
            reportSummary?.UNDER_REVIEW !== undefined
              ? formatNumber(reportSummary.UNDER_REVIEW)
              : t("common.emptyDash")
          }
        />
        <AdminKpiCard
          active={statusFilter === "RESOLVED"}
          icon={<CheckCircle2 className="size-4" />}
          label={t("contentQuality.summaryCards.RESOLVED")}
          onClick={() => {
            setReportOffset(0);
            setStatusFilter((prev) => (prev === "RESOLVED" ? "" : "RESOLVED"));
          }}
          tone="success"
          value={
            reportSummary?.RESOLVED !== undefined
              ? formatNumber(reportSummary.RESOLVED)
              : t("common.emptyDash")
          }
        />
        <AdminKpiCard
          detail={t(
            "contentQuality.summaryCards.reportedScopeDetail",
            {
              pages:
                reportSummary?.REPORTED_PAGES !== undefined
                  ? formatNumber(reportSummary.REPORTED_PAGES)
                  : t("common.emptyDash"),
              rejected:
                reportSummary?.REJECTED !== undefined
                  ? formatNumber(reportSummary.REJECTED)
                  : t("common.emptyDash"),
            },
            "Trang báo cáo: {pages} · Từ chối: {rejected}",
          )}
          label={t(
            "contentQuality.summaryCards.reportedScope",
            undefined,
            "Sách được báo cáo",
          )}
          tone="neutral"
          value={
            reportSummary?.REPORTED_BOOKS !== undefined
              ? formatNumber(reportSummary.REPORTED_BOOKS)
              : t("common.emptyDash")
          }
        />
      </AdminKpiGrid>

      <AdminToolbar
        actions={
          hasReportFilters ? (
            <Button
              onClick={clearReportFilters}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("metadataQuality.clearFilters")}
            </Button>
          ) : undefined
        }
        ariaLabel={t("contentQuality.reports.heading")}
      >
        <AdminSearchInput
          containerClassName="sm:min-w-44!"
          label={t("contentQuality.reports.searchLabel")}
          onChange={(value) => {
            setReportOffset(0);
            setSearch(value);
          }}
          placeholder={t("contentQuality.reports.searchPlaceholder")}
          value={search}
        />
        <AdminSelect
          containerClassName="w-full sm:w-36"
          label={t("contentQuality.reports.statusLabel")}
          onChange={(value) => {
            setReportOffset(0);
            setStatusFilter(value as BookContentReportStatus | "");
          }}
          value={statusFilter}
        >
          <option value="">{t("common.all")}</option>
          {REPORT_STATUS_KEYS.map((value) => (
            <option key={value} value={value}>
              {t(`contentQuality.reportStatuses.${value}`)}
            </option>
          ))}
        </AdminSelect>
        <AdminSelect
          containerClassName="w-full sm:w-44"
          label={t("contentQuality.reports.issueTypeLabel")}
          onChange={(value) => {
            setReportOffset(0);
            setIssueFilter(value as BookContentIssueType | "");
          }}
          value={issueFilter}
        >
          <option value="">{t("common.all")}</option>
          {ISSUE_TYPE_KEYS.map((value) => (
            <option key={value} value={value}>
              {t(`contentQuality.reportIssueTypes.${value}`)}
            </option>
          ))}
        </AdminSelect>
        <AdminSelect
          containerClassName="w-full sm:w-40"
          label={t("contentQuality.reports.bookLabel")}
          onChange={(value) => {
            setReportOffset(0);
            setBookFilter(value);
          }}
          value={bookFilter}
        >
          <option value="">{t("contentQuality.reports.allBooksOption")}</option>
          {(books?.items ?? []).map((book) => (
            <option key={book.book_id} value={book.book_id}>
              {book.book_title}
            </option>
          ))}
        </AdminSelect>
        <label className="flex w-full flex-col gap-1 text-xs font-semibold text-muted sm:w-34">
          {t("contentQuality.reports.fromDateLabel")}
          <input
            className="h-10 min-h-10 w-full rounded-control border border-border bg-white px-2 text-sm font-medium text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onChange={(event) => {
              setReportOffset(0);
              setCreatedAfter(event.target.value);
            }}
            type="date"
            value={createdAfter}
          />
        </label>
        <label className="flex w-full flex-col gap-1 text-xs font-semibold text-muted sm:w-34">
          {t("contentQuality.reports.toDateLabel")}
          <input
            className="h-10 min-h-10 w-full rounded-control border border-border bg-white px-2 text-sm font-medium text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onChange={(event) => {
              setReportOffset(0);
              setCreatedBefore(event.target.value);
            }}
            type="date"
            value={createdBefore}
          />
        </label>
      </AdminToolbar>

      <section className="rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold tracking-tight text-ink">
              {t("contentQuality.reports.heading")}
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              {t("contentQuality.reports.subtitle")}
            </p>
          </div>
          <span className="shrink-0 text-xs font-bold tabular-nums text-muted">
            {t("contentQuality.reports.countBadge", {
              count: reports?.total ?? 0,
            })}
          </span>
        </div>

        {loadingReports ? (
          <AdminLoading
            label={t("contentQuality.reports.loading")}
            variant="skeleton"
          />
        ) : reportError ? (
          <StatusMessage
            title={t("contentQuality.reports.loadErrorTitle")}
            tone="error"
          >
            {reportError}
          </StatusMessage>
        ) : !reports || reports.items.length === 0 ? (
          <EmptyState
            description={t("contentQuality.reports.emptyDesc")}
            title={t("contentQuality.reports.emptyTitle")}
          />
        ) : (
          <div className="grid gap-3">
            {reports.items.map((report) => {
              const isSelected = selectedReport?.id === report.id;
              return (
                <article
                  className={cn(
                    "rounded-xl border p-4 transition-colors",
                    isSelected
                      ? "border-primary bg-sky/20 ring-1 ring-primary/25"
                      : "border-border bg-white hover:border-primary/40 hover:bg-surface-subtle/50",
                  )}
                  key={report.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <AdminBadge
                          dot
                          tone={reportStatusTones[report.status] ?? "neutral"}
                        >
                          {t(`contentQuality.reportStatuses.${report.status}`)}
                        </AdminBadge>
                        <AdminBadge tone="neutral">
                          {t(
                            `contentQuality.reportIssueTypes.${report.issue_type}`,
                          )}
                        </AdminBadge>
                      </div>
                      <h3 className="mt-2 text-base font-extrabold text-ink">
                        {report.book_title}
                        <span className="font-semibold text-muted">
                          {report.page_number !== null
                            ? t("contentQuality.reports.pageScope", {
                                pageNumber: report.page_number,
                              })
                            : t("contentQuality.reports.wholeBookScope")}
                        </span>
                      </h3>
                      <p className="mt-0.5 text-xs text-muted">
                        {t("contentQuality.reports.reporterPrefix")}{" "}
                        {report.reporter_name ||
                          t("contentQuality.reports.reporterFallback")}
                        {" · "}
                        <span className="tabular-nums">
                          {formatDate(report.created_at)}
                        </span>
                      </p>
                    </div>
                    <Button
                      className="min-w-[8.25rem] shrink-0 whitespace-nowrap"
                      disabled={busyKey === `report:${report.id}`}
                      onClick={() => void openReport(report.id)}
                      size="admin"
                      variant={isSelected ? "primary" : "outline"}
                    >
                      {t("contentQuality.reports.viewDetails")}
                    </Button>
                  </div>
                  <p className="mt-2.5 whitespace-pre-wrap text-sm leading-6 text-ink">
                    {report.description}
                  </p>
                  {report.reported_text ? (
                    <p className="mt-2 rounded-control bg-surface-subtle px-3 py-2 text-xs text-muted">
                      {t("contentQuality.reports.suspectedExcerptPrefix")}{" "}
                      <span
                        className="viread-learning-content font-semibold text-ink"
                        dir="ltr"
                        lang="vi"
                      >
                        {report.reported_text}
                      </span>
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}

        {reports ? (
          <PaginationBar
            ariaLabel={t("contentQuality.reports.paginationAria")}
            className="mt-4"
            compact
            disabled={loadingReports}
            itemLabel={t("contentQuality.reports.itemLabel")}
            onPageChange={(nextPage) =>
              setReportOffset((nextPage - 1) * reportLimit)
            }
            page={Math.floor(reportOffset / reportLimit) + 1}
            pageSize={reportLimit}
            total={reports.total}
          />
        ) : null}
      </section>
    </div>
  ) : null;

  const booksSectionNode = showBooks ? (
    <div className="space-y-4">
      {books ? (
        <>
          <AdminKpiGrid
            ariaLabel={t(
              "contentQuality.booksScan.kpiAria",
              undefined,
              "Tổng quan duyệt và an toàn sách",
            )}
            columns={5}
          >
            <AdminKpiCard
              active={bookApprovalFilter === "PENDING_ADMIN_REVIEW"}
              icon={<Clock className="size-4" />}
              label={t(
                "contentQuality.assessmentStatuses.PENDING_ADMIN_REVIEW",
              )}
              onClick={() => {
                setBookOffset(0);
                setBookApprovalFilter((prev) =>
                  prev === "PENDING_ADMIN_REVIEW" ? "" : "PENDING_ADMIN_REVIEW",
                );
              }}
              tone={
                (bookSummary.PENDING_ADMIN_REVIEW ?? 0) > 0
                  ? "warning"
                  : "neutral"
              }
              value={formatNumber(bookSummary.PENDING_ADMIN_REVIEW ?? 0)}
            />
            <AdminKpiCard
              active={bookApprovalFilter === "APPROVED_BY_ADMIN"}
              detail={t(
                "contentQuality.booksScan.kpiApprovedDetail",
                {
                  ready: formatNumber(bookSummary.READY_FOR_CHILDREN ?? 0),
                  approved: formatNumber(bookSummary.APPROVED_BY_ADMIN ?? 0),
                  published: formatNumber(bookSummary.PUBLISHED ?? 0),
                },
                "Sẵn sàng: {ready} · Admin duyệt: {approved} · Tự xuất bản: {published}",
              )}
              icon={<BookCheck className="size-4" />}
              label={t(
                "contentQuality.booksScan.kpiApprovedGroup",
                undefined,
                "Đủ điều kiện / Đã duyệt",
              )}
              onClick={() => {
                setBookOffset(0);
                setBookApprovalFilter((prev) =>
                  prev === "APPROVED_BY_ADMIN" ? "" : "APPROVED_BY_ADMIN",
                );
              }}
              tone="success"
              value={formatNumber(approvedGroupTotal)}
            />
            <AdminKpiCard
              active={bookApprovalFilter === "PROCESSING"}
              detail={t(
                "contentQuality.booksScan.kpiProcessingDetail",
                {
                  processing: formatNumber(bookSummary.PROCESSING ?? 0),
                  stale: formatNumber(bookSummary.STALE ?? 0),
                  failed: formatNumber(bookSummary.SCAN_FAILED ?? 0),
                },
                "Đang quét: {processing} · Stale: {stale} · Lỗi scan: {failed}",
              )}
              icon={<RefreshCw className="size-4" />}
              label={t(
                "contentQuality.booksScan.kpiProcessingGroup",
                undefined,
                "Đang xử lý / Cần quét lại",
              )}
              onClick={() => {
                setBookOffset(0);
                setBookApprovalFilter((prev) =>
                  prev === "PROCESSING" ? "" : "PROCESSING",
                );
              }}
              tone={processingGroupTotal > 0 ? "info" : "neutral"}
              value={formatNumber(processingGroupTotal)}
            />
            <AdminKpiCard
              active={bookAlertFilter === "CHILD_SAFETY"}
              icon={<ShieldAlert className="size-4" />}
              label={t("contentQuality.booksScan.alertCards.CHILD_SAFETY")}
              onClick={() => {
                setBookOffset(0);
                setBookAlertFilter((prev) =>
                  prev === "CHILD_SAFETY" ? "" : "CHILD_SAFETY",
                );
              }}
              tone={(bookAlerts.CHILD_SAFETY ?? 0) > 0 ? "danger" : "neutral"}
              value={formatNumber(bookAlerts.CHILD_SAFETY ?? 0)}
            />
            <AdminKpiCard
              active={bookAlertFilter === "COPYRIGHT"}
              detail={t(
                "contentQuality.booksScan.kpiCopyrightDetail",
                { both: formatNumber(bookAlerts.BOTH ?? 0) },
                "Cả Safety & Copyright: {both}",
              )}
              icon={<AlertTriangle className="size-4" />}
              label={t("contentQuality.booksScan.alertCards.COPYRIGHT")}
              onClick={() => {
                setBookOffset(0);
                setBookAlertFilter((prev) =>
                  prev === "COPYRIGHT" ? "" : "COPYRIGHT",
                );
              }}
              tone={(bookAlerts.COPYRIGHT ?? 0) > 0 ? "warning" : "neutral"}
              value={formatNumber(bookAlerts.COPYRIGHT ?? 0)}
            />
          </AdminKpiGrid>

          <details className="rounded-xl border border-border bg-white px-4 py-2.5 text-xs shadow-2xs">
            <summary className="cursor-pointer font-bold text-ink">
              {t(
                "contentQuality.booksScan.statusBreakdownToggle",
                { count: APPROVAL_STATUS_KEYS.length },
                "Xem phân bổ chi tiết theo trạng thái ({count} nhóm)",
              )}
            </summary>
            <div className="mt-3 flex flex-wrap gap-2 border-t border-border/70 pt-3">
              {APPROVAL_STATUS_KEYS.map((status) => (
                <button
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold transition-colors",
                    bookApprovalFilter === status
                      ? "border-primary bg-primary text-white"
                      : "border-border bg-surface-subtle text-ink hover:border-primary/40",
                  )}
                  key={status}
                  onClick={() => {
                    setBookOffset(0);
                    setBookApprovalFilter((prev) =>
                      prev === status ? "" : status,
                    );
                  }}
                  type="button"
                >
                  <span>
                    {t(`contentQuality.assessmentStatuses.${status}`)}
                  </span>
                  <span className="tabular-nums opacity-80">
                    {formatNumber(bookSummary[status] ?? 0)}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {t("contentQuality.booksScan.statsNote")}
            </p>
          </details>
        </>
      ) : null}

      <AdminToolbar
        actions={
          hasBookFilters ? (
            <Button
              onClick={clearBookFilters}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("metadataQuality.clearFilters")}
            </Button>
          ) : undefined
        }
        ariaLabel={t("contentQuality.booksScan.heading")}
      >
        <AdminSearchInput
          label={t("contentQuality.booksScan.searchLabel")}
          onChange={(value) => {
            setBookOffset(0);
            setBookSearch(value);
          }}
          placeholder={t("contentQuality.booksScan.searchPlaceholder")}
          value={bookSearch}
        />
        <AdminSelect
          containerClassName="w-full sm:w-56"
          label={t("contentQuality.booksScan.assessmentFilterLabel")}
          onChange={(value) => {
            setBookOffset(0);
            setBookApprovalFilter(value as BookApprovalStatus | "");
          }}
          value={bookApprovalFilter}
        >
          <option value="">
            {t("contentQuality.booksScan.allStatusesOption")}
          </option>
          {APPROVAL_STATUS_KEYS.map((status) => (
            <option key={status} value={status}>
              {t(`contentQuality.assessmentStatuses.${status}`)}
            </option>
          ))}
        </AdminSelect>
        <AdminSelect
          containerClassName="w-full sm:w-52"
          label={t("contentQuality.booksScan.alertFilterLabel")}
          onChange={(value) => {
            setBookOffset(0);
            setBookAlertFilter(
              value as "" | "CHILD_SAFETY" | "COPYRIGHT" | "BOTH",
            );
          }}
          value={bookAlertFilter}
        >
          <option value="">
            {t("contentQuality.booksScan.allAlertsOption")}
          </option>
          <option value="CHILD_SAFETY">
            {t("contentQuality.booksScan.alertChildSafetyOption")}
          </option>
          <option value="COPYRIGHT">
            {t("contentQuality.booksScan.alertCopyrightOption")}
          </option>
          <option value="BOTH">
            {t("contentQuality.booksScan.alertBothOption")}
          </option>
        </AdminSelect>
      </AdminToolbar>

      <section className="rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold tracking-tight text-ink">
              {t("contentQuality.booksScan.heading")}
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              {t("contentQuality.booksScan.subtitle")}
            </p>
          </div>
          <span className="shrink-0 text-xs font-bold tabular-nums text-muted">
            {t("contentQuality.booksScan.countBadge", {
              count: books?.total ?? 0,
            })}
          </span>
        </div>

        {loadingBooks ? (
          <AdminLoading
            label={t("contentQuality.booksScan.loading")}
            variant="skeleton"
          />
        ) : bookError ? (
          <StatusMessage
            title={t("contentQuality.booksScan.loadErrorTitle")}
            tone="error"
          >
            {bookError}
          </StatusMessage>
        ) : !books || books.items.length === 0 ? (
          <EmptyState
            description={t("contentQuality.booksScan.emptyDesc")}
            title={t("contentQuality.booksScan.emptyTitle")}
          />
        ) : (
          <div className="grid gap-3">
            {books.items.map((book) => {
              const isSelected = selectedBook?.book_id === book.book_id;
              const isScanning =
                book.latest_scan?.status === "QUEUED" ||
                book.latest_scan?.status === "RUNNING";
              return (
                <article
                  className={cn(
                    "rounded-xl border p-4 transition-colors",
                    isSelected
                      ? "border-primary bg-sky/20 ring-1 ring-primary/25"
                      : "border-border bg-white hover:border-primary/40 hover:bg-surface-subtle/50",
                  )}
                  key={book.book_id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <AdminBadge
                          dot
                          tone={
                            approvalStatusTones[book.assessment.status] ??
                            "neutral"
                          }
                        >
                          {t(
                            `contentQuality.assessmentStatuses.${book.assessment.status}`,
                            undefined,
                            book.assessment.status,
                          )}
                        </AdminBadge>
                        {book.assessment.finding_count > 0 ? (
                          <AdminBadge tone="danger">
                            {t(
                              "contentQuality.booksScan.childSafetyAlertBadge",
                            )}
                          </AdminBadge>
                        ) : null}
                        {book.assessment.copyright_finding_count !== null &&
                        book.assessment.copyright_finding_count > 0 ? (
                          <AdminBadge tone="warning">
                            {t("contentQuality.booksScan.copyrightAlertBadge")}
                          </AdminBadge>
                        ) : null}
                      </div>

                      <h3
                        className="mt-2 text-base font-extrabold text-ink"
                        dir="auto"
                      >
                        {book.book_title}
                      </h3>

                      <p className="mt-1 text-xs text-muted">
                        {t("contentQuality.booksScan.assessmentSummaryLine", {
                          proofreading: formatQualityEnum(
                            book.assessment.proofreading_status,
                          ),
                          safety: formatQualityEnum(
                            book.assessment.child_safety_status,
                          ),
                        })}{" "}
                        {t(
                          `contentQuality.rightsStatuses.${book.assessment.copyright_status}`,
                          undefined,
                          formatQualityEnum(book.assessment.copyright_status),
                        )}
                      </p>

                      <p className="mt-1 text-xs font-semibold tabular-nums text-warning">
                        {t(
                          "contentQuality.booksScan.childSafetyFindingsCount",
                          {
                            count: formatNumber(book.assessment.finding_count),
                          },
                        )}
                        {` · Nghiêm trọng ${formatNumber(book.assessment.high_finding_count)}`}
                        {` · Trung bình ${formatNumber(book.assessment.medium_finding_count)}`}
                        {` · ${t(
                          `contentQuality.rightsStatuses.${book.assessment.copyright_status}`,
                          undefined,
                          formatQualityEnum(book.assessment.copyright_status),
                        )}`}
                      </p>

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted tabular-nums">
                        <span>
                          {t("contentQuality.booksScan.bookMetricsLine", {
                            reports: formatNumber(book.report_count),
                            findings: formatNumber(book.finding_count),
                            needsReview: formatNumber(
                              book.needs_review_finding_count,
                            ),
                          })}
                        </span>
                        <span>
                          {book.latest_scan ? (
                            <>
                              {t("contentQuality.booksScan.latestScanLine")}{" "}
                              {t(
                                `contentQuality.scanStatuses.${book.latest_scan.status}`,
                                undefined,
                                book.latest_scan.status,
                              )}
                              {" · "}
                              {t("contentQuality.booksScan.pagesCheckedRatio", {
                                completed: formatNumber(
                                  book.latest_scan.completed_pages,
                                ),
                                total: formatNumber(
                                  book.latest_scan.total_pages,
                                ),
                              })}
                              {" · "}
                              {formatDate(book.latest_scan.created_at)}
                            </>
                          ) : (
                            t("contentQuality.booksScan.noScanHistory")
                          )}
                        </span>
                      </div>
                      <QualityScanProgressBar
                        enqueuing={busyKey === `scan:${book.book_id}`}
                        scan={book.latest_scan}
                        testId={`quality-book-scan-progress-${book.book_id}`}
                      />
                    </div>

                    <div className="grid w-full grid-cols-2 gap-2 sm:w-[20rem] sm:shrink-0 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                      <Button
                        className="w-full whitespace-nowrap px-2.5"
                        disabled={busyKey === `book:${book.book_id}`}
                        onClick={() => void openBook(book.book_id)}
                        size="admin"
                        variant={isSelected ? "primary" : "secondary"}
                      >
                        {t("contentQuality.booksScan.viewResults")}
                      </Button>
                      <Button
                        className="w-full whitespace-nowrap px-2.5"
                        disabled={
                          busyKey === `scan:${book.book_id}` || isScanning
                        }
                        onClick={() => void enqueueBookScan(book.book_id)}
                        size="admin"
                        variant="outline"
                      >
                        {isScanning
                          ? t("contentQuality.booksScan.scanning")
                          : t("contentQuality.booksScan.scanWholeBook")}
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {books ? (
          <PaginationBar
            ariaLabel={t("contentQuality.booksScan.paginationAria")}
            className="mt-4"
            compact
            disabled={loadingBooks}
            itemLabel={t("contentQuality.booksScan.itemLabel")}
            onPageChange={(nextPage) =>
              setBookOffset((nextPage - 1) * bookLimit)
            }
            page={Math.floor(bookOffset / bookLimit) + 1}
            pageSize={bookLimit}
            total={books.total}
          />
        ) : null}
      </section>
    </div>
  ) : null;

  return (
    <section
      className={cn(
        "space-y-4",
        !embedded && "mt-8 border-t border-border pt-6",
      )}
    >
      {!embedded ? (
        <AdminPageHeader
          actions={
            <Button
              disabled={loadingReports || loadingBooks}
              onClick={() => void Promise.all([loadReports(), loadBooks()])}
              size="admin"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {t("common.reload")}
            </Button>
          }
          description={t("contentQuality.description")}
          eyebrow={t("contentQuality.eyebrow")}
          title={t("contentQuality.heading")}
        />
      ) : null}

      {actionError ? (
        <StatusMessage
          title={t("contentQuality.errors.actionNotDoneTitle")}
          tone="error"
        >
          {actionError}
        </StatusMessage>
      ) : null}

      {section === "all" ? (
        <>
          <div
            aria-label={t("contentQuality.sectionNavAria")}
            className="inline-flex flex-wrap gap-1.5 rounded-xl border border-border bg-surface-subtle p-1.5"
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                const nextTab =
                  activeTab === "catalog" ? "user-books" : "catalog";
                setActiveTab(nextTab);
                const nextId =
                  nextTab === "catalog"
                    ? "quality-tab-catalog"
                    : "quality-tab-user-books";
                document.getElementById(nextId)?.focus();
              }
            }}
            role="tablist"
          >
            <button
              aria-controls="quality-panel-catalog"
              aria-selected={activeTab === "catalog"}
              className={cn(
                "inline-flex min-h-10 items-center gap-2 rounded-control px-3.5 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                activeTab === "catalog"
                  ? "bg-white text-primary shadow-2xs ring-1 ring-border"
                  : "text-muted hover:bg-white/75 hover:text-ink",
              )}
              id="quality-tab-catalog"
              onClick={() => setActiveTab("catalog")}
              role="tab"
              tabIndex={activeTab === "catalog" ? 0 : -1}
              type="button"
            >
              {t("contentQuality.tabs.catalog")}
            </button>
            <button
              aria-controls="quality-panel-user-books"
              aria-selected={activeTab === "user-books"}
              className={cn(
                "inline-flex min-h-10 items-center gap-2 rounded-control px-3.5 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                activeTab === "user-books"
                  ? "bg-white text-primary shadow-2xs ring-1 ring-border"
                  : "text-muted hover:bg-white/75 hover:text-ink",
              )}
              id="quality-tab-user-books"
              onClick={() => setActiveTab("user-books")}
              role="tab"
              tabIndex={activeTab === "user-books" ? 0 : -1}
              type="button"
            >
              {t("contentQuality.tabs.userBooks")}
            </button>
          </div>

          {activeTab === "user-books" ? (
            <div
              aria-labelledby="quality-tab-user-books"
              id="quality-panel-user-books"
              role="tabpanel"
            >
              <AdminUserBooksQualitySection embedded />
            </div>
          ) : (
            <div
              aria-labelledby="quality-tab-catalog"
              className="space-y-6"
              id="quality-panel-catalog"
              role="tabpanel"
            >
              {reportsSectionNode}
              {booksSectionNode}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-6">
          {reportsSectionNode}
          {booksSectionNode}
        </div>
      )}

      {/* Report Detail Drawer */}
      <AdminDrawer
        closeLabel={t("contentQuality.reports.closeDetail")}
        footer={
          <Button onClick={closeReportDrawer} size="admin" variant="outline">
            {t("contentQuality.reports.closeDetail")}
          </Button>
        }
        isOpen={Boolean(selectedReport)}
        onClose={closeReportDrawer}
        size="xl"
        title={t("contentQuality.reports.detailHeading")}
      >
        {selectedReport ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <AdminBadge
                dot
                tone={reportStatusTones[selectedReport.status] ?? "neutral"}
              >
                {t(`contentQuality.reportStatuses.${selectedReport.status}`)}
              </AdminBadge>
              <AdminBadge tone="neutral">
                {t(
                  `contentQuality.reportIssueTypes.${selectedReport.issue_type}`,
                )}
              </AdminBadge>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3 rounded-xl border border-border bg-surface-subtle/50 p-4">
                <h3 className="text-sm font-extrabold text-ink">
                  {t("contentQuality.reports.snapshotHeading")}
                </h3>
                <p className="text-sm font-semibold text-ink">
                  {selectedReport.book_title}
                  <span className="font-normal text-muted">
                    {selectedReport.page_number !== null
                      ? t("contentQuality.reports.pageScope", {
                          pageNumber: selectedReport.page_number,
                        })
                      : t("contentQuality.reports.wholeBookScope")}
                  </span>
                </p>
                <p className="whitespace-pre-wrap text-sm leading-6 text-ink">
                  {selectedReport.description}
                </p>
                {selectedReport.verified_text_snapshot ? (
                  <pre
                    className="viread-learning-content max-h-56 overflow-auto whitespace-pre-wrap rounded-control border border-border bg-white p-3 text-xs leading-5 text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    {selectedReport.verified_text_snapshot}
                  </pre>
                ) : (
                  <p className="text-xs text-muted">
                    {t("contentQuality.reports.noSnapshot")}
                  </p>
                )}
                {selectedReport.page_id && selectedReport.book_id ? (
                  <ButtonLink
                    href={`/admin/books/${encodeURIComponent(selectedReport.book_id)}/pages/${encodeURIComponent(selectedReport.page_id)}${selectedReport.page_revision_id ? `?revisionId=${encodeURIComponent(selectedReport.page_revision_id)}` : ""}`}
                    size="admin"
                    variant="outline"
                  >
                    {t("contentQuality.reports.openOriginalInOcr")}
                  </ButtonLink>
                ) : null}
              </div>

              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-white p-4">
                  <h3 className="text-sm font-extrabold text-ink">
                    {t("contentQuality.reports.historyHeading")}
                  </h3>
                  <ol className="mt-2.5 space-y-3 border-s-2 border-border ps-3.5">
                    {visibleReportHistory.map((item, index) => (
                      <li key={`${item.created_at}-${index}`}>
                        <p className="text-xs font-bold text-ink">
                          {item.from_status
                            ? `${t(`contentQuality.reportStatuses.${item.from_status}`)} → `
                            : ""}
                          {t(`contentQuality.reportStatuses.${item.to_status}`)}
                        </p>
                        <p className="text-[11px] text-muted tabular-nums">
                          {item.actor_name ||
                            t("contentQuality.reports.systemActor")}{" "}
                          · {formatDate(item.created_at)}
                        </p>
                        {item.note ? (
                          <p className="mt-1 text-xs text-muted">{item.note}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  <PaginationBar
                    className="mt-3"
                    compact
                    onPageChange={setReportHistoryPage}
                    page={safeReportHistoryPage}
                    pageSize={DRAWER_LIST_PAGE_SIZE}
                    total={reportHistoryItems.length}
                  />
                </div>

                <div className="rounded-xl border border-border bg-white p-4">
                  <h3 className="text-sm font-extrabold text-ink">
                    {t("contentQuality.reports.linkedFindingsHeading")}
                  </h3>
                  {selectedReport.related_findings.length ? (
                    <div className="mt-2.5 grid gap-2">
                      {visibleReportRelatedFindings.map((finding) => (
                        <div
                          className="rounded-control border border-border bg-surface-subtle/60 p-3"
                          key={finding.id}
                        >
                          <p className="text-xs font-bold text-ink">
                            {t("contentQuality.findingCard.pageIssue", {
                              pageNumber: finding.page_number,
                              issueType: formatQualityEnum(finding.issue_type),
                            })}
                          </p>
                          <p className="mt-0.5 text-[11px] text-muted">
                            {t(
                              `contentQuality.findingStatuses.${finding.status}`,
                            )}{" "}
                            · {formatQualityEnum(finding.detection_source)}
                          </p>
                          <p
                            className="viread-learning-content mt-1.5 whitespace-pre-wrap text-xs text-ink"
                            dir="ltr"
                            lang="vi"
                          >
                            {finding.original_excerpt}
                          </p>
                        </div>
                      ))}
                      <PaginationBar
                        className="mt-1"
                        compact
                        onPageChange={setReportRelatedFindingsPage}
                        page={safeReportRelatedFindingsPage}
                        pageSize={DRAWER_LIST_PAGE_SIZE}
                        total={reportRelatedFindings.length}
                      />
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted">
                      {t("contentQuality.reports.noLinkedFindings")}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-surface-subtle/50 p-4">
              <label
                className="block text-xs font-bold text-ink"
                htmlFor="report-resolution-note"
              >
                {t("contentQuality.reports.adminNoteLabel")}
                <textarea
                  className="mt-1.5 min-h-20 w-full rounded-control border border-border bg-white p-3 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  id="report-resolution-note"
                  maxLength={2000}
                  onChange={(event) => setResolutionNote(event.target.value)}
                  placeholder={t("contentQuality.reports.adminNotePlaceholder")}
                  value={resolutionNote}
                />
              </label>
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedReport.status === "OPEN" ? (
                  <Button
                    disabled={busyKey === `report-status:${selectedReport.id}`}
                    onClick={() =>
                      void changeReportStatus(selectedReport.id, "UNDER_REVIEW")
                    }
                    size="admin"
                    variant="secondary"
                  >
                    {t("contentQuality.reports.actions.takeReview")}
                  </Button>
                ) : null}
                {selectedReport.status === "UNDER_REVIEW" ? (
                  <Button
                    disabled={busyKey === `report-status:${selectedReport.id}`}
                    onClick={() =>
                      void changeReportStatus(selectedReport.id, "OPEN")
                    }
                    size="admin"
                    variant="outline"
                  >
                    {t("contentQuality.reports.actions.returnOpen")}
                  </Button>
                ) : null}
                {["OPEN", "UNDER_REVIEW"].includes(selectedReport.status) ? (
                  <>
                    <Button
                      disabled={
                        !resolutionNote.trim() ||
                        busyKey === `report-status:${selectedReport.id}`
                      }
                      onClick={() =>
                        void changeReportStatus(selectedReport.id, "RESOLVED")
                      }
                      size="admin"
                      variant="primary"
                    >
                      {t("contentQuality.reports.actions.resolve")}
                    </Button>
                    <Button
                      disabled={
                        !resolutionNote.trim() ||
                        busyKey === `report-status:${selectedReport.id}`
                      }
                      onClick={() =>
                        void changeReportStatus(selectedReport.id, "REJECTED")
                      }
                      size="admin"
                      variant="destructive-outline"
                    >
                      {t("contentQuality.reports.actions.rejectWithReason")}
                    </Button>
                  </>
                ) : (
                  <Button
                    disabled={
                      !resolutionNote.trim() ||
                      busyKey === `report-status:${selectedReport.id}`
                    }
                    onClick={() =>
                      void changeReportStatus(selectedReport.id, "UNDER_REVIEW")
                    }
                    size="admin"
                    variant="outline"
                  >
                    {t("contentQuality.reports.actions.reopen")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </AdminDrawer>

      {/* Book Assessment Detail Drawer */}
      <AdminDrawer
        description={t("contentQuality.bookDetail.subheading")}
        footer={
          selectedBook ? (
            <>
              <Button
                disabled={
                  busyKey === `scan:${selectedBook.book_id}` ||
                  selectedBook.scans.some(
                    (run) =>
                      run.status === "QUEUED" || run.status === "RUNNING",
                  )
                }
                onClick={() => void enqueueBookScan(selectedBook.book_id)}
                size="admin"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" className="size-4" />
                {t("contentQuality.bookDetail.rescanBook")}
              </Button>
              <Button
                onClick={closeBookDrawer}
                size="admin"
                variant="secondary"
              >
                {t("common.close")}
              </Button>
            </>
          ) : undefined
        }
        isOpen={Boolean(selectedBook)}
        onClose={closeBookDrawer}
        size="xl"
        title={selectedBook?.book_title ?? ""}
      >
        {selectedBook ? (
          <div className="space-y-5">
            <section
              aria-label={t("contentQuality.bookDetail.assessmentAria")}
              className="space-y-4 rounded-xl border border-border bg-surface-subtle/50 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-extrabold text-ink">
                  {t("contentQuality.bookDetail.assessmentHeading")}
                </h3>
                <AdminBadge
                  dot
                  tone={
                    approvalStatusTones[selectedBook.assessment.status] ??
                    "neutral"
                  }
                >
                  {t(
                    `contentQuality.assessmentStatuses.${selectedBook.assessment.status}`,
                    undefined,
                    selectedBook.assessment.status,
                  )}
                </AdminBadge>
              </div>

              <QualityScanProgressBar
                enqueuing={busyKey === `scan:${selectedBook.book_id}`}
                scan={selectedBook.latest_scan_detail}
                testId="quality-drawer-scan-progress"
              />

              <AdminKpiGrid columns={4}>
                <AdminKpiCard
                  detail={t(
                    "contentQuality.bookDetail.compactOcrDetail",
                    {
                      valid: formatNumber(
                        selectedBook.assessment.ocr_approval_valid_pages,
                      ),
                      total: formatNumber(selectedBook.assessment.page_count),
                      unscanned: formatNumber(
                        selectedBook.assessment.failed_or_unscanned_page_count,
                      ),
                    },
                    "Đã khớp: {valid}/{total} · Chưa quét: {unscanned}",
                  )}
                  label={t("contentQuality.bookDetail.metrics.activePages")}
                  tone="neutral"
                  value={`${formatNumber(selectedBook.assessment.ocr_completed_pages)}/${formatNumber(selectedBook.assessment.page_count)}`}
                />
                <AdminKpiCard
                  detail={t(
                    "contentQuality.bookDetail.compactSafetyDetail",
                    {
                      proofreading: formatQualityEnum(
                        selectedBook.assessment.proofreading_status,
                      ),
                    },
                    "Kiểm tra chính tả: {proofreading}",
                  )}
                  label={t(
                    "contentQuality.bookDetail.metrics.childSafetyLabel",
                  )}
                  tone={
                    selectedBook.assessment.child_safety_status === "COMPLETED"
                      ? "success"
                      : "warning"
                  }
                  value={`${formatNumber(selectedBook.assessment.child_safety_completed_pages)}/${formatNumber(selectedBook.assessment.page_count)}`}
                />
                <AdminKpiCard
                  detail={t(
                    "contentQuality.bookDetail.compactFindingsDetail",
                    {
                      high: formatNumber(
                        selectedBook.assessment.high_finding_count,
                      ),
                      medium: formatNumber(
                        selectedBook.assessment.medium_finding_count,
                      ),
                      pages: formatNumber(
                        selectedBook.assessment.warning_page_count,
                      ),
                    },
                    "Nghiêm trọng {high} · Trung bình {medium} · {pages} trang cảnh báo",
                  )}
                  label={t("contentQuality.bookDetail.metrics.findingsLabel")}
                  tone={
                    selectedBook.assessment.high_finding_count > 0
                      ? "danger"
                      : selectedBook.assessment.finding_count > 0
                        ? "warning"
                        : "success"
                  }
                  value={formatNumber(selectedBook.assessment.finding_count)}
                />
                <AdminKpiCard
                  detail={t(
                    "contentQuality.bookDetail.compactPipelineDetail",
                    {
                      stale: formatNumber(selectedBook.assessment.stale_pages),
                      processing: formatNumber(
                        selectedBook.assessment.processing_pages,
                      ),
                    },
                    "Cần quét lại: {stale} · Đang xử lý: {processing}",
                  )}
                  label={t(
                    "contentQuality.bookDetail.metrics.failedOrUnscanned",
                  )}
                  tone={
                    selectedBook.assessment.failed_or_unscanned_page_count > 0
                      ? "danger"
                      : "neutral"
                  }
                  value={formatNumber(
                    selectedBook.assessment.failed_or_unscanned_page_count,
                  )}
                />
              </AdminKpiGrid>

              <details className="rounded-control border border-border bg-white px-3.5 py-2.5 text-xs">
                <summary className="cursor-pointer font-bold text-ink">
                  {t(
                    "contentQuality.bookDetail.compactMetricsToggle",
                    undefined,
                    "Xem chi tiết chỉ số kiểm tra AI & đánh giá",
                  )}
                </summary>
                <div
                  aria-label={t("contentQuality.bookDetail.aiSummaryAria")}
                  className="mt-3 grid grid-cols-2 gap-2 border-t border-border/70 pt-3 sm:grid-cols-3"
                >
                  <div className="rounded-control bg-surface-subtle p-2">
                    <p className="text-[11px] text-muted">
                      {t("contentQuality.bookDetail.metrics.rightsStatus")}
                    </p>
                    <p className="mt-0.5 font-bold text-ink">
                      {t(
                        `contentQuality.rightsStatuses.${selectedBook.assessment.copyright_status}`,
                        undefined,
                        formatQualityEnum(
                          selectedBook.assessment.copyright_status,
                        ),
                      )}
                    </p>
                  </div>
                  {(
                    [
                      ["pagesTotal", "pages_total"],
                      ["workflowsTotal", "workflows_total"],
                      ["pagesWithWorkflow", "pages_with_workflow"],
                      ["pagesWithoutWorkflow", "pages_without_workflow"],
                      ["proofreadingCompleted", "proofreading_completed"],
                      ["safetyCompleted", "safety_completed"],
                      ["safetyStale", "safety_stale"],
                      ["safetyUnscanned", "safety_unscanned"],
                      ["active", "active"],
                      ["readyForReview", "ready_for_review"],
                      ["failed", "failed"],
                      ["needsAdminReview", "needs_admin_review"],
                    ] as const
                  ).map(([labelKey, key]) => (
                    <div
                      className="rounded-control bg-surface-subtle p-2"
                      key={key}
                    >
                      <p className="text-[11px] text-muted">
                        {t(`contentQuality.bookDetail.aiMetrics.${labelKey}`)}
                      </p>
                      <p className="mt-0.5 font-bold tabular-nums text-ink">
                        {formatNumber(
                          selectedBook.ai_workflow_summary[key] ?? 0,
                        )}
                        {key === "needs_admin_review"
                          ? ` · ${formatNumber(selectedBook.ai_workflow_summary.finding_count ?? 0)}`
                          : ""}
                      </p>
                    </div>
                  ))}
                </div>
              </details>

              <div className="rounded-control border border-border bg-white p-3 text-xs leading-relaxed text-muted">
                {t("contentQuality.bookDetail.publishRulePrefix")}
                <strong className="text-ink">
                  {t("contentQuality.bookDetail.publishRuleStrong")}
                </strong>
                .
              </div>

              {/* Rights Evidence Panel */}
              <section
                aria-label={t("contentQuality.bookDetail.rightsSectionAria")}
                className="rounded-xl border border-border bg-white p-4"
                data-testid="book-rights-panel"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-extrabold text-ink">
                      {t("contentQuality.bookDetail.rightsHeading")}
                    </h4>
                    <p className="mt-0.5 text-xs text-muted">
                      {t("contentQuality.bookDetail.rightsDesc")}
                    </p>
                  </div>
                  <span data-testid="book-rights-status">
                    <AdminBadge
                      tone={
                        rightsStatusTones[
                          selectedBook.rights_evidence?.effective_status ??
                            selectedBook.assessment.copyright_status
                        ] ?? "neutral"
                      }
                    >
                      {t(
                        `contentQuality.rightsStatuses.${
                          selectedBook.rights_evidence?.effective_status ??
                          selectedBook.assessment.copyright_status
                        }`,
                        undefined,
                        formatQualityEnum(
                          selectedBook.rights_evidence?.effective_status ??
                            selectedBook.assessment.copyright_status,
                        ),
                      )}
                    </AdminBadge>
                  </span>
                </div>

                {selectedBook.rights_evidence?.is_stale ? (
                  <p className="mt-2.5 rounded-control border border-amber-300 bg-warning-surface p-2.5 text-xs font-semibold text-warning">
                    {t("contentQuality.bookDetail.rightsStaleWarning")}
                  </p>
                ) : null}

                {rightsSavedNotice ? (
                  <p
                    className="mt-2.5 rounded-control border border-emerald-200 bg-success-surface p-2.5 text-xs font-semibold text-success-ink"
                    role="status"
                  >
                    {rightsSavedNotice}
                  </p>
                ) : null}

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-bold text-ink">
                    {t("contentQuality.bookDetail.rightsStatusField")}
                    <select
                      className="mt-1 h-10 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      onChange={(event) =>
                        setRightsStatus(event.target.value as BookRightsStatus)
                      }
                      value={rightsStatus}
                    >
                      <option value="UNASSESSED">
                        {t(
                          "contentQuality.bookDetail.rightsOptions.UNASSESSED",
                        )}
                      </option>
                      <option value="INSUFFICIENT_EVIDENCE">
                        {t(
                          "contentQuality.bookDetail.rightsOptions.INSUFFICIENT_EVIDENCE",
                        )}
                      </option>
                      <option value="CONCERN_FLAGGED">
                        {t(
                          "contentQuality.bookDetail.rightsOptions.CONCERN_FLAGGED",
                        )}
                      </option>
                      <option value="RIGHTS_REVIEWED">
                        {t(
                          "contentQuality.bookDetail.rightsOptions.RIGHTS_REVIEWED",
                        )}
                      </option>
                    </select>
                  </label>
                  <label className="text-xs font-bold text-ink">
                    {t("contentQuality.bookDetail.usageBasisLabel")}
                    <input
                      className="mt-1 h-10 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      maxLength={120}
                      onChange={(event) =>
                        setRightsUsageBasis(event.target.value)
                      }
                      placeholder={t(
                        "contentQuality.bookDetail.usageBasisPlaceholder",
                      )}
                      type="text"
                      value={rightsUsageBasis}
                    />
                  </label>
                  <label className="text-xs font-bold text-ink">
                    {t("contentQuality.bookDetail.sourceLabel")}
                    <input
                      className="mt-1 h-10 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      maxLength={500}
                      onChange={(event) => setRightsSource(event.target.value)}
                      placeholder={t(
                        "contentQuality.bookDetail.sourcePlaceholder",
                      )}
                      type="text"
                      value={rightsSource}
                    />
                  </label>
                  <label className="text-xs font-bold text-ink">
                    {t("contentQuality.bookDetail.authorOrHolderLabel")}
                    <input
                      className="mt-1 h-10 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      maxLength={300}
                      onChange={(event) => setRightsAuthor(event.target.value)}
                      placeholder={t(
                        "contentQuality.bookDetail.authorOrHolderPlaceholder",
                      )}
                      type="text"
                      value={rightsAuthor}
                    />
                  </label>
                  <label className="text-xs font-bold text-ink sm:col-span-2">
                    {t("contentQuality.bookDetail.evidenceRefLabel")}
                    <input
                      className="mt-1 h-10 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      maxLength={1000}
                      onChange={(event) =>
                        setRightsEvidenceRef(event.target.value)
                      }
                      placeholder={t(
                        "contentQuality.bookDetail.evidenceRefPlaceholder",
                      )}
                      type="text"
                      value={rightsEvidenceRef}
                    />
                  </label>
                  <label className="text-xs font-bold text-ink sm:col-span-2">
                    {t("contentQuality.bookDetail.rightsNotesLabel")}
                    <textarea
                      className="mt-1 min-h-16 w-full rounded-control border border-border bg-white p-2.5 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      maxLength={2000}
                      onChange={(event) => setRightsNotes(event.target.value)}
                      placeholder={t(
                        "contentQuality.bookDetail.rightsNotesPlaceholder",
                      )}
                      value={rightsNotes}
                    />
                  </label>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <Button
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
                    size="admin"
                    type="button"
                  >
                    {t("contentQuality.bookDetail.saveRightsBtn")}
                  </Button>
                  {selectedBook.rights_evidence?.reviewed_at ? (
                    <span className="text-xs text-muted tabular-nums">
                      {t("contentQuality.bookDetail.lastUpdatedPrefix")}{" "}
                      {formatDate(selectedBook.rights_evidence.reviewed_at)}
                      {selectedBook.rights_evidence.reviewed_by_name
                        ? ` · ${selectedBook.rights_evidence.reviewed_by_name}`
                        : ""}
                    </span>
                  ) : null}
                </div>

                {selectedBook.rights_evidence?.history?.length ? (
                  <details className="mt-3 rounded-control border border-border bg-surface-subtle/60 p-2.5">
                    <summary className="cursor-pointer text-xs font-bold text-ink">
                      {t("contentQuality.bookDetail.rightsHistoryHeading", {
                        count: formatNumber(
                          selectedBook.rights_evidence.history.length,
                        ),
                      })}
                    </summary>
                    <ul className="mt-2 grid gap-2 text-xs">
                      {selectedBook.rights_evidence.history.map((entry) => (
                        <li
                          className="rounded-control border border-border bg-white p-2"
                          key={entry.id}
                        >
                          <span className="font-bold text-ink">
                            v{entry.version} ·{" "}
                            {t(
                              `contentQuality.rightsStatuses.${entry.to_status}`,
                              undefined,
                              entry.to_status,
                            )}
                          </span>{" "}
                          ·{" "}
                          <span className="tabular-nums text-muted">
                            {formatDate(entry.created_at)}
                          </span>
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

              {/* Page Diagnostics Panel */}
              {selectedBook.page_diagnostics?.length ? (
                <section
                  aria-label={t("contentQuality.bookDetail.diagnosticsAria")}
                  className="rounded-xl border border-border bg-white p-4"
                  data-testid="book-page-diagnostics"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-extrabold text-ink">
                        {t("contentQuality.bookDetail.diagnosticsHeading", {
                          count: formatNumber(
                            selectedBook.page_diagnostics.length,
                          ),
                        })}
                      </h4>
                      <p className="mt-0.5 text-xs text-muted">
                        {selectedBook.completeness_disclaimer ??
                          t(
                            "contentQuality.bookDetail.diagnosticsMissingPrintNote",
                          )}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(
                        ["ALL", "ISSUES", "UNVERIFIED", "MEDIA_OCR"] as const
                      ).map((value) => (
                        <button
                          className={cn(
                            "min-h-8 rounded-full border px-3 text-xs font-bold transition-colors",
                            pageDiagnosticFilter === value
                              ? "border-primary bg-primary text-white"
                              : "border-border bg-surface-subtle text-ink hover:border-primary/40",
                          )}
                          key={value}
                          onClick={() => {
                            setPageDiagnosticFilter(value);
                            setPageDiagnosticsPage(1);
                          }}
                          type="button"
                        >
                          {t(
                            `contentQuality.bookDetail.diagnosticsTabs.${value}`,
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                  <ul className="mt-3 grid gap-2">
                    {visiblePageDiagnostics.map((item, idx) => (
                      <li
                        className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border bg-surface-subtle/50 p-2.5 text-xs"
                        key={`${item.page_number}:${item.page_id ?? idx}`}
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-extrabold text-ink">
                            {t("contentQuality.bookDetail.pageNumberHeading", {
                              pageNumber: formatNumber(item.page_number),
                            })}
                          </span>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {item.codes.map((code) => (
                              <AdminBadge
                                key={code}
                                tone={code === "OK" ? "success" : "warning"}
                              >
                                {t(
                                  `contentQuality.diagnosticStatuses.${code}`,
                                  undefined,
                                  code,
                                )}
                              </AdminBadge>
                            ))}
                          </div>
                          <p className="mt-1 text-muted">{item.summary}</p>
                        </div>
                        {item.page_id ? (
                          <Link
                            className="inline-flex min-h-8 items-center rounded-control border border-border bg-white px-2.5 font-bold text-primary transition-colors hover:bg-surface-subtle"
                            href={`/admin/books/${encodeURIComponent(selectedBook.book_id)}/pages/${encodeURIComponent(item.page_id)}`}
                          >
                            {t("contentQuality.bookDetail.openOcrPage")}
                          </Link>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <PaginationBar
                    className="mt-3"
                    compact
                    onPageChange={setPageDiagnosticsPage}
                    page={safePageDiagnosticsPage}
                    pageSize={PAGE_DIAGNOSTICS_PAGE_SIZE}
                    total={filteredPageDiagnostics.length}
                  />
                </section>
              ) : null}

              {/* Child Safety Finding Groups */}
              {selectedBook.assessment.finding_groups.length ? (
                <div className="grid gap-3">
                  <h4 className="text-sm font-extrabold text-ink">
                    {t("contentQuality.bookDetail.childSafetySummaryHeading")}
                  </h4>
                  {visibleFindingGroups.map((group) => (
                    <article
                      className="rounded-xl border border-border bg-white p-3.5"
                      key={`${group.category}:${group.severity}`}
                    >
                      <p className="text-sm font-bold text-ink">
                        {t("contentQuality.bookDetail.groupSummaryLine", {
                          category: formatQualityEnum(group.category),
                          severity: formatQualitySeverity(group.severity),
                          findingCount: formatNumber(group.finding_count),
                          pageCount: formatNumber(group.page_count),
                        })}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {t("contentQuality.bookDetail.pagesListPrefix", {
                          pages: group.page_numbers.join(", "),
                        })}
                      </p>
                      {group.examples.map((example, index) => (
                        <div
                          className="mt-2.5 border-t border-border/70 pt-2.5"
                          key={`${example.page_number}:${index}`}
                        >
                          <p className="text-xs font-bold text-muted">
                            {t("contentQuality.bookDetail.evidencePage", {
                              pageNumber: example.page_number,
                            })}
                          </p>
                          <blockquote
                            className="viread-learning-content mt-1 whitespace-pre-wrap rounded-control bg-surface-subtle p-2 text-xs text-ink"
                            dir="ltr"
                            lang="vi"
                          >
                            {example.evidence_text}
                          </blockquote>
                          <p className="mt-1 text-xs text-muted">
                            {example.explanation}
                          </p>
                          <p className="mt-1 text-xs text-ink">
                            {example.recommendation}
                          </p>
                        </div>
                      ))}
                    </article>
                  ))}
                  <PaginationBar
                    compact
                    onPageChange={setFindingGroupsPage}
                    page={safeFindingGroupsPage}
                    pageSize={DRAWER_LIST_PAGE_SIZE}
                    total={findingGroupItems.length}
                  />
                </div>
              ) : null}

              {selectedBook.assessment.blockers.length ? (
                <p className="text-xs text-muted">
                  {t("contentQuality.bookDetail.remainingBlockers")}{" "}
                  {selectedBook.assessment.blockers.join(" · ")}
                </p>
              ) : null}

              {selectedBook.assessment.admin_approved_at ? (
                <p className="rounded-control border border-emerald-200 bg-success-surface p-2.5 text-xs font-semibold text-success-ink">
                  {selectedBook.assessment.publication_source ===
                  "AUTO_APPROVAL"
                    ? t("contentQuality.bookDetail.autoPublishedLabel")
                    : t("contentQuality.bookDetail.adminApprovedLabel")}{" "}
                  {formatDate(selectedBook.assessment.admin_approved_at)}
                  {selectedBook.assessment.admin_approved_by_name
                    ? ` · ${selectedBook.assessment.admin_approved_by_name}`
                    : ""}
                  {selectedBook.assessment.admin_reason
                    ? ` · ${selectedBook.assessment.admin_reason}`
                    : ""}
                </p>
              ) : null}

              {/* Decision Controls */}
              <div className="grid gap-3 border-t border-border pt-4">
                <label className="text-xs font-bold text-ink">
                  {t("contentQuality.bookDetail.decisionReasonLabel")}
                  <textarea
                    className="mt-1.5 min-h-20 w-full rounded-control border border-border bg-white p-3 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
                  <p className="rounded-control border border-danger/25 bg-danger-surface p-3 text-xs font-semibold text-danger">
                    {t("contentQuality.bookDetail.approveGuardHint")}
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button
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
                    size="admin"
                    variant="primary"
                  >
                    {t("contentQuality.bookDetail.approveBookBtn")}
                  </Button>
                  <Button
                    disabled={
                      !bookDecisionReason.trim() ||
                      busyKey === `book-decision:${selectedBook.book_id}`
                    }
                    onClick={() => void decideBook("REJECT")}
                    size="admin"
                    variant="destructive-outline"
                  >
                    {t("contentQuality.bookDetail.rejectBookBtn")}
                  </Button>
                  <Button
                    disabled={
                      !bookDecisionReason.trim() ||
                      busyKey === `book-decision:${selectedBook.book_id}`
                    }
                    onClick={() => void decideBook("REQUEST_RESCAN")}
                    size="admin"
                    variant="outline"
                  >
                    {t("contentQuality.bookDetail.requestRescanBtn")}
                  </Button>
                </div>

                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-48 flex-1 text-xs font-bold text-ink">
                    {t("contentQuality.bookDetail.falsePositiveCategoryLabel")}
                    <input
                      className="mt-1 h-10 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      onChange={(event) =>
                        setFalsePositiveCategory(event.target.value)
                      }
                      value={falsePositiveCategory}
                    />
                  </label>
                  <Button
                    disabled={
                      !bookDecisionReason.trim() ||
                      !falsePositiveCategory.trim() ||
                      busyKey === `book-decision:${selectedBook.book_id}`
                    }
                    onClick={() => void decideBook("FALSE_POSITIVE")}
                    size="admin"
                    variant="outline"
                  >
                    {t("contentQuality.bookDetail.falsePositiveBtn")}
                  </Button>
                </div>

                {selectedBook.decision_history.length ? (
                  <details className="rounded-control border border-border bg-white p-3">
                    <summary className="cursor-pointer text-xs font-bold text-ink">
                      {t("contentQuality.bookDetail.decisionHistoryHeading", {
                        count: formatNumber(
                          selectedBook.decision_history.length,
                        ),
                      })}
                    </summary>
                    <ul className="mt-2 grid gap-2">
                      {selectedBook.decision_history.map((decision, index) => (
                        <li
                          className="rounded-control bg-surface-subtle p-2.5 text-xs"
                          key={`${decision.action}:${decision.created_at}:${index}`}
                        >
                          <p className="font-bold text-ink">
                            {formatQualityEnum(decision.action)} ·{" "}
                            <span className="tabular-nums">
                              {decision.created_at
                                ? formatDate(decision.created_at)
                                : ""}
                            </span>
                            {decision.actor_name
                              ? ` · ${decision.actor_name}`
                              : ""}
                          </p>
                          <p className="mt-1 text-muted">
                            {decision.reason ??
                              t("contentQuality.bookDetail.noReasonFallback")}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            </section>

            {/* Scan History */}
            <section className="rounded-xl border border-border bg-white p-4">
              <h3 className="text-sm font-extrabold text-ink">
                {t("contentQuality.bookDetail.scanHistoryHeading")}
              </h3>
              {selectedBook.scans.length ? (
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {selectedBook.scans.map((scan) => (
                    <Button
                      key={scan.id}
                      onClick={() => void openScan(scan.id)}
                      size="admin"
                      variant={
                        selectedScan?.id === scan.id ? "primary" : "outline"
                      }
                    >
                      {t(
                        `contentQuality.scanStatuses.${scan.status}`,
                        undefined,
                        scan.status,
                      )}{" "}
                      · {formatDate(scan.created_at)}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  {t("contentQuality.bookDetail.noScanYet")}
                </p>
              )}
            </section>

            {/* Combined AI Workflow History */}
            <section className="rounded-xl border border-border bg-white p-4">
              <h3 className="text-sm font-extrabold text-ink">
                {t("contentQuality.bookDetail.aiHistoryHeading")}
              </h3>
              {aiAttentionCount > 0 ? (
                <div
                  aria-live="polite"
                  className="mt-3 rounded-control border border-amber-300 bg-warning-surface p-3 text-xs font-semibold text-warning"
                  role="status"
                >
                  {t("contentQuality.bookDetail.aiAttentionNotice", {
                    count: formatNumber(aiAttentionCount),
                  })}
                </div>
              ) : null}
              {selectedBook.ai_workflows.length ? (
                <div className="mt-3 grid gap-3">
                  {visibleAiWorkflows.map((workflow) => (
                    <article
                      className="rounded-xl border border-border bg-surface-subtle/40 p-3.5"
                      key={workflow.workflow_id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <h4 className="text-sm font-bold text-ink">
                            {formatQualityEnum(workflow.status)} ·{" "}
                            {formatQualityEnum(workflow.safety_status)}
                          </h4>
                          <p className="mt-0.5 text-xs text-muted">
                            {workflow.suitability
                              ? formatQualityEnum(workflow.suitability)
                              : t(
                                  "contentQuality.bookDetail.noSuitabilityFallback",
                                )}{" "}
                            · Phiên bản {workflow.candidate_version}
                            {workflow.hash_match
                              ? t("contentQuality.bookDetail.safetyHashMatch")
                              : t("contentQuality.bookDetail.safetyHashStale")}
                          </p>
                        </div>
                        <ButtonLink
                          href={`/admin/books/${encodeURIComponent(selectedBook.book_id)}/pages/${encodeURIComponent(workflow.page_id)}?revisionId=${encodeURIComponent(workflow.page_revision_id)}`}
                          size="admin"
                          variant="outline"
                        >
                          {t("contentQuality.bookDetail.openOcrReview")}
                        </ButtonLink>
                      </div>

                      {workflow.error_code ? (
                        <p className="mt-2 text-xs font-semibold text-danger">
                          {t("contentQuality.bookDetail.workflowError")}
                        </p>
                      ) : null}

                      <WorkflowInlineProgressBar
                        completedChunks={workflow.progress.completed_chunks}
                        progressPct={workflow.progress_pct}
                        status={workflow.status}
                        totalChunks={workflow.progress.total_chunks}
                      />

                      {workflow.findings.length ? (
                        <div className="mt-2.5 grid gap-2">
                          {workflow.findings.map((finding, index) => (
                            <div
                              className="rounded-control border border-border bg-white p-2.5"
                              key={String(finding.finding_id ?? index)}
                            >
                              <p className="text-xs font-bold text-ink">
                                {formatQualityEnum(finding.category)} ·{" "}
                                {formatQualityEnum(finding.content_type)} ·{" "}
                                {formatQualitySeverity(finding.severity)}
                              </p>
                              <p className="mt-0.5 text-[11px] text-muted">
                                {formatQualityEnum(finding.review_status)} ·{" "}
                                {String(finding.evidence_start ?? "?")}–
                                {String(finding.evidence_end ?? "?")}
                              </p>
                              <blockquote
                                className="viread-learning-content mt-1.5 whitespace-pre-wrap text-xs text-ink"
                                dir="ltr"
                                lang="vi"
                              >
                                {String(finding.evidence_text ?? "")}
                              </blockquote>
                              <p className="mt-1 text-xs text-muted">
                                {String(finding.explanation ?? "")}
                              </p>
                              <p className="mt-1 text-xs text-ink">
                                {String(finding.recommendation ?? "")}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-muted">
                          {workflow.safety_status === "PROVISIONAL" ||
                          workflow.safety_status === "CONFIRMED" ||
                          workflow.safety_status === "AUTO_CONFIRMED"
                            ? t("contentQuality.bookDetail.noSafetyFindings")
                            : t(
                                "contentQuality.bookDetail.noValidSafetyResult",
                              )}
                        </p>
                      )}

                      {workflow.safety_history.length ? (
                        <details className="mt-2.5 rounded-control border border-border bg-white p-2.5">
                          <summary className="cursor-pointer text-xs font-bold text-ink">
                            {t(
                              "contentQuality.bookDetail.previousSafetyScans",
                              {
                                count: formatNumber(
                                  workflow.safety_history.length,
                                ),
                              },
                            )}
                          </summary>
                          <ul className="mt-2 grid gap-2">
                            {workflow.safety_history.map((scan, index) => (
                              <li
                                className="break-all rounded-control bg-surface-subtle p-2.5 text-xs"
                                key={`${String(scan.scan_id)}-${index}`}
                              >
                                <p className="font-bold text-ink">
                                  {formatQualityEnum(scan.status)} ·{" "}
                                  {scan.suitability
                                    ? formatQualityEnum(scan.suitability)
                                    : t(
                                        "contentQuality.bookDetail.noSuitabilityFallback",
                                      )}{" "}
                                  ·{" "}
                                  {t(
                                    "contentQuality.bookDetail.findingsCountLabel",
                                    {
                                      count: formatNumber(
                                        Array.isArray(scan.findings)
                                          ? scan.findings.length
                                          : 0,
                                      ),
                                    },
                                  )}
                                </p>
                                <p className="mt-1 text-[11px] text-muted">
                                  {t(
                                    "contentQuality.bookDetail.archivedPrefix",
                                  )}{" "}
                                  {scan.archived_at
                                    ? formatDate(String(scan.archived_at))
                                    : t("common.unknown")}
                                </p>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}

                      <details className="mt-2.5 rounded-control border border-border bg-white p-2.5">
                        <summary className="cursor-pointer text-xs font-bold text-ink">
                          {t(
                            "contentQuality.bookDetail.candidateVersionsHeading",
                          )}{" "}
                          ·{" "}
                          {t("contentQuality.bookDetail.reviewHistoryHeading")}{" "}
                          ·{" "}
                          {t(
                            "contentQuality.bookDetail.providerProvenanceHeading",
                          )}
                        </summary>
                        <div className="mt-2.5 grid gap-3 border-t border-border/70 pt-2.5 lg:grid-cols-2">
                          <div>
                            <h5 className="text-xs font-bold text-ink">
                              {t(
                                "contentQuality.bookDetail.candidateVersionsHeading",
                              )}
                            </h5>
                            <ul className="mt-1 space-y-1 text-[11px] text-muted">
                              {workflow.candidate_history.map(
                                (version, index) => (
                                  <li
                                    className="break-words"
                                    key={`${String(version.version)}-${index}`}
                                  >
                                    Phiên bản {String(version.version)} ·{" "}
                                    {version.changed_by
                                      ? "Quản trị viên"
                                      : t("common.unknown")}
                                  </li>
                                ),
                              )}
                            </ul>
                          </div>
                          <div>
                            <h5 className="text-xs font-bold text-ink">
                              {t(
                                "contentQuality.bookDetail.reviewHistoryHeading",
                              )}
                            </h5>
                            <ul className="mt-1 space-y-1 text-[11px] text-muted">
                              {workflow.review_history.map((event, index) => (
                                <li
                                  key={`${String(event.created_at)}-${index}`}
                                >
                                  {formatQualityEnum(event.event)} ·{" "}
                                  {event.actor_id
                                    ? "Quản trị viên"
                                    : t("common.unknown")}{" "}
                                  ·{" "}
                                  {event.created_at
                                    ? formatDate(String(event.created_at))
                                    : ""}
                                  {event.reason
                                    ? ` · ${t("contentQuality.bookDetail.reasonPrefix", { reason: String(event.reason) })}`
                                    : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </details>
                    </article>
                  ))}
                  <PaginationBar
                    compact
                    onPageChange={setAiWorkflowsPage}
                    page={safeAiWorkflowsPage}
                    pageSize={DRAWER_LIST_PAGE_SIZE}
                    total={aiWorkflowItems.length}
                  />
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  {t("contentQuality.bookDetail.noCombinedAiHistory")}
                </p>
              )}
            </section>

            {/* Selected Scan Details */}
            {selectedScan ? (
              <section className="rounded-xl border border-border bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-extrabold text-ink">
                    {t("contentQuality.bookDetail.selectedScanHeading", {
                      status: t(
                        `contentQuality.scanStatuses.${selectedScan.status}`,
                        undefined,
                        formatQualityEnum(selectedScan.status),
                      ),
                    })}
                  </h3>
                </div>
                <QualityScanProgressBar
                  scan={selectedScan}
                  testId="quality-selected-scan-progress"
                />
                <div className="mt-2.5 flex flex-wrap gap-2 text-xs tabular-nums">
                  {(
                    [
                      [
                        t("contentQuality.bookDetail.scanStats.totalPages"),
                        selectedScan.total_pages,
                      ],
                      [
                        t("contentQuality.bookDetail.scanStats.completedPages"),
                        selectedScan.completed_pages,
                      ],
                      [
                        t("contentQuality.bookDetail.scanStats.skippedPages"),
                        selectedScan.skipped_pages,
                      ],
                      [
                        t("contentQuality.bookDetail.scanStats.failedPages"),
                        selectedScan.failed_pages,
                      ],
                      [
                        t(
                          "contentQuality.bookDetail.scanStats.aiUnavailablePages",
                        ),
                        selectedScan.ai_unavailable_pages,
                      ],
                    ] as const
                  ).map(([label, value]) => (
                    <AdminBadge key={String(label)} tone="neutral">
                      {label}: {formatNumber(Number(value))}
                    </AdminBadge>
                  ))}
                </div>
                <p className="mt-2.5 text-xs text-muted">
                  {t("contentQuality.bookDetail.aiCompletedNote", {
                    count: formatNumber(selectedScan.ai_completed_pages),
                  })}
                </p>
                {selectedScan.error_summary ? (
                  <p className="mt-2 text-xs font-semibold text-danger">
                    {selectedScan.error_summary}
                  </p>
                ) : null}

                <div className="mt-3.5 grid gap-3">
                  {visibleScanPages.map((page) => (
                    <article
                      className="rounded-xl border border-border bg-surface-subtle/40 p-3.5"
                      key={page.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <h4 className="text-sm font-bold text-ink">
                            {t("contentQuality.bookDetail.pageNumberHeading", {
                              pageNumber: formatNumber(page.page_number),
                            })}
                          </h4>
                          <p className="mt-0.5 text-xs text-muted">
                            {t(
                              `contentQuality.pageScanStatuses.${page.status}`,
                              undefined,
                              formatQualityEnum(page.status),
                            )}
                            {` · ${t("contentQuality.bookDetail.rulePrefix")} `}
                            {formatQualityEnum(page.rule_check_status)}
                            {` · ${t("contentQuality.bookDetail.aiPrefix")} `}
                            {t(
                              `contentQuality.aiCheckStatuses.${page.ai_analysis_status}`,
                              undefined,
                              formatQualityEnum(page.ai_analysis_status),
                            )}
                          </p>
                          {page.error_code || page.error_summary ? (
                            <p className="mt-1.5 text-xs font-semibold text-danger">
                              {page.error_code === "CLOUD_AI_UNAVAILABLE" ||
                              page.error_code === "CLOUD_AI_INVALID_RESPONSE"
                                ? t(
                                    `contentQuality.pageErrorCodes.${page.error_code}`,
                                    undefined,
                                    page.error_summary ?? page.error_code,
                                  )
                                : (page.error_summary ?? page.error_code)}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {page.page_id ? (
                            <ButtonLink
                              href={`/admin/books/${encodeURIComponent(selectedBook.book_id)}/pages/${encodeURIComponent(page.page_id)}${page.page_revision_id ? `?revisionId=${encodeURIComponent(page.page_revision_id)}` : ""}`}
                              size="admin"
                              variant="outline"
                            >
                              {t("contentQuality.bookDetail.checkAndFixPage")}
                            </ButtonLink>
                          ) : null}
                          {page.status === "FAILED" ||
                          page.status === "STALE" ||
                          page.ai_analysis_status === "UNAVAILABLE" ||
                          page.ai_analysis_status === "FAILED" ? (
                            <Button
                              disabled={busyKey === `retry:${page.id}`}
                              onClick={() =>
                                void retryPage(selectedScan.id, page.id)
                              }
                              size="admin"
                              variant="secondary"
                            >
                              {t("contentQuality.bookDetail.rescanPage")}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {page.findings.length ? (
                        <ScanPageFindingsList
                          bookId={selectedBook.book_id}
                          busyKey={busyKey}
                          findings={page.findings}
                          onUpdate={updateFinding}
                        />
                      ) : (
                        <p className="mt-2 text-xs text-muted">
                          {page.status === "COMPLETED"
                            ? t("contentQuality.bookDetail.noFindingThisScan")
                            : t("contentQuality.bookDetail.noScanResultYet")}
                        </p>
                      )}
                    </article>
                  ))}
                  <PaginationBar
                    compact
                    onPageChange={setScanPagesPage}
                    page={safeScanPagesPage}
                    pageSize={DRAWER_LIST_PAGE_SIZE}
                    total={scanPageItems.length}
                  />
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </AdminDrawer>
    </section>
  );
}
