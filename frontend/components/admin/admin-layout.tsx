"use client";

import {
  BookOpenCheck,
  BrainCircuit,
  ClipboardCheck,
  HeartPulse,
  LogOut,
  Music2,
  ScrollText,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { clearAdminBookAiBatchSessions } from "@/components/admin/admin-book-ai-batch-review";
import { Button, ButtonSizeContext } from "@/components/common/button";
import { ViReadLogo } from "@/components/common/viread-logo";
import { LanguageSelector } from "@/components/i18n/language-selector";
import {
  ADMIN_MOBILE_MORE_ITEMS,
  ADMIN_MOBILE_PRIMARY_TABS,
  MobileBottomNav,
} from "@/components/layout/mobile-bottom-nav";
import { SiteFooter } from "@/components/layout/site-footer";
import { GlobalTaskCenter } from "@/components/tasks/global-task-center";
import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import { clearAdminBookUploadSessions } from "@/lib/admin/admin-book-upload-session";
import { clearPrivateMediaMemoryCache } from "@/lib/api/api-client";
import {
  broadcastActorSwitch,
  clearGlobalTasksMemoryCache,
} from "@/lib/api/global-tasks-service";
import { resetApiReadCacheForActorSwitch } from "@/lib/api/read-cache";
import { clearUserCache } from "@/lib/cache/user-query-cache";
import { cn } from "@/lib/utils/cn";

const navGroups = [
  {
    id: "content",
    labelKey: "layout.groups.content",
    fallbackLabel: "Nội dung",
    items: [
      {
        href: "/admin/books",
        labelKey: "layout.nav.books",
        icon: BookOpenCheck,
      },
      {
        href: "/admin/metadata-quality",
        labelKey: "layout.nav.metadataQuality",
        icon: ClipboardCheck,
      },
      {
        href: "/admin/karaoke",
        labelKey: "layout.nav.karaoke",
        icon: Music2,
      },
    ],
  },
  {
    id: "users",
    labelKey: "layout.groups.users",
    fallbackLabel: "Người dùng",
    items: [
      {
        href: "/admin/parents",
        labelKey: "layout.nav.parents",
        icon: UsersRound,
      },
    ],
  },
  {
    id: "system",
    labelKey: "layout.groups.systemAi",
    fallbackLabel: "Hệ thống & AI",
    items: [
      {
        href: "/admin/viread-training",
        labelKey: "layout.nav.training",
        icon: BrainCircuit,
      },
      {
        href: "/admin/health",
        labelKey: "layout.nav.health",
        icon: HeartPulse,
      },
      {
        href: "/admin/audit-logs",
        labelKey: "layout.nav.auditLogs",
        icon: ScrollText,
      },
    ],
  },
] as const;

export function AdminLayout({ children }: { children: ReactNode }) {
  const { auth } = useAdminServices();
  const taskCenter = useOptionalAiTaskCenter();
  const t = useTranslations("admin");
  const pathname = usePathname();
  const router = useRouter();
  const activeNavigationRef = useRef<HTMLAnchorElement>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [hasSignOutError, setHasSignOutError] = useState(false);
  const [isDesktopSidebar, setIsDesktopSidebar] = useState(false);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const syncViewport = () => setIsDesktopSidebar(mediaQuery.matches);
    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);
    return () => mediaQuery.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    const activeLink = activeNavigationRef.current;
    const navContainer = activeLink?.closest("nav");
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

  async function handleSignOut() {
    if (isSigningOut) return;

    setHasSignOutError(false);
    setIsSigningOut(true);
    try {
      taskCenter?.clearForLogout();
      clearGlobalTasksMemoryCache();
      clearAdminBookUploadSessions();
      clearAdminBookAiBatchSessions();
      clearPrivateMediaMemoryCache();
      clearUserCache();
      resetApiReadCacheForActorSwitch();
      broadcastActorSwitch();
      await auth.signOut();
      router.replace("/admin/login");
      router.refresh();
    } catch {
      setHasSignOutError(true);
    } finally {
      setIsSigningOut(false);
    }
  }

  if (pathname === "/admin/login") return <>{children}</>;

  return (
    <ButtonSizeContext.Provider value="admin">
      <div
        className="flex min-h-dvh w-full flex-col bg-admin-canvas lg:flex-row"
        data-admin-workspace="true"
      >
        <a
          className="sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[100] focus:not-sr-only focus:rounded-control focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-primary focus:shadow-lg"
          href="#admin-main-content"
        >
          {t("layout.skipToContent")}
        </a>

        <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-white/95 backdrop-blur-sm lg:flex lg:h-dvh lg:w-60 lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-e lg:border-border lg:bg-admin-sidebar lg:backdrop-blur-none">
          <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between gap-2 px-3 sm:px-5 lg:mx-0 lg:h-auto lg:min-h-full lg:max-w-none lg:flex-col lg:items-stretch lg:justify-start lg:gap-5 lg:px-3.5 lg:py-5">
            <div className="flex min-h-10 min-w-0 items-center gap-2 sm:gap-2.5 lg:border-b lg:border-[#cfe3db] lg:px-1.5 lg:pb-4">
              <ViReadLogo
                ariaLabel={t("layout.logoAria")}
                href="/admin/parents"
                size="md"
              />
              <span className="hidden shrink-0 whitespace-nowrap rounded-full border border-[#c2ddd3] bg-sky/75 px-2 py-0.5 text-[11px] font-bold tracking-wide text-primary-hover min-[440px]:inline-flex">
                {t("layout.badge")}
              </span>
            </div>

            <nav
              aria-label={t("layout.navAria")}
              className="hidden min-w-0 flex-1 flex-col gap-4 lg:flex"
            >
              {navGroups.map((group) => (
                <div className="space-y-1" key={group.id}>
                  <p className="px-2.5 text-[11px] font-bold uppercase tracking-wider text-muted/85">
                    {t(group.labelKey, undefined, group.fallbackLabel)}
                  </p>
                  <ul className="space-y-0.5">
                    {group.items.map(({ href, labelKey, icon: Icon }) => {
                      const isActive =
                        pathname === href || pathname.startsWith(`${href}/`);
                      return (
                        <li key={href}>
                          <Link
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "flex min-h-10 items-center gap-2.5 rounded-control px-2.5 py-2 text-sm font-semibold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                              isActive
                                ? "bg-primary text-white shadow-2xs"
                                : "text-ink hover:bg-[#dcefe7] hover:text-primary-hover",
                            )}
                            href={href}
                            ref={isActive ? activeNavigationRef : undefined}
                          >
                            <Icon
                              aria-hidden="true"
                              className={cn(
                                "size-4 shrink-0",
                                isActive ? "text-white" : "text-primary",
                              )}
                            />
                            <span className="truncate">{t(labelKey)}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>

            <div className="ms-auto flex shrink-0 items-center gap-1.5 sm:gap-2 lg:ms-0 lg:mt-auto lg:flex-col lg:items-stretch lg:gap-2 lg:border-t lg:border-[#cfe3db] lg:pt-4">
              <GlobalTaskCenter
                className="lg:w-full lg:justify-between lg:rounded-control lg:px-3"
                hideOnPaths={["/admin/login"]}
                variant={isDesktopSidebar ? "sidebar" : "topbar"}
              />
              <LanguageSelector
                align="end"
                className="max-[380px]:max-w-[7.25rem] [&>button]:min-h-10 [&>button]:py-1.5 lg:w-full lg:[&>button]:border lg:[&>button]:border-border"
                presentation={isDesktopSidebar ? "sheet" : "auto"}
                variant={isDesktopSidebar ? "menu" : "compact"}
              />
              <Button
                className="shrink-0 lg:w-full lg:justify-start"
                disabled={isSigningOut}
                isLoading={isSigningOut}
                onClick={() => void handleSignOut()}
                size="admin"
                type="button"
                variant="outline"
              >
                {!isSigningOut ? (
                  <LogOut aria-hidden="true" className="size-4 shrink-0" />
                ) : null}
                <span className="max-[400px]:sr-only">
                  {isSigningOut ? t("layout.signingOut") : t("layout.signOut")}
                </span>
              </Button>
            </div>
          </div>
        </header>

        <div className="flex min-w-0 flex-1 flex-col">
          {hasSignOutError ? (
            <p
              className="mx-auto mt-4 w-full max-w-[1360px] px-4 text-sm font-semibold text-danger sm:px-6 lg:px-8"
              role="alert"
            >
              {t("layout.signOutError")}
            </p>
          ) : null}
          <main
            className="mx-auto w-full min-w-0 max-w-[1360px] flex-1 tabular-nums px-4 pb-24 pt-5 sm:px-6 sm:pt-6 lg:px-8 lg:py-8"
            id="admin-main-content"
            tabIndex={-1}
          >
            {children}
          </main>
          <SiteFooter className="hidden lg:block" variant="admin" />
        </div>

        <MobileBottomNav
          ariaLabel={t("layout.mobileNavAria")}
          hideAbove="lg"
          moreItems={ADMIN_MOBILE_MORE_ITEMS}
          moreTitle={t("layout.moreTitle")}
          pathname={pathname}
          sheetId="admin-mobile-more-sheet"
          tabs={ADMIN_MOBILE_PRIMARY_TABS}
        />
      </div>
    </ButtonSizeContext.Provider>
  );
}
