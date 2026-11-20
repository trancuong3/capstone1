"use client";

import { Star } from "lucide-react";
import { Button } from "@/components/common/button";
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

function encouragementText(points: number): string {
  if (points >= 90) return "Xuất sắc! Bé hát rất đúng lời!";
  if (points >= 70) return "Giỏi lắm! Bé hát khá tốt!";
  if (points >= 50) return "Khá tốt! Bé luyện thêm vài câu nữa nhé!";
  return "Cố lên nhé! Mình cùng luyện lại từng câu nha!";
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
  const { overallAccuracy, matchedWords, evaluatedWords, totalWords } = score;
  const points =
    overallAccuracy ??
    (!practice && score.kind === "partial" && evaluatedWords > 0
      ? Math.round((100 * matchedWords) / evaluatedWords)
      : null);
  const allWords = score.lineScores.flatMap((line) => line.words);
  const differentWords = allWords.filter((w) => w.state === "different").length;
  const omittedWords = allWords.filter((w) => w.state === "omitted").length;
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
          <p className="text-sm font-semibold text-primary">
            {encouragementText(points)}
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
          ? "Mình chưa nghe rõ. Bé thử lại nhé!"
          : `Bé hát khớp ${matchedWords}/${evaluatedWords} tiếng trong phần đã nghe.`}
      </p>
      {evaluatedWords > 0 && (
        <>
          <p className="text-sm text-muted">
            Đã đánh giá {evaluatedWords}/{totalWords} tiếng.
          </p>
          <div
            data-testid="karaoke-score-breakdown"
            className="grid grid-cols-3 gap-2 text-xs font-bold sm:text-sm"
          >
            <div className="rounded-control border border-green-400 bg-green-50 p-2 text-green-900">
              <span className="block">Hát đúng</span>
              <span className="text-lg font-extrabold">{matchedWords}</span>
            </div>
            <div className="rounded-control border border-red-400 bg-red-50 p-2 text-red-900">
              <span className="block">Chưa đúng</span>
              <span className="text-lg font-extrabold">{differentWords}</span>
            </div>
            <div className="rounded-control border border-orange-400 bg-orange-50 p-2 text-orange-900">
              <span className="block">Bỏ qua</span>
              <span className="text-lg font-extrabold">{omittedWords}</span>
            </div>
          </div>
        </>
      )}
      {practice && score.lineScores.length === 1 && evaluatedWords > 0 && (
        <div
          aria-hidden="true"
          className="flex flex-wrap justify-center gap-1.5 pt-1 text-sm font-bold"
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
                  {line.evaluatedWords > 0 && (
                    <span
                      aria-hidden="true"
                      className="my-1.5 flex flex-wrap gap-1 text-xs font-semibold"
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
