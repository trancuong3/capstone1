"use client";

import { AlertTriangle, CheckCircle2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { AdminVireadDrivePanel } from "@/components/admin/admin-viread-drive-panel";
import {
  AdminVireadFlow1Replacement,
  AdminVireadReliabilityPanel,
} from "@/components/admin/admin-viread-flow1-replacement";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Modal } from "@/components/common/modal";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { TranslateFn } from "@/lib/i18n/types";
import type { VireadTrainingOverview } from "@/lib/api/viread-training-service";

function hash(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
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

  const load = useCallback(async () => {
    setError(null);
    if (!vireadTraining) {
      setError("Dịch vụ quản trị huấn luyện VietOCR chưa sẵn sàng.");
      return;
    }
    try {
      setData(await vireadTraining.overview());
    } catch (err) {
      setError(
        isServiceError(err)
          ? err.message
          : "Chưa thể tải trạng thái huấn luyện. Kiểm tra quyền Admin và migration VietOCR V2.",
      );
    }
  }, [vireadTraining]);

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
        setMessage(
          t("training.notices.driveConnected", {
            account:
              connected.account_email ??
              t("training.notices.defaultVerifiedAccount"),
          }),
        );
        await load();
      } catch (err) {
        setMessage(
          isServiceError(err)
            ? err.message
            : t("training.notices.oauthExchangeFailed"),
        );
      } finally {
        window.history.replaceState({}, document.title, cleanUrl);
        setBusy(false);
      }
    })();
  }, [load, vireadTraining, t]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    const interval = globalThis.setInterval(() => void load(), 30_000);
    return () => {
      globalThis.clearTimeout(timeout);
      globalThis.clearInterval(interval);
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
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.decide({ ...input, reason: reason.trim() });
      setMessage(
        input.action === "APPROVE"
          ? t("training.notices.approvedDecision")
          : t("training.notices.rollbackDecision"),
      );
      await load();
    } catch (err) {
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.decisionFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function triggerFlow2() {
    if (!vireadTraining?.triggerFlow2 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await vireadTraining.triggerFlow2();
      if (result.scheduled > 0) {
        setMessage(
          `Đã tạo snapshot Luồng 2 (${result.train_count ?? 0} train / ${result.validation_count ?? 0} validation) và xếp hàng job ${result.job_id ?? ""} (${result.status ?? "WAITING_FOR_COLAB_WORKER"}).`,
        );
      } else if (result.reason === "UNRESOLVED_TRAINING_JOB_EXISTS") {
        setMessage(
          "Đang có job huấn luyện chưa kết thúc trong hàng đợi; chưa tạo thêm job mới.",
        );
      } else if (
        result.reason === "ALREADY_TRAINED_FOR_CURRENT_DATASET_AND_CONFIG"
      ) {
        setMessage(
          "Dataset và cấu hình Luồng 2 hiện tại đã có kết quả train trước đó. Thêm mẫu VERIFIED mới hoặc đánh giá candidate hiện có.",
        );
      } else if (result.reason === "TRAIN_AND_VALIDATION_REQUIRED") {
        setMessage(
          `Snapshot hiện có ${result.train_count ?? 0} train và ${result.validation_count ?? 0} validation; cần cả 2 tập mới có thể xếp hàng Colab.`,
        );
      } else if (result.reason === "NO_ELIGIBLE_FLOW2_SAMPLES") {
        setMessage("Chưa có mẫu Luồng 2 sạch nào đủ điều kiện tạo snapshot.");
      } else if (result.reason === "FLOW2_INGESTION_PAUSED") {
        setMessage(
          "Luồng 2 đang tạm dừng (VIREAD_FLOW2_INGESTION_PAUSED=true).",
        );
      } else {
        setMessage(`Không thể xếp hàng Luồng 2 (${result.reason}).`);
      }
      await load();
    } catch (err) {
      setMessage(
        isServiceError(err)
          ? err.message
          : "Không thể tạo snapshot hoặc xếp hàng train Luồng 2.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function retry(jobId: string) {
    if (!vireadTraining || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.retry(jobId);
      setMessage(t("training.notices.retryJobSuccess"));
      await load();
    } catch (err) {
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.retryJobFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteJob(jobId: string) {
    if (!vireadTraining || busy || deletingJobId) return;
    setDeletingJobId(jobId);
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.deleteJob(jobId);
      setMessage(t("training.notices.deleteJobSuccess"));
      await load();
    } catch (err) {
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.deleteJobFailed"),
      );
    } finally {
      setDeletingJobId(null);
      setBusy(false);
    }
  }

  async function evaluateCandidate(
    jobId: string,
    evaluationType: "PILOT" | "PRODUCTION",
  ) {
    if (!vireadTraining || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await vireadTraining.requestEvaluation(
        jobId,
        evaluationType,
      );
      setMessage(
        t("training.notices.queueEvalSuccess", {
          type: evaluationType === "PILOT" ? "Pilot" : "Production",
          samples: formatNumber(result.sample_count),
          groups: formatNumber(result.group_count),
        }),
      );
      await load();
    } catch (err) {
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
      setBusy(false);
    }
  }

  async function closeMismatchedCandidate(jobId: string) {
    if (!vireadTraining || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.discardMismatchedCandidate(jobId);
      setMessage(t("training.notices.closeDriftSuccess"));
      await load();
    } catch (err) {
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.closeDriftFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function closeUnbenchmarkedCandidate(jobId: string) {
    if (!vireadTraining || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.closeUnbenchmarkedCandidate(jobId);
      setMessage(t("training.notices.closeUnbenchmarkedSuccess"));
      await load();
    } catch (err) {
      setMessage(
        isServiceError(err)
          ? err.message
          : t("training.notices.closeUnbenchmarkedFailed"),
      );
    } finally {
      setBusy(false);
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
  return (
    <>
      <AdminPageHeader
        eyebrow={t("training.eyebrow")}
        title={t("training.screenTitle")}
        description={t("training.description")}
        actions={
          <Button
            className="sm:w-auto"
            disabled={!data || busy}
            onClick={() => void load()}
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-5" /> {t("training.refresh")}
          </Button>
        }
      />

      {!data && !error ? <AdminLoading /> : null}
      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {message ? (
        <p
          aria-live="polite"
          className="mb-4 rounded-control bg-sky p-4 font-bold text-primary-hover"
        >
          {message}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="mb-6 grid gap-4 md:grid-cols-3">
            <Card className="bg-white">
              <p className="font-bold text-muted">
                {t("training.activeModelHeading")}
              </p>
              <h2 className="mt-2 text-xl font-black">
                {data.active_model
                  ? trainingProfileName(data.active_model.profile, t)
                  : t("training.notInitialized")}
              </h2>
              <p className="mt-2 break-all font-mono text-xs text-muted">
                {data.active_model
                  ? hash(data.active_model.checkpoint_sha256)
                  : t("common.emptyDash")}
              </p>
              <p className="mt-1 text-xs text-muted">
                {t("training.storagePrefix")}{" "}
                <strong>
                  {data.active_model?.profile === "ORIGINAL"
                    ? t("training.defaultOriginal")
                    : data.active_model?.storage_provider === "google_drive"
                      ? t("training.drive.statuses.CONNECTED")
                      : t("training.storageSupabaseLegacy")}
                </strong>
              </p>
            </Card>
            <Card className="bg-white">
              <p className="font-bold text-muted">
                {t("training.flow2ReadyCardHeading")}
              </p>
              <h2 className="mt-2 text-3xl font-black">
                {formatNumber(
                  data.storage_summary?.flow2_verified_total_samples ??
                    totalSamples,
                )}
              </h2>
              <p className="mt-2 text-xs text-muted">
                {data.storage_summary
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
                  : t("training.streamsSeparate")}
              </p>
            </Card>
            <Card className="bg-white">
              <p className="font-bold text-muted">
                {t("training.outboxHeading")}
              </p>
              <h2 className="mt-2 text-3xl font-black">
                {formatNumber(outboxPending)}
                {outboxErrors > 0 ? (
                  <span className="ms-2 text-base font-extrabold text-danger">
                    {t("training.outboxErrors", {
                      count: formatNumber(outboxErrors),
                    })}
                  </span>
                ) : null}
              </h2>
              <p className="mt-2 text-sm text-muted">
                {outboxSkipped > 0
                  ? t("training.outboxWithSkipped", {
                      skipped: formatNumber(outboxSkipped),
                    })
                  : t("training.outboxDefault")}
              </p>
            </Card>
          </div>

          {runtimeModel ? (
            <Card
              className={`mb-6 border ${
                runtimeModel.matches_desired
                  ? "border-emerald-200 bg-white"
                  : "border-rose-300 bg-rose-50"
              }`}
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
                      className="size-5 text-rose-600"
                    />
                  )}
                  <h2 className="text-lg font-black">
                    {t("training.runtimeHeading")}
                  </h2>
                </div>
                <span className="font-mono text-xs font-bold">
                  {runtimeModel.status_label}
                </span>
              </div>
              <div className="mt-3 grid gap-3 text-xs md:grid-cols-2">
                <div className="rounded-control border border-border bg-white p-3">
                  <p className="font-bold text-muted">
                    {t("training.desiredModelHeading")}
                  </p>
                  <p className="mt-1 font-extrabold">
                    {trainingProfileName(runtimeModel.desired_profile, t)}
                  </p>
                  <p className="mt-1 break-all font-mono text-muted">
                    SHA-256: {hash(runtimeModel.desired_checkpoint_sha256)}
                  </p>
                </div>
                <div className="rounded-control border border-border bg-white p-3">
                  <p className="font-bold text-muted">
                    {t("training.loadedModelHeading")}
                  </p>
                  <p className="mt-1 font-extrabold">
                    {runtimeModel.initialized && runtimeModel.loaded_profile
                      ? trainingProfileName(runtimeModel.loaded_profile, t)
                      : t("training.notLoadedRam")}
                  </p>
                  <p className="mt-1 break-all font-mono text-muted">
                    SHA-256:{" "}
                    {runtimeModel.loaded_checkpoint_sha256
                      ? hash(runtimeModel.loaded_checkpoint_sha256)
                      : t("common.emptyDash")}
                  </p>
                </div>
              </div>
              {!runtimeModel.matches_desired ? (
                <p className="mt-3 text-sm font-bold text-rose-900">
                  {t("training.mismatchWarning")}
                </p>
              ) : null}
            </Card>
          ) : null}

          {data.google_drive ? (
            <AdminVireadDrivePanel
              onUpdated={load}
              status={data.google_drive}
            />
          ) : null}

          {data.active_model?.comparison_summary ? (
            <AdminVireadReliabilityPanel activeModel={data.active_model} />
          ) : null}

          <Card className="mb-6 bg-white">
            <h2 className="text-xl font-black">
              {t("training.readinessHeading")}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {t("training.readinessSubtitle")}
            </p>
            <ul className="mt-4 grid gap-3 md:grid-cols-2">
              <li className="list-none">
                <AdminVireadFlow1Replacement onSuccess={load} />
              </li>
              <li className="rounded-control border border-border p-4">
                <p className="font-extrabold">{t("training.flow2Heading")}</p>
                <p className="mt-2 text-sm">
                  {t("training.flow2CropsPrefix")}{" "}
                  {formatNumber(
                    data.storage_summary?.flow2_verified_total_samples ??
                      sourceCount(["FLOW1_VERIFIED"]),
                  )}{" "}
                  {t("training.sampleUnit")}
                </p>
                <p className="mt-1 text-sm text-muted">
                  {t("training.splitSummary", {
                    train: formatNumber(flow2Train),
                    validation: formatNumber(flow2Validation),
                    holdout: formatNumber(flow2Holdout),
                  })}
                </p>
                {data.storage_summary ? (
                  <>
                    <p className="mt-1 text-xs text-muted">
                      {t("training.flow2DriveReadyPrefix")}{" "}
                      <strong>
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
                      {formatNumber(data.storage_summary.flow2_legacy_samples)}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {t("training.myBooksOptInPrefix")}
                      {formatNumber(
                        data.storage_summary.flow2_parent_candidates_pending ??
                          0,
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
                <p className="mt-1 text-xs text-muted">
                  {t("training.privacyGateNote")}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold">
                  <span
                    className={`rounded-full border px-2.5 py-0.5 ${
                      flow2Train > 0 && flow2Validation > 0
                        ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                        : "border-amber-300 bg-amber-50 text-amber-900"
                    }`}
                  >
                    {flow2Train > 0 && flow2Validation > 0
                      ? t("training.eligibleTrain")
                      : t("training.notEligibleTrain")}
                  </span>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 ${
                      (data.storage_summary
                        ?.evaluation_ready_for_model_replacement ??
                      data.locked_test?.status === "READY")
                        ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                        : "border-slate-300 bg-slate-100 text-slate-800"
                    }`}
                  >
                    {(data.storage_summary
                      ?.evaluation_ready_for_model_replacement ??
                    data.locked_test?.status === "READY")
                      ? t("training.eligibleEval")
                      : t("training.notEligibleEval")}
                  </span>
                </div>
                {data.worker_status ? (
                  <p className="mt-2 text-xs text-muted">
                    Chế độ chạy:{" "}
                    <strong>{data.worker_status.execution_mode}</strong> ·
                    Worker nền Web:{" "}
                    <strong>
                      {data.worker_status.web_heavy_workers_disabled
                        ? "Đang tắt (dùng nút kích hoạt bên dưới)"
                        : "Đang bật"}
                    </strong>
                  </p>
                ) : null}
                {(() => {
                  const blockers =
                    data.flow2_blockers ??
                    data.storage_summary?.flow2_blockers ??
                    [];
                  return blockers.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 rounded-control border border-amber-300 bg-amber-50 p-3 pl-7 text-xs text-amber-950">
                      {blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  ) : null;
                })()}
                {vireadTraining?.triggerFlow2 ? (
                  <div className="mt-3">
                    <Button
                      className="h-11 w-auto"
                      disabled={busy}
                      onClick={() => void triggerFlow2()}
                      variant="primary"
                    >
                      Tạo snapshot & Xếp hàng train Luồng 2
                    </Button>
                  </div>
                ) : null}
                {data.jobs.some(
                  (j) =>
                    ["FLOW2_ADMIN_VERIFIED", "FLOW1_VERIFIED"].includes(
                      j.profile,
                    ) &&
                    [
                      "WAITING_FOR_COLAB_WORKER",
                      "FALLBACK_QUEUED_COLAB",
                    ].includes(j.status),
                ) ? (
                  <div className="mt-3 rounded-control border border-sky-300 bg-sky p-3 text-xs text-slate-900">
                    <p className="font-bold">
                      Hướng dẫn chạy Colab Free GPU T4 (0 VNĐ)
                    </p>
                    <p className="mt-1">
                      Mở notebook{" "}
                      <code className="font-mono">
                        ai/vietocr_v2/viread_vietocr_v2_colab_worker.ipynb
                      </code>
                      , chọn Runtime{" "}
                      <strong>Change runtime type → T4 GPU</strong>, bật 2 Colab
                      Secrets <code className="font-mono">VIREAD_API_BASE</code>{" "}
                      và{" "}
                      <code className="font-mono">
                        VIREAD_TRAINING_WORKER_TOKEN
                      </code>
                      , rồi bấm <strong>Runtime → Run all</strong>.
                    </p>
                  </div>
                ) : null}
              </li>
            </ul>
          </Card>

          <Card className="mb-6 bg-white">
            <h2 className="text-xl font-black">
              {t("training.candidatesHeading")}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {t("training.candidatesSubtitle")}
            </p>
            {data.locked_test ? (
              <div className="mt-4 rounded-control border border-border p-4">
                <p className="font-extrabold">
                  {t("training.lockedTestAutoHeading")}
                </p>
                {data.locked_test.status === "READY" ? (
                  <>
                    <p className="mt-2 text-sm">
                      {t("training.lockedTestReady", {
                        samples: formatNumber(data.locked_test.sample_count),
                        groups: formatNumber(data.locked_test.group_count),
                      })}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-muted">
                      Manifest{" "}
                      {data.locked_test.manifest_sha256
                        ? hash(data.locked_test.manifest_sha256)
                        : t("common.emptyDash")}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-muted">
                    {t("training.lockedTestInsufficient", {
                      samples: formatNumber(
                        data.locked_test.missing_sample_count ??
                          Math.max(
                            0,
                            data.locked_test.minimum_samples -
                              data.locked_test.eligible_sample_count,
                          ),
                      ),
                      groups: formatNumber(
                        data.locked_test.missing_group_count ??
                          Math.max(
                            0,
                            data.locked_test.minimum_groups -
                              data.locked_test.eligible_group_count,
                          ),
                      ),
                    })}
                  </p>
                )}
              </div>
            ) : null}
            <div className="mt-4 space-y-3">
              {data.jobs
                .slice(
                  (Math.min(
                    jobsPage,
                    Math.max(
                      1,
                      Math.ceil(data.jobs.length / TRAINING_LIST_PAGE_SIZE),
                    ),
                  ) -
                    1) *
                    TRAINING_LIST_PAGE_SIZE,
                  Math.min(
                    jobsPage,
                    Math.max(
                      1,
                      Math.ceil(data.jobs.length / TRAINING_LIST_PAGE_SIZE),
                    ),
                  ) * TRAINING_LIST_PAGE_SIZE,
                )
                .map((job) => {
                  const stage = job.progress.stage;
                  const waitingReason = job.metadata.waiting_reason;
                  const localUnavailable = job.metadata.local_unavailable;
                  const workerStatusValue = job.metadata.colab_worker_status;
                  const workerStatus =
                    typeof workerStatusValue === "object" &&
                    workerStatusValue !== null &&
                    !Array.isArray(workerStatusValue)
                      ? (workerStatusValue as Record<string, unknown>)
                      : null;
                  return (
                    <article
                      className="rounded-control border border-border p-4"
                      key={job.job_id}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-extrabold">
                          {job.metadata.operation === "BENCHMARK_ONLY"
                            ? t("training.evalBenchmarkTitle", {
                                type: String(
                                  job.metadata.evaluation_type ??
                                    t("training.evaluationFallbackType"),
                                ),
                                status: job.status,
                              })
                            : t("training.profileStatusTitle", {
                                profile: trainingProfileName(job.profile, t),
                                status: job.status,
                              })}
                        </h3>
                        <span className="text-sm text-muted">
                          {t("training.jobTargetAttempts", {
                            target: job.target,
                            attempts: formatNumber(job.attempts),
                          })}
                        </span>
                      </div>
                      {[
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
                      ].includes(job.status) ? null : (
                        <Button
                          className="mt-3 h-11 w-auto"
                          disabled={busy}
                          onClick={() =>
                            setPendingConfirm({
                              kind: "delete",
                              jobId: job.job_id,
                              title: t("training.deleteOldJobTitle"),
                              description: t("training.deleteOldJobMessage"),
                              confirmLabel: t("training.deleteOldJobConfirm"),
                            })
                          }
                          variant="destructive"
                        >
                          <Trash2 aria-hidden className="size-4" />
                          {deletingJobId === job.job_id
                            ? t("training.deletingJob")
                            : t("training.deleteJobBtn")}
                        </Button>
                      )}
                      <p className="mt-2 break-all font-mono text-xs text-muted">
                        {t("training.jobIdManifest", {
                          jobId: job.job_id,
                          manifest: hash(job.manifest_sha256),
                        })}
                      </p>
                      <p className="mt-1 text-sm">
                        {t("training.stageLabel")}{" "}
                        {typeof stage === "string"
                          ? stage
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
                                  typeof workerStatus.reported_at === "string"
                                    ? t("training.workerReadyTime", {
                                        time: formatDateTime(
                                          workerStatus.reported_at,
                                        ),
                                      })
                                    : "",
                              })
                            : workerStatus?.status === "WAITING_FOR_GPU"
                              ? t("training.workerWaitingGpu", {
                                  reason:
                                    typeof workerStatus.reason_code === "string"
                                      ? workerStatus.reason_code
                                      : t("training.workerWaitingGpuFallback"),
                                })
                              : workerStatus?.status === "WAITING_FOR_RESOURCES"
                                ? t("training.workerWaitingRam", {
                                    reason:
                                      typeof workerStatus.reason_code ===
                                      "string"
                                        ? workerStatus.reason_code
                                        : t(
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
                          {job.last_error_code ??
                            t("training.notConfiguredFallback")}
                          . {t("training.jobNotDispatchedHint")}
                        </p>
                      ) : null}
                      {job.colab_execution_resource_name ? (
                        <p className="mt-1 break-all font-mono text-xs text-muted">
                          {t("training.jobExecutionPrefix", {
                            id: job.colab_execution_resource_name,
                          })}
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
                            reason: localUnavailable,
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
                          {t("training.errorCodeLine", {
                            code: job.last_error_code,
                          })}
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
                            onClick={() => void retry(job.job_id)}
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
                            onClick={() => void retry(job.job_id)}
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
                            onClick={() =>
                              setPendingConfirm({
                                kind: "closeUnbenchmarked",
                                jobId: job.job_id,
                                title: t("training.closeUnbenchmarkedTitle"),
                                description: t(
                                  "training.closeUnbenchmarkedMessage",
                                ),
                                confirmLabel: t(
                                  "training.closeCandidateConfirm",
                                ),
                              })
                            }
                            variant="secondary"
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
                            variant="secondary"
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
                          <p className="mt-1 break-all font-mono text-xs text-muted">
                            {t("training.jobRunPrefix", { id: job.run_id })}
                          </p>
                          {job.run_status === "CANDIDATE" ||
                          job.run_status === "BENCHMARKED" ? (
                            <div className="mt-3 grid gap-3 md:grid-cols-2">
                              <section className="rounded-control border border-border p-3">
                                <h4 className="font-bold">
                                  {t("training.pilotHeading")}
                                </h4>
                                <p className="mt-1 text-xs text-muted">
                                  {t("training.pilotDescriptionShort")}
                                </p>
                                <Button
                                  className="mt-2 h-11 w-auto"
                                  disabled={busy}
                                  onClick={() =>
                                    void evaluateCandidate(job.job_id, "PILOT")
                                  }
                                  variant="secondary"
                                >
                                  {t("training.runPilotBtn")}
                                </Button>
                              </section>
                              <section className="rounded-control border border-border p-3">
                                <h4 className="font-bold">
                                  {t("training.productionHeading")}
                                </h4>
                                <p className="mt-1 text-xs text-muted">
                                  {t("training.productionDescriptionShort")}
                                </p>
                                <Button
                                  className="mt-2 h-11 w-auto"
                                  disabled={
                                    busy ||
                                    !["READY", "READY_TO_CREATE"].includes(
                                      data.locked_test?.status ?? "",
                                    )
                                  }
                                  onClick={() =>
                                    void evaluateCandidate(
                                      job.job_id,
                                      "PRODUCTION",
                                    )
                                  }
                                >
                                  {t("training.runProductionBtn")}
                                </Button>
                              </section>
                            </div>
                          ) : null}
                          {typeof job.metadata.evaluation_status ===
                          "string" ? (
                            <p className="mt-2 text-sm text-muted">
                              {t("training.evalSummaryLine", {
                                type: String(
                                  job.metadata.evaluation_type ?? "",
                                ),
                                status: String(job.metadata.evaluation_status),
                              })}
                              {typeof job.metadata.evaluation_gate_status ===
                              "string"
                                ? ` · ${String(job.metadata.evaluation_gate_status)}`
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
                page={jobsPage}
                pageSize={TRAINING_LIST_PAGE_SIZE}
                total={data.jobs.length}
              />
            </div>
          </Card>

          <Card className="mb-6 bg-white">
            <h2 className="text-xl font-black">
              {t("training.qualityGateHeading")}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {t("training.qualityGateSubtitle", {
                count: formatNumber(latestPassing.length),
              })}
            </p>
            <div className="mt-4 space-y-3">
              {data.runs
                .slice(
                  (Math.min(
                    runsPage,
                    Math.max(
                      1,
                      Math.ceil(data.runs.length / TRAINING_LIST_PAGE_SIZE),
                    ),
                  ) -
                    1) *
                    TRAINING_LIST_PAGE_SIZE,
                  Math.min(
                    runsPage,
                    Math.max(
                      1,
                      Math.ceil(data.runs.length / TRAINING_LIST_PAGE_SIZE),
                    ),
                  ) * TRAINING_LIST_PAGE_SIZE,
                )
                .map((run) => {
                  const runBenchmarks = data.benchmarks.filter(
                    (item) => item.run_id === run.run_id,
                  );
                  const benchmark =
                    runBenchmarks.find(
                      (item) =>
                        item.gate_status === "V2_WIN" &&
                        (item.evaluation_type ?? "PRODUCTION") === "PRODUCTION",
                    ) ?? runBenchmarks[0];
                  return (
                    <article
                      className="rounded-control border border-border p-4"
                      key={run.run_id}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-extrabold">
                          {t("training.profileStatusTitle", {
                            profile: trainingProfileName(run.profile, t),
                            status: run.status,
                          })}
                        </h3>
                        <span className="text-sm text-muted">
                          {t("training.stepCount", {
                            step: formatNumber(run.step),
                          })}
                        </span>
                      </div>
                      <p className="mt-2 break-all font-mono text-xs text-muted">
                        {t("training.jobRunPrefix", { id: run.run_id })}
                      </p>
                      <p className="mt-1 break-all font-mono text-xs text-muted">
                        {t("training.jobCheckpointPrefix")}{" "}
                        {run.checkpoint_sha256
                          ? hash(run.checkpoint_sha256)
                          : t("training.notFinished")}
                      </p>
                      <p className="mt-2 text-sm">
                        {t("training.benchmarkLinePrefix")}{" "}
                        {benchmark
                          ? t("training.benchmarkGateLine", {
                              gateStatus: benchmark.gate_status,
                              samples: formatNumber(benchmark.sample_count),
                              groups: formatNumber(benchmark.group_count),
                            })
                          : t("training.benchmarkNotYet")}
                      </p>
                      {benchmark?.gate_status === "V2_WIN" &&
                      (benchmark.evaluation_type ?? "PRODUCTION") ===
                        "PRODUCTION" ? (
                        <Button
                          className="mt-3 h-12 w-auto"
                          disabled={
                            busy ||
                            reason.trim().length < 8 ||
                            !run.checkpoint_sha256 ||
                            data.active_model?.checkpoint_sha256 ===
                              run.checkpoint_sha256 ||
                            data.active_model?.checkpoint_sha256 !==
                              run.parent_checkpoint_sha256
                          }
                          onClick={() =>
                            void decide({
                              action: "APPROVE",
                              run_id: run.run_id,
                              benchmark_id: benchmark.benchmark_id,
                            })
                          }
                        >
                          {t("training.approveModelBtn")}
                        </Button>
                      ) : null}
                    </article>
                  );
                })}
              {data.runs.length === 0 ? (
                <p className="text-muted">{t("training.noRunsYet")}</p>
              ) : null}
              <PaginationBar
                ariaLabel={t("training.runsPaginationAria")}
                compact
                itemLabel={t("training.runsItemLabel")}
                onPageChange={setRunsPage}
                page={runsPage}
                pageSize={TRAINING_LIST_PAGE_SIZE}
                total={data.runs.length}
              />
            </div>
          </Card>

          <Card className="bg-white">
            <h2 className="text-xl font-black">
              {t("training.approvalHeading")}
            </h2>
            <label
              className="mt-4 block font-bold"
              htmlFor="viread-decision-reason"
            >
              {t("training.approvalReasonLabel")}
            </label>
            <textarea
              className="mt-2 min-h-24 w-full rounded-control border border-border p-3 focus-visible:outline-3 focus-visible:outline-primary"
              id="viread-decision-reason"
              maxLength={1000}
              minLength={8}
              onChange={(event) => setReason(event.target.value)}
              value={reason}
            />
            <p className="mt-2 text-sm text-muted">
              {t("training.approvalNote")}
            </p>
            {data.active_model && data.active_model.profile !== "ORIGINAL" ? (
              <Button
                className="mt-4 h-12 w-auto"
                disabled={busy || reason.trim().length < 8}
                onClick={() => void decide({ action: "ROLLBACK" })}
                variant="secondary"
              >
                {t("training.rollbackBtn")}
              </Button>
            ) : null}
          </Card>
        </>
      ) : null}
      <Modal
        closeOnBackdropClick={!busy}
        closeOnEscape={!busy}
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              disabled={busy}
              fullWidth={false}
              onClick={() => setPendingConfirm(null)}
              type="button"
              variant="secondary"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={busy}
              fullWidth={false}
              isLoading={busy}
              onClick={() => void runPendingConfirm()}
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
        <p className="text-body text-ink">{pendingConfirm?.description}</p>
      </Modal>
    </>
  );
}
