"use client";

import {
  CheckCircle2,
  Clock,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { PaginationBar } from "@/components/common/pagination-bar";
import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { TaskProgressView } from "@/components/tasks/task-progress-view";
import { useTranslations } from "@/hooks/use-i18n";
import type { TranslateFn } from "@/lib/i18n/types";
import { cn } from "@/lib/utils/cn";
import {
  ACTIVE_GLOBAL_TASK_STATUSES,
  type GlobalTaskStatus,
} from "@/types/global-tasks";

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

const TASKS_PAGE_SIZE = 6;

export function GlobalTaskCenterDrawer() {
  const t = useTranslations("common");
  const tOcr = useTranslations("ocr");
  const taskCenter = useOptionalAiTaskCenter();
  const [clockMs, setClockMs] = useState<number>(() => Date.now());
  const scopeKey = taskCenter?.scopeKey ?? "";
  const [tasksPageState, setTasksPageState] = useState<{
    readonly scopeKey: string;
    readonly page: number;
  }>({ scopeKey, page: 1 });

  const isOpen = taskCenter?.isOpen ?? false;
  const activeCount = taskCenter?.activeCount ?? 0;

  useEffect(() => {
    if (!isOpen || activeCount <= 0) {
      return;
    }
    const id = setInterval(() => {
      setClockMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [activeCount, isOpen]);

  if (!taskCenter || !taskCenter.scopeKey || !taskCenter.actorRole || !isOpen) {
    return null;
  }

  const {
    actorRole,
    tasks,
    workerOnline,
    isRefreshing,
    pendingActionJobIds,
    errorMessage,
    closePanel,
    refresh,
    retryTask,
    cancelTask,
  } = taskCenter;

  const isAdminPortal = actorRole === "admin";
  const fullTasksPageHref = isAdminPortal ? "/admin/tasks" : "/studio/tasks";
  const rawTasksPage =
    tasksPageState.scopeKey === scopeKey ? tasksPageState.page : 1;
  const totalTaskPages = Math.max(1, Math.ceil(tasks.length / TASKS_PAGE_SIZE));
  const safeTasksPage = Math.min(Math.max(1, rawTasksPage), totalTaskPages);
  const visibleTasks = tasks.slice(
    (safeTasksPage - 1) * TASKS_PAGE_SIZE,
    safeTasksPage * TASKS_PAGE_SIZE,
  );
  const drawerTitle = isAdminPortal
    ? t("taskCenter.adminTitle", undefined, "Tác vụ AI quản trị")
    : t("taskCenter.parentTitle", undefined, "Tác vụ AI của tôi");
  const drawerSubtitle = isAdminPortal
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
  const scopeBadgeLabel = isAdminPortal
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
        aria-label={drawerTitle}
        aria-modal="true"
        className={cn(
          "flex w-full flex-col bg-white shadow-2xl outline-none",
          "max-h-[82dvh] rounded-t-2xl border-t border-border",
          "sm:h-dvh sm:max-h-dvh sm:w-[min(28rem,100vw)] sm:rounded-none sm:border-s sm:border-t-0",
        )}
        data-portal={actorRole}
        data-testid="global-task-center-panel"
        id="viread-global-task-center-panel"
        role="dialog"
      >
        <div
          className="flex justify-center pt-2.5 sm:hidden"
          aria-hidden="true"
        >
          <span className="h-1.5 w-12 rounded-full bg-border" />
        </div>

        <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3.5 sm:px-5">
          <div className="min-w-0 space-y-1">
            <span
              className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-sky/75 px-2 py-0.5 text-[11px] font-bold text-primary-hover"
              data-testid="task-center-scope-badge"
            >
              <ShieldCheck aria-hidden="true" className="size-3 shrink-0" />
              {scopeBadgeLabel}
            </span>
            <h2 className="text-base font-bold text-ink">{drawerTitle}</h2>
            <p className="text-xs text-muted">{drawerSubtitle}</p>
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
            <WifiOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              {activeCount > 0
                ? t(
                    "taskCenter.workerOfflineBanner",
                    undefined,
                    "Máy chủ OCR đang tạm tắt — Các tác vụ của bạn đã lưu trong hàng chờ và sẽ tự tiếp tục khi máy chủ bật lại.",
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
                {isAdminPortal
                  ? t(
                      "taskCenter.emptyAdminTitle",
                      undefined,
                      "Chưa có tác vụ AI quản trị nào",
                    )
                  : t(
                      "taskCenter.emptyParentTitle",
                      undefined,
                      "Chưa có tác vụ AI nào của bạn",
                    )}
              </p>
              <p className="mt-1 text-xs text-muted">
                {isAdminPortal
                  ? t(
                      "taskCenter.emptyAdminDesc",
                      undefined,
                      "Khi bạn tải trang sách kho chung, chạy OCR, soát lỗi hoặc tạo bìa quản trị, tiến trình % thực sẽ hiển thị riêng tại đây.",
                    )
                  : t(
                      "taskCenter.emptyParentDesc",
                      undefined,
                      "Khi bạn tải trang sách riêng, quét OCR hoặc tạo bìa cho gia đình, tiến trình % thực sẽ hiển thị riêng tại đây.",
                    )}
              </p>
            </div>
          ) : (
            visibleTasks.map((task) => {
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
                        {t("actions.retry", undefined, "Thử lại")}
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
                        {t("actions.cancel", undefined, "Hủy")}
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
                        <ExternalLink aria-hidden="true" className="size-3.5" />
                      </Link>
                    ) : null}
                  </div>
                </article>
              );
            })
          )}
        </div>

        {tasks.length > TASKS_PAGE_SIZE ? (
          <div className="border-t border-border bg-canvas/40 px-4 py-2.5 sm:px-5">
            <PaginationBar
              ariaLabel={t(
                "taskCenter.title",
                undefined,
                "Trung tâm tác vụ AI",
              )}
              compact
              onPageChange={(nextPage) =>
                setTasksPageState({ scopeKey, page: nextPage })
              }
              page={safeTasksPage}
              pageSize={TASKS_PAGE_SIZE}
              total={tasks.length}
            />
          </div>
        ) : null}

        <div className="border-t border-border bg-canvas/40 px-4 py-3 sm:px-5">
          <Link
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-control border border-border bg-white px-4 text-xs font-bold text-primary transition-colors hover:bg-sky/50 focus-visible:outline-3 focus-visible:outline-primary"
            data-testid="global-task-center-full-page-link"
            href={fullTasksPageHref}
            onClick={closePanel}
          >
            {t(
              "taskCenter.openFullPage",
              undefined,
              "Mở trang quản lý tác vụ đầy đủ",
            )}
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </Link>
        </div>
      </section>
    </div>
  );
}
