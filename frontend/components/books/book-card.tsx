"use client";

import { Bookmark, Heart } from "lucide-react";

import { BookCover } from "@/components/books/book-cover";
import { ButtonLink } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import { translateMessage } from "@/lib/i18n/formatter";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import { cn } from "@/lib/utils/cn";
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
    <article className="catalog-volume group flex h-full min-w-0 flex-row items-stretch gap-3 rounded-card border border-border bg-white p-2.5 sm:flex-col sm:items-start sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0">
      <BookCover
        book={book}
        hero
        className="catalog-jacket h-[104px] w-[76px] shrink-0 sm:h-[208px] sm:w-full"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:w-full sm:gap-3">
        {book.visibility_scope === "PARENT_PRIVATE" ? (
          <span className="inline-flex w-fit items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-800 sm:px-2.5 sm:text-xs">
            {t("card.privateFamilyBadge")}
          </span>
        ) : null}
        <h2
          className="book-title viread-learning-content line-clamp-2 text-base font-extrabold text-ink sm:line-clamp-none sm:text-2xl"
          dir="ltr"
          lang="vi"
        >
          {book.title}
        </h2>
        <p className="w-full truncate text-xs text-muted sm:whitespace-normal sm:text-sm">
          {book.author ? (
            <span className="viread-learning-content" dir="ltr" lang="vi">
              {book.author}
            </span>
          ) : (
            t("card.authorPending")
          )}{" "}
          · {formatGradeRange(book, t)}
        </p>
        <div className="mt-auto flex w-full items-center gap-1.5 pt-1 sm:flex-col sm:items-stretch sm:gap-2 sm:pt-0">
          <ButtonLink
            aria-label={t("card.readBookAria", { title: book.title })}
            className="min-h-10 w-auto flex-1 px-3 py-1.5 text-xs sm:order-last sm:min-h-12 sm:w-full sm:flex-none sm:px-4 sm:py-2 sm:text-button"
            href={`/books/${encodeURIComponent(book.id)}`}
          >
            {t("card.viewBook")}
          </ButtonLink>
          {onToggleCollection ? (
            <div className="flex shrink-0 items-center gap-1.5 sm:w-full sm:flex-row sm:flex-wrap sm:gap-2">
              {(["FAVORITE", "WANT_TO_READ"] as const).map((type) => {
                const saved = savedTypes.includes(type);
                const label =
                  type === "FAVORITE"
                    ? t("card.favorite")
                    : t("card.wantToRead");
                const ariaLabel =
                  type === "FAVORITE"
                    ? saved
                      ? t("card.removeFavoriteAria", { title: book.title })
                      : t("card.addFavoriteAria", { title: book.title })
                    : saved
                      ? t("card.removeReadingListAria", { title: book.title })
                      : t("card.addReadingListAria", { title: book.title });
                const Icon = type === "FAVORITE" ? Heart : Bookmark;
                return (
                  <button
                    aria-label={ariaLabel}
                    aria-pressed={saved}
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center gap-1 rounded-control px-2 text-label font-semibold sm:h-auto sm:min-h-11 sm:w-auto sm:flex-1",
                      saved
                        ? "bg-sky text-primary"
                        : "border border-border text-ink hover:bg-canvas",
                    )}
                    disabled={collectionBusy}
                    key={type}
                    onClick={() => onToggleCollection(type)}
                    type="button"
                  >
                    <Icon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 sm:hidden",
                        saved && "fill-current",
                      )}
                    />
                    <span className="sr-only sm:not-sr-only sm:inline">
                      {saved ? "✓ " : ""}
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
