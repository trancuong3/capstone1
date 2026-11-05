import Link from "next/link";

import type { ChildProfileDTO } from "@/types/child";

function initials(alias: string): string {
  const normalized = alias.trim().replace(/^bé\s+/i, "");
  return normalized.slice(0, 2) || "Bé";
}

export function SelectedChildIdentity({ child }: { child: ChildProfileDTO }) {
  return (
    <div className="flex w-full items-center gap-3 rounded-card border border-line bg-white p-3 sm:w-fit sm:min-w-[320px]">
      <span
        aria-hidden="true"
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-purple text-lg font-extrabold text-purple-ink"
      >
        {initials(child.alias)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-extrabold text-ink">{child.alias}</p>
        <p className="text-sm text-muted">Lớp {child.grade}</p>
      </div>
      <Link
        className="rounded-md px-2 py-2 text-sm font-bold text-primary underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
        href="/dashboard?focus=child-selection"
      >
        Đổi hồ sơ
      </Link>
    </div>
  );
}
