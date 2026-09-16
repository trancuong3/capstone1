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

interface ModalProps {
  children: ReactNode;
  closeOnEscape?: boolean;
  isOpen: boolean;
  onClose: () => void;
  showCloseButton?: boolean;
  title: string;
}

export function Modal({
  children,
  closeOnEscape = true,
  isOpen,
  onClose,
  showCloseButton = true,
  title,
}: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    return () => previouslyFocused?.focus();
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && closeOnEscape) {
      onClose();
      return;
    }

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 p-4">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-[620px] overflow-y-auto rounded-card bg-cream p-4 outline-none sm:p-8"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <h2 className="text-heading font-extrabold text-ink" id={titleId}>
            {title}
          </h2>
          {showCloseButton ? (
            <Button
              aria-label="Đóng hộp thoại"
              className="size-12 shrink-0 p-0"
              onClick={onClose}
              variant="quiet"
            >
              <X aria-hidden="true" className="size-6" />
            </Button>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}
