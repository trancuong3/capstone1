import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import { ViReadLogo } from "@/components/common/viread-logo";

interface BookChildHeaderProps {
  backHref?: string;
  child: ChildProfileDTO | null;
  fullBleedDesktop?: boolean;
  hideOnMobile?: boolean;
  mobileLabel?: string;
}

export function BookChildHeader({
  backHref = "/dashboard",
  child,
  fullBleedDesktop = false,
  hideOnMobile = false,
  mobileLabel,
}: BookChildHeaderProps) {
  const contextLabel = mobileLabel ?? "Chọn sách cho bé";

  return (
    <header
      className={cn(
        "catalog-header min-h-16 w-full items-center justify-between gap-2 rounded-card bg-white p-3 md:min-h-24 md:gap-8 md:px-8",
        hideOnMobile ? "hidden xl:flex" : "flex",
        fullBleedDesktop && "md:-mx-8 md:-mt-8 md:px-10",
      )}
    >
      <span className="md:hidden">
        <ViReadLogo href="/dashboard" compact />
      </span>
      <span className="hidden md:block">
        <ViReadLogo href="/dashboard" />
      </span>
      <Link
        aria-label={`Quay lại: ${contextLabel}`}
        className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-control px-1 text-left font-semibold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
        href={backHref}
      >
        <ArrowLeft aria-hidden="true" className="size-5 shrink-0 text-ink" />
        <span className="hidden shrink-0 text-body text-ink md:block">
          Quay lại
        </span>
        <span className="truncate text-sm font-bold text-ink md:ml-8 md:text-xl md:font-extrabold">
          {contextLabel}
        </span>
      </Link>
      {child ? (
        <Link
          href="/dashboard?focus=child-selection"
          aria-label={`Đổi hồ sơ: ${child.alias}, lớp ${child.grade}`}
          className="inline-flex min-h-12 max-w-[144px] shrink-0 items-center truncate rounded-control bg-sky px-2.5 py-2 text-xs font-semibold text-primary focus-visible:outline-3 focus-visible:outline-primary md:w-[220px] md:max-w-none md:px-3 md:text-sm"
        >
          <span className="truncate">
            {child.alias} · Lớp {child.grade}
          </span>
        </Link>
      ) : null}
    </header>
  );
}
