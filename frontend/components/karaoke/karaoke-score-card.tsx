"use client";

import { Star, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { SingingScore } from "@/lib/karaoke/singing-score";

function accuracyLabel(accuracy: number): string {
  if (accuracy >= 90) return "Xuất sắc!";
  if (accuracy >= 70) return "Giỏi lắm!";
  if (accuracy >= 50) return "Khá tốt!";
  if (accuracy >= 30) return "Cố gắng thêm nhé!";
  return "Luyện tập thêm nào!";
}

function accuracyColor(accuracy: number): string {
  if (accuracy >= 70) return "text-success-ink";
  if (accuracy >= 40) return "text-primary";
  return "text-muted";
}

function starCount(accuracy: number): number {
  if (accuracy >= 90) return 5;
  if (accuracy >= 70) return 4;
  if (accuracy >= 50) return 3;
  if (accuracy >= 30) return 2;
  if (accuracy >= 10) return 1;
  return 0;
}

export function KaraokeScoreCard({ score }: { score: SingingScore }) {
  const [showDetail, setShowDetail] = useState(false);
  const stars = starCount(score.overallAccuracy);

  return (
    <div className="mx-auto w-full max-w-sm space-y-4 rounded-card border border-border bg-white p-6 text-center shadow-sm">
      {/* Stars */}
      <div
        className="flex items-center justify-center gap-1"
        aria-label={`${stars} trên 5 sao`}
      >
        {Array.from({ length: 5 }, (_, i) => (
          <Star
            key={i}
            aria-hidden
            className={`size-8 ${
              i < stars
                ? "fill-amber-100 text-amber-500"
                : "fill-transparent text-border"
            }`}
          />
        ))}
      </div>

      {/* Score */}
      <div>
        <p
          className={`text-heading font-extrabold ${accuracyColor(score.overallAccuracy)}`}
        >
          {score.overallAccuracy}%
        </p>
        <p className="text-label font-bold text-ink">
          {accuracyLabel(score.overallAccuracy)}
        </p>
      </div>

      {/* Stats */}
      <p className="text-label text-muted">
        Đúng {score.matchedWords}/{score.totalWords} từ
      </p>

      {/* Detail toggle */}
      {score.lineScores.length > 0 && (
        <div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-label font-semibold text-primary hover:text-primary-hover"
            onClick={() => setShowDetail((prev) => !prev)}
            aria-expanded={showDetail}
          >
            {showDetail ? (
              <>
                Ẩn chi tiết <ChevronUp aria-hidden className="size-4" />
              </>
            ) : (
              <>
                Xem chi tiết <ChevronDown aria-hidden className="size-4" />
              </>
            )}
          </button>

          {showDetail && (
            <div className="mt-3 space-y-2 text-left">
              {score.lineScores.map((ls) => (
                <div
                  key={ls.lineIndex}
                  className="flex items-center justify-between gap-2 rounded-control border border-border px-3 py-2"
                >
                  <span className="text-label text-ink">{ls.lineText}</span>
                  <span
                    className={`whitespace-nowrap text-label font-bold ${accuracyColor(ls.accuracy)}`}
                  >
                    {ls.accuracy}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
