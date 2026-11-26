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

export function ButtonSizeProvider({
  children,
  size,
}: {
  children: ReactNode;
  size: ButtonSize;
}) {
  return (
    <ButtonSizeContext.Provider value={size}>
      {children}
    </ButtonSizeContext.Provider>
  );
}

const baseClassName =
  "inline-flex items-center justify-center gap-2 rounded-control px-4 py-2 text-center text-button font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-55";

const explicitWidthClassPattern =
  /(?:^|\s)(?:(?:sm|md|lg|xl|2xl|max-(?:sm|md|lg|xl|2xl)|min-\[[^\]]+\]|max-\[[^\]]+\]):(?:w-full|w-(?:auto|fit|min|max|px|screen|dvw|svw|lvw|prose|3xs|2xs|xs|\d+(?:\/\d+|\.\d+)?|\[[^\]]+\])|size-\S+)|w-(?:auto|fit|min|max|px|screen|dvw|svw|lvw|prose|3xs|2xs|xs|\d+(?:\/\d+|\.\d+)?|\[[^\]]+\])|size-\S+)!?(?=\s|$)/;

function resolveWidthClassName(
  fullWidth: boolean | undefined,
  className: string | undefined,
): string | undefined {
  if (fullWidth === false) return "w-auto";
  if (fullWidth === true) return "w-full";
  if (className && explicitWidthClassPattern.test(className)) {
    return undefined;
  }
  return "w-full";
}

const variantClassNames: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "bg-sky text-primary-hover hover:bg-border",
  quiet: "bg-white text-ink hover:bg-sky",
  destructive: "bg-danger text-white hover:opacity-90",
};

const sizeClassNames: Record<ButtonSize, string> = {
  default: "min-h-14",
  compact: "min-h-12 px-4 py-2.5 text-label leading-5",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  fullWidth?: boolean;
  isLoading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export function Button({
  children,
  className,
  disabled,
  fullWidth,
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
        resolveWidthClassName(fullWidth, className),
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

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children: ReactNode;
  fullWidth?: boolean;
  href: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export function ButtonLink({
  children,
  className,
  fullWidth,
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
        resolveWidthClassName(fullWidth, className),
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
