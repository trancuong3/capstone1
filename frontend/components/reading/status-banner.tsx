import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

interface StatusBannerProps {
  children: ReactNode;
  className?: string;
  tone?: "info" | "warning";
}

export function StatusBanner({
  children,
  className,
  tone = "info",
}: StatusBannerProps) {
  return (
    <div
      aria-live="polite"
      className={cn(
        "rounded-control px-4 py-3 text-center text-label font-bold shadow-sm",
        tone === "warning"
          ? "bg-warning-surface text-warning"
          : "bg-sky text-primary-hover",
        className,
      )}
      role="status"
    >
      {children}
    </div>
  );
}
