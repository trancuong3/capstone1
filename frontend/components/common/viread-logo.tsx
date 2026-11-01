import { BookOpen } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils/cn";

interface ViReadLogoProps {
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly compact?: boolean;
  readonly href?: string;
  readonly size?: "sm" | "md";
}

/** The single official ViRead wordmark used by public, parent and admin layouts. */
export function ViReadLogo({
  ariaLabel = "ViRead",
  className,
  compact = false,
  href = "/dashboard",
  size = "md",
}: ViReadLogoProps) {
  const isSmall = size === "sm";

  return (
    <Link
      aria-label={ariaLabel}
      className={cn(
        "group inline-flex min-h-11 shrink-0 items-center gap-2 rounded-control text-primary transition-opacity hover:opacity-85 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
        className,
      )}
      href={href}
    >
      <span
        className={cn(
          "grid shrink-0 place-items-center rounded-xl bg-sky text-primary transition-colors group-hover:bg-sky/80",
          isSmall ? "size-8" : "size-9",
        )}
      >
        <BookOpen
          aria-hidden="true"
          className={isSmall ? "size-4" : "size-5"}
          strokeWidth={2.2}
        />
      </span>
      <span
        className={cn(
          "font-extrabold tracking-tight",
          isSmall ? "text-base" : "text-xl",
          compact && "sr-only",
        )}
      >
        ViRead
      </span>
    </Link>
  );
}
