import { forwardRef, useId, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField({ className, error, id, label, ...props }, ref) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;

    return (
      <div className="w-full">
        <div
          className={cn(
            "flex min-h-[90px] w-full flex-col gap-2 rounded-control border bg-white px-4 py-3.5 transition-colors sm:min-h-24 sm:py-4",
            error
              ? "border-danger"
              : "border-border focus-within:border-primary",
            className,
          )}
        >
          <label className="text-label font-bold text-muted" htmlFor={inputId}>
            {label}
          </label>
          <input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
            className="min-w-0 flex-1 border-0 bg-transparent text-body text-ink outline-none placeholder:text-muted/65 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
            id={inputId}
            ref={ref}
            {...props}
          />
        </div>
        {error ? (
          <p className="mt-2 text-label font-bold text-danger" id={errorId}>
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
