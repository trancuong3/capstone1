"use client";

import { Check, Pencil } from "lucide-react";
import Link from "next/link";

import { ProfileAvatar } from "@/components/common/profile-avatar";
import { useTranslations } from "@/hooks/use-i18n";
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
  const tParent = useTranslations("parent");
  const cardAria = tParent("children.cardAria", {
    alias: child.alias,
    grade: child.grade,
  });

  const content = (
    <>
      <ProfileAvatar
        ariaLabel={tParent("children.avatarAria", { alias: child.alias })}
        displayName={child.alias}
        imageUrl={child.avatar_url}
        size="md"
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-xl font-bold leading-tight text-ink">
          {child.alias}
        </span>
        <span className="text-sm text-muted">
          {tParent("children.gradeLabel", { grade: child.grade })}
        </span>
      </span>
      {selected ? (
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-primary">
          <Check aria-hidden="true" className="size-4" />{" "}
          {tParent("children.selectedBadge")}
        </span>
      ) : showEditAction ? (
        <Pencil aria-hidden="true" className="size-4 shrink-0 text-muted" />
      ) : null}
    </>
  );

  const className =
    "group relative flex min-h-20 w-full items-center gap-4 rounded-control border px-4 py-3 text-start transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary " +
    (selected
      ? "border-primary bg-sky"
      : "border-border bg-white hover:border-primary/60");

  if (onSelect) {
    return (
      <button
        aria-label={cardAria}
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
      <Link aria-label={cardAria} className={className} href={href}>
        {content}
      </Link>
    );
  }

  return <article className={className}>{content}</article>;
}
