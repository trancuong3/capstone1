import type { TutorAction } from "@/types/reading";

import { ReadingStatusDialog } from "@/components/reading/reading-status-dialog";

interface TutorMessageProps {
  action: TutorAction | null;
  isRetrying: boolean;
  onClose: () => void;
  onRetry: () => void;
  ttsFailed?: boolean;
  word: string;
}

export function TutorMessage({
  action,
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
          <p className="text-[32px] font-extrabold text-primary">{word}</p>
          <p>
            {ttsFailed
              ? "Mình chưa phát được âm thanh. Bé vẫn có thể nhìn chữ và đọc tiếp nhé."
              : "Nghe thử nhé. Đây chỉ là hỗ trợ mô phỏng, không tự động phát âm thanh."}
          </p>
          {action?.message_code === "READ_EXAMPLE_REPLAYED" ? (
            <p className="font-bold text-success-ink" role="status">
              Đã thử lại phần nghe mẫu.
            </p>
          ) : null}
        </div>
      }
      closeOnEscape
      onClose={onClose}
      primaryAction={{
        isLoading: isRetrying,
        label: ttsFailed ? "Thử nghe lại" : "Nghe mẫu",
        onClick: onRetry,
        variant: "secondary",
      }}
      secondaryAction={{ label: "Đọc tiếp", onClick: onClose }}
      title="Từ này mình đọc thế nào nhỉ?"
    />
  );
}
