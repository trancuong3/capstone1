import type { ParentRole } from "@/types/profile";

export type ProtectedRouteArea = "admin" | "parent";

const parentRoutePrefixes = [
  "/dashboard",
  "/profile",
  "/children",
  "/books",
  "/reading",
  "/sessions",
  "/reports",
] as const;

function matchesRoutePrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
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
