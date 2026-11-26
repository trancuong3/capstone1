import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils/cn";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  endAdornment?: ReactNode;
  error?: string;
  label: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    { className, endAdornment, error, id, label, ...props },
    ref,
  ) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;

    return (
      <div className={cn("w-full", className)}>
        <div className="relative w-full">
          <label
            className={cn(
              "absolute start-4 top-3 z-10 text-sm font-bold text-muted",
              endAdornment
                ? "max-w-[calc(100%-4rem)] truncate"
                : "max-w-[calc(100%-2rem)]",
            )}
            htmlFor={inputId}
          >
            {label}
          </label>
          <input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
            className={cn(
              "h-[72px] w-full rounded-control border bg-white px-4 pb-3 pt-8 text-start text-body text-ink outline-none placeholder:text-muted/70 focus-visible:border-primary focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-canvas disabled:text-muted",
              endAdornment ? "pe-12" : undefined,
              error ? "border-danger" : "border-border",
            )}
            id={inputId}
            ref={ref}
            {...props}
          />
          {endAdornment ? (
            <div className="absolute end-3 top-1/2 z-10 flex -translate-y-1/2 items-center">
              {endAdornment}
            </div>
          ) : null}
        </div>
        {error ? (
          <p className="mt-2 text-label font-semibold text-danger" id={errorId}>
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
