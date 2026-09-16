import { Pencil } from "lucide-react";
import Link from "next/link";

import type { ChildProfileDTO } from "@/types/child";

interface ChildProfileCardProps {
  child: ChildProfileDTO;
  href?: string;
  showEditAction?: boolean;
}

function childInitial(alias: string): string {
  const normalized = alias.trim().replace(/^bé\s+/i, "");
  return normalized.slice(0, 4) || "Bé";
}

export function ChildProfileCard({
  child,
  href,
  showEditAction = false,
}: ChildProfileCardProps) {
  const content = (
    <>
      <span className="flex size-[104px] items-center justify-center rounded-card bg-purple px-4 text-[44px] font-extrabold leading-[1.4] text-purple-ink">
        {childInitial(child.alias)}
      </span>
      <span className="text-[26px] font-bold leading-[1.4] text-ink">
        {child.alias}
      </span>
      <span className="text-label font-bold text-muted">Lớp {child.grade}</span>
      <span className="text-label font-bold text-primary">
        {showEditAction ? (
          <span className="inline-flex items-center gap-2">
            <Pencil aria-hidden="true" className="size-4" />
            Xem và chỉnh sửa
          </span>
        ) : (
          "Sẵn sàng cùng đọc"
        )}
      </span>
    </>
  );

  const className =
    "flex min-h-[280px] w-full flex-col items-center justify-center gap-3 rounded-card border border-border bg-white p-6 text-center transition-colors hover:border-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary";

  if (href) {
    return (
      <Link
        aria-label={`${child.alias}, lớp ${child.grade}`}
        className={className}
        href={href}
      >
        {content}
      </Link>
    );
  }

  return <article className={className}>{content}</article>;
}
