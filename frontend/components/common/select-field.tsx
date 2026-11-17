import { forwardRef, useId, type SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: string;
  label: string;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  function SelectField(
    { children, className, error, id, label, ...props },
    ref,
  ) {
    const generatedId = useId();
    const selectId = id ?? generatedId;
    const errorId = `${selectId}-error`;

    return (
      <div className={cn("w-full", className)}>
        <label
          className="mb-2 block text-label font-semibold text-ink"
          htmlFor={selectId}
        >
          {label}
        </label>
        <select
          aria-describedby={error ? errorId : undefined}
          aria-invalid={Boolean(error)}
          className={cn(
            "h-12 w-full cursor-pointer rounded-control border bg-white px-3.5 text-body text-ink outline-none focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-canvas disabled:text-muted",
            error ? "border-danger" : "border-border",
          )}
          id={selectId}
          ref={ref}
          {...props}
        >
          {children}
        </select>
        {error ? (
          <p className="mt-2 text-label font-semibold text-danger" id={errorId}>
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
