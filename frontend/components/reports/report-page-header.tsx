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
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-[760px]">
        <p className="text-label font-extrabold uppercase tracking-[0.08em] text-primary">
          {eyebrow}
        </p>
        <h1 className="mt-2 text-heading font-extrabold text-ink">{title}</h1>
        <p className="mt-2 text-body text-muted">{description}</p>
      </div>
      {action ? <div className="w-full sm:w-auto">{action}</div> : null}
    </header>
  );
}
