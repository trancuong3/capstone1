"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId } from "react";

import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";

interface ChildSelectorProps {
  readonly childrenProfiles: readonly ChildProfileDTO[];
  readonly selectedChildId: string;
  /** Query parameters to remove when switching profiles (e.g. `["word"]`). */
  readonly clearQueryKeys?: readonly string[];
  readonly compact?: boolean;
  readonly className?: string;
}

export function ChildSelector({
  childrenProfiles,
  selectedChildId,
  clearQueryKeys,
  compact = false,
  className,
}: ChildSelectorProps) {
  const tc = useTranslations("child");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectId = useId();

  return (
    <div className={cn("min-w-0", className)}>
      <label
        className={
          compact ? "sr-only" : "mb-1.5 block text-xs font-bold text-muted"
        }
        htmlFor={selectId}
      >
        {tc("selector.label")}
      </label>
      <select
        aria-label={tc("selector.selectAria")}
        className={
          compact
            ? "h-9 min-h-9 w-full cursor-pointer rounded-control border border-border bg-cream px-2.5 text-xs font-bold text-ink outline-none focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary sm:text-sm"
            : "min-h-12 w-full cursor-pointer rounded-control border border-border bg-white px-3.5 text-sm font-bold text-ink outline-none focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
        }
        id={selectId}
        onChange={(event) => {
          const next = new URLSearchParams(searchParams.toString());
          next.set("childId", event.target.value);
          next.delete("page");
          if (clearQueryKeys) {
            for (const key of clearQueryKeys) {
              next.delete(key);
            }
          }
          router.push(`${pathname}?${next.toString()}`);
        }}
        value={selectedChildId}
      >
        {childrenProfiles.map((child) => (
          <option key={child.id} value={child.id}>
            {tc("selector.optionLabel", {
              alias: child.alias,
              grade: child.grade,
            })}
          </option>
        ))}
      </select>
    </div>
  );
}
