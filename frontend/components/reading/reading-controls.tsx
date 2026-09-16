import { Check, CircleHelp, List, Pause, Volume2 } from "lucide-react";

import { Button } from "@/components/common/button";

interface ReadingControlsProps {
  disabled?: boolean;
  onFinish: () => void;
  onHelp: () => void;
  onManualPage: () => void;
  onPause: () => void;
}

export function ReadingControls({
  disabled = false,
  onFinish,
  onHelp,
  onManualPage,
  onPause,
}: ReadingControlsProps) {
  return (
    <nav
      aria-label="Điều khiển buổi đọc"
      className="grid w-full grid-cols-4 gap-2 rounded-card bg-white p-2 sm:mx-auto sm:max-w-[976px] sm:gap-4"
    >
      <Button
        aria-label="Tạm dừng buổi đọc"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-4 sm:text-button"
        disabled={disabled}
        onClick={onPause}
        variant="quiet"
      >
        <Pause aria-hidden="true" className="size-6" />
        <span>Tạm dừng</span>
      </Button>
      <Button
        aria-label="Nghe từ đang đọc"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-4 sm:text-button"
        disabled={disabled}
        onClick={onHelp}
        variant="secondary"
      >
        <Volume2 aria-hidden="true" className="size-6" />
        <span>Nghe từ</span>
      </Button>
      <Button
        aria-label="Chọn trang hoặc nhận trợ giúp"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-4 sm:text-button"
        disabled={disabled}
        onClick={onManualPage}
        variant="quiet"
      >
        <span className="relative">
          <CircleHelp aria-hidden="true" className="size-6 sm:hidden" />
          <List aria-hidden="true" className="hidden size-6 sm:block" />
        </span>
        <span className="sm:hidden">Giúp</span>
        <span className="hidden sm:inline">Chọn trang</span>
      </Button>
      <Button
        aria-label="Kết thúc buổi đọc"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-4 sm:text-button"
        disabled={disabled}
        onClick={onFinish}
      >
        <Check aria-hidden="true" className="size-6" />
        <span>Xong</span>
      </Button>
    </nav>
  );
}
