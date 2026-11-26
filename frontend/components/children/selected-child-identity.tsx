import Link from "next/link";

import type { ChildProfileDTO } from "@/types/child";

function initials(alias: string): string {
  const normalized = alias.trim().replace(/^bé\s+/i, "");
  return normalized.slice(0, 2) || "Bé";
}

export function SelectedChildIdentity({ child }: { child: ChildProfileDTO }) {
  return (
    <div className="hidden w-full max-w-full items-center gap-3 rounded-card border border-border bg-white p-3 md:flex md:w-fit md:min-w-[320px]">
      <span
        aria-hidden="true"
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-purple text-lg font-semibold text-purple-ink"
      >
        {initials(child.alias)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-ink">{child.alias}</p>
        <p className="text-sm text-muted">Lớp {child.grade}</p>
      </div>
      <Link
        className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 py-2 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
        href="/dashboard?focus=child-selection"
      >
        Đổi hồ sơ
      </Link>
    </div>
  );
}
