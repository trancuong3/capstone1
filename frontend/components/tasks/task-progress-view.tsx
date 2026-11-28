"use client";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { useAiProgress } from "@/hooks/use-ai-progress";
import type { TranslateFn } from "@/lib/i18n/types";
import {
  ACTIVE_GLOBAL_TASK_STATUSES,
  type GlobalTaskItem,
} from "@/types/global-tasks";

export function TaskProgressView({
  task,
  t,
}: {
  readonly task: GlobalTaskItem;
  readonly t: TranslateFn;
}) {
  const isActive = ACTIVE_GLOBAL_TASK_STATUSES.has(task.status);
  const isWaitingForWorker =
    task.status === "WAITING_FOR_WORKER" || task.status === "WAITING_FOR_QUOTA";
  const hasMeasuredCounts =
    task.progress_completed !== null &&
    task.progress_total !== null &&
    task.progress_total > 0;
  const resolvedMode: "measured" | "staged" =
    task.progress_mode ??
    (!task.is_indeterminate && hasMeasuredCounts ? "measured" : "staged");
  const isCompleted =
    task.status === "SUCCEEDED" || task.status === "WAITING_FOR_REVIEW";
  const isFailed = task.status === "FAILED";

  const progress = useAiProgress({
    active: isActive && !isWaitingForWorker,
    realPercent: task.progress_pct,
    progressMode: resolvedMode,
    completed: isCompleted,
    failed: isFailed,
    floorPct: task.status === "QUEUED" ? 5 : 8,
    ceilingPct: 94,
    expectedDurationMs: 18_000,
    resetKey: task.id,
  });

  if (task.status === "CANCELLED" || task.status === "STALE") {
    return null;
  }

  if (isWaitingForWorker) {
    const waitingPct =
      typeof task.progress_pct === "number" &&
      Number.isFinite(task.progress_pct)
        ? Math.max(2, Math.min(10, task.progress_pct))
        : 2;
    return (
      <div
        className="mt-2.5 space-y-1.5 rounded-control border border-amber-200 bg-amber-50/75 px-2.5 py-2"
        data-testid={`task-queued-offline-${task.id}`}
      >
        <AiProgressBar
          active={false}
          label={
            task.stage_label_vi ||
            t(
              "aiProgress.waitingWorker",
              undefined,
              "Đang chờ máy xử lý AI kết nối lại…",
            )
          }
          percent={waitingPct}
          size="sm"
          testId={`task-progress-${task.id}`}
          tone="warning"
        />
      </div>
    );
  }

  const isPartialSuccess = task.status === "PARTIAL_SUCCESS";
  if (
    !isActive &&
    !isCompleted &&
    !isFailed &&
    !isPartialSuccess &&
    task.progress_pct === null
  ) {
    return null;
  }

  const detail = hasMeasuredCounts
    ? `${task.progress_completed}/${task.progress_total}${task.progress_unit ? ` ${task.progress_unit}` : ""}`
    : undefined;
  const displayPercent = isFailed
    ? typeof task.progress_pct === "number" &&
      Number.isFinite(task.progress_pct)
      ? Math.max(0, Math.min(100, task.progress_pct))
      : 0
    : isCompleted
      ? 100
      : isPartialSuccess
        ? typeof task.progress_pct === "number" &&
          Number.isFinite(task.progress_pct)
          ? Math.max(0, Math.min(100, task.progress_pct))
          : 90
        : progress.percent;

  const tone: "primary" | "success" | "warning" | "danger" = isFailed
    ? "danger"
    : isCompleted
      ? "success"
      : isPartialSuccess
        ? "warning"
        : "primary";

  return (
    <AiProgressBar
      active={isActive}
      className="mt-2.5"
      detail={detail}
      label={
        task.stage_label_vi ||
        t(
          "taskCenter.progressAria",
          { title: task.title_vi },
          "Tiến độ {title}",
        )
      }
      percent={displayPercent}
      size="sm"
      testId={`task-progress-${task.id}`}
      tone={tone}
    />
  );
}
