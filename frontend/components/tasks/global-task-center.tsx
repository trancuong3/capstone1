"use client";

import { AlertCircle, Clock, Loader2, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import { ACTIVE_GLOBAL_TASK_STATUSES } from "@/types/global-tasks";

const LazyGlobalTaskCenterDrawer = dynamic(
  () =>
    import("@/components/tasks/global-task-center-drawer").then(
      (mod) => mod.GlobalTaskCenterDrawer,
    ),
  { ssr: false },
);

export interface GlobalTaskCenterProps {
  readonly variant?:
    "header-pill" | "floating" | "sidebar" | "topbar" | "drawer-only";
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

export function GlobalTaskCenter({
  variant = "header-pill",
  hideOnPaths = [],
  className,
}: GlobalTaskCenterProps) {
  const t = useTranslations("admin");
  const pathname = usePathname() ?? "/";
  const taskCenter = useOptionalAiTaskCenter();

  const isOpen = taskCenter?.isOpen ?? false;
  const activeCount = taskCenter?.activeCount ?? 0;

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

  const { tasks, waitingReviewCount, failedCount, togglePanel } = taskCenter;

  if (variant === "drawer-only") {
    return isOpen ? <LazyGlobalTaskCenterDrawer /> : null;
  }

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
            activeCount > 0
              ? "bg-primary text-white"
              : failedCount > 0
                ? "bg-danger text-white"
                : "bg-amber-600 text-white",
          )}
        >
          {highlightCount}
        </span>
      ) : null}
    </button>
  );

  return (
    <>
      {triggerButton}
      {isOpen ? <LazyGlobalTaskCenterDrawer /> : null}
    </>
  );
}
