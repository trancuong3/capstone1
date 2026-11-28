"use client";

import {
  BookOpenCheck,
  CalendarClock,
  Check,
  ChevronRight,
  CircleHelp,
  Globe,
  History,
  LogOut,
  Mic,
  Settings,
  Sparkles,
  UserRound,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { ProfileAvatar } from "@/components/common/profile-avatar";
import { InlineLanguagePanel } from "@/components/i18n/inline-language-panel";
import type { AppStore } from "@/components/providers/app-store-provider";
import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";

const TASK_LAST_SEEN_KEY_PREFIX = "viread_tasks_last_seen:";

function readLastSeenTimestamp(userId: string | null): number {
  if (!userId || typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(
      `${TASK_LAST_SEEN_KEY_PREFIX}${userId}`,
    );
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeLastSeenTimestamp(userId: string | null, value: number): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${TASK_LAST_SEEN_KEY_PREFIX}${userId}`,
      String(value),
    );
  } catch {
    // Ignore storage quota / privacy mode errors.
  }
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "");
  }
  return pathname;
}

function isRouteActive(pathname: string, href: string): boolean {
  const normalized = normalizePath(pathname);
  return normalized === href || normalized.startsWith(`${href}/`);
}

export interface ParentAccountDropdownProps {
  readonly userId: string | null;
  readonly pathname: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly avatarUrl: string | null | undefined;
  readonly roleLabel: string | null;
  readonly availableChildren: readonly ChildProfileDTO[];
  readonly selectedChild: ChildProfileDTO | null;
  readonly appStore: AppStore | null;
  readonly isSigningOut: boolean;
  readonly onSignOut: () => Promise<void>;
  readonly onBeforeOpen?: () => void;
  readonly hideAiTasks?: boolean;
}

const GUIDE_STEPS = [
  { key: "1", href: "/children" },
  { key: "2", href: "/my-books" },
  { key: "3", href: "/device-permissions" },
  { key: "4", href: "/reports/difficult-words" },
  { key: "5", href: "/reading-management" },
] as const;

type DropdownView = "main" | "language";

export function ParentAccountDropdown({
  userId,
  pathname,
  displayName,
  email,
  avatarUrl,
  roleLabel,
  availableChildren,
  selectedChild,
  appStore,
  isSigningOut,
  onSignOut,
  onBeforeOpen,
  hideAiTasks = false,
}: ParentAccountDropdownProps) {
  const { metadata, t } = useI18n();
  const taskCenter = useOptionalAiTaskCenter();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const languageTriggerRef = useRef<HTMLButtonElement>(null);
  const openedByKeyboardRef = useRef(false);
  const languageOpenedByKeyboardRef = useRef(false);
  const restoreLanguageFocusRef = useRef(false);
  const languagePanelId = useId();

  const [menuState, setMenuState] = useState<{
    readonly isOpen: boolean;
    readonly pathname: string;
    readonly view: DropdownView;
    readonly returningFromLanguage: boolean;
  }>({
    isOpen: false,
    pathname: "",
    view: "main",
    returningFromLanguage: false,
  });
  const [guideOpen, setGuideOpen] = useState(false);
  const [languageAnnouncement, setLanguageAnnouncement] = useState("");
  const [seenState, setSeenState] = useState<{
    readonly userId: string | null;
    readonly ms: number;
  }>({ userId: null, ms: 0 });

  const isOpen = menuState.isOpen && menuState.pathname === pathname;
  const activeView: DropdownView = isOpen ? menuState.view : "main";
  const lastSeenTaskMs =
    seenState.userId === userId ? seenState.ms : readLastSeenTimestamp(userId);

  const activeCount = taskCenter?.activeCount ?? 0;
  const waitingReviewCount = taskCenter?.waitingReviewCount ?? 0;
  const failedCount = taskCenter?.failedCount ?? 0;

  const { newlyCompletedCount, latestTaskTimestampMs } = useMemo(() => {
    const taskList = taskCenter?.tasks ?? [];
    let newest = 0;
    let newlyDone = 0;
    for (const task of taskList) {
      const ts = Date.parse(
        task.updated_at || task.completed_at || task.created_at,
      );
      if (Number.isFinite(ts) && ts > newest) {
        newest = ts;
      }
      if (
        (task.status === "SUCCEEDED" || task.status === "PARTIAL_SUCCESS") &&
        Number.isFinite(ts) &&
        ts > lastSeenTaskMs
      ) {
        newlyDone += 1;
      }
    }
    return {
      newlyCompletedCount: newlyDone,
      latestTaskTimestampMs: newest,
    };
  }, [lastSeenTaskMs, taskCenter?.tasks]);

  const hasRedAlert =
    !hideAiTasks &&
    (waitingReviewCount > 0 || failedCount > 0 || newlyCompletedCount > 0);
  const hasRunningActivity = !hideAiTasks && !hasRedAlert && activeCount > 0;

  const taskSummaryText = useMemo(() => {
    if (failedCount > 0) {
      return t("navigation.accountMenu.taskStatusFailed", {
        count: failedCount,
      });
    }
    if (waitingReviewCount > 0) {
      return t("navigation.accountMenu.taskStatusReview", {
        count: waitingReviewCount,
      });
    }
    if (activeCount > 0) {
      return t("navigation.accountMenu.taskStatusRunning", {
        count: activeCount,
      });
    }
    if (newlyCompletedCount > 0) {
      return t("navigation.accountMenu.taskStatusNewDone", {
        count: newlyCompletedCount,
      });
    }
    return t("navigation.accountMenu.taskStatusIdle");
  }, [activeCount, failedCount, newlyCompletedCount, t, waitingReviewCount]);

  const taskBadgeCount =
    failedCount > 0
      ? failedCount
      : waitingReviewCount > 0
        ? waitingReviewCount
        : newlyCompletedCount > 0
          ? newlyCompletedCount
          : activeCount > 0
            ? activeCount
            : 0;

  const closeMenu = useCallback(() => {
    openedByKeyboardRef.current = false;
    languageOpenedByKeyboardRef.current = false;
    restoreLanguageFocusRef.current = false;
    setMenuState((current) => ({
      ...current,
      isOpen: false,
      view: "main",
      returningFromLanguage: false,
    }));
  }, []);

  const openLanguageView = useCallback((byKeyboard: boolean) => {
    languageOpenedByKeyboardRef.current = byKeyboard;
    restoreLanguageFocusRef.current = false;
    setMenuState((current) => ({
      ...current,
      view: "language",
      returningFromLanguage: false,
    }));
  }, []);

  const handleBackToMain = useCallback(
    (options?: { readonly restoreFocus?: boolean }) => {
      restoreLanguageFocusRef.current = options?.restoreFocus ?? true;
      languageOpenedByKeyboardRef.current = false;
      setMenuState((current) => ({
        ...current,
        view: "main",
        returningFromLanguage: true,
      }));
    },
    [],
  );

  const markTasksSeen = useCallback(() => {
    const seenAt = Math.max(Date.now(), latestTaskTimestampMs);
    setSeenState({ userId, ms: seenAt });
    writeLastSeenTimestamp(userId, seenAt);
  }, [latestTaskTimestampMs, userId]);

  const handleOpenAiTasks = useCallback(() => {
    markTasksSeen();
    closeMenu();
    taskCenter?.openPanel();
  }, [closeMenu, markTasksSeen, taskCenter]);

  // Restore focus cleanly when returning from Language view, or focus the first
  // menuitem only when opened via keyboard so mouse clicks avoid a focus ring.
  useEffect(() => {
    if (!isOpen || activeView !== "main") return;

    if (restoreLanguageFocusRef.current) {
      restoreLanguageFocusRef.current = false;
      languageTriggerRef.current?.focus();
      return;
    }

    if (openedByKeyboardRef.current) {
      openedByKeyboardRef.current = false;
      containerRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
        ?.focus();
    }
  }, [activeView, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        closeMenu();
      }
    }

    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (activeView === "language") {
        handleBackToMain({ restoreFocus: true });
        return;
      }
      closeMenu();
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [activeView, closeMenu, handleBackToMain, isOpen]);

  function handleTriggerClick(event: MouseEvent<HTMLButtonElement>) {
    onBeforeOpen?.();
    if (isOpen) {
      closeMenu();
      return;
    }
    // Keyboard activation via Enter/Space reports event.detail === 0.
    openedByKeyboardRef.current = event.detail === 0;
    restoreLanguageFocusRef.current = false;
    setMenuState({
      isOpen: true,
      pathname,
      view: "main",
      returningFromLanguage: false,
    });
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" && !isOpen) {
      event.preventDefault();
      onBeforeOpen?.();
      openedByKeyboardRef.current = true;
      restoreLanguageFocusRef.current = false;
      setMenuState({
        isOpen: true,
        pathname,
        view: "main",
        returningFromLanguage: false,
      });
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (activeView !== "main") {
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    const items = containerRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    );
    if (!items?.length) return;

    event.preventDefault();
    const currentIndex = Array.from(items).indexOf(
      document.activeElement as HTMLElement,
    );
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? currentIndex < 0
              ? 0
              : (currentIndex + 1) % items.length
            : currentIndex < 0
              ? items.length - 1
              : (currentIndex - 1 + items.length) % items.length;

    items[nextIndex]?.focus();
  }

  const menuItemClass = (active = false) =>
    cn(
      "group flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
      active ? "bg-sky/75 text-primary-hover" : "text-ink hover:bg-canvas",
    );

  const iconTileClass = (active: boolean, tintClass: string) =>
    cn(
      "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
      active ? "bg-white text-primary shadow-2xs" : tintClass,
    );

  const readingManagementActive = isRouteActive(
    pathname,
    "/reading-management",
  );
  const sessionsActive = isRouteActive(pathname, "/sessions");
  const profileActive = isRouteActive(pathname, "/profile");
  const childrenActive = isRouteActive(pathname, "/children");
  const devicePermissionsActive = isRouteActive(
    pathname,
    "/device-permissions",
  );
  const settingsActive = isRouteActive(pathname, "/settings");
  const helpSupportActive = isRouteActive(pathname, "/help-support");

  return (
    <>
      <div className="relative shrink-0" ref={containerRef}>
        <span
          aria-live="polite"
          className="sr-only"
          role={languageAnnouncement ? "status" : undefined}
        >
          {languageAnnouncement}
        </span>

        <button
          aria-controls="parent-account-menu"
          aria-expanded={isOpen}
          aria-haspopup="menu"
          aria-label={
            isOpen
              ? t("navigation.accountMenu.closeAria")
              : t("navigation.accountMenu.openAria")
          }
          className={cn(
            "relative flex size-12 items-center justify-center rounded-full border-2 bg-white p-0.5 shadow-xs transition-all focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
            isOpen
              ? "border-primary ring-4 ring-sky/80"
              : "border-border/85 hover:border-primary/65 hover:shadow-sm",
          )}
          onClick={handleTriggerClick}
          onKeyDown={handleTriggerKeyDown}
          ref={triggerRef}
          title={
            hasRedAlert
              ? t("navigation.accountMenu.unreadBadgeAria")
              : hasRunningActivity
                ? t("navigation.accountMenu.runningBadgeAria")
                : undefined
          }
          type="button"
        >
          <ProfileAvatar
            ariaLabel={t("accessibility.accountAvatar")}
            displayName={displayName}
            imageUrl={avatarUrl}
            size="sm"
          />
          {hasRedAlert ? (
            <span
              className="pointer-events-none absolute -end-0.5 -top-0.5 flex size-3.5 items-center justify-center"
              data-testid="avatar-notification-dot"
            >
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex size-3 rounded-full bg-rose-500 ring-2 ring-white" />
              <span className="sr-only">
                {t("navigation.accountMenu.unreadBadgeAria")}
              </span>
            </span>
          ) : hasRunningActivity ? (
            <span
              className="pointer-events-none absolute -end-0.5 -top-0.5 flex size-3.5 items-center justify-center"
              data-testid="avatar-running-dot"
            >
              <span className="relative inline-flex size-3 animate-pulse rounded-full bg-primary ring-2 ring-white" />
              <span className="sr-only">
                {t("navigation.accountMenu.runningBadgeAria")}
              </span>
            </span>
          ) : null}
        </button>

        {isOpen ? (
          <div
            aria-label={t("navigation.accountMenu.shortMenuAria")}
            className="avatar-menu-enter absolute end-0 top-full z-50 mt-2.5 flex max-h-[min(calc(100dvh-10rem),660px)] w-[min(22.5rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-border/90 bg-white shadow-[0_20px_44px_-14px_rgba(35,62,64,0.20),0_4px_14px_-2px_rgba(35,62,64,0.08)] xl:max-h-[min(calc(100dvh-5.5rem),680px)]"
            id="parent-account-menu"
            onKeyDown={handleMenuKeyDown}
            role="menu"
          >
            {activeView === "language" ? (
              <InlineLanguagePanel
                id={languagePanelId}
                onAnnouncement={setLanguageAnnouncement}
                onBack={handleBackToMain}
                openedByKeyboard={languageOpenedByKeyboardRef.current}
              />
            ) : (
              <div
                className={cn(
                  "flex min-h-0 flex-1 flex-col",
                  menuState.returningFromLanguage && "avatar-menu-view-back",
                )}
              >
                {/* Pinned Profile Bookplate Header */}
                <div className="flex shrink-0 items-center gap-3 border-b border-border/75 bg-sky/40 px-4 py-3.5">
                  <span className="shrink-0 rounded-full ring-2 ring-white shadow-xs">
                    <ProfileAvatar
                      ariaLabel={t("accessibility.accountAvatar")}
                      displayName={displayName}
                      imageUrl={avatarUrl}
                      size="md"
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-[15px] font-extrabold leading-snug text-ink">
                        {displayName ??
                          t("navigation.accountMenu.defaultAccountLabel")}
                      </p>
                      {roleLabel ? (
                        <span className="inline-flex shrink-0 items-center rounded-full border border-primary/20 bg-white/90 px-2 py-0.5 text-[11px] font-bold text-primary-hover">
                          {roleLabel}
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
                  {/* Quick Child Switcher */}
                  {availableChildren.length > 0 && appStore ? (
                    <div className="rounded-xl border border-border/70 bg-canvas/85 p-2.5">
                      <div className="flex items-center justify-between gap-2 px-0.5">
                        <p className="text-xs font-bold text-muted">
                          {t("navigation.accountMenu.quickChildTitle")}
                        </p>
                        <Link
                          className="shrink-0 rounded text-xs font-bold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                          href="/children"
                          onClick={closeMenu}
                        >
                          {t("navigation.childSwitcher.manageChildren")}
                        </Link>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {availableChildren.map((child) => {
                          const isSelected = selectedChild?.id === child.id;
                          return (
                            <button
                              aria-pressed={isSelected}
                              className={cn(
                                "inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
                                isSelected
                                  ? "border-primary bg-primary text-white shadow-2xs"
                                  : "border-border bg-white text-ink hover:border-primary/45 hover:bg-sky/40",
                              )}
                              key={child.id}
                              onClick={() => {
                                appStore.selectChild(child.id);
                                appStore.setValidatedSelectedChild(child);
                                closeMenu();
                              }}
                              type="button"
                            >
                              <span className="truncate">
                                {t("navigation.childSwitcher.compactLabel", {
                                  alias: child.alias,
                                  grade: child.grade,
                                })}
                              </span>
                              {isSelected ? (
                                <Check
                                  aria-hidden="true"
                                  className="size-3.5 shrink-0"
                                  strokeWidth={2.5}
                                />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Group 1: Activity & Utilities */}
                  <div>
                    <p className="px-2.5 pb-0.5 pt-1 text-xs font-bold text-muted">
                      {t("navigation.accountMenu.activitiesSection")}
                    </p>
                    <div className="space-y-0.5">
                      {!hideAiTasks && taskCenter?.scopeKey ? (
                        <button
                          className={menuItemClass(false)}
                          data-testid="menu-ai-tasks-trigger"
                          onClick={handleOpenAiTasks}
                          role="menuitem"
                          tabIndex={0}
                          type="button"
                        >
                          <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky/80 text-primary">
                            <Sparkles aria-hidden="true" className="size-4" />
                            {hasRedAlert ? (
                              <span
                                aria-hidden="true"
                                className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-rose-500 ring-2 ring-white"
                                data-testid="menu-ai-tasks-red-dot"
                              />
                            ) : hasRunningActivity ? (
                              <span
                                aria-hidden="true"
                                className="absolute -end-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-primary ring-2 ring-white"
                              />
                            ) : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate leading-tight">
                              {t("navigation.parent.aiTasksNotifications")}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] font-medium text-muted">
                              {taskSummaryText}
                            </span>
                          </span>
                          {taskBadgeCount > 0 ? (
                            <span
                              className={cn(
                                "inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-extrabold tabular-nums text-white",
                                hasRedAlert ? "bg-rose-500" : "bg-primary",
                              )}
                            >
                              {taskBadgeCount}
                            </span>
                          ) : null}
                        </button>
                      ) : null}

                      <Link
                        aria-current={
                          readingManagementActive ? "page" : undefined
                        }
                        className={menuItemClass(readingManagementActive)}
                        href="/reading-management"
                        onClick={closeMenu}
                        role="menuitem"
                        tabIndex={0}
                      >
                        <span
                          aria-hidden="true"
                          className={iconTileClass(
                            readingManagementActive,
                            "bg-book-orange/75 text-[#964623]",
                          )}
                        >
                          <CalendarClock className="size-4" />
                        </span>
                        <span className="truncate">
                          {t("navigation.parent.readingManagement")}
                        </span>
                      </Link>

                      <Link
                        aria-current={sessionsActive ? "page" : undefined}
                        className={menuItemClass(sessionsActive)}
                        href="/sessions"
                        onClick={closeMenu}
                        role="menuitem"
                        tabIndex={0}
                      >
                        <span
                          aria-hidden="true"
                          className={iconTileClass(
                            sessionsActive,
                            "bg-desk text-[#225c84]",
                          )}
                        >
                          <History className="size-4" />
                        </span>
                        <span className="truncate">
                          {t("navigation.parent.sessionsLong")}
                        </span>
                      </Link>
                    </div>
                  </div>

                  {/* Group 2: Account & Devices */}
                  <div
                    aria-orientation="horizontal"
                    className="border-t border-border/65"
                    role="separator"
                  />
                  <div>
                    <p className="px-2.5 pb-0.5 pt-0.5 text-xs font-bold text-muted">
                      {t("navigation.accountMenu.accountDeviceSection")}
                    </p>
                    <div className="space-y-0.5">
                      <Link
                        aria-current={profileActive ? "page" : undefined}
                        className={menuItemClass(profileActive)}
                        href="/profile"
                        onClick={closeMenu}
                        role="menuitem"
                        tabIndex={0}
                      >
                        <span
                          aria-hidden="true"
                          className={iconTileClass(
                            profileActive,
                            "bg-surface-subtle text-primary",
                          )}
                        >
                          <UserRound className="size-4" />
                        </span>
                        <span className="truncate">
                          {t("navigation.parent.parentProfile")}
                        </span>
                      </Link>

                      <Link
                        aria-current={childrenActive ? "page" : undefined}
                        className={menuItemClass(childrenActive)}
                        href="/children"
                        onClick={closeMenu}
                        role="menuitem"
                        tabIndex={0}
                      >
                        <span
                          aria-hidden="true"
                          className={iconTileClass(
                            childrenActive,
                            "bg-surface-subtle text-primary",
                          )}
                        >
                          <UsersRound className="size-4" />
                        </span>
                        <span className="truncate">
                          {t("navigation.parent.children")}
                        </span>
                      </Link>

                      <Link
                        aria-current={
                          devicePermissionsActive ? "page" : undefined
                        }
                        className={menuItemClass(devicePermissionsActive)}
                        href="/device-permissions"
                        onClick={closeMenu}
                        role="menuitem"
                        tabIndex={0}
                      >
                        <span
                          aria-hidden="true"
                          className={iconTileClass(
                            devicePermissionsActive,
                            "bg-surface-subtle text-primary",
                          )}
                        >
                          <Mic className="size-4" />
                        </span>
                        <span className="truncate">
                          {t("navigation.parent.devicePermissions")}
                        </span>
                      </Link>

                      <Link
                        aria-current={settingsActive ? "page" : undefined}
                        className={menuItemClass(settingsActive)}
                        href="/settings"
                        onClick={closeMenu}
                        role="menuitem"
                        tabIndex={0}
                      >
                        <span
                          aria-hidden="true"
                          className={iconTileClass(
                            settingsActive,
                            "bg-surface-subtle text-muted",
                          )}
                        >
                          <Settings className="size-4" />
                        </span>
                        <span className="truncate">
                          {t("navigation.parent.settings")}
                        </span>
                      </Link>

                      <div data-variant="menu">
                        <button
                          aria-controls={languagePanelId}
                          aria-expanded={false}
                          aria-haspopup="listbox"
                          aria-label={t(
                            "common.languageSelector.buttonAriaLabel",
                            {
                              language: metadata.nativeName,
                            },
                          )}
                          className="group flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start text-sm font-semibold text-ink transition-colors outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                          onClick={(event) =>
                            openLanguageView(event.detail === 0)
                          }
                          ref={languageTriggerRef}
                          type="button"
                        >
                          <span
                            aria-hidden="true"
                            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky/80 text-primary transition-colors group-hover:bg-sky"
                          >
                            <Globe className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {t("navigation.accountMenu.languageLabel")}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <span className="max-w-[8.25rem] truncate rounded-full border border-primary/20 bg-sky/65 px-2.5 py-0.5 text-xs font-bold text-primary-hover">
                              {metadata.nativeName}
                            </span>
                            <ChevronRight
                              aria-hidden="true"
                              className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 viread-rtl-flip"
                            />
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Group 3: Guide & Support */}
                  <div
                    aria-orientation="horizontal"
                    className="border-t border-border/65"
                    role="separator"
                  />
                  <div>
                    <p className="px-2.5 pb-0.5 pt-0.5 text-xs font-bold text-muted">
                      {t("navigation.accountMenu.guideSupportSection")}
                    </p>
                    <div className="space-y-0.5">
                      <button
                        className={menuItemClass(false)}
                        onClick={() => {
                          closeMenu();
                          setGuideOpen(true);
                        }}
                        role="menuitem"
                        tabIndex={0}
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className={iconTileClass(
                            false,
                            "bg-surface-subtle text-primary",
                          )}
                        >
                          <BookOpenCheck className="size-4" />
                        </span>
                        <span className="truncate">
                          {t("navigation.parent.userGuide")}
                        </span>
                      </button>

                      <Link
                        aria-current={helpSupportActive ? "page" : undefined}
                        className={menuItemClass(helpSupportActive)}
                        href="/help-support"
                        onClick={closeMenu}
                        role="menuitem"
                        tabIndex={0}
                      >
                        <span
                          aria-hidden="true"
                          className={iconTileClass(
                            helpSupportActive,
                            "bg-surface-subtle text-muted",
                          )}
                        >
                          <CircleHelp className="size-4" />
                        </span>
                        <span className="truncate">
                          {t("navigation.parent.helpFeedback")}
                        </span>
                      </Link>
                    </div>
                  </div>
                </div>

                {/* Pinned Sign-Out Footer */}
                <div className="shrink-0 border-t border-border/75 bg-cream/80 p-2">
                  <button
                    className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start text-sm font-semibold text-danger transition-colors outline-none hover:bg-danger-surface focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-55"
                    disabled={isSigningOut}
                    onClick={() => void onSignOut()}
                    role="menuitem"
                    tabIndex={0}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-danger-surface text-danger"
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

      {/* Step-by-step Quick User Guide Modal */}
      <Modal
        closeOnBackdropClick
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ButtonLink
              className="sm:w-auto"
              href="/help-support"
              onClick={() => setGuideOpen(false)}
              variant="secondary"
            >
              {t("navigation.guide.openHelpCenter")}
            </ButtonLink>
            <Button
              className="sm:w-auto"
              onClick={() => setGuideOpen(false)}
              type="button"
            >
              {t("navigation.guide.closeAction")}
            </Button>
          </div>
        }
        isOpen={guideOpen}
        onClose={() => setGuideOpen(false)}
        title={t("navigation.guide.title")}
        tone="paper"
      >
        <p className="mb-4 text-sm text-muted">
          {t("navigation.guide.subtitle")}
        </p>
        <ol className="space-y-3">
          {GUIDE_STEPS.map((step) => (
            <li
              className="flex flex-col gap-2 rounded-control border border-border bg-canvas/60 p-3.5 sm:flex-row sm:items-center sm:justify-between"
              key={step.key}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-extrabold text-ink">
                  {t(`navigation.guide.steps.${step.key}.title`)}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-muted">
                  {t(`navigation.guide.steps.${step.key}.body`)}
                </p>
              </div>
              <Link
                className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-control border border-primary/30 bg-white px-3 text-xs font-bold text-primary transition-colors hover:bg-sky"
                href={step.href}
                onClick={() => setGuideOpen(false)}
              >
                {t(`navigation.guide.steps.${step.key}.action`)}
              </Link>
            </li>
          ))}
        </ol>
      </Modal>
    </>
  );
}
