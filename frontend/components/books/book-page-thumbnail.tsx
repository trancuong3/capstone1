"use client";

import Image from "next/image";

import { AuthenticatedImage } from "@/components/common/authenticated-image";
import { useTranslations } from "@/hooks/use-i18n";
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
  const t = useTranslations("books");
  const isPrivateMedia = isPrivateApiMediaUrl(page.preview_url);
  return (
    <button
      aria-label={t("detail.thumbnailSelectAria", { page: page.page_number })}
      aria-pressed={isSelected}
      className={cn(
        "flex h-[176px] w-40 shrink-0 flex-col gap-2.5 rounded-card border bg-white p-3 text-start transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:h-[200px] sm:w-48 sm:gap-3 sm:p-4",
        isSelected
          ? "border-primary ring-2 ring-primary/20"
          : "border-border hover:border-primary",
      )}
      onClick={() => onSelect(page)}
      type="button"
    >
      <span className="relative h-[96px] w-full overflow-hidden rounded-lg bg-cream shadow-sm sm:h-[107px] sm:w-40">
        {isPrivateMedia ? (
          <AuthenticatedImage
            alt={t("detail.thumbnailAlt", { page: page.page_number })}
            className="h-full w-full object-contain px-4 py-2"
            src={page.preview_url}
          />
        ) : (
          <Image
            alt={t("detail.thumbnailAlt", { page: page.page_number })}
            className="object-contain px-6 py-4"
            fill
            sizes="160px"
            src={page.preview_url}
            unoptimized
          />
        )}
        <span className="absolute inset-x-1.5 bottom-1.5 z-10 truncate rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-semibold leading-tight text-ink">
          {t("detail.thumbnailVerifiedTooltip")}
        </span>
      </span>
      <span className="text-sm font-semibold text-ink sm:text-body">
        {t("detail.pageNumberOption", { page: page.page_number })}
      </span>
    </button>
  );
}
