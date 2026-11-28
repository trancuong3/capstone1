import type { AssistantRoleScope } from "@/types/assistant";

const AUTH_PATHS = new Set([
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/admin/login",
]);

export const PUBLIC_ASSISTANT_NAV_ALLOWLIST = new Set<string>([
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/admin/login",
]);

export const PARENT_ASSISTANT_NAV_ALLOWLIST = new Set<string>([
  "/dashboard",
  "/books",
  "/my-books",
  "/book-scanner",
  "/children",
  "/children/new",
  "/profile",
  "/settings",
  "/reports",
  "/reports/difficult-words",
  "/sessions",
  "/reading-management",
  "/reading-preparation",
  "/entertainment",
  "/entertainment/memory-game",
  "/entertainment/sentence-shooter",
  "/entertainment/picture-description",
  "/karaoke",
  "/device-permissions",
  "/help-support",
  "/book-reports",
  "/studio/tasks",
]);

export const ADMIN_ASSISTANT_NAV_ALLOWLIST = new Set<string>([
  ...PARENT_ASSISTANT_NAV_ALLOWLIST,
  "/admin",
  "/admin/books",
  "/admin/books/new",
  "/admin/metadata-quality",
  "/admin/viread-training",
  "/admin/health",
  "/admin/audit-logs",
  "/admin/parents",
  "/admin/karaoke",
  "/admin/karaoke/new",
  "/admin/tasks",
]);

export function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.has(pathname);
}

export function isReadingSessionPath(pathname: string): boolean {
  return pathname === "/reading" || pathname.startsWith("/reading/");
}

export function isAdminPath(pathname: string): boolean {
  return (
    (pathname === "/admin" || pathname.startsWith("/admin/")) &&
    pathname !== "/admin/login"
  );
}

export function inferAssistantRoleScope(
  pathname: string,
  explicitScope?: AssistantRoleScope,
): AssistantRoleScope {
  if (explicitScope) {
    return explicitScope;
  }
  if (isAuthPath(pathname)) {
    return "public";
  }
  if (isAdminPath(pathname)) {
    return "admin";
  }
  return "parent";
}

export function isSafeAssistantNavigationHref(
  href: string | null | undefined,
  currentPathname: string,
  explicitScope?: AssistantRoleScope,
): href is string {
  if (!href || !href.startsWith("/") || href.startsWith("//")) {
    return false;
  }
  if (
    href.includes("://") ||
    href.includes("?") ||
    href.includes("#") ||
    href.includes("..")
  ) {
    return false;
  }
  const normalizedCurrent = (currentPathname || "/").split("?")[0] || "/";
  if (href === normalizedCurrent) {
    return false;
  }
  const scope = inferAssistantRoleScope(normalizedCurrent, explicitScope);
  if (scope === "public") {
    return PUBLIC_ASSISTANT_NAV_ALLOWLIST.has(href);
  }
  if (scope === "parent") {
    if (isAdminPath(href)) {
      return false;
    }
    return PARENT_ASSISTANT_NAV_ALLOWLIST.has(href);
  }
  return ADMIN_ASSISTANT_NAV_ALLOWLIST.has(href);
}

export function isSafeAssistantQuickActionHref(
  href: string | null | undefined,
  currentPathname: string,
  explicitScope?: AssistantRoleScope,
): href is string {
  if (!href || !href.startsWith("/") || href.startsWith("//")) {
    return false;
  }
  if (
    href.includes("://") ||
    href.includes("?") ||
    href.includes("#") ||
    href.includes("..")
  ) {
    return false;
  }
  const normalizedCurrent = (currentPathname || "/").split("?")[0] || "/";
  const scope = inferAssistantRoleScope(normalizedCurrent, explicitScope);
  if (scope === "public") {
    return PUBLIC_ASSISTANT_NAV_ALLOWLIST.has(href);
  }
  if (scope === "parent") {
    if (isAdminPath(href)) {
      return false;
    }
    return (
      PARENT_ASSISTANT_NAV_ALLOWLIST.has(href) ||
      PUBLIC_ASSISTANT_NAV_ALLOWLIST.has(href)
    );
  }
  return (
    ADMIN_ASSISTANT_NAV_ALLOWLIST.has(href) ||
    PUBLIC_ASSISTANT_NAV_ALLOWLIST.has(href)
  );
}

export function hasMobileBottomNavPath(pathname: string): boolean {
  if (isAuthPath(pathname) || isReadingSessionPath(pathname)) {
    return false;
  }
  if (
    pathname === "/children/new" ||
    pathname === "/books" ||
    pathname.startsWith("/books/")
  ) {
    return false;
  }
  if (pathname.startsWith("/sessions/") && pathname.endsWith("/report")) {
    return false;
  }
  return true;
}
