import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export interface ResponsiveTableProps {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function ResponsiveTable({
  ariaLabel,
  children,
  className,
}: ResponsiveTableProps) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "relative w-full max-w-full overflow-x-auto overscroll-x-contain rounded-2xl border border-border bg-white shadow-[inset_-12px_0_12px_-12px_rgba(35,62,64,0.18)] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
        className,
      )}
      role="region"
      tabIndex={0}
    >
      {children}
    </div>
  );
}
