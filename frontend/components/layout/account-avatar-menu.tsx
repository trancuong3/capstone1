"use client";

import {
  ChevronRight,
  CircleHelp,
  Globe,
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

import { InlineLanguagePanel } from "@/components/i18n/inline-language-panel";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

interface AccountAvatarMenuProps {
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: string | null;
  readonly isSigningOut: boolean;
  readonly onSignOut: () => void;
}

const itemSelector =
  'a[role="menuitem"], button[role="menuitem"]:not([disabled])';

type AvatarMenuView = "main" | "language";

export function AccountAvatarMenu({
  displayName,
  email,
  role,
  isSigningOut,
  onSignOut,
}: AccountAvatarMenuProps) {
  const { metadata, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AvatarMenuView>("main");
  const [returningFromLanguage, setReturningFromLanguage] = useState(false);
  const [languageOpenedByKeyboard, setLanguageOpenedByKeyboard] =
    useState(false);
  const [languageAnnouncement, setLanguageAnnouncement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const languageTriggerRef = useRef<HTMLButtonElement>(null);
  const openedFreshRef = useRef(false);
  const restoreLanguageFocusRef = useRef(false);
  const menuId = useId();
  const languagePanelId = useId();
  const languageTitleId = useId();
  const identity = displayName?.trim() || email?.trim() || "";
  const initial =
    Array.from(identity)[0]?.toLocaleUpperCase(metadata.bcp47) || "?";
  const accountLabel =
    displayName?.trim() ||
    email ||
    t("navigation.accountMenu.defaultAccountLabel");

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setView("main");
    setReturningFromLanguage(false);
    setLanguageOpenedByKeyboard(false);
    openedFreshRef.current = false;
    restoreLanguageFocusRef.current = false;
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openLanguageView = useCallback((byKeyboard: boolean) => {
    openedFreshRef.current = false;
    restoreLanguageFocusRef.current = false;
    setLanguageOpenedByKeyboard(byKeyboard);
    setReturningFromLanguage(false);
    setView("language");
  }, []);

  const handleBackToMain = useCallback(
    (options?: { readonly restoreFocus?: boolean }) => {
      openedFreshRef.current = false;
      restoreLanguageFocusRef.current = options?.restoreFocus ?? true;
      setLanguageOpenedByKeyboard(false);
      setReturningFromLanguage(true);
      setView("main");
    },
    [],
  );

  const focusItem = useCallback((index: number) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? [],
    );
    if (!items.length) return;
    items[Math.max(0, Math.min(index, items.length - 1))]?.focus();
  }, []);

  useEffect(() => {
    if (!open || view !== "main") return;
    if (restoreLanguageFocusRef.current) {
      restoreLanguageFocusRef.current = false;
      languageTriggerRef.current?.focus();
      return;
    }
    if (openedFreshRef.current) {
      openedFreshRef.current = false;
      focusItem(0);
    }
  }, [focusItem, open, view]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        close();
      }
    }

    function handleDocumentKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (view === "language") {
        handleBackToMain({ restoreFocus: true });
        return;
      }
      close(true);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [close, handleBackToMain, open, view]);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (view !== "main") return;
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
      <span
        aria-live="polite"
        className="sr-only"
        role={languageAnnouncement ? "status" : undefined}
      >
        {languageAnnouncement}
      </span>

      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("navigation.accountMenu.openAria")}
        className={cn(
          "flex size-11 items-center justify-center rounded-full border-2 bg-sky text-base font-semibold text-primary transition-all focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60 sm:size-12",
          open
            ? "border-primary ring-4 ring-sky/80"
            : "border-primary/20 hover:border-primary",
        )}
        disabled={isSigningOut}
        onClick={() => {
          if (open) {
            close();
          } else {
            openedFreshRef.current = true;
            setView("main");
            setReturningFromLanguage(false);
            setOpen(true);
          }
        }}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true">{initial}</span>
      </button>

      {open ? (
        <div
          aria-label={
            view === "main" ? t("navigation.accountMenu.menuAria") : undefined
          }
          aria-labelledby={view === "language" ? languageTitleId : undefined}
          className={cn(
            "avatar-menu-enter absolute end-0 top-full z-50 mt-2.5 flex w-[min(21rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-border/80 bg-white shadow-[0_20px_44px_-14px_rgba(35,62,64,0.18),0_4px_14px_-2px_rgba(35,62,64,0.06)] ring-1 ring-ink/[0.06]",
            view === "language"
              ? "max-h-[min(calc(100dvh-9.5rem),540px)] xl:max-h-[min(calc(100dvh-5.5rem),560px)]"
              : "max-h-[min(calc(100dvh-9.5rem),580px)] xl:max-h-[min(calc(100dvh-5.5rem),640px)]",
          )}
          id={menuId}
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
          role={view === "language" ? "dialog" : "menu"}
        >
          {view === "language" ? (
            <InlineLanguagePanel
              id={languagePanelId}
              onAnnouncement={setLanguageAnnouncement}
              onBack={handleBackToMain}
              openedByKeyboard={languageOpenedByKeyboard}
              titleId={languageTitleId}
            />
          ) : (
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                returningFromLanguage && "avatar-menu-view-back",
              )}
            >
              {/* Pinned Profile Bookplate Header */}
              <div className="flex shrink-0 items-center gap-3 border-b border-border/75 bg-sky/40 px-3.5 py-2.5">
                <div
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sky text-base font-bold text-primary ring-2 ring-white shadow-xs"
                >
                  {initial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-[15px] font-extrabold leading-snug text-ink">
                      {accountLabel}
                    </p>
                    {role ? (
                      <span className="inline-flex shrink-0 items-center rounded-full border border-primary/20 bg-white/90 px-2 py-0.5 text-[11px] font-bold text-primary-hover">
                        {role}
                      </span>
                    ) : null}
                  </div>
                  {email ? (
                    <p
                      className="mt-0.5 truncate text-xs text-muted"
                      title={email}
                    >
                      {email}
                    </p>
                  ) : null}
                </div>
              </div>

              {/* Single Scrollable Menu Body */}
              <div className="avatar-menu-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain p-2">
                <div>
                  <p className="px-2.5 pb-0.5 pt-0.5 text-xs font-bold text-muted">
                    {t("navigation.accountMenu.profileSection")}
                  </p>
                  <div className="space-y-0.5">
                    <Link
                      className="flex min-h-11 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm font-semibold text-ink transition-colors outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 sm:min-h-[38px]"
                      href="/profile"
                      onClick={() => close()}
                      role="menuitem"
                      tabIndex={-1}
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-primary sm:size-7"
                      >
                        <UserRound className="size-4" />
                      </span>
                      <span className="truncate">
                        {t("navigation.parent.parentProfile")}
                      </span>
                    </Link>
                    <Link
                      className="flex min-h-11 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm font-semibold text-ink transition-colors outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 sm:min-h-[38px]"
                      href="/children"
                      onClick={() => close()}
                      role="menuitem"
                      tabIndex={-1}
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-primary sm:size-7"
                      >
                        <UsersRound className="size-4" />
                      </span>
                      <span className="truncate">
                        {t("navigation.parent.children")}
                      </span>
                    </Link>
                  </div>
                </div>

                <div
                  aria-orientation="horizontal"
                  className="border-t border-border/65"
                  role="separator"
                />

                <div>
                  <p className="px-2.5 pb-0.5 pt-0.5 text-xs font-bold text-muted">
                    {t("navigation.accountMenu.accountSection")}
                  </p>
                  <div className="space-y-0.5">
                    <Link
                      className="flex min-h-11 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm font-semibold text-ink transition-colors outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 sm:min-h-[38px]"
                      href="/settings"
                      onClick={() => close()}
                      role="menuitem"
                      tabIndex={-1}
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-muted sm:size-7"
                      >
                        <Settings className="size-4" />
                      </span>
                      <span className="truncate">
                        {t("navigation.parent.settings")}
                      </span>
                    </Link>
                    <Link
                      className="flex min-h-11 items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm font-semibold text-ink transition-colors outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 sm:min-h-[38px]"
                      href="/help-support"
                      onClick={() => close()}
                      role="menuitem"
                      tabIndex={-1}
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-muted sm:size-7"
                      >
                        <CircleHelp className="size-4" />
                      </span>
                      <span className="truncate">
                        {t("navigation.parent.helpSupport")}
                      </span>
                    </Link>

                    <div data-variant="menu">
                      <button
                        aria-controls={languagePanelId}
                        aria-expanded={false}
                        aria-haspopup="dialog"
                        aria-label={t(
                          "common.languageSelector.buttonAriaLabel",
                          {
                            language: metadata.nativeName,
                          },
                        )}
                        className="group flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-start text-sm font-semibold text-ink transition-colors outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 sm:min-h-[38px]"
                        onClick={(event) =>
                          openLanguageView(event.detail === 0)
                        }
                        ref={languageTriggerRef}
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky/80 text-primary transition-colors group-hover:bg-sky sm:size-7"
                        >
                          <Globe className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {t("common.languageSelector.label")}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="max-w-[8rem] truncate rounded-full border border-primary/20 bg-sky/65 px-2.5 py-0.5 text-xs font-bold text-primary-hover">
                            {metadata.nativeName}
                          </span>
                          <ChevronRight
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted transition-transform ltr:group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5 viread-rtl-flip"
                          />
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Pinned Sign-Out Footer */}
              <div className="shrink-0 border-t border-border/75 bg-cream/80 p-1.5">
                <button
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-start text-sm font-semibold text-danger transition-colors outline-none hover:bg-danger-surface focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-[38px]"
                  disabled={isSigningOut}
                  onClick={() => {
                    close();
                    onSignOut();
                  }}
                  role="menuitem"
                  tabIndex={-1}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-danger-surface text-danger sm:size-7"
                  >
                    <LogOut className="size-4 viread-rtl-flip" />
                  </span>
                  <span className="truncate">
                    {isSigningOut
                      ? t("auth.session.signingOut")
                      : t("auth.session.signOut")}
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
