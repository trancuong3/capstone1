import { Circle, ScanLine } from "lucide-react";

interface ReadingProgressProps {
  isListening: boolean;
  pageNumber: number;
}

export function ReadingProgress({
  isListening,
  pageNumber,
}: ReadingProgressProps) {
  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center justify-center gap-x-16 gap-y-2 text-label font-bold text-muted"
      role="status"
    >
      <span className="inline-flex items-center gap-2">
        <Circle aria-hidden="true" className="size-3 fill-current" />
        {isListening ? "Mình đang nghe bé đọc" : "Mình đang chờ bé"}
      </span>
      <span className="inline-flex items-center gap-2 text-success-ink">
        <ScanLine aria-hidden="true" className="size-4" />
        Đã thấy trang {pageNumber}
      </span>
    </div>
  );
}
