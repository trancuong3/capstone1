"use client";

import Link from "next/link";

import { useTranslations } from "@/hooks/use-i18n";
import type { ChildProfileDTO } from "@/types/child";

function initials(alias: string, fallback: string): string {
  const normalized = alias.trim().replace(/^bé\s+/i, "");
  return normalized.slice(0, 2) || fallback;
}

export function SelectedChildIdentity({ child }: { child: ChildProfileDTO }) {
  const tParent = useTranslations("parent");

  return (
    <div className="flex w-full items-center gap-3 rounded-card border border-border bg-white p-3 sm:w-fit sm:min-w-[320px]">
      <span
        aria-hidden="true"
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-purple text-lg font-semibold text-purple-ink"
      >
        {initials(child.alias, tParent("children.childInitialFallback"))}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-ink">{child.alias}</p>
        <p className="text-sm text-muted">
          {tParent("children.gradeLabel", { grade: child.grade })}
        </p>
      </div>
      <Link
        className="inline-flex min-h-11 shrink-0 items-center rounded-control px-3 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
        href="/dashboard?focus=child-selection"
      >
        {tParent("children.switchProfile")}
      </Link>
    </div>
  );
}
