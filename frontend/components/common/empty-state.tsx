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
    <section className="flex w-full flex-col items-center gap-4 rounded-card bg-cream p-8 text-center">
      {icon ?? (
        <BookOpenText aria-hidden="true" className="size-10 text-primary" />
      )}
      <div>
        <Heading className="text-2xl font-extrabold leading-[1.4] text-ink">
          {title}
        </Heading>
        <p className="mt-2 text-lg leading-[1.4] text-muted">{description}</p>
      </div>
      {action}
    </section>
  );
}
