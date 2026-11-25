"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId } from "react";

import type { ChildProfileDTO } from "@/types/child";

interface ChildSelectorProps {
  readonly childrenProfiles: readonly ChildProfileDTO[];
  readonly selectedChildId: string;
  /** Query parameters to remove when switching profiles (e.g. `["word"]`). */
  readonly clearQueryKeys?: readonly string[];
}

export function ChildSelector({
  childrenProfiles,
  selectedChildId,
  clearQueryKeys,
}: ChildSelectorProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectId = useId();

  return (
    <div className="min-w-0">
      <label
        className="mb-1.5 block text-xs font-bold text-muted"
        htmlFor={selectId}
      >
        Hồ sơ của bé
      </label>
      <select
        aria-label="Chọn hồ sơ bé để xem dữ liệu"
        className="min-h-12 w-full cursor-pointer rounded-control border border-border bg-white px-3.5 text-sm font-bold text-ink outline-none focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
            {child.alias} · Lớp {child.grade}
          </option>
        ))}
      </select>
    </div>
  );
}
