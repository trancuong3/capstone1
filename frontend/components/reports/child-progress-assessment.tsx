"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  Lightbulb,
  Minus,
  RefreshCw,
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
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import type { ChildProgressAssessment } from "@/lib/api/child-progress-service";
import { cn } from "@/lib/utils/cn";

const PERIODS = [7, 30, 90] as const;
const GRADE_STYLES: Record<string, string> = {
  EXCELLENT: "border border-success-ink/20 bg-success-surface text-success-ink",
  GOOD: "border border-primary/20 bg-sky text-primary-hover",
  FAIR: "border border-warning/25 bg-warning-surface text-warning",
  NEEDS_SUPPORT: "border border-danger/20 bg-danger-surface text-danger",
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

function TrendBadge({ delta }: { readonly delta: number | null }) {
  if (delta === null) return null;
  const up = delta >= 3;
  const down = delta <= -3;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-control px-2.5 py-1 text-xs font-bold tabular-nums",
        up
          ? "bg-success-surface text-success-ink"
          : down
            ? "bg-warning-surface text-warning"
            : "bg-canvas text-muted ring-1 ring-inset ring-border",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
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
        <span className="text-sm font-bold text-ink">{component.label}</span>
        <span
          className={cn(
            "text-sm font-extrabold tabular-nums",
            score === null ? "text-muted" : "text-primary",
          )}
        >
          {score === null ? "Chưa đủ dữ liệu" : `${score}/100`}
        </span>
      </div>
      <div
        aria-label={`${component.label}: ${score === null ? "chưa đủ dữ liệu" : `${score} trên 100`}`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={score ?? undefined}
        className="h-2.5 overflow-hidden rounded-full bg-canvas ring-1 ring-inset ring-border/70"
        role="progressbar"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            score !== null && score < 55 ? "bg-warning/70" : "bg-primary",
          )}
          style={{ width: `${score ?? 0}%` }}
        />
      </div>
      <p className="text-xs leading-5 text-muted">{component.detail}</p>
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
    <section
      aria-labelledby="progress-weekly-title"
      className="space-y-3 rounded-card border border-border bg-cream/60 p-3.5 md:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3
          className="text-base font-extrabold text-ink"
          id="progress-weekly-title"
        >
          Thời gian đọc theo tuần
        </h3>
        <span className="text-xs font-semibold text-muted">
          Chiều cao: phút đọc · Nhãn trên cột: tỷ lệ đọc đúng
        </span>
      </div>
      <div className="overflow-x-auto pb-0.5">
        <div
          aria-hidden="true"
          className="flex h-40 items-end gap-1.5 border-b border-border pt-2 min-[640px]:gap-4"
        >
          {weekly.map((week) => {
            const barHeight =
              week.minutes > 0
                ? Math.max(10, Math.round((week.minutes / maxMinutes) * 92))
                : 3;
            return (
              <div
                className={cn(
                  "flex h-full flex-1 flex-col justify-end text-center",
                  weekly.length > 6 ? "min-w-[2.5rem]" : "min-w-0",
                )}
                key={week.week_start}
              >
                <span className="mb-1 text-xs font-bold tabular-nums text-primary">
                  {week.accuracy_pct === null
                    ? "–"
                    : `${Math.round(week.accuracy_pct)}%`}
                </span>
                <div
                  className={cn(
                    "mx-auto w-full max-w-12 rounded-t-control",
                    week.minutes > 0 ? "bg-primary/85" : "bg-border",
                  )}
                  style={{ height: `${barHeight}px` }}
                  title={`${week.minutes} phút (${week.sessions} buổi)`}
                />
                <span className="mt-1.5 text-[11px] font-bold tabular-nums text-ink">
                  {week.minutes}p
                </span>
                <span className="pb-1.5 text-[11px] font-semibold tabular-nums text-muted">
                  {shortDate(week.week_start)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
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

function InsightColumn({
  title,
  tone,
  children,
}: {
  readonly title: string;
  readonly tone: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("space-y-2.5 rounded-control border p-4", tone)}>
      <h4 className="text-sm font-extrabold text-ink">{title}</h4>
      {children}
    </section>
  );
}

export function ChildProgressAssessmentCard({
  childId,
  childName,
  showReadingAssessment = true,
}: {
  readonly childId: string;
  readonly childName: string;
  readonly showReadingAssessment?: boolean;
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
      className="rounded-card border border-border bg-white p-4 md:p-6"
    >
      <div className="flex flex-col gap-3 border-b border-border pb-4 min-[640px]:flex-row min-[640px]:items-end min-[640px]:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-bold text-primary">
            Đánh giá động theo khoảng ngày gần đây
          </p>
          <h2
            className="text-xl font-extrabold text-ink md:text-2xl"
            id="ai-progress-title"
          >
            {childName} đang đọc thế nào?
          </h2>
          <p className="text-sm text-muted">
            Tính trực tiếp trên các buổi đọc gần đây (độc lập với kỳ báo cáo đã
            lưu ở trên).
          </p>
        </div>

        <div
          aria-label="Khoảng thời gian đánh giá"
          className="inline-flex max-w-full shrink-0 self-start rounded-control border border-border bg-canvas p-1 min-[640px]:self-auto"
          role="radiogroup"
        >
          {PERIODS.map((option) => (
            <button
              aria-checked={days === option}
              className={cn(
                "min-h-11 rounded-control px-3 text-sm font-bold transition-colors focus-visible:outline-3 focus-visible:outline-primary min-[640px]:px-3.5",
                days === option
                  ? "bg-primary text-white"
                  : "text-ink hover:bg-white",
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
          className="mt-5 space-y-4"
        >
          <Skeleton className="h-32 rounded-card" />
          <Skeleton className="h-24 rounded-card" />
        </div>
      ) : view.status === "error" ? (
        <div className="mt-5 space-y-4">
          <StatusMessage title="Chưa tải được đánh giá" tone="error">
            Có lỗi xảy ra. Ba mẹ có thể thử lại, báo cáo theo kỳ đã lưu ở trên
            không bị ảnh hưởng.
          </StatusMessage>
          <Button
            className="min-[640px]:w-auto min-[640px]:self-start"
            onClick={() => {
              setView({ status: "loading" });
              setReloadKey((key) => key + 1);
            }}
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Thử lại
          </Button>
        </div>
      ) : (
        <AssessmentBody
          onRefresh={refreshAi}
          showReadingAssessment={showReadingAssessment}
          view={view}
        />
      )}
    </section>
  );
}

function AssessmentBody({
  view,
  onRefresh,
  showReadingAssessment,
}: {
  readonly view: Extract<View, { status: "ready" }>;
  readonly onRefresh: () => void;
  readonly showReadingAssessment: boolean;
}) {
  const { data } = view;
  const { score, metrics, assessment } = data;
  const actionsFor = (audience: "PARENT" | "CHILD") =>
    assessment.actions.filter((action) => action.audience === audience);

  return (
    <div className="mt-5 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-muted">
        <p>
          Khoảng đánh giá: {shortDate(data.period_start)} →{" "}
          {shortDate(data.period_end)} ({data.days} ngày gần nhất)
        </p>
        <p className="tabular-nums">
          Cơ sở tính: {metrics.sessions} buổi · {metrics.reading_minutes} phút ·{" "}
          {metrics.words_read} từ
          {metrics.accuracy_pct !== null
            ? ` · ${Math.round(metrics.accuracy_pct)}% đọc đúng`
            : ""}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.25fr)] lg:items-start">
        <div className="flex flex-col gap-3 rounded-control border border-border bg-cream/70 p-4 md:p-5">
          <p className="text-xs font-bold text-muted">Điểm tổng hợp</p>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-4xl font-extrabold tracking-tight tabular-nums text-ink">
              {score.overall ?? "–"}
            </span>
            <span className="text-sm font-bold text-muted">/ 100</span>
            {score.grade_label ? (
              <span
                className={cn(
                  "ml-1 rounded-control px-2.5 py-0.5 text-sm font-bold",
                  GRADE_STYLES[score.grade ?? ""] ??
                    "bg-sky text-primary-hover",
                )}
              >
                {score.grade_label}
              </span>
            ) : (
              <span className="ml-1 rounded-control bg-canvas px-2.5 py-0.5 text-sm font-bold text-muted ring-1 ring-inset ring-border">
                Chưa đủ dữ liệu
              </span>
            )}
          </div>
          <div>
            <TrendBadge delta={score.delta} />
          </div>
        </div>

        {score.components.length > 0 ? (
          <ul className="space-y-3.5">
            {score.components.map((component) => (
              <ComponentBar component={component} key={component.key} />
            ))}
          </ul>
        ) : (
          <p className="rounded-control border border-dashed border-border bg-canvas p-4 text-sm text-muted">
            Chưa đủ buổi đọc trong {data.days} ngày gần nhất để tách điểm từng
            kỹ năng.
          </p>
        )}
      </div>

      {showReadingAssessment ? (
        <ReadingAssessmentSummary
          assessment={metrics.reading_assessment}
          scopeLabel={`${data.days} ngày gần nhất`}
        />
      ) : null}

      {data.weekly.some((week) => week.minutes > 0) ? (
        <WeeklyChart weekly={data.weekly} />
      ) : null}

      <div className="space-y-4 border-t border-border pt-5" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className={cn(
              "inline-flex items-center rounded-control px-2.5 py-1 text-xs font-bold",
              assessment.source === "AI"
                ? "border border-primary/20 bg-sky text-primary-hover"
                : "border border-border bg-canvas text-muted",
            )}
          >
            {assessment.source === "AI"
              ? "Nhận xét do AI viết"
              : "Nhận xét tự động từ số liệu"}
          </span>
          {data.data_status === "OK" ? (
            <Button
              className="min-h-11 w-auto px-3.5 text-sm"
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

        <div className="min-w-0 max-w-3xl space-y-1.5">
          <h3 className="break-words text-lg font-extrabold text-ink">
            {assessment.headline}
          </h3>
          <p className="break-words text-body leading-relaxed text-ink">
            {assessment.summary}
          </p>
        </div>

        {assessment.strengths.length > 0 || assessment.weaknesses.length > 0 ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {assessment.strengths.length > 0 ? (
              <InsightColumn
                title="Bé làm tốt"
                tone="border-success-ink/20 bg-success-surface/35"
              >
                <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink">
                  {assessment.strengths.map((item) => (
                    <li className="break-words" key={item}>
                      {item}
                    </li>
                  ))}
                </ul>
              </InsightColumn>
            ) : null}
            {assessment.weaknesses.length > 0 ? (
              <InsightColumn
                title="Bé cần cải thiện"
                tone="border-warning/25 bg-warning-surface/40"
              >
                <ul className="space-y-2.5 text-sm">
                  {assessment.weaknesses.map((item) => (
                    <li className="flex min-w-0 gap-2" key={item.area}>
                      <TriangleAlert
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-warning"
                      />
                      <span className="min-w-0 break-words">
                        <strong className="block font-bold text-ink">
                          {item.area}
                        </strong>
                        <span className="text-muted">{item.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </InsightColumn>
            ) : null}
          </div>
        ) : null}

        {assessment.actions.length > 0 ? (
          <section className="space-y-3">
            <h3 className="inline-flex items-center gap-2 text-base font-extrabold text-ink">
              <Lightbulb aria-hidden="true" className="size-4 text-primary" />
              Gợi ý đồng hành tiếp theo
            </h3>
            <div className="grid gap-3 lg:grid-cols-2">
              {(
                [
                  ["PARENT", "Ba mẹ có thể làm"],
                  ["CHILD", "Bé có thể làm"],
                ] as const
              ).map(([audience, title]) =>
                actionsFor(audience).length > 0 ? (
                  <div
                    className="min-w-0 space-y-2 rounded-control border border-border bg-cream/70 p-4"
                    key={audience}
                  >
                    <h4 className="text-sm font-extrabold text-primary">
                      {title}
                    </h4>
                    <ul className="space-y-2.5 text-sm">
                      {actionsFor(audience).map((action) => (
                        <li className="min-w-0 break-words" key={action.title}>
                          <strong className="block font-bold text-ink">
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
        ) : null}

        {assessment.practice_words.length > 0 ? (
          <section className="min-w-0 space-y-2">
            <h3 className="text-sm font-extrabold text-ink">
              Từ gợi ý luyện thêm ({data.days} ngày)
            </h3>
            <ul className="flex min-w-0 flex-wrap gap-2">
              {assessment.practice_words.map((word) => {
                const detail = data.difficult_words.find(
                  (item) => item.word === word,
                );
                return (
                  <li
                    className="max-w-full min-w-0 break-words rounded-control border border-border bg-canvas px-3 py-1.5 text-sm font-bold text-ink [overflow-wrap:anywhere]"
                    key={word}
                    title={
                      detail?.heard_as
                        ? `Bé thường đọc thành “${detail.heard_as}” (${detail.times} lần)`
                        : detail
                          ? `Ghi nhận ${detail.times} lần`
                          : undefined
                    }
                  >
                    {word}
                    {detail?.heard_as ? (
                      <span className="ml-1.5 text-xs font-medium text-muted">
                        (đọc thành “{detail.heard_as}”)
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {assessment.encouragement ? (
          <p className="break-words border-l-2 border-primary pl-3.5 text-sm font-semibold text-muted">
            {assessment.encouragement}
          </p>
        ) : null}
      </div>
    </div>
  );
}
