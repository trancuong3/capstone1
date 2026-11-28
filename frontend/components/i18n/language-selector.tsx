"use client";

import { Check, ChevronDown, Globe, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { useI18n } from "@/hooks/use-i18n";
import type { LocaleMetadata, SupportedLocale } from "@/lib/i18n/locales";
import { cn } from "@/lib/utils/cn";

export type LanguageSelectorVariant =
  "header" | "menu" | "settings" | "compact";

export interface LanguageSelectorProps {
  readonly variant?: LanguageSelectorVariant;
  readonly className?: string;
  readonly align?: "start" | "end";
  readonly publishedOnly?: boolean;
  readonly locales?: readonly LocaleMetadata[];
  readonly presentation?: "auto" | "popover" | "sheet";
  readonly onLocaleChange?: (locale: SupportedLocale) => void;
}

const MOBILE_MEDIA_QUERY = "(max-width: 639px)";

function detectMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  }
  return window.innerWidth > 0 && window.innerWidth < 640;
}

export function normalizeSearchToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

const triggerVariantClasses: Record<LanguageSelectorVariant, string> = {
  header:
    "min-h-11 max-w-52 rounded-control border border-border bg-white px-3 py-2 text-sm font-semibold text-ink hover:bg-sky",
  compact:
    "min-h-11 max-w-44 rounded-full border border-border bg-white px-2.5 py-2 text-xs font-semibold text-ink hover:bg-sky",
  menu: "min-h-11 w-full justify-between rounded-control bg-white px-3 py-2 text-sm font-semibold text-ink hover:bg-sky",
  settings:
    "min-h-12 w-full justify-between rounded-control border border-border bg-white px-4 py-2.5 text-body font-semibold text-ink hover:bg-sky",
};

export function LanguageSelector({
  variant = "header",
  className,
  align = "end",
  publishedOnly = true,
  locales,
  presentation = "auto",
  onLocaleChange,
}: LanguageSelectorProps) {
  const { locale, metadata, availableLocales, isLoadingLocale, setLocale, t } =
    useI18n();

  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pushedHistoryRef = useRef(false);

  const panelId = useId();
  const titleId = useId();
  const searchId = useId();

  useEffect(() => {
    function updateViewport() {
      setIsMobileViewport(detectMobileViewport());
    }

    updateViewport();

    if (typeof window.matchMedia === "function") {
      const media = window.matchMedia(MOBILE_MEDIA_QUERY);
      const handleChange = (event: MediaQueryListEvent) => {
        setIsMobileViewport(event.matches);
      };
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", handleChange);
        return () => media.removeEventListener("change", handleChange);
      }
    }

    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  const useBottomSheet =
    presentation === "sheet" || (presentation === "auto" && isMobileViewport);

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

  const closeSelector = useCallback(
    (options?: {
      readonly restoreFocus?: boolean;
      readonly fromPopstate?: boolean;
    }) => {
      setIsOpen(false);
      setSearchQuery("");

      if (pushedHistoryRef.current) {
        pushedHistoryRef.current = false;
        if (!options?.fromPopstate && typeof window !== "undefined") {
          try {
            const state = window.history.state as {
              readonly vireadLanguageSheet?: boolean;
            } | null;
            if (state?.vireadLanguageSheet) {
              window.history.back();
            }
          } catch {
            // Ignore history restrictions in sandboxed WebViews.
          }
        }
      }

      if (options?.restoreFocus) {
        triggerRef.current?.focus();
      }
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) return;

    const focusTimer = window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0);

    function handlePointerDown(event: PointerEvent) {
      if (
        !useBottomSheet &&
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        closeSelector({ restoreFocus: false });
      }
    }

    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSelector({ restoreFocus: true });
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [closeSelector, isOpen, useBottomSheet]);

  useEffect(() => {
    if (!isOpen || !useBottomSheet || typeof window === "undefined") {
      return;
    }

    try {
      window.history.pushState({ vireadLanguageSheet: true }, "");
      pushedHistoryRef.current = true;
    } catch {
      pushedHistoryRef.current = false;
    }

    function handlePopState() {
      if (pushedHistoryRef.current) {
        pushedHistoryRef.current = false;
      }
      setIsOpen(false);
      setSearchQuery("");
      triggerRef.current?.focus();
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isOpen, useBottomSheet]);

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
    setAnnouncement(
      t("common.languageSelector.switchedNotice", {
        language: item.nativeName,
      }),
    );
    onLocaleChange?.(resolved);
    closeSelector({ restoreFocus: true });
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOptionAt(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const options = getOptionButtons();
      focusOptionAt(options.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSelector({ restoreFocus: true });
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
      case "Escape":
        event.preventDefault();
        closeSelector({ restoreFocus: true });
        break;
    }
  }

  function renderOptionRow(item: LocaleMetadata) {
    const isSelected = item.code === locale;
    return (
      <button
        aria-selected={isSelected}
        className={cn(
          "flex min-h-11 w-full items-center justify-between gap-3 rounded-control px-3 py-2 text-start transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
          isSelected
            ? "bg-sky text-primary-hover"
            : "bg-white text-ink hover:bg-canvas",
        )}
        data-locale-code={item.code}
        data-locale-published={String(item.published)}
        key={item.code}
        lang={item.bcp47}
        onClick={() => void handleSelectLocale(item)}
        role="option"
        type="button"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-ink">
            {item.nativeName}
          </span>
          {item.englishName !== item.nativeName ? (
            <span className="block truncate text-xs text-muted">
              {item.englishName} · {item.code}
            </span>
          ) : (
            <span className="block truncate text-xs text-muted">
              {item.code}
            </span>
          )}
        </span>
        {isSelected ? (
          <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
        ) : null}
      </button>
    );
  }

  const selectorBody = (
    <>
      <div className="sticky top-0 z-10 border-b border-border bg-white px-3 py-2.5">
        <div className="relative flex items-center">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 size-4 text-muted"
          />
          <input
            aria-label={t("common.languageSelector.searchLabel")}
            className="min-h-11 w-full rounded-control border border-border bg-canvas pe-11 ps-9 text-sm text-ink placeholder:text-muted focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
              className="absolute end-0 flex size-11 items-center justify-center rounded-control text-muted hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
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

      <div
        aria-label={t("common.languageSelector.dialogTitle")}
        className="max-h-72 overflow-y-auto overscroll-contain p-2 sm:max-h-80"
        onKeyDown={handleListKeyDown}
        ref={listRef}
        role="listbox"
      >
        {normalizedQuery ? (
          filteredLocales.length > 0 ? (
            <div
              role="group"
              aria-label={t("common.languageSelector.searchResultsHeading")}
            >
              <p className="px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {t("common.languageSelector.searchResultsHeading")}
              </p>
              <div className="grid gap-1">
                {filteredLocales.map(renderOptionRow)}
              </div>
            </div>
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted">
              {t("common.languageSelector.emptySearch", { query: searchQuery })}
            </p>
          )
        ) : (
          <div className="grid gap-3">
            {popularLocales.length > 0 ? (
              <div
                aria-label={t("common.languageSelector.popularHeading")}
                role="group"
              >
                <p className="px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-muted">
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
                <p className="px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-muted">
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
    </>
  );

  return (
    <div
      className={cn(
        "relative inline-block",
        (variant === "menu" || variant === "settings") && "w-full",
        className,
      )}
      data-variant={variant}
      ref={rootRef}
    >
      <span
        aria-live="polite"
        className="sr-only"
        role={announcement ? "status" : undefined}
      >
        {announcement}
      </span>

      <button
        aria-controls={isOpen ? panelId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={t("common.languageSelector.buttonAriaLabel", {
          language: metadata.nativeName,
        })}
        className={cn(
          "inline-flex items-center gap-2 transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
          triggerVariantClasses[variant],
        )}
        disabled={isLoadingLocale}
        onClick={() => {
          if (isOpen) {
            closeSelector({ restoreFocus: true });
          } else {
            setIsOpen(true);
          }
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Globe aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <span className="truncate">{metadata.nativeName}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && !useBottomSheet ? (
        <div
          aria-labelledby={titleId}
          className={cn(
            "absolute top-full z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-card border border-border bg-white shadow-xl",
            align === "start" ? "start-0" : "end-0",
          )}
          data-language-popover="true"
          id={panelId}
          role="dialog"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-extrabold text-ink" id={titleId}>
              {t("common.languageSelector.dialogTitle")}
            </h2>
            <span className="text-xs font-medium text-muted">
              {metadata.nativeName}
            </span>
          </div>
          {selectorBody}
        </div>
      ) : null}

      {isOpen && useBottomSheet ? (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end"
          data-language-sheet="true"
          role="presentation"
        >
          <button
            aria-label={t("common.languageSelector.closeButton")}
            className="fixed inset-0 bg-ink/40 backdrop-blur-[1px]"
            onClick={() => closeSelector({ restoreFocus: true })}
            tabIndex={-1}
            type="button"
          />
          <section
            aria-labelledby={titleId}
            aria-modal="true"
            className="relative z-10 flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-border bg-white pt-3 shadow-2xl pb-[env(safe-area-inset-bottom)]"
            id={panelId}
            role="dialog"
          >
            <div
              aria-hidden="true"
              className="mx-auto mb-2 h-1.5 w-10 shrink-0 rounded-full bg-border"
            />
            <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2">
              <div>
                <h2 className="text-lg font-extrabold text-ink" id={titleId}>
                  {t("common.languageSelector.dialogTitle")}
                </h2>
                <p className="text-xs font-medium text-muted">
                  {t("common.languageSelector.currentBadge")}:{" "}
                  <span className="font-bold text-primary">
                    {metadata.nativeName}
                  </span>
                </p>
              </div>
              <button
                aria-label={t("common.languageSelector.closeButton")}
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                onClick={() => closeSelector({ restoreFocus: true })}
                type="button"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
              {selectorBody}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
