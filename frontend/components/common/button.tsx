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

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "quiet"
  | "destructive"
  | "outline"
  | "destructive-outline";
export type ButtonSize = "default" | "compact" | "touch" | "icon" | "admin";

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
  "inline-flex items-center justify-center gap-2 rounded-control text-center font-bold transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-55";

const explicitWidthClassPattern =
  /(?:^|\s)(?:w-(?:auto|fit|min|max|\d+|\[.+?\])!?|(?:sm|md|lg|xl):w-\S+|size-\S+)/;
const explicitHeightClassPattern = /(?:^|\s)(?:min-h-|h-|size-)\S+/;
const explicitPaddingClassPattern = /(?:^|\s)p(?:[xytrblse])?-\S+/;
const explicitTextSizeClassPattern =
  /(?:^|\s)text-(?:xs|sm|base|lg|xl|\d|button|label|heading|\[)\S*/;

function resolveWidthClassName(
  fullWidth: boolean | undefined,
  className: string | undefined,
  resolvedSize: ButtonSize,
  inheritedSize: ButtonSize,
): string | undefined {
  if (fullWidth === false) return "w-auto";
  if (fullWidth === true) return "w-full";
  if (resolvedSize === "icon") return undefined;
  if (className && explicitWidthClassPattern.test(className)) {
    return undefined;
  }
  if (resolvedSize === "admin" || inheritedSize === "admin") {
    return "w-auto";
  }
  return "w-full";
}

const variantClassNames: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "bg-sky text-primary-hover hover:bg-border",
  quiet: "bg-white text-ink hover:bg-sky",
  destructive: "bg-danger text-white hover:opacity-90",
  outline: "border border-border bg-white text-ink hover:bg-canvas",
  "destructive-outline":
    "border border-danger/30 bg-white text-danger hover:bg-danger-surface",
};

const sizeClassParts: Record<
  ButtonSize,
  { readonly height: string; readonly padding: string; readonly text: string }
> = {
  default: {
    height: "min-h-14",
    padding: "px-4 py-2",
    text: "text-button",
  },
  compact: {
    height: "min-h-12",
    padding: "px-4 py-2.5",
    text: "text-label leading-5",
  },
  touch: {
    height: "min-h-11",
    padding: "px-3.5 py-2",
    text: "text-sm leading-5",
  },
  icon: {
    height: "size-11 sm:size-12",
    padding: "p-0",
    text: "text-label",
  },
  admin: {
    height: "min-h-11 sm:min-h-10",
    padding: "px-3 py-1.5",
    text: "text-sm leading-5",
  },
};

function resolveSizeClassName(
  resolvedSize: ButtonSize,
  className: string | undefined,
): string {
  const parts = sizeClassParts[resolvedSize];
  const hasExplicitHeight =
    Boolean(className) && explicitHeightClassPattern.test(className ?? "");
  const hasExplicitPadding =
    Boolean(className) && explicitPaddingClassPattern.test(className ?? "");
  const hasExplicitTextSize =
    Boolean(className) && explicitTextSizeClassPattern.test(className ?? "");

  return cn(
    !hasExplicitHeight && parts.height,
    !hasExplicitPadding && parts.padding,
    !hasExplicitTextSize && parts.text,
  );
}

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
  const resolvedSize = size ?? inheritedSize;

  return (
    <button
      aria-busy={isLoading || undefined}
      className={cn(
        baseClassName,
        resolveWidthClassName(
          fullWidth,
          className,
          resolvedSize,
          inheritedSize,
        ),
        variantClassNames[variant],
        resolveSizeClassName(resolvedSize, className),
        className,
      )}
      disabled={disabled || isLoading}
      type={type}
      {...props}
    >
      {isLoading ? (
        <LoaderCircle
          aria-hidden="true"
          className={cn(
            "animate-spin",
            resolvedSize === "admin" || resolvedSize === "touch"
              ? "size-4"
              : "size-5",
          )}
        />
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
  const resolvedSize = size ?? inheritedSize;

  return (
    <Link
      className={cn(
        baseClassName,
        resolveWidthClassName(
          fullWidth,
          className,
          resolvedSize,
          inheritedSize,
        ),
        variantClassNames[variant],
        resolveSizeClassName(resolvedSize, className),
        className,
      )}
      href={href}
      {...props}
    >
      {children}
    </Link>
  );
}
