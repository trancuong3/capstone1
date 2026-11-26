import { Bookmark, Heart } from "lucide-react";

import { BookCover } from "@/components/books/book-cover";
import { ButtonLink } from "@/components/common/button";
import type { BookListItemDTO } from "@/types/book";
import type { BookCollectionType } from "@/types/reading-management";

export function formatGradeRange(book: BookListItemDTO): string {
  return book.min_grade === book.max_grade
    ? `Lớp ${book.min_grade}`
    : `Lớp ${book.min_grade}–${book.max_grade}`;
}

interface BookCardProps {
  book: BookListItemDTO;
  savedTypes?: readonly BookCollectionType[];
  onToggleCollection?: (type: BookCollectionType) => void;
  collectionBusy?: boolean;
}

export function BookCard({
  book,
  savedTypes = [],
  onToggleCollection,
  collectionBusy = false,
}: BookCardProps) {
  return (
    <article className="catalog-volume group flex h-full min-w-0 flex-col items-start gap-2 rounded-card border border-border/70 bg-white p-2.5 shadow-xs sm:gap-3 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none">
      <BookCover
        book={book}
        hero
        className="catalog-jacket h-36! sm:h-[205px]!"
      />
      {book.visibility_scope === "PARENT_PRIVATE" ? (
        <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-800 sm:px-2.5 sm:text-xs">
          Sách riêng của gia đình
        </span>
      ) : null}
      <h2 className="book-title line-clamp-2 w-full text-sm leading-snug text-ink sm:line-clamp-none sm:text-2xl">
        {book.title}
      </h2>
      <p className="line-clamp-1 w-full text-xs text-muted sm:line-clamp-none sm:text-sm">
        {book.author ?? "Tác giả đang cập nhật"} · {formatGradeRange(book)}
      </p>
      <ButtonLink
        aria-label={`Đọc sách ${book.title}`}
        className="order-last mt-auto min-h-11 px-2.5 text-xs sm:min-h-12 sm:px-5 sm:text-label"
        href={`/books/${encodeURIComponent(book.id)}`}
      >
        Xem sách
      </ButtonLink>
      {onToggleCollection ? (
        <div className="grid w-full grid-cols-2 gap-1.5 sm:flex sm:flex-row sm:flex-wrap sm:gap-2">
          {(["FAVORITE", "WANT_TO_READ"] as const).map((type) => {
            const saved = savedTypes.includes(type);
            const label = type === "FAVORITE" ? "Yêu thích" : "Muốn đọc";
            const Icon = type === "FAVORITE" ? Heart : Bookmark;
            return (
              <button
                aria-label={
                  (saved ? "Bỏ " : "Thêm ") +
                  book.title +
                  (type === "FAVORITE"
                    ? " " + label.toLowerCase()
                    : " vào danh sách muốn đọc")
                }
                aria-pressed={saved}
                className={
                  "flex min-h-11 min-w-11 flex-1 items-center justify-center gap-1 rounded-control px-2 text-label font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary " +
                  (saved
                    ? "bg-sky text-primary"
                    : "border border-border bg-white text-ink hover:bg-canvas")
                }
                disabled={collectionBusy}
                key={type}
                onClick={() => onToggleCollection(type)}
                type="button"
              >
                <Icon
                  aria-hidden="true"
                  className={
                    "size-4 shrink-0 sm:hidden" +
                    (saved ? " fill-current" : "")
                  }
                />
                <span className="sr-only sm:not-sr-only">
                  {saved ? "✓ " : ""}
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
