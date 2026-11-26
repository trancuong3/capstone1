"use client";

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Lock,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { AdminFlow2CandidatesPanel } from "@/components/admin/admin-flow2-candidates-panel";
import {
  AdminBadge,
  AdminDrawer,
  AdminKpiCard,
  AdminKpiGrid,
  AdminSearchInput,
  AdminToolbar,
  type AdminBadgeTone,
} from "@/components/admin/admin-ui";
import { AuthenticatedImage } from "@/components/common/authenticated-image";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import { cn } from "@/lib/utils/cn";
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

const QUEUE_STATUS_TONES: Record<string, AdminBadgeTone> = {
  PENDING_ADMIN: "info",
  FLAGGED: "warning",
  CHECK_FAILED: "danger",
  APPROVED: "success",
  REJECTED: "danger",
  SUSPENDED: "danger",
};

const WORKFLOW_TONES: Record<string, AdminBadgeTone> = {
  CHECKING: "info",
  PASSED_READY_TO_ADD: "success",
  NEEDS_ADMIN_REVIEW: "warning",
  CHECK_FAILED: "danger",
  PENDING_ADMIN: "info",
  APPROVED_READY_TO_ADD: "success",
  REJECTED: "danger",
  NEEDS_RECHECK: "warning",
  ADDED_TO_BOOK: "success",
  CANCELLED: "neutral",
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
    <div className="rounded-xl border border-border bg-surface-subtle/60 p-4">
      <label className="flex flex-col gap-1.5 text-xs font-bold text-ink">
        {t("userBooks.decisionReasonLabel")}
        <textarea
          aria-label={t("userBooks.decisionReasonAria")}
          className="min-h-24 w-full rounded-control border border-border bg-white p-2.5 text-sm font-normal text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
          onChange={(event) => setDecisionReason(event.target.value)}
          placeholder={t("userBooks.decisionReasonPlaceholder")}
          value={decisionReason}
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={!detail.can_approve || busyAction !== null}
          isLoading={busyAction === "decide:APPROVE"}
          onClick={() => void handleDecisionClick("APPROVE")}
          size="admin"
          type="button"
          variant="primary"
        >
          <ShieldCheck aria-hidden="true" className="size-4" />
          {t("userBooks.approveBtn")}
        </Button>

        <Button
          disabled={busyAction !== null}
          isLoading={busyAction === "decide:REQUEST_CHANGES"}
          onClick={() => void handleDecisionClick("REQUEST_CHANGES")}
          size="admin"
          type="button"
          variant="secondary"
        >
          <CheckCircle2 aria-hidden="true" className="size-4" />
          {t("userBooks.requestChangesBtn")}
        </Button>

        <Button
          disabled={busyAction !== null}
          isLoading={busyAction === "decide:REJECT"}
          onClick={() => void handleDecisionClick("REJECT")}
          size="admin"
          type="button"
          variant="destructive-outline"
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
              className="h-10 min-h-10 flex-1 rounded-control border border-border bg-white px-3 text-xs text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onChange={(event) => setSuspendReason(event.target.value)}
              placeholder={t("userBooks.suspendReasonPlaceholder")}
              value={suspendReason}
            />
            <Button
              disabled={busyAction !== null}
              isLoading={busyAction === "suspend"}
              onClick={() => void handleSuspendClick()}
              size="admin"
              type="button"
              variant="destructive"
            >
              <Ban aria-hidden="true" className="size-3.5" />
              {t("userBooks.suspendBtn")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded-control border border-danger/25 bg-danger-surface p-2.5 text-xs font-semibold text-danger">
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

export interface AdminUserBooksQualitySectionProps {
  readonly embedded?: boolean;
  readonly onPendingCountChange?: (count: number) => void;
  readonly refreshSignal?: number;
}

export const AdminUserBooksQualitySection = memo(
  function AdminUserBooksQualitySection({
    onPendingCountChange,
    refreshSignal = 0,
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
      void refreshSignal;
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
      refreshSignal,
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

    const closeDrawer = useCallback(() => {
      setSelectedId(null);
      setConflictError(null);
      setActionError(null);
    }, []);

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
        setSelectedId(null);
        await loadQueue();
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
        setSelectedId(null);
        await loadQueue();
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
      <div className="flex flex-col gap-4">
        {/* Scope & Isolation Notice */}
        <div
          className="flex items-start gap-3 rounded-xl border border-primary/20 bg-sky/45 p-3.5 text-sm text-ink"
          role="note"
        >
          <Lock
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-primary"
          />
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-ink">
              {t("userBooks.headerTitle")}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              {t("userBooks.headerDesc")}
            </p>
          </div>
        </div>

        {/* Sub-tab switcher: Moderation vs Flow 2 OCR sample verification */}
        <div
          aria-label={t("userBooks.subtabsAria")}
          className="inline-flex w-fit flex-wrap gap-1.5 rounded-xl border border-border bg-surface-subtle p-1"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              const nextSub =
                subTab === "moderation" ? "flow2_candidates" : "moderation";
              setSubTab(nextSub);
              const targetId =
                nextSub === "moderation"
                  ? "user-books-subtab-moderation"
                  : "user-books-subtab-flow2";
              document.getElementById(targetId)?.focus();
            }
          }}
          role="tablist"
        >
          <button
            aria-controls="user-books-subpanel-moderation"
            aria-selected={subTab === "moderation"}
            className={cn(
              "rounded-control px-3.5 py-2 text-xs font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
              subTab === "moderation"
                ? "bg-white text-primary shadow-2xs ring-1 ring-border"
                : "text-muted hover:bg-white/75 hover:text-ink",
            )}
            id="user-books-subtab-moderation"
            onClick={() => setSubTab("moderation")}
            role="tab"
            tabIndex={subTab === "moderation" ? 0 : -1}
            type="button"
          >
            {t("userBooks.subtabModeration")}
          </button>
          <button
            aria-controls="user-books-subpanel-flow2"
            aria-selected={subTab === "flow2_candidates"}
            className={cn(
              "rounded-control px-3.5 py-2 text-xs font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
              subTab === "flow2_candidates"
                ? "bg-white text-primary shadow-2xs ring-1 ring-border"
                : "text-muted hover:bg-white/75 hover:text-ink",
            )}
            id="user-books-subtab-flow2"
            onClick={() => setSubTab("flow2_candidates")}
            role="tab"
            tabIndex={subTab === "flow2_candidates" ? 0 : -1}
            type="button"
          >
            {t("userBooks.subtabFlow2")}
          </button>
        </div>

        {subTab === "flow2_candidates" ? (
          <div
            aria-labelledby="user-books-subtab-flow2"
            id="user-books-subpanel-flow2"
            role="tabpanel"
          >
            <AdminFlow2CandidatesPanel />
          </div>
        ) : (
          <div
            aria-labelledby="user-books-subtab-moderation"
            className="space-y-4"
            id="user-books-subpanel-moderation"
            role="tabpanel"
          >
            <AdminKpiGrid
              ariaLabel={t(
                "userBooks.kpiAria",
                undefined,
                "Tổng quan hàng đợi sách người dùng",
              )}
              columns={4}
            >
              <AdminKpiCard
                icon={<Clock className="size-4" />}
                label={t("userBooks.filters.PENDING_ADMIN")}
                tone={(summary.PENDING_ADMIN ?? 0) > 0 ? "info" : "neutral"}
                value={formatNumber(summary.PENDING_ADMIN ?? 0)}
              />
              <AdminKpiCard
                icon={<AlertTriangle className="size-4" />}
                label={t("userBooks.filters.FLAGGED")}
                tone={(summary.FLAGGED ?? 0) > 0 ? "warning" : "neutral"}
                value={formatNumber(summary.FLAGGED ?? 0)}
              />
              <AdminKpiCard
                icon={<XCircle className="size-4" />}
                label={t("userBooks.filters.CHECK_FAILED")}
                tone={(summary.CHECK_FAILED ?? 0) > 0 ? "danger" : "neutral"}
                value={formatNumber(summary.CHECK_FAILED ?? 0)}
              />
              <AdminKpiCard
                icon={<CheckCircle2 className="size-4" />}
                label={t("userBooks.filters.APPROVED")}
                tone="success"
                value={formatNumber(summary.APPROVED ?? 0)}
              />
            </AdminKpiGrid>

            {actionNotice ? (
              <StatusMessage
                title={t("userBooks.decisionSavedTitle")}
                tone="success"
              >
                {actionNotice}
              </StatusMessage>
            ) : null}

            {/* Filters & Search */}
            <AdminToolbar
              actions={
                <Button
                  disabled={loadingQueue}
                  onClick={() => void loadQueue()}
                  size="admin"
                  type="button"
                  variant="outline"
                >
                  <RefreshCw aria-hidden="true" className="size-4" />
                  {t("userBooks.reloadQueue")}
                </Button>
              }
              ariaLabel={t("userBooks.filterAria")}
            >
              <AdminSearchInput
                containerClassName="max-w-md"
                hideLabel
                label={t("userBooks.searchLabel")}
                onChange={(value) => {
                  setQueueOffset(0);
                  setSearchText(value);
                }}
                placeholder={t("userBooks.searchPlaceholder")}
                value={searchText}
              />
            </AdminToolbar>

            <section className="rounded-xl border border-border bg-white p-4 shadow-2xs sm:p-5">
              <div className="min-w-0">
                <h2 className="text-lg font-extrabold tracking-tight text-ink">
                  {t("userBooks.queueHeading")}
                </h2>
                <p className="mt-0.5 text-xs text-muted">
                  {t("userBooks.queueSubtitle")}
                </p>
              </div>

              {/* 6 Required Status Filter Buttons + All */}
              <div
                aria-label={t("userBooks.filterAria")}
                className="mt-3.5 flex flex-wrap gap-2"
                role="group"
              >
                <button
                  aria-pressed={statusFilter === ""}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    statusFilter === ""
                      ? "border-primary bg-primary text-white"
                      : "border-border bg-white text-ink hover:bg-surface-subtle",
                  )}
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
                      aria-pressed={active}
                      className={cn(
                        "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                        active
                          ? "border-primary bg-primary text-white"
                          : "border-border bg-white text-ink hover:bg-surface-subtle",
                      )}
                      key={filterKey}
                      onClick={() => {
                        setQueueOffset(0);
                        setStatusFilter(filterKey);
                      }}
                      type="button"
                    >
                      {t(`userBooks.filters.${filterKey}`)}
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
                          active
                            ? "bg-white/20 text-white"
                            : "bg-surface-subtle text-ink",
                        )}
                      >
                        {formatNumber(count)}
                      </span>
                    </button>
                  );
                })}
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
                      className="h-24 w-full rounded-xl"
                      key={idx}
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
                      QUEUE_STATUS_TONES[item.queue_status] ?? "neutral";
                    return (
                      <li
                        className={cn(
                          "flex flex-col justify-between gap-3 rounded-xl border p-4 transition-colors sm:flex-row sm:items-center",
                          isSelected
                            ? "border-primary bg-sky/20 ring-1 ring-primary/25"
                            : "border-border bg-white hover:border-primary/40 hover:bg-surface-subtle/50",
                        )}
                        key={`${item.book_id}:${targetSubId ?? "none"}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <AdminBadge dot tone={tone}>
                              {t(`userBooks.filters.${item.queue_status}`)}
                            </AdminBadge>
                            {item.moderation_status === "SUSPENDED" ? (
                              <AdminBadge tone="danger">
                                {t("userBooks.suspendedBadge")}
                              </AdminBadge>
                            ) : null}
                            {item.policy_blocked ? (
                              <AdminBadge
                                icon={
                                  <ShieldAlert
                                    aria-hidden="true"
                                    className="size-3"
                                  />
                                }
                                tone="danger"
                              >
                                {t("userBooks.policyBlockedBadge")}
                              </AdminBadge>
                            ) : null}
                          </div>
                          <h3 className="mt-1.5 text-base font-extrabold text-ink">
                            {item.book_title}
                          </h3>
                          <p className="mt-0.5 text-xs text-muted">
                            {t("userBooks.ownerLabel")}{" "}
                            <strong className="text-ink">
                              {item.owner_label}
                            </strong>
                            {item.latest_submission_version
                              ? t("userBooks.versionPrefix", {
                                  version: item.latest_submission_version,
                                })
                              : ""}
                            {" · "}
                            <span className="tabular-nums">
                              {t("userBooks.committedPages", {
                                count: formatNumber(item.committed_page_count),
                              })}
                            </span>
                          </p>
                          <p className="mt-1 text-xs tabular-nums text-muted">
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
                            disabled={!targetSubId}
                            onClick={() => {
                              if (targetSubId) {
                                void openDetail(targetSubId);
                              }
                            }}
                            size="admin"
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

            {/* Detail Review Drawer */}
            <AdminDrawer
              description={
                detail
                  ? t("userBooks.detailMeta", {
                      owner: detail.owner_label,
                      version: detail.submission_version,
                      lockVersion: detail.optimistic_lock_version,
                      hashSuffix: detail.snapshot_hash
                        ? ` · Hash ${detail.snapshot_hash.slice(0, 12)}`
                        : "",
                    })
                  : undefined
              }
              footer={
                detail ? (
                  <>
                    <Button
                      onClick={() => void openDetail(detail.submission_id)}
                      size="admin"
                      type="button"
                      variant="outline"
                    >
                      <RefreshCw aria-hidden="true" className="size-3.5" />
                      {t("userBooks.reloadLatest")}
                    </Button>
                    <Button
                      onClick={closeDrawer}
                      size="admin"
                      type="button"
                      variant="secondary"
                    >
                      {t("common.close")}
                    </Button>
                  </>
                ) : undefined
              }
              isOpen={Boolean(selectedId)}
              onClose={closeDrawer}
              size="xl"
              title={
                detail
                  ? t("userBooks.detailHeading", {
                      title: detail.book_title,
                      pageNumber: detail.source_page_number,
                      totalPages: detail.batch_total_pages,
                    })
                  : t("userBooks.detailAria")
              }
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
                <div
                  aria-label={t("userBooks.detailAria")}
                  className="flex flex-col gap-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <AdminBadge tone="info">
                      {t("userBooks.privateParentBookTag")}
                    </AdminBadge>
                    <AdminBadge
                      dot
                      tone={WORKFLOW_TONES[detail.workflow_status] ?? "neutral"}
                    >
                      {detail.workflow_status_label}
                    </AdminBadge>
                    {detail.book_moderation_status === "SUSPENDED" ? (
                      <AdminBadge tone="danger">
                        {t("userBooks.bookSuspendedTag")}
                      </AdminBadge>
                    ) : null}
                  </div>

                  {conflictError ? (
                    <StatusMessage
                      title={t("userBooks.conflictTitle")}
                      tone="warning"
                    >
                      <div className="flex flex-col gap-2">
                        <p>{conflictError}</p>
                        <Button
                          className="self-start"
                          onClick={() => void openDetail(detail.submission_id)}
                          size="admin"
                          type="button"
                          variant="secondary"
                        >
                          <RotateCcw aria-hidden="true" className="size-3.5" />
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

                  <div className="grid gap-4 lg:grid-cols-12">
                    {/* Left Column: Authenticated Page Image */}
                    <div className="lg:col-span-5">
                      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
                        {t("userBooks.sourceImageHeading")}
                      </p>
                      <div className="overflow-hidden rounded-xl border border-border bg-surface-subtle p-3">
                        <AuthenticatedImage
                          alt={t("userBooks.sourceImageAlt", {
                            pageNumber: detail.source_page_number,
                            title: detail.book_title,
                          })}
                          className="mx-auto max-h-[380px] w-full object-contain"
                          src={detail.image_url}
                        />
                      </div>
                      <div className="mt-3 rounded-xl border border-border bg-surface-subtle/60 p-3 text-xs">
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
                        <div className="rounded-xl border border-border bg-surface-subtle/60 p-3">
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
                        <div className="rounded-xl border border-border bg-white p-3">
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
                      <div className="rounded-xl border border-border bg-surface-subtle p-3 text-xs">
                        <p className="font-bold text-ink">
                          {t("userBooks.toolCheckHeading", {
                            status: detail.tool_check_status,
                          })}
                          {detail.tool_check_suitability
                            ? ` (${detail.tool_check_suitability})`
                            : ""}
                        </p>
                        <p className="mt-1 text-muted">
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
                              detail.tool_check_scope.copyright_scanner_status,
                          })}
                        </p>
                      </div>

                      {/* Findings — Sensitive Excerpts Collapsed by Default */}
                      {detail.tool_check_findings.length > 0 ? (
                        <div className="rounded-xl border border-amber-200 bg-warning-surface/65 p-3">
                          <p className="flex items-center gap-1.5 text-xs font-bold text-warning">
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
                            {detail.tool_check_findings.map((finding, idx) => (
                              <li
                                className="rounded-control border border-amber-200 bg-white p-2.5"
                                key={finding.finding_id ?? idx}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-bold text-ink">
                                    {finding.category}
                                  </span>
                                  <AdminBadge
                                    tone={
                                      finding.severity === "HIGH"
                                        ? "danger"
                                        : "warning"
                                    }
                                  >
                                    {finding.severity}
                                  </AdminBadge>
                                </div>
                                {finding.explanation ? (
                                  <p className="mt-1 text-ink">
                                    {finding.explanation}
                                  </p>
                                ) : null}
                                {finding.excerpt ? (
                                  <details className="mt-1.5">
                                    <summary className="cursor-pointer font-semibold text-primary">
                                      {t("userBooks.revealSensitiveExcerpt")}
                                    </summary>
                                    <p
                                      className="viread-learning-content mt-1 rounded bg-surface-subtle p-2 font-mono text-[11px] text-ink"
                                      dir="ltr"
                                      lang="vi"
                                    >
                                      {finding.excerpt}
                                    </p>
                                  </details>
                                ) : null}
                              </li>
                            ))}
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
                        busyAction={busyAction}
                        detail={detail}
                        key={detail.submission_id}
                        onSubmitDecision={submitDecision}
                        onSuspendBook={handleSuspendBook}
                      />

                      {/* Moderation History */}
                      <div className="rounded-xl border border-border bg-white p-3">
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
                                className="rounded-control border border-border bg-surface-subtle/50 p-2"
                                key={hist.request_id}
                              >
                                <div className="flex flex-wrap items-center justify-between gap-1">
                                  <span className="font-bold text-ink">
                                    v{hist.submission_version} · {hist.status}
                                    {hist.decided_by_label
                                      ? ` · ${hist.decided_by_label}`
                                      : ""}
                                  </span>
                                  <span className="text-[11px] tabular-nums text-muted">
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
            </AdminDrawer>
          </div>
        )}
      </div>
    );
  },
);
