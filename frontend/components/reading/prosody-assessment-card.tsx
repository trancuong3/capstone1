"use client";

import { Mic, Sparkles, TrendingUp } from "lucide-react";

import type {
  GradeBandVerdict,
  ProsodyAnalysisResponse,
} from "@/lib/api/fluency-prosody-service";
import { cn } from "@/lib/utils/cn";
import { useProsodyCoachTranslations } from "@/messages/features/prosody_coach";

export interface ProsodyAssessmentCardProps {
  readonly result: ProsodyAnalysisResponse;
  readonly className?: string;
}

const BAND_TEXT_CLASSES: Record<GradeBandVerdict, string> = {
  EXCELLENT: "text-emerald-700",
  GOOD: "text-sky-700",
  DEVELOPING: "text-amber-700",
  NEEDS_PRACTICE: "text-rose-700",
};

const BAND_SURFACE_CLASSES: Record<GradeBandVerdict, string> = {
  EXCELLENT: "border-emerald-200 bg-emerald-50/80",
  GOOD: "border-sky-200 bg-sky-50/80",
  DEVELOPING: "border-amber-200 bg-amber-50/80",
  NEEDS_PRACTICE: "border-rose-200 bg-rose-50/80",
};

function ScoreMeter({
  label,
  score,
  accentClass,
}: {
  label: string;
  score: number;
  accentClass: string;
}) {
  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  const fillClass =
    rounded >= 84
      ? "bg-emerald-500"
      : rounded >= 68
        ? "bg-sky-500"
        : rounded >= 50
          ? "bg-amber-500"
          : "bg-rose-500";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-ink">{label}</span>
        <span className={cn("font-bold tabular-nums", accentClass)}>
          {rounded}/100
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            fillClass,
          )}
          style={{ width: `${rounded}%` }}
          role="progressbar"
          aria-valuenow={rounded}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        />
      </div>
    </div>
  );
}

export function ProsodyAssessmentCard({
  result,
  className,
}: ProsodyAssessmentCardProps) {
  const tp = useProsodyCoachTranslations();
  const bandColor = BAND_TEXT_CLASSES[result.grade_band_verdict];
  const bandSurface = BAND_SURFACE_CLASSES[result.grade_band_verdict];

  const bandLabel =
    result.grade_band_verdict === "EXCELLENT"
      ? tp("gradeBandExcellent")
      : result.grade_band_verdict === "GOOD"
        ? tp("gradeBandGood")
        : result.grade_band_verdict === "DEVELOPING"
          ? tp("gradeBandDeveloping")
          : tp("gradeBandNeedsPractice");

  return (
    <section
      data-testid="prosody-assessment-card"
      aria-label={tp("cardTitle")}
      className={cn(
        "space-y-4 rounded-2xl border border-border bg-white p-4 shadow-2xs sm:p-5",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-violet-100">
          <Mic className="size-4 text-violet-700" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold leading-tight text-ink sm:text-base">
            {tp("cardTitle")}
          </h3>
          <p className="text-xs text-muted">{tp("cardSubtitle")}</p>
        </div>
      </div>

      <div
        className={cn(
          "flex items-center justify-between gap-3 rounded-xl border px-4 py-3",
          bandSurface,
        )}
      >
        <div>
          <p className="text-xs font-medium text-muted">
            {tp("cardOverallLabel")}
          </p>
          <p
            data-testid="prosody-overall-score"
            className={cn(
              "mt-0.5 text-2xl font-extrabold leading-none tabular-nums",
              bandColor,
            )}
          >
            {Math.round(result.overall_prosody_score)}
            <span className="ms-0.5 text-sm font-semibold text-muted">
              /100
            </span>
          </p>
        </div>
        <div className="text-end">
          <p
            data-testid="prosody-grade-verdict"
            className={cn("text-sm font-bold", bandColor)}
          >
            {bandLabel}
          </p>
          <div className="mt-0.5 flex items-center justify-end gap-1">
            <TrendingUp className="size-3 text-muted" aria-hidden="true" />
            <span className="text-xs text-muted">{tp("cardGradeRange")}</span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <ScoreMeter
          label={tp("cardMeterComma")}
          score={result.comma_pause_score}
          accentClass={bandColor}
        />
        <ScoreMeter
          label={tp("cardMeterPeriod")}
          score={result.period_pause_score}
          accentClass={bandColor}
        />
        <ScoreMeter
          label={tp("cardMeterIntonation")}
          score={result.intonation_contour_score}
          accentClass={bandColor}
        />
      </div>

      <div
        data-testid="prosody-coaching-tip"
        className="flex items-start gap-2 rounded-xl border border-violet-100 bg-violet-50/90 px-3.5 py-3"
      >
        <Sparkles
          className="mt-0.5 size-4 shrink-0 text-violet-700"
          aria-hidden="true"
        />
        <p className="text-sm leading-relaxed text-violet-950" lang="vi">
          {result.coaching_tip_vi}
        </p>
      </div>
    </section>
  );
}
