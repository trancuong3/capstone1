"use client";

import { ArrowRight, Sparkles, TrainFront } from "lucide-react";

import { ButtonLink } from "@/components/common/button";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

export interface FiveMinuteTrainCtaCardProps {
  readonly childId?: string | null;
  readonly childAlias?: string | null;
  readonly focusWords?: readonly string[];
  readonly sourceSurface?: "dashboard" | "reports" | "entertainment";
  readonly compact?: boolean;
  readonly className?: string;
}

export function FiveMinuteTrainCtaCard({
  childId,
  childAlias,
  focusWords,
  sourceSurface = "dashboard",
  compact = false,
  className,
}: FiveMinuteTrainCtaCardProps) {
  const { t } = useI18n();
  const cleanWords = (focusWords ?? [])
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 3);

  const query = new URLSearchParams();
  if (childId) {
    query.set("childId", childId);
  }
  if (sourceSurface) {
    query.set("from", sourceSurface);
  }
  const href = query.size
    ? `/learning-train?${query.toString()}`
    : "/learning-train";

  return (
    <aside
      aria-label={t("fiveMinTrain.cta.title")}
      className={cn(
        "@container rounded-card border border-emerald-200/90 bg-gradient-to-r from-emerald-50/85 via-cream to-amber-50/75 shadow-xs",
        className,
      )}
      data-testid="five-minute-train-cta-card"
    >
      <div
        className={cn(
          "flex flex-col justify-between gap-3.5 @[560px]:flex-row @[560px]:items-center",
          compact ? "p-3.5 @[560px]:p-4" : "p-4 @[560px]:p-5",
        )}
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-0.5 text-xs font-extrabold text-emerald-800 shadow-xs">
              <TrainFront aria-hidden="true" className="size-3.5 shrink-0" />
              {t("fiveMinTrain.cta.badge")}
            </span>
          </div>

          <h3
            className={cn(
              "font-extrabold text-ink",
              compact
                ? "text-sm @[560px]:text-base"
                : "text-base @[560px]:text-lg",
            )}
          >
            {t("fiveMinTrain.cta.title")}
          </h3>

          <p className="text-xs leading-relaxed text-muted @[560px]:text-sm">
            {childAlias
              ? t("fiveMinTrain.cta.descriptionWithChild", {
                  alias: childAlias,
                })
              : t("fiveMinTrain.cta.descriptionGeneric")}
          </p>

          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px] font-bold text-emerald-950">
            <span className="rounded-full bg-white/90 px-2.5 py-0.5">
              {t("fiveMinTrain.cta.car1Chip")}
            </span>
            <span aria-hidden="true" className="text-muted">
              →
            </span>
            <span className="rounded-full bg-white/90 px-2.5 py-0.5">
              {t("fiveMinTrain.cta.car2Chip")}
            </span>
            <span aria-hidden="true" className="text-muted">
              →
            </span>
            <span className="rounded-full bg-white/90 px-2.5 py-0.5">
              {t("fiveMinTrain.cta.car3Chip")}
            </span>
          </div>

          {cleanWords.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs">
              <span className="inline-flex items-center gap-1 font-semibold text-muted">
                <Sparkles
                  aria-hidden="true"
                  className="size-3 text-amber-600"
                />
                {t("fiveMinTrain.cta.focusWordsLabel")}
              </span>
              <span
                className="viread-learning-content rounded-full border border-amber-200 bg-white px-2.5 py-0.5 font-bold text-amber-900"
                dir="ltr"
                lang="vi"
              >
                {cleanWords.join(" · ")}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center">
          <ButtonLink
            className="min-h-12 w-full whitespace-nowrap @[560px]:w-auto"
            data-testid="five-minute-train-launch-btn"
            href={href}
            size="compact"
          >
            {childId
              ? t("fiveMinTrain.cta.launchAction")
              : t("fiveMinTrain.cta.selectChildAction")}{" "}
            <ArrowRight
              aria-hidden="true"
              className="viread-rtl-flip size-4 shrink-0"
            />
          </ButtonLink>
        </div>
      </div>
    </aside>
  );
}
