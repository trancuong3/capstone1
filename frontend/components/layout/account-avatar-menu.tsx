"use client";

import {
  CircleHelp,
  LogOut,
  Settings,
  UserRound,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

interface AccountAvatarMenuProps {
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: string | null;
  readonly isSigningOut: boolean;
  readonly onSignOut: () => void;
}

const itemSelector =
  'a[role="menuitem"], button[role="menuitem"]:not([disabled])';

export function AccountAvatarMenu({
  displayName,
  email,
  role,
  isSigningOut,
  onSignOut,
}: AccountAvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const identity = displayName?.trim() || email?.trim() || "";
  const initial = Array.from(identity)[0]?.toLocaleUpperCase("vi-VN") || "?";
  const accountLabel = displayName?.trim() || email || "Tài khoản ViRead";

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const focusItem = useCallback((index: number) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [],
    );
    if (!items.length) return;
    items[Math.max(0, Math.min(index, items.length - 1))]?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    focusItem(0);

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        close();
      }
    }

    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [open, close, focusItem]);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(current < 0 ? 0 : (current + 1) % items.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(
          current < 0
            ? items.length - 1
            : (current - 1 + items.length) % items.length,
        );
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(items.length - 1);
        break;
    }
  }

  return (
    <div className="relative z-40 shrink-0" ref={rootRef}>
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Mở menu tài khoản"
        className="flex size-11 items-center justify-center rounded-full border-2 border-primary/20 bg-sky text-base font-extrabold text-primary transition-colors hover:border-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60 sm:size-12"
        disabled={isSigningOut}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true">{initial}</span>
      </button>

      {open ? (
        <div
          aria-label="Menu tài khoản ViRead"
          className="absolute right-0 top-full mt-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-border bg-white shadow-xl"
          id={menuId}
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
          role="menu"
        >
          <div className="flex items-center gap-3 border-b border-border p-4">
            <div
              aria-hidden="true"
              className="flex size-12 shrink-0 items-center justify-center rounded-full bg-sky text-lg font-extrabold text-primary"
            >
              {initial}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-extrabold text-ink">
                {accountLabel}
              </p>
              {email ? (
                <p className="mt-0.5 break-all text-xs text-muted">{email}</p>
              ) : null}
              {role ? (
                <p className="mt-1 text-xs font-semibold text-primary">{role}</p>
              ) : null}
            </div>
          </div>

          <div className="p-2">
            <p className="px-3 pb-1 pt-2 text-[11px] font-extrabold uppercase tracking-wider text-muted">
              Hồ sơ
            </p>
            <Link
              className="flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink outline-none hover:bg-sky focus-visible:ring-2 focus-visible:ring-primary"
              href="/profile"
              onClick={() => close()}
              role="menuitem"
              tabIndex={-1}
            >
              <UserRound aria-hidden="true" className="size-4 text-primary" />
              Hồ sơ ba mẹ
            </Link>
            <Link
              className="flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink outline-none hover:bg-sky focus-visible:ring-2 focus-visible:ring-primary"
              href="/children"
              onClick={() => close()}
              role="menuitem"
              tabIndex={-1}
            >
              <UsersRound aria-hidden="true" className="size-4 text-primary" />
              Hồ sơ bé
            </Link>
          </div>

          <div
            aria-orientation="horizontal"
            className="border-t border-border"
            role="separator"
          />

          <div className="p-2">
            <p className="px-3 pb-1 pt-2 text-[11px] font-extrabold uppercase tracking-wider text-muted">
              Tài khoản
            </p>
            <Link
              className="flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink outline-none hover:bg-sky focus-visible:ring-2 focus-visible:ring-primary"
              href="/settings"
              onClick={() => close()}
              role="menuitem"
              tabIndex={-1}
            >
              <Settings aria-hidden="true" className="size-4 text-primary" />
              Cài đặt
            </Link>
          </div>

          <div
            aria-orientation="horizontal"
            className="border-t border-border"
            role="separator"
          />

          <div className="p-2">
            <p className="px-3 pb-1 pt-2 text-[11px] font-extrabold uppercase tracking-wider text-muted">
              Trợ giúp
            </p>
            <Link
              className="flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink outline-none hover:bg-sky focus-visible:ring-2 focus-visible:ring-primary"
              href="/help-support"
              onClick={() => close()}
              role="menuitem"
              tabIndex={-1}
            >
              <CircleHelp aria-hidden="true" className="size-4 text-primary" />
              Trợ giúp & hỗ trợ
            </Link>
          </div>

          <div
            aria-orientation="horizontal"
            className="border-t border-border"
            role="separator"
          />

          <div className="p-2">
            <p className="px-3 pb-1 pt-2 text-[11px] font-extrabold uppercase tracking-wider text-muted">
              Phiên đăng nhập
            </p>
            <button
              className="flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-left text-sm font-semibold text-danger outline-none hover:bg-danger-surface focus-visible:ring-2 focus-visible:ring-danger disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSigningOut}
              onClick={() => {
                close();
                onSignOut();
              }}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              <LogOut aria-hidden="true" className="size-4" />
              {isSigningOut ? "Đang đăng xuất…" : "Đăng xuất"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
