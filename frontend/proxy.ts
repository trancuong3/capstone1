import { NextResponse, type NextRequest } from "next/server";

import { readPlaywrightAuthFixture } from "@/lib/auth/playwright-auth-fixture";
import {
  getProtectedRouteArea,
  getProtectedRouteRedirect,
} from "@/lib/auth/route-policy";
import {
  preserveSupabaseAuthResponse,
  refreshSupabaseAuth,
} from "@/lib/supabase/proxy";

function redirectWithAuthState(
  request: NextRequest,
  destination: string,
  authResponse: NextResponse,
) {
  const url = request.nextUrl.clone();
  url.pathname = destination;
  url.search = "";

  return preserveSupabaseAuthResponse(authResponse, NextResponse.redirect(url));
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const protectedArea = getProtectedRouteArea(pathname);
  const fixtureRole = readPlaywrightAuthFixture(request.headers);

  if (fixtureRole) {
    const destination = getProtectedRouteRedirect(pathname, fixtureRole);
    return destination
      ? NextResponse.redirect(new URL(destination, request.url))
      : NextResponse.next();
  }

  const auth = await refreshSupabaseAuth(request);

  if (protectedArea && !auth.userId) {
    return redirectWithAuthState(
      request,
      protectedArea === "admin" ? "/admin/login" : "/login",
      auth.response,
    );
  }

  return auth.response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
