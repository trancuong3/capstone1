"use client";

import {
  BarChart3,
  BookMarked,
  Check,
  ChevronDown,
  Gamepad2,
  LayoutDashboard,
  Lock,
  ShieldCheck,
  UsersRound,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ButtonSizeContext } from "@/components/common/button";
import { resolveDisplayName } from "@/components/common/profile-avatar";
import { ViReadLogo } from "@/components/common/viread-logo";
import { dispatchI18nAuthSync } from "@/components/i18n/i18n-provider";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { ParentAccountDropdown } from "@/components/layout/parent-account-dropdown";
import { SiteFooter } from "@/components/layout/site-footer";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { AiTaskCenterProvider } from "@/components/tasks/ai-task-center-provider";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import {
  ParentPinModal,
  type ParentPinModalMode,
} from "@/components/security/parent-pin-modal";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useAuthService } from "@/hooks/use-auth-service";
import { useI18n } from "@/hooks/use-i18n";
import { useProfileService } from "@/hooks/use-profile-service";
import { clearPrivateMediaMemoryCache } from "@/lib/api/api-client";
import { createFamilyPedagogyService } from "@/lib/api/family-pedagogy-service";
import { clearAndroidScheduledReminders } from "@/lib/reading/native-reminder-bridge";
import {
  clearAllOfflineReadingPacks,
  clearOfflineReadingPacksForUser,
  listPendingOfflineSessions,
  subscribeOfflinePackChanges,
  syncPendingOfflineSessions,
} from "@/lib/offline/offline-reading-pack";
import {
  clearChildModeLockForUser,
  isChildModeLockedForUser,
  isParentProtectedRoute,
  setChildModeLockedForUser,
  subscribeChildModeLock,
} from "@/lib/security/child-mode-lock";
import {
  broadcastActorSwitch,
  clearGlobalTasksMemoryCache,
} from "@/lib/api/global-tasks-service";
import { resetApiReadCacheForActorSwitch } from "@/lib/api/read-cache";
import { clearStoredScanJobIds } from "@/lib/cache/scan-job-storage";
import {
  clearUserCache,
  DEFAULT_USER_CACHE_TTL_MS,
  PERSISTENT_USER_CACHE_MAX_STALE_MS,
  readUserCacheWithStale,
  sanitizeDashboardSummaryForCache,
  writeUserCache,
} from "@/lib/cache/user-query-cache";
import {
  hydrateTeacherVoiceFromChildProfile,
  resetTeacherVoiceForActorSwitch,
} from "@/lib/reading/session-voice-lock";
import { wipeOfflineAccountData } from "@/lib/offline/offline-hygiene";
import { installOfflineOutboxReconnectAutoDrain } from "@/lib/offline/offline-session-outbox";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type { DashboardSummaryDTO, ParentProfileDTO } from "@/types/profile";

interface AppShellProps {
  children: ReactNode;
}

const navigationItemsConfig = [
  {
    href: "/dashboard",
    icon: LayoutDashboard,
    labelKey: "navigation.parent.dashboard",
  },
  {
    href: "/my-books",
    icon: BookMarked,
    labelKey: "navigation.parent.myBooks",
  },
  {
    href: "/reports",
    icon: BarChart3,
    labelKey: "navigation.parent.reports",
  },
  {
    href: "/reports/difficult-words",
    icon: Volume2,
    labelKey: "navigation.parent.difficultWords",
  },
  {
    href: "/entertainment",
    icon: Gamepad2,
    labelKey: "navigation.parent.entertainment",
  },
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
    !navigationItemsConfig.some(
      (other) =>
        other.href !== href &&
        other.href.startsWith(`${href}/`) &&
        routeIsActive(normalized, other.href),
    )
  );
}

export function AppShell({ children }: AppShellProps) {
  const { t } = useI18n();
  const authRuntime = useAuthRuntime();
  const authService = useAuthService();
  const profileService = useProfileService();
  const appStore = useContext(AppStoreContext);
  const pathname = usePathname();
  const router = useRouter();
  const activeNavigationRef = useRef<HTMLAnchorElement>(null);
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

  useEffect(() => {
    if (selectedChild) {
      hydrateTeacherVoiceFromChildProfile(selectedChild);
    }
  }, [selectedChild]);

  const isChildSwitcherVisible = childSwitcherOpenForPath === pathname;
  const isMobileImmersive =
    immersiveEventState.active && immersiveEventState.pathname === pathname;
  const isFromRegister =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("from") === "register";
  const isChildOnboarding =
    pathname === "/children/new" &&
    (availableChildren.length === 0 || isFromRegister);
  const normalizedPathname = normalizeRoutePath(pathname);
  const isBookCatalogRoute = normalizedPathname === "/books";
  const isBookRoute =
    isBookCatalogRoute || normalizedPathname.startsWith("/books/");
  const isReadingRoute = normalizedPathname.startsWith("/reading/");
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
    const activeLink = activeNavigationRef.current;
    const navContainer = activeLink?.parentElement;
    if (
      !activeLink ||
      !navContainer ||
      navContainer.scrollWidth <= navContainer.clientWidth ||
      typeof activeLink.scrollIntoView !== "function"
    ) {
      return;
    }
    activeLink.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

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
      resetTeacherVoiceForActorSwitch();
      clearUserCache(prevId);
      clearChildModeLockForUser(prevId);
      void clearAndroidScheduledReminders();
      void clearOfflineReadingPacksForUser(prevId);
      clearStoredScanJobIds(user?.id ?? null);
      if (!user?.id) {
        clearUserCache();
        void clearAllOfflineReadingPacks();
      }
      broadcastActorSwitch();
    }
    previousUserIdRef.current = user?.id;
  }, [user?.id]);

  useEffect(() => {
    if (!userId) return;
    let disposed = false;
    const flushIfPendingOnline = async () => {
      if (
        disposed ||
        (typeof navigator !== "undefined" && navigator.onLine === false)
      ) {
        return;
      }
      const pending = await listPendingOfflineSessions(userId);
      if (!disposed && pending.length > 0) {
        await syncPendingOfflineSessions(userId);
      }
    };
    const onOnline = () => {
      void flushIfPendingOnline();
    };
    window.addEventListener("online", onOnline);
    const unsub = subscribeOfflinePackChanges(() => {
      // Only auto-flush when online and local outbox has queued items
      void flushIfPendingOnline();
    });
    void flushIfPendingOnline();
    return () => {
      disposed = true;
      window.removeEventListener("online", onOnline);
      unsub();
    };
  }, [userId]);

  useEffect(() => {
    return installOfflineOutboxReconnectAutoDrain(() => ({
      parentAccountId: userId,
      childProfileId: selectedChildId,
    }));
  }, [selectedChildId, userId]);

  const familyPedagogyService = useMemo(
    () => createFamilyPedagogyService(),
    [],
  );
  const [pinState, setPinState] = useState<{
    readonly userId: string;
    readonly hasPin: boolean;
  } | null>(null);
  const hasParentPin = Boolean(
    userId && pinState?.userId === userId && pinState.hasPin,
  );
  const [pinModalMode, setPinModalMode] = useState<ParentPinModalMode | null>(
    null,
  );
  const getLockSnapshot = useCallback(
    () => isChildModeLockedForUser(userId),
    [userId],
  );
  const isChildModeLocked = useSyncExternalStore(
    subscribeChildModeLock,
    getLockSnapshot,
    () => false,
  );
  const isProtectedByChildLock =
    isChildModeLocked && isParentProtectedRoute(pathname);

  const handleChildModeToggle = useCallback(() => {
    if (!userId) return;
    if (isChildModeLocked) {
      setPinModalMode("unlock");
      return;
    }
    if (hasParentPin) {
      setChildModeLockedForUser(userId, true);
      if (isParentProtectedRoute(pathname)) {
        router.push("/dashboard");
      }
      return;
    }
    const targetUserId = userId;
    void familyPedagogyService
      .getPinStatus()
      .then((statusRes) => {
        setPinState({ userId: targetUserId, hasPin: statusRes.has_pin });
        if (statusRes.has_pin) {
          setChildModeLockedForUser(targetUserId, true);
          if (isParentProtectedRoute(pathname)) {
            router.push("/dashboard");
          }
        } else {
          setPinModalMode("setup");
        }
      })
      .catch(() => {
        setPinModalMode("setup");
      });
  }, [
    familyPedagogyService,
    hasParentPin,
    isChildModeLocked,
    pathname,
    router,
    userId,
  ]);

  async function handleSignOut() {
    if (isSigningOut) return;
    if (isChildModeLocked) {
      setPinModalMode("unlock");
      return;
    }

    setHasSignOutError(false);
    setIsSigningOut(true);

    try {
      void wipeOfflineAccountData({
        parentAccountId: userId,
        reason: "logout",
      }).catch(() => undefined);
      clearPrivateMediaMemoryCache();
      clearGlobalTasksMemoryCache();
      clearChildModeLockForUser(userId);
      void clearAndroidScheduledReminders();
      void clearAllOfflineReadingPacks();
      clearStoredScanJobIds();
      resetApiReadCacheForActorSwitch();
      resetTeacherVoiceForActorSwitch();
      clearUserCache();
      broadcastActorSwitch();
      await authService.signOut();
      dispatchI18nAuthSync({ userId: null, preferredLocale: null });
      router.replace("/login");
      router.refresh();
    } catch {
      setHasSignOutError(true);
    } finally {
      setIsSigningOut(false);
    }
  }

  // AppShell is strictly the Parent portal. Never escalate its AI Task Center
  // to "admin" even if the signed-in account holds an admin role.
  const taskActorId = userId;
  const taskActorRole = taskActorId ? ("parent" as const) : null;

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
        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            "min-h-dvh bg-canvas",
            isBookCatalogRoute && !isMobileImmersive && "pb-24 sm:pb-8",
          )}
        >
          {children}
        </main>
        {isBookCatalogRoute && !isMobileImmersive ? (
          <MobileBottomNav pathname={pathname} />
        ) : null}
      </AiTaskCenterProvider>
    );
  }

  const autoSyncStudioTasks =
    Boolean(taskActorId) &&
    !isChildOnboarding &&
    (pathname.startsWith("/studio") ||
      pathname.startsWith("/my-books") ||
      pathname.startsWith("/books") ||
      pathname.startsWith("/library") ||
      pathname.startsWith("/book-scanner") ||
      pathname.startsWith("/scan"));

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
            "parent-topbar sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 px-3 backdrop-blur-sm sm:px-6 xl:static xl:bg-white xl:px-8",
            isMobileImmersive && "hidden xl:block",
          )}
        >
          <nav
            aria-label={t("navigation.parent.navLabel")}
            className={cn(
              "mx-auto flex h-14 w-full min-w-0 max-w-[1312px] items-center gap-2 xl:h-auto xl:min-h-16 xl:gap-2 2xl:gap-4",
              isChildOnboarding && "min-h-11",
            )}
          >
            <ViReadLogo
              ariaLabel={t("navigation.footer.logoDashboardAria")}
              className={cn(isChildOnboarding ? "text-label" : "xl:me-auto")}
              href="/dashboard"
              size="md"
            />

            <div className="flex min-w-0 flex-1 items-center justify-end gap-2 xl:w-auto xl:flex-none xl:gap-2 2xl:gap-3">
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
                          className="inline-flex min-h-12 max-w-[164px] items-center gap-1.5 rounded-full border border-border bg-sky/70 px-3 text-xs font-bold text-primary-hover transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                          onClick={() =>
                            setChildSwitcherOpenForPath((current) =>
                              current === pathname ? null : pathname,
                            )
                          }
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
                                    hydrateTeacherVoiceFromChildProfile(child, {
                                      force: true,
                                    });
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
                        className="inline-flex min-h-12 max-w-[164px] items-center gap-1.5 rounded-full border border-border bg-sky/70 px-3 text-xs font-bold text-primary-hover transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
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

                  <div className="parent-nav-links hidden min-w-0 items-center justify-end gap-1.5 py-1 xl:flex xl:flex-none xl:flex-nowrap 2xl:gap-2">
                    {navigationItemsConfig.map(
                      ({ href, icon: Icon, labelKey }) => {
                        const isActive = isAppShellNavItemActive(
                          pathname,
                          href,
                        );

                        return (
                          <Link
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-control px-2.5 text-center text-xs font-semibold text-ink transition-colors focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary sm:min-h-11 sm:text-sm xl:h-11 xl:gap-2 xl:px-3 xl:text-[15px]",
                              isActive
                                ? "bg-sky text-primary-hover xl:underline xl:decoration-2 xl:underline-offset-8"
                                : "bg-white hover:bg-canvas",
                            )}
                            href={href}
                            key={href}
                            ref={isActive ? activeNavigationRef : undefined}
                          >
                            <Icon
                              aria-hidden="true"
                              className="size-4 shrink-0 sm:size-[18px]"
                              strokeWidth={1.8}
                            />
                            <span className="whitespace-nowrap">
                              {t(labelKey)}
                            </span>
                          </Link>
                        );
                      },
                    )}
                  </div>
                </>
              ) : (
                <span className="flex-1" />
              )}

              {!isChildOnboarding && userId ? (
                <button
                  aria-pressed={isChildModeLocked}
                  className={cn(
                    "inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    isChildModeLocked
                      ? "border-emerald-400 bg-emerald-50 text-emerald-900"
                      : "border-border bg-canvas/80 text-ink hover:bg-sky/60",
                  )}
                  data-testid="child-mode-lock-toggle"
                  onClick={handleChildModeToggle}
                  title={
                    isChildModeLocked
                      ? t("parent.childModePin.lockedTooltip")
                      : t("parent.childModePin.unlockedTooltip")
                  }
                  type="button"
                >
                  {isChildModeLocked ? (
                    <Lock
                      aria-hidden="true"
                      className="size-3.5 text-emerald-700"
                    />
                  ) : (
                    <ShieldCheck
                      aria-hidden="true"
                      className="size-3.5 text-primary"
                    />
                  )}
                  <span className="hidden sm:inline">
                    {isChildModeLocked
                      ? t("parent.childModePin.lockedPill")
                      : t("parent.childModePin.unlockedPill")}
                  </span>
                </button>
              ) : null}

              {!isChildOnboarding && !isChildModeLocked ? (
                <GlobalTaskCenter
                  hideOnPaths={["/children/new"]}
                  variant="drawer-only"
                />
              ) : null}

              <ParentAccountDropdown
                appStore={appStore}
                availableChildren={availableChildren}
                avatarUrl={profile?.avatar_url}
                displayName={displayName}
                email={email}
                hideAiTasks={isChildOnboarding}
                isSigningOut={isSigningOut}
                onBeforeOpen={() => setChildSwitcherOpenForPath(null)}
                onSignOut={handleSignOut}
                pathname={pathname}
                roleLabel={resolvedRoleLabel}
                selectedChild={selectedChild}
                userId={userId}
              />
            </div>
          </nav>
          {hasSignOutError ? (
            <p
              className="mx-auto mt-3 w-full max-w-[1376px] pb-2 text-label font-semibold text-danger"
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
            {isProtectedByChildLock ? (
              <section
                className="mx-auto my-8 max-w-md space-y-4 rounded-card border border-primary/25 bg-cream p-6 text-center shadow-2xs"
                data-testid="child-mode-route-guard"
              >
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-white text-primary shadow-2xs">
                  <Lock aria-hidden="true" className="size-6" />
                </div>
                <h1 className="text-xl font-extrabold text-ink">
                  {t("parent.childModePin.routeGuardTitle")}
                </h1>
                <p className="text-sm text-muted">
                  {t("parent.childModePin.routeGuardDesc")}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <button
                    className="inline-flex min-h-10 items-center justify-center rounded-control border border-border bg-white px-4 py-2 text-sm font-bold text-ink hover:bg-sky/50"
                    onClick={() => router.push("/dashboard")}
                    type="button"
                  >
                    {t("parent.childModePin.backToChildDesk")}
                  </button>
                  <button
                    className="inline-flex min-h-10 items-center justify-center rounded-control bg-primary px-4 py-2 text-sm font-bold text-white hover:bg-primary-hover"
                    data-testid="child-mode-guard-unlock-btn"
                    onClick={() => setPinModalMode("unlock")}
                    type="button"
                  >
                    {t("parent.childModePin.unlockButton")}
                  </button>
                </div>
              </section>
            ) : (
              children
            )}
          </ButtonSizeContext.Provider>
        </main>

        <ParentPinModal
          hasExistingPin={hasParentPin}
          isOpen={pinModalMode !== null || isProtectedByChildLock}
          mode={isProtectedByChildLock ? "unlock" : (pinModalMode ?? "setup")}
          onClose={() => {
            setPinModalMode(null);
            if (isProtectedByChildLock) {
              router.push("/dashboard");
            }
          }}
          onPinConfigured={() => {
            if (userId) {
              setPinState({ userId, hasPin: true });
            }
            setChildModeLockedForUser(userId, true);
            setPinModalMode(null);
            if (isParentProtectedRoute(pathname)) {
              router.push("/dashboard");
            }
          }}
          onPinRemoved={() => {
            if (userId) {
              setPinState({ userId, hasPin: false });
            }
            setChildModeLockedForUser(userId, false);
            setPinModalMode(null);
          }}
          onPinVerified={() => {
            setChildModeLockedForUser(userId, false);
            setPinModalMode(null);
          }}
        />

        <SiteFooter className="hidden lg:block" variant="parent" />

        {!isChildOnboarding && !isMobileImmersive ? (
          <MobileBottomNav pathname={pathname} />
        ) : null}
      </div>
    </AiTaskCenterProvider>
  );
}
