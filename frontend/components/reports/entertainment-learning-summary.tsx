"use client";

import { HeartHandshake, Info, Music2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { ButtonLink } from "@/components/common/button";
import { SegmentedFilterBar } from "@/components/common/segmented-filter-bar";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import { adaptTextToTeacherPersona } from "@/lib/reading/voice-persona";
import type {
  ParentEntertainmentAnalyticsDTO,
  SkillStatus,
} from "@/types/adaptive-learning";

interface Props {
  readonly childId: string;
  readonly childName: string;
  readonly initialData?: ParentEntertainmentAnalyticsDTO | null;
}

type SkillFilter = "ALL" | SkillStatus;

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
    className: "bg-white text-muted",
  },
};

export function EntertainmentLearningSummary({
  childId,
  childName,
  initialData = null,
}: Props) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reports");
  const tCommon = useTranslations("common");
  const teacherPersona = useTeacherPersona();
  const [fetchedData, setFetchedData] =
    useState<ParentEntertainmentAnalyticsDTO | null>(null);
  const [fetchStatus, setFetchStatus] = useState<"loading" | "ready" | "empty">(
    "loading",
  );
  const [skillFilter, setSkillFilter] = useState<SkillFilter>("ALL");

  useEffect(() => {
    if (initialData) return;
    let active = true;
    async function load() {
      try {
        const result = await createAdaptiveLearningService().getParentAnalytics(
          childId,
          30,
          teacherPersona.gender,
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
  }, [childId, initialData, teacherPersona.gender]);

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
      <div className="space-y-2 rounded-control bg-canvas/65 p-3.5 text-xs text-muted sm:text-sm">
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
      <div className="rounded-control bg-canvas/65 p-3.5 text-xs text-muted sm:text-sm">
        {t("entertainmentSummary.empty", { childName })}
      </div>
    );
  }

  const observedSkillsCount = data.skills.filter(
    (skill) => skill.status === "OBSERVED",
  ).length;
  const estimatedSkillsCount = data.skills.filter(
    (skill) => skill.status === "ESTIMATED",
  ).length;
  const unknownSkillsCount = data.skills.filter(
    (skill) => skill.status === "UNKNOWN",
  ).length;

  const filteredSkills =
    skillFilter === "ALL"
      ? data.skills
      : data.skills.filter((skill) => skill.status === skillFilter);

  const skillFilterOptions = [
    {
      value: "ALL" as const,
      label: `${tCommon("taskCenter.filters.all")} (${formatNumber(data.skills.length)})`,
    },
    {
      value: "OBSERVED" as const,
      label: `${t("entertainmentSummary.statusObserved")} (${formatNumber(observedSkillsCount)})`,
    },
    {
      value: "ESTIMATED" as const,
      label: `${t("entertainmentSummary.statusEstimated")} (${formatNumber(estimatedSkillsCount)})`,
    },
    {
      value: "UNKNOWN" as const,
      label: `${t("entertainmentSummary.statusUnknown")} (${formatNumber(unknownSkillsCount)})`,
    },
  ] as const;

  return (
    <div className="flex flex-col gap-3">
      {/* Explicit Non-Diagnostic Disclaimer */}
      <div className="flex items-start gap-2 rounded-control bg-sky/45 px-3 py-2 text-xs text-ink">
        <Info
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-primary"
        />
        <p className="viread-learning-content" dir="ltr" lang="vi">
          {data.disclaimer_vi}
        </p>
      </div>

      {/* Horizontal Honest Evidence Counter Strip */}
      <dl className="grid grid-cols-1 rounded-control bg-canvas/70 sm:grid-cols-3">
        <div className="flex items-baseline justify-between gap-2 px-3 py-2">
          <dt className="text-xs font-semibold text-muted">
            {t("entertainmentSummary.observedCounterLabel")}
          </dt>
          <dd className="text-base font-extrabold tabular-nums text-success-ink">
            {data.observed_skills_count} / {data.skills.length}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 border-t border-border/70 px-3 py-2 sm:border-s sm:border-t-0">
          <dt className="text-xs font-semibold text-muted">
            {t("entertainmentSummary.estimatedCounterLabel")}
          </dt>
          <dd className="text-base font-extrabold tabular-nums text-primary">
            {data.estimated_skills_count}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 border-t border-border/70 px-3 py-2 sm:border-s sm:border-t-0">
          <dt className="text-xs font-semibold text-muted">
            {t("entertainmentSummary.unknownCounterLabel")}
          </dt>
          <dd className="text-base font-extrabold tabular-nums text-muted">
            {data.unknown_skills_count}
          </dd>
        </div>
      </dl>

      {/* Activity per Game Module */}
      <div>
        <h3 className="text-sm font-extrabold text-ink">
          {t("entertainmentSummary.activitiesTitle", {
            days: data.window_days,
          })}
        </h3>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {data.module_activities.map((mod) => (
            <div
              className="min-w-0 rounded-control bg-canvas/65 px-3 py-2"
              key={mod.game_key}
            >
              <div className="flex items-center justify-between gap-1.5">
                <p
                  className="viread-learning-content truncate text-xs font-bold text-ink sm:text-sm"
                  dir="ltr"
                  lang="vi"
                >
                  {adaptTextToTeacherPersona(
                    mod.title_vi,
                    teacherPersona.gender,
                  )}
                </p>
                {mod.recent_average_pct !== null ? (
                  <span className="shrink-0 rounded-full bg-sky px-2 py-0.5 text-[11px] font-extrabold tabular-nums text-primary-hover">
                    {t("entertainmentSummary.avgScoreBadge", {
                      pct: mod.recent_average_pct,
                    })}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-muted">
                    {t("entertainmentSummary.noScoreBadge")}
                  </span>
                )}
              </div>
              <p
                className="viread-learning-content mt-1 text-[11px] leading-snug text-muted"
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-ink">
            {t("entertainmentSummary.skillsMapTitle")}
          </h3>
          <SegmentedFilterBar
            ariaLabel={t("entertainmentSummary.skillsMapTitle")}
            onChange={setSkillFilter}
            options={skillFilterOptions}
            value={skillFilter}
          />
        </div>
        {filteredSkills.length > 0 ? (
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {filteredSkills.map((skill) => {
              const badge = STATUS_BADGE[skill.status];
              return (
                <li
                  className="flex min-w-0 items-center justify-between gap-2 rounded-control bg-canvas/65 px-3 py-2"
                  key={skill.skill_key}
                >
                  <div className="min-w-0">
                    <p
                      className="viread-learning-content break-words text-xs font-bold leading-snug text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {skill.label_vi}
                    </p>
                    <p className="text-[11px] text-muted">
                      {skill.evidence_count > 0
                        ? t("entertainmentSummary.evidenceCount", {
                            count: skill.evidence_count,
                          })
                        : t("entertainmentSummary.noPracticeYet")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {skill.mastery_pct !== null ? (
                      <span className="text-xs font-extrabold tabular-nums text-ink">
                        {skill.mastery_pct}%
                      </span>
                    ) : null}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${badge.className}`}
                    >
                      {t(badge.key)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 rounded-control bg-canvas/60 px-3 py-2 text-xs text-muted">
            {tCommon("states.empty")}
          </p>
        )}
      </div>

      {/* Practiced Difficult Words */}
      {data.practiced_difficult_words.length ? (
        <div>
          <h3 className="text-sm font-extrabold text-ink">
            {t("entertainmentSummary.practicedWordsTitle")}
          </h3>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {data.practiced_difficult_words.map((word) => (
              <li
                className="inline-flex flex-wrap items-center gap-1 rounded-full bg-warning-surface/70 px-2.5 py-1 text-xs font-bold text-warning"
                key={word.normalized_word}
              >
                <span className="viread-learning-content" dir="ltr" lang="vi">
                  {word.display_text}
                </span>
                {word.phonics_label_vi ? (
                  <span
                    className="viread-learning-content rounded-full bg-white/85 px-1.5 py-0.5 text-[10px] font-semibold text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    {word.phonics_label_vi}
                  </span>
                ) : null}{" "}
                ·{" "}
                {t("entertainmentSummary.practiceTimes", {
                  count: word.practice_count,
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Karaoke Weak Segments & Home Support Tips */}
      <div
        className={
          data.karaoke_weak_segments.length
            ? "grid gap-2.5 lg:grid-cols-2"
            : undefined
        }
      >
        {data.karaoke_weak_segments.length ? (
          <div className="rounded-control bg-danger-surface/55 p-3">
            <div className="flex items-center gap-1.5 text-xs font-extrabold text-danger sm:text-sm">
              <Music2 aria-hidden="true" className="size-3.5" />
              {t("entertainmentSummary.karaokeWeakSegmentsTitle")}
            </div>
            <ul className="mt-2 space-y-1.5">
              {data.karaoke_weak_segments.map((seg, idx) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-white/90 px-2.5 py-2 text-xs"
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
                      className="viread-learning-content text-[11px] text-muted"
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

        <div className="rounded-control bg-success-surface/50 p-3">
          <div className="flex items-center gap-1.5 text-xs font-extrabold text-success-ink sm:text-sm">
            <HeartHandshake aria-hidden="true" className="size-3.5" />
            {t("entertainmentSummary.homeTipsTitle")}
          </div>
          <ul className="mt-1.5 space-y-1 text-xs text-ink sm:text-sm">
            {data.home_support_tips_vi.map((tip, idx) => (
              <li className="flex items-start gap-1.5" key={idx}>
                <Sparkles
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-success-ink"
                />
                <span className="viread-learning-content" dir="ltr" lang="vi">
                  {tip}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
