"use client";

import { Mic, Volume2 } from "lucide-react";
import type { SessionReviewItem } from "@/lib/utils/session-review-queue";

export type EndReviewActivity =
  "ready" | "listening" | "processing" | "assisting";

interface EndOfReadingReviewProps {
  readonly item: SessionReviewItem;
  readonly currentPosition: number;
  readonly totalItems: number;
  readonly activity: EndReviewActivity;
  readonly secondsRemaining: number | null;
  readonly feedback: string;
  readonly onStartAttempt: () => void;
}

export function EndOfReadingReview({
  item,
  currentPosition,
  totalItems,
  activity,
  secondsRemaining,
  feedback,
  onStartAttempt,
}: EndOfReadingReviewProps) {
  const progress = totalItems > 0 ? (currentPosition / totalItems) * 100 : 100;

  return (
    <main
      aria-label="Luyện lại từ sau khi đọc"
      className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col justify-center gap-6 px-4 py-8"
      data-review-word-id={item.wordId}
      data-review-activity={activity}
    >
      <header className="space-y-3 text-center">
        <p className="text-sm font-bold text-primary">Con đã đọc xong rồi!</p>
        <h1 className="text-heading font-extrabold text-ink">
          Mình cùng luyện lại một vài từ nhé.
        </h1>
        <p className="text-sm text-muted" aria-live="polite">
          Có {totalItems} từ cần nghe lại · Từ thứ {currentPosition} /{" "}
          {totalItems}
        </p>
        <div
          className="h-2 overflow-hidden rounded-full bg-cream-dark"
          role="progressbar"
          aria-label="Tiến trình luyện từ"
          aria-valuemin={0}
          aria-valuemax={totalItems}
          aria-valuenow={Math.max(0, currentPosition - 1)}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      <section className="flex flex-col items-center gap-5 rounded-card border border-line bg-white px-5 py-8 text-center shadow-sm sm:px-8">
        <p className="text-base font-semibold text-muted">
          Con cùng đọc lại nhé!
        </p>
        <p
          className="text-5xl font-black leading-tight text-ink sm:text-6xl"
          data-testid="review-target-word"
        >
          {item.expectedWord}
        </p>
        {item.reason === "CONFIDENTLY_INCORRECT" ? (
          <p className="max-w-md text-sm text-muted">
            Mình thử đọc lại từ này chậm rãi nhé.
          </p>
        ) : (
          <p className="max-w-md text-sm text-muted">
            Mình chưa nghe rõ từ này. Con thử đọc lại hoặc nghe mẫu nhé.
          </p>
        )}

        {activity === "listening" ? (
          <div className="flex flex-col items-center gap-2" role="status">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Mic aria-hidden="true" className="size-6 animate-pulse" />
            </span>
            <p className="font-semibold text-primary">
              Mình đang nghe con đọc…
            </p>
            <p className="text-sm text-muted">
              Còn {secondsRemaining ?? 3} giây
            </p>
          </div>
        ) : activity === "processing" ? (
          <div className="flex flex-col items-center gap-2" role="status">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Mic aria-hidden="true" className="size-6" />
            </span>
            <p className="font-semibold text-primary">
              Mình đang kiểm tra lời đọc…
            </p>
            <p className="text-sm text-muted">
              Mình đợi kết quả nhận diện hoàn tất nhé.
            </p>
          </div>
        ) : activity === "assisting" ? (
          <div className="flex flex-col items-center gap-2" role="status">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Volume2 aria-hidden="true" className="size-6 animate-pulse" />
            </span>
            <p className="font-semibold text-primary">
              Mình nghe mẫu trước nhé.
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={onStartAttempt}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-control bg-primary px-6 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Mic aria-hidden="true" className="size-5" />
            {item.attempts === 0 ? "Bắt đầu đọc" : "Con thử lại nhé!"}
          </button>
        )}

        <p
          className="min-h-6 text-sm font-semibold text-muted"
          aria-live="polite"
        >
          {feedback}
        </p>
        <p className="text-xs text-muted">
          Lượt thử:{" "}
          {Math.min(
            item.attempts +
              (activity === "listening" || activity === "processing" ? 1 : 0),
            2,
          )}{" "}
          / 2
        </p>
      </section>
    </main>
  );
}
