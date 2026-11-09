"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  Lightbulb,
  Minus,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import { Button } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import type { ChildProgressAssessment } from "@/lib/api/child-progress-service";
import { cn } from "@/lib/utils/cn";

const PERIODS = [7, 30, 90] as const;
const GRADE_STYLES: Record<string, string> = {
  EXCELLENT: "bg-success-surface text-success-ink",
  GOOD: "bg-sky text-primary-hover",
  FAIR: "bg-warning-surface text-ink",
  NEEDS_SUPPORT: "bg-danger-surface text-danger",
};

type View =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      data: ChildProgressAssessment;
      ai: "idle" | "writing" | "failed";
    };

function shortDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}/${month}`;
}

function ScoreRing({ score }: { readonly score: number | null }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const filled = score === null ? 0 : (score / 100) * circumference;
  return (
    <div className="relative size-36 shrink-0">
      <svg
        aria-hidden="true"
        className="size-full -rotate-90"
        viewBox="0 0 120 120"
      >
        <circle
          className="stroke-border"
          cx="60"
          cy="60"
          fill="none"
          r={radius}
          strokeWidth="12"
        />
        <circle
          className="stroke-primary transition-[stroke-dasharray] duration-700"
          cx="60"
          cy="60"
          fill="none"
          r={radius}
          strokeDasharray={`${filled} ${circumference}`}
          strokeLinecap="round"
          strokeWidth="12"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-extrabold text-ink">{score ?? "–"}</span>
        <span className="text-label font-bold text-muted">/ 100</span>
      </div>
    </div>
  );
}

function TrendBadge({ delta }: { readonly delta: number | null }) {
  if (delta === null) return null;
  const up = delta >= 3;
  const down = delta <= -3;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-control px-2 py-1 text-label font-bold",
        up
          ? "bg-success-surface text-success-ink"
          : down
            ? "bg-warning-surface text-ink"
            : "bg-sky text-primary-hover",
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
      {up || down
        ? `${delta > 0 ? "+" : ""}${delta} điểm so với kỳ trước`
        : "Ổn định so với kỳ trước"}
    </span>
  );
}

function ComponentBar({
  component,
}: {
  readonly component: ChildProgressAssessment["score"]["components"][number];
}) {
  const { score } = component;
  return (
    <li className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-extrabold text-ink">{component.label}</span>
        <span className="text-label font-extrabold text-primary">
          {score === null ? "Chưa đủ dữ liệu" : `${score}/100`}
        </span>
      </div>
      <div
        aria-label={`${component.label}: ${score === null ? "chưa đủ dữ liệu" : `${score} trên 100`}`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={score ?? undefined}
        className="h-3 overflow-hidden rounded-full bg-border"
        role="progressbar"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700",
            score !== null && score < 55 ? "bg-book-orange" : "bg-primary",
          )}
          style={{ width: `${score ?? 0}%` }}
        />
      </div>
      <p className="text-label text-muted">{component.detail}</p>
    </li>
  );
}

function WeeklyChart({
  weekly,
}: {
  readonly weekly: ChildProgressAssessment["weekly"];
}) {
  const maxMinutes = Math.max(...weekly.map((week) => week.minutes), 1);
  return (
    <section aria-labelledby="progress-weekly-title" className="space-y-3">
      <h3
        className="text-lg font-extrabold text-ink"
        id="progress-weekly-title"
      >
        Thời gian đọc theo tuần
      </h3>
      <div aria-hidden="true" className="flex h-36 items-end gap-3">
        {weekly.map((week) => (
          <div
            className="flex h-full min-w-0 flex-1 flex-col justify-end text-center"
            key={week.week_start}
          >
            <span className="mb-1 text-xs font-bold text-muted">
              {week.accuracy_pct === null
                ? ""
                : `${Math.round(week.accuracy_pct)}%`}
            </span>
            <div
              className="mx-auto w-full max-w-12 rounded-t-control bg-primary/80"
              style={{
                height: `${Math.max(4, (week.minutes / maxMinutes) * 88)}px`,
              }}
              title={`${week.minutes} phút`}
            />
            <span className="mt-2 text-xs font-bold text-muted">
              {shortDate(week.week_start)}
            </span>
          </div>
        ))}
      </div>
      <p className="text-label text-muted">
        Cột cao là đọc nhiều phút hơn; số % phía trên là tỉ lệ đọc đúng của
        tuần.
      </p>
      <ul className="sr-only">
        {weekly.map((week) => (
          <li key={week.week_start}>
            Tuần từ {shortDate(week.week_start)}: {week.sessions} buổi,{" "}
            {week.minutes} phút
            {week.accuracy_pct === null
              ? ""
              : `, đọc đúng ${Math.round(week.accuracy_pct)}%`}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ListSection({
  title,
  tone,
  children,
}: {
  readonly title: string;
  readonly tone: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("space-y-3 rounded-card p-4 sm:p-5", tone)}>
      <h3 className="text-lg font-extrabold text-ink">{title}</h3>
      {children}
    </section>
  );
}

export function ChildProgressAssessmentCard({
  childId,
  childName,
}: {
  readonly childId: string;
  readonly childName: string;
}) {
  const service = useContext(AppServicesContext)?.childProgressService;
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [view, setView] = useState<View>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!service) return;
    const request = ++requestRef.current;
    const controller = new AbortController();
    const isCurrent = () => requestRef.current === request;

    service
      .get(childId, days, controller.signal)
      .then((data) => {
        if (!isCurrent()) return;
        const needsAi =
          data.data_status === "OK" && data.assessment.source !== "AI";
        setView({ status: "ready", data, ai: needsAi ? "writing" : "idle" });
        if (!needsAi) return;
        service
          .generate(childId, days, { signal: controller.signal })
          .then((next) => {
            if (!isCurrent()) return;
            setView({
              status: "ready",
              data: next,
              ai: next.assessment.source === "AI" ? "idle" : "failed",
            });
          })
          .catch(() => {
            if (!isCurrent()) return;
            setView((current) =>
              current.status === "ready"
                ? { ...current, ai: "failed" }
                : current,
            );
          });
      })
      .catch(() => {
        if (isCurrent()) setView({ status: "error" });
      });

    return () => {
      requestRef.current += 1;
      controller.abort();
    };
  }, [service, childId, days, reloadKey]);

  const refreshAi = useCallback(() => {
    if (!service || view.status !== "ready") return;
    const request = ++requestRef.current;
    setView({ ...view, ai: "writing" });
    service
      .generate(childId, days, { refresh: true })
      .then((next) => {
        if (requestRef.current !== request) return;
        setView({
          status: "ready",
          data: next,
          ai: next.assessment.source === "AI" ? "idle" : "failed",
        });
      })
      .catch(() => {
        if (requestRef.current !== request) return;
        setView((current) =>
          current.status === "ready" ? { ...current, ai: "failed" } : current,
        );
      });
  }, [service, view, childId, days]);

  // Without the service (tests, demos) the saved-report screen stays unchanged.
  if (!service) return null;

  return (
    <section
      aria-labelledby="ai-progress-title"
      className="rounded-card bg-white p-5 shadow-[0_12px_32px_rgba(33,65,86,0.06)] sm:p-8"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="inline-flex items-center gap-2 text-label font-extrabold uppercase tracking-wide text-purple-ink">
            <Sparkles aria-hidden="true" className="size-4" />
            Đánh giá bằng AI
          </p>
          <h2
            className="text-2xl font-extrabold text-ink"
            id="ai-progress-title"
          >
            {childName} đang đọc thế nào?
          </h2>
          <p className="text-label text-muted">
            Điểm được tính từ dữ liệu đọc thật của bé; AI chỉ viết nhận xét và
            gợi ý.
          </p>
        </div>
        <div
          aria-label="Khoảng thời gian đánh giá"
          className="inline-flex shrink-0 rounded-control bg-sky p-1"
          role="radiogroup"
        >
          {PERIODS.map((option) => (
            <button
              aria-checked={days === option}
              className={cn(
                "rounded-control px-3 py-2 text-label font-bold transition focus-visible:outline-3 focus-visible:outline-primary",
                days === option
                  ? "bg-primary text-white"
                  : "text-primary-hover hover:bg-white",
              )}
              key={option}
              onClick={() => {
                if (option === days) return;
                setView({ status: "loading" });
                setDays(option);
              }}
              role="radio"
              type="button"
            >
              {option} ngày
            </button>
          ))}
        </div>
      </div>

      {view.status === "loading" ? (
        <div
          aria-busy="true"
          aria-label="Đang tính điểm tiến bộ"
          className="mt-6 space-y-4"
        >
          <Skeleton className="h-40 rounded-card" />
          <Skeleton className="h-24 rounded-card" />
        </div>
      ) : view.status === "error" ? (
        <div className="mt-6 space-y-4">
          <StatusMessage title="Chưa tải được đánh giá" tone="error">
            Có lỗi xảy ra. Ba mẹ có thể thử lại, báo cáo đã lưu bên dưới không
            bị ảnh hưởng.
          </StatusMessage>
          <Button
            className="sm:w-auto"
            onClick={() => {
              setView({ status: "loading" });
              setReloadKey((key) => key + 1);
            }}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-5" />
            Thử lại
          </Button>
        </div>
      ) : (
        <AssessmentBody onRefresh={refreshAi} view={view} />
      )}
    </section>
  );
}

function AssessmentBody({
  view,
  onRefresh,
}: {
  readonly view: Extract<View, { status: "ready" }>;
  readonly onRefresh: () => void;
}) {
  const { data } = view;
  const { score, metrics, assessment } = data;
  const actionsFor = (audience: "PARENT" | "CHILD") =>
    assessment.actions.filter((action) => action.audience === audience);

  return (
    <div className="mt-6 space-y-8">
      <p className="text-label text-muted">
        Kỳ {shortDate(data.period_start)} → {shortDate(data.period_end)} (
        {data.days} ngày)
      </p>

      <div className="grid gap-6 lg:grid-cols-[auto_1fr] lg:items-center">
        <div className="flex flex-col items-center gap-3 sm:flex-row lg:flex-col">
          <ScoreRing score={score.overall} />
          <div className="flex flex-col items-center gap-2 sm:items-start lg:items-center">
            {score.grade_label ? (
              <span
                className={cn(
                  "rounded-control px-3 py-1 text-lg font-extrabold",
                  GRADE_STYLES[score.grade ?? ""] ??
                    "bg-sky text-primary-hover",
                )}
              >
                {score.grade_label}
              </span>
            ) : (
              <span className="rounded-control bg-sky px-3 py-1 text-lg font-extrabold text-primary-hover">
                Chưa đủ dữ liệu
              </span>
            )}
            <TrendBadge delta={score.delta} />
          </div>
        </div>
        <ul className="space-y-4">
          {score.components.map((component) => (
            <ComponentBar component={component} key={component.key} />
          ))}
        </ul>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Buổi đọc", `${metrics.sessions}`],
          ["Phút đọc", `${metrics.reading_minutes}`],
          ["Từ đã đọc", `${metrics.words_read}`],
          [
            "Đọc đúng",
            metrics.accuracy_pct === null
              ? "–"
              : `${Math.round(metrics.accuracy_pct)}%`,
          ],
        ].map(([label, value]) => (
          <div className="rounded-card bg-cream p-4 text-center" key={label}>
            <dt className="text-label font-bold text-muted">{label}</dt>
            <dd className="text-2xl font-extrabold text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      {data.weekly.some((week) => week.minutes > 0) ? (
        <WeeklyChart weekly={data.weekly} />
      ) : null}

      <div
        className="space-y-4 rounded-card border-2 border-border p-4 sm:p-6"
        aria-live="polite"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            className={cn(
              "inline-flex items-center gap-2 rounded-control px-3 py-1 text-label font-extrabold",
              assessment.source === "AI"
                ? "bg-purple/20 text-purple-ink"
                : "bg-sky text-primary-hover",
            )}
          >
            <Sparkles aria-hidden="true" className="size-4" />
            {assessment.source === "AI"
              ? "Nhận xét do AI viết"
              : "Nhận xét tự động từ số liệu"}
          </p>
          {data.data_status === "OK" ? (
            <Button
              className="h-11 w-auto px-4 text-label"
              disabled={view.ai === "writing"}
              isLoading={view.ai === "writing"}
              onClick={onRefresh}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {view.ai === "writing"
                ? "AI đang viết nhận xét…"
                : "Nhờ AI nhận xét lại"}
            </Button>
          ) : null}
        </div>

        {view.ai === "failed" ? (
          <StatusMessage tone="warning">
            Chưa kết nối được AI nên đang hiển thị nhận xét tự động từ số liệu.
            Ba mẹ có thể bấm “Nhờ AI nhận xét lại” sau.
          </StatusMessage>
        ) : null}

        <h3 className="text-xl font-extrabold text-ink">
          {assessment.headline}
        </h3>
        <p className="text-body text-ink">{assessment.summary}</p>

        <div className="grid gap-4 lg:grid-cols-2">
          {assessment.strengths.length > 0 ? (
            <ListSection title="Bé làm tốt" tone="bg-success-surface/50">
              <ul className="list-disc space-y-2 pl-5 text-ink">
                {assessment.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </ListSection>
          ) : null}
          {assessment.weaknesses.length > 0 ? (
            <ListSection title="Bé cần cải thiện" tone="bg-warning-surface/60">
              <ul className="space-y-3">
                {assessment.weaknesses.map((item) => (
                  <li className="flex gap-2" key={item.area}>
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-book-orange"
                    />
                    <span>
                      <strong className="block text-ink">{item.area}</strong>
                      <span className="text-muted">{item.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </ListSection>
          ) : null}
        </div>

        <section className="space-y-3">
          <h3 className="inline-flex items-center gap-2 text-lg font-extrabold text-ink">
            <Lightbulb aria-hidden="true" className="size-5 text-book-orange" />
            Cần làm gì để bé tốt hơn
          </h3>
          <div className="grid gap-4 lg:grid-cols-2">
            {(
              [
                ["PARENT", "Ba mẹ có thể làm"],
                ["CHILD", "Bé có thể làm"],
              ] as const
            ).map(([audience, title]) =>
              actionsFor(audience).length > 0 ? (
                <div
                  className="space-y-2 rounded-card bg-cream p-4"
                  key={audience}
                >
                  <h4 className="font-extrabold text-purple-ink">{title}</h4>
                  <ul className="space-y-3">
                    {actionsFor(audience).map((action) => (
                      <li key={action.title}>
                        <strong className="block text-ink">
                          {action.title}
                        </strong>
                        <span className="text-muted">{action.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
          </div>
        </section>

        {assessment.practice_words.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-lg font-extrabold text-ink">
              Từ bé nên luyện thêm
            </h3>
            <ul className="flex flex-wrap gap-2">
              {assessment.practice_words.map((word) => {
                const detail = data.difficult_words.find(
                  (item) => item.word === word,
                );
                return (
                  <li
                    className="rounded-control bg-sky px-3 py-1.5 font-bold text-primary-hover"
                    key={word}
                    title={
                      detail?.heard_as
                        ? `Bé thường đọc thành “${detail.heard_as}” (${detail.times} lần)`
                        : `Sai ${detail?.times ?? 0} lần`
                    }
                  >
                    {word}
                    {detail?.heard_as ? (
                      <span className="ml-1 text-xs font-medium text-muted">
                        (đọc thành “{detail.heard_as}”)
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <p className="rounded-card bg-primary/10 p-4 text-center text-lg font-extrabold text-primary-hover">
          {assessment.encouragement}
        </p>
      </div>
    </div>
  );
}
