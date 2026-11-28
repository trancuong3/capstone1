"use client";

import { Award, BookOpenCheck, CheckCircle2, Lock, X } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/common/button";
import { useI18n } from "@/hooks/use-i18n";
import type {
  BookStampDTO,
  BookStampMotif,
  MilestoneStampDTO,
  PhonemeGardenSummaryDTO,
} from "@/lib/api/phoneme-garden-service";
import { cn } from "@/lib/utils/cn";
import { usePhonemeGardenTranslations } from "@/messages/features/phoneme_garden";

const MOTIF_COLORS: Record<
  BookStampMotif,
  { readonly bg: string; readonly ring: string; readonly accent: string }
> = {
  LOTUS_SEAL: {
    bg: "bg-rose-50 border-rose-200",
    ring: "#E11D48",
    accent: "#FDA4AF",
  },
  BAMBOO_SCROLL: {
    bg: "bg-emerald-50 border-emerald-200",
    ring: "#059669",
    accent: "#6EE7B7",
  },
  STARLIGHT_LANTERN: {
    bg: "bg-amber-50 border-amber-200",
    ring: "#D97706",
    accent: "#FCD34D",
  },
  SUNRISE_KITE: {
    bg: "bg-sky-50 border-sky-200",
    ring: "#0284C7",
    accent: "#7DD3FC",
  },
  BANYAN_LEAF: {
    bg: "bg-lime-50 border-lime-200",
    ring: "#65A30D",
    accent: "#BEF264",
  },
};

function StampSealIllustration({ motif }: { readonly motif: BookStampMotif }) {
  const palette = MOTIF_COLORS[motif];
  return (
    <svg aria-hidden="true" className="size-12 shrink-0" viewBox="0 0 56 56">
      <circle
        cx="28"
        cy="28"
        fill={palette.accent}
        opacity="0.35"
        r="24"
        stroke={palette.ring}
        strokeDasharray="3 2"
        strokeWidth="2"
      />
      <circle
        cx="28"
        cy="28"
        fill="#FFFFFF"
        r="18"
        stroke={palette.ring}
        strokeWidth="1.5"
      />
      <path
        d="M19 23 H37 V35 H19 Z"
        fill="none"
        stroke={palette.ring}
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <line
        stroke={palette.ring}
        strokeWidth="1.8"
        x1="28"
        x2="28"
        y1="23"
        y2="35"
      />
    </svg>
  );
}

function BookStampItem({
  stamp,
  formatCompletedDate,
  t,
}: {
  readonly stamp: BookStampDTO;
  readonly formatCompletedDate: (iso: string) => string;
  readonly t: ReturnType<typeof usePhonemeGardenTranslations>;
}) {
  const motifStyle = MOTIF_COLORS[stamp.motif];
  return (
    <article
      className={cn(
        "flex items-start gap-3 rounded-card border p-3.5 shadow-2xs",
        motifStyle.bg,
      )}
      data-testid={`book-stamp-${stamp.book_id}`}
      role="listitem"
    >
      <StampSealIllustration motif={stamp.motif} />
      <div className="min-w-0 flex-1 space-y-1">
        <h4
          className="viread-learning-content line-clamp-2 text-sm font-extrabold text-ink"
          dir="ltr"
          lang="vi"
        >
          {stamp.book_title}
        </h4>
        <p className="text-xs text-muted">
          {t("bookStampCompletedOn", {
            date: formatCompletedDate(stamp.completed_at),
          })}
        </p>
        {stamp.completed_sessions_count > 1 ? (
          <span className="inline-flex items-center rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-bold text-amber-900">
            {t("bookStampSessionsBadge", {
              count: stamp.completed_sessions_count,
            })}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function MilestoneStampItem({
  stamp,
  t,
}: {
  readonly stamp: MilestoneStampDTO;
  readonly t: ReturnType<typeof usePhonemeGardenTranslations>;
}) {
  const pct = Math.min(
    100,
    Math.round(
      (stamp.progress_current / Math.max(1, stamp.progress_target)) * 100,
    ),
  );
  return (
    <article
      className={cn(
        "flex flex-col justify-between gap-2.5 rounded-card border p-3.5",
        stamp.unlocked
          ? "border-emerald-300 bg-emerald-50/80"
          : "border-border bg-canvas/70",
      )}
      data-milestone-unlocked={stamp.unlocked ? "true" : "false"}
      data-testid={`milestone-stamp-${stamp.stamp_key}`}
      role="listitem"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <h4
            className="viread-learning-content text-sm font-extrabold text-ink"
            dir="ltr"
            lang="vi"
          >
            {stamp.title_vi}
          </h4>
          <p
            className="viread-learning-content text-xs text-muted"
            dir="ltr"
            lang="vi"
          >
            {stamp.description_vi}
          </p>
        </div>
        {stamp.unlocked ? (
          <CheckCircle2
            aria-hidden="true"
            className="size-5 shrink-0 text-emerald-700"
          />
        ) : (
          <Lock aria-hidden="true" className="size-4 shrink-0 text-muted" />
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] font-bold">
          <span className={stamp.unlocked ? "text-emerald-900" : "text-muted"}>
            {stamp.unlocked
              ? t("milestoneUnlockedBadge")
              : t("milestoneProgressBadge", {
                  current: stamp.progress_current,
                  target: stamp.progress_target,
                })}
          </span>
          <span className="tabular-nums text-muted">
            {stamp.progress_current}/{stamp.progress_target}
          </span>
        </div>
        <div
          aria-hidden="true"
          className="h-2 w-full overflow-hidden rounded-full bg-white"
        >
          <div
            className={cn(
              "h-full rounded-full transition-all",
              stamp.unlocked ? "bg-emerald-600" : "bg-amber-400",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </article>
  );
}

export interface BookStampPassportModalProps {
  readonly summary: PhonemeGardenSummaryDTO;
  readonly onClose: () => void;
}

export function BookStampPassportModal({
  summary,
  onClose,
}: BookStampPassportModalProps) {
  const t = usePhonemeGardenTranslations();
  const { formatDate } = useI18n();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const formatCompletedDate = (iso: string): string => {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      return iso;
    }
    return formatDate(parsed, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  };

  return (
    <div
      aria-label={t("passportModalTitle")}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      data-testid="book-stamp-passport-modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="dialog"
    >
      <div className="max-h-[90vh] w-full max-w-2xl space-y-5 overflow-y-auto rounded-card border border-border bg-white p-5 shadow-xl sm:p-6">
        <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
          <div className="space-y-1">
            <h2 className="book-title text-xl font-extrabold text-ink">
              {t("passportModalTitle")}
            </h2>
            <p className="text-sm text-muted">
              {t("passportModalSubtitle", { alias: summary.child_alias })}
            </p>
          </div>
          <Button
            aria-label={t("closePassportButton")}
            className="min-h-10 px-3"
            data-testid="close-book-stamp-passport-btn"
            fullWidth={false}
            onClick={onClose}
            size="compact"
            type="button"
            variant="quiet"
          >
            <X aria-hidden="true" className="size-4" />
            {t("closePassportButton")}
          </Button>
        </div>

        {/* Section 1: Deduplicated Completed Book Stamps */}
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-extrabold text-amber-900">
            <BookOpenCheck
              aria-hidden="true"
              className="size-4 text-amber-700"
            />
            {t("bookStampsHeading", { count: summary.book_stamps.length })}
          </h3>

          {summary.book_stamps.length === 0 ? (
            <p
              className="rounded-card border border-dashed border-amber-200 bg-amber-50/50 p-4 text-sm text-muted"
              data-testid="book-stamps-empty"
            >
              {t("bookStampsEmpty")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="list">
              {summary.book_stamps.map((stamp) => (
                <BookStampItem
                  formatCompletedDate={formatCompletedDate}
                  key={stamp.stamp_key}
                  stamp={stamp}
                  t={t}
                />
              ))}
            </div>
          )}
        </section>

        {/* Section 2: Calm Cumulative Milestone Stamps */}
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-extrabold text-emerald-900">
            <Award aria-hidden="true" className="size-4 text-emerald-700" />
            {t("milestoneStampsHeading")}
          </h3>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="list">
            {summary.milestone_stamps.map((stamp) => (
              <MilestoneStampItem key={stamp.stamp_key} stamp={stamp} t={t} />
            ))}
          </div>
        </section>

        <p className="rounded-control bg-cream px-3.5 py-2 text-center text-xs font-semibold text-muted">
          {t("calmBanner")}
        </p>
      </div>
    </div>
  );
}
