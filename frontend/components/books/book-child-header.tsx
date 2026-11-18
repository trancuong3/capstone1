import { ArrowLeft } from "lucide-react";
import Link from "next/link";

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
  const contextLabel = mobileLabel ?? "Chọn sách cho bé";

  return (
    <header
      className={cn(
        "catalog-header flex min-h-20 w-full items-center justify-between gap-3 rounded-card bg-white p-4 sm:min-h-24 sm:gap-8 sm:px-8",
        fullBleedDesktop && "sm:-mx-8 sm:-mt-8 sm:px-10",
      )}
    >
      <span className="sm:hidden">
        <ViReadLogo href="/dashboard" compact />
      </span>
      <span className="hidden sm:block">
        <ViReadLogo href="/dashboard" />
      </span>
      <Link
        aria-label={`Quay lại: ${contextLabel}`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-control text-left font-semibold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
        href={backHref}
      >
        <ArrowLeft aria-hidden="true" className="size-5 shrink-0 text-ink" />
        <span className="hidden shrink-0 text-body text-ink sm:block">
          Quay lại
        </span>
        <span className="truncate text-label text-ink sm:ml-8 sm:text-xl sm:font-extrabold">
          {contextLabel}
        </span>
      </Link>
      {child ? (
        <Link
          href="/dashboard?focus=child-selection"
          aria-label={`Đổi hồ sơ: ${child.alias}, lớp ${child.grade}`}
          className="hidden shrink-0 truncate rounded-control bg-sky px-3 py-2 text-sm font-semibold text-primary focus-visible:outline-3 focus-visible:outline-primary sm:block sm:w-[220px]"
        >
          {child.alias} · Lớp {child.grade}
        </Link>
      ) : null}
    </header>
  );
}
