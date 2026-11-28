"use client";

import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";

import { cn } from "@/lib/utils/cn";

export interface ModalProps {
  children: ReactNode;
  closeOnBackdropClick?: boolean;
  closeOnEscape?: boolean;
  footer?: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  role?: "dialog" | "alertdialog";
  showCloseButton?: boolean;
  title: string;
  tone?: "cream" | "paper";
}

let activeModalLocks = 0;
let previousBodyOverflow: string | null = null;

function lockBodyScroll() {
  if (typeof document === "undefined") return;
  if (activeModalLocks === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  activeModalLocks += 1;
}

function unlockBodyScroll() {
  if (typeof document === "undefined") return;
  activeModalLocks = Math.max(0, activeModalLocks - 1);
  if (activeModalLocks === 0) {
    document.body.style.overflow = previousBodyOverflow ?? "";
    previousBodyOverflow = null;
  }
}

export function Modal({
  children,
  closeOnBackdropClick = false,
  closeOnEscape = true,
  footer,
  isOpen,
  onClose,
  role = "dialog",
  showCloseButton = true,
  title,
  tone = "cream",
}: ModalProps) {
  const tA11y = useTranslations("accessibility");
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    lockBodyScroll();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus({ preventScroll: true });

    return () => {
      unlockBodyScroll();
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !closeOnEscape) {
      return;
    }

    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    }

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [closeOnEscape, isOpen]);

  if (!isOpen) {
    return null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || !dialogRef.current) {
      return;
    }

    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );

    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (document.activeElement === dialogRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const surfaceClass = tone === "paper" ? "bg-white" : "bg-cream";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/35 p-0 sm:items-center sm:p-4"
      data-modal-backdrop="true"
      onClick={(event) => {
        if (closeOnBackdropClick && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(
          "flex max-h-[88dvh] w-full max-w-[640px] flex-col overflow-hidden rounded-t-[20px] rounded-b-none shadow-xl outline-none sm:max-h-[calc(100dvh-2rem)] sm:rounded-card",
          surfaceClass,
        )}
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role={role}
        tabIndex={-1}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-border sm:hidden"
        />
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:items-start sm:gap-4 sm:px-8 sm:py-6">
          <h2
            className={cn(
              "min-w-0 break-words",
              tone === "paper"
                ? "text-lg font-extrabold text-ink sm:text-2xl"
                : "text-lg font-extrabold text-ink sm:text-heading sm:font-semibold",
            )}
            id={titleId}
          >
            {title}
          </h2>
          {showCloseButton ? (
            <Button
              aria-label={tA11y("closeDialog")}
              className="size-11! shrink-0 p-0! sm:size-12!"
              fullWidth={false}
              onClick={onClose}
              variant="quiet"
            >
              <X aria-hidden="true" className="size-6" />
            </Button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3.5 sm:px-8 sm:py-6">
          {children}
        </div>
        {footer ? (
          <div
            className={cn(
              "shrink-0 border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-8 sm:py-4 sm:pb-4",
              surfaceClass,
            )}
            data-modal-footer="true"
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
