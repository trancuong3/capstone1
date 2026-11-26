import Image from "next/image";

import { AuthenticatedImage } from "@/components/common/authenticated-image";
import { isPrivateApiMediaUrl } from "@/lib/api/api-client";
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
  const isPrivateMedia = isPrivateApiMediaUrl(page.preview_url);
  return (
    <button
      aria-label={`Chọn trang ${page.page_number}`}
      aria-pressed={isSelected}
      className={cn(
        "flex h-[156px] w-36 shrink-0 flex-col gap-2 rounded-card border bg-white p-2.5 text-left transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary md:h-[200px] md:w-48 md:gap-3 md:p-4",
        isSelected
          ? "border-primary ring-2 ring-primary/20"
          : "border-border hover:border-primary",
      )}
      onClick={() => onSelect(page)}
      type="button"
    >
      <span className="relative h-[92px] w-full overflow-hidden rounded-lg bg-cream shadow-sm md:h-[107px] md:w-40">
        {isPrivateMedia ? (
          <AuthenticatedImage
            alt={`Ảnh xem trước trang ${page.page_number}`}
            className="h-full w-full object-contain px-4 py-2"
            src={page.preview_url}
          />
        ) : (
          <Image
            alt={`Ảnh xem trước trang ${page.page_number}`}
            className="object-contain px-6 py-4"
            fill
            sizes="160px"
            src={page.preview_url}
            unoptimized
          />
        )}
        <span className="absolute bottom-2 left-2 right-2 z-10 text-[5px] font-semibold text-ink">
          Trang sách đã được xác minh
        </span>
      </span>
      <span className="text-sm font-semibold text-ink md:text-body">
        Trang {page.page_number}
      </span>
    </button>
  );
}
