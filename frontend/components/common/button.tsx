"use client";

import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils/cn";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "destructive";
export type ButtonSize = "default" | "compact";

export const ButtonSizeContext = createContext<ButtonSize>("default");

const baseClassName =
  "inline-flex h-16 w-full items-center justify-center gap-2 rounded-control px-4 py-3 text-center text-button font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-55";

const variantClassNames: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "bg-sky text-primary-hover hover:bg-border",
  quiet: "bg-white text-ink hover:bg-sky",
  destructive: "bg-danger text-white hover:opacity-90",
};

const sizeClassNames: Record<ButtonSize, string> = {
  default: "",
  compact: "h-auto min-h-11 px-4 py-2.5 text-sm leading-5",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  isLoading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export function Button({
  children,
  className,
  disabled,
  isLoading = false,
  size,
  type = "button",
  variant = "primary",
  ...props
}: ButtonProps) {
  const inheritedSize = useContext(ButtonSizeContext);

  return (
    <button
      aria-busy={isLoading || undefined}
      className={cn(
        baseClassName,
        variantClassNames[variant],
        sizeClassNames[size ?? inheritedSize],
        className,
      )}
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
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export function ButtonLink({
  children,
  className,
  href,
  size,
  variant = "primary",
  ...props
}: ButtonLinkProps) {
  const inheritedSize = useContext(ButtonSizeContext);

  return (
    <Link
      className={cn(
        baseClassName,
        variantClassNames[variant],
        sizeClassNames[size ?? inheritedSize],
        className,
      )}
      href={href}
      {...props}
    >
      {children}
    </Link>
  );
}
