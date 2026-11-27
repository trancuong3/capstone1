"use client";

import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { useTranslations } from "@/hooks/use-i18n";
import type { TranslateFn } from "@/lib/i18n/types";
import { cn } from "@/lib/utils/cn";
import {
  ACTIVE_GLOBAL_TASK_STATUSES,
  type GlobalTaskItem,
  type GlobalTaskStatus,
} from "@/types/global-tasks";

export interface GlobalTaskCenterProps {
  readonly variant?: "header-pill" | "floating" | "sidebar" | "topbar";
  readonly hideOnPaths?: readonly string[];
  readonly className?: string;
}

function isChildReadingPath(pathname: string): boolean {
  return pathname === "/reading" || pathname.startsWith("/reading/");
}

function shouldHideOnPath(
  pathname: string,
  hideOnPaths: readonly string[],
): boolean {
  if (isChildReadingPath(pathname)) {
    return true;
  }
  return hideOnPaths.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
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

function TaskProgressView({
  task,
  t,
}: {
  readonly task: GlobalTaskItem;
  readonly t: TranslateFn;
}) {
  const isActive = ACTIVE_GLOBAL_TASK_STATUSES.has(task.status);
  const hasMeasuredProgress =
    !task.is_indeterminate &&
    task.progress_completed !== null &&
    task.progress_total !== null &&
    task.progress_total > 0 &&
    task.progress_pct !== null;

  if (hasMeasuredProgress) {
    const pct = Math.max(0, Math.min(100, task.progress_pct!));
    return (
      <div
        className="mt-2.5 space-y-1.5"
        data-testid={`task-progress-${task.id}`}
      >
        <div className="flex items-center justify-between text-xs font-semibold text-muted">
          <span>
            {task.progress_completed}/{task.progress_total}
            {task.progress_unit ? ` ${task.progress_unit}` : ""}
          </span>
          <span className="tabular-nums">{Math.round(pct)}%</span>
        </div>
        <div
          aria-label={t(
            "taskCenter.progressAria",
            { title: task.title_vi },
            "Tiến độ {title}",
          )}
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
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (task.status === "WAITING_FOR_WORKER") {
    return (
      <div
        className="mt-2.5 flex items-center gap-2 rounded-control border border-amber-200 bg-amber-50/80 px-2.5 py-1.5 text-xs font-medium text-amber-900"
        data-testid={`task-queued-offline-${task.id}`}
      >
        <Clock
          aria-hidden="true"
          className="size-3.5 shrink-0 text-amber-700"
        />
        <span>
          {task.stage_label_vi ||
            "Đã lưu trong hàng chờ — Chờ máy chủ OCR bật lại"}
        </span>
      </div>
    );
  }

  if (isActive) {
    return (
      <div
        className="mt-2.5 space-y-1.5"
        data-testid={`task-progress-${task.id}`}
      >
        <div className="flex items-center justify-between text-xs font-medium text-muted">
          <span>{task.stage_label_vi}</span>
          <span>
            {t("taskCenter.backgroundProcessing", undefined, "Đang xử lý nền…")}
          </span>
        </div>
        <div
          aria-label={t(
            "taskCenter.processingAria",
            { title: task.title_vi },
            "Đang xử lý {title}",
          )}
          className="h-2 w-full overflow-hidden rounded-full bg-canvas"
          data-indeterminate="true"
          role="progressbar"
        >
          <div className="h-full w-2/5 animate-pulse rounded-full bg-primary/75" />
        </div>
      </div>
    );
  }

  return null;
}

export function GlobalTaskCenter({
  variant = "header-pill",
  hideOnPaths = [],
  className,
}: GlobalTaskCenterProps) {
  const t = useTranslations("admin");
  const tOcr = useTranslations("ocr");
  const pathname = usePathname() ?? "/";
  const taskCenter = useOptionalAiTaskCenter();
  const [clockMs, setClockMs] = useState<number>(() => Date.now());

  const isOpen = taskCenter?.isOpen ?? false;
  const activeCount = taskCenter?.activeCount ?? 0;

  // Tick live elapsed clock ONLY while drawer is open and active tasks exist (pure elapsed time, never fake %).
  useEffect(() => {
    if (!isOpen || activeCount <= 0) {
      return;
    }
    const id = setInterval(() => {
      setClockMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [activeCount, isOpen]);

  // Escape key closes the slide-over / bottom sheet cleanly.
  useEffect(() => {
    if (!isOpen || !taskCenter) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        taskCenter?.closePanel();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, taskCenter]);

  if (!taskCenter || !taskCenter.scopeKey) {
    return null;
  }

  // Child reading protection: NEVER render floating task UI on /reading/*!
  if (shouldHideOnPath(pathname, hideOnPaths)) {
    return null;
  }

  const {
    tasks,
    waitingReviewCount,
    failedCount,
    workerOnline,
    isRefreshing,
    pendingActionJobIds,
    errorMessage,
    togglePanel,
    closePanel,
    refresh,
    retryTask,
    cancelTask,
  } = taskCenter;

  const activeTasks = tasks.filter((item) =>
    ACTIVE_GLOBAL_TASK_STATUSES.has(item.status),
  );
  const allActiveWaitingForWorker =
    activeCount > 0 &&
    activeTasks.length > 0 &&
    activeTasks.every((item) => item.status === "WAITING_FOR_WORKER");

  const pillText = allActiveWaitingForWorker
    ? t(
        "taskCenter.pillWaitingForWorker",
        { count: activeCount },
        "Hàng chờ OCR ({count})",
      )
    : activeCount > 0
      ? t(
          "taskCenter.pillRunning",
          { count: activeCount },
          "AI đang chạy ({count})",
        )
      : waitingReviewCount > 0
        ? t(
            "taskCenter.pillWaitingReview",
            { count: waitingReviewCount },
            "Cần xác minh ({count})",
          )
        : failedCount > 0
          ? t(
              "taskCenter.pillFailed",
              { count: failedCount },
              "Tác vụ lỗi ({count})",
            )
          : t("taskCenter.pillIdle", undefined, "Tác vụ AI");

  const highlightCount =
    activeCount > 0
      ? activeCount
      : waitingReviewCount > 0
        ? waitingReviewCount
        : failedCount > 0
          ? failedCount
          : 0;

  const isCompactTopbar = variant === "header-pill" || variant === "topbar";

  const triggerButton = (
    <button
      aria-controls="viread-global-task-center-panel"
      aria-expanded={isOpen}
      aria-label={t("taskCenter.openAria", undefined, "Mở trung tâm tác vụ AI")}
      className={cn(
        "inline-flex items-center border font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
        variant === "sidebar" &&
          "min-h-10 w-full justify-between gap-2 rounded-control px-3 py-2 text-xs shadow-2xs",
        variant === "topbar" &&
          "min-h-10 min-w-10 justify-center gap-1.5 rounded-full px-2.5 text-xs shadow-2xs sm:px-3",
        variant === "header-pill" &&
          "min-h-11 min-w-11 justify-center gap-1.5 rounded-full px-2.5 text-xs shadow-sm sm:gap-2 sm:px-3.5 sm:text-sm",
        variant === "floating" &&
          "fixed bottom-20 end-4 z-40 min-h-12 justify-center gap-2 rounded-full px-4 text-xs shadow-lg sm:text-sm xl:bottom-5 xl:end-5",
        allActiveWaitingForWorker
          ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100/70"
          : activeCount > 0
            ? "border-primary/40 bg-sky text-primary-hover hover:bg-sky/80"
            : failedCount > 0
              ? "border-red-200 bg-red-50 text-danger hover:bg-red-100/70"
              : waitingReviewCount > 0
                ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100/70"
                : "border-border bg-white text-ink hover:bg-canvas",
        className,
      )}
      data-testid="global-task-center-trigger"
      data-variant={variant}
      onClick={togglePanel}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        {allActiveWaitingForWorker ? (
          <Clock
            aria-hidden="true"
            className="size-4 shrink-0 text-amber-700"
          />
        ) : activeCount > 0 ? (
          <Loader2
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin"
          />
        ) : failedCount > 0 ? (
          <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
        ) : (
          <Sparkles
            aria-hidden="true"
            className="size-4 shrink-0 text-primary"
          />
        )}
        <span
          className={cn(
            "truncate whitespace-nowrap",
            isCompactTopbar && "sr-only sm:not-sr-only",
          )}
        >
          {pillText}
        </span>
      </span>
      {isCompactTopbar && highlightCount > 0 ? (
        <span aria-hidden="true" className="tabular-nums sm:hidden">
          {highlightCount}
        </span>
      ) : null}
      {variant === "sidebar" && highlightCount > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums",
            allActiveWaitingForWorker
              ? "bg-amber-600 text-white"
              : activeCount > 0
                ? "bg-primary text-white"
                : failedCount > 0
                  ? "bg-danger text-white"
                  : "bg-amber-600 text-white",
          )}
          data-testid="global-task-center-sidebar-count"
        >
          {highlightCount}
        </span>
      ) : null}
    </button>
  );

  return (
    <>
      {triggerButton}

      {isOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-end bg-ink/35 backdrop-blur-[1px] sm:items-stretch"
          data-testid="global-task-center-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closePanel();
            }
          }}
        >
          <section
            aria-label={t("taskCenter.title", undefined, "Trung tâm tác vụ AI")}
            aria-modal="true"
            className={cn(
              "flex w-full flex-col bg-white shadow-2xl outline-none",
              // Mobile bottom sheet (< sm) vs Desktop slide-over (>= sm)
              "max-h-[82dvh] rounded-t-2xl border-t border-border",
              "sm:h-dvh sm:max-h-dvh sm:w-[min(28rem,100vw)] sm:rounded-none sm:border-s sm:border-t-0",
            )}
            data-testid="global-task-center-panel"
            id="viread-global-task-center-panel"
            role="dialog"
          >
            {/* Mobile bottom-sheet visual drag indicator */}
            <div
              className="flex justify-center pt-2.5 sm:hidden"
              aria-hidden="true"
            >
              <span className="h-1.5 w-12 rounded-full bg-border" />
            </div>

            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3.5 sm:px-5">
              <div className="min-w-0">
                <h2 className="text-base font-bold text-ink">
                  {t("taskCenter.title", undefined, "Trung tâm tác vụ AI")}
                </h2>
                <p className="text-xs text-muted">
                  {t(
                    "taskCenter.subtitle",
                    undefined,
                    "Tác vụ nền tiếp tục chạy an toàn kể cả khi bạn chuyển trang.",
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  aria-label={t(
                    "taskCenter.refreshAria",
                    undefined,
                    "Làm mới danh sách tác vụ",
                  )}
                  className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-control text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-3 focus-visible:outline-primary"
                  disabled={isRefreshing}
                  onClick={() => void refresh()}
                  type="button"
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={cn("size-4", isRefreshing && "animate-spin")}
                  />
                </button>
                <button
                  aria-label={t(
                    "taskCenter.closeAria",
                    undefined,
                    "Đóng trung tâm tác vụ AI",
                  )}
                  className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-control text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-3 focus-visible:outline-primary"
                  onClick={closePanel}
                  type="button"
                >
                  <X aria-hidden="true" className="size-5" />
                </button>
              </div>
            </div>

            {workerOnline === false ? (
              <div
                className="mx-4 mt-3 flex items-start gap-2.5 rounded-control border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs font-medium text-amber-900 sm:mx-5"
                data-testid="global-task-center-worker-offline-banner"
                role="status"
              >
                <WifiOff
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0"
                />
                <span>
                  {activeCount > 0
                    ? t(
                        "taskCenter.workerOfflineBanner",
                        undefined,
                        "Máy chủ OCR đang tạm tắt — Các tác vụ đã lưu trong hàng chờ và sẽ tự động nhận diện ngay khi máy chủ OCR bật lại.",
                      )
                    : tOcr(
                        "serviceStatus.taskCenterOfflineIdleBanner",
                        undefined,
                        "Dịch vụ OCR hiện chưa sẵn sàng — Các trang mới tải lên sẽ được lưu an toàn vào hàng chờ và tự động xử lý ngay khi OCR hoạt động trở lại.",
                      )}
                </span>
              </div>
            ) : null}

            {errorMessage ? (
              <div
                className="mx-4 mt-3 rounded-control border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-danger sm:mx-5"
                role="alert"
              >
                {errorMessage}
              </div>
            ) : null}

            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5">
              {tasks.length === 0 ? (
                <div className="rounded-card border border-dashed border-border bg-canvas/50 px-4 py-8 text-center">
                  <CheckCircle2
                    aria-hidden="true"
                    className="mx-auto size-8 text-muted"
                  />
                  <p className="mt-2 text-sm font-semibold text-ink">
                    {t(
                      "taskCenter.emptyTitle",
                      undefined,
                      "Chưa có tác vụ AI nào",
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {t(
                      "taskCenter.emptyDescription",
                      undefined,
                      "Khi bạn tải trang sách, tách nội dung OCR hoặc tạo bìa, tiến trình thực sẽ hiển thị tại đây.",
                    )}
                  </p>
                </div>
              ) : (
                tasks.map((task) => {
                  const isBusy = pendingActionJobIds.has(task.id);
                  const isActive = ACTIVE_GLOBAL_TASK_STATUSES.has(task.status);
                  const elapsedText = formatElapsed(
                    task.started_at,
                    task.created_at,
                    clockMs,
                    t,
                  );

                  return (
                    <article
                      className="rounded-card border border-border bg-white p-3.5 shadow-xs"
                      data-testid={`task-card-${task.id}`}
                      key={`${task.source}-${task.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-sm font-bold text-ink">
                            {task.title_vi}
                          </h3>
                          {task.book_title || task.page_number ? (
                            <p className="mt-0.5 truncate text-xs text-muted">
                              {task.book_title ??
                                t(
                                  "taskCenter.defaultBookLabel",
                                  undefined,
                                  "Sách",
                                )}
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
                            "shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
                            statusBadgeTone(task.status),
                          )}
                        >
                          {task.status_label_vi}
                        </span>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                        <span>
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
                      </div>

                      <TaskProgressView t={t} task={task} />

                      {task.error_message_vi ? (
                        <p className="mt-2 rounded-control bg-red-50 px-2.5 py-1.5 text-xs text-danger">
                          {task.error_message_vi}
                        </p>
                      ) : null}

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {task.can_retry ? (
                          <button
                            className="inline-flex min-h-12 items-center gap-1.5 rounded-control border border-primary/40 bg-sky px-3.5 text-xs font-semibold text-primary-hover transition-colors hover:bg-sky/80 disabled:opacity-50"
                            disabled={isBusy}
                            onClick={() => void retryTask(task.id)}
                            type="button"
                          >
                            <RotateCcw aria-hidden="true" className="size-4" />
                            {t("common.retry")}
                          </button>
                        ) : null}

                        {task.can_cancel ? (
                          <button
                            className="inline-flex min-h-12 items-center gap-1.5 rounded-control border border-border bg-white px-3.5 text-xs font-semibold text-ink transition-colors hover:bg-canvas disabled:opacity-50"
                            disabled={isBusy}
                            onClick={() => void cancelTask(task.id)}
                            type="button"
                          >
                            <XCircle aria-hidden="true" className="size-4" />
                            {t("common.cancel")}
                          </button>
                        ) : null}

                        {task.result_href &&
                        (task.status === "SUCCEEDED" ||
                          task.status === "PARTIAL_SUCCESS" ||
                          task.status === "WAITING_FOR_REVIEW") ? (
                          <Link
                            className="ms-auto inline-flex min-h-12 items-center gap-1.5 rounded-control bg-primary px-3.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover"
                            href={task.result_href}
                            onClick={closePanel}
                          >
                            {t(
                              "taskCenter.viewResultAction",
                              undefined,
                              "Xem kết quả",
                            )}
                            <ExternalLink
                              aria-hidden="true"
                              className="size-3.5"
                            />
                          </Link>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
