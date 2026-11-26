"use client";

import { BookCover } from "@/components/books/book-cover";
import { ButtonLink } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import { translateMessage } from "@/lib/i18n/formatter";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import { viMessages } from "@/messages/vi";
import type { BookListItemDTO } from "@/types/book";
import type { BookCollectionType } from "@/types/reading-management";

export function formatGradeRange(
  book: BookListItemDTO,
  t?: (key: string, params?: Record<string, string | number>) => string,
): string {
  const translate =
    t ??
    ((key: string, params?: Record<string, string | number>) =>
      translateMessage(
        viMessages,
        viMessages,
        DEFAULT_LOCALE,
        `books.${key}`,
        params,
      ));
  return book.min_grade === book.max_grade
    ? translate("card.gradeSingle", { grade: book.min_grade })
    : translate("card.gradeRange", {
        min: book.min_grade,
        max: book.max_grade,
      });
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
  const t = useTranslations("books");

  return (
    <article className="catalog-volume group flex h-full min-w-0 flex-col items-start gap-3">
      <BookCover book={book} hero className="catalog-jacket" />
      {book.visibility_scope === "PARENT_PRIVATE" ? (
        <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
          {t("card.privateFamilyBadge")}
        </span>
      ) : null}
      <h2
        className="book-title viread-learning-content text-2xl text-ink"
        dir="ltr"
        lang="vi"
      >
        {book.title}
      </h2>
      <p className="w-full text-sm text-muted">
        {book.author ? (
          <span className="viread-learning-content" dir="ltr" lang="vi">
            {book.author}
          </span>
        ) : (
          t("card.authorPending")
        )}{" "}
        · {formatGradeRange(book, t)}
      </p>
      <ButtonLink
        aria-label={t("card.readBookAria", { title: book.title })}
        className="order-last mt-auto min-h-12"
        href={`/books/${encodeURIComponent(book.id)}`}
      >
        {t("card.viewBook")}
      </ButtonLink>
      {onToggleCollection ? (
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap">
          {(["FAVORITE", "WANT_TO_READ"] as const).map((type) => {
            const saved = savedTypes.includes(type);
            const label =
              type === "FAVORITE" ? t("card.favorite") : t("card.wantToRead");
            const ariaLabel =
              type === "FAVORITE"
                ? saved
                  ? t("card.removeFavoriteAria", { title: book.title })
                  : t("card.addFavoriteAria", { title: book.title })
                : saved
                  ? t("card.removeReadingListAria", { title: book.title })
                  : t("card.addReadingListAria", { title: book.title });
            return (
              <button
                aria-label={ariaLabel}
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
                {saved ? "✓ " : ""}
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
