import Image from "next/image";

import { cn } from "@/lib/utils/cn";
import type { BookListItemDTO } from "@/types/book";

type ArtworkVariant = "cat" | "garden" | "travel" | "starfruit";

const artworkByVariant: Record<ArtworkVariant, string> = {
  cat: "/images/figma/book-cat.svg",
  garden: "/images/figma/book-garden.svg",
  travel: "/images/figma/book-travel.svg",
  starfruit: "/images/figma/book-starfruit.svg",
};

const toneByVariant: Record<ArtworkVariant, string> = {
  cat: "bg-book-orange",
  garden: "bg-success-surface",
  travel: "bg-sky",
  starfruit: "bg-purple",
};

function resolveArtwork(book: BookListItemDTO): ArtworkVariant {
  const title = book.title.normalize("NFC").toLocaleLowerCase("vi");

  if (title.includes("vườn")) {
    return "garden";
  }

  if (title.includes("chuyến")) {
    return "travel";
  }

  if (title.includes("khế")) {
    return "starfruit";
  }

  return "cat";
}

interface BookCoverProps {
  book: BookListItemDTO;
  className?: string;
  hero?: boolean;
  titleAsHeading?: boolean;
}

export function BookCover({
  book,
  className,
  hero = false,
  titleAsHeading = false,
}: BookCoverProps) {
  const artwork = resolveArtwork(book);

  if (hero) {
    return (
      <div
        className={cn(
          "relative h-[205px] w-full overflow-hidden rounded-control",
          toneByVariant[artwork],
          className,
        )}
      >
        <Image
          alt=""
          className="object-contain"
          fill
          priority
          sizes="(max-width: 767px) 358px, 269px"
          src={artworkByVariant[artwork]}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex h-60 w-full max-w-56 flex-col gap-2 rounded-control p-4",
        toneByVariant[artwork],
        className,
      )}
    >
      {titleAsHeading ? (
        <h2 className="line-clamp-2 text-[26px] font-bold leading-[1.4] text-ink">
          {book.title}
        </h2>
      ) : (
        <p className="line-clamp-2 text-[26px] font-bold leading-[1.4] text-ink">
          {book.title}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <Image
          alt=""
          className="object-contain"
          fill
          sizes="230px"
          src={artworkByVariant[artwork]}
        />
      </div>
      <p className="text-[14px] leading-[1.4] text-muted">MỘT CÂU CHUYỆN NHỎ</p>
    </div>
  );
}
