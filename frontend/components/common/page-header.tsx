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
  const hasMdActionWidth = /(?:^|\s)md:w-/.test(actionClassName ?? "");

  return (
    <header
      className={cn(
        "flex min-h-11 flex-row flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5 md:min-h-0 md:flex-col md:flex-nowrap md:items-stretch md:gap-4 md:pb-5 lg:flex-row lg:items-end",
        className,
      )}
    >
      <div className="min-w-[min(100%,11rem)] flex-1 md:min-w-0 md:max-w-3xl">
        {eyebrow ? (
          <p className="hidden text-sm font-semibold text-muted md:block">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="book-title line-clamp-2 break-words text-xl leading-tight text-ink md:mt-1 md:line-clamp-none md:whitespace-normal md:text-3xl lg:text-[40px]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 hidden max-w-2xl text-body leading-6 text-muted md:block">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div
          className={cn(
            "flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2 md:justify-start md:gap-3 lg:w-auto [&>a]:min-h-11 [&>a]:w-auto [&>a]:px-3 [&>a]:text-xs [&>a]:md:px-5 [&>a]:md:text-label [&>button]:min-h-11 [&>button]:w-auto [&>button]:px-3 [&>button]:text-xs [&>button]:md:px-5 [&>button]:md:text-label",
            !hasMdActionWidth && "md:w-full",
            actionClassName,
          )}
        >
          {action}
        </div>
      ) : null}
    </header>
  );
}
