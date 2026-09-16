import { ArrowLeft, Heart } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { ButtonLink } from "@/components/common/button";
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
    ? `${child.alias} · Lớp ${child.grade}`
    : "Chọn sách cho bé";

  return (
    <header className="w-full">
      <div className="hidden h-16 w-full items-center justify-between sm:flex">
        <Link
          aria-label="Về tổng quan"
          className="flex h-16 shrink-0 items-center gap-3 rounded-control font-bold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
          href="/dashboard"
        >
          <Image
            alt=""
            height={48}
            priority
            src="/images/figma/owl-mascot.svg"
            width={48}
          />
          <span className="text-body">READALONG VISION</span>
        </Link>
        <ButtonLink
          className="max-w-[220px] shrink-0"
          href="/dashboard"
          variant="quiet"
        >
          <Heart aria-hidden="true" className="size-5" />
          Dành cho ba mẹ
        </ButtonLink>
      </div>

      <Link
        aria-label={`Quay lại. ${mobileLabel ?? childLabel}`}
        className="flex h-12 w-full items-center gap-2 rounded-control text-left font-bold text-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:hidden"
        href={backHref}
      >
        <ArrowLeft aria-hidden="true" className="size-[26px] text-ink" />
        <span className="text-label">{mobileLabel ?? childLabel}</span>
      </Link>
    </header>
  );
}
