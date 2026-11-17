import { BookOpenText } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  action?: ReactNode;
  description: string;
  headingLevel?: 1 | 2 | 3;
  icon?: ReactNode;
  title: string;
}

export function EmptyState({
  action,
  description,
  headingLevel = 2,
  icon,
  title,
}: EmptyStateProps) {
  const Heading = headingLevel === 1 ? "h1" : headingLevel === 3 ? "h3" : "h2";

  return (
    <section className="flex w-full flex-col items-center gap-4 rounded-card border border-border bg-white p-6 text-center">
      {icon ?? (
        <BookOpenText aria-hidden="true" className="size-6 text-primary" />
      )}
      <div className="max-w-xl">
        <Heading className="text-xl font-semibold leading-snug text-ink">
          {title}
        </Heading>
        <p className="mt-2 text-base leading-6 text-muted">{description}</p>
      </div>
      {action}
    </section>
  );
}
