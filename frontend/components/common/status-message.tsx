import {
  AlertCircle,
  CheckCircle2,
  CircleAlert,
  Info,
  type LucideIcon,
} from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

type StatusTone = "info" | "success" | "warning" | "error";

const toneClasses: Record<StatusTone, string> = {
  info: "bg-sky text-ink",
  success: "bg-success-surface text-success-ink",
  warning: "bg-warning-surface text-warning",
  error: "bg-danger-surface text-danger",
};

const toneIcons: Record<StatusTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: CircleAlert,
  error: AlertCircle,
};

interface StatusMessageProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  title?: string;
  tone?: StatusTone;
}

export function StatusMessage({
  children,
  className,
  title,
  tone = "info",
  ...props
}: StatusMessageProps) {
  const Icon = toneIcons[tone];
  const role = tone === "error" ? "alert" : "status";

  return (
    <div
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={cn(
        "flex w-full items-start gap-3 rounded-control p-4",
        toneClasses[tone],
        className,
      )}
      role={role}
      {...props}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 text-label">
        {title ? <p className="font-extrabold">{title}</p> : null}
        <div className={cn(title && "mt-1")}>{children}</div>
      </div>
    </div>
  );
}
