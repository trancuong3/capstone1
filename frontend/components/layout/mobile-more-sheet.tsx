"use client";

import { ChevronRight, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  type RefObject,
} from "react";

import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

export interface MobileMoreSheetItem {
  readonly href: string;
  readonly label: string;
  readonly labelKey?: string;
  readonly description?: string;
  readonly descriptionKey?: string;
  readonly groupKey?: string;
  readonly icon: LucideIcon;
  readonly isActive?: (pathname: string) => boolean;
}

interface MobileMoreSheetProps {
  readonly id?: string;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly pathname: string;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly title?: string;
  readonly items: readonly MobileMoreSheetItem[];
}

function defaultRouteActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileMoreSheet({
  id = "mobile-more-sheet",
  isOpen,
  onClose,
  pathname,
  returnFocusRef,
  title,
  items,
}: MobileMoreSheetProps) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const resolvedTitle = title ?? t("navigation.parent.moreTitle");

  const handleDismiss = useCallback(() => {
    onClose();
    returnFocusRef?.current?.focus();
  }, [onClose, returnFocusRef]);

  useEffect(() => {
    if (!isOpen) return;
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        handleDismiss();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, handleDismiss]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end xl:hidden"
      role="presentation"
    >
      <button
        aria-label={t("accessibility.closeMoreSheet")}
        className="fixed inset-0 bg-ink/40 backdrop-blur-[1px]"
        onClick={handleDismiss}
        tabIndex={-1}
        type="button"
      />
      <section
        aria-labelledby={`${id}-title`}
        aria-modal="true"
        className="relative z-10 max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 shadow-2xl"
        id={id}
        role="dialog"
      >
        <div
          aria-hidden="true"
          className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-border"
        />
        <div className="mb-3 flex items-center justify-between gap-2 px-1">
          <h2 className="text-lg font-extrabold text-ink" id={`${id}-title`}>
            {resolvedTitle}
          </h2>
          <button
            aria-label={t("accessibility.closeSheet")}
            className="flex size-12 items-center justify-center rounded-full text-muted transition-colors hover:bg-canvas hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onClick={handleDismiss}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <nav aria-label={resolvedTitle} className="grid gap-1.5">
          {items.map((item, index) => {
            const {
              href,
              label,
              labelKey,
              description,
              descriptionKey,
              groupKey,
              icon: Icon,
              isActive,
            } = item;
            const previousGroupKey =
              index > 0 ? items[index - 1]?.groupKey : undefined;
            const showGroupHeading =
              Boolean(groupKey) && groupKey !== previousGroupKey;
            const showGroupDivider =
              index > 0 && groupKey !== previousGroupKey;
            const active = isActive
              ? isActive(pathname)
              : defaultRouteActive(pathname, href);
            const resolvedLabel = labelKey ? t(labelKey) : label;
            const resolvedDescription = descriptionKey
              ? t(descriptionKey)
              : description;

            return (
              <Fragment key={href}>
                {showGroupDivider ? (
                  <div
                    aria-hidden="true"
                    className="my-1 border-t border-border/80"
                  />
                ) : null}
                {showGroupHeading && groupKey ? (
                  <p className="px-3 pb-0.5 pt-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                    {t(groupKey)}
                  </p>
                ) : null}
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-12 items-center gap-3 rounded-control px-3 py-2.5 text-start transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    active
                      ? "bg-sky text-primary-hover"
                      : "bg-white text-ink hover:bg-canvas",
                  )}
                  href={href}
                  onClick={onClose}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-control",
                      active
                        ? "bg-white text-primary"
                        : "bg-canvas text-primary",
                    )}
                  >
                    <Icon className="size-5" strokeWidth={1.9} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">
                      {resolvedLabel}
                    </span>
                    {resolvedDescription ? (
                      <span className="block truncate text-xs text-muted">
                        {resolvedDescription}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted viread-rtl-flip"
                  />
                </Link>
              </Fragment>
            );
          })}
        </nav>
      </section>
    </div>
  );
}
