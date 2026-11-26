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
        size="md"
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-base font-bold leading-tight text-ink md:text-xl">
          {child.alias}
        </span>
        <span className="text-xs text-muted md:text-sm">Lớp {child.grade}</span>
      </span>
      {selected ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary md:text-sm">
          <Check aria-hidden="true" className="size-4" /> Đang chọn
        </span>
      ) : showEditAction ? (
        <Pencil aria-hidden="true" className="size-4 shrink-0 text-muted" />
      ) : null}
    </>
  );

  const className =
    "group relative flex min-h-16 w-full items-center gap-3 rounded-control border px-3 py-2 text-left transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary md:min-h-20 md:gap-4 md:px-4 md:py-3 " +
    (selected
      ? "border-primary bg-sky"
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
