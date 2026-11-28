"use client";

import { HeartHandshake, Info, Music2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { ButtonLink } from "@/components/common/button";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import type {
  ParentEntertainmentAnalyticsDTO,
  SkillStatus,
} from "@/types/adaptive-learning";

interface Props {
  readonly childId: string;
  readonly childName: string;
  readonly initialData?: ParentEntertainmentAnalyticsDTO | null;
}

const STATUS_BADGE: Record<
  SkillStatus,
  { readonly key: string; readonly className: string }
> = {
  OBSERVED: {
    key: "entertainmentSummary.statusObserved",
    className: "bg-success-surface text-success-ink",
  },
  ESTIMATED: {
    key: "entertainmentSummary.statusEstimated",
    className: "bg-sky text-primary-hover",
  },
  UNKNOWN: {
    key: "entertainmentSummary.statusUnknown",
    className: "bg-slate-100 text-muted",
  },
};

export function EntertainmentLearningSummary({
  childId,
  childName,
  initialData = null,
}: Props) {
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const [fetchedData, setFetchedData] =
    useState<ParentEntertainmentAnalyticsDTO | null>(null);
  const [fetchStatus, setFetchStatus] = useState<"loading" | "ready" | "empty">(
    "loading",
  );

  useEffect(() => {
    if (initialData) return;
    let active = true;
    async function load() {
      try {
        const result = await createAdaptiveLearningService().getParentAnalytics(
          childId,
          30,
        );
        if (!active) return;
        if (
          !result ||
          !Array.isArray(result.skills) ||
          !Array.isArray(result.module_activities)
        ) {
          setFetchStatus("empty");
          return;
        }
        setFetchedData(result);
        setFetchStatus("ready");
      } catch {
        if (active) {
          setFetchStatus("empty");
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [childId, initialData]);

  const data = initialData ?? fetchedData;
  const status = initialData ? "ready" : fetchStatus;
  const analyticsProgress = useAiProgress({
    active: status === "loading",
    expectedDurationMs: 5_000,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.analyzing") },
      { atPct: 50, label: tCommon("aiProgress.loadingRecommendations") },
      { atPct: 85, label: tCommon("aiProgress.finalizing") },
    ],
  });

  if (status === "loading") {
    return (
      <div className="space-y-2.5 rounded-card border border-border bg-white p-5 text-sm text-muted">
        <p>{t("entertainmentSummary.loading", { childName })}</p>
        <AiProgressBar
          active
          label={
            analyticsProgress.stageLabel ??
            tCommon("aiProgress.loadingRecommendations")
          }
          percent={analyticsProgress.percent}
          size="compact"
          testId="entertainment-learning-summary-progress"
        />
      </div>
    );
  }

  if (!data || status === "empty") {
    return (
      <div className="rounded-card border border-border bg-white p-5 text-sm text-muted">
        {t("entertainmentSummary.empty", { childName })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Explicit Non-Diagnostic Disclaimer */}
      <div className="flex items-start gap-3 rounded-control border border-sky-200 bg-sky/50 p-4 text-sm text-ink">
        <Info
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-primary"
        />
        <p className="viread-learning-content" dir="ltr" lang="vi">
          {data.disclaimer_vi}
        </p>
      </div>

      {/* 3 Honest Evidence Counters */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-control border border-border bg-white p-4">
          <p className="text-xs font-semibold text-muted">
            {t("entertainmentSummary.observedCounterLabel")}
          </p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums text-success-ink">
            {data.observed_skills_count} / {data.skills.length}
          </p>
        </div>
        <div className="rounded-control border border-border bg-white p-4">
          <p className="text-xs font-semibold text-muted">
            {t("entertainmentSummary.estimatedCounterLabel")}
          </p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums text-primary">
            {data.estimated_skills_count}
          </p>
        </div>
        <div className="rounded-control border border-border bg-white p-4">
          <p className="text-xs font-semibold text-muted">
            {t("entertainmentSummary.unknownCounterLabel")}
          </p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums text-muted">
            {data.unknown_skills_count}
          </p>
        </div>
      </div>

      {/* Activity per Game Module */}
      <div>
        <h3 className="text-lg font-bold text-ink">
          {t("entertainmentSummary.activitiesTitle", {
            days: data.window_days,
          })}
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {data.module_activities.map((mod) => (
            <div
              className="rounded-control border border-border bg-white p-4"
              key={mod.game_key}
            >
              <div className="flex items-center justify-between gap-2">
                <p
                  className="viread-learning-content font-bold text-ink"
                  dir="ltr"
                  lang="vi"
                >
                  {mod.title_vi}
                </p>
                {mod.recent_average_pct !== null ? (
                  <span className="rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold tabular-nums text-primary-hover">
                    {t("entertainmentSummary.avgScoreBadge", {
                      pct: mod.recent_average_pct,
                    })}
                  </span>
                ) : (
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-muted">
                    {t("entertainmentSummary.noScoreBadge")}
                  </span>
                )}
              </div>
              <p
                className="viread-learning-content mt-1 text-xs text-muted"
                dir="ltr"
                lang="vi"
              >
                {mod.highlight_vi}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* 16-Skill Transparent Map */}
      <div>
        <h3 className="text-lg font-bold text-ink">
          {t("entertainmentSummary.skillsMapTitle")}
        </h3>
        <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
          {data.skills.map((skill) => {
            const badge = STATUS_BADGE[skill.status];
            return (
              <li
                className="flex items-center justify-between gap-3 rounded-control border border-border bg-white px-4 py-3"
                key={skill.skill_key}
              >
                <div className="min-w-0">
                  <p
                    className="viread-learning-content break-words leading-snug text-sm font-bold text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    {skill.label_vi}
                  </p>
                  <p className="text-xs text-muted">
                    {skill.evidence_count > 0
                      ? t("entertainmentSummary.evidenceCount", {
                          count: skill.evidence_count,
                        })
                      : t("entertainmentSummary.noPracticeYet")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {skill.mastery_pct !== null ? (
                    <span className="text-sm font-extrabold tabular-nums text-ink">
                      {skill.mastery_pct}%
                    </span>
                  ) : null}
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold ${badge.className}`}
                  >
                    {t(badge.key)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Practiced Difficult Words */}
      {data.practiced_difficult_words.length ? (
        <div>
          <h3 className="text-lg font-bold text-ink">
            {t("entertainmentSummary.practicedWordsTitle")}
          </h3>
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {data.practiced_difficult_words.map((word) => (
              <li
                className="rounded-full border border-amber-200 bg-amber-50 px-3.5 py-1.5 text-xs font-bold text-amber-900"
                key={word.normalized_word}
              >
                <span className="viread-learning-content" dir="ltr" lang="vi">
                  {word.display_text}
                </span>{" "}
                ·{" "}
                {t("entertainmentSummary.practiceTimes", {
                  count: word.practice_count,
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Karaoke Weak Segments */}
      {data.karaoke_weak_segments.length ? (
        <div className="rounded-control border border-rose-200 bg-rose-50/60 p-4">
          <div className="flex items-center gap-2 font-bold text-rose-950">
            <Music2 aria-hidden="true" className="size-4" />
            {t("entertainmentSummary.karaokeWeakSegmentsTitle")}
          </div>
          <ul className="mt-2.5 space-y-2">
            {data.karaoke_weak_segments.map((seg, idx) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-white p-3 text-sm"
                key={`${seg.song_id}-${seg.start_ms}-${idx}`}
              >
                <div className="min-w-0">
                  <p
                    className="viread-learning-content font-bold text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    “{seg.line_text}”
                  </p>
                  <p
                    className="viread-learning-content text-xs text-muted"
                    dir="ltr"
                    lang="vi"
                  >
                    {seg.tip_vi}
                  </p>
                </div>
                <ButtonLink
                  href={`/karaoke/${encodeURIComponent(seg.song_id)}`}
                  size="compact"
                  variant="secondary"
                >
                  {t("entertainmentSummary.openSongAction")}
                </ButtonLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Home Support Tips */}
      <div className="rounded-control border border-emerald-200 bg-emerald-50/70 p-4">
        <div className="flex items-center gap-2 font-bold text-emerald-950">
          <HeartHandshake aria-hidden="true" className="size-4" />
          {t("entertainmentSummary.homeTipsTitle")}
        </div>
        <ul className="mt-2 space-y-1.5 text-sm text-emerald-950">
          {data.home_support_tips_vi.map((tip, idx) => (
            <li className="flex items-start gap-2" key={idx}>
              <Sparkles
                aria-hidden="true"
                className="mt-1 size-3.5 shrink-0 text-emerald-700"
              />
              <span className="viread-learning-content" dir="ltr" lang="vi">
                {tip}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
