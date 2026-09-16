import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-control bg-border/80", className)}
      {...props}
    />
  );
}
