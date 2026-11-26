"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw, Search } from "lucide-react";

import { AdminLoading } from "@/components/admin/admin-ui";
import { AdminUserBooksQualitySection } from "@/components/admin/admin-user-books-quality-section";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { TranslateFn } from "@/lib/i18n/types";
import type {
  BookContentIssueType,
  BookContentReportDetailDTO,
  BookContentReportStatus,
  BookQualityBookDetailDTO,
  BookQualityBookPageDTO,
  BookApprovalStatus,
  BookQualityFindingDTO,
  BookQualityFindingStatus,
  BookQualityReportAdminPageDTO,
  BookQualityScanDetailDTO,
  BookRightsStatus,
} from "@/types/book-content-quality";

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
      <span className="text-sm text-muted">
        {t("contentQuality.findingCard.pageUnavailable")}
      </span>
    );
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
  const t = useTranslations("admin");
  const { formatPercent } = useI18n();
  return (
    <article className="rounded-control border border-border bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="font-semibold text-ink">
          {t("contentQuality.findingCard.pageIssue", {
            pageNumber: finding.page_number,
            issueType: finding.issue_type,
          })}
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          <span className="rounded-full bg-canvas px-3 py-1">
            {finding.severity}
          </span>
          <span className="rounded-full bg-sky px-3 py-1 text-primary-hover">
            {t(`contentQuality.findingStatuses.${finding.status}`)}
          </span>
        </div>
      </div>
      <blockquote className="mt-3 whitespace-pre-wrap rounded-control bg-canvas p-3 text-sm leading-6 text-ink">
        {finding.original_excerpt ? (
          <span className="viread-learning-content" dir="ltr" lang="vi">
            {finding.original_excerpt}
          </span>
        ) : (
          t("contentQuality.findingCard.emptyExcerpt")
        )}
      </blockquote>
      <p className="mt-2 text-sm leading-6 text-muted">{finding.explanation}</p>
      {finding.suggested_correction ? (
        <p className="mt-2 text-sm text-ink">
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
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>
          {t("contentQuality.findingCard.sourcePrefix")}{" "}
          {finding.detection_source === "RULE"
            ? t("contentQuality.findingCard.sourceDeterministic")
            : t("contentQuality.findingCard.sourceOllama")}
        </span>
        {finding.model_name ? <span>Model: {finding.model_name}</span> : null}
        {finding.confidence !== null ? (
          <span>
            Confidence:{" "}
            {formatPercent(finding.confidence, { maximumFractionDigits: 0 })}
          </span>
        ) : null}
        {finding.page_revision_id ? (
          <span className="font-mono">
            Revision: {finding.page_revision_id}
          </span>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <OcrLink bookId={bookId} finding={finding}>
          {t("contentQuality.findingCard.openInOcr")}
        </OcrLink>
        {finding.status === "NEEDS_REVIEW" ? (
          <>
            <Button
              className="h-10 w-auto px-3 text-sm"
              disabled={busy}
              onClick={() => onUpdate(finding, "CONFIRMED")}
              variant="secondary"
            >
              {t("contentQuality.findingCard.confirmWarning")}
            </Button>
            <Button
              className="h-10 w-auto px-3 text-sm"
              disabled={busy}
              onClick={() => onUpdate(finding, "DISMISSED")}
              variant="secondary"
            >
              {t("contentQuality.findingCard.dismiss")}
            </Button>
          </>
        ) : finding.status === "CONFIRMED" ? (
          <Button
            className="h-10 w-auto px-3 text-sm"
            disabled={busy}
            onClick={() => onUpdate(finding, "RESOLVED")}
            variant="secondary"
          >
            {t("contentQuality.findingCard.markResolved")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function AdminBookContentQualityScreen() {
  const { bookContentQuality } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDateTime, formatNumber } = useI18n();
  const formatDate = formatDateTime;
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
        setBookError(errorMessage(error, t));
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
    t,
  ]);

  useEffect(() => {
    if (activeTab !== "catalog") return;
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
  }, [activeTab, loadReports, search]);

  useEffect(() => {
    if (activeTab !== "catalog") return;
    const requestId = bookRequestId;
    if (!bookSearch.trim()) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) void loadBooks();
      });
      return () => {
        cancelled = true;
        requestId.current += 1;
      };
    }
    const timeout = globalThis.setTimeout(() => void loadBooks(), 180);
    return () => {
      globalThis.clearTimeout(timeout);
      requestId.current += 1;
    };
  }, [activeTab, bookSearch, loadBooks]);

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

  async function openReport(reportId: string) {
    setBusyKey(`report:${reportId}`);
    setActionError(null);
    try {
      const detail = await bookContentQuality.getReport(reportId);
      setSelectedReport(detail);
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

  return (
    <section className="mt-10 border-t border-border pt-8">
      <header className="mb-6 flex flex-col justify-between gap-4 border-b border-border pb-5 lg:flex-row lg:items-end">
        <div className="min-w-0 max-w-3xl">
          <p className="text-sm font-semibold text-muted">
            {t("contentQuality.eyebrow")}
          </p>
          <h2 className="book-title mt-1 text-3xl text-ink sm:text-[36px]">
            {t("contentQuality.heading")}
          </h2>
          <p className="mt-2 max-w-2xl text-body leading-6 text-muted">
            {t("contentQuality.description")}
          </p>
        </div>
        <div className="flex w-full shrink-0 flex-wrap gap-3 sm:w-auto">
          <Button
            className="h-12"
            disabled={loadingReports || loadingBooks}
            fullWidth={false}
            onClick={() => void Promise.all([loadReports(), loadBooks()])}
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-4" />
            {t("common.reload")}
          </Button>
        </div>
      </header>

      {actionError ? (
        <StatusMessage
          tone="error"
          title={t("contentQuality.errors.actionNotDoneTitle")}
        >
          {actionError}
        </StatusMessage>
      ) : null}

      <div
        aria-label={t("contentQuality.sectionNavAria")}
        className="mb-6 flex flex-wrap gap-2"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const nextTab = activeTab === "catalog" ? "user-books" : "catalog";
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
          className={
            "inline-flex min-h-11 items-center gap-2 rounded-control border px-4 text-sm font-bold transition " +
            (activeTab === "catalog"
              ? "border-primary bg-primary text-white"
              : "border-border bg-white text-ink hover:bg-canvas")
          }
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
          className={
            "inline-flex min-h-11 items-center gap-2 rounded-control border px-4 text-sm font-bold transition " +
            (activeTab === "user-books"
              ? "border-primary bg-primary text-white"
              : "border-border bg-white text-ink hover:bg-canvas")
          }
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
          <AdminUserBooksQualitySection />
        </div>
      ) : null}

      {activeTab === "catalog" ? (
        <div
          aria-labelledby="quality-tab-catalog"
          id="quality-panel-catalog"
          role="tabpanel"
        >
          <section
            aria-label={t("contentQuality.reportSummaryAria")}
            className="mb-6"
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {(
                [
                  "OPEN",
                  "UNDER_REVIEW",
                  "RESOLVED",
                  "REJECTED",
                  "REPORTED_BOOKS",
                  "REPORTED_PAGES",
                ] as const
              ).map((key) => (
                <div
                  className="rounded-card border border-border bg-white p-4"
                  key={key}
                >
                  <p className="text-sm text-muted">
                    {t(`contentQuality.summaryCards.${key}`)}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
                    {reportSummary?.[key] !== undefined
                      ? formatNumber(reportSummary[key])
                      : t("common.emptyDash")}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-card border border-border bg-white p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-ink">
                  {t("contentQuality.reports.heading")}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {t("contentQuality.reports.subtitle")}
                </p>
              </div>
              <span className="text-sm font-semibold text-muted">
                {t("contentQuality.reports.countBadge", {
                  count: reports?.total ?? 0,
                })}
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="block text-sm font-semibold text-ink">
                {t("contentQuality.reports.searchLabel")}
                <span className="relative mt-1 block">
                  <Search
                    aria-hidden
                    className="absolute start-3 top-3 size-4 text-muted"
                  />
                  <input
                    className="min-h-11 w-full rounded-control border border-border pe-3 ps-9"
                    onChange={(event) => {
                      setReportOffset(0);
                      setSearch(event.target.value);
                    }}
                    placeholder={t("contentQuality.reports.searchPlaceholder")}
                    value={search}
                  />
                </span>
              </label>
              <label className="block text-sm font-semibold text-ink">
                {t("contentQuality.reports.fromDateLabel")}
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
                {t("contentQuality.reports.toDateLabel")}
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
                {t("contentQuality.reports.statusLabel")}
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
                  <option value="">{t("common.all")}</option>
                  {REPORT_STATUS_KEYS.map((value) => (
                    <option key={value} value={value}>
                      {t(`contentQuality.reportStatuses.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-semibold text-ink">
                {t("contentQuality.reports.issueTypeLabel")}
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
                  <option value="">{t("common.all")}</option>
                  {ISSUE_TYPE_KEYS.map((value) => (
                    <option key={value} value={value}>
                      {t(`contentQuality.reportIssueTypes.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-semibold text-ink">
                {t("contentQuality.reports.bookLabel")}
                <select
                  className="mt-1 min-h-11 w-full rounded-control border border-border px-3"
                  onChange={(event) => {
                    setReportOffset(0);
                    setBookFilter(event.target.value);
                  }}
                  value={bookFilter}
                >
                  <option value="">
                    {t("contentQuality.reports.allBooksOption")}
                  </option>
                  {(books?.items ?? []).map((book) => (
                    <option key={book.book_id} value={book.book_id}>
                      {book.book_title}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {loadingReports ? (
              <AdminLoading label={t("contentQuality.reports.loading")} />
            ) : reportError ? (
              <StatusMessage
                tone="error"
                title={t("contentQuality.reports.loadErrorTitle")}
              >
                {reportError}
              </StatusMessage>
            ) : !reports || reports.items.length === 0 ? (
              <EmptyState
                title={t("contentQuality.reports.emptyTitle")}
                description={t("contentQuality.reports.emptyDesc")}
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
                          {t(
                            `contentQuality.reportIssueTypes.${report.issue_type}`,
                          )}
                          {report.page_number !== null
                            ? t("contentQuality.reports.pageScope", {
                                pageNumber: report.page_number,
                              })
                            : t("contentQuality.reports.wholeBookScope")}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {t("contentQuality.reports.reporterPrefix")}{" "}
                          {report.reporter_name ||
                            t("contentQuality.reports.reporterFallback")}
                          {" · "}
                          {formatDate(report.created_at)}
                        </p>
                      </div>
                      <span className="rounded-full bg-sky px-3 py-1 text-xs font-semibold text-primary-hover">
                        {t(`contentQuality.reportStatuses.${report.status}`)}
                      </span>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink">
                      {report.description}
                    </p>
                    {report.reported_text ? (
                      <p className="mt-2 text-sm text-muted">
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
                        {t("contentQuality.reports.viewDetails")}
                      </Button>
                    </div>
                  </article>
                ))}
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

          {selectedReport ? (
            <section className="mt-6 rounded-card border border-border bg-white p-4 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-ink">
                    {t("contentQuality.reports.detailHeading")}
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
                  {t("contentQuality.reports.closeDetail")}
                </Button>
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="font-semibold text-ink">
                    {t("contentQuality.reports.snapshotHeading")}
                  </h3>
                  <p className="mt-2 text-sm text-muted">
                    {selectedReport.book_title}
                    {selectedReport.page_number !== null
                      ? t("contentQuality.reports.pageScope", {
                          pageNumber: selectedReport.page_number,
                        })
                      : t("contentQuality.reports.wholeBookScope")}
                  </p>
                  <p className="mt-2 text-sm font-semibold text-ink">
                    {t(
                      `contentQuality.reportIssueTypes.${selectedReport.issue_type}`,
                    )}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">
                    {selectedReport.description}
                  </p>
                  {selectedReport.verified_text_snapshot ? (
                    <pre
                      className="viread-learning-content mt-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-control bg-canvas p-3 text-xs leading-5 text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {selectedReport.verified_text_snapshot}
                    </pre>
                  ) : (
                    <p className="mt-3 text-sm text-muted">
                      {t("contentQuality.reports.noSnapshot")}
                    </p>
                  )}
                  {selectedReport.page_id && selectedReport.book_id ? (
                    <Link
                      className="mt-3 inline-flex min-h-10 items-center rounded-control border border-border px-3 text-sm font-semibold text-primary hover:bg-canvas"
                      href={`/admin/books/${encodeURIComponent(selectedReport.book_id)}/pages/${encodeURIComponent(selectedReport.page_id)}${selectedReport.page_revision_id ? `?revisionId=${encodeURIComponent(selectedReport.page_revision_id)}` : ""}`}
                    >
                      {t("contentQuality.reports.openOriginalInOcr")}
                    </Link>
                  ) : null}
                  {selectedReport.content_hash_snapshot ? (
                    <p className="mt-2 break-all font-mono text-xs text-muted">
                      Content hash: {selectedReport.content_hash_snapshot}
                    </p>
                  ) : null}
                </div>
                <div>
                  <h3 className="font-semibold text-ink">
                    {t("contentQuality.reports.historyHeading")}
                  </h3>
                  <ol className="mt-2 space-y-3 border-s-2 border-border ps-4">
                    {selectedReport.history.map((item, index) => (
                      <li key={`${item.created_at}-${index}`}>
                        <p className="text-sm font-semibold text-ink">
                          {item.from_status
                            ? `${t(`contentQuality.reportStatuses.${item.from_status}`)} → `
                            : ""}
                          {t(`contentQuality.reportStatuses.${item.to_status}`)}
                        </p>
                        <p className="text-xs text-muted">
                          {item.actor_name ||
                            t("contentQuality.reports.systemActor")}{" "}
                          · {formatDate(item.created_at)}
                        </p>
                        {item.note ? (
                          <p className="mt-1 text-sm text-muted">{item.note}</p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  <h3 className="mt-5 font-semibold text-ink">
                    {t("contentQuality.reports.linkedFindingsHeading")}
                  </h3>
                  {selectedReport.related_findings.length ? (
                    <div className="mt-2 grid gap-2">
                      {selectedReport.related_findings.map((finding) => (
                        <div
                          className="rounded-control bg-canvas p-3"
                          key={finding.id}
                        >
                          <p className="text-sm font-semibold text-ink">
                            {t("contentQuality.findingCard.pageIssue", {
                              pageNumber: finding.page_number,
                              issueType: finding.issue_type,
                            })}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            {t(
                              `contentQuality.findingStatuses.${finding.status}`,
                            )}{" "}
                            · {finding.detection_source}
                          </p>
                          <p
                            className="viread-learning-content mt-2 whitespace-pre-wrap text-sm text-ink"
                            dir="ltr"
                            lang="vi"
                          >
                            {finding.original_excerpt}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-muted">
                      {t("contentQuality.reports.noLinkedFindings")}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-5 border-t border-border pt-4">
                <label
                  className="block text-sm font-semibold text-ink"
                  htmlFor="report-resolution-note"
                >
                  {t("contentQuality.reports.adminNoteLabel")}
                  <textarea
                    className="mt-2 min-h-20 w-full rounded-control border border-border p-3 font-normal"
                    id="report-resolution-note"
                    maxLength={2000}
                    onChange={(event) => setResolutionNote(event.target.value)}
                    placeholder={t(
                      "contentQuality.reports.adminNotePlaceholder",
                    )}
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
                      {t("contentQuality.reports.actions.takeReview")}
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
                      {t("contentQuality.reports.actions.returnOpen")}
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
                        {t("contentQuality.reports.actions.resolve")}
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
                        {t("contentQuality.reports.actions.rejectWithReason")}
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
                      {t("contentQuality.reports.actions.reopen")}
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
                  {t("contentQuality.booksScan.heading")}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {t("contentQuality.booksScan.subtitle")}
                </p>
              </div>
              <span className="text-sm font-semibold text-muted">
                {t("contentQuality.booksScan.countBadge", {
                  count: books?.total ?? 0,
                })}
              </span>
            </div>
            <label className="mb-4 block max-w-lg text-sm font-semibold text-ink">
              {t("contentQuality.booksScan.searchLabel")}
              <input
                className="mt-1 min-h-11 w-full rounded-control border border-border px-3"
                onChange={(event) => {
                  setBookOffset(0);
                  setBookSearch(event.target.value);
                }}
                placeholder={t("contentQuality.booksScan.searchPlaceholder")}
                value={bookSearch}
              />
            </label>
            {books ? (
              <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {APPROVAL_STATUS_KEYS.map((status) => (
                  <div className="rounded-control bg-canvas p-3" key={status}>
                    <p className="text-xs text-muted">
                      {t(`contentQuality.assessmentStatuses.${status}`)}
                    </p>
                    <p className="mt-1 text-lg font-extrabold text-ink">
                      {formatNumber(books.summary[status] ?? 0)}
                    </p>
                  </div>
                ))}
                {(["CHILD_SAFETY", "COPYRIGHT", "BOTH"] as const).map((key) => (
                  <div
                    className="rounded-control border border-amber-200 bg-amber-50 p-3"
                    key={key}
                  >
                    <p className="text-xs text-muted">
                      {t(`contentQuality.booksScan.alertCards.${key}`)}
                    </p>
                    <p className="mt-1 text-lg font-extrabold text-ink">
                      {formatNumber(books.alert_summary[key] ?? 0)}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
            <label className="mb-4 block max-w-lg text-sm font-semibold text-ink">
              {t("contentQuality.booksScan.assessmentFilterLabel")}
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
                <option value="">
                  {t("contentQuality.booksScan.allStatusesOption")}
                </option>
                {APPROVAL_STATUS_KEYS.map((status) => (
                  <option key={status} value={status}>
                    {t(`contentQuality.assessmentStatuses.${status}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="mb-4 block max-w-lg text-sm font-semibold text-ink">
              {t("contentQuality.booksScan.alertFilterLabel")}
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
              </select>
            </label>
            <p className="mb-4 text-xs text-muted">
              {t("contentQuality.booksScan.statsNote")}
            </p>
            {loadingBooks ? (
              <AdminLoading label={t("contentQuality.booksScan.loading")} />
            ) : bookError ? (
              <StatusMessage
                tone="error"
                title={t("contentQuality.booksScan.loadErrorTitle")}
              >
                {bookError}
              </StatusMessage>
            ) : !books || books.items.length === 0 ? (
              <EmptyState
                title={t("contentQuality.booksScan.emptyTitle")}
                description={t("contentQuality.booksScan.emptyDesc")}
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
                        <h3 className="font-bold text-ink" dir="auto">
                          {book.book_title}
                        </h3>
                        <span
                          className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-extrabold ${approvalStatusStyles[book.assessment.status]}`}
                        >
                          {t(
                            `contentQuality.assessmentStatuses.${book.assessment.status}`,
                            undefined,
                            book.assessment.status,
                          )}
                        </span>
                        {book.assessment.finding_count > 0 ? (
                          <span className="ms-2 inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-900">
                            {t(
                              "contentQuality.booksScan.childSafetyAlertBadge",
                            )}
                          </span>
                        ) : null}
                        {book.assessment.copyright_finding_count !== null &&
                        book.assessment.copyright_finding_count > 0 ? (
                          <span className="ms-2 inline-flex rounded-full bg-orange-100 px-3 py-1 text-xs font-extrabold text-orange-900">
                            {t("contentQuality.booksScan.copyrightAlertBadge")}
                          </span>
                        ) : null}
                        <p className="mt-2 text-sm text-muted">
                          {t("contentQuality.booksScan.assessmentSummaryLine", {
                            proofreading: book.assessment.proofreading_status,
                            safety: book.assessment.child_safety_status,
                          })}{" "}
                          {t(
                            `contentQuality.rightsStatuses.${book.assessment.copyright_status}`,
                            undefined,
                            book.assessment.copyright_status,
                          )}
                        </p>
                        <p className="mt-1 text-xs font-semibold text-amber-900">
                          {t(
                            "contentQuality.booksScan.childSafetyFindingsCount",
                            {
                              count: formatNumber(
                                book.assessment.finding_count,
                              ),
                            },
                          )}
                          {` · HIGH ${formatNumber(book.assessment.high_finding_count)}`}
                          {` · MEDIUM ${formatNumber(book.assessment.medium_finding_count)}`}
                          {` · ${t(
                            `contentQuality.rightsStatuses.${book.assessment.copyright_status}`,
                            undefined,
                            book.assessment.copyright_status,
                          )}`}
                        </p>
                        <p className="mt-1 text-sm text-muted">
                          {t("contentQuality.booksScan.bookMetricsLine", {
                            reports: formatNumber(book.report_count),
                            findings: formatNumber(book.finding_count),
                            needsReview: formatNumber(
                              book.needs_review_finding_count,
                            ),
                          })}
                        </p>
                        {book.latest_scan ? (
                          <p className="mt-1 text-xs text-muted">
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
                              total: formatNumber(book.latest_scan.total_pages),
                            })}
                            {" · "}
                            {formatDate(book.latest_scan.created_at)}
                          </p>
                        ) : (
                          <p className="mt-1 text-xs text-muted">
                            {t("contentQuality.booksScan.noScanHistory")}
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
                          {t("contentQuality.booksScan.viewResults")}
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
                            ? t("contentQuality.booksScan.scanning")
                            : t("contentQuality.booksScan.scanWholeBook")}
                        </Button>
                      </div>
                    </div>
                  </article>
                ))}
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

          {selectedBook ? (
            <section className="mt-6 rounded-card border border-border bg-white p-4 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-ink" dir="auto">
                    {selectedBook.book_title}
                  </h2>
                  <p className="mt-1 text-sm text-muted">
                    {t("contentQuality.bookDetail.subheading")}
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
                    {t("contentQuality.bookDetail.rescanBook")}
                  </Button>
                  <Button
                    className="h-10 w-auto px-3 text-sm"
                    onClick={() => setSelectedBook(null)}
                    variant="secondary"
                  >
                    {t("common.close")}
                  </Button>
                </div>
              </div>

              <section
                aria-label={t("contentQuality.bookDetail.assessmentAria")}
                className="mt-5 rounded-control border border-border bg-canvas p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-lg font-extrabold text-ink">
                    {t("contentQuality.bookDetail.assessmentHeading")}
                  </h3>
                  <span
                    className={`rounded-full px-3 py-1 text-sm font-extrabold ${approvalStatusStyles[selectedBook.assessment.status]}`}
                  >
                    {t(
                      `contentQuality.assessmentStatuses.${selectedBook.assessment.status}`,
                      undefined,
                      selectedBook.assessment.status,
                    )}
                  </span>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    [
                      t("contentQuality.bookDetail.metrics.activePages"),
                      `${formatNumber(selectedBook.assessment.ocr_completed_pages)}/${formatNumber(selectedBook.assessment.page_count)} OCR`,
                    ],
                    [
                      t(
                        "contentQuality.bookDetail.metrics.verifiedCandidateHash",
                      ),
                      `${formatNumber(selectedBook.assessment.ocr_approval_valid_pages)}/${formatNumber(selectedBook.assessment.page_count)}`,
                    ],
                    [
                      t("contentQuality.bookDetail.metrics.proofreadingDone"),
                      `${formatNumber(selectedBook.assessment.proofreading_completed_pages)}/${formatNumber(selectedBook.assessment.page_count)} · ${selectedBook.assessment.proofreading_status}`,
                    ],
                    [
                      t("contentQuality.bookDetail.metrics.childSafetyLabel"),
                      `${formatNumber(selectedBook.assessment.child_safety_completed_pages)}/${formatNumber(selectedBook.assessment.page_count)} · ${selectedBook.assessment.child_safety_status}`,
                    ],
                    [
                      t("contentQuality.bookDetail.metrics.inProgress"),
                      t("contentQuality.bookDetail.metrics.pagesCountValue", {
                        count: formatNumber(
                          selectedBook.assessment.processing_pages,
                        ),
                      }),
                    ],
                    [
                      t("contentQuality.bookDetail.metrics.rightsStatus"),
                      t(
                        `contentQuality.rightsStatuses.${selectedBook.assessment.copyright_status}`,
                        undefined,
                        selectedBook.assessment.copyright_status,
                      ),
                    ],
                    [
                      t("contentQuality.bookDetail.metrics.findingsLabel"),
                      `${formatNumber(selectedBook.assessment.finding_count)} · HIGH ${formatNumber(selectedBook.assessment.high_finding_count)} · MEDIUM ${formatNumber(selectedBook.assessment.medium_finding_count)}`,
                    ],
                    [
                      t("contentQuality.bookDetail.metrics.alertPages"),
                      formatNumber(selectedBook.assessment.warning_page_count),
                    ],
                    [
                      t("contentQuality.bookDetail.metrics.failedOrUnscanned"),
                      `${formatNumber(selectedBook.assessment.failed_or_unscanned_page_count)} · ${t(
                        "contentQuality.bookDetail.metrics.failedSuffix",
                        {
                          count: formatNumber(
                            selectedBook.assessment.failed_pages,
                          ),
                        },
                      )}`,
                    ],
                    [
                      t("contentQuality.bookDetail.metrics.staleResults"),
                      t("contentQuality.bookDetail.metrics.pagesCountValue", {
                        count: formatNumber(
                          selectedBook.assessment.stale_pages,
                        ),
                      }),
                    ],
                    [
                      t("contentQuality.bookDetail.metrics.assessmentHash"),
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
                  {t("contentQuality.bookDetail.publishRulePrefix")}
                  <strong>
                    {t("contentQuality.bookDetail.publishRuleStrong")}
                  </strong>
                  .
                </div>

                <section
                  aria-label={t("contentQuality.bookDetail.rightsSectionAria")}
                  className="mt-4 rounded-control border border-border bg-white p-4"
                  data-testid="book-rights-panel"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="font-extrabold text-ink">
                        {t("contentQuality.bookDetail.rightsHeading")}
                      </h4>
                      <p className="mt-1 text-xs text-muted">
                        {t("contentQuality.bookDetail.rightsDesc")}
                      </p>
                    </div>
                    <span
                      className="rounded-full bg-canvas px-3 py-1 text-xs font-extrabold text-ink"
                      data-testid="book-rights-status"
                    >
                      {t(
                        `contentQuality.rightsStatuses.${
                          selectedBook.rights_evidence?.effective_status ??
                          selectedBook.assessment.copyright_status
                        }`,
                        undefined,
                        selectedBook.rights_evidence?.effective_status ??
                          selectedBook.assessment.copyright_status,
                      )}
                      {selectedBook.rights_evidence?.version
                        ? ` · v${selectedBook.rights_evidence.version}`
                        : ""}
                    </span>
                  </div>
                  {selectedBook.rights_evidence?.is_stale ? (
                    <p className="mt-2 rounded-control border border-amber-400 bg-amber-50 p-2.5 text-xs font-semibold text-amber-950">
                      {t("contentQuality.bookDetail.rightsStaleWarning")}
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
                      {t("contentQuality.bookDetail.rightsStatusField")}
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
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
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
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
                        maxLength={500}
                        onChange={(event) =>
                          setRightsSource(event.target.value)
                        }
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
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
                        maxLength={300}
                        onChange={(event) =>
                          setRightsAuthor(event.target.value)
                        }
                        placeholder={t(
                          "contentQuality.bookDetail.authorOrHolderPlaceholder",
                        )}
                        type="text"
                        value={rightsAuthor}
                      />
                    </label>
                    <label className="sm:col-span-2 text-xs font-bold text-ink">
                      {t("contentQuality.bookDetail.evidenceRefLabel")}
                      <input
                        className="mt-1 min-h-10 w-full rounded-control border border-border bg-white px-3 text-sm font-normal"
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
                    <label className="sm:col-span-2 text-xs font-bold text-ink">
                      {t("contentQuality.bookDetail.rightsNotesLabel")}
                      <textarea
                        className="mt-1 min-h-16 w-full rounded-control border border-border bg-white p-2.5 text-sm font-normal"
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
                      {t("contentQuality.bookDetail.saveRightsBtn")}
                    </Button>
                    {selectedBook.rights_evidence?.reviewed_at ? (
                      <span className="text-xs text-muted">
                        {t("contentQuality.bookDetail.lastUpdatedPrefix")}{" "}
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
                        {t("contentQuality.bookDetail.rightsHistoryHeading", {
                          count: formatNumber(
                            selectedBook.rights_evidence.history.length,
                          ),
                        })}
                      </summary>
                      <ul className="mt-2 grid gap-2 text-xs">
                        {selectedBook.rights_evidence.history.map((entry) => (
                          <li
                            className="rounded-control bg-white p-2"
                            key={entry.id}
                          >
                            <span className="font-bold">
                              v{entry.version} ·{" "}
                              {t(
                                `contentQuality.rightsStatuses.${entry.to_status}`,
                                undefined,
                                entry.to_status,
                              )}
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
                    aria-label={t("contentQuality.bookDetail.diagnosticsAria")}
                    className="mt-4 rounded-control border border-border bg-white p-4"
                    data-testid="book-page-diagnostics"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h4 className="font-extrabold text-ink">
                          {t("contentQuality.bookDetail.diagnosticsHeading", {
                            count: formatNumber(
                              selectedBook.page_diagnostics.length,
                            ),
                          })}
                        </h4>
                        <p className="mt-1 text-xs text-muted">
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
                            {t(
                              `contentQuality.bookDetail.diagnosticsTabs.${value}`,
                            )}
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
                                {t(
                                  "contentQuality.bookDetail.pageNumberHeading",
                                  {
                                    pageNumber: formatNumber(item.page_number),
                                  },
                                )}
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
                                    {t(
                                      `contentQuality.diagnosticStatuses.${code}`,
                                      undefined,
                                      code,
                                    )}
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
                                {t("contentQuality.bookDetail.openOcrPage")}
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
                      {t("contentQuality.bookDetail.childSafetySummaryHeading")}
                    </h4>
                    {selectedBook.assessment.finding_groups.map((group) => (
                      <article
                        className="rounded-control border border-border bg-white p-3"
                        key={`${group.category}:${group.severity}`}
                      >
                        <p className="font-bold text-ink">
                          {t("contentQuality.bookDetail.groupSummaryLine", {
                            category: group.category,
                            severity: group.severity,
                            findingCount: formatNumber(group.finding_count),
                            pageCount: formatNumber(group.page_count),
                          })}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {t("contentQuality.bookDetail.pagesListPrefix", {
                            pages: group.page_numbers.join(", "),
                          })}
                        </p>
                        {group.examples.map((example, index) => (
                          <div
                            className="mt-2 border-t border-border pt-2"
                            key={`${example.page_number}:${index}`}
                          >
                            <p className="text-xs font-bold text-muted">
                              {t("contentQuality.bookDetail.evidencePage", {
                                pageNumber: example.page_number,
                              })}
                            </p>
                            <blockquote
                              className="viread-learning-content mt-1 whitespace-pre-wrap text-sm text-ink"
                              dir="ltr"
                              lang="vi"
                            >
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
                    {t("contentQuality.bookDetail.remainingBlockers")}{" "}
                    {selectedBook.assessment.blockers.join(" · ")}
                  </p>
                ) : null}
                {selectedBook.assessment.admin_approved_at ? (
                  <p className="mt-2 text-sm text-emerald-900">
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

                <div className="mt-4 grid gap-3 border-t border-border pt-4">
                  <label className="text-sm font-semibold text-ink">
                    {t("contentQuality.bookDetail.decisionReasonLabel")}
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
                      {t("contentQuality.bookDetail.approveGuardHint")}
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
                      {t("contentQuality.bookDetail.approveBookBtn")}
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
                      {t("contentQuality.bookDetail.rejectBookBtn")}
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
                      {t("contentQuality.bookDetail.requestRescanBtn")}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-48 text-sm font-semibold text-ink">
                      {t(
                        "contentQuality.bookDetail.falsePositiveCategoryLabel",
                      )}
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
                      {t("contentQuality.bookDetail.falsePositiveBtn")}
                    </Button>
                  </div>
                  {selectedBook.decision_history.length ? (
                    <details className="rounded-control border border-border bg-white p-3">
                      <summary className="cursor-pointer text-sm font-bold">
                        {t("contentQuality.bookDetail.decisionHistoryHeading", {
                          count: formatNumber(
                            selectedBook.decision_history.length,
                          ),
                        })}
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
                                {decision.reason ??
                                  t(
                                    "contentQuality.bookDetail.noReasonFallback",
                                  )}
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
                aria-label={t("contentQuality.bookDetail.aiSummaryAria")}
              >
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
                  <div className="rounded-control bg-canvas p-3" key={key}>
                    <p className="text-xs text-muted">
                      {t(`contentQuality.bookDetail.aiMetrics.${labelKey}`)}
                    </p>
                    <p className="mt-1 text-lg font-extrabold text-ink">
                      {formatNumber(selectedBook.ai_workflow_summary[key] ?? 0)}
                      {key === "needs_admin_review"
                        ? ` · ${formatNumber(selectedBook.ai_workflow_summary.finding_count ?? 0)}`
                        : ""}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <h3 className="font-semibold text-ink">
                  {t("contentQuality.bookDetail.scanHistoryHeading")}
                </h3>
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
                  <p className="mt-2 text-sm text-muted">
                    {t("contentQuality.bookDetail.noScanYet")}
                  </p>
                )}
              </div>

              <div className="mt-5 border-t border-border pt-4">
                <h3 className="font-bold text-ink">
                  {t("contentQuality.bookDetail.aiHistoryHeading")}
                </h3>
                {aiAttentionCount > 0 ? (
                  <div
                    aria-live="polite"
                    className="mt-3 rounded-control border border-amber-500 bg-amber-50 p-4 text-sm text-amber-950"
                    role="status"
                  >
                    {t("contentQuality.bookDetail.aiAttentionNotice", {
                      count: formatNumber(aiAttentionCount),
                    })}
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
                              {workflow.suitability ??
                                t(
                                  "contentQuality.bookDetail.noSuitabilityFallback",
                                )}{" "}
                              · Candidate v{workflow.candidate_version}
                              {workflow.hash_match
                                ? t("contentQuality.bookDetail.safetyHashMatch")
                                : t(
                                    "contentQuality.bookDetail.safetyHashStale",
                                  )}
                            </p>
                            <p className="mt-1 break-all font-mono text-xs text-muted">
                              {t("contentQuality.bookDetail.workflowIdLine", {
                                workflowId: workflow.workflow_id,
                                revisionId: workflow.page_revision_id,
                              })}
                            </p>
                          </div>
                          <Link
                            className="inline-flex min-h-10 items-center rounded-control border border-border px-3 text-sm font-bold text-primary hover:bg-canvas"
                            href={`/admin/books/${encodeURIComponent(selectedBook.book_id)}/pages/${encodeURIComponent(workflow.page_id)}?revisionId=${encodeURIComponent(workflow.page_revision_id)}`}
                          >
                            {t("contentQuality.bookDetail.openOcrReview")}
                          </Link>
                        </div>

                        {workflow.error_code ? (
                          <p className="mt-3 text-sm text-danger">
                            {t("contentQuality.bookDetail.workflowError", {
                              code: workflow.error_code,
                            })}
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
                                <blockquote
                                  className="viread-learning-content mt-2 whitespace-pre-wrap text-sm"
                                  dir="ltr"
                                  lang="vi"
                                >
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
                              ? t("contentQuality.bookDetail.noSafetyFindings")
                              : t(
                                  "contentQuality.bookDetail.noValidSafetyResult",
                                )}
                          </p>
                        )}

                        {workflow.safety_history.length ? (
                          <details className="mt-3 rounded-control border border-border p-3">
                            <summary className="cursor-pointer text-sm font-bold">
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
                                  className="break-all rounded-control bg-canvas p-3 text-xs"
                                  key={`${String(scan.scan_id)}-${index}`}
                                >
                                  <p className="font-bold">
                                    {String(scan.status)} ·{" "}
                                    {String(
                                      scan.suitability ??
                                        t(
                                          "contentQuality.bookDetail.noSuitabilityFallback",
                                        ),
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
                                  <p className="mt-1 font-mono text-muted">
                                    {t("contentQuality.bookDetail.hashPrefix", {
                                      hash: String(scan.content_hash ?? "?"),
                                    })}{" "}
                                    ·{" "}
                                    {t(
                                      "contentQuality.bookDetail.archivedPrefix",
                                    )}{" "}
                                    {String(scan.archived_at ?? "")}
                                  </p>
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}

                        <div className="mt-3 grid gap-3 lg:grid-cols-3">
                          <div>
                            <h5 className="text-sm font-bold">
                              {t(
                                "contentQuality.bookDetail.candidateVersionsHeading",
                              )}
                            </h5>
                            <ul className="mt-1 space-y-1 text-xs text-muted">
                              {workflow.candidate_history.map(
                                (version, index) => (
                                  <li
                                    className="break-all"
                                    key={`${String(version.version)}-${index}`}
                                  >
                                    v{String(version.version)} ·{" "}
                                    {String(
                                      version.changed_by ?? t("common.unknown"),
                                    )}{" "}
                                    · {String(version.content_hash ?? "")}
                                  </li>
                                ),
                              )}
                            </ul>
                          </div>
                          <div>
                            <h5 className="text-sm font-bold">
                              {t(
                                "contentQuality.bookDetail.reviewHistoryHeading",
                              )}
                            </h5>
                            <ul className="mt-1 space-y-1 text-xs text-muted">
                              {workflow.review_history.map((event, index) => (
                                <li
                                  key={`${String(event.created_at)}-${index}`}
                                >
                                  {String(event.event)} ·{" "}
                                  {String(
                                    event.actor_id ?? t("common.unknown"),
                                  )}{" "}
                                  · {String(event.created_at ?? "")}
                                  {event.reason
                                    ? ` · ${t("contentQuality.bookDetail.reasonPrefix", { reason: String(event.reason) })}`
                                    : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <h5 className="text-sm font-bold">
                              {t(
                                "contentQuality.bookDetail.providerProvenanceHeading",
                              )}
                            </h5>
                            <ul className="mt-1 space-y-1 text-xs text-muted">
                              {workflow.provider_events.map((event, index) => (
                                <li
                                  key={`${String(event.provider)}-${String(event.chunk_id)}-${index}`}
                                >
                                  {String(event.provider)} ·{" "}
                                  {String(event.model)} ·{" "}
                                  {event.availability
                                    ? t(
                                        "contentQuality.bookDetail.providerAvailable",
                                      )
                                    : t(
                                        "contentQuality.bookDetail.providerUnavailable",
                                      )}
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
                    {t("contentQuality.bookDetail.noCombinedAiHistory")}
                  </p>
                )}
              </div>

              {selectedScan ? (
                <div className="mt-5 border-t border-border pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold text-ink">
                      {t("contentQuality.bookDetail.selectedScanHeading", {
                        status: t(
                          `contentQuality.scanStatuses.${selectedScan.status}`,
                          undefined,
                          selectedScan.status,
                        ),
                      })}
                    </h3>
                    <span className="font-mono text-xs text-muted">
                      {selectedScan.id}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
                    {[
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
                    ].map(([label, value]) => (
                      <div
                        className="rounded-control bg-canvas p-3"
                        key={String(label)}
                      >
                        <p className="text-xs text-muted">{label}</p>
                        <p className="mt-1 text-lg font-semibold tabular-nums text-ink">
                          {formatNumber(Number(value))}
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-muted">
                    {t("contentQuality.bookDetail.aiCompletedNote", {
                      count: formatNumber(selectedScan.ai_completed_pages),
                    })}
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
                              {t(
                                "contentQuality.bookDetail.pageNumberHeading",
                                {
                                  pageNumber: formatNumber(page.page_number),
                                },
                              )}
                            </h4>
                            <p className="mt-1 text-xs text-muted">
                              {t(
                                `contentQuality.pageScanStatuses.${page.status}`,
                                undefined,
                                page.status,
                              )}
                              {` · ${t("contentQuality.bookDetail.rulePrefix")} `}
                              {page.rule_check_status}
                              {` · ${t("contentQuality.bookDetail.aiPrefix")} `}
                              {t(
                                `contentQuality.aiCheckStatuses.${page.ai_analysis_status}`,
                                undefined,
                                page.ai_analysis_status,
                              )}
                            </p>
                            {page.page_revision_id ? (
                              <p className="mt-1 break-all font-mono text-xs text-muted">
                                {t(
                                  "contentQuality.bookDetail.sourceRevisionPrefix",
                                )}{" "}
                                {page.page_revision_id}
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
                                {t("contentQuality.bookDetail.checkAndFixPage")}
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
                                {t("contentQuality.bookDetail.rescanPage")}
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
                              ? t("contentQuality.bookDetail.noFindingThisScan")
                              : t("contentQuality.bookDetail.noScanResultYet")}
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
