"use client";

import {
  BarChart3,
  BookMarked,
  CalendarClock,
  Check,
  ChevronDown,
  CircleHelp,
  Gamepad2,
  GraduationCap,
  History,
  LayoutDashboard,
  LogOut,
  Settings,
  UserRound,
  UsersRound,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ButtonSizeContext } from "@/components/common/button";
import {
  ProfileAvatar,
  resolveDisplayName,
} from "@/components/common/profile-avatar";
import { ViReadLogo } from "@/components/common/viread-logo";
import { dispatchI18nAuthSync } from "@/components/i18n/i18n-provider";
import { LanguageSelector } from "@/components/i18n/language-selector";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { SiteFooter } from "@/components/layout/site-footer";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useAuthService } from "@/hooks/use-auth-service";
import { useI18n } from "@/hooks/use-i18n";
import { useProfileService } from "@/hooks/use-profile-service";
import { clearPrivateMediaMemoryCache } from "@/lib/api/api-client";
import { clearGlobalTasksMemoryCache } from "@/lib/api/global-tasks-service";
import { resetApiReadCacheForActorSwitch } from "@/lib/api/read-cache";
import {
  clearUserCache,
  DEFAULT_USER_CACHE_TTL_MS,
  PERSISTENT_USER_CACHE_MAX_STALE_MS,
  readUserCacheWithStale,
  sanitizeDashboardSummaryForCache,
  writeUserCache,
} from "@/lib/cache/user-query-cache";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type { DashboardSummaryDTO, ParentProfileDTO } from "@/types/profile";

interface AppShellProps {
  children: ReactNode;
}

const learningMenuItemsConfig = [
  {
    href: "/reports",
    icon: BarChart3,
    labelKey: "navigation.parent.reports",
    descriptionKey: "navigation.parent.moreDescriptions.reports",
    badgeClassName: "bg-sky text-primary",
  },
  {
    href: "/reports/difficult-words",
    icon: Volume2,
    labelKey: "navigation.parent.difficultWords",
    descriptionKey: "navigation.parent.moreDescriptions.difficultWords",
    badgeClassName: "bg-amber-50 text-amber-700",
  },
  {
    href: "/sessions",
    icon: History,
    labelKey: "navigation.parent.sessions",
    descriptionKey: "navigation.parent.moreDescriptions.sessions",
    badgeClassName: "bg-emerald-50 text-emerald-700",
  },
  {
    href: "/reading-management",
    icon: CalendarClock,
    labelKey: "navigation.parent.readingManagement",
    descriptionKey: "navigation.parent.moreDescriptions.readingManagement",
    badgeClassName: "bg-orange-50 text-amber-800",
  },
] as const;

const learningGroupHrefs = learningMenuItemsConfig.map((item) => item.href);

const allParentNavHrefs = [
  "/dashboard",
  "/my-books",
  "/entertainment",
  ...learningGroupHrefs,
] as const;

function normalizeRoutePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "");
  }
  return pathname;
}

function routeIsActive(pathname: string, href: string): boolean {
  const normalized = normalizeRoutePath(pathname);
  return normalized === href || normalized.startsWith(`${href}/`);
}

export function isAppShellNavItemActive(
  pathname: string,
  href: string,
): boolean {
  const normalized = normalizeRoutePath(pathname);
  if (href === "/entertainment") {
    return (
      routeIsActive(normalized, "/entertainment") ||
      routeIsActive(normalized, "/karaoke")
    );
  }
  if (href === "/reports") {
    return (
      routeIsActive(normalized, "/reports") &&
      !routeIsActive(normalized, "/reports/difficult-words")
    );
  }
  return (
    routeIsActive(normalized, href) &&
    !allParentNavHrefs.some(
      (otherHref) =>
        otherHref !== href &&
        otherHref.startsWith(`${href}/`) &&
        routeIsActive(normalized, otherHref),
    )
  );
}

export function isAppShellNavGroupActive(
  pathname: string,
  hrefs: readonly string[],
): boolean {
  return hrefs.some((href) => isAppShellNavItemActive(pathname, href));
}

export function AppShell({ children }: AppShellProps) {
  const { t } = useI18n();
  const authRuntime = useAuthRuntime();
  const authService = useAuthService();
  const profileService = useProfileService();
  const appStore = useContext(AppStoreContext);
  const pathname = usePathname();
  const router = useRouter();
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const avatarButtonRef = useRef<HTMLButtonElement>(null);
  const learningMenuRef = useRef<HTMLDivElement>(null);
  const learningButtonRef = useRef<HTMLButtonElement>(null);
  const childSwitcherRef = useRef<HTMLDivElement>(null);
  const previousUserIdRef = useRef<string | undefined>(undefined);

  const user = authRuntime.session?.user ?? null;
  const userId = user?.id ?? authRuntime.initialUserId ?? null;

  const [cachedSummary, setCachedSummary] =
    useState<DashboardSummaryDTO | null>(null);
  const [fetchedProfile, setFetchedProfile] = useState<ParentProfileDTO | null>(
    null,
  );
  const [fetchedChildren, setFetchedChildren] = useState<ChildProfileDTO[]>([]);
  const [accountMenu, setAccountMenu] = useState<{
    isOpen: boolean;
    pathname: string;
  }>({ isOpen: false, pathname: "" });
  const [learningMenuOpenForPath, setLearningMenuOpenForPath] = useState<
    string | null
  >(null);
  const [childSwitcherOpenForPath, setChildSwitcherOpenForPath] = useState<
    string | null
  >(null);
  const [immersiveEventState, setImmersiveEventState] = useState<{
    active: boolean;
    pathname: string;
  }>({ active: false, pathname: "" });
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [hasSignOutError, setHasSignOutError] = useState(false);

  const profile = fetchedProfile ?? cachedSummary?.profile ?? null;
  const availableChildren = useMemo(
    () =>
      fetchedChildren.length > 0
        ? fetchedChildren
        : (cachedSummary?.children ?? []),
    [cachedSummary?.children, fetchedChildren],
  );

  const selectedChildId = appStore?.selectedChildId ?? null;
  const validatedSelectedChild = appStore?.validatedSelectedChild ?? null;
  const selectedChild = useMemo(() => {
    if (
      validatedSelectedChild &&
      (!selectedChildId || validatedSelectedChild.id === selectedChildId)
    ) {
      return validatedSelectedChild;
    }
    if (!selectedChildId) return null;
    return (
      availableChildren.find((candidate) => candidate.id === selectedChildId) ??
      null
    );
  }, [availableChildren, selectedChildId, validatedSelectedChild]);

  const isAccountMenuVisible =
    accountMenu.isOpen && accountMenu.pathname === pathname;
  const isLearningMenuVisible = learningMenuOpenForPath === pathname;
  const isChildSwitcherVisible = childSwitcherOpenForPath === pathname;
  const isLearningGroupActive = isAppShellNavGroupActive(
    pathname,
    learningGroupHrefs,
  );
  const isMobileImmersive =
    immersiveEventState.active && immersiveEventState.pathname === pathname;
  const isChildOnboarding = pathname === "/children/new";
  const isBookRoute = pathname === "/books" || pathname.startsWith("/books/");
  const isReadingRoute = pathname.startsWith("/reading/");
  const isImmersiveRoute = isBookRoute || isReadingRoute;

  const displayName = resolveDisplayName(
    profile?.display_name,
    user?.display_name,
    profile?.email ?? user?.email,
  );
  const email = profile?.email ?? user?.email ?? null;

  const resolvedRoleLabel =
    profile?.role === "parent"
      ? t("parent.profile.roleParent")
      : profile?.role === "admin"
        ? t("parent.profile.roleAdmin")
        : null;

  useEffect(() => {
    let isActive = true;

    const loadProfileAndSummary = async () => {
      const cached =
        readUserCacheWithStale<DashboardSummaryDTO>(
          userId,
          "dashboard-summary",
          DEFAULT_USER_CACHE_TTL_MS,
          PERSISTENT_USER_CACHE_MAX_STALE_MS,
        )?.data ?? null;
      if (isActive) {
        setCachedSummary(cached);
      }

      try {
        if (typeof profileService.getDashboardSummary === "function") {
          const summary = await profileService.getDashboardSummary();
          if (!isActive) return;
          setFetchedProfile(summary.profile);
          setFetchedChildren(summary.children);
          setCachedSummary(summary);
          const ownerId = userId ?? summary.profile?.id ?? null;
          if (ownerId) {
            const cacheableSummary = sanitizeDashboardSummaryForCache(summary);
            writeUserCache(ownerId, "dashboard-summary", cacheableSummary, {
              persist: "session",
            });
            writeUserCache(ownerId, "children", cacheableSummary.children, {
              persist: "session",
            });
          }
          return;
        }
        const nextProfile = await profileService.get();
        if (isActive) setFetchedProfile(nextProfile);
      } catch {
        if (isActive && !cached) {
          setFetchedProfile(null);
        }
      }
    };

    void loadProfileAndSummary();

    return () => {
      isActive = false;
    };
  }, [profileService, userId]);

  useEffect(() => {
    function handleProfileUpdated(event: Event) {
      const detail = (event as CustomEvent<{ displayName?: unknown }>).detail;
      if (typeof detail?.displayName !== "string") return;
      setFetchedProfile((current) => {
        const base = current ?? cachedSummary?.profile ?? null;
        return base
          ? { ...base, display_name: detail.displayName as string }
          : base;
      });
    }

    function handleImmersiveMode(event: Event) {
      const detail = (event as CustomEvent<{ active?: unknown }>).detail;
      setImmersiveEventState({
        active: Boolean(detail?.active),
        pathname,
      });
    }

    window.addEventListener("viread:profile-updated", handleProfileUpdated);
    window.addEventListener("viread:immersive-mode", handleImmersiveMode);
    return () => {
      window.removeEventListener(
        "viread:profile-updated",
        handleProfileUpdated,
      );
      window.removeEventListener("viread:immersive-mode", handleImmersiveMode);
    };
  }, [cachedSummary?.profile, pathname]);

  useEffect(() => {
    if (!isAccountMenuVisible) return;
    accountMenuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus();
  }, [isAccountMenuVisible]);

  useEffect(() => {
    if (!isAccountMenuVisible) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !accountMenuRef.current?.contains(event.target)
      ) {
        setAccountMenu((current) => ({ ...current, isOpen: false }));
      }
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountMenu((current) => ({ ...current, isOpen: false }));
        avatarButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isAccountMenuVisible]);

  useEffect(() => {
    if (!isLearningMenuVisible) return;
    learningMenuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus();
  }, [isLearningMenuVisible]);

  useEffect(() => {
    if (!isLearningMenuVisible) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !learningMenuRef.current?.contains(event.target)
      ) {
        setLearningMenuOpenForPath(null);
      }
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setLearningMenuOpenForPath(null);
        learningButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isLearningMenuVisible]);

  useEffect(() => {
    if (!isChildSwitcherVisible) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !childSwitcherRef.current?.contains(event.target)
      ) {
        setChildSwitcherOpenForPath(null);
      }
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setChildSwitcherOpenForPath(null);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isChildSwitcherVisible]);

  useEffect(() => {
    clearPrivateMediaMemoryCache();
    clearGlobalTasksMemoryCache();
    const prevId = previousUserIdRef.current;
    if (prevId !== undefined && prevId !== user?.id) {
      resetApiReadCacheForActorSwitch();
      clearUserCache(prevId);
      if (!user?.id) {
        clearUserCache();
      }
    }
    previousUserIdRef.current = user?.id;
  }, [user?.id]);

  async function handleSignOut() {
    if (isSigningOut) return;

    setHasSignOutError(false);
    setIsSigningOut(true);

    try {
      clearPrivateMediaMemoryCache();
      clearGlobalTasksMemoryCache();
      resetApiReadCacheForActorSwitch();
      clearUserCache();
      await authService.signOut();
      dispatchI18nAuthSync({ userId: null, preferredLocale: null });
      setAccountMenu((current) => ({ ...current, isOpen: false }));
      router.replace("/login");
      router.refresh();
    } catch {
      setHasSignOutError(true);
    } finally {
      setIsSigningOut(false);
    }
  }

  function handleLearningMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    const items = learningMenuRef.current?.querySelectorAll<HTMLElement>(
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

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    const items = accountMenuRef.current?.querySelectorAll<HTMLElement>(
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

  const taskActorId = user?.id ?? null;
  const taskActorRole = taskActorId
    ? profile?.role === "admin"
      ? "admin"
      : "parent"
    : null;

  if (isReadingRoute) {
    return (
      <AiTaskCenterProvider
        actorId={taskActorId}
        actorRole={taskActorRole}
        enabled={false}
      >
        <main id="main-content" tabIndex={-1} className="min-h-dvh bg-canvas">
          {children}
        </main>
      </AiTaskCenterProvider>
    );
  }

  if (isBookRoute) {
    return (
      <AiTaskCenterProvider actorId={taskActorId} actorRole={taskActorRole}>
        <main id="main-content" tabIndex={-1} className="min-h-dvh bg-canvas">
          {children}
        </main>
      </AiTaskCenterProvider>
    );
  }

  const autoSyncStudioTasks =
    pathname.startsWith("/my-books") ||
    pathname.startsWith("/book-scanner") ||
    pathname.startsWith("/studio/tasks");

  return (
    <AiTaskCenterProvider
      actorId={taskActorId}
      actorRole={taskActorRole}
      autoSyncOnMount={autoSyncStudioTasks}
    >
      <div className="parent-shell flex min-h-dvh flex-col bg-canvas">
        <a
          className="sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[100] focus:not-sr-only focus:rounded-control focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-primary focus:shadow-lg"
          href="#main-content"
        >
          {t("navigation.parent.skipToContent")}
        </a>
        <header
          className={cn(
            "parent-topbar sticky top-0 z-30 shrink-0 border-b border-border/80 bg-white/95 backdrop-blur-md",
            isMobileImmersive && "hidden xl:block",
          )}
        >
          <nav
            aria-label={t("navigation.parent.navLabel")}
            className={cn(
              "mx-auto flex h-14 w-full min-w-0 max-w-[1184px] items-center gap-2 px-4 sm:px-8 xl:h-16 xl:gap-4",
              isChildOnboarding && "min-h-11",
            )}
          >
            <ViReadLogo
              ariaLabel={t("navigation.footer.logoDashboardAria")}
              className={cn("shrink-0", isChildOnboarding && "text-label")}
              href="/dashboard"
              size="md"
            />

            {!isChildOnboarding ? (
              <div className="parent-nav-links hidden min-w-0 items-center gap-1.5 xl:ms-4 xl:flex xl:flex-none xl:flex-nowrap">
                <Link
                  aria-current={
                    isAppShellNavItemActive(pathname, "/dashboard")
                      ? "page"
                      : undefined
                  }
                  className={cn(
                    "group inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    isAppShellNavItemActive(pathname, "/dashboard")
                      ? "bg-sky/80 font-bold text-primary-hover"
                      : "text-ink hover:bg-canvas hover:text-primary-hover",
                  )}
                  href="/dashboard"
                  onClick={() => {
                    setLearningMenuOpenForPath(null);
                    setAccountMenu((current) => ({
                      ...current,
                      isOpen: false,
                    }));
                  }}
                >
                  <LayoutDashboard
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 transition-colors",
                      isAppShellNavItemActive(pathname, "/dashboard")
                        ? "text-primary"
                        : "text-muted group-hover:text-primary",
                    )}
                    strokeWidth={1.9}
                  />
                  <span>{t("navigation.parent.dashboard")}</span>
                </Link>

                <Link
                  aria-current={
                    isAppShellNavItemActive(pathname, "/my-books")
                      ? "page"
                      : undefined
                  }
                  className={cn(
                    "group inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    isAppShellNavItemActive(pathname, "/my-books")
                      ? "bg-sky/80 font-bold text-primary-hover"
                      : "text-ink hover:bg-canvas hover:text-primary-hover",
                  )}
                  href="/my-books"
                  onClick={() => {
                    setLearningMenuOpenForPath(null);
                    setAccountMenu((current) => ({
                      ...current,
                      isOpen: false,
                    }));
                  }}
                >
                  <BookMarked
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 transition-colors",
                      isAppShellNavItemActive(pathname, "/my-books")
                        ? "text-primary"
                        : "text-muted group-hover:text-primary",
                    )}
                    strokeWidth={1.9}
                  />
                  <span>{t("navigation.parent.myBooks")}</span>
                </Link>

                <div className="relative" ref={learningMenuRef}>
                  <button
                    aria-controls="parent-learning-menu"
                    aria-expanded={isLearningMenuVisible}
                    aria-haspopup="menu"
                    className={cn(
                      "group inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      isLearningGroupActive
                        ? "bg-sky/80 font-bold text-primary-hover"
                        : isLearningMenuVisible
                          ? "bg-canvas text-primary-hover"
                          : "text-ink hover:bg-canvas hover:text-primary-hover",
                    )}
                    data-active={isLearningGroupActive ? "true" : undefined}
                    onClick={() => {
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }));
                      setChildSwitcherOpenForPath(null);
                      setLearningMenuOpenForPath((current) =>
                        current === pathname ? null : pathname,
                      );
                    }}
                    onKeyDown={(event) => {
                      if (
                        (event.key === "ArrowDown" ||
                          event.key === "ArrowUp") &&
                        !isLearningMenuVisible
                      ) {
                        event.preventDefault();
                        setAccountMenu((current) => ({
                          ...current,
                          isOpen: false,
                        }));
                        setChildSwitcherOpenForPath(null);
                        setLearningMenuOpenForPath(pathname);
                      }
                    }}
                    ref={learningButtonRef}
                    title={t("navigation.parent.learningGroupAria")}
                    type="button"
                  >
                    <GraduationCap
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 transition-colors",
                        isLearningGroupActive || isLearningMenuVisible
                          ? "text-primary"
                          : "text-muted group-hover:text-primary",
                      )}
                      strokeWidth={1.9}
                    />
                    <span>{t("navigation.parent.learningGroup")}</span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 transition-transform duration-150",
                        isLearningGroupActive || isLearningMenuVisible
                          ? "text-primary"
                          : "text-muted group-hover:text-primary",
                        isLearningMenuVisible && "rotate-180",
                      )}
                      strokeWidth={2}
                    />
                  </button>

                  {isLearningMenuVisible ? (
                    <div
                      aria-label={t("navigation.parent.learningGroupAria")}
                      className="absolute start-0 top-full z-50 mt-2 w-80 rounded-card border border-border bg-white p-2 shadow-xl"
                      id="parent-learning-menu"
                      onKeyDown={handleLearningMenuKeyDown}
                      role="menu"
                    >
                      <div className="grid gap-1">
                        {learningMenuItemsConfig.map(
                          ({
                            href,
                            icon: Icon,
                            labelKey,
                            descriptionKey,
                            badgeClassName,
                          }) => {
                            const isItemActive = isAppShellNavItemActive(
                              pathname,
                              href,
                            );

                            return (
                              <Link
                                aria-current={isItemActive ? "page" : undefined}
                                className={cn(
                                  "flex items-start gap-3 rounded-control px-3 py-2.5 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary",
                                  isItemActive
                                    ? "bg-sky/80 text-primary-hover"
                                    : "text-ink hover:bg-canvas",
                                )}
                                href={href}
                                key={href}
                                onClick={() => setLearningMenuOpenForPath(null)}
                                role="menuitem"
                                tabIndex={0}
                              >
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-control",
                                    isItemActive
                                      ? "bg-white text-primary shadow-2xs"
                                      : badgeClassName,
                                  )}
                                >
                                  <Icon className="size-4" strokeWidth={1.9} />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-bold leading-snug">
                                    {t(labelKey)}
                                  </span>
                                  <span className="mt-0.5 block text-xs leading-snug text-muted">
                                    {t(descriptionKey)}
                                  </span>
                                </span>
                              </Link>
                            );
                          },
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>

                <Link
                  aria-current={
                    isAppShellNavItemActive(pathname, "/entertainment")
                      ? "page"
                      : undefined
                  }
                  className={cn(
                    "group inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    isAppShellNavItemActive(pathname, "/entertainment")
                      ? "bg-sky/80 font-bold text-primary-hover"
                      : "text-ink hover:bg-canvas hover:text-primary-hover",
                  )}
                  href="/entertainment"
                  onClick={() => {
                    setLearningMenuOpenForPath(null);
                    setAccountMenu((current) => ({
                      ...current,
                      isOpen: false,
                    }));
                  }}
                >
                  <Gamepad2
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 transition-colors",
                      isAppShellNavItemActive(pathname, "/entertainment")
                        ? "text-primary"
                        : "text-muted group-hover:text-primary",
                    )}
                    strokeWidth={1.9}
                  />
                  <span>{t("navigation.parent.entertainment")}</span>
                </Link>
              </div>
            ) : null}

            <div className="ms-auto flex min-w-0 items-center justify-end gap-2 sm:gap-2.5">
              {!isChildOnboarding ? (
                <>
                  <div
                    className="relative flex min-w-0 items-center xl:hidden"
                    ref={childSwitcherRef}
                  >
                    {availableChildren.length > 0 && appStore ? (
                      <>
                        <button
                          aria-expanded={isChildSwitcherVisible}
                          aria-haspopup="listbox"
                          aria-label={
                            selectedChild
                              ? t("navigation.childSwitcher.selectedAria", {
                                  alias: selectedChild.alias,
                                })
                              : t("navigation.childSwitcher.openAria")
                          }
                          className="inline-flex min-h-12 max-w-[136px] items-center gap-1.5 rounded-full border border-border bg-sky/70 px-3 text-xs font-bold text-primary-hover transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary min-[390px]:max-w-[164px]"
                          onClick={() => {
                            setLearningMenuOpenForPath(null);
                            setAccountMenu((current) => ({
                              ...current,
                              isOpen: false,
                            }));
                            setChildSwitcherOpenForPath((current) =>
                              current === pathname ? null : pathname,
                            );
                          }}
                          type="button"
                        >
                          <span className="truncate">
                            {selectedChild
                              ? t("navigation.childSwitcher.compactLabel", {
                                  alias: selectedChild.alias,
                                  grade: selectedChild.grade,
                                })
                              : t("navigation.childSwitcher.selectChild")}
                          </span>
                          <ChevronDown
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                          />
                        </button>

                        {isChildSwitcherVisible ? (
                          <div
                            aria-label={t("navigation.childSwitcher.listAria")}
                            className="absolute end-0 top-full z-50 mt-2 w-60 rounded-card border border-border bg-white p-2 shadow-lg"
                            role="listbox"
                          >
                            {availableChildren.map((child) => {
                              const isSelected = selectedChild?.id === child.id;
                              return (
                                <button
                                  aria-selected={isSelected}
                                  className={cn(
                                    "flex min-h-12 w-full items-center justify-between gap-2 rounded-control px-3 text-start text-sm font-semibold transition-colors",
                                    isSelected
                                      ? "bg-sky text-primary-hover"
                                      : "text-ink hover:bg-canvas",
                                  )}
                                  key={child.id}
                                  onClick={() => {
                                    appStore.selectChild(child.id);
                                    appStore.setValidatedSelectedChild(child);
                                    setChildSwitcherOpenForPath(null);
                                  }}
                                  role="option"
                                  type="button"
                                >
                                  <span className="truncate">
                                    {child.alias}{" "}
                                    <span className="font-normal text-muted">
                                      {t(
                                        "navigation.childSwitcher.gradeLabel",
                                        {
                                          grade: child.grade,
                                        },
                                      )}
                                    </span>
                                  </span>
                                  {isSelected ? (
                                    <Check
                                      aria-hidden="true"
                                      className="size-4 shrink-0 text-primary"
                                    />
                                  ) : null}
                                </button>
                              );
                            })}
                            <div className="my-1 border-t border-border" />
                            <Link
                              className="flex min-h-11 items-center gap-2 rounded-control px-3 text-xs font-bold text-primary hover:bg-canvas"
                              href="/children"
                              onClick={() => setChildSwitcherOpenForPath(null)}
                            >
                              <UsersRound
                                aria-hidden="true"
                                className="size-4"
                              />
                              {t("navigation.childSwitcher.manageChildren")}
                            </Link>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <Link
                        className="inline-flex min-h-12 max-w-[136px] items-center gap-1.5 rounded-full border border-border bg-sky/70 px-3 text-xs font-bold text-primary-hover transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary min-[390px]:max-w-[164px]"
                        href="/dashboard?focus=child-selection"
                      >
                        <span className="truncate">
                          {selectedChild
                            ? t("navigation.childSwitcher.compactLabel", {
                                alias: selectedChild.alias,
                                grade: selectedChild.grade,
                              })
                            : t("navigation.childSwitcher.selectChild")}
                        </span>
                      </Link>
                    )}
                  </div>

                  <span
                    aria-hidden="true"
                    className="hidden h-5 w-px shrink-0 bg-border/80 xl:block"
                  />

                  <GlobalTaskCenter
                    className="shrink-0"
                    hideOnPaths={["/children/new"]}
                    variant="header-pill"
                  />
                </>
              ) : null}

              <div className="relative shrink-0" ref={accountMenuRef}>
                <button
                  aria-controls="parent-account-menu"
                  aria-expanded={isAccountMenuVisible}
                  aria-haspopup="menu"
                  aria-label={
                    isAccountMenuVisible
                      ? t("navigation.accountMenu.closeAria")
                      : t("navigation.accountMenu.openAria")
                  }
                  className="flex size-12 items-center justify-center rounded-full border border-border bg-white p-0.5 shadow-2xs transition-colors hover:border-primary focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary xl:size-11"
                  onClick={() => {
                    setChildSwitcherOpenForPath(null);
                    setLearningMenuOpenForPath(null);
                    if (isAccountMenuVisible) {
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }));
                    } else {
                      setAccountMenu({ isOpen: true, pathname });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && !isAccountMenuVisible) {
                      event.preventDefault();
                      setChildSwitcherOpenForPath(null);
                      setLearningMenuOpenForPath(null);
                      setAccountMenu({ isOpen: true, pathname });
                    }
                  }}
                  ref={avatarButtonRef}
                  type="button"
                >
                  <ProfileAvatar
                    ariaLabel={t("accessibility.accountAvatar")}
                    displayName={displayName}
                    imageUrl={profile?.avatar_url}
                    size="sm"
                  />
                </button>
                <div
                  aria-label={t("navigation.accountMenu.shortMenuAria")}
                  className="absolute end-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-border bg-white p-2 shadow-xl"
                  hidden={!isAccountMenuVisible}
                  id="parent-account-menu"
                  onKeyDown={handleMenuKeyDown}
                  role="menu"
                >
                  <div className="flex items-center gap-3 rounded-control bg-canvas/70 px-3 py-2.5">
                    <ProfileAvatar
                      ariaLabel={t("accessibility.accountAvatar")}
                      displayName={displayName}
                      imageUrl={profile?.avatar_url}
                      size="md"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-ink">
                        {displayName ??
                          t("navigation.accountMenu.defaultAccountLabel")}
                      </p>
                      {email ? (
                        <p className="truncate text-xs text-muted">{email}</p>
                      ) : null}
                      {resolvedRoleLabel ? (
                        <p className="mt-0.5 text-xs font-semibold text-primary">
                          {resolvedRoleLabel}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="my-2 border-t border-border/80" />
                  <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                    {t("navigation.accountMenu.profileSection")}
                  </p>
                  <Link
                    aria-current={
                      routeIsActive(pathname, "/profile") ? "page" : undefined
                    }
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary",
                      routeIsActive(pathname, "/profile")
                        ? "bg-sky/80 text-primary-hover"
                        : "hover:bg-canvas",
                    )}
                    href="/profile"
                    onClick={() =>
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }))
                    }
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                  >
                    <UserRound
                      aria-hidden="true"
                      className="size-4 text-primary"
                    />
                    {t("navigation.parent.parentProfile")}
                  </Link>
                  <Link
                    aria-current={
                      routeIsActive(pathname, "/children") ? "page" : undefined
                    }
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary",
                      routeIsActive(pathname, "/children")
                        ? "bg-sky/80 text-primary-hover"
                        : "hover:bg-canvas",
                    )}
                    href="/children"
                    onClick={() =>
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }))
                    }
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                  >
                    <UsersRound
                      aria-hidden="true"
                      className="size-4 text-primary"
                    />
                    {t("navigation.parent.children")}
                  </Link>

                  <div className="my-2 border-t border-border/80" />
                  <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                    {t("navigation.accountMenu.accountSection")}
                  </p>
                  <Link
                    aria-current={
                      routeIsActive(pathname, "/settings") ? "page" : undefined
                    }
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary",
                      routeIsActive(pathname, "/settings")
                        ? "bg-sky/80 text-primary-hover"
                        : "hover:bg-canvas",
                    )}
                    href="/settings"
                    onClick={() =>
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }))
                    }
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                  >
                    <Settings
                      aria-hidden="true"
                      className="size-4 text-primary"
                    />
                    {t("navigation.parent.settings")}
                  </Link>

                  <div className="my-2 border-t border-border/80" />
                  <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                    {t("navigation.accountMenu.helpSection")}
                  </p>
                  <Link
                    aria-current={
                      routeIsActive(pathname, "/help-support")
                        ? "page"
                        : undefined
                    }
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-semibold text-ink outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary",
                      routeIsActive(pathname, "/help-support")
                        ? "bg-sky/80 text-primary-hover"
                        : "hover:bg-canvas",
                    )}
                    href="/help-support"
                    onClick={() =>
                      setAccountMenu((current) => ({
                        ...current,
                        isOpen: false,
                      }))
                    }
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                  >
                    <CircleHelp
                      aria-hidden="true"
                      className="size-4 text-primary"
                    />
                    {t("navigation.parent.helpSupport")}
                  </Link>

                  <div className="my-2 border-t border-border/80" />
                  <div className="px-1 py-1">
                    <p className="px-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                      {t("common.languageSelector.label")}
                    </p>
                    <LanguageSelector variant="menu" />
                  </div>

                  <div className="my-2 border-t border-border/80" />
                  <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">
                    {t("navigation.accountMenu.sessionSection")}
                  </p>
                  <button
                    className="flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-start text-sm font-semibold text-danger outline-none transition-colors hover:bg-danger-surface focus-visible:ring-2 focus-visible:ring-danger disabled:cursor-not-allowed disabled:opacity-55"
                    disabled={isSigningOut}
                    onClick={() => void handleSignOut()}
                    role="menuitem"
                    tabIndex={isAccountMenuVisible ? 0 : -1}
                    type="button"
                  >
                    <LogOut
                      aria-hidden="true"
                      className="size-4 viread-rtl-flip"
                    />
                    {isSigningOut
                      ? t("auth.session.signingOut")
                      : t("auth.session.signOut")}
                  </button>
                </div>
              </div>
            </div>
          </nav>
          {hasSignOutError ? (
            <p
              className="mx-auto mt-2 w-full max-w-[1184px] px-4 pb-2 text-sm font-semibold text-danger sm:px-8"
              role="alert"
            >
              {t("auth.session.signOutError")}
            </p>
          ) : null}
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            isImmersiveRoute
              ? "w-full flex-1"
              : "mx-auto w-full max-w-[1184px] px-4 sm:px-8",
            !isImmersiveRoute && "min-w-0 flex-1",
            !isImmersiveRoute &&
              (isChildOnboarding
                ? "pb-8 pt-4 sm:pb-10"
                : isMobileImmersive
                  ? "py-4 sm:py-6 xl:py-10"
                  : "pb-24 pt-5 sm:pt-7 xl:py-10"),
          )}
        >
          <ButtonSizeContext.Provider value="compact">
            {children}
          </ButtonSizeContext.Provider>
        </main>

        <SiteFooter className="hidden lg:block" variant="parent" />

        {!isChildOnboarding && !isMobileImmersive ? (
          <MobileBottomNav pathname={pathname} />
        ) : null}
      </div>
    </AiTaskCenterProvider>
  );
}
