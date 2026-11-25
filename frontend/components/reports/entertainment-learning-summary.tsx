"use client";

import { HeartHandshake, Info, Music2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { ButtonLink } from "@/components/common/button";
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

const STATUS_BADGE: Record<SkillStatus, { label: string; className: string }> =
  {
    OBSERVED: {
      label: "Đã quan sát rõ",
      className: "bg-success-surface text-success-ink",
    },
    ESTIMATED: {
      label: "Ước lượng bước đầu",
      className: "bg-sky text-primary-hover",
    },
    UNKNOWN: {
      label: "Chưa đủ dữ liệu",
      className: "bg-slate-100 text-muted",
    },
  };

export function EntertainmentLearningSummary({
  childId,
  childName,
  initialData = null,
}: Props) {
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

  if (status === "loading") {
    return (
      <div className="rounded-card border border-border bg-white p-5 text-sm text-muted">
        Đang tổng hợp hoạt động Vui học &amp; Giải trí của {childName}...
      </div>
    );
  }

  if (!data || status === "empty") {
    return (
      <div className="rounded-card border border-border bg-white p-5 text-sm text-muted">
        Chưa có dữ liệu tổng hợp từ khu vực Vui học &amp; Giải trí cho{" "}
        {childName}. Khi bé chơi Kể chuyện tranh, Xạ thủ ghép câu, Karaoke hoặc
        Bé nhớ được gì?, tiến bộ sẽ tự động hiện tại đây.
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
        <p>{data.disclaimer_vi}</p>
      </div>

      {/* 3 Honest Evidence Counters */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-control border border-border bg-white p-4">
          <p className="text-xs font-semibold text-muted">
            Kỹ năng đã quan sát rõ
          </p>
          <p className="mt-1 text-2xl font-extrabold text-success-ink">
            {data.observed_skills_count} / {data.skills.length}
          </p>
        </div>
        <div className="rounded-control border border-border bg-white p-4">
          <p className="text-xs font-semibold text-muted">Ước lượng bước đầu</p>
          <p className="mt-1 text-2xl font-extrabold text-primary">
            {data.estimated_skills_count}
          </p>
        </div>
        <div className="rounded-control border border-border bg-white p-4">
          <p className="text-xs font-semibold text-muted">Chưa đủ dữ liệu</p>
          <p className="mt-1 text-2xl font-extrabold text-muted">
            {data.unknown_skills_count}
          </p>
        </div>
      </div>

      {/* Activity per Game Module */}
      <div>
        <h3 className="text-lg font-bold text-ink">
          Hoạt động theo 4 trò chơi ({data.window_days} ngày gần nhất)
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {data.module_activities.map((mod) => (
            <div
              className="rounded-control border border-border bg-white p-4"
              key={mod.game_key}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-bold text-ink">{mod.title_vi}</p>
                {mod.recent_average_pct !== null ? (
                  <span className="rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary-hover">
                    TB {mod.recent_average_pct}%
                  </span>
                ) : (
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-muted">
                    Chưa có điểm
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">{mod.highlight_vi}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 16-Skill Transparent Map */}
      <div>
        <h3 className="text-lg font-bold text-ink">
          Bản đồ kỹ năng (Quan sát thực tế vs Chưa đủ dữ liệu)
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
                  <p className="truncate text-sm font-bold text-ink">
                    {skill.label_vi}
                  </p>
                  <p className="text-xs text-muted">
                    {skill.evidence_count > 0
                      ? `${skill.evidence_count} lượt ghi nhận`
                      : "Chưa có lượt luyện tập"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {skill.mastery_pct !== null ? (
                    <span className="text-sm font-extrabold text-ink">
                      {skill.mastery_pct}%
                    </span>
                  ) : null}
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold ${badge.className}`}
                  >
                    {badge.label}
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
            Từ khó bé đang ôn lồng ghép qua trò chơi
          </h3>
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {data.practiced_difficult_words.map((word) => (
              <li
                className="rounded-full border border-amber-200 bg-amber-50 px-3.5 py-1.5 text-xs font-bold text-amber-900"
                key={word.normalized_word}
              >
                {word.display_text} · {word.practice_count} lần
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
            Đoạn hát bé có thể luyện chậm 0.85x
          </div>
          <ul className="mt-2.5 space-y-2">
            {data.karaoke_weak_segments.map((seg, idx) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-white p-3 text-sm"
                key={`${seg.song_id}-${seg.start_ms}-${idx}`}
              >
                <div>
                  <p className="font-bold text-ink">“{seg.line_text}”</p>
                  <p className="text-xs text-muted">{seg.tip_vi}</p>
                </div>
                <ButtonLink
                  href={`/karaoke/${encodeURIComponent(seg.song_id)}`}
                  size="compact"
                  variant="secondary"
                >
                  Mở bài hát
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
          Gợi ý ba mẹ đồng hành tại nhà
        </div>
        <ul className="mt-2 space-y-1.5 text-sm text-emerald-950">
          {data.home_support_tips_vi.map((tip, idx) => (
            <li className="flex items-start gap-2" key={idx}>
              <Sparkles
                aria-hidden="true"
                className="mt-1 size-3.5 shrink-0 text-emerald-700"
              />
              <span>{tip}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
