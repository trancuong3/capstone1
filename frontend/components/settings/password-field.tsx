"use client";

import { Eye, EyeOff } from "lucide-react";

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  autoComplete: string;
  toggleAriaLabel: string;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  visible,
  onToggle,
  autoComplete,
  toggleAriaLabel,
}: PasswordFieldProps) {
  return (
    <div className="flex min-h-[64px] w-full flex-col gap-1 rounded-control border border-border bg-white px-3.5 py-2.5 sm:min-h-[72px] sm:px-4 sm:py-3">
      <label className="text-label font-semibold text-muted" htmlFor={id}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          autoComplete={autoComplete}
          className="min-w-0 flex-1 bg-transparent text-start text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          required
          type={visible ? "text" : "password"}
          value={value}
        />
        <button
          aria-label={toggleAriaLabel}
          className="flex size-11 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sky hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          onClick={onToggle}
          type="button"
        >
          {visible ? (
            <EyeOff aria-hidden="true" className="size-5" />
          ) : (
            <Eye aria-hidden="true" className="size-5" />
          )}
        </button>
      </div>
    </div>
  );
}
