"use client";

import { ChevronRight, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";

import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

export interface MobileMoreSheetItem {
  readonly href: string;
  readonly label: string;
  readonly labelKey?: string;
  readonly description?: string;
  readonly descriptionKey?: string;
  readonly icon: LucideIcon;
  readonly isActive?: (pathname: string) => boolean;
}

interface MobileMoreSheetProps {
  readonly id?: string;
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly pathname: string;
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
  title,
  items,
}: MobileMoreSheetProps) {
  const { t } = useI18n();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const resolvedTitle = title ?? t("navigation.parent.moreTitle");

  useEffect(() => {
    if (!isOpen) return;
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end xl:hidden"
      role="presentation"
    >
      <button
        aria-label={t("accessibility.closeMoreSheet")}
        className="fixed inset-0 bg-ink/40 backdrop-blur-[1px]"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <section
        aria-labelledby={`${id}-title`}
        aria-modal="true"
        className="relative z-10 w-full rounded-t-2xl border-t border-border bg-white px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 shadow-2xl"
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
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        <nav aria-label={resolvedTitle} className="grid gap-1.5">
          {items.map(
            ({
              href,
              label,
              labelKey,
              description,
              descriptionKey,
              icon: Icon,
              isActive,
            }) => {
              const active = isActive
                ? isActive(pathname)
                : defaultRouteActive(pathname, href);
              const resolvedLabel = labelKey ? t(labelKey) : label;
              const resolvedDescription = descriptionKey
                ? t(descriptionKey)
                : description;

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-12 items-center gap-3 rounded-control px-3 py-2.5 text-start transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    active
                      ? "bg-sky text-primary-hover"
                      : "bg-white text-ink hover:bg-canvas",
                  )}
                  href={href}
                  key={href}
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
              );
            },
          )}
        </nav>
      </section>
    </div>
  );
}
