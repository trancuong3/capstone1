import Image from "next/image";

import { WordHighlightOverlay } from "@/components/reading/word-highlight-overlay";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO } from "@/types/reading";

interface BookPageViewerProps {
  currentWordId: string | null;
  isTransitioning?: boolean;
  page: ReadingPageDTO;
}

function secondaryCopy(pageNumber: number): string {
  if (pageNumber === 5) {
    return "Nắng sớm nhẹ nhàng ghé qua. Chú mèo nhỏ thức dậy thật vui.";
  }

  if (pageNumber === 6) {
    return "Chú khẽ vươn vai, chào ngày mới.";
  }

  return "Nắng sớm nhẹ nhàng ghé qua. Chú khẽ vươn vai, chào ngày mới.";
}

export function BookPageViewer({
  currentWordId,
  isTransitioning = false,
  page,
}: BookPageViewerProps) {
  return (
    <article
      aria-busy={isTransitioning || undefined}
      aria-label={`Trang sách ${page.page_number}`}
      className={cn(
        "relative min-h-[552px] w-full overflow-hidden rounded-[8px] bg-cream p-4 shadow-[0_8px_24px_rgba(33,61,66,0.06)] sm:aspect-[3/2] sm:min-h-0 sm:max-w-[1008px] sm:p-10",
        isTransitioning && "opacity-60",
      )}
      data-page-id={page.page_id}
      data-page-revision-id={page.page_revision_id}
    >
      <WordHighlightOverlay currentWordId={currentWordId} page={page} />

      <div className="relative z-10 flex h-full flex-col">
        <h1 className="max-w-[230px] text-[26px] font-extrabold leading-[1.4] text-ink sm:max-w-none sm:text-heading">
          Một buổi sáng yên bình
        </h1>

        <div className="relative mx-auto mt-3 h-[168px] w-full max-w-[294px] overflow-hidden rounded-control bg-book-orange sm:mt-4 sm:h-[34%] sm:max-w-[560px]">
          <Image
            alt="Chú mèo nhỏ nằm cạnh cửa sổ"
            className="h-full w-full object-cover"
            fill
            priority
            sizes="(max-width: 767px) 294px, 560px"
            src="/images/figma/book-cat.svg"
          />
        </div>

        <p className="mt-4 text-[26px] font-extrabold leading-[1.8] text-ink sm:mt-5 sm:text-[32px] sm:leading-[1.4]">
          {page.words.map((word) => (
            <span
              className={cn(
                "mr-2 inline-block rounded-[12px] px-1",
                word.word_id === currentWordId && "bg-highlight",
              )}
              data-bbox={word.bbox.join(",")}
              data-page-revision-id={page.page_revision_id}
              data-word-id={word.word_id}
              key={word.word_id}
            >
              {word.text}
            </span>
          ))}
        </p>
        <p className="mt-1 text-body font-bold text-ink sm:text-[26px]">
          {secondaryCopy(page.page_number)}
        </p>
        <p className="mt-auto text-label text-muted">{page.page_number}</p>
      </div>

      <span className="sr-only" aria-live="polite">
        Từ hiện tại:{" "}
        {page.words.find((word) => word.word_id === currentWordId)?.text}
      </span>
    </article>
  );
}
