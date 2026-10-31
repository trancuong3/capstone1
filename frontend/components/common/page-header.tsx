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
    <header
      className={cn(
        "mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end",
        className,
      )}
    >
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? (
          <p className="text-label font-extrabold uppercase tracking-wider text-primary">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mt-1 text-heading font-extrabold text-ink">{title}</h1>
        {description ? (
          <p className="mt-2 text-body text-muted">{description}</p>
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
