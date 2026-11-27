"use client";

import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import {
  createGlobalTasksService,
  emitStudioTasksChanged,
  STUDIO_TASKS_CHANGED_EVENT,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import { cn } from "@/lib/utils/cn";
import {
  ACTIVE_GLOBAL_TASK_STATUSES,
  type GlobalTaskActorRole,
  type GlobalTaskItem,
  type GlobalTaskListResponse,
  type GlobalTaskStatus,
} from "@/types/global-tasks";

export type StudioTaskStatusFilter =
  "ALL" | "ACTIVE" | "WAITING_FOR_REVIEW" | "FAILED" | "SUCCEEDED" | "OTHER";

export type StudioTaskRoleFilter = "ALL" | GlobalTaskActorRole;

export interface StudioTasksPageScreenProps {
  readonly viewMode?: "parent" | "admin";
  readonly service?: GlobalTasksService;
}

function statusBadgeTone(status: GlobalTaskStatus): string {
  switch (status) {
    case "RUNNING":
    case "QUEUED":
    case "RETRY_SCHEDULED":
    case "CANCEL_REQUESTED":
      return "bg-sky text-primary-hover border-primary/20";
    case "WAITING_FOR_WORKER":
    case "WAITING_FOR_QUOTA":
    case "WAITING_FOR_REVIEW":
    case "PARTIAL_SUCCESS":
      return "bg-amber-50 text-amber-800 border-amber-200";
    case "SUCCEEDED":
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    case "FAILED":
      return "bg-red-50 text-danger border-red-200";
    case "CANCELLED":
    case "STALE":
    default:
      return "bg-canvas text-muted border-border";
  }
}

function matchesStatusFilter(
  status: GlobalTaskStatus,
  filter: StudioTaskStatusFilter,
): boolean {
  if (filter === "ALL") return true;
  if (filter === "ACTIVE") return ACTIVE_GLOBAL_TASK_STATUSES.has(status);
  if (filter === "WAITING_FOR_REVIEW") return status === "WAITING_FOR_REVIEW";
  if (filter === "FAILED") {
    return status === "FAILED" || status === "PARTIAL_SUCCESS";
  }
  if (filter === "SUCCEEDED") return status === "SUCCEEDED";
  return status === "CANCELLED" || status === "STALE";
}

function formatElapsedVietnamese(
  startedIso: string | null,
  createdIso: string,
  nowMs: number,
): string {
  const parsed = Date.parse(startedIso ?? createdIso);
  if (!Number.isFinite(parsed)) return "";
  const elapsedSec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (elapsedSec < 60) {
    return `${elapsedSec} giây`;
  }
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes} phút ${seconds} giây` : `${minutes} phút`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours} giờ ${remMinutes} phút` : `${hours} giờ`;
}

function buildBookHref(
  task: GlobalTaskItem,
  viewMode: "parent" | "admin",
): string | null {
  if (!task.book_id) return null;
  if (viewMode === "admin" || task.actor_role === "admin") {
    return `/admin/books/${encodeURIComponent(task.book_id)}`;
  }
  return `/my-books?bookId=${encodeURIComponent(task.book_id)}`;
}

function buildPageHref(
  task: GlobalTaskItem,
  viewMode: "parent" | "admin",
): string | null {
  if (!task.book_id || !task.book_page_id) return null;
  if (viewMode === "admin" || task.actor_role === "admin") {
    return `/admin/books/${encodeURIComponent(task.book_id)}/pages/${encodeURIComponent(task.book_page_id)}`;
  }
  return `/my-books?bookId=${encodeURIComponent(task.book_id)}#page-${encodeURIComponent(task.book_page_id)}`;
}

export function StudioTasksPageScreen({
  viewMode = "parent",
  service: injectedService,
}: StudioTasksPageScreenProps) {
  const taskCenter = useOptionalAiTaskCenter();
  const useProviderData = Boolean(
    !injectedService && taskCenter && taskCenter.scopeKey,
  );
  const fallbackService = useMemo(
    () => injectedService ?? createGlobalTasksService(),
    [injectedService],
  );

  const [localFeed, setLocalFeed] = useState<GlobalTaskListResponse | null>(
    null,
  );
  const [localLoading, setLocalLoading] = useState(!useProviderData);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localBusyIds, setLocalBusyIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [statusFilter, setStatusFilter] =
    useState<StudioTaskStatusFilter>("ALL");
  const [roleFilter, setRoleFilter] = useState<StudioTaskRoleFilter>("ALL");
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [clockMs, setClockMs] = useState<number>(() => Date.now());

  const loadLocalFeed = useCallback(
    async (signal?: AbortSignal) => {
      setLocalLoading(true);
      setLocalError(null);
      try {
        const data = await fallbackService.listTasks({ limit: 80, signal });
        if (signal?.aborted) return;
        setLocalFeed(data);
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLocalError(
          err instanceof Error && err.message
            ? err.message
            : "Chưa tải được danh sách tác vụ AI.",
        );
      } finally {
        if (!signal?.aborted) {
          setLocalLoading(false);
        }
      }
    },
    [fallbackService],
  );

  useEffect(() => {
    if (useProviderData && taskCenter) {
      const timer = globalThis.setTimeout(() => {
        void taskCenter.refresh();
      }, 0);
      return () => globalThis.clearTimeout(timer);
    }

    let active = true;
    let activeController: AbortController | null = null;

    const fetchFeed = () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      void fallbackService
        .listTasks({ limit: 80, signal: controller.signal })
        .then((data) => {
          if (!active || controller.signal.aborted) return;
          setLocalFeed(data);
          setLocalError(null);
          setLocalLoading(false);
        })
        .catch((err: unknown) => {
          if (!active || controller.signal.aborted) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setLocalError(
            err instanceof Error && err.message
              ? err.message
              : "Chưa tải được danh sách tác vụ AI.",
          );
          setLocalLoading(false);
        });
    };

    fetchFeed();

    const handleSync = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      fetchFeed();
    };
    if (typeof window !== "undefined") {
      window.addEventListener(STUDIO_TASKS_CHANGED_EVENT, handleSync);
      window.addEventListener("viread:android-resume", handleSync);
    }
    return () => {
      active = false;
      activeController?.abort();
      if (typeof window !== "undefined") {
        window.removeEventListener(STUDIO_TASKS_CHANGED_EVENT, handleSync);
        window.removeEventListener("viread:android-resume", handleSync);
      }
    };
  }, [fallbackService, taskCenter, useProviderData]);

  const tasks: readonly GlobalTaskItem[] = useMemo(
    () =>
      useProviderData ? (taskCenter?.tasks ?? []) : (localFeed?.tasks ?? []),
    [localFeed?.tasks, taskCenter?.tasks, useProviderData],
  );
  const activeCount = useProviderData
    ? (taskCenter?.activeCount ?? 0)
    : (localFeed?.active_count ?? 0);
  const waitingReviewCount = useProviderData
    ? (taskCenter?.waitingReviewCount ?? 0)
    : (localFeed?.waiting_review_count ?? 0);
  const failedCount = useProviderData
    ? (taskCenter?.failedCount ?? 0)
    : (localFeed?.failed_count ?? 0);
  const completedCount = useProviderData
    ? (taskCenter?.completedCount ?? 0)
    : (localFeed?.completed_count ?? 0);
  const workerOnline = useProviderData
    ? (taskCenter?.workerOnline ?? null)
    : (localFeed?.worker_online ?? null);
  const isRefreshing = useProviderData
    ? (taskCenter?.isRefreshing ?? false)
    : localLoading;
  const errorMessage = useProviderData
    ? (taskCenter?.errorMessage ?? null)
    : localError;
  const pendingActionIds = useProviderData
    ? (taskCenter?.pendingActionJobIds ?? new Set<string>())
    : localBusyIds;

  useEffect(() => {
    if (activeCount <= 0) return;
    const id = setInterval(() => {
      setClockMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [activeCount]);

  const handleRefresh = useCallback(async () => {
    setActionNotice(null);
    if (useProviderData && taskCenter) {
      await taskCenter.refresh();
    } else {
      await loadLocalFeed();
    }
  }, [loadLocalFeed, taskCenter, useProviderData]);

  const handleRetry = useCallback(
    async (jobId: string) => {
      setActionNotice(null);
      if (useProviderData && taskCenter) {
        await taskCenter.retryTask(jobId);
        setActionNotice("Đã xếp lịch thử lại tác vụ từ điểm lưu gần nhất.");
        return;
      }
      setLocalBusyIds((prev) => new Set(prev).add(jobId));
      try {
        const res = await fallbackService.retryTask(jobId);
        setActionNotice(res.message_vi);
        emitStudioTasksChanged();
        await loadLocalFeed();
      } catch (err) {
        setLocalError(
          err instanceof Error && err.message
            ? err.message
            : "Không thể thử lại tác vụ lúc này.",
        );
      } finally {
        setLocalBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [fallbackService, loadLocalFeed, taskCenter, useProviderData],
  );

  const handleCancel = useCallback(
    async (jobId: string) => {
      setActionNotice(null);
      if (useProviderData && taskCenter) {
        await taskCenter.cancelTask(jobId);
        setActionNotice("Đã gửi yêu cầu hủy tác vụ an toàn.");
        return;
      }
      setLocalBusyIds((prev) => new Set(prev).add(jobId));
      try {
        const res = await fallbackService.cancelTask(jobId);
        setActionNotice(res.message_vi);
        emitStudioTasksChanged();
        await loadLocalFeed();
      } catch (err) {
        setLocalError(
          err instanceof Error && err.message
            ? err.message
            : "Không thể hủy tác vụ lúc này.",
        );
      } finally {
        setLocalBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [fallbackService, loadLocalFeed, taskCenter, useProviderData],
  );

  const filteredTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          matchesStatusFilter(task.status, statusFilter) &&
          (roleFilter === "ALL" || task.actor_role === roleFilter),
      ),
    [roleFilter, statusFilter, tasks],
  );

  const statusFilterOptions: ReadonlyArray<{
    readonly value: StudioTaskStatusFilter;
    readonly label: string;
    readonly count: number;
  }> = [
    { value: "ALL", label: "Tất cả", count: tasks.length },
    { value: "ACTIVE", label: "Đang chạy", count: activeCount },
    {
      value: "WAITING_FOR_REVIEW",
      label: "Cần xác minh",
      count: waitingReviewCount,
    },
    { value: "FAILED", label: "Thất bại", count: failedCount },
    { value: "SUCCEEDED", label: "Hoàn tất", count: completedCount },
    {
      value: "OTHER",
      label: "Đã hủy / Cũ",
      count: tasks.filter(
        (t) => t.status === "CANCELLED" || t.status === "STALE",
      ).length,
    },
  ];

  const roleFilterOptions: ReadonlyArray<{
    readonly value: StudioTaskRoleFilter;
    readonly label: string;
  }> = [
    { value: "ALL", label: "Tất cả vai trò" },
    { value: "admin", label: "Quản trị" },
    { value: "parent", label: "Phụ huynh" },
  ];

  return (
    <section
      aria-labelledby="studio-tasks-heading"
      className="mx-auto flex w-full max-w-[1160px] flex-col gap-5 px-4 py-6 sm:px-6"
      data-testid="studio-tasks-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-primary">
            <Sparkles aria-hidden="true" className="size-3.5" />
            Smart Book Studio V2
          </p>
          <h1
            className="text-2xl font-black text-ink sm:text-3xl"
            id="studio-tasks-heading"
          >
            Trung tâm tác vụ AI
          </h1>
          <p className="text-sm text-muted">
            Theo dõi bền vững mọi tác vụ OCR, tách nội dung, ảnh bìa và tranh
            minh họa — an toàn khi tải lại trang hoặc chuyển ứng dụng.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-white px-3.5 text-xs font-bold text-ink transition-colors hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary"
            href={viewMode === "admin" ? "/admin/books" : "/my-books"}
          >
            <BookOpen aria-hidden="true" className="size-4" />
            {viewMode === "admin" ? "Về kho sách quản trị" : "Về sách của tôi"}
          </Link>
          <Button
            className="min-h-11 w-auto px-4 text-xs"
            disabled={isRefreshing}
            fullWidth={false}
            isLoading={isRefreshing}
            onClick={() => void handleRefresh()}
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Làm mới
          </Button>
        </div>
      </header>

      {/* Summary metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="bg-white p-4">
          <p className="text-xs font-semibold text-muted">Đang chạy</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-primary">
            {activeCount}
          </p>
        </Card>
        <Card className="bg-white p-4">
          <p className="text-xs font-semibold text-muted">Cần xác minh</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-amber-700">
            {waitingReviewCount}
          </p>
        </Card>
        <Card className="bg-white p-4">
          <p className="text-xs font-semibold text-muted">Thất bại</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-danger">
            {failedCount}
          </p>
        </Card>
        <Card className="bg-white p-4">
          <p className="text-xs font-semibold text-muted">Hoàn tất</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-emerald-700">
            {completedCount}
          </p>
        </Card>
      </div>

      {workerOnline !== null ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-control border px-3.5 py-2.5 text-xs font-semibold",
            workerOnline
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-amber-200 bg-amber-50 text-amber-900",
          )}
          role="status"
        >
          {workerOnline ? (
            <Wifi aria-hidden="true" className="size-4 shrink-0" />
          ) : (
            <WifiOff aria-hidden="true" className="size-4 shrink-0" />
          )}
          <span>
            {workerOnline
              ? "Máy xử lý AI / OCR đang trực tuyến và sẵn sàng nhận tác vụ."
              : "Máy xử lý AI đang tạm ngoại tuyến — tác vụ đã lưu bền vững và sẽ tự động tiếp tục khi kết nối lại."}
          </span>
        </div>
      ) : null}

      {actionNotice ? (
        <StatusMessage tone="info">{actionNotice}</StatusMessage>
      ) : null}

      {errorMessage ? (
        <StatusMessage tone="error">{errorMessage}</StatusMessage>
      ) : null}

      {/* Filter Bar */}
      <Card className="flex flex-col gap-3 bg-white p-4">
        <div
          aria-label="Lọc tác vụ theo trạng thái"
          className="flex flex-wrap gap-2"
          role="group"
        >
          {statusFilterOptions.map((option) => {
            const selected = statusFilter === option.value;
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-xs font-bold transition-colors focus-visible:outline-3 focus-visible:outline-primary",
                  selected
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-white text-ink hover:bg-canvas",
                )}
                key={option.value}
                onClick={() => setStatusFilter(option.value)}
                type="button"
              >
                <span>{option.label}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
                    selected
                      ? "bg-white/20 text-white"
                      : "bg-canvas text-muted",
                  )}
                >
                  {option.count}
                </span>
              </button>
            );
          })}
        </div>

        <div
          aria-label="Lọc tác vụ theo vai trò"
          className="flex flex-wrap items-center gap-2 border-t border-border pt-3"
          role="group"
        >
          <span className="text-xs font-semibold text-muted">Vai trò:</span>
          {roleFilterOptions.map((option) => {
            const selected = roleFilter === option.value;
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-control border px-3 text-xs font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-primary",
                  selected
                    ? "border-primary bg-sky text-primary-hover"
                    : "border-border bg-white text-ink hover:bg-canvas",
                )}
                key={option.value}
                onClick={() => setRoleFilter(option.value)}
                type="button"
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </Card>

      {/* Task Cards */}
      {filteredTasks.length === 0 ? (
        <Card className="border-dashed bg-white px-6 py-10 text-center">
          <CheckCircle2
            aria-hidden="true"
            className="mx-auto size-9 text-muted"
          />
          <p className="mt-3 text-base font-bold text-ink">
            {tasks.length === 0
              ? "Chưa có tác vụ AI nào"
              : "Không có tác vụ nào khớp bộ lọc hiện tại"}
          </p>
          <p className="mt-1 text-sm text-muted">
            {tasks.length === 0
              ? "Khi bạn tải trang sách, chạy OCR, tạo bìa hoặc tách tranh minh họa, tiến trình thực sẽ hiển thị tại đây."
              : "Hãy chọn bộ lọc khác hoặc bấm Làm mới để cập nhật danh sách mới nhất."}
          </p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {filteredTasks.map((task) => {
            const isBusy = pendingActionIds.has(task.id);
            const isActive = ACTIVE_GLOBAL_TASK_STATUSES.has(task.status);
            const elapsedText = formatElapsedVietnamese(
              task.started_at,
              task.created_at,
              clockMs,
            );
            const bookHref = buildBookHref(task, viewMode);
            const pageHref = buildPageHref(task, viewMode);
            const hasMeasuredProgress =
              !task.is_indeterminate &&
              task.progress_completed !== null &&
              task.progress_total !== null &&
              task.progress_total > 0 &&
              task.progress_pct !== null;

            return (
              <article
                className="rounded-card border border-border bg-white p-4 shadow-xs"
                data-testid={`studio-task-row-${task.id}`}
                key={`${task.source}-${task.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-extrabold text-ink">
                        {task.title_vi}
                      </h2>
                      <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-bold uppercase text-muted">
                        {task.actor_role === "admin" ? "Quản trị" : "Phụ huynh"}
                      </span>
                    </div>
                    {task.book_title || task.page_number ? (
                      <p className="text-xs font-medium text-muted">
                        {task.book_title ?? "Sách"}
                        {task.page_number ? ` • Trang ${task.page_number}` : ""}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full border px-3 py-1 text-xs font-bold",
                      statusBadgeTone(task.status),
                    )}
                  >
                    {task.status_label_vi}
                  </span>
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                  <span className="inline-flex items-center gap-1">
                    {isActive ? (
                      <Loader2
                        aria-hidden="true"
                        className="size-3.5 animate-spin text-primary"
                      />
                    ) : task.status === "FAILED" ? (
                      <AlertCircle
                        aria-hidden="true"
                        className="size-3.5 text-danger"
                      />
                    ) : null}
                    Bước:{" "}
                    <strong className="text-ink">{task.stage_label_vi}</strong>
                  </span>
                  {elapsedText ? (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      <Clock aria-hidden="true" className="size-3.5" />
                      {isActive ? `Đã chạy ${elapsedText}` : elapsedText}
                    </span>
                  ) : null}
                  {task.attempt_count > 0 ? (
                    <span className="tabular-nums">
                      Lần thử {task.attempt_count}/{task.max_attempts}
                    </span>
                  ) : null}
                </div>

                {hasMeasuredProgress ? (
                  <div className="mt-3 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-semibold text-muted">
                      <span>
                        {task.progress_completed}/{task.progress_total}
                        {task.progress_unit ? ` ${task.progress_unit}` : ""}
                      </span>
                      <span className="tabular-nums">
                        {Math.round(
                          Math.max(0, Math.min(100, task.progress_pct!)),
                        )}
                        %
                      </span>
                    </div>
                    <div
                      aria-label={`Tiến độ ${task.title_vi}`}
                      aria-valuemax={task.progress_total!}
                      aria-valuemin={0}
                      aria-valuenow={task.progress_completed!}
                      className="h-2 w-full overflow-hidden rounded-full bg-canvas"
                      role="progressbar"
                    >
                      <div
                        className={cn(
                          "h-full rounded-full transition-[width] duration-300",
                          task.status === "FAILED"
                            ? "bg-danger"
                            : task.status === "SUCCEEDED"
                              ? "bg-emerald-600"
                              : "bg-primary",
                        )}
                        style={{
                          width: `${Math.max(0, Math.min(100, task.progress_pct!))}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : isActive ? (
                  <div className="mt-3 space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-muted">
                      <span>{task.stage_label_vi}</span>
                      <span>Đang xử lý nền…</span>
                    </div>
                    <div
                      aria-label={`Đang xử lý ${task.title_vi}`}
                      className="h-2 w-full overflow-hidden rounded-full bg-canvas"
                      data-indeterminate="true"
                      role="progressbar"
                    >
                      <div className="h-full w-2/5 animate-pulse rounded-full bg-primary/75" />
                    </div>
                  </div>
                ) : null}

                {task.error_message_vi ? (
                  <p className="mt-2.5 rounded-control bg-red-50 px-3 py-2 text-xs font-medium text-danger">
                    {task.error_message_vi}
                  </p>
                ) : null}

                <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
                  {task.can_retry ? (
                    <button
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-primary/40 bg-sky px-3.5 text-xs font-bold text-primary-hover transition-colors hover:bg-sky/80 disabled:opacity-50"
                      disabled={isBusy}
                      onClick={() => void handleRetry(task.id)}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" className="size-4" />
                      Thử lại
                    </button>
                  ) : null}

                  {task.can_cancel ? (
                    <button
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-white px-3.5 text-xs font-bold text-ink transition-colors hover:bg-canvas disabled:opacity-50"
                      disabled={isBusy}
                      onClick={() => void handleCancel(task.id)}
                      type="button"
                    >
                      <XCircle aria-hidden="true" className="size-4" />
                      Hủy
                    </button>
                  ) : null}

                  {bookHref ? (
                    <Link
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-white px-3 text-xs font-semibold text-ink transition-colors hover:bg-canvas"
                      href={bookHref}
                    >
                      <BookOpen aria-hidden="true" className="size-3.5" />
                      Mở sách
                    </Link>
                  ) : null}

                  {pageHref ? (
                    <Link
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-white px-3 text-xs font-semibold text-ink transition-colors hover:bg-canvas"
                      href={pageHref}
                    >
                      <FileText aria-hidden="true" className="size-3.5" />
                      Mở trang
                    </Link>
                  ) : null}

                  {task.result_href &&
                  (task.status === "SUCCEEDED" ||
                    task.status === "PARTIAL_SUCCESS" ||
                    task.status === "WAITING_FOR_REVIEW") ? (
                    <Link
                      className="ms-auto inline-flex min-h-11 items-center gap-1.5 rounded-control bg-primary px-3.5 text-xs font-bold text-white transition-colors hover:bg-primary-hover"
                      href={task.result_href}
                    >
                      Xem kết quả
                      <ExternalLink aria-hidden="true" className="size-3.5" />
                    </Link>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
