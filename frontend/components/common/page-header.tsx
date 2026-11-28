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
        "flex flex-col justify-between gap-3 border-b border-border pb-3.5 lg:flex-row lg:items-end",
        className,
      )}
    >
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? (
          <p className="text-xs font-bold uppercase tracking-wide text-primary sm:text-sm sm:normal-case sm:tracking-normal sm:text-muted">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="book-title mt-0.5 text-2xl text-ink sm:text-[34px]">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-5 text-muted sm:text-base sm:leading-6">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div
          className={cn(
            "flex w-full shrink-0 flex-wrap items-center gap-2.5 sm:w-auto",
            actionClassName,
          )}
        >
          {action}
        </div>
      ) : null}
    </header>
  );
}
