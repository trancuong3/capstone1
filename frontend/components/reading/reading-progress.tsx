import { Circle } from "lucide-react";

interface ReadingProgressProps {
  isListening: boolean;
  pageNumber: number;
  wordCount?: number;
  readCount?: number;
  currentWord?: string | null;
}

export function ReadingProgress({
  isListening,
  pageNumber,
  wordCount = 0,
  readCount = 0,
  currentWord,
}: ReadingProgressProps) {
  const progressPercent =
    wordCount > 0
      ? Math.min(100, Math.round((readCount / wordCount) * 100))
      : 0;

  return (
    <div className="mx-auto w-full max-w-[1104px]">
      <div
        aria-hidden="true"
        className="h-[3px] w-full overflow-hidden rounded-full bg-border/60 md:hidden"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      <div
        className="flex items-center justify-between gap-2 px-0.5 pt-1 text-[11px] leading-tight md:grid md:grid-cols-[1fr_auto] md:items-center md:gap-2 md:border-t md:border-border md:px-1 md:pt-4 md:text-sm"
        role="status"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-bold text-ink md:gap-2">
          <Circle
            aria-hidden="true"
            className="size-2 shrink-0 fill-current text-primary md:size-2.5"
          />
          <span className="truncate">
            {isListening ? "Mình đang nghe bé đọc" : "Mình đang chờ bé"}
          </span>
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted md:text-sm">
          Trang {pageNumber}
          {wordCount > 0 && (
            <>
              {" "}
              · Đã đọc {readCount}/{wordCount} từ
            </>
          )}
          {currentWord && isListening && (
            <span className="hidden md:inline">
              {" "}
              · Từ đang đọc: “{currentWord}”
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
