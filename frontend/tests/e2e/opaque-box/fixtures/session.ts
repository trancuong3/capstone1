import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
  Request,
} from "@playwright/test";
import { stringToBase64URL } from "@supabase/ssr";

import { createPlaywrightAuthFixtureHeaders } from "@/lib/auth/playwright-auth-fixture";
import type { SupportedLocale } from "@/lib/i18n/locales";
import type { ParentRole } from "@/types/profile";

import {
  OPAQUE_ADMIN_ID,
  OPAQUE_NOW_ISO,
  OPAQUE_PARENT_ID,
  OPAQUE_SUPABASE_URL,
  makeAdminCatalogItem,
  makeAdminHealthSnapshot,
  makeAssistantChatReply,
  makeCatalogBook,
  makeChildProfile,
  makeDashboardSummary,
  makeGlobalTaskList,
  makeHealthPayload,
  makeParentProfile,
} from "./test-data";

export { OPAQUE_ADMIN_ID, OPAQUE_PARENT_ID };

export type OpaqueRole = "guest" | "parent" | "admin" | "android";

export const DEFAULT_OPAQUE_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 ViReadAndroid/1.0";

export interface CreateRoleContextOptions {
  readonly baseURL?: string;
  readonly locale?: SupportedLocale;
  readonly appRole?: ParentRole | "guest";
  readonly selectedChildId?: string;
  readonly userAgent?: string;
  readonly extraHTTPHeaders?: Readonly<Record<string, string>>;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly onRefreshToken?: () => string;
}

export interface RoleContextHandle {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly role: OpaqueRole;
  readonly effectiveRole: ParentRole | null;
  readonly userId: string | null;
  readonly baseURL: string;
  getAccessToken(): string | null;
  dispose(): Promise<void>;
}

export interface ApiMockRequestContext {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly postDataText: string | null;
  readonly postDataJson: unknown;
}

export interface ApiMockResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly contentType?: string;
  readonly body: unknown;
}

export type ApiRouteHandler =
  | ApiMockResponse
  | ((
      ctx: ApiMockRequestContext,
    ) =>
      | Promise<ApiMockResponse | null | undefined>
      | ApiMockResponse
      | null
      | undefined);

export type ApiMockHandlers =
  | Record<string, ApiRouteHandler>
  | ((
      ctx: ApiMockRequestContext,
    ) =>
      | Promise<ApiMockResponse | null | undefined>
      | ApiMockResponse
      | null
      | undefined);

export type ApiUnmatchedMode = "passthrough" | "default-mock" | "strict-501";

export interface InstallApiMockOptions {
  readonly unmatchedMode?: ApiUnmatchedMode;
}

export interface RecordedApiRequest {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly ts: number;
}

export interface ApiMockHandle {
  readonly isLive: boolean;
  readonly apiOrigin: string;
  getRequests(): readonly RecordedApiRequest[];
  resetRequests(): void;
}

export interface PageErrorCollector {
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  assertNoErrors(): void;
  reset(): void;
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
};

function makeFakeJwt(sub: string, role: ParentRole): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      aud: "authenticated",
      exp: nowSec + 36_000,
      iat: nowSec - 60,
      role: "authenticated",
      sub,
      user_metadata: { role },
    }),
    "utf8",
  ).toString("base64url");
  return `${header}.${payload}.synthetic-opaque-e2e-signature`;
}

function buildSupabaseSession(userId: string, role: ParentRole, token: string) {
  return {
    access_token: token,
    token_type: "bearer",
    expires_in: 36_000,
    expires_at: Math.floor(Date.now() / 1000) + 36_000,
    refresh_token: "synthetic-opaque-refresh-token",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: role === "admin" ? "admin@viread.local" : "parent@viread.local",
      user_metadata: { role },
      app_metadata: { provider: "email" },
      created_at: OPAQUE_NOW_ISO,
    },
  };
}

function resolveDefaultBaseUrl(explicit?: string): string {
  const port = process.env.PLAYWRIGHT_OPAQUE_PORT?.trim() || "3299";
  return (
    explicit?.trim() ||
    process.env.PLAYWRIGHT_BASE_URL?.trim() ||
    `http://127.0.0.1:${port}`
  );
}

function resolveApiOrigin(): string {
  const liveUrl = process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim();
  if (liveUrl) {
    return liveUrl.replace(/\/+$/, "");
  }
  const apiPort = process.env.VIREAD_OPAQUE_API_PORT?.trim() || "18180";
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  return (configured || `http://127.0.0.1:${apiPort}`).replace(/\/+$/, "");
}

function resolveSupabaseCookieName(): string {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || OPAQUE_SUPABASE_URL;
  try {
    const projectRef = new URL(supabaseUrl).hostname.split(".")[0] || "example";
    return `sb-${projectRef}-auth-token`;
  } catch {
    return "sb-example-auth-token";
  }
}

export async function createRoleContext(
  browser: Browser,
  role: OpaqueRole,
  options: CreateRoleContextOptions = {},
): Promise<RoleContextHandle> {
  const baseURL = resolveDefaultBaseUrl(options.baseURL);
  const effectiveRole: ParentRole | null =
    role === "guest"
      ? null
      : role === "android"
        ? options.appRole === "guest"
          ? null
          : (options.appRole ?? "parent")
        : role;

  const userId =
    effectiveRole === "admin"
      ? OPAQUE_ADMIN_ID
      : effectiveRole === "parent"
        ? OPAQUE_PARENT_ID
        : null;

  const fixtureToken = process.env.PLAYWRIGHT_AUTH_FIXTURE_TOKEN?.trim() || "";
  if (effectiveRole !== null && fixtureToken.length < 32) {
    throw new Error(
      "PLAYWRIGHT_AUTH_FIXTURE_TOKEN must be set (>= 32 chars) before calling createRoleContext for authenticated roles.",
    );
  }

  const mergedHeaders: Record<string, string> = {
    ...(effectiveRole !== null
      ? createPlaywrightAuthFixtureHeaders(effectiveRole, fixtureToken)
      : {}),
    ...(options.extraHTTPHeaders ?? {}),
  };

  const contextOptions: BrowserContextOptions = {
    baseURL,
    ...(Object.keys(mergedHeaders).length > 0
      ? { extraHTTPHeaders: mergedHeaders }
      : {}),
    ...(role === "android"
      ? {
          userAgent: options.userAgent ?? DEFAULT_OPAQUE_ANDROID_UA,
          viewport: options.viewport ?? { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
        }
      : {
          ...(options.userAgent ? { userAgent: options.userAgent } : {}),
          ...(options.viewport ? { viewport: options.viewport } : {}),
        }),
  };

  const context = await browser.newContext(contextOptions);

  let activeToken: string | null =
    effectiveRole && userId ? makeFakeJwt(userId, effectiveRole) : null;

  const initialSession =
    effectiveRole && userId && activeToken
      ? buildSupabaseSession(userId, effectiveRole, activeToken)
      : null;

  await context.route("https://*.supabase.co/**", async (route) => {
    const reqUrl = new URL(route.request().url());
    if (!effectiveRole || !userId || !initialSession) {
      if (reqUrl.pathname.startsWith("/auth/v1/token")) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "invalid_grant" }),
        });
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ message: "JWT missing" }),
      });
      return;
    }

    if (reqUrl.pathname.startsWith("/auth/v1/token")) {
      activeToken =
        options.onRefreshToken?.() ?? makeFakeJwt(userId, effectiveRole);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          buildSupabaseSession(userId, effectiveRole, activeToken),
        ),
      });
      return;
    }

    if (reqUrl.pathname.startsWith("/rest/v1/profiles")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: userId, role: effectiveRole, active: 1 }]),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(initialSession.user),
    });
  });

  const cookiesToSet: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    url?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
  }> = [];

  if (initialSession) {
    cookiesToSet.push({
      name: resolveSupabaseCookieName(),
      value: `base64-${stringToBase64URL(JSON.stringify(initialSession))}`,
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    });
  }

  if (options.locale) {
    cookiesToSet.push({
      name: "viread_locale",
      value: options.locale,
      url: baseURL,
    });
  }

  if (cookiesToSet.length > 0) {
    await context.addCookies(cookiesToSet);
  }

  if (options.selectedChildId && userId) {
    await context.addInitScript(
      ({ ownerId, childId }) => {
        try {
          window.sessionStorage.setItem(
            `viread:selected-child:${ownerId}`,
            childId,
          );
        } catch {
          // Ignore restricted storage contexts.
        }
      },
      { ownerId: userId, childId: options.selectedChildId },
    );
  }

  const page = await context.newPage();

  return {
    context,
    page,
    role,
    effectiveRole,
    userId,
    baseURL,
    getAccessToken: () => activeToken,
    dispose: () => context.close(),
  };
}

function buildDefaultMockBody(
  method: string,
  pathname: string,
  postDataJson: unknown,
): { status: number; body: unknown } {
  if (method === "GET" && pathname === "/health") {
    return { status: 200, body: makeHealthPayload() };
  }
  if (method === "GET" && pathname === "/profiles/me") {
    return { status: 200, body: makeParentProfile() };
  }
  if (method === "GET" && pathname === "/profiles/children") {
    return { status: 200, body: [makeChildProfile()] };
  }
  if (method === "GET" && pathname === "/profiles/dashboard-summary") {
    return { status: 200, body: makeDashboardSummary() };
  }
  if (
    method === "GET" &&
    (pathname === "/books/catalog" || pathname === "/books/")
  ) {
    return { status: 200, body: [makeCatalogBook()] };
  }
  if (method === "GET" && pathname === "/books/admin/catalog") {
    return { status: 200, body: [makeAdminCatalogItem()] };
  }
  if (method === "GET" && pathname === "/system/admin/health") {
    return { status: 200, body: makeAdminHealthSnapshot() };
  }
  if (method === "GET" && pathname === "/studio/tasks") {
    return { status: 200, body: makeGlobalTaskList() };
  }
  if (method === "GET" && pathname === "/voice/status") {
    return { status: 200, body: { available: false, mode: "browser" } };
  }
  if (method === "POST" && pathname === "/assistant/chat") {
    const payload =
      postDataJson && typeof postDataJson === "object"
        ? (postDataJson as Record<string, unknown>)
        : {};
    const message =
      typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "Xin chào";
    return {
      status: 200,
      body: makeAssistantChatReply({ reply: `Gợi ý ViRead: ${message}` }),
    };
  }
  return { status: 200, body: { ok: true } };
}

function safeRequestJson(request: Request): unknown {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

export async function installApiMock(
  page: Page,
  handlers?: ApiMockHandlers,
  options: InstallApiMockOptions = {},
): Promise<ApiMockHandle> {
  const liveUrl = process.env.VIREAD_OPAQUE_LIVE_API_URL?.trim();
  const isLive = Boolean(liveUrl);
  const apiOrigin = resolveApiOrigin();
  const unmatchedMode: ApiUnmatchedMode =
    options.unmatchedMode ?? "passthrough";
  const requests: RecordedApiRequest[] = [];

  if (isLive) {
    page.on("request", (req) => {
      const urlStr = req.url();
      if (!urlStr.startsWith(apiOrigin) || req.method() === "OPTIONS") {
        return;
      }
      const parsed = new URL(urlStr);
      requests.push({
        method: req.method().toUpperCase(),
        path: parsed.pathname,
        url: urlStr,
        ts: Date.now(),
      });
    });
    return {
      isLive: true,
      apiOrigin,
      getRequests: () => [...requests],
      resetRequests: () => {
        requests.length = 0;
      },
    };
  }

  await page.route(`${apiOrigin}/**`, async (route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const urlStr = req.url();
    const parsedUrl = new URL(urlStr);
    const pathname = parsedUrl.pathname;

    if (method === "OPTIONS") {
      if (unmatchedMode === "passthrough") {
        await route.continue();
        return;
      }
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }

    requests.push({
      method,
      path: pathname,
      url: urlStr,
      ts: Date.now(),
    });

    const ctx: ApiMockRequestContext = {
      method,
      pathname,
      url: parsedUrl,
      headers: req.headers(),
      postDataText: req.postData(),
      postDataJson: safeRequestJson(req),
    };

    let customResponse: ApiMockResponse | null | undefined;
    if (typeof handlers === "function") {
      customResponse = await handlers(ctx);
    } else if (handlers) {
      const entry =
        handlers[`${method} ${pathname}`] ?? handlers[pathname] ?? undefined;
      if (typeof entry === "function") {
        customResponse = await entry(ctx);
      } else if (entry !== undefined) {
        customResponse = entry;
      }
    }

    if (customResponse) {
      const body =
        typeof customResponse.body === "string" ||
        Buffer.isBuffer(customResponse.body)
          ? customResponse.body
          : JSON.stringify(customResponse.body);
      await route.fulfill({
        status: customResponse.status ?? 200,
        headers: {
          ...CORS_HEADERS,
          ...(customResponse.headers ?? {}),
        },
        contentType: customResponse.contentType ?? "application/json",
        body,
      });
      return;
    }

    if (unmatchedMode === "passthrough") {
      await route.continue();
      return;
    }

    if (unmatchedMode === "strict-501") {
      await route.fulfill({
        status: 501,
        headers: CORS_HEADERS,
        contentType: "application/json",
        body: JSON.stringify({
          detail: `UNMOCKED_OPAQUE_ROUTE: ${method} ${pathname}`,
        }),
      });
      return;
    }

    const fallback = buildDefaultMockBody(method, pathname, ctx.postDataJson);
    await route.fulfill({
      status: fallback.status,
      headers: CORS_HEADERS,
      contentType: "application/json",
      body: JSON.stringify(fallback.body),
    });
  });

  return {
    isLive: false,
    apiOrigin,
    getRequests: () => [...requests],
    resetRequests: () => {
      requests.length = 0;
    },
  };
}

export function attachPageErrorCollector(page: Page): PageErrorCollector {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  return {
    consoleErrors,
    pageErrors,
    assertNoErrors(): void {
      if (consoleErrors.length > 0 || pageErrors.length > 0) {
        throw new Error(
          `Expected zero browser errors, got consoleErrors=${JSON.stringify(consoleErrors)}, pageErrors=${JSON.stringify(pageErrors)}`,
        );
      }
    },
    reset(): void {
      consoleErrors.length = 0;
      pageErrors.length = 0;
    },
  };
}
