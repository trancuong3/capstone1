import { PageHeader } from "@/components/common/page-header";
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
    <PageHeader
      action={action}
      actionClassName="sm:w-auto"
      className="mb-0"
      description={description}
      eyebrow={eyebrow}
      title={title}
    />
  );
}
