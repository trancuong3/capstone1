import { Check, Pencil } from "lucide-react";
import Link from "next/link";

import { ProfileAvatar } from "@/components/common/profile-avatar";
import type { ChildProfileDTO } from "@/types/child";

interface ChildProfileCardProps {
  child: ChildProfileDTO;
  href?: string;
  showEditAction?: boolean;
  onSelect?: () => void;
  selected?: boolean;
}

export function ChildProfileCard({
  child,
  href,
  showEditAction = false,
  onSelect,
  selected = false,
}: ChildProfileCardProps) {
  const content = (
    <>
      <ProfileAvatar
        ariaLabel={`Ảnh đại diện của ${child.alias}`}
        displayName={child.alias}
        imageUrl={child.avatar_url}
        size="card"
      />
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
    "relative flex min-h-[280px] w-full flex-col items-center justify-center gap-3 rounded-card border p-6 text-center transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary " +
    (selected
      ? "border-primary bg-sky ring-2 ring-primary"
      : "border-border bg-white hover:border-primary");

  if (onSelect) {
    return (
      <button
        aria-label={`${child.alias}, lớp ${child.grade}`}
        aria-pressed={selected}
        className={className}
        onClick={onSelect}
        type="button"
      >
        {selected ? (
          <span className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-primary text-white">
            <Check aria-hidden="true" className="size-5" />
          </span>
        ) : null}
        {content}
      </button>
    );
  }

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
