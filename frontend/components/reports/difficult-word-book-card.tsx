"use client";

import { BookOpen, Check, ChevronDown, Mic, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";

import { BookCover } from "@/components/books/book-cover";
import { Button } from "@/components/common/button";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type {
  DifficultWordBookGroup,
  DifficultWordDTO,
  DifficultWordPracticeStatus,
} from "@/types/reports";

const MAX_COLLAPSED_WORDS = 10;

interface DifficultWordBookCardProps {
  readonly group: DifficultWordBookGroup;
  readonly onStartBookPractice: (word: DifficultWordDTO) => void;
  readonly onSelectWord: (word: DifficultWordDTO) => void;
}

const CHIP_STYLES: Record<
  DifficultWordPracticeStatus,
  {
    readonly className: string;
    readonly dotClass: string;
    readonly labelKey: string;
  }
> = {
  NOT_PRACTICED: {
    className:
      "border-orange-200 bg-orange-50/90 text-orange-950 hover:border-orange-300 hover:bg-orange-100/90 focus-visible:outline-primary",
    dotClass: "bg-orange-500",
    labelKey: "bookCard.badgeNotPracticed",
  },
  NEEDS_MORE_PRACTICE: {
    className:
      "border-amber-300 bg-warning-surface/90 text-warning hover:border-amber-400 hover:bg-warning-surface focus-visible:outline-primary",
    dotClass: "bg-amber-600",
    labelKey: "bookCard.badgeNeedsMore",
  },
  IN_PROGRESS: {
    className:
      "border-amber-200 bg-cream text-ink hover:border-amber-300 hover:bg-warning-surface/70 focus-visible:outline-primary",
    dotClass: "bg-amber-500",
    labelKey: "bookCard.badgeInProgress",
  },
  COMPLETED: {
    className:
      "border-emerald-300 bg-success-surface text-success-ink hover:border-emerald-400 hover:bg-emerald-100 focus-visible:outline-primary",
    dotClass: "bg-emerald-600",
    labelKey: "bookCard.badgeCompleted",
  },
};

export function DifficultWordBookCard({
  group,
  onStartBookPractice,
  onSelectWord,
}: DifficultWordBookCardProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("difficultWords");
  const tr = useTranslations("reading");
  const [coverError, setCoverError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const handleCoverError = useCallback(() => setCoverError(true), []);

  const firstPendingWord =
    group.words.find((item) => item.practice_status !== "COMPLETED") ??
    group.words[0];
  const allCompleted =
    group.totalWords > 0 && group.completedWords === group.totalWords;
  const gradeLabel =
    group.minGrade != null
      ? group.maxGrade != null && group.maxGrade !== group.minGrade
        ? t("bookCard.gradeRange", {
            min: group.minGrade,
            max: group.maxGrade,
          })
        : t("bookCard.gradeSingle", { grade: group.minGrade })
      : null;

  const hasOverflowWords = group.words.length > MAX_COLLAPSED_WORDS;
  const visibleWords =
    hasOverflowWords && !expanded
      ? group.words.slice(0, MAX_COLLAPSED_WORDS)
      : group.words;
  const hiddenCount = Math.max(0, group.words.length - MAX_COLLAPSED_WORDS);

  return (
    <article
      className="flex h-full min-w-0 flex-col justify-between gap-5 rounded-card border border-border bg-white p-5 shadow-xs transition-shadow hover:shadow-md sm:p-6"
      data-book-group={group.key}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-4">
          {group.bookId ? (
            group.bookCoverUrl && !coverError ? (
              /* eslint-disable-next-line @next/next/no-img-element --
                 Remote cover URLs come from the backend without a fixed
                 hostname, so next/image remotePatterns cannot be configured
                 ahead of time.  A plain <img> with onError fallback is the
                 safest option until cover URLs are served from a known CDN. */
              <img
                alt={t("bookCard.coverAlt", { title: group.bookTitle })}
                className="h-24 w-20 shrink-0 rounded-control border border-border object-cover shadow-xs sm:h-28 sm:w-24"
                loading="lazy"
                onError={handleCoverError}
                src={group.bookCoverUrl}
              />
            ) : (
              <BookCover
                book={{
                  id: group.bookId,
                  title: group.bookTitle,
                  author: group.bookAuthor,
                  min_grade: group.minGrade ?? 1,
                  max_grade: group.maxGrade ?? group.minGrade ?? 1,
                  lifecycle_status: "ACTIVE",
                }}
                className="h-24! w-20! shrink-0 rounded-control! border border-border p-2 shadow-xs sm:h-28! sm:w-24!"
                hero
              />
            )
          ) : (
            <div className="flex h-24 w-20 shrink-0 items-center justify-center rounded-control border border-border bg-surface-subtle text-primary shadow-2xs sm:h-28 sm:w-24">
              <BookOpen aria-hidden="true" className="size-8" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {gradeLabel ? (
                <span className="inline-flex items-center rounded-full bg-sky px-2.5 py-0.5 text-xs font-bold text-primary-hover">
                  {gradeLabel}
                </span>
              ) : null}
              {allCompleted ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-success-surface px-2.5 py-0.5 text-xs font-bold text-success-ink">
                  <Sparkles aria-hidden="true" className="size-3.5" />
                  {t("bookCard.completedBadge")}
                </span>
              ) : null}
            </div>

            <h2
              className="viread-learning-content mt-1.5 line-clamp-2 text-xl font-extrabold leading-snug text-ink"
              dir="ltr"
              lang="vi"
            >
              {group.bookTitle}
            </h2>

            {group.bookAuthor ? (
              <p
                className="viread-learning-content mt-0.5 truncate text-sm text-muted"
                dir="ltr"
                lang="vi"
              >
                {group.bookAuthor}
              </p>
            ) : null}

            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs font-bold text-muted">
                <span>
                  {t("bookCard.progressSummary", {
                    completed: formatNumber(group.completedWords),
                    total: formatNumber(group.totalWords),
                  })}
                </span>
                <span className="tabular-nums text-primary-hover">
                  {group.progressPercent}%
                </span>
              </div>
              <div
                aria-hidden="true"
                className="h-2.5 w-full overflow-hidden rounded-full bg-surface-subtle"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${group.progressPercent}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        <div
          className="flex flex-wrap gap-2"
          role="list"
          aria-label={t("bookCard.wordsAria", { title: group.bookTitle })}
        >
          {visibleWords.map((word) => {
            const status: DifficultWordPracticeStatus =
              word.practice_status ?? "NOT_PRACTICED";
            const style = CHIP_STYLES[status];
            const statusLabel = t(style.labelKey);
            return (
              <button
                aria-label={t("bookCard.wordButtonAria", {
                  word: word.display_text,
                  status: statusLabel,
                })}
                className={`inline-flex min-h-12 items-center gap-2 rounded-full border px-4 py-1.5 text-base font-extrabold shadow-2xs transition-all hover:-translate-y-0.5 hover:shadow-xs focus-visible:outline-3 focus-visible:outline-offset-2 ${style.className}`}
                key={word.normalized_word}
                onClick={() => onSelectWord(word)}
                type="button"
              >
                {status === "COMPLETED" ? (
                  <Check
                    aria-hidden="true"
                    className="size-4 text-success-ink"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className={`size-2 rounded-full ${style.dotClass}`}
                  />
                )}
                <span className="viread-learning-content" dir="ltr" lang="vi">
                  {word.display_text}
                </span>
              </button>
            );
          })}

          {hasOverflowWords ? (
            <button
              aria-expanded={expanded}
              className="inline-flex min-h-11 items-center rounded-full border border-dashed border-primary/40 bg-canvas px-3.5 py-1.5 text-xs font-extrabold text-primary transition-colors hover:bg-sky/60 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onClick={() => setExpanded((prev) => !prev)}
              type="button"
            >
              {expanded
                ? t("bookCard.showFewerWords")
                : t("bookCard.showMoreWords", {
                    count: formatNumber(hiddenCount),
                  })}
            </button>
          ) : null}
        </div>

        <details className="group rounded-control border border-border bg-surface-subtle/80 px-4 py-2.5 text-sm">
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between font-bold text-ink">
            <span>{t("bookCard.parentDetails")}</span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 text-muted transition-transform group-open:rotate-180"
            />
          </summary>
          <ul className="mt-2.5 divide-y divide-border/70 border-t border-border pt-2 text-xs text-muted">
            {group.words.map((word) => {
              const source = word.sources?.[0];
              const mispronounced = word.mispronunciation_count ?? 0;
              return (
                <li
                  className="flex flex-col gap-1.5 py-2 first:pt-1 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                  key={`detail-${word.normalized_word}`}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className="viread-learning-content text-sm font-extrabold text-ink"
                        dir="ltr"
                        lang="vi"
                      >
                        {word.display_text}
                      </span>
                      {source?.page_number ? (
                        <span className="inline-flex items-center rounded-full border border-border bg-white px-2 py-0.5 text-[11px] font-bold text-muted">
                          {tr("progress.pageLabel", {
                            page: formatNumber(source.page_number),
                          })}
                        </span>
                      ) : null}
                    </div>
                    {source?.context_phrase ? (
                      <p
                        className="viread-learning-content italic text-muted"
                        dir="ltr"
                        lang="vi"
                      >
                        “{source.context_phrase}”
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5 tabular-nums">
                    <span className="rounded-full border border-border bg-white px-2 py-0.5 text-[11px] font-bold text-ink">
                      {
                        t("bookCard.wordStats", {
                          score: formatNumber(word.difficulty_score),
                          mispronounced: formatNumber(mispronounced),
                          omitted: formatNumber(word.omission_count),
                          repeated: formatNumber(word.repetition_count),
                        }).split(" · ")[0]
                      }
                    </span>
                    {mispronounced > 0 ? (
                      <span className="rounded-full bg-orange-100/90 px-2 py-0.5 text-[11px] font-bold text-orange-900">
                        {t("bookCard.tagMispronounced", {
                          count: formatNumber(mispronounced),
                        })}
                      </span>
                    ) : null}
                    {word.omission_count > 0 ? (
                      <span className="rounded-full bg-warning-surface px-2 py-0.5 text-[11px] font-bold text-warning">
                        {t("bookCard.tagOmitted", {
                          count: formatNumber(word.omission_count),
                        })}
                      </span>
                    ) : null}
                    {word.repetition_count > 0 ? (
                      <span className="rounded-full bg-sky px-2 py-0.5 text-[11px] font-bold text-primary-hover">
                        {t("bookCard.tagRepeated", {
                          count: formatNumber(word.repetition_count),
                        })}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      </div>

      {firstPendingWord ? (
        <Button
          className="min-h-12 w-full rounded-control text-base font-extrabold"
          onClick={() => onStartBookPractice(firstPendingWord)}
          variant={allCompleted ? "secondary" : "primary"}
        >
          <Mic aria-hidden="true" className="size-5" />
          {allCompleted
            ? t("bookCard.reviewBookAction")
            : t("bookCard.practiceBookAction")}
        </Button>
      ) : null}
    </article>
  );
}
