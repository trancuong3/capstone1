"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { SelectField } from "@/components/common/select-field";
import type { ChildProfileDTO } from "@/types/child";

interface ChildSelectorProps {
  readonly childrenProfiles: readonly ChildProfileDTO[];
  readonly selectedChildId: string;
}

export function ChildSelector({
  childrenProfiles,
  selectedChildId,
}: ChildSelectorProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <SelectField
      aria-label="Chọn hồ sơ bé để xem dữ liệu"
      className="sm:min-h-[88px]"
      label="Hồ sơ của bé"
      onChange={(event) => {
        const next = new URLSearchParams(searchParams.toString());
        next.set("childId", event.target.value);
        next.delete("page");
        router.push(`${pathname}?${next.toString()}`);
      }}
      value={selectedChildId}
    >
      {childrenProfiles.map((child) => (
        <option key={child.id} value={child.id}>
          {child.alias} · Lớp {child.grade}
        </option>
      ))}
    </SelectField>
  );
}
