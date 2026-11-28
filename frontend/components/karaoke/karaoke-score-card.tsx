"use client";

import { Star } from "lucide-react";
import { Button } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import type {
  LiveSingingScore,
  LiveWordState,
} from "@/lib/karaoke/live-singing-score";

const wordBadgeClass: Record<LiveWordState, string> = {
  matched: "border-green-500 bg-green-100 text-green-900",
  different:
    "border-red-500 bg-red-100 text-red-900 underline decoration-red-600",
  omitted: "border-orange-400 bg-orange-100 text-orange-900",
  unknown: "border-slate-200 bg-slate-100 text-slate-500",
};

function encouragementKey(points: number): string {
  if (points >= 90) return "karaoke.score.praise90";
  if (points >= 70) return "karaoke.score.praise70";
  if (points >= 50) return "karaoke.score.praise50";
  return "karaoke.score.praiseLow";
}

export function KaraokeScoreCard({
  score,
  practice = false,
  onPractice,
}: {
  score: LiveSingingScore;
  practice?: boolean;
  onPractice?: (lineId: string) => void;
}) {
  const t = useTranslations("entertainment");
  const { overallAccuracy, matchedWords, evaluatedWords, totalWords } = score;
  const points =
    overallAccuracy ??
    (!practice && score.kind === "partial" && evaluatedWords > 0
      ? Math.round((100 * matchedWords) / evaluatedWords)
      : null);
  const allWords = score.lineScores.flatMap((line) => line.words);
  const differentWords = allWords.filter((w) => w.state === "different").length;
  const omittedWords = allWords.filter((w) => w.state === "omitted").length;
  const errorLine = score.lineScores.find((line) =>
    line.words.some(
      (word) => word.state === "different" || word.state === "omitted",
    ),
  );
  const unheardLine = score.lineScores.find((line) =>
    line.words.some((word) => word.state === "unknown"),
  );
  const suggested = errorLine ?? unheardLine;
  const unassessedWords = totalWords - evaluatedWords;

  return (
    <section
      aria-label={t("karaoke.score.regionAria")}
      className="mx-auto grid w-full max-w-lg gap-3 rounded-card bg-white p-4 text-center shadow-sm sm:p-5"
    >
      {points !== null && (
        <div className="grid gap-1">
          <p className="font-bold">
            {score.kind === "whole"
              ? t("karaoke.score.wholePointsTitle")
              : t("karaoke.score.partialPointsTitle")}
          </p>
          <p className="text-5xl font-extrabold text-primary">{points}/100</p>
          <p className="text-sm font-semibold text-primary">
            {t(encouragementKey(points))}
          </p>
        </div>
      )}
      {points !== null && (
        <div aria-hidden className="flex justify-center gap-1 text-amber-700">
          {Array.from({ length: 5 }, (_, i) => (
            <Star
              key={i}
              className={
                i < Math.round(points / 20)
                  ? "size-7 fill-amber-300"
                  : "size-7 opacity-30"
              }
            />
          ))}
        </div>
      )}
      <p role="status" className="font-bold">
        {score.kind === "insufficient"
          ? t("karaoke.score.insufficient")
          : t("karaoke.score.matchedSummary", {
              matched: matchedWords,
              evaluated: evaluatedWords,
            })}
      </p>
      {unassessedWords > 0 && (
        <p className="text-sm text-muted">
          {t("karaoke.score.unassessedNote", { count: unassessedWords })}
        </p>
      )}
      {evaluatedWords > 0 && (
        <>
          <p className="text-sm text-muted">
            {t("karaoke.score.evaluatedTotal", {
              evaluated: evaluatedWords,
              total: totalWords,
            })}
          </p>
          <div
            data-testid="karaoke-score-breakdown"
            className="grid grid-cols-3 gap-2 text-xs font-bold sm:text-sm"
          >
            <div className="rounded-control border border-green-400 bg-green-50 p-2 text-green-900">
              <span className="block">{t("karaoke.score.matchedBox")}</span>
              <span className="text-lg font-extrabold">{matchedWords}</span>
            </div>
            <div className="rounded-control border border-red-400 bg-red-50 p-2 text-red-900">
              <span className="block">{t("karaoke.score.wrongBox")}</span>
              <span className="text-lg font-extrabold">{differentWords}</span>
            </div>
            <div className="rounded-control border border-orange-400 bg-orange-50 p-2 text-orange-900">
              <span className="block">{t("karaoke.score.omittedBox")}</span>
              <span className="text-lg font-extrabold">{omittedWords}</span>
            </div>
          </div>
        </>
      )}
      {practice && score.lineScores.length === 1 && evaluatedWords > 0 && (
        <div
          aria-hidden="true"
          className="viread-learning-content flex flex-wrap justify-center gap-1.5 pt-1 text-sm font-bold"
          dir="ltr"
          lang="vi"
        >
          {score.lineScores[0].words.map((word) => (
            <span
              key={word.id}
              data-word-chip={word.state}
              className={`rounded border px-2 py-0.5 ${wordBadgeClass[word.state]}`}
            >
              {word.text}
            </span>
          ))}
        </div>
      )}
      {onPractice && suggested && (
        <Button
          variant="secondary"
          onClick={() => onPractice(suggested.lineId)}
        >
          {errorLine
            ? t("karaoke.score.practiceErrorLine", {
                number: suggested.lineIndex + 1,
              })
            : t("karaoke.score.practiceUnheardLine", {
                number: suggested.lineIndex + 1,
              })}
        </Button>
      )}
      {onPractice && score.lineScores.length > 1 && (
        <details className="text-start">
          <summary className="flex min-h-11 cursor-pointer items-center font-bold">
            {t("karaoke.score.viewLinesSummary")}
          </summary>
          <ol className="grid max-h-72 gap-2 overflow-y-auto">
            {score.lineScores.map((line) => (
              <li key={line.lineId}>
                <button
                  type="button"
                  className="min-h-12 w-full rounded-control border border-border p-2 text-start"
                  onClick={() => onPractice(line.lineId)}
                >
                  <span className="block font-bold">
                    {t("karaoke.score.linePrefix", {
                      number: line.lineIndex + 1,
                    })}
                    <span
                      className="viread-learning-content"
                      dir="ltr"
                      lang="vi"
                    >
                      {line.lineText}
                    </span>
                  </span>
                  {line.evaluatedWords > 0 && (
                    <span
                      aria-hidden="true"
                      className="viread-learning-content my-1.5 flex flex-wrap gap-1 text-xs font-semibold"
                      dir="ltr"
                      lang="vi"
                    >
                      {line.words.map((word) => (
                        <span
                          key={word.id}
                          data-word-chip={word.state}
                          className={`rounded border px-1.5 py-0.5 ${wordBadgeClass[word.state]}`}
                        >
                          {word.text}
                        </span>
                      ))}
                    </span>
                  )}
                  {line.evaluatedWords
                    ? t("karaoke.score.lineMatchedRetry", {
                        matched: line.matchedWords,
                        evaluated: line.evaluatedWords,
                      })
                    : t("karaoke.score.lineUnheardRetry")}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
