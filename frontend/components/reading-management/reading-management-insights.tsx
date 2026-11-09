import { Flame, Hourglass, CheckCircle2, CalendarDays } from "lucide-react";

import type {
  ReadingGoalDTO,
  ReadingPlanDTO,
} from "@/types/reading-management";

const dayNames = [
  "Chủ nhật",
  "Thứ hai",
  "Thứ ba",
  "Thứ tư",
  "Thứ năm",
  "Thứ sáu",
  "Thứ bảy",
];

/** "2026-11-09" -> "09/11". Dates are calendar days, never shifted by time zone. */
export function shortDate(value: string): string {
  const [, month, day] = value.split("-");
  return `${day}/${month}`;
}

/** "2026-11-09" -> "Thứ hai, 09/11". */
export function dayLabel(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${dayNames[weekday]}, ${shortDate(value)}`;
}

export function goalCycleLabel(goal: ReadingGoalDTO): string | null {
  if (!goal.cycle_starts_on || !goal.cycle_ends_on) return null;
  if (goal.cycle_starts_on === goal.cycle_ends_on) {
    return `Ngày ${shortDate(goal.cycle_starts_on)}`;
  }
  return `${shortDate(goal.cycle_starts_on)} – ${shortDate(goal.cycle_ends_on)}`;
}

/** Goals that are live right now: not paused, finished, expired or upcoming. */
export function isRunningGoal(goal: ReadingGoalDTO): boolean {
  return goal.status === "ACTIVE" && (goal.phase ?? "RUNNING") === "RUNNING";
}

export function isRunningPlan(plan: ReadingPlanDTO): boolean {
  return plan.status === "ACTIVE" && (plan.phase ?? "RUNNING") === "RUNNING";
}

const noteClass =
  "mt-3 flex items-start gap-2 rounded-control px-3 py-2 text-label";

/** Extra lines for a goal card: cycle, phase hint and streak. */
export function GoalInsights({ goal }: { goal: ReadingGoalDTO }) {
  const phase = goal.phase ?? "RUNNING";
  const streak = goal.streak_cycles ?? 0;
  const cycle = goalCycleLabel(goal);
  const unit = goal.period === "DAILY" ? "ngày" : "tuần";
  const finished = goal.status === "COMPLETED" || goal.status === "ENDED";
  return (
    <>
      {cycle && !finished ? (
        <p className="mt-1 text-sm text-muted">
          {phase === "EXPIRED" ? "Chu kỳ cuối" : "Chu kỳ hiện tại"}: {cycle}
        </p>
      ) : null}
      {phase === "UPCOMING" ? (
        <p className={`${noteClass} bg-sky text-primary`} role="note">
          <Hourglass aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Mục tiêu chưa đến ngày bắt đầu ({shortDate(goal.starts_on)}).
        </p>
      ) : null}
      {phase === "EXPIRED" && !finished ? (
        <p className={`${noteClass} bg-cream text-ink`} role="note">
          <Hourglass aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Mục tiêu đã hết hạn
          {goal.ends_on ? ` từ ${shortDate(goal.ends_on)}` : ""}. Hãy chọn “Hoàn
          thành” hoặc “Kết thúc” để lưu kết quả.
        </p>
      ) : null}
      {streak > 0 && !finished ? (
        <p className={`${noteClass} bg-sky text-primary`}>
          <Flame aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>{streak}</strong> {unit} liên tiếp đạt mục tiêu
          </span>
        </p>
      ) : null}
    </>
  );
}

/** Extra lines for a plan card: today's progress or the next reading day. */
export function PlanInsights({ plan }: { plan: ReadingPlanDTO }) {
  const phase = plan.phase ?? "RUNNING";
  const finished = plan.status === "COMPLETED" || plan.status === "ENDED";
  if (finished) return null;
  if (phase === "UPCOMING") {
    return (
      <p className={`${noteClass} bg-sky text-primary`} role="note">
        <Hourglass aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        Kế hoạch bắt đầu từ {shortDate(plan.starts_on)}.
        {plan.next_scheduled_date
          ? ` Buổi đọc đầu tiên: ${dayLabel(plan.next_scheduled_date)}.`
          : ""}
      </p>
    );
  }
  if (phase === "EXPIRED") {
    return (
      <p className={`${noteClass} bg-cream text-ink`} role="note">
        <Hourglass aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        Kế hoạch đã hết hạn
        {plan.ends_on ? ` từ ${shortDate(plan.ends_on)}` : ""}; số liệu là của
        tuần cuối. Hãy chọn “Hoàn thành” hoặc “Kết thúc”.
      </p>
    );
  }
  if (plan.status === "PAUSED") return null;
  const minutes = plan.minutes_today ?? 0;
  if (plan.is_scheduled_today) {
    const reached = minutes >= plan.target_minutes;
    return (
      <p
        className={`${noteClass} ${reached ? "bg-sky text-primary" : "bg-white text-ink"}`}
      >
        {reached ? (
          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        ) : (
          <CalendarDays aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        )}
        <span>
          {reached ? "Hôm nay bé đã đọc đủ: " : "Hôm nay bé cần đọc: "}
          <strong>
            {minutes}/{plan.target_minutes} phút
          </strong>
        </span>
      </p>
    );
  }
  if (plan.next_scheduled_date) {
    return (
      <p className={`${noteClass} bg-white text-ink`}>
        <CalendarDays aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          Hôm nay không có lịch đọc. Buổi tiếp theo:{" "}
          <strong>{dayLabel(plan.next_scheduled_date)}</strong>
        </span>
      </p>
    );
  }
  return null;
}

interface TodaySummaryProps {
  readonly childName: string;
  readonly plans: readonly ReadingPlanDTO[];
  readonly goals: readonly ReadingGoalDTO[];
}

/** One glance at what the child should do today. */
export function TodaySummary({ childName, plans, goals }: TodaySummaryProps) {
  const todayPlans = plans.filter(
    (plan) => isRunningPlan(plan) && plan.is_scheduled_today,
  );
  const dailyGoals = goals.filter(
    (goal) => isRunningGoal(goal) && goal.period === "DAILY",
  );
  const nextPlan = plans
    .filter((plan) => plan.status === "ACTIVE" && plan.next_scheduled_date)
    .sort((a, b) =>
      (a.next_scheduled_date ?? "").localeCompare(b.next_scheduled_date ?? ""),
    )[0];

  return (
    <section
      aria-label="Hôm nay"
      className="rounded-card border border-border bg-white p-5 shadow-sm sm:p-6"
    >
      <h2 className="text-xl font-extrabold text-ink">
        Hôm nay {childName} cần đọc gì?
      </h2>
      {todayPlans.length === 0 && dailyGoals.length === 0 ? (
        <p className="mt-3 text-label text-muted">
          {nextPlan?.next_scheduled_date
            ? `Hôm nay không có lịch đọc. Buổi tiếp theo: ${dayLabel(nextPlan.next_scheduled_date)} (${nextPlan.title}).`
            : "Chưa có kế hoạch hoặc mục tiêu hằng ngày đang chạy. Hãy tạo kế hoạch bên dưới để bé có việc cần làm."}
        </p>
      ) : (
        <ul className="mt-4 grid gap-3 md:grid-cols-2">
          {todayPlans.map((plan) => {
            const minutes = plan.minutes_today ?? 0;
            const percent = Math.min(
              100,
              Math.round((minutes * 100) / plan.target_minutes),
            );
            return (
              <li key={plan.id} className="rounded-control bg-canvas p-3">
                <p className="font-bold text-ink">{plan.title}</p>
                {plan.book_title ? (
                  <p className="text-sm text-muted">Sách: {plan.book_title}</p>
                ) : null}
                <p className="mt-1 text-label text-ink">
                  {minutes}/{plan.target_minutes} phút hôm nay
                  {minutes >= plan.target_minutes ? " · Đã đủ" : ""}
                </p>
                <div
                  role="progressbar"
                  aria-label={`Tiến độ hôm nay: ${plan.title}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  className="mt-2 h-2 overflow-hidden rounded-full bg-white"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </li>
            );
          })}
          {dailyGoals.map((goal) => (
            <li key={goal.id} className="rounded-control bg-canvas p-3">
              <p className="font-bold text-ink">
                Mục tiêu {goal.target_value}{" "}
                {goal.metric === "MINUTES" ? "phút" : "buổi"} mỗi ngày
              </p>
              <p className="mt-1 text-label text-ink">
                {goal.current_value}/{goal.target_value}
                {goal.progress_percent >= 100 ? " · Đã đạt" : ""}
                {(goal.streak_cycles ?? 0) > 0
                  ? ` · ${goal.streak_cycles} ngày liên tiếp`
                  : ""}
              </p>
              <div
                role="progressbar"
                aria-label={`Tiến độ hôm nay: mục tiêu ${goal.target_value}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(goal.progress_percent)}
                className="mt-2 h-2 overflow-hidden rounded-full bg-white"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${goal.progress_percent}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
