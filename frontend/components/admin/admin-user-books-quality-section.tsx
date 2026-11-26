"use client";

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { AdminFlow2CandidatesPanel } from "@/components/admin/admin-flow2-candidates-panel";
import { AuthenticatedImage } from "@/components/common/authenticated-image";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import {
  type AdminUserBookDecisionType,
  type AdminUserBookQueueFilter,
  type AdminUserBookQueueItemDTO,
  type AdminUserBookQueuePageDTO,
  type AdminUserBookSubmissionDetailDTO,
} from "@/types/parent-private-book";

const QUEUE_FILTER_KEYS: readonly AdminUserBookQueueFilter[] = [
  "PENDING_ADMIN",
  "FLAGGED",
  "CHECK_FAILED",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
];

const QUEUE_STATUS_TONES: Record<string, string> = {
  PENDING_ADMIN: "border-indigo-300 bg-indigo-100 text-indigo-950",
  FLAGGED: "border-amber-300 bg-amber-100 text-amber-950",
  CHECK_FAILED: "border-rose-300 bg-rose-100 text-rose-900",
  APPROVED: "border-emerald-300 bg-emerald-100 text-emerald-950",
  REJECTED: "border-rose-300 bg-rose-100 text-rose-900",
  SUSPENDED: "border-rose-400 bg-rose-100 text-rose-950",
};

const WORKFLOW_TONES: Record<string, string> = {
  CHECKING: "border-primary/30 bg-sky text-primary-hover",
  PASSED_READY_TO_ADD: "border-emerald-300 bg-emerald-100 text-emerald-950",
  NEEDS_ADMIN_REVIEW: "border-amber-300 bg-amber-100 text-amber-950",
  CHECK_FAILED: "border-rose-300 bg-rose-100 text-rose-900",
  PENDING_ADMIN: "border-indigo-300 bg-indigo-100 text-indigo-950",
  APPROVED_READY_TO_ADD: "border-emerald-300 bg-emerald-100 text-emerald-950",
  REJECTED: "border-rose-300 bg-rose-100 text-rose-900",
  NEEDS_RECHECK: "border-orange-300 bg-orange-100 text-orange-950",
  ADDED_TO_BOOK: "border-teal-300 bg-teal-100 text-teal-950",
  CANCELLED: "border-slate-300 bg-slate-100 text-slate-700",
};

function getAdminErrorText(error: unknown, fallback: string): string {
  if (isServiceError(error) && error.message) {
    return error.message;
  }
  return fallback;
}

interface UserBookDecisionPanelProps {
  detail: AdminUserBookSubmissionDetailDTO;
  busyAction: string | null;
  onSubmitDecision: (
    decision: AdminUserBookDecisionType,
    decisionReason: string,
  ) => Promise<boolean>;
  onSuspendBook: (
    suspendReason: string,
    decisionReason: string,
  ) => Promise<boolean>;
}

function UserBookDecisionPanel({
  detail,
  busyAction,
  onSubmitDecision,
  onSuspendBook,
}: UserBookDecisionPanelProps) {
  const t = useTranslations("admin");
  const [decisionReason, setDecisionReason] = useState("");
  const [suspendReason, setSuspendReason] = useState("");

  async function handleDecisionClick(decision: AdminUserBookDecisionType) {
    const succeeded = await onSubmitDecision(decision, decisionReason);
    if (succeeded) {
      setDecisionReason("");
    }
  }

  async function handleSuspendClick() {
    const succeeded = await onSuspendBook(suspendReason, decisionReason);
    if (succeeded) {
      setSuspendReason("");
    }
  }

  return (
    <div className="rounded-card border border-border bg-canvas/60 p-4">
      <label className="flex flex-col gap-1.5 text-xs font-bold text-ink">
        {t("userBooks.decisionReasonLabel")}
        <textarea
          aria-label={t("userBooks.decisionReasonAria")}
          className="min-h-24 w-full rounded-control border border-border bg-white p-2.5 text-sm font-normal text-ink focus-visible:outline-3 focus-visible:outline-primary"
          onChange={(event) => setDecisionReason(event.target.value)}
          placeholder={t("userBooks.decisionReasonPlaceholder")}
          value={decisionReason}
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          className="min-h-11 w-auto px-4 text-sm"
          disabled={!detail.can_approve || busyAction !== null}
          isLoading={busyAction === "decide:APPROVE"}
          onClick={() => void handleDecisionClick("APPROVE")}
          type="button"
        >
          <ShieldCheck aria-hidden="true" className="size-4" />
          {t("userBooks.approveBtn")}
        </Button>

        <Button
          className="min-h-11 w-auto px-4 text-sm"
          disabled={busyAction !== null}
          isLoading={busyAction === "decide:REQUEST_CHANGES"}
          onClick={() => void handleDecisionClick("REQUEST_CHANGES")}
          type="button"
          variant="secondary"
        >
          <CheckCircle2 aria-hidden="true" className="size-4" />
          {t("userBooks.requestChangesBtn")}
        </Button>

        <Button
          className="min-h-11 w-auto px-4 text-sm"
          disabled={busyAction !== null}
          isLoading={busyAction === "decide:REJECT"}
          onClick={() => void handleDecisionClick("REJECT")}
          type="button"
          variant="destructive"
        >
          <XCircle aria-hidden="true" className="size-4" />
          {t("userBooks.rejectBtn")}
        </Button>
      </div>

      {/* Suspend Book */}
      {detail.book_moderation_status !== "SUSPENDED" ? (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-xs font-bold text-ink">
            {t("userBooks.suspendTitle")}
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              aria-label={t("userBooks.suspendReasonAria")}
              className="min-h-10 flex-1 rounded-control border border-border bg-white px-3 text-xs text-ink"
              onChange={(event) => setSuspendReason(event.target.value)}
              placeholder={t("userBooks.suspendReasonPlaceholder")}
              value={suspendReason}
            />
            <Button
              className="min-h-10 w-auto px-4 text-xs"
              disabled={busyAction !== null}
              isLoading={busyAction === "suspend"}
              onClick={() => void handleSuspendClick()}
              type="button"
              variant="destructive"
            >
              <Ban aria-hidden="true" className="size-3.5" />
              {t("userBooks.suspendBtn")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded bg-rose-50 p-2 text-xs font-semibold text-rose-900">
          {detail.book_suspended_reason
            ? t("userBooks.alreadySuspendedNote", {
                reason: detail.book_suspended_reason,
              })
            : t("userBooks.suspendedBadge")}
        </p>
      )}
    </div>
  );
}

interface AdminUserBooksQualitySectionProps {
  onPendingCountChange?: (count: number) => void;
}

export const AdminUserBooksQualitySection = memo(
  function AdminUserBooksQualitySection({
    onPendingCountChange,
  }: AdminUserBooksQualitySectionProps) {
    const { bookContentQuality } = useAdminServices();
    const t = useTranslations("admin");
    const { formatDateTime, formatNumber } = useI18n();
    const [subTab, setSubTab] = useState<"moderation" | "flow2_candidates">(
      "moderation",
    );

    const [statusFilter, setStatusFilter] = useState<
      "" | AdminUserBookQueueFilter
    >("PENDING_ADMIN");
    const [searchText, setSearchText] = useState("");
    const [queue, setQueue] = useState<AdminUserBookQueuePageDTO | null>(null);
    const [loadingQueue, setLoadingQueue] = useState(true);
    const [queueError, setQueueError] = useState<string | null>(null);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [detail, setDetail] =
      useState<AdminUserBookSubmissionDetailDTO | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);

    const [busyAction, setBusyAction] = useState<string | null>(null);
    const [actionNotice, setActionNotice] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [conflictError, setConflictError] = useState<string | null>(null);
    const detailRequestIdRef = useRef(0);

    const USER_BOOKS_PAGE_SIZE = 30;
    const [queueOffset, setQueueOffset] = useState(0);
    const [queueReloadKey, setQueueReloadKey] = useState(0);

    const loadQueue = useCallback(async () => {
      setQueueReloadKey((prev) => prev + 1);
    }, []);

    useEffect(() => {
      if (!bookContentQuality.listUserBooks) {
        return;
      }
      let active = true;
      void Promise.resolve()
        .then(() => {
          if (!active) return;
          setLoadingQueue(true);
          setQueueError(null);
          return bookContentQuality.listUserBooks!({
            status: statusFilter || undefined,
            search: searchText.trim() || undefined,
            limit: USER_BOOKS_PAGE_SIZE,
            offset: queueOffset,
          });
        })
        .then((response) => {
          if (!active || !response) return;
          if (
            response.items.length === 0 &&
            queueOffset > 0 &&
            response.total > 0
          ) {
            setQueueOffset(Math.max(0, queueOffset - USER_BOOKS_PAGE_SIZE));
            return;
          }
          setQueue(response);
          onPendingCountChange?.(response.summary?.PENDING_ADMIN ?? 0);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setQueueError(
            getAdminErrorText(error, t("userBooks.queueLoadError")),
          );
        })
        .finally(() => {
          if (active) setLoadingQueue(false);
        });
      return () => {
        active = false;
      };
    }, [
      bookContentQuality,
      onPendingCountChange,
      queueOffset,
      queueReloadKey,
      searchText,
      statusFilter,
      t,
    ]);

    const openDetail = useCallback(
      async (submissionId: string, options?: { preserveNotice?: boolean }) => {
        if (!bookContentQuality.getUserBookSubmission) return;
        const requestId = ++detailRequestIdRef.current;
        setSelectedId(submissionId);
        setLoadingDetail(true);
        setDetailError(null);
        setConflictError(null);
        setActionError(null);
        if (!options?.preserveNotice) {
          setActionNotice(null);
        }
        try {
          const result =
            await bookContentQuality.getUserBookSubmission(submissionId);
          if (requestId !== detailRequestIdRef.current) return;
          setDetail(result);
        } catch (error) {
          if (requestId !== detailRequestIdRef.current) return;
          setDetail(null);
          setDetailError(
            getAdminErrorText(error, t("userBooks.detailLoadError")),
          );
        } finally {
          if (requestId === detailRequestIdRef.current) {
            setLoadingDetail(false);
          }
        }
      },
      [bookContentQuality, t],
    );

    async function submitDecision(
      decision: AdminUserBookDecisionType,
      decisionReason: string,
    ): Promise<boolean> {
      if (!detail || !bookContentQuality.decideUserBookSubmission) return false;
      setActionError(null);
      setActionNotice(null);
      setConflictError(null);

      const trimmedReason = decisionReason.trim();
      if (trimmedReason.length < 5) {
        setActionError(t("userBooks.errors.decisionReasonMin"));
        return false;
      }
      if (decision === "APPROVE" && !detail.can_approve) {
        setActionError(
          detail.approve_blocked_reason ??
            t("userBooks.errors.policyBlockedApprove"),
        );
        return false;
      }
      if (!detail.snapshot_hash) {
        setActionError(t("userBooks.errors.missingSnapshotHash"));
        return false;
      }

      setBusyAction(`decide:${decision}`);
      try {
        const response = await bookContentQuality.decideUserBookSubmission(
          detail.submission_id,
          {
            decision,
            reason: trimmedReason,
            expected_submission_version: detail.submission_version,
            expected_snapshot_hash: detail.snapshot_hash,
            expected_lock_version: detail.optimistic_lock_version,
          },
        );
        setActionNotice(
          decision === "APPROVE"
            ? t("userBooks.notices.approved", {
                version:
                  response.approved_submission_version ??
                  detail.submission_version,
              })
            : decision === "REQUEST_CHANGES"
              ? t("userBooks.notices.requestChanges")
              : decision === "SUSPEND"
                ? t("userBooks.notices.suspendedBook")
                : t("userBooks.notices.rejected"),
        );
        await Promise.all([
          loadQueue(),
          openDetail(detail.submission_id, { preserveNotice: true }),
        ]);
        return true;
      } catch (error) {
        if (isServiceError(error) && error.status === 409) {
          setConflictError(
            getAdminErrorText(error, t("userBooks.conflictMessage")),
          );
        } else {
          setActionError(
            getAdminErrorText(error, t("userBooks.errors.saveDecisionFailed")),
          );
        }
        return false;
      } finally {
        setBusyAction(null);
      }
    }

    async function handleSuspendBook(
      suspendReason: string,
      decisionReason: string,
    ): Promise<boolean> {
      if (!detail || !bookContentQuality.suspendUserBook) return false;
      setActionError(null);
      setActionNotice(null);
      setConflictError(null);

      const trimmed = suspendReason.trim() || decisionReason.trim();
      if (trimmed.length < 5) {
        setActionError(t("userBooks.errors.suspendReasonMin"));
        return false;
      }

      setBusyAction("suspend");
      try {
        await bookContentQuality.suspendUserBook(detail.book_id, trimmed);
        setActionNotice(
          t("userBooks.notices.suspendedWithTitle", {
            title: detail.book_title,
          }),
        );
        await Promise.all([
          loadQueue(),
          openDetail(detail.submission_id, { preserveNotice: true }),
        ]);
        return true;
      } catch (error) {
        setActionError(
          getAdminErrorText(error, t("userBooks.errors.suspendGeneric")),
        );
        return false;
      } finally {
        setBusyAction(null);
      }
    }

    const summary = queue?.summary ?? {};

    return (
      <div
        aria-labelledby="quality-tab-user-books"
        className="flex flex-col gap-5"
        id="quality-panel-user-books"
        role="tabpanel"
      >
        {/* Scope & Isolation Notice */}
        <div
          role="note"
          className="flex items-start gap-3 rounded-card border border-indigo-200 bg-indigo-50/70 p-4 text-sm text-indigo-950"
        >
          <Lock
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-indigo-700"
          />
          <div>
            <p className="font-bold">{t("userBooks.headerTitle")}</p>
            <p className="mt-0.5 text-xs text-indigo-900 sm:text-sm">
              {t("userBooks.headerDesc")}
            </p>
          </div>
        </div>

        {/* Sub-tab switcher: Moderation vs Flow 2 OCR sample verification */}
        <div
          aria-label={t("userBooks.subtabsAria")}
          className="flex flex-wrap gap-2"
          role="tablist"
        >
          <button
            aria-selected={subTab === "moderation"}
            className={`rounded-full border px-4 py-2 text-xs font-extrabold transition ${
              subTab === "moderation"
                ? "border-primary bg-primary text-white"
                : "border-border bg-white text-ink hover:bg-surface-subtle"
            }`}
            onClick={() => setSubTab("moderation")}
            role="tab"
            type="button"
          >
            {t("userBooks.subtabModeration")}
          </button>
          <button
            aria-selected={subTab === "flow2_candidates"}
            className={`rounded-full border px-4 py-2 text-xs font-extrabold transition ${
              subTab === "flow2_candidates"
                ? "border-primary bg-primary text-white"
                : "border-border bg-white text-ink hover:bg-surface-subtle"
            }`}
            onClick={() => setSubTab("flow2_candidates")}
            role="tab"
            type="button"
          >
            {t("userBooks.subtabFlow2")}
          </button>
        </div>

        {subTab === "flow2_candidates" ? (
          <AdminFlow2CandidatesPanel />
        ) : (
          <>
            {/* Filters & Search */}
            <section className="rounded-card border border-border bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-extrabold text-ink">
                    {t("userBooks.queueHeading")}
                  </h2>
                  <p className="mt-1 text-xs text-muted sm:text-sm">
                    {t("userBooks.queueSubtitle")}
                  </p>
                </div>
                <Button
                  className="min-h-10 w-auto px-3 text-sm"
                  disabled={loadingQueue}
                  onClick={() => void loadQueue()}
                  type="button"
                  variant="secondary"
                >
                  <RefreshCw aria-hidden="true" className="size-4" />
                  {t("userBooks.reloadQueue")}
                </Button>
              </div>

              {/* 6 Required Status Filter Buttons + All */}
              <div
                aria-label={t("userBooks.filterAria")}
                className="mt-4 flex flex-wrap gap-2"
                role="group"
              >
                <button
                  aria-pressed={statusFilter === ""}
                  className={
                    "inline-flex min-h-10 items-center gap-1.5 rounded-control border px-3 text-xs font-bold transition sm:text-sm " +
                    (statusFilter === ""
                      ? "border-primary bg-primary text-white"
                      : "border-border bg-white text-ink hover:bg-canvas")
                  }
                  onClick={() => {
                    setQueueOffset(0);
                    setStatusFilter("");
                  }}
                  type="button"
                >
                  {t("userBooks.filterAll")}
                </button>
                {QUEUE_FILTER_KEYS.map((filterKey) => {
                  const count = summary[filterKey] ?? 0;
                  const active = statusFilter === filterKey;
                  return (
                    <button
                      key={filterKey}
                      aria-pressed={active}
                      className={
                        "inline-flex min-h-10 items-center gap-1.5 rounded-control border px-3 text-xs font-bold transition sm:text-sm " +
                        (active
                          ? "border-primary bg-primary text-white"
                          : "border-border bg-white text-ink hover:bg-canvas")
                      }
                      onClick={() => {
                        setQueueOffset(0);
                        setStatusFilter(filterKey);
                      }}
                      type="button"
                    >
                      {t(`userBooks.filters.${filterKey}`)}
                      <span
                        className={
                          "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums " +
                          (active
                            ? "bg-white/20 text-white"
                            : "bg-canvas text-ink")
                        }
                      >
                        {formatNumber(count)}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 max-w-md">
                <label className="relative block">
                  <span className="sr-only">{t("userBooks.searchLabel")}</span>
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted"
                  />
                  <input
                    aria-label={t("userBooks.searchLabel")}
                    className="min-h-11 w-full rounded-control border border-border bg-white pe-3 ps-9 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
                    onChange={(event) => {
                      setQueueOffset(0);
                      setSearchText(event.target.value);
                    }}
                    placeholder={t("userBooks.searchPlaceholder")}
                    type="search"
                    value={searchText}
                  />
                </label>
              </div>

              {queueError ? (
                <StatusMessage
                  className="mt-4"
                  title={t("userBooks.queueErrorTitle")}
                  tone="error"
                >
                  {queueError}
                </StatusMessage>
              ) : null}

              {loadingQueue ? (
                <div aria-busy="true" className="mt-4 grid gap-3">
                  {[0, 1, 2].map((idx) => (
                    <Skeleton
                      key={idx}
                      className="h-24 w-full rounded-control"
                    />
                  ))}
                </div>
              ) : !queue || queue.items.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    description={t("userBooks.emptyDesc")}
                    title={t("userBooks.emptyTitle")}
                  />
                </div>
              ) : (
                <ul className="mt-4 flex flex-col gap-3">
                  {queue.items.map((item: AdminUserBookQueueItemDTO) => {
                    const targetSubId = item.latest_submission_id;
                    const isSelected = Boolean(
                      targetSubId && selectedId === targetSubId,
                    );
                    const tone =
                      QUEUE_STATUS_TONES[item.queue_status] ??
                      "border-border bg-canvas text-ink";
                    return (
                      <li
                        key={`${item.book_id}:${targetSubId ?? "none"}`}
                        className={
                          "flex flex-col justify-between gap-3 rounded-control border p-4 transition sm:flex-row sm:items-center " +
                          (isSelected
                            ? "border-primary bg-sky/25 ring-2 ring-primary/20"
                            : "border-border bg-white hover:border-primary/50")
                        }
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold ${tone}`}
                            >
                              {t(`userBooks.filters.${item.queue_status}`)}
                            </span>
                            {item.moderation_status === "SUSPENDED" ? (
                              <span className="inline-flex items-center rounded-full border border-rose-300 bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-900">
                                {t("userBooks.suspendedBadge")}
                              </span>
                            ) : null}
                            {item.policy_blocked ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-rose-400 bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-900">
                                <ShieldAlert
                                  aria-hidden="true"
                                  className="size-3"
                                />
                                {t("userBooks.policyBlockedBadge")}
                              </span>
                            ) : null}
                          </div>
                          <h3 className="mt-1.5 text-base font-extrabold text-ink">
                            {item.book_title}
                          </h3>
                          <p className="mt-0.5 text-xs text-muted">
                            {t("userBooks.ownerLabel")}{" "}
                            <strong>{item.owner_label}</strong>
                            {item.latest_submission_version
                              ? t("userBooks.versionPrefix", {
                                  version: item.latest_submission_version,
                                })
                              : ""}
                            {" · "}
                            {t("userBooks.committedPages", {
                              count: formatNumber(item.committed_page_count),
                            })}
                          </p>
                          <p className="mt-1 text-xs text-muted">
                            {t("userBooks.queueItemStats", {
                              pending: formatNumber(item.pending_count),
                              flagged: formatNumber(item.flagged_count),
                              failed: formatNumber(item.failed_count),
                              time: formatDateTime(item.latest_submitted_at),
                            })}
                          </p>
                        </div>

                        <div className="flex shrink-0 items-center">
                          <Button
                            className="min-h-10 w-full px-4 text-sm sm:w-auto"
                            disabled={!targetSubId}
                            onClick={() => {
                              if (targetSubId) {
                                void openDetail(targetSubId);
                              }
                            }}
                            type="button"
                            variant={isSelected ? "primary" : "secondary"}
                          >
                            {t("userBooks.openForReview")}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {queue ? (
                <PaginationBar
                  ariaLabel={t("userBooks.paginationAria")}
                  className="mt-4"
                  compact
                  disabled={loadingQueue}
                  itemLabel={t("userBooks.itemLabel")}
                  onPageChange={(nextPage) =>
                    setQueueOffset((nextPage - 1) * USER_BOOKS_PAGE_SIZE)
                  }
                  page={Math.floor(queueOffset / USER_BOOKS_PAGE_SIZE) + 1}
                  pageSize={USER_BOOKS_PAGE_SIZE}
                  total={queue.total}
                />
              ) : null}
            </section>

            {/* Detail Review Panel */}
            {selectedId ? (
              <section
                aria-label={t("userBooks.detailAria")}
                className="rounded-card border-2 border-primary/30 bg-white p-4 shadow-sm sm:p-6"
              >
                {loadingDetail ? (
                  <div aria-busy="true" className="flex flex-col gap-4">
                    <Skeleton className="h-8 w-1/2" />
                    <Skeleton className="h-64 w-full" />
                  </div>
                ) : detailError || !detail ? (
                  <StatusMessage
                    title={t("userBooks.detailErrorTitle")}
                    tone="error"
                  >
                    {detailError ?? t("userBooks.submissionNotFound")}
                  </StatusMessage>
                ) : (
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-bold text-indigo-900">
                            {t("userBooks.privateParentBookTag")}
                          </span>
                          <span
                            className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                              WORKFLOW_TONES[detail.workflow_status] ??
                              "border-border bg-canvas text-ink"
                            }`}
                          >
                            {detail.workflow_status_label}
                          </span>
                          {detail.book_moderation_status === "SUSPENDED" ? (
                            <span className="rounded-full border border-rose-300 bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-900">
                              {t("userBooks.bookSuspendedTag")}
                            </span>
                          ) : null}
                        </div>
                        <h3 className="mt-2 text-xl font-extrabold text-ink">
                          {t("userBooks.detailHeading", {
                            title: detail.book_title,
                            pageNumber: detail.source_page_number,
                            totalPages: detail.batch_total_pages,
                          })}
                        </h3>
                        <p className="mt-1 text-xs text-muted">
                          {t("userBooks.detailMeta", {
                            owner: detail.owner_label,
                            version: detail.submission_version,
                            lockVersion: detail.optimistic_lock_version,
                            hashSuffix: detail.snapshot_hash
                              ? ` · Hash ${detail.snapshot_hash.slice(0, 12)}`
                              : "",
                          })}
                        </p>
                      </div>

                      <Button
                        className="min-h-10 w-auto px-3 text-xs"
                        onClick={() => void openDetail(detail.submission_id)}
                        type="button"
                        variant="secondary"
                      >
                        <RefreshCw aria-hidden="true" className="size-3.5" />
                        {t("userBooks.reloadLatest")}
                      </Button>
                    </div>

                    {conflictError ? (
                      <StatusMessage
                        title={t("userBooks.conflictTitle")}
                        tone="warning"
                      >
                        <div className="flex flex-col gap-2">
                          <p>{conflictError}</p>
                          <Button
                            className="min-h-9 w-auto self-start px-3 text-xs"
                            onClick={() =>
                              void openDetail(detail.submission_id)
                            }
                            type="button"
                            variant="secondary"
                          >
                            <RotateCcw
                              aria-hidden="true"
                              className="size-3.5"
                            />
                            {t("userBooks.reloadLatestVersionBtn")}
                          </Button>
                        </div>
                      </StatusMessage>
                    ) : null}

                    {actionError ? (
                      <StatusMessage
                        title={t("userBooks.actionIncompleteTitle")}
                        tone="error"
                      >
                        {actionError}
                      </StatusMessage>
                    ) : null}

                    {actionNotice ? (
                      <StatusMessage
                        title={t("userBooks.decisionSavedTitle")}
                        tone="success"
                      >
                        {actionNotice}
                      </StatusMessage>
                    ) : null}

                    <div className="grid gap-5 lg:grid-cols-12">
                      {/* Left Column: Authenticated Page Image */}
                      <div className="lg:col-span-5">
                        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
                          {t("userBooks.sourceImageHeading")}
                        </p>
                        <div className="overflow-hidden rounded-card border border-border bg-cream p-3">
                          <AuthenticatedImage
                            alt={t("userBooks.sourceImageAlt", {
                              pageNumber: detail.source_page_number,
                              title: detail.book_title,
                            })}
                            className="mx-auto max-h-[420px] w-full object-contain"
                            src={detail.image_url}
                          />
                        </div>
                        <div className="mt-3 rounded-control border border-border bg-canvas p-3 text-xs">
                          <p className="font-bold text-ink">
                            {t("userBooks.parentDeclarationHeading")}
                          </p>
                          <p className="mt-1">
                            <strong>{t("userBooks.sourceTypeLabel")}</strong>{" "}
                            {detail.source_type_label}
                          </p>
                          {detail.source_note ? (
                            <p className="mt-1">
                              <strong>{t("userBooks.sourceNoteLabel")}</strong>{" "}
                              {detail.source_note}
                            </p>
                          ) : null}
                          {detail.parent_request_note ? (
                            <p className="mt-1">
                              <strong>{t("userBooks.parentNoteLabel")}</strong>{" "}
                              {detail.parent_request_note}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      {/* Right Column: Evidence, Texts, Findings & Decision Controls */}
                      <div className="flex flex-col gap-4 lg:col-span-7">
                        {/* Text Comparison */}
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-control border border-border bg-canvas p-3">
                            <p className="text-xs font-bold text-muted">
                              {t("userBooks.originalOcrHeading")}
                            </p>
                            {detail.ocr_text?.trim() ? (
                              <p
                                className="viread-learning-content mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink"
                                dir="ltr"
                                lang="vi"
                              >
                                {detail.ocr_text}
                              </p>
                            ) : (
                              <p className="mt-1 text-xs leading-relaxed text-muted">
                                {t("userBooks.originalOcrEmpty")}
                              </p>
                            )}
                          </div>
                          <div className="rounded-control border border-border bg-white p-3">
                            <p className="text-xs font-bold text-ink">
                              {t("userBooks.proposedTextHeading")}
                            </p>
                            {detail.candidate_text?.trim() ? (
                              <p
                                className="viread-learning-content mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink"
                                dir="ltr"
                                lang="vi"
                              >
                                {detail.candidate_text}
                              </p>
                            ) : (
                              <p className="mt-1 text-xs leading-relaxed text-muted">
                                {t("userBooks.proposedTextEmpty")}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Tool Check Summary & Scope */}
                        <div className="rounded-control border border-border bg-slate-50 p-3 text-xs">
                          <p className="font-bold text-ink">
                            {t("userBooks.toolCheckHeading", {
                              status: detail.tool_check_status,
                            })}
                            {detail.tool_check_suitability
                              ? ` (${detail.tool_check_suitability})`
                              : ""}
                          </p>
                          <p className="mt-1 text-slate-700">
                            {t("userBooks.toolCheckScope", {
                              modality: detail.tool_check_scope.modality,
                              checked: formatNumber(
                                detail.tool_check_scope.chunks_checked,
                              ),
                              total: formatNumber(
                                detail.tool_check_scope.total_chunks,
                              ),
                              engineMode: detail.tool_check_scope
                                .local_ai_enforced
                                ? t("userBooks.engineOllamaLocal")
                                : t("userBooks.engineDefaultAi"),
                              copyrightStatus:
                                detail.tool_check_scope
                                  .copyright_scanner_status,
                            })}
                          </p>
                        </div>

                        {/* Findings — Sensitive Excerpts Collapsed by Default */}
                        {detail.tool_check_findings.length > 0 ? (
                          <div className="rounded-control border border-amber-300 bg-amber-50 p-3">
                            <p className="flex items-center gap-1.5 text-xs font-bold text-amber-950">
                              <AlertTriangle
                                aria-hidden="true"
                                className="size-4 shrink-0"
                              />
                              {t("userBooks.findingsHeading", {
                                count: formatNumber(
                                  detail.tool_check_findings.length,
                                ),
                              })}
                            </p>
                            <ul className="mt-2 space-y-2 text-xs">
                              {detail.tool_check_findings.map(
                                (finding, idx) => (
                                  <li
                                    key={finding.finding_id ?? idx}
                                    className="rounded border border-amber-200 bg-white p-2.5"
                                  >
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-bold text-ink">
                                        {finding.category}
                                      </span>
                                      <span
                                        className={
                                          "rounded px-1.5 py-0.5 text-[11px] font-bold " +
                                          (finding.severity === "HIGH"
                                            ? "bg-rose-100 text-rose-900"
                                            : "bg-amber-100 text-amber-950")
                                        }
                                      >
                                        {finding.severity}
                                      </span>
                                    </div>
                                    {finding.explanation ? (
                                      <p className="mt-1 text-ink">
                                        {finding.explanation}
                                      </p>
                                    ) : null}
                                    {finding.excerpt ? (
                                      <details className="mt-1.5">
                                        <summary className="cursor-pointer font-semibold text-primary">
                                          {t(
                                            "userBooks.revealSensitiveExcerpt",
                                          )}
                                        </summary>
                                        <p
                                          className="viread-learning-content mt-1 rounded bg-slate-100 p-2 font-mono text-[11px] text-ink"
                                          dir="ltr"
                                          lang="vi"
                                        >
                                          {finding.excerpt}
                                        </p>
                                      </details>
                                    ) : null}
                                  </li>
                                ),
                              )}
                            </ul>
                          </div>
                        ) : null}

                        {/* Policy-Block Warning */}
                        {detail.tool_check_policy_blocked ? (
                          <StatusMessage
                            title={t("userBooks.policyBlockTitle")}
                            tone="error"
                          >
                            {detail.approve_blocked_reason ??
                              t("userBooks.policyBlockBody")}
                          </StatusMessage>
                        ) : null}

                        {/* Moderation Decision Form */}
                        <UserBookDecisionPanel
                          key={detail.submission_id}
                          busyAction={busyAction}
                          detail={detail}
                          onSubmitDecision={submitDecision}
                          onSuspendBook={handleSuspendBook}
                        />

                        {/* Moderation History */}
                        <div className="rounded-control border border-border bg-white p-3">
                          <p className="text-xs font-bold text-ink">
                            {t("userBooks.historyHeading", {
                              count: formatNumber(detail.history.length),
                            })}
                          </p>
                          {detail.history.length === 0 ? (
                            <p className="mt-1 text-xs text-muted">
                              {t("userBooks.noHistoryYet")}
                            </p>
                          ) : (
                            <ul className="mt-2 space-y-2 text-xs">
                              {detail.history.map((hist) => (
                                <li
                                  key={hist.request_id}
                                  className="rounded border border-border bg-canvas/50 p-2"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-1">
                                    <span className="font-bold text-ink">
                                      v{hist.submission_version} · {hist.status}
                                      {hist.decided_by_label
                                        ? ` · ${hist.decided_by_label}`
                                        : ""}
                                    </span>
                                    <span className="text-[11px] text-muted">
                                      {formatDateTime(hist.created_at)}
                                    </span>
                                  </div>
                                  {hist.decision_reason ? (
                                    <p className="mt-1 text-ink">
                                      {t("userBooks.historyReason", {
                                        reason: hist.decision_reason,
                                      })}
                                    </p>
                                  ) : null}
                                  {hist.parent_request_note ? (
                                    <p className="mt-0.5 text-muted">
                                      {t("userBooks.historyParentNote")}{" "}
                                      {hist.parent_request_note}
                                    </p>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    );
  },
);
