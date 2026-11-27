"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  HardDrive,
  Layers,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AdminBadge,
  AdminKpiCard,
  AdminKpiGrid,
  AdminLoading,
  AdminPageHeader,
} from "@/components/admin/admin-ui";
import { AdminVireadDrivePanel } from "@/components/admin/admin-viread-drive-panel";
import {
  AdminVireadFlow1Replacement,
  AdminVireadReliabilityPanel,
} from "@/components/admin/admin-viread-flow1-replacement";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { TranslateFn } from "@/lib/i18n/types";
import type { VireadTrainingOverview } from "@/lib/api/viread-training-service";
import { cn } from "@/lib/utils/cn";

type TrainingTabKey = "overview" | "drive" | "flow1" | "flow2";

function formatTrainingStatusLabel(status: string): string {
  const map: Record<string, string> = {
    WAITING_FOR_COLAB_WORKER: "Đang chờ hệ thống huấn luyện",
    FALLBACK_QUEUED_COLAB: "Đang chờ hệ thống huấn luyện từ xa",
    COLAB_SUBMITTED: "Đã gửi yêu cầu huấn luyện",
    COLAB_EXECUTING: "Đang huấn luyện",
    RUNNING: "Đang chạy",
    COMPLETED: "Hoàn tất",
    SUCCEEDED: "Hoàn tất",
    FAILED: "Gặp lỗi",
    BLOCKED: "Đang tạm dừng",
    BLOCKED_CONFIGURATION: "Chưa đủ cấu hình",
    QUALITY_GATE_REJECTED: "Chưa đạt ngưỡng chất lượng",
    CANDIDATE: "Ứng viên",
    BENCHMARKED: "Đã kiểm định",
    ACTIVATED: "Đang hoạt động",
    QUEUED: "Đang xếp hàng",
    PENDING: "Đang chờ",
    V2_WIN: "Đạt chuẩn vượt trội",
    V2_LOST: "Chưa vượt mô hình hiện tại",
    INSUFFICIENT_EVIDENCE: "Chưa đủ dữ liệu kiểm định",
    TRAINING: "Đang huấn luyện",
    EVALUATING: "Đang kiểm định",
    PREPARING: "Đang chuẩn bị",
  };
  return map[status] ?? status.replaceAll("_", " ").toLowerCase();
}

function trainingProfileName(profile: string, t: TranslateFn) {
  if (profile === "FLOW1_EXTERNAL_TRDG" || profile === "FLOW2_EXTERNAL_TRDG") {
    return t("training.flow1Label");
  }
  if (profile === "FLOW2_ADMIN_VERIFIED" || profile === "FLOW1_VERIFIED") {
    return t("training.flow2Label");
  }
  return profile;
}

export function AdminVireadTrainingScreen() {
  const { vireadTraining } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDateTime, formatNumber } = useI18n();
  const [activeTab, setActiveTab] = useState<TrainingTabKey>("overview");
  const [data, setData] = useState<VireadTrainingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [jobsPage, setJobsPage] = useState(1);
  const [runsPage, setRunsPage] = useState(1);
  const TRAINING_LIST_PAGE_SIZE = 5;
  const [pendingConfirm, setPendingConfirm] = useState<{
    kind: "delete" | "closeMismatched" | "closeUnbenchmarked";
    jobId: string;
    title: string;
    description: string;
    confirmLabel: string;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState(() =>
    t("training.approvalDefaultReason"),
  );
  const oauthCallbackHandled = useRef(false);
  const mountedRef = useRef(true);
  const loadRequestIdRef = useRef(0);
  const actionRequestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestIdRef.current += 1;
      actionRequestIdRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    if (!mountedRef.current) return;
    setError(null);
    if (!vireadTraining) {
      setError(
        t(
          "training.errors.serviceUnavailable",
          undefined,
          "Dịch vụ quản trị huấn luyện hiện chưa sẵn sàng.",
        ),
      );
      return;
    }
    try {
      const nextData = await vireadTraining.overview();
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }
      setData(nextData);
    } catch (err) {
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }
      setError(
        isServiceError(err)
          ? err.message
          : t(
              "training.errors.loadFailed",
              undefined,
              "Chưa thể tải trạng thái huấn luyện. Vui lòng kiểm tra quyền quản trị và thử lại.",
            ),
      );
    }
  }, [t, vireadTraining]);

  useEffect(() => {
    if (
      oauthCallbackHandled.current ||
      !vireadTraining?.completeDriveCallback ||
      typeof window === "undefined"
    ) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const oauthError = params.get("error");
    if (!code && !oauthError) return;
    oauthCallbackHandled.current = true;
    const cleanUrl = `${window.location.pathname}${window.location.hash || ""}`;
    // Use an uncancelled async task so React StrictMode double-mount cleanup
    // does not drop an OAuth callback before completion, and clean the URL in finally.
    void (async () => {
      await Promise.resolve();
      if (!mountedRef.current) return;
      setActiveTab("drive");
      const actionId = ++actionRequestIdRef.current;
      if (oauthError) {
        setMessage(t("training.notices.oauthCancelled", { error: oauthError }));
        window.history.replaceState({}, document.title, cleanUrl);
        return;
      }
      if (!code || !state) {
        setMessage(t("training.notices.oauthMissingState"));
        window.history.replaceState({}, document.title, cleanUrl);
        return;
      }
      setBusy(true);
      try {
        const connected = await vireadTraining.completeDriveCallback({
          code,
          state,
        });
        if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
          return;
        }
        setMessage(
          t("training.notices.driveConnected", {
            account:
              connected.account_email ??
              t("training.notices.defaultVerifiedAccount"),
          }),
        );
        await load();
      } catch (err) {
        if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
          return;
        }
        setMessage(
          isServiceError(err)
            ? err.message
            : t("training.notices.oauthExchangeFailed"),
        );
      } finally {
        window.history.replaceState({}, document.title, cleanUrl);
        if (mountedRef.current && actionId === actionRequestIdRef.current) {
          setBusy(false);
        }
      }
    })();
  }, [load, vireadTraining, t]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    let interval: ReturnType<typeof globalThis.setInterval> | null = null;

    const stopPolling = () => {
      if (interval !== null) {
        globalThis.clearInterval(interval);
        interval = null;
      }
    };

    const startPolling = () => {
      stopPolling();
      if (typeof document !== "undefined" && document.hidden) return;
      interval = globalThis.setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        void load();
      }, 30_000);
    };

    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    };

    startPolling();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      globalThis.clearTimeout(timeout);
      stopPolling();
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
    };
  }, [load]);

  const latestPassing = useMemo(() => {
    if (!data) return [];
    return data.runs.flatMap((run) => {
      const benchmark = data.benchmarks.find(
        (item) =>
          item.run_id === run.run_id &&
          item.candidate_checkpoint_sha256 === run.checkpoint_sha256 &&
          item.gate_status === "V2_WIN" &&
          (item.evaluation_type ?? "PRODUCTION") === "PRODUCTION",
      );
      return benchmark ? [{ run, benchmark }] : [];
    });
  }, [data]);

  async function decide(input: {
    action: "APPROVE" | "ROLLBACK";
    run_id?: string;
    benchmark_id?: string;
  }) {
    if (!vireadTraining || busy || reason.trim().length < 8) return;
    const actionId = ++actionRequestIdRef.current;
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.decide({ ...input, reason: reason.trim() });
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        input.action === "APPROVE"
          ? t("training.notices.approvedDecision")
          : t("training.notices.rollbackDecision"),
      );
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.decisionFailed"),
      );
    } finally {
      if (mountedRef.current && actionId === actionRequestIdRef.current) {
        setBusy(false);
      }
    }
  }

  async function triggerFlow2() {
    if (!vireadTraining?.triggerFlow2 || busy) return;
    const actionId = ++actionRequestIdRef.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = await vireadTraining.triggerFlow2();
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      if (result.scheduled > 0) {
        setMessage(
          t("training.notices.flow2Scheduled", {
            train: formatNumber(result.train_count ?? 0),
            validation: formatNumber(result.validation_count ?? 0),
          }),
        );
      } else if (result.reason === "UNRESOLVED_TRAINING_JOB_EXISTS") {
        setMessage(t("training.notices.flow2UnresolvedJob"));
      } else if (
        result.reason === "ALREADY_TRAINED_FOR_CURRENT_DATASET_AND_CONFIG"
      ) {
        setMessage(t("training.notices.flow2AlreadyTrained"));
      } else if (result.reason === "TRAIN_AND_VALIDATION_REQUIRED") {
        setMessage(
          t("training.notices.flow2TrainValRequired", {
            train: formatNumber(result.train_count ?? 0),
            validation: formatNumber(result.validation_count ?? 0),
          }),
        );
      } else if (result.reason === "NO_ELIGIBLE_FLOW2_SAMPLES") {
        setMessage(t("training.notices.flow2NoEligibleSamples"));
      } else if (result.reason === "FLOW2_INGESTION_PAUSED") {
        setMessage(t("training.notices.flow2Paused"));
      } else {
        setMessage(t("training.notices.flow2ScheduleBlocked"));
      }
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : t(
              "training.notices.flow2TriggerFailed",
              undefined,
              "Không thể tạo đợt dữ liệu hoặc xếp hàng huấn luyện.",
            ),
      );
    } finally {
      if (mountedRef.current && actionId === actionRequestIdRef.current) {
        setBusy(false);
      }
    }
  }

  async function retry(jobId: string) {
    if (!vireadTraining || busy) return;
    const actionId = ++actionRequestIdRef.current;
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.retry(jobId);
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(t("training.notices.retryJobSuccess"));
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.retryJobFailed"),
      );
    } finally {
      if (mountedRef.current && actionId === actionRequestIdRef.current) {
        setBusy(false);
      }
    }
  }

  async function deleteJob(jobId: string) {
    if (!vireadTraining || busy || deletingJobId) return;
    const actionId = ++actionRequestIdRef.current;
    setDeletingJobId(jobId);
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.deleteJob(jobId);
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(t("training.notices.deleteJobSuccess"));
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.deleteJobFailed"),
      );
    } finally {
      if (mountedRef.current && actionId === actionRequestIdRef.current) {
        setDeletingJobId(null);
        setBusy(false);
      }
    }
  }

  async function evaluateCandidate(
    jobId: string,
    evaluationType: "PILOT" | "PRODUCTION",
  ) {
    if (!vireadTraining || busy) return;
    const actionId = ++actionRequestIdRef.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = await vireadTraining.requestEvaluation(
        jobId,
        evaluationType,
      );
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        t("training.notices.queueEvalSuccess", {
          type: evaluationType === "PILOT" ? "Pilot" : "Production",
          samples: formatNumber(result.sample_count),
          groups: formatNumber(result.group_count),
        }),
      );
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : evaluationType === "PRODUCTION" &&
              !["READY", "READY_TO_CREATE"].includes(
                data?.locked_test?.status ?? "",
              )
            ? t("training.notices.productionInsufficient")
            : t("training.notices.queueEvalFailed"),
      );
    } finally {
      if (mountedRef.current && actionId === actionRequestIdRef.current) {
        setBusy(false);
      }
    }
  }

  async function closeMismatchedCandidate(jobId: string) {
    if (!vireadTraining || busy) return;
    const actionId = ++actionRequestIdRef.current;
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.discardMismatchedCandidate(jobId);
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(t("training.notices.closeDriftSuccess"));
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.closeDriftFailed"),
      );
    } finally {
      if (mountedRef.current && actionId === actionRequestIdRef.current) {
        setBusy(false);
      }
    }
  }

  async function closeUnbenchmarkedCandidate(jobId: string) {
    if (!vireadTraining || busy) return;
    const actionId = ++actionRequestIdRef.current;
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.closeUnbenchmarkedCandidate(jobId);
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(t("training.notices.closeUnbenchmarkedSuccess"));
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.closeUnbenchmarkedFailed"),
      );
    } finally {
      if (mountedRef.current && actionId === actionRequestIdRef.current) {
        setBusy(false);
      }
    }
  }

  async function runPendingConfirm() {
    if (!pendingConfirm) return;
    const action = pendingConfirm;
    setPendingConfirm(null);
    if (action.kind === "delete") {
      await deleteJob(action.jobId);
    } else if (action.kind === "closeMismatched") {
      await closeMismatchedCandidate(action.jobId);
    } else {
      await closeUnbenchmarkedCandidate(action.jobId);
    }
  }

  const totalSamples =
    data?.samples.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const outboxCount = (statuses: string[]) =>
    data?.outbox
      .filter((item) => statuses.includes(item.status))
      .reduce((sum, item) => sum + item.count, 0) ?? 0;
  const outboxPending =
    data?.storage_summary?.outbox_pending !== undefined
      ? data.storage_summary.outbox_pending + data.storage_summary.outbox_retry
      : outboxCount(["PENDING", "PROCESSING", "RETRY"]);
  const outboxErrors =
    data?.storage_summary !== undefined && data.storage_summary !== null
      ? data.storage_summary.outbox_dead + data.storage_summary.outbox_blocked
      : outboxCount(["DEAD", "BLOCKED"]);
  const outboxSkipped =
    data?.storage_summary?.outbox_skipped ?? outboxCount(["SKIPPED"]);
  const sourceCount = (flows: string[], split?: string) =>
    data?.samples
      .filter(
        (item) =>
          flows.includes(item.source_flow) && (!split || item.split === split),
      )
      .reduce((sum, item) => sum + item.count, 0) ?? 0;
  const flow2Train =
    data?.storage_summary?.flow2_train_samples ??
    sourceCount(["FLOW1_VERIFIED"], "train");
  const flow2Validation =
    data?.storage_summary?.flow2_validation_samples ??
    sourceCount(["FLOW1_VERIFIED"], "validation");
  const flow2Holdout =
    data?.storage_summary?.flow2_holdout_samples ??
    sourceCount(["FLOW1_VERIFIED"], "holdout");
  const runtimeModel = data?.runtime_model ?? null;

  const tabs: ReadonlyArray<{
    readonly id: TrainingTabKey;
    readonly label: string;
    readonly icon: typeof Cpu;
    readonly badge?: string;
    readonly alert?: boolean;
  }> = [
    {
      id: "overview",
      label: t("training.tabs.overview", undefined, "Tổng quan & Runtime"),
      icon: Cpu,
      alert: Boolean(runtimeModel && !runtimeModel.matches_desired),
    },
    {
      id: "drive",
      label: t("training.tabs.drive", undefined, "Kho lưu trữ"),
      icon: HardDrive,
      alert: Boolean(
        data?.google_drive &&
        (!data.google_drive.connected ||
          data.google_drive.status === "TOKEN_REVOKED" ||
          data.google_drive.status === "ERROR"),
      ),
    },
    {
      id: "flow1",
      label: t("training.tabs.flow1", undefined, "Cập nhật mô hình"),
      icon: UploadCloud,
    },
    {
      id: "flow2",
      label: t("training.tabs.flow2", undefined, "Huấn luyện & Đánh giá"),
      icon: Layers,
      badge:
        data && data.jobs.length > 0
          ? formatNumber(data.jobs.length)
          : undefined,
    },
  ];

  const flow2Blockers =
    data?.flow2_blockers ?? data?.storage_summary?.flow2_blockers ?? [];
  const safeJobsPage = Math.min(
    Math.max(1, jobsPage),
    Math.max(1, Math.ceil((data?.jobs.length ?? 0) / TRAINING_LIST_PAGE_SIZE)),
  );
  const safeRunsPage = Math.min(
    Math.max(1, runsPage),
    Math.max(1, Math.ceil((data?.runs.length ?? 0) / TRAINING_LIST_PAGE_SIZE)),
  );
  const hasWaitingColabJob = Boolean(
    data?.jobs.some(
      (j) =>
        ["FLOW2_ADMIN_VERIFIED", "FLOW1_VERIFIED"].includes(j.profile) &&
        ["WAITING_FOR_COLAB_WORKER", "FALLBACK_QUEUED_COLAB"].includes(
          j.status,
        ),
    ),
  );

  return (
    <>
      <AdminPageHeader
        eyebrow={t("training.eyebrow")}
        title={t("training.screenTitle")}
        description={t("training.description")}
        actions={
          <Button
            disabled={!data || busy}
            fullWidth={false}
            onClick={() => void load()}
            size="admin"
            variant="outline"
          >
            <RefreshCw aria-hidden className="size-4" />
            {t("training.refresh")}
          </Button>
        }
      />

      {!data && !error ? <AdminLoading /> : null}
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {message ? (
        <p
          aria-live="polite"
          className="mb-4 rounded-xl border border-primary/25 bg-sky px-4 py-3 text-sm font-bold text-primary-hover"
        >
          {message}
        </p>
      ) : null}

      {data ? (
        <div className="space-y-5">
          <div
            aria-label={t(
              "training.tabsAria",
              undefined,
              "Phân khu huấn luyện OCR",
            )}
            className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-surface-subtle/80 p-1.5"
            role="tablist"
          >
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isSelected = activeTab === tab.id;
              return (
                <button
                  aria-controls={`training-tabpanel-${tab.id}`}
                  aria-selected={isSelected}
                  className={cn(
                    "inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-control px-3.5 py-2 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:flex-initial",
                    isSelected
                      ? "bg-white text-primary-hover shadow-2xs ring-1 ring-primary/20"
                      : "text-muted hover:bg-white/60 hover:text-ink",
                  )}
                  id={`training-tab-${tab.id}`}
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  role="tab"
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate">{tab.label}</span>
                  {tab.badge ? (
                    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-sky px-1.5 text-xs font-extrabold text-primary-hover tabular-nums">
                      {tab.badge}
                    </span>
                  ) : null}
                  {tab.alert ? (
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-danger"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          {activeTab === "overview" ? (
            <section
              aria-labelledby="training-tab-overview"
              className="space-y-5"
              id="training-tabpanel-overview"
              role="tabpanel"
            >
              <AdminKpiGrid
                ariaLabel={t(
                  "training.kpiGridAria",
                  undefined,
                  "Chỉ số huấn luyện OCR",
                )}
                columns={3}
              >
                <AdminKpiCard
                  detail={
                    <span className="block text-xs text-muted">
                      {t("training.storagePrefix")}{" "}
                      <strong className="text-ink">
                        {data.active_model?.profile === "ORIGINAL"
                          ? t("training.defaultOriginal")
                          : data.active_model?.storage_provider ===
                              "google_drive"
                            ? t("training.drive.statuses.CONNECTED")
                            : t("training.storageSupabaseLegacy")}
                      </strong>
                    </span>
                  }
                  label={t("training.activeModelHeading")}
                  tone="info"
                  value={
                    <span className="text-lg font-extrabold">
                      {data.active_model
                        ? trainingProfileName(data.active_model.profile, t)
                        : t("training.notInitialized")}
                    </span>
                  }
                />
                <AdminKpiCard
                  detail={
                    data.storage_summary
                      ? t("training.storageBreakdown", {
                          synced: formatNumber(
                            data.storage_summary.flow2_drive_synced_samples,
                          ),
                          pending: formatNumber(
                            data.storage_summary
                              .flow2_pending_verification_samples ?? 0,
                          ),
                          excluded: formatNumber(
                            data.storage_summary.flow2_excluded_samples ?? 0,
                          ),
                          legacy: formatNumber(
                            data.storage_summary.flow2_legacy_samples,
                          ),
                          total: formatNumber(totalSamples),
                        })
                      : t("training.streamsSeparate")
                  }
                  label={t("training.flow2ReadyCardHeading")}
                  value={formatNumber(
                    data.storage_summary?.flow2_verified_total_samples ??
                      totalSamples,
                  )}
                />
                <AdminKpiCard
                  detail={
                    outboxSkipped > 0
                      ? t("training.outboxWithSkipped", {
                          skipped: formatNumber(outboxSkipped),
                        })
                      : t("training.outboxDefault")
                  }
                  label={t("training.outboxHeading")}
                  tone={outboxErrors > 0 ? "danger" : "neutral"}
                  value={
                    <span className="inline-flex flex-wrap items-baseline gap-2">
                      <span>{formatNumber(outboxPending)}</span>
                      {outboxErrors > 0 ? (
                        <span className="text-sm font-extrabold text-danger">
                          {t("training.outboxErrors", {
                            count: formatNumber(outboxErrors),
                          })}
                        </span>
                      ) : null}
                    </span>
                  }
                />
              </AdminKpiGrid>

              {runtimeModel ? (
                <Card
                  className={cn(
                    "border p-5",
                    runtimeModel.matches_desired
                      ? "border-emerald-200 bg-white"
                      : "border-danger/35 bg-danger-surface/60",
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {runtimeModel.matches_desired ? (
                        <CheckCircle2
                          aria-hidden
                          className="size-5 text-emerald-600"
                        />
                      ) : (
                        <AlertTriangle
                          aria-hidden
                          className="size-5 text-danger"
                        />
                      )}
                      <h2 className="text-lg font-extrabold text-ink">
                        {t("training.runtimeHeading")}
                      </h2>
                    </div>
                    <AdminBadge
                      dot
                      tone={runtimeModel.matches_desired ? "success" : "danger"}
                    >
                      {runtimeModel.matches_desired
                        ? "Đang hoạt động đúng cấu hình"
                        : "Đang dùng mô hình dự phòng"}
                    </AdminBadge>
                  </div>
                  <div className="mt-3 grid gap-3 text-xs md:grid-cols-2">
                    <div className="rounded-control border border-border bg-white p-3.5">
                      <p className="font-bold text-muted">
                        {t("training.desiredModelHeading")}
                      </p>
                      <p className="mt-1 text-sm font-extrabold text-ink">
                        {trainingProfileName(runtimeModel.desired_profile, t)}
                      </p>
                    </div>
                    <div className="rounded-control border border-border bg-white p-3.5">
                      <p className="font-bold text-muted">
                        {t("training.loadedModelHeading")}
                      </p>
                      <p className="mt-1 text-sm font-extrabold text-ink">
                        {runtimeModel.initialized && runtimeModel.loaded_profile
                          ? trainingProfileName(runtimeModel.loaded_profile, t)
                          : t("training.notLoadedRam")}
                      </p>
                    </div>
                  </div>
                  {!runtimeModel.matches_desired ? (
                    <p className="mt-3 text-sm font-bold text-danger">
                      {t("training.mismatchWarning")}
                    </p>
                  ) : null}
                </Card>
              ) : null}

              {data.active_model?.comparison_summary ? (
                <AdminVireadReliabilityPanel activeModel={data.active_model} />
              ) : null}
            </section>
          ) : null}

          {activeTab === "drive" ? (
            <section
              aria-labelledby="training-tab-drive"
              id="training-tabpanel-drive"
              role="tabpanel"
            >
              {data.google_drive ? (
                <AdminVireadDrivePanel
                  onUpdated={load}
                  status={data.google_drive}
                />
              ) : (
                <EmptyState
                  description={t(
                    "training.driveUnavailableDesc",
                    undefined,
                    "Hệ thống hiện chưa có thông tin cấu hình kho lưu trữ đám mây.",
                  )}
                  icon={
                    <HardDrive aria-hidden className="size-8 text-primary" />
                  }
                  title={t(
                    "training.driveUnavailableTitle",
                    undefined,
                    "Chưa có cấu hình kho lưu trữ",
                  )}
                />
              )}
            </section>
          ) : null}

          {activeTab === "flow1" ? (
            <section
              aria-labelledby="training-tab-flow1"
              className="space-y-5"
              id="training-tabpanel-flow1"
              role="tabpanel"
            >
              <AdminVireadFlow1Replacement onSuccess={load} />
            </section>
          ) : null}

          {activeTab === "flow2" ? (
            <section
              aria-labelledby="training-tab-flow2"
              className="space-y-5"
              id="training-tabpanel-flow2"
              role="tabpanel"
            >
              <Card className="bg-white p-5">
                <div className="space-y-1">
                  <h2 className="text-lg font-extrabold text-ink">
                    {t("training.flow2Heading")}
                  </h2>
                  <p className="text-sm text-muted">
                    {t("training.readinessSubtitle")}
                  </p>
                </div>

                <div className="mt-3 space-y-2 rounded-xl border border-border bg-surface-subtle/40 p-4">
                  <p className="text-sm font-semibold text-ink tabular-nums">
                    {t("training.flow2CropsPrefix")}{" "}
                    {formatNumber(
                      data.storage_summary?.flow2_verified_total_samples ??
                        sourceCount(["FLOW1_VERIFIED"]),
                    )}{" "}
                    {t("training.sampleUnit")}
                  </p>
                  <p className="text-sm text-muted tabular-nums">
                    {t("training.splitSummary", {
                      train: formatNumber(flow2Train),
                      validation: formatNumber(flow2Validation),
                      holdout: formatNumber(flow2Holdout),
                    })}
                  </p>
                  {data.storage_summary ? (
                    <>
                      <p className="text-xs text-muted tabular-nums">
                        {t("training.flow2DriveReadyPrefix")}{" "}
                        <strong className="text-ink">
                          {formatNumber(
                            data.storage_summary.flow2_drive_synced_samples,
                          )}
                        </strong>
                        {t("training.pendingVerifyPrefix")}
                        {formatNumber(
                          (data.storage_summary
                            .flow2_pending_verification_samples ?? 0) +
                            (data.storage_summary
                              .flow2_parent_candidates_pending ?? 0),
                        )}
                        {t("training.excludedPrefix")}
                        {formatNumber(
                          data.storage_summary.flow2_excluded_samples ?? 0,
                        )}
                        {t("training.legacySupabasePrefix")}
                        {formatNumber(
                          data.storage_summary.flow2_legacy_samples,
                        )}
                      </p>
                      <p className="text-xs text-muted tabular-nums">
                        {t("training.myBooksOptInPrefix")}
                        {formatNumber(
                          data.storage_summary
                            .flow2_parent_candidates_pending ?? 0,
                        )}
                        {t("training.pendingSyncPrefix")}
                        {formatNumber(
                          data.storage_summary
                            .flow2_parent_candidates_sync_queued ?? 0,
                        )}
                        {t("training.syncedPrefix")}
                        {formatNumber(
                          data.storage_summary.flow2_parent_candidates_synced ??
                            0,
                        )}
                      </p>
                    </>
                  ) : null}
                  <p className="text-xs text-muted">
                    {t("training.privacyGateNote")}
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <AdminBadge
                      dot
                      tone={
                        flow2Train > 0 && flow2Validation > 0
                          ? "success"
                          : "warning"
                      }
                    >
                      {flow2Train > 0 && flow2Validation > 0
                        ? t("training.eligibleTrain")
                        : t("training.notEligibleTrain")}
                    </AdminBadge>
                    <AdminBadge
                      dot
                      tone={
                        (data.storage_summary
                          ?.evaluation_ready_for_model_replacement ??
                        data.locked_test?.status === "READY")
                          ? "success"
                          : "neutral"
                      }
                    >
                      {(data.storage_summary
                        ?.evaluation_ready_for_model_replacement ??
                      data.locked_test?.status === "READY")
                        ? t("training.eligibleEval")
                        : t("training.notEligibleEval")}
                    </AdminBadge>
                  </div>
                  {data.worker_status ? (
                    <p className="pt-1 text-xs text-muted">
                      {t(
                        "training.workerExecutionModeLabel",
                        undefined,
                        "Chế độ chạy:",
                      )}{" "}
                      <strong className="text-ink">
                        {data.worker_status.execution_mode === "COLAB"
                          ? "Từ xa"
                          : data.worker_status.execution_mode === "LOCAL"
                            ? "Cục bộ"
                            : "Tự động"}
                      </strong>{" "}
                      ·{" "}
                      {t(
                        "training.workerWebHeavyLabel",
                        undefined,
                        "Tiến trình nền:",
                      )}{" "}
                      <strong className="text-ink">
                        {data.worker_status.web_heavy_workers_disabled
                          ? t(
                              "training.workerWebHeavyDisabled",
                              undefined,
                              "Đang tắt (dùng nút kích hoạt bên dưới)",
                            )
                          : t(
                              "training.workerWebHeavyEnabled",
                              undefined,
                              "Đang bật",
                            )}
                      </strong>
                    </p>
                  ) : null}
                  {flow2Blockers.length > 0 ? (
                    <ul className="list-disc space-y-1 rounded-control border border-amber-200 bg-warning-surface p-3 ps-7 text-xs text-warning">
                      {flow2Blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  ) : null}
                  {vireadTraining?.triggerFlow2 ? (
                    <div className="pt-2">
                      <Button
                        disabled={busy}
                        fullWidth={false}
                        onClick={() => void triggerFlow2()}
                        size="admin"
                        variant="primary"
                      >
                        {t(
                          "training.triggerFlow2Btn",
                          undefined,
                          "Tạo đợt dữ liệu & Xếp hàng huấn luyện",
                        )}
                      </Button>
                    </div>
                  ) : null}
                  {hasWaitingColabJob ? (
                    <div className="mt-3 rounded-control border border-primary/25 bg-sky p-3 text-xs text-ink">
                      <p className="font-bold text-primary-hover">
                        {t(
                          "training.colabGuideTitle",
                          undefined,
                          "Hướng dẫn vận hành hệ thống huấn luyện",
                        )}
                      </p>
                      <p className="mt-1 leading-relaxed">
                        Hệ thống sẽ tự động gửi tác vụ khi kết nối huấn luyện từ
                        xa sẵn sàng. Hãy đảm bảo phiên xử lý đang hoạt động và
                        đã bật khóa bảo mật huấn luyện.
                      </p>
                    </div>
                  ) : null}
                </div>
              </Card>

              <Card className="bg-white p-5">
                <h2 className="text-lg font-extrabold text-ink">
                  {t("training.candidatesHeading")}
                </h2>
                <p className="text-sm text-muted">
                  {t("training.candidatesSubtitle")}
                </p>
                {data.locked_test ? (
                  <div className="rounded-xl border border-border bg-surface-subtle/40 p-4">
                    <p className="text-sm font-extrabold text-ink">
                      {t("training.lockedTestAutoHeading")}
                    </p>
                    {data.locked_test.status === "READY" ? (
                      <p className="mt-1.5 text-sm text-ink tabular-nums">
                        {t("training.lockedTestReady", {
                          samples: formatNumber(data.locked_test.sample_count),
                          groups: formatNumber(data.locked_test.group_count),
                        })}
                      </p>
                    ) : (
                      <p className="mt-1.5 text-sm text-muted tabular-nums">
                        {t("training.lockedTestInsufficient", {
                          samples: formatNumber(
                            data.locked_test.missing_sample_count ??
                              Math.max(
                                0,
                                data.locked_test.minimum_samples -
                                  data.locked_test.eligible_sample_count,
                              ),
                          ),
                          minSamples: formatNumber(
                            data.locked_test.minimum_samples,
                          ),
                          groups: formatNumber(
                            data.locked_test.missing_group_count ??
                              Math.max(
                                0,
                                data.locked_test.minimum_groups -
                                  data.locked_test.eligible_group_count,
                              ),
                          ),
                          minGroups: formatNumber(
                            data.locked_test.minimum_groups,
                          ),
                        })}
                      </p>
                    )}
                  </div>
                ) : null}

                <div className="space-y-3">
                  {data.jobs
                    .slice(
                      (safeJobsPage - 1) * TRAINING_LIST_PAGE_SIZE,
                      safeJobsPage * TRAINING_LIST_PAGE_SIZE,
                    )
                    .map((job) => {
                      const stage = job.progress.stage;
                      const waitingReason = job.metadata.waiting_reason;
                      const localUnavailable = job.metadata.local_unavailable;
                      const workerStatusValue =
                        job.metadata.colab_worker_status;
                      const workerStatus =
                        typeof workerStatusValue === "object" &&
                        workerStatusValue !== null &&
                        !Array.isArray(workerStatusValue)
                          ? (workerStatusValue as Record<string, unknown>)
                          : null;
                      const canDeleteJob = ![
                        ...(data.worker_status?.local_training_enabled === false
                          ? []
                          : ["QUEUED", "LOCAL_RUNNING"]),
                        "FALLBACK_QUEUED_COLAB",
                        "COLAB_RUNNING",
                        "WAITING_FOR_DATA",
                        "WAITING_FOR_COLAB_WORKER",
                        "COLAB_SUBMITTING",
                        "COLAB_SUBMITTED",
                        "COLAB_EXECUTING",
                      ].includes(job.status);

                      return (
                        <article
                          className="rounded-xl border border-border bg-white p-4"
                          key={job.job_id}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-3">
                            <h3 className="text-base font-extrabold text-ink">
                              {job.metadata.operation === "BENCHMARK_ONLY"
                                ? t("training.evalBenchmarkTitle", {
                                    type:
                                      job.metadata.evaluation_type === "PILOT"
                                        ? "Kiểm thử nhanh"
                                        : job.metadata.evaluation_type ===
                                            "PRODUCTION"
                                          ? "Kiểm định chính thức"
                                          : t(
                                              "training.evaluationFallbackType",
                                            ),
                                    status: formatTrainingStatusLabel(
                                      job.status,
                                    ),
                                  })
                                : t("training.profileStatusTitle", {
                                    profile: trainingProfileName(
                                      job.profile,
                                      t,
                                    ),
                                    status: formatTrainingStatusLabel(
                                      job.status,
                                    ),
                                  })}
                            </h3>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-semibold text-muted tabular-nums">
                                {t("training.jobTargetAttempts", {
                                  target:
                                    job.target === "COLAB" ? "Từ xa" : "Cục bộ",
                                  attempts: formatNumber(job.attempts),
                                })}
                              </span>
                              {canDeleteJob ? (
                                <Button
                                  disabled={busy}
                                  fullWidth={false}
                                  onClick={() =>
                                    setPendingConfirm({
                                      kind: "delete",
                                      jobId: job.job_id,
                                      title: t("training.deleteOldJobTitle"),
                                      description: t(
                                        "training.deleteOldJobMessage",
                                      ),
                                      confirmLabel: t(
                                        "training.deleteOldJobConfirm",
                                      ),
                                    })
                                  }
                                  size="admin"
                                  variant="destructive-outline"
                                >
                                  <Trash2 aria-hidden className="size-4" />
                                  {deletingJobId === job.job_id
                                    ? t("training.deletingJob")
                                    : t("training.deleteJobBtn")}
                                </Button>
                              ) : null}
                            </div>
                          </div>

                          <p className="mt-2.5 text-sm text-ink tabular-nums">
                            {t("training.stageLabel")}{" "}
                            {typeof stage === "string"
                              ? formatTrainingStatusLabel(stage)
                              : t("training.stageWaiting")}
                            {typeof job.progress.completed_steps === "number" &&
                            typeof job.progress.total_steps === "number"
                              ? t("training.stepsProgress", {
                                  completed: formatNumber(
                                    job.progress.completed_steps,
                                  ),
                                  total: formatNumber(job.progress.total_steps),
                                })
                              : ""}
                          </p>
                          {job.status === "WAITING_FOR_COLAB_WORKER" ||
                          job.status === "FALLBACK_QUEUED_COLAB" ? (
                            <p className="mt-1 text-sm text-muted">
                              {workerStatus?.status === "READY"
                                ? t("training.workerReady", {
                                    timeSuffix:
                                      typeof workerStatus.reported_at ===
                                      "string"
                                        ? t("training.workerReadyTime", {
                                            time: formatDateTime(
                                              workerStatus.reported_at,
                                            ),
                                          })
                                        : "",
                                  })
                                : workerStatus?.status === "WAITING_FOR_GPU"
                                  ? t("training.workerWaitingGpu", {
                                      reason: t(
                                        "training.workerWaitingGpuFallback",
                                      ),
                                    })
                                  : workerStatus?.status ===
                                      "WAITING_FOR_RESOURCES"
                                    ? t("training.workerWaitingRam", {
                                        reason: t(
                                          "training.workerWaitingRamFallback",
                                        ),
                                      })
                                    : t("training.noColabWorker")}
                            </p>
                          ) : null}
                          {job.status === "COLAB_SUBMITTED" ||
                          job.status === "COLAB_EXECUTING" ? (
                            <p className="mt-1 text-sm text-muted">
                              {job.status === "COLAB_SUBMITTED"
                                ? t("training.colabPending")
                                : t("training.colabRunning")}
                            </p>
                          ) : null}
                          {job.status === "BLOCKED_CONFIGURATION" ? (
                            <p className="mt-1 text-sm text-danger">
                              {t("training.jobNotDispatchedPrefix")}{" "}
                              {t("training.jobNotDispatchedHint")}
                            </p>
                          ) : null}
                          {job.status === "QUALITY_GATE_REJECTED" ? (
                            <p className="mt-1 text-sm text-muted">
                              {t("training.gateFailedNote")}
                            </p>
                          ) : null}
                          {job.target === "COLAB" &&
                          typeof localUnavailable === "string" ? (
                            <p className="mt-1 text-sm text-muted">
                              {t("training.localFallback", {
                                reason: "Hệ thống chuyển sang xử lý từ xa",
                              })}
                            </p>
                          ) : null}
                          {typeof waitingReason === "string" ? (
                            <p className="mt-1 text-sm text-muted">
                              {t("training.waitingData")}
                            </p>
                          ) : null}
                          {job.last_error_code ? (
                            <p className="mt-1 text-sm text-danger">
                              Tác vụ gặp sự cố khi xử lý. Vui lòng kiểm tra cấu
                              hình hoặc thử lại.
                            </p>
                          ) : null}
                          {(job.status === "FAILED" ||
                            (job.status === "BLOCKED" &&
                              ["CREATED", "RUNNING"].includes(
                                job.run_status ?? "",
                              ) &&
                              job.last_error_code ===
                                "COLAB_RETRY_REQUIRES_RUN_RECOVERY")) &&
                          job.target === "COLAB" &&
                          job.attempts < 3 &&
                          (!job.run_id ||
                            (["CREATED", "RUNNING"].includes(
                              job.run_status ?? "",
                            ) &&
                              (job.last_error_code === "HTTPERROR" ||
                                job.last_error_code ===
                                  "COLAB_RETRY_REQUIRES_RUN_RECOVERY"))) &&
                          !job.colab_execution_id &&
                          !job.colab_execution_resource_name &&
                          !job.colab_operation_name ? (
                            <div className="mt-3">
                              <Button
                                disabled={busy}
                                fullWidth={false}
                                onClick={() => void retry(job.job_id)}
                                size="admin"
                                variant="secondary"
                              >
                                {t("training.retryJobBtn")}
                              </Button>
                              <p className="mt-1 text-xs text-muted">
                                {t("training.retryJobHint")}
                              </p>
                            </div>
                          ) : null}
                          {job.status === "BLOCKED" &&
                          job.run_status === "CANDIDATE" &&
                          job.target === "COLAB" &&
                          job.run_config_sha256 === job.config_sha256 &&
                          Boolean(job.locked_test_version_id) &&
                          Boolean(job.locked_test_manifest_sha256) &&
                          job.attempts < 3 &&
                          !job.colab_execution_id &&
                          !job.colab_execution_resource_name &&
                          !job.colab_operation_name &&
                          [
                            "HTTPERROR",
                            "COLAB_FAILURE_REQUIRES_RUN_RECOVERY",
                          ].includes(job.last_error_code ?? "") ? (
                            <div className="mt-3">
                              <Button
                                disabled={busy}
                                fullWidth={false}
                                onClick={() => void retry(job.job_id)}
                                size="admin"
                                variant="secondary"
                              >
                                {t("training.resumeEvalBtn")}
                              </Button>
                              <p className="mt-1 text-xs text-muted">
                                {t("training.resumeEvalHint")}
                              </p>
                            </div>
                          ) : null}
                          {job.status === "CANDIDATE" &&
                          job.run_status === "CANDIDATE" &&
                          job.candidate_has_benchmark === false &&
                          job.run_config_sha256 === job.config_sha256 &&
                          job.worker_id === null ? (
                            <div className="mt-3">
                              <Button
                                disabled={busy}
                                fullWidth={false}
                                onClick={() =>
                                  setPendingConfirm({
                                    kind: "closeUnbenchmarked",
                                    jobId: job.job_id,
                                    title: t(
                                      "training.closeUnbenchmarkedTitle",
                                    ),
                                    description: t(
                                      "training.closeUnbenchmarkedMessage",
                                    ),
                                    confirmLabel: t(
                                      "training.closeCandidateConfirm",
                                    ),
                                  })
                                }
                                size="admin"
                                variant="outline"
                              >
                                {t("training.closeUnbenchmarkedBtn")}
                              </Button>
                              <p className="mt-1 text-xs text-muted">
                                {t("training.closeUnbenchmarkedHint", {
                                  minSamples: formatNumber(
                                    data.locked_test?.minimum_samples ?? 200,
                                  ),
                                  minGroups: formatNumber(
                                    data.locked_test?.minimum_groups ?? 30,
                                  ),
                                })}
                              </p>
                            </div>
                          ) : null}
                          {job.status === "BLOCKED" &&
                          job.run_status === "CANDIDATE" &&
                          job.run_config_sha256 &&
                          job.run_config_sha256 !== job.config_sha256 ? (
                            <div className="mt-3">
                              <Button
                                disabled={busy}
                                fullWidth={false}
                                onClick={() =>
                                  setPendingConfirm({
                                    kind: "closeMismatched",
                                    jobId: job.job_id,
                                    title: t("training.closeConfigDriftTitle"),
                                    description: t(
                                      "training.closeConfigDriftMessage",
                                    ),
                                    confirmLabel: t(
                                      "training.closeCandidateConfirm",
                                    ),
                                  })
                                }
                                size="admin"
                                variant="outline"
                              >
                                {t("training.closeConfigDriftBtn")}
                              </Button>
                              <p className="mt-1 text-xs text-muted">
                                {t("training.closeConfigDriftHint")}
                              </p>
                            </div>
                          ) : null}
                          {job.run_id ? (
                            <>
                              {job.run_status === "CANDIDATE" ||
                              job.run_status === "BENCHMARKED" ? (
                                <div className="mt-3 grid items-stretch gap-3 md:grid-cols-2">
                                  <section className="flex flex-col rounded-control border border-border bg-surface-subtle/30 p-3.5">
                                    <h4 className="text-sm font-bold text-ink">
                                      {t("training.pilotHeading")}
                                    </h4>
                                    <p className="mt-1 text-xs text-muted">
                                      {t("training.pilotDescriptionShort")}
                                    </p>
                                    <div className="mt-auto pt-3">
                                      <Button
                                        disabled={busy}
                                        fullWidth={false}
                                        onClick={() =>
                                          void evaluateCandidate(
                                            job.job_id,
                                            "PILOT",
                                          )
                                        }
                                        size="admin"
                                        variant="secondary"
                                      >
                                        {t("training.runPilotBtn")}
                                      </Button>
                                    </div>
                                  </section>
                                  <section className="flex flex-col rounded-control border border-border bg-surface-subtle/30 p-3.5">
                                    <h4 className="text-sm font-bold text-ink">
                                      {t("training.productionHeading")}
                                    </h4>
                                    <p className="mt-1 text-xs text-muted">
                                      {t("training.productionDescriptionShort")}
                                    </p>
                                    <div className="mt-auto pt-3">
                                      <Button
                                        disabled={
                                          busy ||
                                          ![
                                            "READY",
                                            "READY_TO_CREATE",
                                          ].includes(
                                            data.locked_test?.status ?? "",
                                          )
                                        }
                                        fullWidth={false}
                                        onClick={() =>
                                          void evaluateCandidate(
                                            job.job_id,
                                            "PRODUCTION",
                                          )
                                        }
                                        size="admin"
                                      >
                                        {t("training.runProductionBtn")}
                                      </Button>
                                    </div>
                                  </section>
                                </div>
                              ) : null}
                              {typeof job.metadata.evaluation_status ===
                              "string" ? (
                                <p className="mt-2 text-sm text-muted">
                                  {t("training.evalSummaryLine", {
                                    type:
                                      job.metadata.evaluation_type === "PILOT"
                                        ? "Kiểm thử nhanh"
                                        : job.metadata.evaluation_type ===
                                            "PRODUCTION"
                                          ? "Kiểm định chính thức"
                                          : "Đánh giá",
                                    status: formatTrainingStatusLabel(
                                      String(job.metadata.evaluation_status),
                                    ),
                                  })}
                                  {typeof job.metadata
                                    .evaluation_gate_status === "string"
                                    ? ` · ${formatTrainingStatusLabel(
                                        String(
                                          job.metadata.evaluation_gate_status,
                                        ),
                                      )}`
                                    : ""}
                                </p>
                              ) : null}
                            </>
                          ) : null}
                        </article>
                      );
                    })}
                  {data.jobs.length === 0 ? (
                    <p className="text-sm text-muted">
                      {t("training.noDatasetEligible")}
                    </p>
                  ) : null}
                  <PaginationBar
                    ariaLabel={t("training.jobsPaginationAria")}
                    compact
                    itemLabel={t("training.jobsItemLabel")}
                    onPageChange={setJobsPage}
                    page={safeJobsPage}
                    pageSize={TRAINING_LIST_PAGE_SIZE}
                    total={data.jobs.length}
                  />
                </div>
              </Card>

              <Card className="bg-white p-5">
                <h2 className="text-lg font-extrabold text-ink">
                  {t("training.qualityGateHeading")}
                </h2>
                <p className="text-sm text-muted">
                  {t("training.qualityGateSubtitle", {
                    count: formatNumber(latestPassing.length),
                  })}
                </p>
                <div className="space-y-3">
                  {data.runs
                    .slice(
                      (safeRunsPage - 1) * TRAINING_LIST_PAGE_SIZE,
                      safeRunsPage * TRAINING_LIST_PAGE_SIZE,
                    )
                    .map((run) => {
                      const runBenchmarks = data.benchmarks.filter(
                        (item) => item.run_id === run.run_id,
                      );
                      const benchmark =
                        runBenchmarks.find(
                          (item) =>
                            item.gate_status === "V2_WIN" &&
                            (item.evaluation_type ?? "PRODUCTION") ===
                              "PRODUCTION",
                        ) ?? runBenchmarks[0];
                      return (
                        <article
                          className="rounded-xl border border-border bg-white p-4"
                          key={run.run_id}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-base font-extrabold text-ink">
                              {t("training.profileStatusTitle", {
                                profile: trainingProfileName(run.profile, t),
                                status: formatTrainingStatusLabel(run.status),
                              })}
                            </h3>
                            <span className="text-xs font-semibold text-muted tabular-nums">
                              {t("training.stepCount", {
                                step: formatNumber(run.step),
                              })}
                            </span>
                          </div>
                          <p className="mt-2 text-xs text-muted">
                            {t("training.jobCheckpointPrefix")}:{" "}
                            {run.checkpoint_sha256
                              ? "Đã sẵn sàng"
                              : t("training.notFinished")}
                          </p>
                          <p className="mt-2 text-sm text-ink tabular-nums">
                            {t("training.benchmarkLinePrefix")}{" "}
                            {benchmark
                              ? t("training.benchmarkGateLine", {
                                  gateStatus: formatTrainingStatusLabel(
                                    benchmark.gate_status,
                                  ),
                                  samples: formatNumber(benchmark.sample_count),
                                  groups: formatNumber(benchmark.group_count),
                                })
                              : t("training.benchmarkNotYet")}
                          </p>
                          {benchmark?.gate_status === "V2_WIN" &&
                          (benchmark.evaluation_type ?? "PRODUCTION") ===
                            "PRODUCTION" ? (
                            <div className="mt-3">
                              <Button
                                disabled={
                                  busy ||
                                  reason.trim().length < 8 ||
                                  !run.checkpoint_sha256 ||
                                  data.active_model?.checkpoint_sha256 ===
                                    run.checkpoint_sha256 ||
                                  data.active_model?.checkpoint_sha256 !==
                                    run.parent_checkpoint_sha256
                                }
                                fullWidth={false}
                                onClick={() =>
                                  void decide({
                                    action: "APPROVE",
                                    run_id: run.run_id,
                                    benchmark_id: benchmark.benchmark_id,
                                  })
                                }
                                size="admin"
                              >
                                {t("training.approveModelBtn")}
                              </Button>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  {data.runs.length === 0 ? (
                    <p className="text-sm text-muted">
                      {t("training.noRunsYet")}
                    </p>
                  ) : null}
                  <PaginationBar
                    ariaLabel={t("training.runsPaginationAria")}
                    compact
                    itemLabel={t("training.runsItemLabel")}
                    onPageChange={setRunsPage}
                    page={safeRunsPage}
                    pageSize={TRAINING_LIST_PAGE_SIZE}
                    total={data.runs.length}
                  />
                </div>
              </Card>

              <Card className="bg-white p-5">
                <h2 className="text-lg font-extrabold text-ink">
                  {t("training.approvalHeading")}
                </h2>
                <label
                  className="block text-sm font-bold text-ink"
                  htmlFor="viread-decision-reason"
                >
                  {t("training.approvalReasonLabel")}
                </label>
                <textarea
                  className="min-h-24 w-full rounded-control border border-border bg-white p-3 text-sm text-ink focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  id="viread-decision-reason"
                  maxLength={1000}
                  minLength={8}
                  onChange={(event) => setReason(event.target.value)}
                  value={reason}
                />
                <p className="text-sm text-muted">
                  {t("training.approvalNote")}
                </p>
                {data.active_model &&
                data.active_model.profile !== "ORIGINAL" ? (
                  <div>
                    <Button
                      disabled={busy || reason.trim().length < 8}
                      fullWidth={false}
                      onClick={() => void decide({ action: "ROLLBACK" })}
                      size="admin"
                      variant="outline"
                    >
                      {t("training.rollbackBtn")}
                    </Button>
                  </div>
                ) : null}
              </Card>
            </section>
          ) : null}
        </div>
      ) : null}

      <Modal
        closeOnBackdropClick={!busy}
        closeOnEscape={!busy}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={busy}
              fullWidth={false}
              onClick={() => setPendingConfirm(null)}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={busy}
              fullWidth={false}
              isLoading={busy}
              onClick={() => void runPendingConfirm()}
              size="admin"
              type="button"
              variant={
                pendingConfirm?.kind === "delete" ? "destructive" : "primary"
              }
            >
              {pendingConfirm?.confirmLabel ?? t("common.confirm")}
            </Button>
          </div>
        }
        isOpen={pendingConfirm !== null}
        onClose={() => {
          if (!busy) setPendingConfirm(null);
        }}
        role="alertdialog"
        showCloseButton={!busy}
        title={pendingConfirm?.title ?? t("training.defaultConfirmTitle")}
        tone="paper"
      >
        <p className="text-sm leading-relaxed text-ink">
          {pendingConfirm?.description}
        </p>
      </Modal>
    </>
  );
}
