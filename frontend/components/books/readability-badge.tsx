"use client";

import { BookCheck, Sparkles } from "lucide-react";

import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

export interface VietnameseReadabilityBadgeData {
  readonly estimated_grade_band:
    "GRADE_1" | "GRADE_2" | "GRADE_3" | "GRADE_4_5" | "UNRATED";
  readonly estimated_min_grade: number;
  readonly estimated_max_grade: number;
  readonly grade_match_status: "MATCHED" | "TOO_HARD" | "TOO_EASY" | "UNRATED";
  readonly phonics_readiness_score: number;
  readonly avg_syllables_per_sentence?: number;
  readonly explanation_vi?: string;
}

interface ReadabilityBadgeProps {
  readonly readability?: VietnameseReadabilityBadgeData | null;
  readonly className?: string;
}

export function ReadabilityBadge({
  readability,
  className,
}: ReadabilityBadgeProps) {
  const t = useTranslations("books");

  if (!readability || readability.estimated_grade_band === "UNRATED") {
    return null;
  }

  const statusTone =
    readability.grade_match_status === "MATCHED"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
      : readability.grade_match_status === "TOO_HARD"
        ? "border-amber-300 bg-amber-50 text-amber-950"
        : "border-sky-300 bg-sky/70 text-primary-hover";

  const statusLabel =
    readability.grade_match_status === "MATCHED"
      ? t("readability.matched")
      : readability.grade_match_status === "TOO_HARD"
        ? t("readability.tooHard", {
            min: readability.estimated_min_grade,
            max: readability.estimated_max_grade,
          })
        : readability.grade_match_status === "TOO_EASY"
          ? t("readability.tooEasy", {
              min: readability.estimated_min_grade,
              max: readability.estimated_max_grade,
            })
          : t("readability.estimatedGrade", {
              min: readability.estimated_min_grade,
              max: readability.estimated_max_grade,
            });

  const readinessRounded = Math.round(readability.phonics_readiness_score);

  return (
    <span
      className={cn("inline-flex flex-wrap items-center gap-1.5", className)}
      data-testid="vietnamese-readability-badge"
      title={readability.explanation_vi || undefined}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-bold",
          statusTone,
        )}
      >
        <BookCheck aria-hidden="true" className="size-3 shrink-0" />
        {statusLabel}
      </span>
      <span className="inline-flex items-center gap-1 rounded-full border border-teal-200 bg-teal-50/80 px-2.5 py-0.5 text-[11px] font-bold text-teal-900">
        <Sparkles aria-hidden="true" className="size-3 shrink-0" />
        {t("readability.phonicsScore", { score: readinessRounded })}
      </span>
    </span>
  );
}
