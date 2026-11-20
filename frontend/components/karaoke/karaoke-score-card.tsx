"use client";

import { Star } from "lucide-react";
import { Button } from "@/components/common/button";
import type { LiveSingingScore } from "@/lib/karaoke/live-singing-score";

export function KaraokeScoreCard({
  score,
  practice = false,
  onPractice,
}: {
  score: LiveSingingScore;
  practice?: boolean;
  onPractice?: (lineId: string) => void;
}) {
  const { overallAccuracy, matchedWords, evaluatedWords, totalWords } = score;
  const points =
    overallAccuracy ??
    (!practice && score.kind === "partial" && evaluatedWords > 0
      ? Math.round((100 * matchedWords) / evaluatedWords)
      : null);
  const suggested =
    score.lineScores.find((line) => line.matchedWords < line.words.length) ??
    score.lineScores[0];

  return (
    <section
      aria-label="Kết quả đúng lời"
      className="mx-auto grid w-full max-w-lg gap-3 rounded-card bg-white p-5 text-center shadow-sm"
    >
      {points !== null && (
        <div className="grid gap-1">
          <p className="font-bold">
            {score.kind === "whole" ? "Điểm đúng lời" : "Điểm phần đã nghe"}
          </p>
          <p className="text-5xl font-extrabold text-primary">{points}/100</p>
        </div>
      )}
      {overallAccuracy !== null && (
        <div aria-hidden className="flex justify-center gap-1 text-amber-700">
          {Array.from({ length: 5 }, (_, i) => (
            <Star
              key={i}
              className={
                i < Math.round(overallAccuracy / 20)
                  ? "size-7 fill-amber-300"
                  : "size-7 opacity-30"
              }
            />
          ))}
        </div>
      )}
      <p role="status" className="font-bold">
        {score.kind === "insufficient"
          ? "Mình chưa nghe rõ. Bé thử lại nhé!"
          : `Bé hát khớp ${matchedWords}/${evaluatedWords} tiếng trong phần đã nghe.`}
      </p>
      {evaluatedWords > 0 && (
        <p className="text-sm text-muted">
          Đã đánh giá {evaluatedWords}/{totalWords} tiếng.
        </p>
      )}
      {onPractice && suggested && (
        <Button
          variant="secondary"
          onClick={() => onPractice(suggested.lineId)}
        >
          Luyện lại câu {suggested.lineIndex + 1}
        </Button>
      )}
      {onPractice && score.lineScores.length > 1 && (
        <details className="text-left">
          <summary className="cursor-pointer py-2 font-bold">
            Xem từng câu
          </summary>
          <ol className="grid max-h-72 gap-2 overflow-y-auto">
            {score.lineScores.map((line) => (
              <li key={line.lineId}>
                <button
                  type="button"
                  className="min-h-12 w-full rounded-control border border-border p-2 text-left"
                  onClick={() => onPractice(line.lineId)}
                >
                  <span className="block font-bold">
                    Câu {line.lineIndex + 1} · {line.lineText}
                  </span>
                  {line.evaluatedWords
                    ? `${line.matchedWords}/${line.evaluatedWords} tiếng khớp · Luyện lại`
                    : "Chưa nghe rõ · Luyện lại"}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
