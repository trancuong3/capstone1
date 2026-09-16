import { VideoOff } from "lucide-react";
import type { ReactNode } from "react";

interface CameraPreviewProps {
  children: ReactNode;
}

export function CameraPreview({ children }: CameraPreviewProps) {
  return (
    <section
      aria-label="Bản xem trước camera mô phỏng"
      className="relative flex min-h-0 w-full items-center justify-center rounded-card bg-desk p-4 sm:flex-1 sm:p-8"
    >
      <div className="absolute right-3 top-3 z-20 inline-flex items-center gap-2 rounded-control bg-white/90 px-3 py-2 text-[13px] font-bold text-muted sm:right-5 sm:top-5">
        <VideoOff aria-hidden="true" className="size-4" />
        <span className="hidden sm:inline">Mô phỏng · không ghi hình</span>
        <span className="sr-only sm:hidden">Mô phỏng, không ghi hình</span>
      </div>
      {children}
    </section>
  );
}
