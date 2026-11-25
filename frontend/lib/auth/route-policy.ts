import type { ParentRole } from "@/types/profile";

export type ProtectedRouteArea = "admin" | "parent";

export const AUTH_NEXT_COOKIE = "viread_auth_next";

const parentRoutePrefixes = [
  "/dashboard",
  "/profile",
  "/children",
  "/books",
  "/my-books",
  "/book-reports",
  "/book-scanner",
  "/device-permissions",
  "/entertainment",
  "/help-support",
  "/reading",
  "/reading-management",
  "/reading-preparation",
  "/sessions",
  "/reports",
  "/karaoke",
  "/settings",
] as const;

const authRoutePrefixes = [
  "/login",
  "/admin/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/auth/callback",
] as const;

const CONTROL_OR_BACKSLASH_RE = /[\x00-\x1f\x7f\\]/;

function matchesRoutePrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isAuthRoute(pathname: string): boolean {
  return authRoutePrefixes.some((prefix) =>
    matchesRoutePrefix(pathname, prefix),
  );
}

function parseSafeRelativeUrl(raw: string | null | undefined): URL | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim();
  if (!candidate) return null;
  if (CONTROL_OR_BACKSLASH_RE.test(candidate)) return null;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate, "https://viread.local");
  } catch {
    return null;
  }

  if (parsed.origin !== "https://viread.local") return null;
  if (parsed.pathname.startsWith("//")) return null;

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  if (
    CONTROL_OR_BACKSLASH_RE.test(decodedPathname) ||
    decodedPathname.startsWith("//")
  ) {
    return null;
  }

  if (isAuthRoute(parsed.pathname)) return null;

  return parsed;
}

export function getProtectedRouteArea(
  pathname: string,
): ProtectedRouteArea | null {
  if (matchesRoutePrefix(pathname, "/admin") && pathname !== "/admin/login") {
    return "admin";
  }

  return parentRoutePrefixes.some((prefix) =>
    matchesRoutePrefix(pathname, prefix),
  )
    ? "parent"
    : null;
}

export function getRoleHome(role: ParentRole) {
  return role === "admin" ? "/admin/books" : "/dashboard";
}

export function getProtectedRouteRedirect(
  pathname: string,
  role: ParentRole | null,
): string | null {
  const area = getProtectedRouteArea(pathname);
  if (!area) return null;

  if (!role) {
    return area === "admin" ? "/admin/login" : "/login";
  }

  return role === area ? null : getRoleHome(role);
}

export function isSafeRelativeNextCandidate(
  raw: string | null | undefined,
): string | null {
  const parsed = parseSafeRelativeUrl(raw);
  if (!parsed) return null;
  if (!getProtectedRouteArea(parsed.pathname)) return null;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function sanitizeNextPath(
  raw: string | null | undefined,
  role: ParentRole,
): string {
  const parsed = parseSafeRelativeUrl(raw);
  if (!parsed) return getRoleHome(role);

  const area = getProtectedRouteArea(parsed.pathname);
  if (area !== role) {
    return getRoleHome(role);
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function buildLoginRedirectPath(
  loginPath: "/login" | "/admin/login",
  nextPath: string | null | undefined,
): string {
  const safeNext = isSafeRelativeNextCandidate(nextPath);
  if (!safeNext) return loginPath;
  return `${loginPath}?next=${encodeURIComponent(safeNext)}`;
}
