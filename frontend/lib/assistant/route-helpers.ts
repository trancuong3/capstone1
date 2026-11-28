const AUTH_PATHS = new Set([
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/admin/login",
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
