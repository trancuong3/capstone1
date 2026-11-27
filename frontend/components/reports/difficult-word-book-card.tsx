"use client";

import { BookOpen, Check, ChevronDown, Mic, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";

import { BookCover } from "@/components/books/book-cover";
import { Button } from "@/components/common/button";
import { PaginationBar } from "@/components/common/pagination-bar";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type {
  DifficultWordBookGroup,
  DifficultWordDTO,
  DifficultWordPracticeStatus,
} from "@/types/reports";

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
      "border-red-300 bg-red-50 text-red-900 hover:bg-red-100 focus-visible:outline-red-600",
    dotClass: "bg-red-500",
    labelKey: "bookCard.badgeNotPracticed",
  },
  NEEDS_MORE_PRACTICE: {
    className:
      "border-red-300 bg-red-50 text-red-900 hover:bg-red-100 focus-visible:outline-red-600",
    dotClass: "bg-red-500",
    labelKey: "bookCard.badgeNeedsMore",
  },
  IN_PROGRESS: {
    className:
      "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 focus-visible:outline-amber-600",
    dotClass: "bg-amber-500",
    labelKey: "bookCard.badgeInProgress",
  },
  COMPLETED: {
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 focus-visible:outline-emerald-600",
    dotClass: "bg-emerald-500",
    labelKey: "bookCard.badgeCompleted",
  },
};

const WORD_CHIPS_PAGE_SIZE = 12;
const DETAIL_WORDS_PAGE_SIZE = 6;

export function DifficultWordBookCard({
  group,
  onStartBookPractice,
  onSelectWord,
}: DifficultWordBookCardProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("difficultWords");
  const tr = useTranslations("reading");
  const [coverError, setCoverError] = useState(false);
  const [chipsPage, setChipsPage] = useState(1);
  const [detailsPage, setDetailsPage] = useState(1);
  const handleCoverError = useCallback(() => setCoverError(true), []);

  const totalChipPages = Math.max(
    1,
    Math.ceil(group.words.length / WORD_CHIPS_PAGE_SIZE),
  );
  const safeChipsPage = Math.min(Math.max(1, chipsPage), totalChipPages);
  const visibleChipWords = group.words.slice(
    (safeChipsPage - 1) * WORD_CHIPS_PAGE_SIZE,
    safeChipsPage * WORD_CHIPS_PAGE_SIZE,
  );

  const totalDetailPages = Math.max(
    1,
    Math.ceil(group.words.length / DETAIL_WORDS_PAGE_SIZE),
  );
  const safeDetailsPage = Math.min(Math.max(1, detailsPage), totalDetailPages);
  const visibleDetailWords = group.words.slice(
    (safeDetailsPage - 1) * DETAIL_WORDS_PAGE_SIZE,
    safeDetailsPage * DETAIL_WORDS_PAGE_SIZE,
  );

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

  return (
    <article
      className="flex min-w-0 flex-col justify-between gap-5 rounded-[24px] border border-[#DCE8E4] bg-white p-5 shadow-sm transition-shadow hover:shadow-md sm:p-6"
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
                className="h-24 w-20 shrink-0 rounded-2xl border border-[#DCE8E4] object-cover sm:h-28 sm:w-24"
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
                className="h-24! w-20! shrink-0 rounded-2xl! border border-[#DCE8E4] p-2 sm:h-28! sm:w-24!"
                hero
              />
            )
          ) : (
            <div className="flex h-24 w-20 shrink-0 items-center justify-center rounded-2xl border border-[#DCE8E4] bg-[#F6FAF8] text-[#147D87] sm:h-28 sm:w-24">
              <BookOpen aria-hidden="true" className="size-8" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {gradeLabel ? (
                <span className="inline-flex items-center rounded-full bg-[#DDF3F5] px-2.5 py-0.5 text-xs font-bold text-[#0E6D76]">
                  {gradeLabel}
                </span>
              ) : null}
              {allCompleted ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-900">
                  <Sparkles aria-hidden="true" className="size-3.5" />
                  {t("bookCard.completedBadge")}
                </span>
              ) : null}
            </div>

            <h2
              className="viread-learning-content mt-1.5 text-xl font-extrabold leading-snug text-[#213C42]"
              dir="ltr"
              lang="vi"
            >
              {group.bookTitle}
            </h2>

            {group.bookAuthor ? (
              <p
                className="viread-learning-content mt-0.5 truncate text-sm text-[#526970]"
                dir="ltr"
                lang="vi"
              >
                {group.bookAuthor}
              </p>
            ) : null}

            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs font-bold text-[#526970]">
                <span>
                  {t("bookCard.progressSummary", {
                    completed: formatNumber(group.completedWords),
                    total: formatNumber(group.totalWords),
                  })}
                </span>
                <span className="tabular-nums text-[#0E6D76]">
                  {group.progressPercent}%
                </span>
              </div>
              <div
                aria-hidden="true"
                className="h-2.5 w-full overflow-hidden rounded-full bg-[#E8EFEA]"
              >
                <div
                  className="h-full rounded-full bg-[#147D87] transition-all duration-300"
                  style={{ width: `${group.progressPercent}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          <div
            className="flex flex-wrap gap-2"
            role="list"
            aria-label={t("bookCard.wordsAria", { title: group.bookTitle })}
          >
            {visibleChipWords.map((word) => {
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
                  className={`inline-flex min-h-12 items-center gap-2 rounded-full border px-4 py-2 text-base font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 ${style.className}`}
                  key={word.normalized_word}
                  onClick={() => onSelectWord(word)}
                  type="button"
                >
                  {status === "COMPLETED" ? (
                    <Check
                      aria-hidden="true"
                      className="size-4 text-emerald-700"
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
          </div>
          <PaginationBar
            ariaLabel={t("bookCard.wordsAria", { title: group.bookTitle })}
            compact
            onPageChange={setChipsPage}
            page={safeChipsPage}
            pageSize={WORD_CHIPS_PAGE_SIZE}
            total={group.words.length}
          />
        </div>

        <details className="group rounded-2xl border border-[#DCE8E4] bg-[#F6FAF8] px-4 py-2.5 text-sm">
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between font-bold text-[#213C42]">
            <span>{t("bookCard.parentDetails")}</span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 text-[#526970] transition-transform group-open:rotate-180"
            />
          </summary>
          <ul className="mt-2.5 space-y-2 border-t border-[#DCE8E4] pt-2.5 text-xs text-[#526970]">
            {visibleDetailWords.map((word) => {
              const source = word.sources?.[0];
              return (
                <li
                  className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between"
                  key={`detail-${word.normalized_word}`}
                >
                  <div>
                    <span
                      className="viread-learning-content font-bold text-[#213C42]"
                      dir="ltr"
                      lang="vi"
                    >
                      {word.display_text}
                    </span>
                    {source?.page_number ? (
                      <span>
                        {" "}
                        ·{" "}
                        {tr("progress.pageLabel", {
                          page: formatNumber(source.page_number),
                        })}
                      </span>
                    ) : null}
                    {source?.context_phrase ? (
                      <span
                        className="viread-learning-content italic"
                        dir="ltr"
                        lang="vi"
                      >
                        {" "}
                        · “{source.context_phrase}”
                      </span>
                    ) : null}
                  </div>
                  <span className="tabular-nums">
                    {t("bookCard.wordStats", {
                      score: formatNumber(word.difficulty_score),
                      mispronounced: formatNumber(
                        word.mispronunciation_count ?? 0,
                      ),
                      omitted: formatNumber(word.omission_count),
                      repeated: formatNumber(word.repetition_count),
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
          <PaginationBar
            ariaLabel={t("bookCard.parentDetails")}
            className="mt-2.5"
            compact
            onPageChange={setDetailsPage}
            page={safeDetailsPage}
            pageSize={DETAIL_WORDS_PAGE_SIZE}
            total={group.words.length}
          />
        </details>
      </div>

      {firstPendingWord ? (
        <Button
          className="min-h-12 w-full rounded-2xl text-base font-extrabold"
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
