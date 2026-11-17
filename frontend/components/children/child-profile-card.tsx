import { Check, Pencil } from "lucide-react";
import Link from "next/link";

import { ProfileAvatar } from "@/components/common/profile-avatar";
import type { ChildProfileDTO } from "@/types/child";

interface ChildProfileCardProps {
  child: Pick<ChildProfileDTO, "id" | "alias" | "grade" | "avatar_url">;
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
      <span className="text-2xl font-extrabold leading-[1.4] text-ink">
        {child.alias}
      </span>
      <span className="text-label font-semibold text-muted">
        Lớp {child.grade}
      </span>
      <span className="text-label font-semibold text-primary">
        {selected ? (
          <span className="inline-flex items-center gap-2">
            <Check aria-hidden="true" className="size-4" />
            Đang chọn
          </span>
        ) : showEditAction ? (
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
    "group relative flex min-h-[280px] w-full flex-col items-center justify-center gap-3 rounded-card border p-6 text-center transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary " +
    (selected
      ? "border-primary bg-sky ring-2 ring-primary"
      : "border-border bg-white hover:border-primary/60");

  if (onSelect) {
    return (
      <button
        aria-label={`${child.alias}, lớp ${child.grade}`}
        aria-pressed={selected}
        className={className}
        onClick={onSelect}
        type="button"
      >
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
