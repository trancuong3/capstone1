import { ArrowLeft, Heart } from "lucide-react";
import Link from "next/link";

import { ButtonLink } from "@/components/common/button";
import { ViReadLogo } from "@/components/common/viread-logo";
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
  const childLabel = child
    ? child.alias + " · Lớp " + child.grade
    : "Chọn sách cho bé";

  return (
    <header className="w-full">
      <div className="hidden h-16 w-full items-center justify-between sm:flex">
        <ViReadLogo
          ariaLabel="ViRead - về tổng quan"
          href="/dashboard"
          size="md"
        />
        <ButtonLink
          className="max-w-[220px] shrink-0"
          href="/dashboard"
          variant="quiet"
        >
          <Heart aria-hidden="true" className="size-5" />
          Dành cho ba mẹ
        </ButtonLink>
      </div>

      <div className="flex h-12 w-full min-w-0 items-center gap-2 sm:hidden">
        <ViReadLogo
          ariaLabel="ViRead - về tổng quan"
          compact
          href="/dashboard"
          size="sm"
        />
        <Link
          aria-label={"Quay lại. " + (mobileLabel ?? childLabel)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-control text-left font-bold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
          href={backHref}
        >
          <ArrowLeft
            aria-hidden="true"
            className="size-6 shrink-0 text-ink"
          />
          <span className="truncate text-label">
            {mobileLabel ?? childLabel}
          </span>
        </Link>
      </div>
    </header>
  );
}
