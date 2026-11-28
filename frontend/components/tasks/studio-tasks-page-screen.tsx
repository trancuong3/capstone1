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
  ShieldCheck,
  Sparkles,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { TaskProgressView } from "@/components/tasks/global-task-center";
import { useTranslations } from "@/hooks/use-i18n";
import {
  createGlobalTasksService,
  emitStudioTasksChanged,
  STUDIO_TASKS_CHANGED_EVENT,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import type { TranslateFn } from "@/lib/i18n/types";
import { cn } from "@/lib/utils/cn";
import {
  ACTIVE_GLOBAL_TASK_STATUSES,
  type GlobalTaskActorRole,
  type GlobalTaskItem,
  type GlobalTaskListResponse,
  type GlobalTaskStatus,
  type StudioTasksChangedDetail,
} from "@/types/global-tasks";

export type StudioTaskStatusFilter =
  "ALL" | "ACTIVE" | "WAITING_FOR_REVIEW" | "FAILED" | "SUCCEEDED" | "OTHER";

export interface StudioTasksPageScreenProps {
  readonly viewMode?: GlobalTaskActorRole;
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

function formatElapsed(
  startedIso: string | null,
  createdIso: string,
  nowMs: number,
  t: TranslateFn,
): string {
  const parsed = Date.parse(startedIso ?? createdIso);
  if (!Number.isFinite(parsed)) return "";
  const elapsedSec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (elapsedSec < 60) {
    return t(
      "taskCenter.elapsedSeconds",
      { seconds: elapsedSec },
      "{seconds} giây",
    );
  }
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  if (minutes < 60) {
    return seconds > 0
      ? t(
          "taskCenter.elapsedMinutesSeconds",
          { minutes, seconds },
          "{minutes} phút {seconds} giây",
        )
      : t("taskCenter.elapsedMinutes", { minutes }, "{minutes} phút");
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0
    ? t(
        "taskCenter.elapsedHoursMinutes",
        { hours, minutes: remMinutes },
        "{hours} giờ {minutes} phút",
      )
    : t("taskCenter.elapsedHours", { hours }, "{hours} giờ");
}

function buildBookHref(
  task: GlobalTaskItem,
  viewMode: GlobalTaskActorRole,
): string | null {
  if (!task.book_id) return null;
  if (viewMode === "admin") {
    return `/admin/books/${encodeURIComponent(task.book_id)}`;
  }
  return `/my-books?bookId=${encodeURIComponent(task.book_id)}`;
}

function buildPageHref(
  task: GlobalTaskItem,
  viewMode: GlobalTaskActorRole,
): string | null {
  if (!task.book_id || !task.book_page_id) return null;
  if (viewMode === "admin") {
    return `/admin/books/${encodeURIComponent(task.book_id)}/pages/${encodeURIComponent(task.book_page_id)}`;
  }
  return `/my-books?bookId=${encodeURIComponent(task.book_id)}#page-${encodeURIComponent(task.book_page_id)}`;
}

function filterTasksForPortal(
  items: readonly GlobalTaskItem[],
  viewMode: GlobalTaskActorRole,
  expectedActorId?: string | null,
): readonly GlobalTaskItem[] {
  return items.filter((task) => {
    if (task.actor_role !== viewMode) return false;
    if (task.portal && task.portal !== viewMode) return false;
    if (expectedActorId && task.actor_id && task.actor_id !== expectedActorId) {
      return false;
    }
    return true;
  });
}

export function StudioTasksPageScreen({
  viewMode = "parent",
  service: injectedService,
}: StudioTasksPageScreenProps) {
  const t = useTranslations("common");
  const taskCenter = useOptionalAiTaskCenter();
  const useProviderData = Boolean(
    !injectedService &&
    taskCenter &&
    taskCenter.scopeKey &&
    taskCenter.actorRole === viewMode,
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
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [clockMs, setClockMs] = useState<number>(() => Date.now());

  const loadLocalFeed = useCallback(
    async (signal?: AbortSignal) => {
      setLocalLoading(true);
      setLocalError(null);
      try {
        const data = await fallbackService.listTasks({
          portal: viewMode,
          limit: 80,
          signal,
        });
        if (signal?.aborted) return;
        if (
          data.actor_role !== viewMode ||
          (data.portal && data.portal !== viewMode)
        ) {
          setLocalFeed(null);
          return;
        }
        setLocalFeed(data);
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLocalError(
          err instanceof Error && err.message
            ? err.message
            : t(
                "taskCenter.loadError",
                undefined,
                "Chưa tải được danh sách tác vụ AI.",
              ),
        );
      } finally {
        if (!signal?.aborted) {
          setLocalLoading(false);
        }
      }
    },
    [fallbackService, t, viewMode],
  );

  const providerScopeKey = taskCenter?.scopeKey ?? null;
  const taskCenterRefreshRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    taskCenterRefreshRef.current = taskCenter?.refresh ?? null;
  }, [taskCenter?.refresh]);

  useEffect(() => {
    if (!useProviderData || !providerScopeKey) return;
    const timer = globalThis.setTimeout(() => {
      void taskCenterRefreshRef.current?.();
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [providerScopeKey, useProviderData]);

  useEffect(() => {
    if (useProviderData) {
      return;
    }

    let active = true;
    let activeController: AbortController | null = null;

    const fetchFeed = () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      void fallbackService
        .listTasks({ portal: viewMode, limit: 80, signal: controller.signal })
        .then((data) => {
          if (!active || controller.signal.aborted) return;
          if (
            data.actor_role !== viewMode ||
            (data.portal && data.portal !== viewMode)
          ) {
            setLocalFeed(null);
            setLocalError(null);
            setLocalLoading(false);
            return;
          }
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
              : t(
                  "taskCenter.loadError",
                  undefined,
                  "Chưa tải được danh sách tác vụ AI.",
                ),
          );
          setLocalLoading(false);
        });
    };

    fetchFeed();

    const handleSync = (event?: Event) => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      const detail = (
        event as CustomEvent<StudioTasksChangedDetail | undefined> | undefined
      )?.detail;
      if (detail?.portal && detail.portal !== viewMode) {
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
  }, [fallbackService, t, useProviderData, viewMode]);

  const tasks: readonly GlobalTaskItem[] = useMemo(() => {
    const raw = useProviderData
      ? (taskCenter?.tasks ?? [])
      : (localFeed?.tasks ?? []);
    const expectedActorId = useProviderData
      ? taskCenter?.actorId
      : localFeed?.actor_id;
    return filterTasksForPortal(raw, viewMode, expectedActorId);
  }, [
    localFeed?.actor_id,
    localFeed?.tasks,
    taskCenter?.actorId,
    taskCenter?.tasks,
    useProviderData,
    viewMode,
  ]);

  const activeCount = useMemo(
    () =>
      tasks.filter((task) => ACTIVE_GLOBAL_TASK_STATUSES.has(task.status))
        .length,
    [tasks],
  );
  const waitingReviewCount = useMemo(
    () => tasks.filter((task) => task.status === "WAITING_FOR_REVIEW").length,
    [tasks],
  );
  const failedCount = useMemo(
    () =>
      tasks.filter(
        (task) => task.status === "FAILED" || task.status === "PARTIAL_SUCCESS",
      ).length,
    [tasks],
  );
  const completedCount = useMemo(
    () => tasks.filter((task) => task.status === "SUCCEEDED").length,
    [tasks],
  );
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
        setActionNotice(
          t(
            "taskCenter.retryNotice",
            undefined,
            "Đã xếp lịch thử lại tác vụ từ điểm lưu gần nhất.",
          ),
        );
        return;
      }
      setLocalBusyIds((prev) => new Set(prev).add(jobId));
      try {
        const res = await fallbackService.retryTask(jobId, {
          portal: viewMode,
        });
        setActionNotice(res.message_vi);
        emitStudioTasksChanged({ portal: viewMode });
        await loadLocalFeed();
      } catch (err) {
        setLocalError(
          err instanceof Error && err.message
            ? err.message
            : t(
                "taskCenter.retryError",
                undefined,
                "Không thể thử lại tác vụ lúc này.",
              ),
        );
      } finally {
        setLocalBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [fallbackService, loadLocalFeed, t, taskCenter, useProviderData, viewMode],
  );

  const handleCancel = useCallback(
    async (jobId: string) => {
      setActionNotice(null);
      if (useProviderData && taskCenter) {
        await taskCenter.cancelTask(jobId);
        setActionNotice(
          t(
            "taskCenter.cancelNotice",
            undefined,
            "Đã gửi yêu cầu hủy tác vụ an toàn.",
          ),
        );
        return;
      }
      setLocalBusyIds((prev) => new Set(prev).add(jobId));
      try {
        const res = await fallbackService.cancelTask(jobId, {
          portal: viewMode,
        });
        setActionNotice(res.message_vi);
        emitStudioTasksChanged({ portal: viewMode });
        await loadLocalFeed();
      } catch (err) {
        setLocalError(
          err instanceof Error && err.message
            ? err.message
            : t(
                "taskCenter.cancelError",
                undefined,
                "Không thể hủy tác vụ lúc này.",
              ),
        );
      } finally {
        setLocalBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      }
    },
    [fallbackService, loadLocalFeed, t, taskCenter, useProviderData, viewMode],
  );

  const filteredTasks = useMemo(
    () =>
      tasks.filter((task) => matchesStatusFilter(task.status, statusFilter)),
    [statusFilter, tasks],
  );

  const statusFilterOptions: ReadonlyArray<{
    readonly value: StudioTaskStatusFilter;
    readonly label: string;
    readonly count: number;
  }> = [
    {
      value: "ALL",
      label: t("taskCenter.filters.all", undefined, "Tất cả"),
      count: tasks.length,
    },
    {
      value: "ACTIVE",
      label: t("taskCenter.filters.active", undefined, "Đang chạy"),
      count: activeCount,
    },
    {
      value: "WAITING_FOR_REVIEW",
      label: t("taskCenter.filters.waitingReview", undefined, "Cần xác minh"),
      count: waitingReviewCount,
    },
    {
      value: "FAILED",
      label: t("taskCenter.filters.failed", undefined, "Thất bại"),
      count: failedCount,
    },
    {
      value: "SUCCEEDED",
      label: t("taskCenter.filters.succeeded", undefined, "Hoàn tất"),
      count: completedCount,
    },
    {
      value: "OTHER",
      label: t("taskCenter.filters.other", undefined, "Đã hủy / Cũ"),
      count: tasks.filter(
        (item) => item.status === "CANCELLED" || item.status === "STALE",
      ).length,
    },
  ];

  const isAdminView = viewMode === "admin";
  const pageHeading = isAdminView
    ? t("taskCenter.adminTitle", undefined, "Tác vụ AI quản trị")
    : t("taskCenter.parentTitle", undefined, "Tác vụ AI của tôi");
  const pageSubtitle = isAdminView
    ? t(
        "taskCenter.adminSubtitle",
        undefined,
        "Chỉ hiển thị các tác vụ AI của riêng tài khoản quản trị này. Tiến trình chạy nền an toàn khi bạn chuyển trang.",
      )
    : t(
        "taskCenter.parentSubtitle",
        undefined,
        "Chỉ hiển thị các tác vụ AI thuộc tài khoản phụ huynh của bạn. Tiến trình chạy nền an toàn khi bạn chuyển trang.",
      );
  const scopeBadgeLabel = isAdminView
    ? t(
        "taskCenter.scopeBadgeAdmin",
        undefined,
        "Không gian quản trị (riêng bạn)",
      )
    : t(
        "taskCenter.scopeBadgeParent",
        undefined,
        "Không gian phụ huynh (riêng bạn)",
      );

  return (
    <section
      aria-labelledby="studio-tasks-heading"
      className="mx-auto flex w-full max-w-[1160px] flex-col gap-5 px-4 py-6 sm:px-6"
      data-portal={viewMode}
      data-testid="studio-tasks-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-primary">
              <Sparkles aria-hidden="true" className="size-3.5" />
              ViRead Studio
            </p>
            <span
              className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-sky/75 px-2.5 py-0.5 text-[11px] font-bold text-primary-hover"
              data-testid="studio-tasks-scope-badge"
            >
              <ShieldCheck aria-hidden="true" className="size-3 shrink-0" />
              {scopeBadgeLabel}
            </span>
          </div>
          <h1
            className="text-2xl font-black text-ink sm:text-3xl"
            id="studio-tasks-heading"
          >
            {pageHeading}
          </h1>
          <p className="text-sm text-muted">{pageSubtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-white px-3.5 text-xs font-bold text-ink transition-colors hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary"
            href={isAdminView ? "/admin/books" : "/my-books"}
          >
            <BookOpen aria-hidden="true" className="size-4" />
            {isAdminView
              ? t(
                  "taskCenter.backToAdminBooks",
                  undefined,
                  "Về kho sách quản trị",
                )
              : t("taskCenter.backToParentBooks", undefined, "Về sách của tôi")}
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
            {t("taskCenter.refreshBtn", undefined, "Làm mới")}
          </Button>
        </div>
      </header>

      {/* Summary metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="bg-white p-4">
          <p className="text-xs font-semibold text-muted">
            {t("taskCenter.metrics.active", undefined, "Đang chạy")}
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums text-primary">
            {activeCount}
          </p>
        </Card>
        <Card className="bg-white p-4">
          <p className="text-xs font-semibold text-muted">
            {t("taskCenter.metrics.waitingReview", undefined, "Cần xác minh")}
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums text-amber-700">
            {waitingReviewCount}
          </p>
        </Card>
        <Card className="bg-white p-4">
          <p className="text-xs font-semibold text-muted">
            {t("taskCenter.metrics.failed", undefined, "Thất bại")}
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums text-danger">
            {failedCount}
          </p>
        </Card>
        <Card className="bg-white p-4">
          <p className="text-xs font-semibold text-muted">
            {t("taskCenter.metrics.completed", undefined, "Hoàn tất")}
          </p>
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
              ? t(
                  "taskCenter.workerOnlineBanner",
                  undefined,
                  "Máy xử lý AI / OCR đang trực tuyến và sẵn sàng nhận tác vụ.",
                )
              : t(
                  "taskCenter.workerOfflineBanner",
                  undefined,
                  "Máy chủ OCR đang tạm tắt — Các tác vụ của bạn đã lưu trong hàng chờ và sẽ tự tiếp tục khi máy chủ bật lại.",
                )}
          </span>
        </div>
      ) : null}

      {actionNotice ? (
        <StatusMessage tone="info">{actionNotice}</StatusMessage>
      ) : null}

      {errorMessage ? (
        <StatusMessage tone="error">{errorMessage}</StatusMessage>
      ) : null}

      {/* Status-only Filter Bar (strictly isolated per portal — NO cross-role filter!) */}
      <Card className="flex flex-col gap-3 bg-white p-4">
        <div
          aria-label={t(
            "taskCenter.filterAria",
            undefined,
            "Lọc tác vụ theo trạng thái",
          )}
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
              ? isAdminView
                ? t(
                    "taskCenter.emptyAdminTitle",
                    undefined,
                    "Chưa có tác vụ AI quản trị nào",
                  )
                : t(
                    "taskCenter.emptyParentTitle",
                    undefined,
                    "Chưa có tác vụ AI nào của bạn",
                  )
              : t(
                  "taskCenter.emptyFilteredTitle",
                  undefined,
                  "Không có tác vụ nào khớp bộ lọc hiện tại",
                )}
          </p>
          <p className="mt-1 text-sm text-muted">
            {tasks.length === 0
              ? isAdminView
                ? t(
                    "taskCenter.emptyAdminDesc",
                    undefined,
                    "Khi bạn tải trang sách kho chung, chạy OCR, soát lỗi hoặc tạo bìa quản trị, tiến trình % thực sẽ hiển thị riêng tại đây.",
                  )
                : t(
                    "taskCenter.emptyParentDesc",
                    undefined,
                    "Khi bạn tải trang sách riêng, quét OCR hoặc tạo bìa cho gia đình, tiến trình % thực sẽ hiển thị riêng tại đây.",
                  )
              : t(
                  "taskCenter.emptyFilteredDesc",
                  undefined,
                  "Hãy chọn bộ lọc khác hoặc bấm Làm mới để cập nhật danh sách mới nhất.",
                )}
          </p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {filteredTasks.map((task) => {
            const isBusy = pendingActionIds.has(task.id);
            const isActive = ACTIVE_GLOBAL_TASK_STATUSES.has(task.status);
            const elapsedText = formatElapsed(
              task.started_at,
              task.created_at,
              clockMs,
              t,
            );
            const bookHref = buildBookHref(task, viewMode);
            const pageHref = buildPageHref(task, viewMode);

            return (
              <article
                className="rounded-card border border-border bg-white p-4 shadow-xs"
                data-testid={`studio-task-row-${task.id}`}
                key={`${task.source}-${task.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <h2 className="text-base font-extrabold text-ink">
                      {task.title_vi}
                    </h2>
                    {task.book_title || task.page_number ? (
                      <p className="text-xs font-medium text-muted">
                        {task.book_title ??
                          t("taskCenter.defaultBookLabel", undefined, "Sách")}
                        {task.page_number
                          ? t(
                              "taskCenter.pageSeparator",
                              { pageNumber: task.page_number },
                              " • Trang {pageNumber}",
                            )
                          : ""}
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
                    {t(
                      "taskCenter.stagePrefix",
                      { stage: task.stage_label_vi },
                      "Bước: {stage}",
                    )}
                  </span>
                  {elapsedText ? (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      <Clock aria-hidden="true" className="size-3.5" />
                      {isActive
                        ? t(
                            "taskCenter.elapsedRunning",
                            { elapsed: elapsedText },
                            "Đã chạy {elapsed}",
                          )
                        : elapsedText}
                    </span>
                  ) : null}
                  {task.attempt_count > 0 ? (
                    <span className="tabular-nums">
                      {t(
                        "taskCenter.attemptLabel",
                        {
                          attempt: task.attempt_count,
                          maxAttempts: task.max_attempts,
                        },
                        "Lần thử {attempt}/{maxAttempts}",
                      )}
                    </span>
                  ) : null}
                </div>

                <TaskProgressView t={t} task={task} />

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
                      {t("actions.retry", undefined, "Thử lại")}
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
                      {t("actions.cancel", undefined, "Hủy")}
                    </button>
                  ) : null}

                  {bookHref ? (
                    <Link
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-white px-3 text-xs font-semibold text-ink transition-colors hover:bg-canvas"
                      href={bookHref}
                    >
                      <BookOpen aria-hidden="true" className="size-3.5" />
                      {t("taskCenter.openBookAction", undefined, "Mở sách")}
                    </Link>
                  ) : null}

                  {pageHref ? (
                    <Link
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-white px-3 text-xs font-semibold text-ink transition-colors hover:bg-canvas"
                      href={pageHref}
                    >
                      <FileText aria-hidden="true" className="size-3.5" />
                      {t("taskCenter.openPageAction", undefined, "Mở trang")}
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
                      {t(
                        "taskCenter.viewResultAction",
                        undefined,
                        "Xem kết quả",
                      )}
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
