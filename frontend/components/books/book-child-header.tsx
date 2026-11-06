import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import type { ChildProfileDTO } from "@/types/child";

interface BookChildHeaderProps {
  backHref?: string;
  child: ChildProfileDTO | null;
  mobileLabel?: string;
}

export function BookChildHeader({
  backHref = "/dashboard",
  child,
  mobileLabel,
}: BookChildHeaderProps) {
  const contextLabel = mobileLabel ?? "Chọn sách cho bé";

  return (
    <header className="flex min-h-12 w-full items-center justify-between gap-3 border-b border-border/70 pb-3">
      <Link
        aria-label={`Quay lại: ${contextLabel}`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-control text-left font-bold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
        href={backHref}
      >
        <ArrowLeft aria-hidden="true" className="size-5 shrink-0 text-ink" />
        <span className="truncate text-label">{contextLabel}</span>
      </Link>
      {child ? (
        <p className="max-w-[42%] shrink-0 truncate text-right text-sm font-bold text-muted sm:max-w-none">
          {child.alias} · Lớp {child.grade}
        </p>
      ) : null}
    </header>
  );
}
