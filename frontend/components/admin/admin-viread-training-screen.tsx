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
import { isServiceError } from "@/lib/api/service-error";
import type { VireadTrainingOverview } from "@/lib/api/viread-training-service";

function hash(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function trainingProfileName(profile: string) {
  if (profile === "FLOW1_EXTERNAL_TRDG" || profile === "FLOW2_EXTERNAL_TRDG") {
    return "Luồng 1 · ảnh thực tế + TRDG";
  }
  if (profile === "FLOW2_ADMIN_VERIFIED" || profile === "FLOW1_VERIFIED") {
    return "Luồng 2 · Admin xác nhận";
  }
  return profile;
}

export function AdminVireadTrainingScreen() {
  const { vireadTraining } = useAdminServices();
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
  const [reason, setReason] = useState(
    "Đã rà soát báo cáo Locked Test và chấp thuận bản VietOCR V2.",
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
      setError("Dịch vụ quản trị huấn luyện VietOCR chưa sẵn sàng.");
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
      if (!mountedRef.current) return;
      const actionId = ++actionRequestIdRef.current;
      if (oauthError) {
        setMessage(
          `Google OAuth đã bị hủy hoặc từ chối (${oauthError}). Chưa có token nào được lưu.`,
        );
        window.history.replaceState({}, document.title, cleanUrl);
        return;
      }
      if (!code || !state) {
        setMessage(
          "Thiếu tham số state từ Google OAuth. Vui lòng bấm Kết nối Google Drive để thử lại.",
        );
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
          `Đã kết nối Google Drive Luồng 2 thành công (${connected.account_email ?? "tài khoản đã xác thực"}) với phạm vi tối thiểu drive.file.`,
        );
        await load();
      } catch (err) {
        if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
          return;
        }
        setMessage(
          isServiceError(err)
            ? err.message
            : "Không thể hoàn tất xác thực OAuth Google Drive (state hết hạn, không khớp phiên Admin hoặc thiếu phạm vi drive.file). Vui lòng thử kết nối lại.",
        );
      } finally {
        window.history.replaceState({}, document.title, cleanUrl);
        if (mountedRef.current && actionId === actionRequestIdRef.current) {
          setBusy(false);
        }
      }
    })();
  }, [load, vireadTraining]);

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
          ? "Đã ghi quyết định phê duyệt. Backend sẽ tải model đã kiểm tra."
          : "Đã ghi quyết định rollback về model trước đó.",
      );
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : "Không thể lưu quyết định. Hãy kiểm tra trạng thái và thử lại.",
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
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : "Không thể tạo snapshot hoặc xếp hàng train Luồng 2.",
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
      setMessage(
        "Đã đưa lại job lỗi vào hàng đợi. Colab sẽ nhận đúng snapshot dữ liệu khi bạn chạy worker.",
      );
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : "Không thể thử lại job này. Job có thể đã tạo run, model gốc đã đổi hoặc một job khác đang chạy.",
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
      setMessage(
        "Đã xóa job cũ. Dataset, run và checkpoint được giữ; hàng đợi sẽ tạo job mới theo cấu hình backend hiện tại nếu dữ liệu vẫn đủ điều kiện.",
      );
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : "Không thể xóa job. Job có thể đang chờ hoặc đang chạy; hãy làm mới trạng thái rồi thử lại.",
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
        `${evaluationType === "PILOT" ? "Pilot" : "Production"} đã vào hàng đợi: ${result.sample_count} mẫu, ${result.group_count} nhóm. Worker chỉ benchmark checkpoint có sẵn; không train lại.`,
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
            ? "Chưa đủ Locked Test Production độc lập. Candidate được giữ nguyên; có thể dùng Pilot để kiểm tra nhanh pipeline."
            : "Không thể xếp đánh giá. Candidate hoặc cohort có thể đã đổi trạng thái; hãy tải lại trang.",
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
      setMessage(
        "Đã đóng job lỗi cấu hình. Run và checkpoint được giữ nguyên, candidate chưa được benchmark/duyệt; hệ thống có thể tạo job mới theo cấu hình đã khóa đúng.",
      );
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : "Không thể đóng candidate này; trạng thái hoặc lineage có thể đã thay đổi.",
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
      setMessage(
        "Đã đóng candidate chưa benchmark; run và checkpoint được giữ nguyên. Hệ thống sẽ tự tạo Locked Test và job thay thế khi đủ holdout VERIFIED độc lập.",
      );
      await load();
    } catch (err) {
      if (!mountedRef.current || actionId !== actionRequestIdRef.current) {
        return;
      }
      setMessage(
        isServiceError(err)
          ? err.message
          : "Không thể đóng candidate. Có thể worker vẫn đang chạy, candidate đã có benchmark hoặc lineage đã thay đổi.",
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
  return (
    <>
      <AdminPageHeader
        eyebrow="OCR model lifecycle"
        title="Huấn luyện VietOCR V2"
        description="Theo dõi hai luồng dữ liệu, lưu trữ Google Drive 0 VNĐ, checkpoint, benchmark ghép cặp và quyết định model."
        actions={
          <Button
            className="sm:w-auto"
            disabled={!data || busy}
            onClick={() => void load()}
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-5" /> Làm mới
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
                Model đang hoạt động (Desired)
              </p>
              <h2 className="mt-2 text-xl font-black">
                {data.active_model
                  ? trainingProfileName(data.active_model.profile)
                  : "Chưa khởi tạo"}
              </h2>
              <p className="mt-2 break-all font-mono text-xs text-muted">
                {data.active_model
                  ? hash(data.active_model.checkpoint_sha256)
                  : "—"}
              </p>
              <p className="mt-1 text-xs text-muted">
                Lưu trữ:{" "}
                <strong>
                  {data.active_model?.profile === "ORIGINAL"
                    ? "Original mặc định"
                    : data.active_model?.storage_provider === "google_drive"
                      ? "Google Drive (Private)"
                      : "Supabase Legacy"}
                </strong>
              </p>
            </Card>
            <Card className="bg-white">
              <p className="font-bold text-muted">Mẫu Flow 2 sẵn sàng train</p>
              <h2 className="mt-2 text-3xl font-black">
                {(
                  data.storage_summary?.flow2_verified_total_samples ??
                  totalSamples
                ).toLocaleString("vi-VN")}
              </h2>
              <p className="mt-2 text-xs text-muted">
                {data.storage_summary
                  ? `Drive sẵn sàng: ${data.storage_summary.flow2_drive_synced_samples.toLocaleString("vi-VN")} · Chờ xác minh: ${(data.storage_summary.flow2_pending_verification_samples ?? 0).toLocaleString("vi-VN")} · Đã loại: ${(data.storage_summary.flow2_excluded_samples ?? 0).toLocaleString("vi-VN")} · Legacy: ${data.storage_summary.flow2_legacy_samples.toLocaleString("vi-VN")} (Tổng lịch sử/tất cả luồng: ${totalSamples.toLocaleString("vi-VN")})`
                  : "Các luồng được lưu tách riêng."}
              </p>
            </Card>
            <Card className="bg-white">
              <p className="font-bold text-muted">
                Outbox VERIFIED đang chờ / lỗi
              </p>
              <h2 className="mt-2 text-3xl font-black">
                {outboxPending.toLocaleString("vi-VN")}
                {outboxErrors > 0 ? (
                  <span className="ml-2 text-base font-extrabold text-danger">
                    ({outboxErrors.toLocaleString("vi-VN")} lỗi/chặn)
                  </span>
                ) : null}
              </h2>
              <p className="mt-2 text-sm text-muted">
                {outboxSkipped > 0
                  ? `Tác vụ bền vững · ${outboxSkipped.toLocaleString("vi-VN")} sự kiện AI-only đã bỏ qua an toàn.`
                  : "Tác vụ bền vững, tự retry khi lỗi."}
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
                    Trạng thái Runtime OCR: Desired vs Loaded Model
                  </h2>
                </div>
                <span className="font-mono text-xs font-bold">
                  {runtimeModel.status_label}
                </span>
              </div>
              <div className="mt-3 grid gap-3 text-xs md:grid-cols-2">
                <div className="rounded-control border border-border bg-white p-3">
                  <p className="font-bold text-muted">
                    Desired Active Model (Database Pointer)
                  </p>
                  <p className="mt-1 font-extrabold">
                    {trainingProfileName(runtimeModel.desired_profile)}
                  </p>
                  <p className="mt-1 break-all font-mono text-muted">
                    SHA-256: {hash(runtimeModel.desired_checkpoint_sha256)}
                  </p>
                </div>
                <div className="rounded-control border border-border bg-white p-3">
                  <p className="font-bold text-muted">
                    Loaded Runtime Model (Trong tiến trình OCR)
                  </p>
                  <p className="mt-1 font-extrabold">
                    {runtimeModel.initialized && runtimeModel.loaded_profile
                      ? trainingProfileName(runtimeModel.loaded_profile)
                      : "Chưa nạp vào RAM (lazy-load ở lượt OCR đầu tiên)"}
                  </p>
                  <p className="mt-1 break-all font-mono text-muted">
                    SHA-256:{" "}
                    {runtimeModel.loaded_checkpoint_sha256
                      ? hash(runtimeModel.loaded_checkpoint_sha256)
                      : "—"}
                  </p>
                </div>
              </div>
              {!runtimeModel.matches_desired ? (
                <p className="mt-3 text-sm font-bold text-rose-900">
                  Cảnh báo lệch model: Runtime OCR hiện đang nạp bản khác với
                  con trỏ active trong database (có thể do fallback khi Google
                  Drive gặp lỗi hoặc worker chưa tải lại checkpoint mới). Kiểm
                  tra kết nối Google Drive bên dưới.
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
              Training Readiness · nguồn dữ liệu
            </h2>
            <p className="mt-2 text-sm text-muted">
              Hai luồng dùng dataset và run riêng, cùng fine-tune VietOCR V2.
            </p>
            <ul className="mt-4 grid gap-3 md:grid-cols-2">
              <li className="list-none">
                <AdminVireadFlow1Replacement onSuccess={load} />
              </li>
              <li className="rounded-control border border-border p-4">
                <p className="font-extrabold">
                  Luồng 2 · văn bản Admin xác nhận
                </p>
                <p className="mt-2 text-sm">
                  Crop dòng từ revision VERIFIED:{" "}
                  {(
                    data.storage_summary?.flow2_verified_total_samples ??
                    sourceCount(["FLOW1_VERIFIED"])
                  ).toLocaleString("vi-VN")}{" "}
                  mẫu
                </p>
                <p className="mt-1 text-sm text-muted">
                  Train {flow2Train.toLocaleString("vi-VN")} · Validation{" "}
                  {flow2Validation.toLocaleString("vi-VN")} · Holdout{" "}
                  {flow2Holdout.toLocaleString("vi-VN")}
                </p>
                {data.storage_summary ? (
                  <>
                    <p className="mt-1 text-xs text-muted">
                      Mẫu Flow 2 sẵn sàng train (Drive):{" "}
                      <strong>
                        {data.storage_summary.flow2_drive_synced_samples.toLocaleString(
                          "vi-VN",
                        )}
                      </strong>{" "}
                      · Chờ xác minh:{" "}
                      {(
                        (data.storage_summary
                          .flow2_pending_verification_samples ?? 0) +
                        (data.storage_summary.flow2_parent_candidates_pending ??
                          0)
                      ).toLocaleString("vi-VN")}{" "}
                      · Đã loại:{" "}
                      {(
                        data.storage_summary.flow2_excluded_samples ?? 0
                      ).toLocaleString("vi-VN")}{" "}
                      · Legacy Supabase:{" "}
                      {data.storage_summary.flow2_legacy_samples.toLocaleString(
                        "vi-VN",
                      )}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Đóng góp từ Sách của tôi (opt-in): Chờ xác minh{" "}
                      {(
                        data.storage_summary.flow2_parent_candidates_pending ??
                        0
                      ).toLocaleString("vi-VN")}{" "}
                      · Chờ đồng bộ{" "}
                      {(
                        data.storage_summary
                          .flow2_parent_candidates_sync_queued ?? 0
                      ).toLocaleString("vi-VN")}{" "}
                      · Đã đồng bộ{" "}
                      {(
                        data.storage_summary.flow2_parent_candidates_synced ?? 0
                      ).toLocaleString("vi-VN")}
                    </p>
                  </>
                ) : null}
                <p className="mt-1 text-xs text-muted">
                  Chỉ nhận revision hoặc dòng chữ sách riêng đã được chủ sách
                  bật đóng góp và Admin xác minh thủ công (chặn tuyệt đối
                  AI_AUTO_VERIFIED); mẫu gia đình không tự trở thành Locked
                  Test.
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
                      ? "Đủ điều kiện train (Train + Validation)"
                      : "Chưa đủ điều kiện train (cần Train + Validation)"}
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
                      ? "Đủ điều kiện đánh giá để thay model (Locked Test sẵn sàng)"
                      : "Chưa đủ điều kiện đánh giá để thay model (chưa đủ Locked Test độc lập)"}
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
              Candidate Management · hàng đợi huấn luyện
            </h2>
            <p className="mt-2 text-sm text-muted">
              Training chạy ngay khi Train/Validation sẵn sàng. Candidate được
              giữ nguyên; Pilot nhỏ chỉ kiểm tra sơ bộ, còn model chỉ đổi sau
              Production Locked Test độc lập, thắng baseline và Admin duyệt.
            </p>
            {data.locked_test ? (
              <div className="mt-4 rounded-control border border-border p-4">
                <p className="font-extrabold">Locked Test tự động</p>
                {data.locked_test.status === "READY" ? (
                  <>
                    <p className="mt-2 text-sm">
                      Sẵn sàng ·{" "}
                      {data.locked_test.sample_count.toLocaleString("vi-VN")}{" "}
                      mẫu ·{" "}
                      {data.locked_test.group_count.toLocaleString("vi-VN")}{" "}
                      trang/nhóm
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-muted">
                      Manifest{" "}
                      {data.locked_test.manifest_sha256
                        ? hash(data.locked_test.manifest_sha256)
                        : "—"}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-muted">
                    Chưa đủ dữ liệu holdout VERIFIED độc lập: còn{" "}
                    {(
                      data.locked_test.missing_sample_count ??
                      Math.max(
                        0,
                        data.locked_test.minimum_samples -
                          data.locked_test.eligible_sample_count,
                      )
                    ).toLocaleString("vi-VN")}{" "}
                    cặp ảnh-nhãn và{" "}
                    {(
                      data.locked_test.missing_group_count ??
                      Math.max(
                        0,
                        data.locked_test.minimum_groups -
                          data.locked_test.eligible_group_count,
                      )
                    ).toLocaleString("vi-VN")}{" "}
                    trang/nhóm. Không dùng mẫu Train/Validation hoặc tự sinh
                    nhãn để lấp phần thiếu.
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
                            ? `${String(job.metadata.evaluation_type ?? "Evaluation")} benchmark-only · ${job.status}`
                            : `${trainingProfileName(job.profile)} · ${job.status}`}
                        </h3>
                        <span className="text-sm text-muted">
                          {job.target} · lần thử {job.attempts}
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
                              title: "Xóa job cũ?",
                              description:
                                "Xóa job cũ này? Dataset, run và checkpoint vẫn được giữ nguyên.",
                              confirmLabel: "Xóa job cũ",
                            })
                          }
                          variant="destructive"
                        >
                          <Trash2 aria-hidden className="size-4" />
                          {deletingJobId === job.job_id
                            ? "Đang xóa…"
                            : "Xóa job cũ"}
                        </Button>
                      )}
                      <p className="mt-2 break-all font-mono text-xs text-muted">
                        Job {job.job_id} · manifest {hash(job.manifest_sha256)}
                      </p>
                      <p className="mt-1 text-sm">
                        Giai đoạn:{" "}
                        {typeof stage === "string" ? stage : "đang chờ"}
                        {typeof job.progress.completed_steps === "number" &&
                        typeof job.progress.total_steps === "number"
                          ? ` · ${job.progress.completed_steps}/${job.progress.total_steps} bước`
                          : ""}
                      </p>
                      {job.status === "WAITING_FOR_COLAB_WORKER" ||
                      job.status === "FALLBACK_QUEUED_COLAB" ? (
                        <p className="mt-1 text-sm text-muted">
                          {workerStatus?.status === "READY"
                            ? `Colab worker báo READY lần gần nhất${typeof workerStatus.reported_at === "string" ? ` lúc ${new Date(workerStatus.reported_at).toLocaleString("vi-VN")}` : ""}.`
                            : workerStatus?.status === "WAITING_FOR_GPU"
                              ? `Colab worker đang chờ GPU phù hợp (${typeof workerStatus.reason_code === "string" ? workerStatus.reason_code : "thiếu GPU/CUDA/VRAM"}). Job vẫn được giữ trong hàng đợi.`
                              : workerStatus?.status === "WAITING_FOR_RESOURCES"
                                ? `Colab worker đang chờ đủ RAM hoặc dung lượng đĩa (${typeof workerStatus.reason_code === "string" ? workerStatus.reason_code : "thiếu tài nguyên"}). Job vẫn được giữ trong hàng đợi.`
                                : "Chưa có Colab worker sẵn sàng. Khi worker đã cấu hình và kết nối, job sẽ tự được nhận."}
                        </p>
                      ) : null}
                      {job.status === "COLAB_SUBMITTED" ||
                      job.status === "COLAB_EXECUTING" ? (
                        <p className="mt-1 text-sm text-muted">
                          {job.status === "COLAB_SUBMITTED"
                            ? "Colab Enterprise đã nhận execution; chờ runtime GPU bắt đầu."
                            : "Colab Enterprise đang chạy notebook cho job này."}
                        </p>
                      ) : null}
                      {job.status === "BLOCKED_CONFIGURATION" ? (
                        <p className="mt-1 text-sm text-danger">
                          Job chưa được gửi lên Google Cloud. Mã cấu hình:{" "}
                          {job.last_error_code ?? "chưa cấu hình"}. Hãy hoàn tất
                          checklist trong docs/viread-colab-enterprise-setup.md
                          rồi thử lại.
                        </p>
                      ) : null}
                      {job.colab_execution_resource_name ? (
                        <p className="mt-1 break-all font-mono text-xs text-muted">
                          Execution {job.colab_execution_resource_name}
                        </p>
                      ) : null}
                      {job.status === "QUALITY_GATE_REJECTED" ? (
                        <p className="mt-1 text-sm text-muted">
                          Candidate không đạt quality gate và chưa được kích
                          hoạt.
                        </p>
                      ) : null}
                      {job.target === "COLAB" &&
                      typeof localUnavailable === "string" ? (
                        <p className="mt-1 text-sm text-muted">
                          Máy local chuyển job sang Colab vì: {localUnavailable}
                          .
                        </p>
                      ) : null}
                      {typeof waitingReason === "string" ? (
                        <p className="mt-1 text-sm text-muted">
                          Đang chờ dữ liệu: cần cả Train và Validation.
                        </p>
                      ) : null}
                      {job.last_error_code ? (
                        <p className="mt-1 text-sm text-danger">
                          Mã lỗi: {job.last_error_code}
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
                            Thử lại job này
                          </Button>
                          <p className="mt-1 text-xs text-muted">
                            Thử lại trước khi train hoặc tiếp tục tải checkpoint
                            bị gián đoạn; giữ nguyên dataset và lineage. Locked
                            Test không bắt buộc để train.
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
                            Tiếp tục kiểm thử candidate
                          </Button>
                          <p className="mt-1 text-xs text-muted">
                            Checkpoint đã có; dùng lại cùng Google Drive Colab
                            để tiếp tục Locked Test và benchmark. Nếu tệp
                            candidate chưa được lưu trên Drive, worker sẽ dừng
                            an toàn.
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
                                title: "Đóng candidate chưa benchmark?",
                                description:
                                  "Đóng candidate chưa benchmark? Checkpoint và run được giữ để kiểm toán; model đang dùng không đổi. Job thay thế chỉ được xếp sau khi Locked Test đủ mẫu VERIFIED độc lập.",
                                confirmLabel: "Đóng candidate",
                              })
                            }
                            variant="secondary"
                          >
                            Đóng candidate, chờ job thay thế
                          </Button>
                          <p className="mt-1 text-xs text-muted">
                            Chỉ đóng candidate đã dừng và chưa benchmark.
                            Checkpoint được lưu làm hồ sơ; job mới chỉ được tạo
                            khi Locked Test đạt tối thiểu{" "}
                            {data.locked_test?.minimum_samples ?? 200} cặp và{" "}
                            {data.locked_test?.minimum_groups ?? 30} trang độc
                            lập.
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
                                title: "Đóng candidate lệch cấu hình?",
                                description:
                                  "Đóng job candidate bị lệch fingerprint cấu hình? Run và checkpoint sẽ được giữ để kiểm toán; candidate không được benchmark hay kích hoạt.",
                                confirmLabel: "Đóng candidate",
                              })
                            }
                            variant="secondary"
                          >
                            Đóng candidate lệch cấu hình
                          </Button>
                          <p className="mt-1 text-xs text-muted">
                            Giữ run và checkpoint làm hồ sơ; chỉ đóng job lỗi để
                            cho phép tạo job mới. Candidate này không được
                            benchmark hoặc kích hoạt.
                          </p>
                        </div>
                      ) : null}
                      {job.run_id ? (
                        <>
                          <p className="mt-1 break-all font-mono text-xs text-muted">
                            Run {job.run_id}
                          </p>
                          {job.run_status === "CANDIDATE" ||
                          job.run_status === "BENCHMARKED" ? (
                            <div className="mt-3 grid gap-3 md:grid-cols-2">
                              <section className="rounded-control border border-border p-3">
                                <h4 className="font-bold">Pilot Evaluation</h4>
                                <p className="mt-1 text-xs text-muted">
                                  Tối đa 40 holdout VERIFIED, ít nhất 5 nhóm.
                                  Chỉ xem CER/WER và khoảng tin cậy; không thể
                                  promotion.
                                </p>
                                <Button
                                  className="mt-2 h-11 w-auto"
                                  disabled={busy}
                                  onClick={() =>
                                    void evaluateCandidate(job.job_id, "PILOT")
                                  }
                                  variant="secondary"
                                >
                                  Chạy Pilot trên candidate đã lưu
                                </Button>
                              </section>
                              <section className="rounded-control border border-border p-3">
                                <h4 className="font-bold">
                                  Production Evaluation
                                </h4>
                                <p className="mt-1 text-xs text-muted">
                                  Dùng cohort độc lập, tối thiểu 200 mẫu và 30
                                  nhóm; so CER/WER với Original, parent và
                                  active.
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
                                  Chạy Production Locked Test
                                </Button>
                              </section>
                            </div>
                          ) : null}
                          {typeof job.metadata.evaluation_status ===
                          "string" ? (
                            <p className="mt-2 text-sm text-muted">
                              Đánh giá{" "}
                              {String(job.metadata.evaluation_type ?? "")} ·{" "}
                              {String(job.metadata.evaluation_status)}
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
                  Chưa có dataset nào đủ điều kiện tạo job.
                </p>
              ) : null}
              <PaginationBar
                ariaLabel="Phân trang hàng đợi huấn luyện"
                compact
                itemLabel="job"
                onPageChange={setJobsPage}
                page={jobsPage}
                pageSize={TRAINING_LIST_PAGE_SIZE}
                total={data.jobs.length}
              />
            </div>
          </Card>

          <Card className="mb-6 bg-white">
            <h2 className="text-xl font-black">
              Quality Gate · kết quả benchmark
            </h2>
            <p className="mt-2 text-sm text-muted">
              {latestPassing.length} checkpoint đạt quality gate và đủ điều kiện
              xét duyệt.
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
                          {trainingProfileName(run.profile)} · {run.status}
                        </h3>
                        <span className="text-sm text-muted">
                          Bước {run.step.toLocaleString("vi-VN")}
                        </span>
                      </div>
                      <p className="mt-2 break-all font-mono text-xs text-muted">
                        Run {run.run_id}
                      </p>
                      <p className="mt-1 break-all font-mono text-xs text-muted">
                        Checkpoint{" "}
                        {run.checkpoint_sha256
                          ? hash(run.checkpoint_sha256)
                          : "chưa hoàn tất"}
                      </p>
                      <p className="mt-2 text-sm">
                        Benchmark:{" "}
                        {benchmark
                          ? `${benchmark.gate_status} · ${benchmark.sample_count} cặp / ${benchmark.group_count} nhóm`
                          : "chưa có"}
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
                          Phê duyệt model
                        </Button>
                      ) : null}
                    </article>
                  );
                })}
              {data.runs.length === 0 ? (
                <p className="text-muted">Chưa có lần huấn luyện nào.</p>
              ) : null}
              <PaginationBar
                ariaLabel="Phân trang kết quả huấn luyện"
                compact
                itemLabel="lần huấn luyện"
                onPageChange={setRunsPage}
                page={runsPage}
                pageSize={TRAINING_LIST_PAGE_SIZE}
                total={data.runs.length}
              />
            </div>
          </Card>

          <Card className="bg-white">
            <h2 className="text-xl font-black">
              Admin Approval · quản lý quyết định
            </h2>
            <label
              className="mt-4 block font-bold"
              htmlFor="viread-decision-reason"
            >
              Lý do phê duyệt hoặc rollback
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
              Quyết định chỉ đổi con trỏ model sau benchmark thắng trên Locked
              Test; Original vẫn được giữ làm baseline và phương án rollback.
            </p>
            {data.active_model && data.active_model.profile !== "ORIGINAL" ? (
              <Button
                className="mt-4 h-12 w-auto"
                disabled={busy || reason.trim().length < 8}
                onClick={() => void decide({ action: "ROLLBACK" })}
                variant="secondary"
              >
                Rollback về model trước
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
              Hủy
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
              {pendingConfirm?.confirmLabel ?? "Xác nhận"}
            </Button>
          </div>
        }
        isOpen={pendingConfirm !== null}
        onClose={() => {
          if (!busy) setPendingConfirm(null);
        }}
        role="alertdialog"
        showCloseButton={!busy}
        title={pendingConfirm?.title ?? "Xác nhận thao tác"}
        tone="paper"
      >
        <p className="text-body text-ink">{pendingConfirm?.description}</p>
      </Modal>
    </>
  );
}
