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
  showTitle?: boolean;
  size?: "default" | "medium" | "small";
}

export function BookCover({
  book,
  className,
  hero = false,
  titleAsHeading = false,
  showTitle = true,
  size = "default",
}: BookCoverProps) {
  const artwork = resolveArtwork(book);
  const compact = size !== "default";
  const coverDimensions =
    size === "small"
      ? { width: 56, height: 80 }
      : size === "medium"
        ? { width: 112, height: 144 }
        : undefined;

  if (hero) {
    return (
      <div
        className={cn(
          "relative h-[205px] w-full overflow-hidden rounded-control",
          "bg-cream",
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
        "flex w-full flex-col items-center justify-center rounded-card bg-cream",
        compact ? "shrink-0 gap-1 p-2" : "h-[260px] gap-4 p-6",
        className,
      )}
      style={coverDimensions}
    >
      <div
        className={cn(
          "relative h-[144px] w-full max-w-[192px]",
          compact && "min-h-0 flex-1",
        )}
      >
        <Image
          alt=""
          className="object-contain"
          fill
          sizes={
            size === "small" ? "56px" : size === "medium" ? "112px" : "192px"
          }
          src={artworkByVariant[artwork]}
        />
      </div>
      {!showTitle ? null : titleAsHeading ? (
        <h2
          className={cn(
            "viread-learning-content line-clamp-2 text-center text-2xl font-extrabold leading-snug text-ink",
            compact && "text-xs leading-tight",
          )}
          dir="ltr"
          lang="vi"
        >
          {book.title}
        </h2>
      ) : (
        <p
          className={cn(
            "viread-learning-content line-clamp-2 text-center text-2xl font-extrabold leading-snug text-ink",
            compact && "text-xs leading-tight",
          )}
          dir="ltr"
          lang="vi"
        >
          {book.title}
        </p>
      )}
    </div>
  );
}
