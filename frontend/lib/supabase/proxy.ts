import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabasePublicConfig } from "@/lib/supabase/config";

const refreshResponseHeaders = ["cache-control", "expires", "pragma"] as const;

export interface SupabaseProxyAuthResult {
  readonly response: NextResponse;
  readonly userId: string | null;
}

export async function refreshSupabaseAuth(
  request: NextRequest,
): Promise<SupabaseProxyAuthResult> {
  let response = NextResponse.next({ request });
  const { publishableKey, url } = getSupabasePublicConfig();
  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, responseHeaders) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });

        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, options, value }) => {
          response.cookies.set(name, value, options);
        });
        Object.entries(responseHeaders).forEach(([name, value]) => {
          response.headers.set(name, value);
        });
      },
    },
  });

  // Keep this call immediately after client creation. It validates the JWT and
  // lets @supabase/ssr refresh request/response cookies before Server Components.
  const { data, error } = await supabase.auth.getClaims();
  const subject = data?.claims.sub;

  return {
    response,
    userId: !error && typeof subject === "string" && subject ? subject : null,
  };
}

export function preserveSupabaseAuthResponse(
  source: NextResponse,
  target: NextResponse,
) {
  source.cookies.getAll().forEach((cookie) => {
    target.cookies.set(cookie);
  });

  refreshResponseHeaders.forEach((name) => {
    const value = source.headers.get(name);
    if (value !== null) target.headers.set(name, value);
  });

  return target;
}
