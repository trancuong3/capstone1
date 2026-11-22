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
    <article className="group flex h-full w-full flex-col items-start gap-4 rounded-card border border-border bg-white p-4 transition-colors hover:border-primary/40 sm:p-6">
      <BookCover book={book} />
      <h2 className="text-2xl font-extrabold leading-snug text-ink">
        {book.title}
      </h2>
      <p className="w-full truncate text-label font-semibold text-muted">
        {book.author ?? "Tác giả đang cập nhật"} · {formatGradeRange(book)}
      </p>
      <ButtonLink
        aria-label={`Đọc sách ${book.title}`}
        className="order-last mt-auto min-h-16 w-full"
        href={`/books/${encodeURIComponent(book.id)}`}
      >
        Xem sách
      </ButtonLink>
      {onToggleCollection ? (
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap">
          {(["FAVORITE", "WANT_TO_READ"] as const).map((type) => {
            const saved = savedTypes.includes(type);
            const label = type === "FAVORITE" ? "Yêu thích" : "Muốn đọc";
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
                {saved ? "Đã lưu" : label}
              </button>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
