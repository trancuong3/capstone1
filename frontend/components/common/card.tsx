import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  tone?: "default" | "success";
}

export function Card({
  children,
  className,
  tone = "default",
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-4 overflow-hidden rounded-card border border-border p-4 shadow-sm sm:gap-6 sm:p-8",
        tone === "success" ? "bg-success-surface" : "bg-white",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
