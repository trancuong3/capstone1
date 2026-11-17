import { ArrowRight, Heart, ListChecks } from "lucide-react";

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
    <article className="flex h-full w-full flex-col items-start gap-3 rounded-card border border-border bg-white p-4">
      <BookCover book={book} titleAsHeading />
      <p className="w-full truncate text-label font-semibold text-muted">
        {book.author ?? "Tác giả đang cập nhật"}
      </p>
      <p className="w-full text-label font-semibold text-primary">
        {formatGradeRange(book)}
      </p>
      <ButtonLink
        aria-label={`Đọc sách ${book.title}`}
        className="mt-auto w-full"
        href={`/books/${encodeURIComponent(book.id)}`}
      >
        Đọc sách
        <ArrowRight aria-hidden="true" className="size-5" />
      </ButtonLink>
      {onToggleCollection ? (
        <div className="flex w-full flex-wrap gap-2">
          {(["FAVORITE", "WANT_TO_READ"] as const).map((type) => {
            const saved = savedTypes.includes(type);
            const label = type === "FAVORITE" ? "Yêu thích" : "Muốn đọc";
            const ActionIcon = type === "FAVORITE" ? Heart : ListChecks;
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
                  "flex min-h-10 flex-1 items-center justify-center gap-1 rounded-control px-2 text-label font-semibold " +
                  (saved
                    ? "bg-sky text-primary"
                    : "border border-border text-ink hover:bg-canvas")
                }
                disabled={collectionBusy}
                key={type}
                onClick={() => onToggleCollection(type)}
                type="button"
              >
                <ActionIcon aria-hidden="true" className="size-4" />
                {saved ? "Đã lưu" : label}
              </button>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
