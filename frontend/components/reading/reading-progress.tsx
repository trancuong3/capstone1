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
  return (
    <div
      className="mx-auto grid w-full max-w-[1104px] gap-2 border-t border-border px-1 pt-4 sm:grid-cols-[1fr_auto] sm:items-center"
      role="status"
    >
      <span className="inline-flex items-center gap-2 font-bold text-ink">
        <Circle
          aria-hidden="true"
          className="size-2.5 fill-current text-primary"
        />
        {isListening ? "Mình đang nghe bé đọc" : "Mình đang chờ bé"}
      </span>
      <span className="text-sm tabular-nums text-muted">
        Trang {pageNumber}
        {wordCount > 0 && (
          <>
            {" "}
            · Đã đọc {readCount}/{wordCount} từ
          </>
        )}
        {currentWord && isListening && <> · Từ đang đọc: “{currentWord}”</>}
      </span>
    </div>
  );
}
