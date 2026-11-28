"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import { ViReadLogo } from "@/components/common/viread-logo";

interface BookChildHeaderProps {
  backHref?: string;
  child: ChildProfileDTO | null;
  fullBleedDesktop?: boolean;
  mobileLabel?: string;
}

export function BookChildHeader({
  backHref = "/dashboard",
  child,
  fullBleedDesktop = false,
  mobileLabel,
}: BookChildHeaderProps) {
  const t = useTranslations("books");
  const contextLabel = mobileLabel ?? t("childHeader.defaultMobileLabel");

  return (
    <header
      className={cn(
        "catalog-header sticky top-0 z-20 -mx-3.5 flex h-13 w-auto items-center justify-between gap-2 bg-white/95 px-3 backdrop-blur-sm sm:static sm:h-auto sm:min-h-24 sm:gap-8 sm:rounded-card sm:bg-white sm:px-8 sm:py-3 sm:backdrop-blur-none",
        fullBleedDesktop
          ? "sm:-mx-8 sm:-mt-8 sm:w-auto sm:px-10"
          : "sm:mx-0 sm:w-full",
      )}
    >
      {!backHref ? (
        <span className="sm:hidden">
          <ViReadLogo href="/dashboard" compact />
        </span>
      ) : null}
      <span className="hidden sm:block">
        <ViReadLogo href="/dashboard" />
      </span>
      <Link
        aria-label={t("childHeader.backAria", { context: contextLabel })}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-control px-1 text-start font-semibold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:min-h-12 sm:gap-2"
        href={backHref}
      >
        <ArrowLeft
          aria-hidden="true"
          className="viread-rtl-flip size-5 shrink-0 text-ink"
        />
        <span className="hidden shrink-0 text-body text-ink sm:block">
          {t("childHeader.back")}
        </span>
        <span className="truncate text-sm font-extrabold text-ink sm:ms-8 sm:text-xl">
          {contextLabel}
        </span>
      </Link>
      {child ? (
        <Link
          href="/dashboard?focus=child-selection"
          aria-label={t("childHeader.switchChildAria", {
            alias: child.alias,
            grade: child.grade,
          })}
          className="inline-flex min-h-11 max-w-[132px] shrink-0 items-center truncate rounded-full border border-border/70 bg-sky/80 px-2.5 py-1 text-xs font-bold text-primary-hover focus-visible:outline-3 focus-visible:outline-primary sm:min-h-12 sm:w-[220px] sm:max-w-none sm:rounded-control sm:border-0 sm:bg-sky sm:px-3 sm:py-2 sm:text-sm sm:font-semibold sm:text-primary"
        >
          <span className="truncate">
            {t("childHeader.childMeta", {
              alias: child.alias,
              grade: child.grade,
            })}
          </span>
        </Link>
      ) : null}
    </header>
  );
}
