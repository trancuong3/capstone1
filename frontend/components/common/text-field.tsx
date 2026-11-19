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
      <div className={cn("relative w-full", className)}>
        <label
          className="absolute left-4 top-3 z-10 max-w-[calc(100%-2rem)] text-sm font-bold text-muted"
          htmlFor={inputId}
        >
          {label}
        </label>
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={Boolean(error)}
          className={cn(
            "h-[72px] w-full rounded-control border bg-white px-4 pb-3 pt-8 text-body text-ink outline-none placeholder:text-muted/70 focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-canvas disabled:text-muted",
            error ? "border-danger" : "border-border",
          )}
          id={inputId}
          ref={ref}
          {...props}
        />
        {error ? (
          <p className="mt-2 text-label font-semibold text-danger" id={errorId}>
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
