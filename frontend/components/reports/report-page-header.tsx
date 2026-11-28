import type { ReactNode } from "react";

interface ReportPageHeaderProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}

export function ReportPageHeader({
  action,
  description,
  eyebrow,
  title,
}: ReportPageHeaderProps) {
  return (
    <header className="mb-0 flex flex-col justify-between gap-2.5 border-b border-border pb-3 sm:gap-4 sm:pb-5 lg:flex-row lg:items-end">
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? (
          <p className="text-xs font-semibold text-muted sm:text-sm">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="book-title mt-0.5 text-xl text-ink sm:mt-1 sm:text-3xl lg:text-[40px]">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted sm:mt-2 sm:text-body sm:leading-6">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex w-full shrink-0 flex-wrap gap-2 sm:w-auto sm:gap-3 max-sm:[&>a]:min-h-11 max-sm:[&>button]:min-h-11">
          {action}
        </div>
      ) : null}
    </header>
  );
}
