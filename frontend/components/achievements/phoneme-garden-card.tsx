"use client";

import {
  BookMarked,
  Flower2,
  ShieldCheck,
  Sparkles,
  Sprout,
} from "lucide-react";

import { Button, ButtonLink } from "@/components/common/button";
import type {
  BedStage,
  PhonemeBedDTO,
  PhonemeGardenSummaryDTO,
  PlantSymbolKey,
} from "@/lib/api/phoneme-garden-service";
import { cn } from "@/lib/utils/cn";
import { usePhonemeGardenTranslations } from "@/messages/features/phoneme_garden";

const STAGE_BADGE_STYLES: Record<BedStage, string> = {
  SEED: "border-amber-200 bg-amber-50 text-amber-900",
  SPROUT: "border-lime-200 bg-lime-50 text-lime-900",
  BUD: "border-teal-200 bg-teal-50 text-teal-900",
  BLOOM: "border-emerald-300 bg-emerald-100 text-emerald-950",
};

const PLANT_PALETTE: Record<
  PlantSymbolKey,
  { readonly petal: string; readonly center: string; readonly accent: string }
> = {
  lotus: { petal: "#F472B6", center: "#FBBF24", accent: "#FBCFE8" },
  apricot: { petal: "#FACC15", center: "#D97706", accent: "#FEF08A" },
  bamboo: { petal: "#22C55E", center: "#15803D", accent: "#BBF7D0" },
  sunflower: { petal: "#FB923C", center: "#78350F", accent: "#FED7AA" },
  chrysanthemum: { petal: "#FBBF24", center: "#B45309", accent: "#FDE68A" },
  peach: { petal: "#FB7185", center: "#BE123C", accent: "#FECDD3" },
  flamboyant: { petal: "#EF4444", center: "#FDE047", accent: "#FCA5A5" },
};

function BotanicalBedIllustration({
  symbol,
  stage,
  label,
}: {
  readonly symbol: PlantSymbolKey;
  readonly stage: BedStage;
  readonly label: string;
}) {
  const palette = PLANT_PALETTE[symbol];
  return (
    <svg
      aria-label={label}
      className="h-24 w-24 shrink-0"
      role="img"
      viewBox="0 0 96 96"
    >
      {/* Warm sky halo */}
      <circle cx="48" cy="44" fill={palette.accent} opacity="0.38" r="34" />
      {/* Terracotta garden bed soil */}
      <ellipse cx="48" cy="80" fill="#A16207" opacity="0.28" rx="34" ry="8" />
      <ellipse cx="48" cy="78" fill="#78350F" opacity="0.55" rx="28" ry="6" />

      {stage === "SEED" ? (
        <g>
          <ellipse cx="48" cy="73" fill="#D97706" rx="8" ry="5.5" />
          <path
            d="M45 70 Q48 65 52 70"
            fill="none"
            stroke="#65A30D"
            strokeLinecap="round"
            strokeWidth="2.5"
          />
        </g>
      ) : null}

      {stage === "SPROUT" ? (
        <g>
          <path
            d="M48 77 Q48 60 48 52"
            fill="none"
            stroke="#16A34A"
            strokeLinecap="round"
            strokeWidth="4"
          />
          <ellipse
            cx="40"
            cy="58"
            fill="#4ADE80"
            rx="9"
            ry="5"
            transform="rotate(-28 40 58)"
          />
          <ellipse
            cx="56"
            cy="56"
            fill="#22C55E"
            rx="9"
            ry="5"
            transform="rotate(28 56 56)"
          />
        </g>
      ) : null}

      {stage === "BUD" ? (
        <g>
          <path
            d="M48 77 Q47 56 48 40"
            fill="none"
            stroke="#15803D"
            strokeLinecap="round"
            strokeWidth="4.5"
          />
          <ellipse
            cx="38"
            cy="61"
            fill="#4ADE80"
            rx="10"
            ry="5"
            transform="rotate(-25 38 61)"
          />
          <ellipse
            cx="58"
            cy="58"
            fill="#22C55E"
            rx="10"
            ry="5"
            transform="rotate(25 58 58)"
          />
          <ellipse cx="48" cy="36" fill={palette.petal} rx="9" ry="12" />
          <path
            d="M40 41 Q48 47 56 41"
            fill="none"
            stroke="#15803D"
            strokeLinecap="round"
            strokeWidth="3"
          />
        </g>
      ) : null}

      {stage === "BLOOM" ? (
        symbol === "bamboo" ? (
          <g>
            <rect fill="#15803D" height="50" rx="3" width="6" x="39" y="28" />
            <rect fill="#22C55E" height="44" rx="3" width="6" x="51" y="34" />
            <line
              stroke="#DCFCE7"
              strokeWidth="2"
              x1="39"
              x2="45"
              y1="44"
              y2="44"
            />
            <line
              stroke="#DCFCE7"
              strokeWidth="2"
              x1="39"
              x2="45"
              y1="60"
              y2="60"
            />
            <line
              stroke="#DCFCE7"
              strokeWidth="2"
              x1="51"
              x2="57"
              y1="50"
              y2="50"
            />
            <ellipse
              cx="30"
              cy="36"
              fill="#4ADE80"
              rx="11"
              ry="4.5"
              transform="rotate(-30 30 36)"
            />
            <ellipse
              cx="65"
              cy="40"
              fill="#22C55E"
              rx="11"
              ry="4.5"
              transform="rotate(28 65 40)"
            />
            <ellipse
              cx="63"
              cy="28"
              fill="#86EFAC"
              rx="10"
              ry="4"
              transform="rotate(-18 63 28)"
            />
          </g>
        ) : (
          <g>
            <path
              d="M48 77 Q47 56 48 38"
              fill="none"
              stroke="#15803D"
              strokeLinecap="round"
              strokeWidth="4.5"
            />
            <ellipse
              cx="37"
              cy="62"
              fill="#4ADE80"
              rx="10"
              ry="5"
              transform="rotate(-26 37 62)"
            />
            <ellipse
              cx="59"
              cy="59"
              fill="#22C55E"
              rx="10"
              ry="5"
              transform="rotate(26 59 59)"
            />
            {[0, 60, 120, 180, 240, 300].map((angle) => (
              <ellipse
                cx="48"
                cy="24"
                fill={palette.petal}
                key={angle}
                rx="7.5"
                ry="12"
                transform={`rotate(${angle} 48 35)`}
              />
            ))}
            <circle cx="48" cy="35" fill={palette.center} r="8" />
          </g>
        )
      ) : null}
    </svg>
  );
}

function resolveStageLabel(
  stage: BedStage,
  t: ReturnType<typeof usePhonemeGardenTranslations>,
): string {
  switch (stage) {
    case "SEED":
      return t("stageSeed");
    case "SPROUT":
      return t("stageSprout");
    case "BUD":
      return t("stageBud");
    case "BLOOM":
      return t("stageBloom");
  }
}

function BedCard({
  bed,
  t,
}: {
  readonly bed: PhonemeBedDTO;
  readonly t: ReturnType<typeof usePhonemeGardenTranslations>;
}) {
  const stageLabel = resolveStageLabel(bed.stage, t);
  return (
    <article
      className={cn(
        "flex flex-col justify-between rounded-card border p-4 shadow-2xs transition-colors",
        bed.stage === "BLOOM"
          ? "border-emerald-300 bg-gradient-to-b from-white via-emerald-50/50 to-amber-50/40"
          : "border-border bg-white/95",
      )}
      data-bed-stage={bed.stage}
      data-testid={`phoneme-bed-${bed.bed_key}`}
      role="listitem"
    >
      <div className="flex flex-col items-center text-center">
        <div className="flex w-full items-center justify-between gap-2">
          <span
            className="viread-learning-content rounded-full bg-cream px-2.5 py-0.5 text-[11px] font-extrabold text-ink"
            dir="ltr"
            lang="vi"
          >
            {bed.phonics_label_vi}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-extrabold",
              STAGE_BADGE_STYLES[bed.stage],
            )}
            data-testid={`phoneme-bed-stage-${bed.bed_key}`}
          >
            {bed.stage === "BLOOM" ? (
              <Flower2 aria-hidden="true" className="size-3" />
            ) : (
              <Sprout aria-hidden="true" className="size-3" />
            )}
            {stageLabel}
          </span>
        </div>

        <BotanicalBedIllustration
          label={`${bed.plant_name_vi} — ${stageLabel}`}
          stage={bed.stage}
          symbol={bed.plant_symbol}
        />

        <h3
          className="viread-learning-content text-base font-extrabold text-ink"
          dir="ltr"
          lang="vi"
        >
          {bed.plant_name_vi}
        </h3>

        <p className="mt-1 text-xs font-bold text-emerald-800">
          {t("bedMasteredCount", { count: bed.mastered_words_count })}
          {bed.practiced_words_count > bed.mastered_words_count
            ? ` · ${t("bedPracticedCount", { count: bed.practiced_words_count })}`
            : ""}
        </p>
      </div>

      <div className="mt-3 space-y-2 border-t border-border/60 pt-2.5">
        {bed.mastered_words.length > 0 ? (
          <div>
            <p className="text-[11px] font-bold text-muted">
              {t("bedMasteredWordsLabel")}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {bed.mastered_words.slice(0, 5).map((word) => (
                <span
                  className="viread-learning-content inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-900"
                  dir="ltr"
                  key={word}
                  lang="vi"
                >
                  {word}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[11px] font-medium text-muted">
            {bed.stage === "SEED"
              ? t("bedSeedWaitingHint")
              : t("bedNextStageHint", { count: bed.words_to_next_stage })}
          </p>
        )}

        <p
          className="viread-learning-content text-xs leading-relaxed text-muted"
          dir="ltr"
          lang="vi"
        >
          {bed.encouragement_vi}
        </p>
      </div>
    </article>
  );
}

export interface PhonemeGardenCardProps {
  readonly summary: PhonemeGardenSummaryDTO;
  readonly onViewPassport?: () => void;
  readonly fullGardenHref?: string;
}

export function PhonemeGardenCard({
  summary,
  onViewPassport,
  fullGardenHref,
}: PhonemeGardenCardProps) {
  const t = usePhonemeGardenTranslations();
  const totalEarnedStamps =
    summary.total_completed_books + summary.unlocked_milestone_stamps_count;

  return (
    <section
      aria-label={t("pageTitle")}
      className="space-y-4 rounded-card border border-emerald-200 bg-gradient-to-br from-emerald-50/85 via-cream to-amber-50/70 p-5 shadow-2xs sm:p-6"
      data-testid="phoneme-garden-card"
    >
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-white px-3 py-1 text-xs font-extrabold text-emerald-900">
              <ShieldCheck
                aria-hidden="true"
                className="size-3.5 text-emerald-700"
              />
              {t("privacyBadge")}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1 text-xs font-bold text-amber-900">
              <Sparkles
                aria-hidden="true"
                className="size-3.5 text-amber-600"
              />
              {t("statsBloomedBeds", { count: summary.bloomed_beds_count })}
            </span>
          </div>

          <h2 className="book-title text-xl font-extrabold text-ink sm:text-2xl">
            {t("pageTitle")}
          </h2>
          <p className="text-sm text-muted">{t("pageSubtitle")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onViewPassport ? (
            <Button
              className="min-h-11 shrink-0 px-4"
              data-testid="open-book-stamp-passport-btn"
              fullWidth={false}
              onClick={onViewPassport}
              size="compact"
              type="button"
              variant="secondary"
            >
              <BookMarked
                aria-hidden="true"
                className="size-4 text-amber-700"
              />
              {t("viewPassportButton", { count: totalEarnedStamps })}
            </Button>
          ) : null}

          {fullGardenHref ? (
            <ButtonLink
              className="min-h-11 shrink-0 px-4 text-xs font-bold"
              href={fullGardenHref}
              size="compact"
              variant="quiet"
            >
              {t("openFullGardenLink")}
            </ButtonLink>
          ) : null}
        </div>
      </div>

      {/* Gentle encouraging message & summary counters */}
      <div className="flex flex-col justify-between gap-3 rounded-card border border-emerald-200/80 bg-white/85 p-3.5 sm:flex-row sm:items-center">
        <p
          className="viread-learning-content text-sm font-bold text-emerald-950"
          dir="ltr"
          lang="vi"
        >
          {summary.gentle_message_vi}
        </p>

        <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-900">
            {t("statsMasteredWords", { count: summary.total_mastered_words })}
          </span>
          <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-amber-900">
            {t("statsCompletedBooks", { count: summary.total_completed_books })}
          </span>
          <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-sky-950">
            {t("statsCompletedSessions", {
              count: summary.total_completed_sessions,
            })}
          </span>
        </div>
      </div>

      {/* 7 Vietnamese Phonics Flower Beds */}
      <div
        aria-label={t("bedsListAria")}
        className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7"
        role="list"
      >
        {summary.beds.map((bed) => (
          <BedCard bed={bed} key={bed.bed_key} t={t} />
        ))}
      </div>

      {/* Mandatory calm non-punitive pedagogy note */}
      <p className="rounded-control border border-emerald-200/60 bg-white/70 px-3.5 py-2 text-center text-xs font-semibold text-muted">
        {t("calmBanner")}
      </p>
    </section>
  );
}
