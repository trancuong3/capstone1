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
    <section className="flex w-full flex-col items-center gap-5 rounded-card border border-border bg-white px-6 py-10 text-center shadow-[0_2px_10px_rgba(33,60,66,0.06)] sm:px-10 sm:py-12">
      <span className="grid size-16 place-items-center rounded-full bg-sky text-primary">
        {icon ?? <BookOpenText aria-hidden="true" className="size-7" />}
      </span>
      <div className="max-w-xl">
        <Heading className="text-xl font-extrabold leading-snug text-ink">
          {title}
        </Heading>
        <p className="mt-2 text-base leading-6 text-muted">{description}</p>
      </div>
      {action}
    </section>
  );
}
