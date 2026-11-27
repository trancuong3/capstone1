import { NextResponse, type NextRequest } from "next/server";

import { readPlaywrightAuthFixture } from "@/lib/auth/playwright-auth-fixture";
import {
  buildLoginRedirectPath,
  getProtectedRouteArea,
  getProtectedRouteRedirect,
  getRoleHome,
} from "@/lib/auth/route-policy";
import {
  preserveSupabaseAuthResponse,
  refreshSupabaseAuth,
} from "@/lib/supabase/proxy";

function redirectWithAuthState(
  request: NextRequest,
  destination: string,
  authResponse: NextResponse,
  nextPath?: string,
) {
  const url = request.nextUrl.clone();
  url.pathname = destination;
  url.search = "";
  if (nextPath) {
    url.searchParams.set("next", nextPath);
  }

  return preserveSupabaseAuthResponse(authResponse, NextResponse.redirect(url));
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const currentPathWithQuery = `${pathname}${request.nextUrl.search}`;
  const protectedArea = getProtectedRouteArea(pathname);
  const fixtureRole = readPlaywrightAuthFixture(request.headers);

  request.headers.set("x-viread-next", currentPathWithQuery);

  if (fixtureRole) {
    const destination =
      getProtectedRouteRedirect(pathname, fixtureRole) ??
      (pathname === "/admin" && fixtureRole === "admin"
        ? "/admin/parents"
        : null);
    return destination
      ? NextResponse.redirect(
          new URL(
            destination === "/login" || destination === "/admin/login"
              ? buildLoginRedirectPath(destination, currentPathWithQuery)
              : destination,
            request.url,
          ),
        )
      : NextResponse.next({ request });
  }

  const auth = await refreshSupabaseAuth(request);

  if (pathname === "/" && auth.userId) {
    return redirectWithAuthState(
      request,
      auth.role ? getRoleHome(auth.role) : getRoleHome("parent"),
      auth.response,
    );
  }

  if (pathname === "/admin" && auth.userId) {
    return redirectWithAuthState(
      request,
      auth.role === "parent" ? getRoleHome("parent") : "/admin/parents",
      auth.response,
    );
  }

  if (protectedArea && !auth.userId) {
    return redirectWithAuthState(
      request,
      protectedArea === "admin" ? "/admin/login" : "/login",
      auth.response,
      currentPathWithQuery,
    );
  }

  return auth.response;
}

export const config = {
  matcher: [
    "/((?!api/|_next/static|_next/image|wasm/|sounds/|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|wasm|onnx|mp3|wav|ogg|json|mjs|map)$).*)",
  ],
};
