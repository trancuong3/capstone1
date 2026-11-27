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
        "catalog-header flex min-h-16 w-full items-center justify-between gap-2 rounded-card bg-white p-3 sm:min-h-24 sm:gap-8 sm:px-8",
        fullBleedDesktop && "sm:-mx-8 sm:-mt-8 sm:w-auto sm:px-10",
      )}
    >
      <span className="sm:hidden">
        <ViReadLogo href="/dashboard" compact />
      </span>
      <span className="hidden sm:block">
        <ViReadLogo href="/dashboard" />
      </span>
      <Link
        aria-label={t("childHeader.backAria", { context: contextLabel })}
        className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-control px-1 text-start font-semibold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
        href={backHref}
      >
        <ArrowLeft
          aria-hidden="true"
          className="viread-rtl-flip size-5 shrink-0 text-ink"
        />
        <span className="hidden shrink-0 text-body text-ink sm:block">
          {t("childHeader.back")}
        </span>
        <span className="truncate text-sm font-bold text-ink sm:ms-8 sm:text-xl sm:font-extrabold">
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
          className="inline-flex min-h-12 max-w-[144px] shrink-0 items-center truncate rounded-control bg-sky px-2.5 py-2 text-xs font-semibold text-primary focus-visible:outline-3 focus-visible:outline-primary sm:w-[220px] sm:max-w-none sm:px-3 sm:text-sm"
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
