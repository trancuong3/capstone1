import type { TutorAction } from "@/types/reading";

import { ReadingStatusDialog } from "@/components/reading/reading-status-dialog";

interface TutorMessageProps {
  action: TutorAction | null;
  errorMessage?: string | null;
  isPlaying?: boolean;
  isRetrying: boolean;
  onClose: () => void;
  onRetry: () => void;
  ttsFailed?: boolean;
  word: string;
}

export function TutorMessage({
  action,
  errorMessage = null,
  isPlaying = false,
  isRetrying,
  onClose,
  onRetry,
  ttsFailed = false,
  word,
}: TutorMessageProps) {
  return (
    <ReadingStatusDialog
      body={
        <div className="space-y-3">
          <p className="text-[32px] font-semibold text-primary">{word}</p>
          <p>
            {ttsFailed
              ? (errorMessage ??
                "Mình chưa phát được âm thanh. Bé vẫn có thể nhìn chữ và đọc tiếp nhé.")
              : isPlaying
                ? "Mình đang phát âm thanh mẫu. Bé lắng nghe nhé."
                : "Bé có thể nhấn Nghe mẫu để nghe lại từ này."}
          </p>
          {action?.message_code === "READ_EXAMPLE_REPLAYED" ? (
            <p className="font-semibold text-success-ink" role="status">
              Đã thử lại phần nghe mẫu.
            </p>
          ) : null}
        </div>
      }
      closeOnEscape
      onClose={onClose}
      primaryAction={{
        disabled: isPlaying,
        isLoading: isRetrying,
        label: isPlaying
          ? "Đang phát"
          : ttsFailed
            ? "Thử nghe lại"
            : "Nghe mẫu",
        onClick: onRetry,
        variant: "secondary",
      }}
      secondaryAction={{ label: "Đọc tiếp", onClick: onClose }}
      title="Từ này mình đọc thế nào nhỉ?"
    />
  );
}
