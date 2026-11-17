import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

interface PageHeaderProps {
  readonly action?: ReactNode;
  readonly actionClassName?: string;
  readonly className?: string;
  readonly description?: string;
  readonly eyebrow?: string;
  readonly title: string;
}

export function PageHeader({
  action,
  actionClassName,
  className,
  description,
  eyebrow,
  title,
}: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col justify-between gap-4", className)}>
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? (
          <p className="text-label font-bold text-primary">{eyebrow}</p>
        ) : null}
        <h1 className="mt-1 text-heading font-extrabold leading-tight text-ink">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-body leading-6 text-muted">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div
          className={cn(
            "flex w-full shrink-0 flex-wrap gap-3 sm:w-auto",
            actionClassName,
          )}
        >
          {action}
        </div>
      ) : null}
    </header>
  );
}
