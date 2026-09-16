import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";

import { cn } from "@/lib/utils/cn";

export type ButtonVariant = "primary" | "secondary" | "quiet";

const baseClassName =
  "inline-flex h-16 w-full items-center justify-center gap-2 rounded-control px-4 py-3 text-center text-button font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-55";

const variantClassNames: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "bg-sky text-primary-hover hover:bg-border",
  quiet: "bg-white text-ink hover:bg-sky",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  isLoading?: boolean;
  variant?: ButtonVariant;
}

export function Button({
  children,
  className,
  disabled,
  isLoading = false,
  type = "button",
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <button
      aria-busy={isLoading || undefined}
      className={cn(baseClassName, variantClassNames[variant], className)}
      disabled={disabled || isLoading}
      type={type}
      {...props}
    >
      {isLoading ? (
        <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
      ) : null}
      {children}
    </button>
  );
}

interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children: ReactNode;
  href: string;
  variant?: ButtonVariant;
}

export function ButtonLink({
  children,
  className,
  href,
  variant = "primary",
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      className={cn(baseClassName, variantClassNames[variant], className)}
      href={href}
      {...props}
    >
      {children}
    </Link>
  );
}
