import Image from "next/image";

import { cn } from "@/lib/utils/cn";
import type { BookPagePreviewDTO } from "@/types/book";

interface BookPageThumbnailProps {
  isSelected: boolean;
  onSelect: (page: BookPagePreviewDTO) => void;
  page: BookPagePreviewDTO;
}

export function BookPageThumbnail({
  isSelected,
  onSelect,
  page,
}: BookPageThumbnailProps) {
  return (
    <button
      aria-label={`Chọn trang ${page.page_number}`}
      aria-pressed={isSelected}
      className={cn(
        "flex h-[200px] w-48 shrink-0 flex-col gap-3 rounded-card border bg-white p-4 text-left transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
        isSelected
          ? "border-primary ring-2 ring-primary/20"
          : "border-border hover:border-primary",
      )}
      onClick={() => onSelect(page)}
      type="button"
    >
      <span className="relative h-[107px] w-40 overflow-hidden rounded-lg bg-cream shadow-sm">
        <span className="absolute left-2 top-2 z-10 text-[5px] font-bold text-ink">
          Một buổi sáng yên bình
        </span>
        <Image
          alt=""
          className="object-contain px-6 py-4"
          fill
          sizes="160px"
          src={page.preview_url}
        />
        <span className="absolute bottom-2 left-2 right-2 z-10 text-[5px] font-bold text-ink">
          Trang sách đã được xác minh
        </span>
      </span>
      <span className="text-body font-bold text-ink">
        Trang {page.page_number}
      </span>
    </button>
  );
}
