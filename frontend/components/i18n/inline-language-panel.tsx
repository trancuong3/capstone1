"use client";

import { ArrowLeft, Check, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { normalizeSearchToken } from "@/components/i18n/language-selector";
import { useI18n } from "@/hooks/use-i18n";
import type { LocaleMetadata, SupportedLocale } from "@/lib/i18n/locales";
import { cn } from "@/lib/utils/cn";

export interface InlineLanguagePanelProps {
  readonly id: string;
  readonly titleId: string;
  readonly openedByKeyboard?: boolean;
  readonly publishedOnly?: boolean;
  readonly locales?: readonly LocaleMetadata[];
  readonly onBack: (options?: { readonly restoreFocus?: boolean }) => void;
  readonly onLocaleChange?: (locale: SupportedLocale) => void;
  readonly onAnnouncement?: (message: string) => void;
}

export function InlineLanguagePanel({
  id,
  titleId,
  openedByKeyboard = false,
  publishedOnly = true,
  locales,
  onBack,
  onLocaleChange,
  onAnnouncement,
}: InlineLanguagePanelProps) {
  const { locale, metadata, availableLocales, isLoadingLocale, setLocale, t } =
    useI18n();

  const [searchQuery, setSearchQuery] = useState("");
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const searchId = useId();

  useEffect(() => {
    const isCoarsePointer =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;

    if (isCoarsePointer && !openedByKeyboard) {
      backButtonRef.current?.focus();
    } else {
      searchInputRef.current?.focus();
    }
  }, [openedByKeyboard]);

  const selectableLocales = useMemo(() => {
    const base = locales ?? availableLocales;
    return publishedOnly ? base.filter((item) => item.published) : base;
  }, [availableLocales, locales, publishedOnly]);

  const normalizedQuery = useMemo(
    () => normalizeSearchToken(searchQuery),
    [searchQuery],
  );

  const filteredLocales = useMemo(() => {
    if (!normalizedQuery) return selectableLocales;
    return selectableLocales.filter((item) => {
      const nativeToken = normalizeSearchToken(item.nativeName);
      const englishToken = normalizeSearchToken(item.englishName);
      const codeToken = normalizeSearchToken(item.code);
      return (
        nativeToken.includes(normalizedQuery) ||
        englishToken.includes(normalizedQuery) ||
        codeToken.includes(normalizedQuery)
      );
    });
  }, [normalizedQuery, selectableLocales]);

  const popularLocales = useMemo(
    () =>
      normalizedQuery ? [] : selectableLocales.filter((item) => item.popular),
    [normalizedQuery, selectableLocales],
  );

  const otherLocales = useMemo(
    () =>
      normalizedQuery ? [] : selectableLocales.filter((item) => !item.popular),
    [normalizedQuery, selectableLocales],
  );

  const getOptionButtons = useCallback((): HTMLButtonElement[] => {
    return Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
  }, []);

  const focusOptionAt = useCallback(
    (index: number) => {
      const options = getOptionButtons();
      if (options.length === 0) return;
      const clamped = Math.max(0, Math.min(index, options.length - 1));
      options[clamped]?.focus();
    },
    [getOptionButtons],
  );

  async function handleSelectLocale(item: LocaleMetadata) {
    const resolved = await setLocale(item.code);
    onAnnouncement?.(
      t("common.languageSelector.switchedNotice", {
        language: item.nativeName,
      }),
    );
    onLocaleChange?.(resolved);
    onBack({ restoreFocus: true });
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOptionAt(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const options = getOptionButtons();
      focusOptionAt(options.length - 1);
    }
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const options = getOptionButtons();
    if (options.length === 0) return;
    const currentIndex = options.indexOf(
      document.activeElement as HTMLButtonElement,
    );

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusOptionAt(
          currentIndex < 0 ? 0 : (currentIndex + 1) % options.length,
        );
        break;
      case "ArrowUp":
        event.preventDefault();
        if (currentIndex <= 0) {
          searchInputRef.current?.focus();
        } else {
          focusOptionAt(currentIndex - 1);
        }
        break;
      case "Home":
        event.preventDefault();
        focusOptionAt(0);
        break;
      case "End":
        event.preventDefault();
        focusOptionAt(options.length - 1);
        break;
    }
  }

  function renderOptionRow(item: LocaleMetadata) {
    const isSelected = item.code === locale;
    return (
      <button
        aria-selected={isSelected}
        className={cn(
          "flex min-h-11 w-full items-center justify-between gap-2.5 rounded-xl border px-3 py-2 text-start transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:opacity-60",
          isSelected
            ? "border-primary/35 bg-sky/75 text-primary-hover shadow-2xs"
            : "border-transparent bg-white text-ink hover:bg-canvas",
        )}
        data-locale-code={item.code}
        data-locale-published={String(item.published)}
        disabled={isLoadingLocale}
        key={item.code}
        lang={item.bcp47}
        onClick={() => void handleSelectLocale(item)}
        role="option"
        type="button"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold leading-snug">
            {item.nativeName}
          </span>
          {item.englishName !== item.nativeName ? (
            <span className="mt-0.5 block truncate text-xs text-muted">
              {item.englishName}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide",
              isSelected
                ? "bg-white/90 text-primary-hover"
                : "bg-surface-subtle text-muted",
            )}
          >
            {item.code}
          </span>
          {isSelected ? (
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-white shadow-2xs"
            >
              <Check className="size-3.5" strokeWidth={2.5} />
            </span>
          ) : null}
        </span>
      </button>
    );
  }

  return (
    <div
      className="avatar-menu-view-forward flex min-h-0 flex-1 flex-col bg-white"
      data-language-inline="true"
      id={id}
    >
      {/* Pinned sub-view header */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border/75 bg-sky/40 px-3 py-2.5">
        <button
          aria-label={t("common.actions.back")}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/85 text-ink shadow-2xs transition-colors hover:bg-white hover:text-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          onClick={() => onBack({ restoreFocus: true })}
          ref={backButtonRef}
          type="button"
        >
          <ArrowLeft aria-hidden="true" className="size-4 viread-rtl-flip" />
        </button>
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-[15px] font-extrabold leading-tight text-ink"
            id={titleId}
          >
            {t("common.languageSelector.dialogTitle")}
          </h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span className="shrink-0">
              {t("common.languageSelector.currentBadge")}:
            </span>
            <span className="truncate rounded-full border border-primary/20 bg-white/90 px-2 py-0.5 text-[11px] font-bold text-primary-hover">
              {metadata.nativeName}
            </span>
          </p>
        </div>
      </div>

      {/* Pinned search bar */}
      <div className="shrink-0 border-b border-border/65 bg-white px-3 py-2.5">
        <div className="relative flex items-center">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 size-4 text-muted"
          />
          <input
            aria-label={t("common.languageSelector.searchLabel")}
            className="avatar-menu-search min-h-11 w-full rounded-xl border border-border/90 bg-canvas/75 pe-10 ps-9 text-sm text-ink placeholder:text-muted transition-colors focus:border-primary focus:bg-white focus:ring-2 focus:ring-primary/25"
            id={searchId}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t("common.languageSelector.searchPlaceholder")}
            ref={searchInputRef}
            type="search"
            value={searchQuery}
          />
          {searchQuery ? (
            <button
              aria-label={t("common.languageSelector.clearSearch")}
              className="absolute end-0 flex size-11 items-center justify-center rounded-xl text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary"
              onClick={() => {
                setSearchQuery("");
                searchInputRef.current?.focus();
              }}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Single dedicated scrollable language list */}
      <div
        aria-label={t("common.languageSelector.dialogTitle")}
        className="avatar-menu-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
        onKeyDown={handleListKeyDown}
        ref={listRef}
        role="listbox"
      >
        {normalizedQuery ? (
          filteredLocales.length > 0 ? (
            <div
              aria-label={t("common.languageSelector.searchResultsHeading")}
              role="group"
            >
              <p className="px-2.5 pb-1 pt-1 text-xs font-bold text-muted">
                {t("common.languageSelector.searchResultsHeading")}
              </p>
              <div className="grid gap-1">
                {filteredLocales.map(renderOptionRow)}
              </div>
            </div>
          ) : (
            <p className="px-3 py-8 text-center text-sm text-muted">
              {t("common.languageSelector.emptySearch", { query: searchQuery })}
            </p>
          )
        ) : (
          <div className="grid gap-2.5">
            {popularLocales.length > 0 ? (
              <div
                aria-label={t("common.languageSelector.popularHeading")}
                role="group"
              >
                <p className="px-2.5 pb-1 pt-1 text-xs font-bold text-muted">
                  {t("common.languageSelector.popularHeading")}
                </p>
                <div className="grid gap-1">
                  {popularLocales.map(renderOptionRow)}
                </div>
              </div>
            ) : null}

            {otherLocales.length > 0 ? (
              <div
                aria-label={t("common.languageSelector.allHeading")}
                role="group"
              >
                <p className="px-2.5 pb-1 pt-1 text-xs font-bold text-muted">
                  {t("common.languageSelector.allHeading")}
                </p>
                <div className="grid gap-1">
                  {otherLocales.map(renderOptionRow)}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
