import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { register } from "node:module";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..", "..");

const PUBLISHED_LOCALES = [
  "vi",
  "en",
  "zh-Hans",
  "zh-Hant",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "ar",
  "he",
];

// Register an inline ESM loader for TypeScript + `@/` alias resolution in node --test
// so contract checks execute real Next.js config, routes, and API modules.
const loaderCode = `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from ${JSON.stringify(pathToFileURL(path.join(frontendRoot, "node_modules", "typescript", "lib", "typescript.js")).href)};

const frontendRoot = ${JSON.stringify(frontendRoot)};
const TRY_EXTS = ["", ".ts", ".tsx", ".mjs", ".js", ".json", "/index.ts", "/index.tsx", "/index.js"];

function resolveCandidate(basePath) {
  for (const ext of TRY_EXTS) {
    const candidate = basePath + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return pathToFileURL(candidate).href;
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      url: "data:text/javascript,export default {};",
      shortCircuit: true,
    };
  }
  if (
    specifier === "next/server" ||
    specifier === "next/headers" ||
    specifier === "next/navigation" ||
    specifier === "next/cache"
  ) {
    return nextResolve(specifier + ".js", context);
  }
  if (specifier.startsWith("@/")) {
    const resolved = resolveCandidate(path.join(frontendRoot, specifier.slice(2)));
    if (resolved) {
      return { url: resolved, shortCircuit: true };
    }
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:")
  ) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const resolved = resolveCandidate(path.resolve(parentDir, specifier));
    if (resolved) {
      return { url: resolved, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:")) {
    const filePath = fileURLToPath(url);
    const normalized = filePath.replace(/\\\\/g, "/");

    if (normalized.endsWith("/lib/supabase/server.ts")) {
      const realCode = fs.readFileSync(filePath, "utf8");
      const transpiled = ts.transpileModule(realCode, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
        fileName: filePath,
      });
      const wrapped = transpiled.outputText.replace(
        /export async function createServerSupabaseClient\\(/,
        "async function _realCreateServerSupabaseClient(",
      ) + "\\nexport async function createServerSupabaseClient(...args) { if (globalThis.__vireadContractMocks?.createServerSupabaseClient) return globalThis.__vireadContractMocks.createServerSupabaseClient(...args); return _realCreateServerSupabaseClient(...args); }\\n";
      return { format: "module", source: wrapped, shortCircuit: true };
    }

    if (normalized.endsWith("/lib/supabase/proxy.ts")) {
      const realCode = fs.readFileSync(filePath, "utf8");
      const transpiled = ts.transpileModule(realCode, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
        fileName: filePath,
      });
      const wrapped = transpiled.outputText.replace(
        /export async function refreshSupabaseAuth\\(/,
        "async function _realRefreshSupabaseAuth(",
      ) + "\\nexport async function refreshSupabaseAuth(...args) { if (globalThis.__vireadContractMocks?.refreshSupabaseAuth) return globalThis.__vireadContractMocks.refreshSupabaseAuth(...args); return _realRefreshSupabaseAuth(...args); }\\n";
      return { format: "module", source: wrapped, shortCircuit: true };
    }

    if (normalized.endsWith("/lib/supabase/client.ts")) {
      const realCode = fs.readFileSync(filePath, "utf8");
      const transpiled = ts.transpileModule(realCode, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
        fileName: filePath,
      });
      const wrapped = transpiled.outputText.replace(
        /export function createBrowserSupabaseClient\\(/,
        "function _realCreateBrowserSupabaseClient(",
      ) + "\\nexport function createBrowserSupabaseClient(...args) { if (globalThis.__vireadContractMocks?.createBrowserSupabaseClient) return globalThis.__vireadContractMocks.createBrowserSupabaseClient(...args); return _realCreateBrowserSupabaseClient(...args); }\\n";
      return { format: "module", source: wrapped, shortCircuit: true };
    }

    if (filePath.endsWith(".json")) {
      const jsonText = fs.readFileSync(filePath, "utf8");
      return {
        format: "module",
        source: "export default " + jsonText + ";",
        shortCircuit: true,
      };
    }

    if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
      const sourceText = fs.readFileSync(filePath, "utf8");
      const transpiled = ts.transpileModule(sourceText, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
        },
        fileName: filePath,
      });
      return {
        format: "module",
        source: transpiled.outputText,
        shortCircuit: true,
      };
    }
  }
  return nextLoad(url, context);
}
`;

register(
  `data:text/javascript;base64,${Buffer.from(loaderCode, "utf8").toString("base64")}`,
);

function readFrontendFile(relPath) {
  return fs.readFileSync(path.join(frontendRoot, relPath), "utf8");
}

function parseTsAst(relPath) {
  const fullPath = path.join(frontendRoot, relPath);
  const content = fs.readFileSync(fullPath, "utf8");
  return ts.createSourceFile(
    fullPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walkAst(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => walkAst(child, visitor));
}

function collectImports(ast) {
  const imports = [];
  walkAst(ast, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
  });
  return imports;
}

function collectCallExpressions(ast) {
  const calls = [];
  walkAst(ast, (node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node.expression.getText(ast));
    }
  });
  return calls;
}

function collectCallNodes(ast, rootNode = ast) {
  const calls = [];
  walkAst(rootNode, (node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node);
    }
  });
  return calls;
}

function isMethodCall(ast, callNode, objName, propName) {
  if (!ts.isCallExpression(callNode)) return false;
  const expr = callNode.expression;
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === objName &&
    expr.name.text === propName
  );
}

function parseMaxAgeSeconds(headerValue) {
  if (typeof headerValue !== "string") return null;
  const match = /\bmax-age=(\d+)\b/i.exec(headerValue);
  return match ? Number(match[1]) : null;
}

function assertStaticAssetCacheControl(cacheValue, { minMaxAge, label }) {
  assert.match(
    cacheValue,
    /\bpublic\b/i,
    `${label} Cache-Control must include public: ${cacheValue}`,
  );
  assert.doesNotMatch(
    cacheValue,
    /\b(?:no-store|no-cache)\b/i,
    `${label} Cache-Control must not disable caching: ${cacheValue}`,
  );
  const maxAge = parseMaxAgeSeconds(cacheValue);
  assert.ok(
    maxAge !== null && Number.isFinite(maxAge) && maxAge >= minMaxAge,
    `${label} Cache-Control must specify max-age >= ${minMaxAge}, got ${cacheValue}`,
  );
}

function findHeaderRulesForSource(rules, sourcePath) {
  return rules.filter((rule) => rule.source === sourcePath);
}

function getHeaderValue(rule, headerKey) {
  const target = headerKey.toLowerCase();
  const found = (rule.headers ?? []).find(
    (h) => String(h.key).toLowerCase() === target,
  );
  return found ? String(found.value) : null;
}

function matchesNextProxyConfig(config, pathname) {
  const matchers = Array.isArray(config?.matcher)
    ? config.matcher
    : config?.matcher
      ? [config.matcher]
      : [];
  return matchers.some((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string") return false;
    const regex = new RegExp(`^${source}$`);
    return regex.test(pathname);
  });
}

// ---------------------------------------------------------------------------
// E1: Vercel Config, Static Asset Caching & Security/HSTS Headers
// ---------------------------------------------------------------------------
describe("E1 [harness]: vercel.json & baseline next.config.ts headers", () => {
  it("vercel.json targets sin1, cron /api/cron/parent-emails, and maxDuration 60 for relay", () => {
    const vercelConfig = JSON.parse(readFrontendFile("vercel.json"));
    assert.deepEqual(vercelConfig.regions, ["sin1"]);
    assert.equal(vercelConfig.buildCommand, "npm run build:hosting");
    assert.equal(
      vercelConfig.functions?.["api/parent-email-relay.py"]?.maxDuration,
      60,
    );
    assert.ok(
      Array.isArray(vercelConfig.crons) &&
        vercelConfig.crons.some(
          (cron) =>
            cron.path === "/api/cron/parent-emails" &&
            typeof cron.schedule === "string" &&
            cron.schedule.trim().length > 0,
        ),
    );
  });

  it("next.config.ts sets immutable Cache-Control on /wasm/:path* and baseline security headers on /:path*", async () => {
    const { default: nextConfig } = await import("../../next.config.ts");
    assert.equal(typeof nextConfig.headers, "function");
    const rules = await nextConfig.headers();

    const wasmRules = findHeaderRulesForSource(rules, "/wasm/:path*");
    assert.ok(wasmRules.length >= 1, "Expected /wasm/:path* header rule");
    const wasmCache = getHeaderValue(wasmRules[0], "Cache-Control");
    assert.match(wasmCache ?? "", /public/);
    assert.match(wasmCache ?? "", /max-age=31536000/);
    assert.match(wasmCache ?? "", /immutable/);

    const rootRules = findHeaderRulesForSource(rules, "/:path*");
    assert.ok(rootRules.length >= 1, "Expected /:path* security header rule");
    assert.equal(
      getHeaderValue(rootRules[0], "X-Content-Type-Options"),
      "nosniff",
    );
    assert.equal(getHeaderValue(rootRules[0], "X-Frame-Options"), "DENY");
    assert.equal(
      getHeaderValue(rootRules[0], "Referrer-Policy"),
      "strict-origin-when-cross-origin",
    );
    assert.ok(getHeaderValue(rootRules[0], "Permissions-Policy"));
    assert.ok(getHeaderValue(rootRules[0], "Content-Security-Policy"));
  });

  it("negative boundary: /login, /dashboard, and /api/* do NOT receive immutable or static public Cache-Control", async () => {
    const { default: nextConfig } = await import("../../next.config.ts");
    const rules = await nextConfig.headers();
    const nonStaticRules = rules.filter(
      (rule) =>
        rule.source === "/:path*" ||
        rule.source === "/login" ||
        rule.source === "/dashboard" ||
        String(rule.source).startsWith("/api/") ||
        String(rule.source).startsWith("/auth/"),
    );
    for (const rule of nonStaticRules) {
      const cacheControl = getHeaderValue(rule, "Cache-Control");
      assert.ok(
        !cacheControl || !cacheControl.includes("immutable"),
        `Route rule ${rule.source} must not set immutable Cache-Control`,
      );
      if (
        String(rule.source).startsWith("/api/") ||
        String(rule.source).startsWith("/auth/")
      ) {
        assert.ok(
          !cacheControl || !/\bpublic\b/i.test(cacheControl),
          `Sensitive route rule ${rule.source} must not set public Cache-Control`,
        );
      }
    }
    assert.equal(
      nextConfig.poweredByHeader,
      false,
      "next.config.ts must disable X-Powered-By header",
    );
    const rootRule = findHeaderRulesForSource(rules, "/:path*")[0];
    const csp = rootRule
      ? getHeaderValue(rootRule, "Content-Security-Policy")
      : null;
    assert.match(csp ?? "", /object-src\s+'none'/);
    assert.match(csp ?? "", /frame-ancestors\s+'none'/);
  });
});

describe("E1 [M3-target]: static asset Cache-Control (/images, /audio, /workers) & HSTS", () => {
  it("next.config.ts configures public long-lived Cache-Control (>= 86400s) for /images/:path*", async () => {
    const { default: nextConfig } = await import("../../next.config.ts");
    const rules = await nextConfig.headers();
    const imgRule = rules.find(
      (r) =>
        typeof r.source === "string" &&
        r.source.includes("/images") &&
        getHeaderValue(r, "Cache-Control"),
    );
    assert.ok(imgRule, "Missing Cache-Control rule for /images/*");
    const cache = getHeaderValue(imgRule, "Cache-Control") ?? "";
    assertStaticAssetCacheControl(cache, {
      minMaxAge: 86_400,
      label: "/images/:path*",
    });
  });

  it("next.config.ts configures public long-lived Cache-Control for /audio/:path* (>= 86400s) and /workers/:path* (>= 3600s)", async () => {
    const { default: nextConfig } = await import("../../next.config.ts");
    const rules = await nextConfig.headers();

    const audioRule = rules.find(
      (r) =>
        typeof r.source === "string" &&
        r.source.includes("/audio") &&
        getHeaderValue(r, "Cache-Control"),
    );
    assert.ok(audioRule, "Missing Cache-Control rule for /audio/*");
    assertStaticAssetCacheControl(
      getHeaderValue(audioRule, "Cache-Control") ?? "",
      {
        minMaxAge: 86_400,
        label: "/audio/:path*",
      },
    );

    const workersRule = rules.find(
      (r) =>
        typeof r.source === "string" &&
        r.source.includes("/workers") &&
        getHeaderValue(r, "Cache-Control"),
    );
    assert.ok(workersRule, "Missing Cache-Control rule for /workers/*");
    assertStaticAssetCacheControl(
      getHeaderValue(workersRule, "Cache-Control") ?? "",
      {
        minMaxAge: 3_600,
        label: "/workers/:path*",
      },
    );
  });

  it("next.config.ts enforces Strict-Transport-Security (max-age >= 31536000) in production and omits HSTS in development", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const { default: prodConfig } =
        await import("../../next.config.ts?env=prod-hsts-check");
      const prodRules = await prodConfig.headers();
      const prodRoot = findHeaderRulesForSource(prodRules, "/:path*")[0];
      const prodHsts = prodRoot
        ? getHeaderValue(prodRoot, "Strict-Transport-Security")
        : null;
      assert.ok(
        prodHsts,
        "Missing Strict-Transport-Security header on /:path*",
      );
      const hstsMaxAge = parseMaxAgeSeconds(prodHsts);
      assert.ok(
        hstsMaxAge !== null && hstsMaxAge >= 31_536_000,
        `HSTS max-age must be >= 31536000, got ${prodHsts}`,
      );

      process.env.NODE_ENV = "development";
      const { default: devConfig } =
        await import("../../next.config.ts?env=dev-hsts-check");
      const devRules = await devConfig.headers();
      const devRoot = findHeaderRulesForSource(devRules, "/:path*")[0];
      const devHsts = devRoot
        ? getHeaderValue(devRoot, "Strict-Transport-Security")
        : null;
      assert.equal(
        devHsts,
        null,
        "HSTS must not be emitted in NODE_ENV=development",
      );
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// E2: Proxy Routing, `/` Redirect, Role Cache, OAuth Preview & Route Hygiene
// ---------------------------------------------------------------------------
describe("E2 [harness]: baseline proxy matcher & OAuth spoofed-host rejection", () => {
  it("proxy.ts matcher excludes api/cron, wasm, workers, audio and matches app routes", async () => {
    const { config } = await import("../../proxy.ts");
    for (const appRoute of ["/dashboard", "/admin/books", "/login"]) {
      assert.equal(
        matchesNextProxyConfig(config, appRoute),
        true,
        `Expected proxy matcher to match ${appRoute}`,
      );
    }
    for (const skipped of [
      "/api/cron/parent-emails",
      "/wasm/sherpa/sherpa-onnx-wasm-main-vad-asr.wasm",
      "/workers/sherpa-stt-worker.js",
      "/audio/word-samples/thuc-nang.wav",
    ]) {
      assert.equal(
        matchesNextProxyConfig(config, skipped),
        false,
        `Expected proxy matcher to skip ${skipped}`,
      );
    }
  });

  it("auth/callback/route.ts rejects spoofed x-forwarded-host when NEXT_PUBLIC_SITE_URL is set", async () => {
    const { NextRequest } = await import("next/server.js");
    const prevSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const prevVercelEnv = process.env.VERCEL_ENV;
    const prevVercelUrl = process.env.VERCEL_URL;
    process.env.NEXT_PUBLIC_SITE_URL = "https://viread-frontend.vercel.app";
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_URL;

    globalThis.__vireadContractMocks = {
      createServerSupabaseClient: async () => ({
        auth: {
          exchangeCodeForSession: async () => ({ data: {}, error: null }),
          getUser: async () => ({
            data: {
              user: {
                id: "10000000-0000-4000-8000-000000000001",
                email: "parent@viread.local",
              },
            },
            error: null,
          }),
          signOut: async () => ({ error: null }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { role: "parent", active: 1 },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };

    try {
      const { GET } = await import("../../app/auth/callback/route.ts");
      const req = new NextRequest(
        "https://viread-frontend.vercel.app/auth/callback?code=test-code",
        {
          headers: {
            "x-forwarded-host": "evil.attacker.example",
            "x-forwarded-proto": "https",
          },
        },
      );
      const res = await GET(req);
      assert.equal(res.status, 307);
      assert.equal(
        res.headers.get("location"),
        "https://viread-frontend.vercel.app/dashboard",
      );
    } finally {
      delete globalThis.__vireadContractMocks;
      if (prevSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = prevSiteUrl;
      if (prevVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prevVercelEnv;
      if (prevVercelUrl === undefined) delete process.env.VERCEL_URL;
      else process.env.VERCEL_URL = prevVercelUrl;
    }
  });
});

describe("E2 [M3-target]: proxy relay exclusion, unauthenticated / redirect, role TTL & preview OAuth", () => {
  it("proxy.ts matcher excludes /api/parent-email-relay", async () => {
    const { config } = await import("../../proxy.ts");
    assert.equal(
      matchesNextProxyConfig(config, "/api/parent-email-relay"),
      false,
      "proxy.ts matcher must exclude /api/parent-email-relay",
    );
  });

  it("proxy.ts redirects unauthenticated GET / directly to /login", async () => {
    const { NextRequest } = await import("next/server.js");
    globalThis.__vireadContractMocks = {
      refreshSupabaseAuth: async () => {
        const { NextResponse } = await import("next/server.js");
        return { userId: null, role: null, response: NextResponse.next() };
      },
    };
    try {
      const { proxy } = await import("../../proxy.ts");
      const req = new NextRequest("http://127.0.0.1:3000/");
      const res = await proxy(req);
      assert.equal(res.status, 307);
      const location = res.headers.get("location") ?? "";
      assert.ok(
        new URL(location).pathname === "/login",
        `Expected redirect to /login, got ${location}`,
      );
    } finally {
      delete globalThis.__vireadContractMocks;
    }
  });

  it("proxy.ts redirects unauthenticated protected routes with next param and redirects authenticated / to /dashboard", async () => {
    const { NextRequest } = await import("next/server.js");
    try {
      globalThis.__vireadContractMocks = {
        refreshSupabaseAuth: async () => {
          const { NextResponse } = await import("next/server.js");
          return { userId: null, role: null, response: NextResponse.next() };
        },
      };
      const { proxy } = await import("../../proxy.ts");

      const unauthDash = await proxy(
        new NextRequest("http://127.0.0.1:3000/dashboard?tab=1"),
      );
      assert.equal(unauthDash.status, 307);
      const dashLoc = new URL(unauthDash.headers.get("location") ?? "");
      assert.equal(dashLoc.pathname, "/login");
      assert.equal(dashLoc.searchParams.get("next"), "/dashboard?tab=1");

      const unauthAdmin = await proxy(
        new NextRequest("http://127.0.0.1:3000/admin/books"),
      );
      assert.equal(unauthAdmin.status, 307);
      const adminLoc = new URL(unauthAdmin.headers.get("location") ?? "");
      assert.equal(adminLoc.pathname, "/admin/login");
      assert.equal(adminLoc.searchParams.get("next"), "/admin/books");

      globalThis.__vireadContractMocks = {
        refreshSupabaseAuth: async () => {
          const { NextResponse } = await import("next/server.js");
          return {
            userId: "10000000-0000-4000-8000-000000000001",
            role: "parent",
            response: NextResponse.next(),
          };
        },
      };
      const authRoot = await proxy(new NextRequest("http://127.0.0.1:3000/"));
      assert.equal(authRoot.status, 307);
      assert.equal(
        new URL(authRoot.headers.get("location") ?? "").pathname,
        "/dashboard",
      );

      const parentOnAdmin = await proxy(
        new NextRequest("http://127.0.0.1:3000/admin"),
      );
      assert.equal(parentOnAdmin.status, 307);
      assert.equal(
        new URL(parentOnAdmin.headers.get("location") ?? "").pathname,
        "/dashboard",
      );
    } finally {
      delete globalThis.__vireadContractMocks;
    }
  });

  it("ssr-auth-cache.ts tunes ROLE_CACHE_TTL_MS > 30_000 and rejects tampered, expired, wrong-user, or wrong-cookie-hash tokens", async () => {
    const cacheMod = await import("../../lib/auth/ssr-auth-cache.ts");
    assert.ok(
      cacheMod.ROLE_CACHE_TTL_MS > 30_000,
      `Expected ROLE_CACHE_TTL_MS > 30_000, got ${cacheMod.ROLE_CACHE_TTL_MS}`,
    );
    assert.ok(
      cacheMod.ROLE_CACHE_MAX_AGE_SECONDS > 30,
      `Expected ROLE_CACHE_MAX_AGE_SECONDS > 30, got ${cacheMod.ROLE_CACHE_MAX_AGE_SECONDS}`,
    );

    const cookieHash = "hash-abc";
    const token = cacheMod.signSsrRoleCacheCookie({
      userId: "user-1",
      role: "parent",
      cookieHash,
      now: 1_000_000,
    });
    assert.equal(
      cacheMod.verifySsrRoleCacheCookie(token, "user-1", cookieHash, 1_000_500),
      "parent",
    );
    assert.equal(
      cacheMod.verifySsrRoleCacheCookie(
        `${token}tamper`,
        "user-1",
        cookieHash,
        1_000_500,
      ),
      null,
    );
    assert.equal(
      cacheMod.verifySsrRoleCacheCookie(
        token,
        "user-1",
        cookieHash,
        1_000_000 + cacheMod.ROLE_CACHE_TTL_MS,
      ),
      null,
    );
    assert.equal(
      cacheMod.verifySsrRoleCacheCookie(token, "user-2", cookieHash, 1_000_500),
      null,
    );
    assert.equal(
      cacheMod.verifySsrRoleCacheCookie(
        token,
        "user-1",
        "hash-other",
        1_000_500,
      ),
      null,
    );
  });

  it("auth/callback/route.ts allows VERCEL_ENV=preview VERCEL_URL origin while rejecting spoofed preview hosts", async () => {
    const { NextRequest } = await import("next/server.js");
    const prevSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const prevVercelEnv = process.env.VERCEL_ENV;
    const prevVercelUrl = process.env.VERCEL_URL;
    process.env.NEXT_PUBLIC_SITE_URL = "https://viread-frontend.vercel.app";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "viread-frontend-git-feat-preview.vercel.app";

    globalThis.__vireadContractMocks = {
      createServerSupabaseClient: async () => ({
        auth: {
          exchangeCodeForSession: async () => ({ data: {}, error: null }),
          getUser: async () => ({
            data: {
              user: {
                id: "10000000-0000-4000-8000-000000000001",
                email: "parent@viread.local",
              },
            },
            error: null,
          }),
          signOut: async () => ({ error: null }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { role: "parent", active: 1 },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };

    try {
      const { GET } = await import("../../app/auth/callback/route.ts");
      const previewReq = new NextRequest(
        "https://viread-frontend-git-feat-preview.vercel.app/auth/callback?code=preview-code",
        {
          headers: {
            "x-forwarded-host": "viread-frontend-git-feat-preview.vercel.app",
            "x-forwarded-proto": "https",
          },
        },
      );
      const previewRes = await GET(previewReq);
      assert.equal(
        previewRes.headers.get("location"),
        "https://viread-frontend-git-feat-preview.vercel.app/dashboard",
      );

      const spoofReq = new NextRequest(
        "https://viread-frontend-git-feat-preview.vercel.app/auth/callback?code=preview-code",
        {
          headers: {
            "x-forwarded-host": "evil-preview.attacker.example",
            "x-forwarded-proto": "https",
          },
        },
      );
      const spoofRes = await GET(spoofReq);
      assert.notEqual(
        new URL(spoofRes.headers.get("location") ?? "").hostname,
        "evil-preview.attacker.example",
      );
    } finally {
      delete globalThis.__vireadContractMocks;
      if (prevSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = prevSiteUrl;
      if (prevVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prevVercelEnv;
      if (prevVercelUrl === undefined) delete process.env.VERCEL_URL;
      else process.env.VERCEL_URL = prevVercelUrl;
    }
  });
});

describe("E2 [M4-target]: (app) route group hygiene & tsconfig .next-* exclusion", () => {
  it("consolidates sessions/[sessionId]/report under app/(app)/ and removes duplicate root report layout", () => {
    assert.equal(
      fs.existsSync(
        path.join(
          frontendRoot,
          "app/(app)/sessions/[sessionId]/report/page.tsx",
        ),
      ),
      true,
      "Expected app/(app)/sessions/[sessionId]/report/page.tsx to exist",
    );
    assert.equal(
      fs.existsSync(
        path.join(frontendRoot, "app/sessions/[sessionId]/report/page.tsx"),
      ),
      false,
      "Legacy app/sessions/[sessionId]/report/page.tsx should be consolidated into (app)",
    );
    assert.equal(
      fs.existsSync(path.join(frontendRoot, "app/(app)/error.tsx")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(frontendRoot, "app/(app)/loading.tsx")),
      true,
    );
  });

  it("tsconfig.json excludes .next-* directories instead of hardcoding .next-e2e types", () => {
    const tsconfig = JSON.parse(readFrontendFile("tsconfig.json"));
    const exclude = Array.isArray(tsconfig.exclude) ? tsconfig.exclude : [];
    const include = Array.isArray(tsconfig.include) ? tsconfig.include : [];
    assert.ok(
      exclude.some((item) => String(item).includes(".next-")),
      `Expected tsconfig.json exclude to cover .next-*, got ${JSON.stringify(exclude)}`,
    );
    assert.equal(
      include.some((item) => String(item).includes(".next-e2e")),
      false,
      "tsconfig.json include should not list .next-e2e",
    );
  });
});

// ---------------------------------------------------------------------------
// E3: /api/cron/parent-emails Resilience & Auth Guards
// ---------------------------------------------------------------------------
describe("E3 [harness]: /api/cron/parent-emails runtime contract & retry", () => {
  let mockServer;
  let mockUrl;
  let mode = "ok";
  let attempts = 0;
  let lastCronSecretHeader = null;
  let lastScopeParam = null;
  let prevEnv = {};

  before(async () => {
    mockServer = http.createServer((req, res) => {
      if (req.url?.startsWith("/parent-notifications/cron/dispatch")) {
        attempts += 1;
        lastCronSecretHeader = req.headers["x-cron-secret"] ?? null;
        lastScopeParam = new URL(req.url, "http://127.0.0.1").searchParams.get(
          "scope",
        );
        if (mode === "fail-once" && attempts === 1) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: "transient 502" }));
          return;
        }
        if (mode === "fail-500") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: "internal error" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dispatched: 2, attempts }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const addr = mockServer.address();
    mockUrl = `http://127.0.0.1:${addr.port}`;

    prevEnv = {
      CRON_SECRET: process.env.CRON_SECRET,
      BACKEND_API_URL: process.env.BACKEND_API_URL,
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      PARENT_EMAIL_CRON_SECRET: process.env.PARENT_EMAIL_CRON_SECRET,
    };
    process.env.CRON_SECRET = "contract_cron_secret_0123456789abcdef";
    process.env.BACKEND_API_URL = mockUrl;
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.PARENT_EMAIL_CRON_SECRET;
  });

  after(async () => {
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    await new Promise((resolve) => mockServer.close(() => resolve()));
  });

  it("exports maxDuration = 60 and keeps retry timeout budget <= 60_000ms", async () => {
    const routeMod = await import("../../app/api/cron/parent-emails/route.ts");
    assert.equal(routeMod.maxDuration, 60);
    const source = readFrontendFile("app/api/cron/parent-emails/route.ts");
    const totalMatch = /TOTAL_BUDGET_MS\s*=\s*([\d_]+)/.exec(source);
    const firstMatch = /FIRST_ATTEMPT_TIMEOUT_MS\s*=\s*([\d_]+)/.exec(source);
    const retryMatch = /RETRY_ATTEMPT_TIMEOUT_MS\s*=\s*([\d_]+)/.exec(source);

    if (totalMatch && firstMatch) {
      const totalBudgetMs = Number(totalMatch[1].replaceAll("_", ""));
      const firstAttemptMs = Number(firstMatch[1].replaceAll("_", ""));
      assert.ok(
        totalBudgetMs > 0 && totalBudgetMs <= 60_000,
        `TOTAL_BUDGET_MS (${totalBudgetMs}ms) exceeds maxDuration 60s`,
      );
      assert.ok(
        firstAttemptMs > 0 && firstAttemptMs <= totalBudgetMs,
        `FIRST_ATTEMPT_TIMEOUT_MS (${firstAttemptMs}ms) exceeds TOTAL_BUDGET_MS`,
      );
    } else {
      assert.ok(firstMatch && retryMatch, "Missing timeout budget constants");
      const totalMs =
        Number(firstMatch[1].replaceAll("_", "")) +
        Number(retryMatch[1].replaceAll("_", ""));
      assert.ok(
        totalMs <= 60_000,
        `Combined cron timeout budget (${totalMs}ms) exceeds maxDuration 60s`,
      );
    }
  });

  it("returns 503 when CRON_SECRET is missing or too short", async () => {
    const { NextRequest } = await import("next/server.js");
    const { GET } = await import("../../app/api/cron/parent-emails/route.ts");
    const saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "short";
    try {
      const res = await GET(
        new NextRequest("http://127.0.0.1:3000/api/cron/parent-emails"),
      );
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error, "CRON_SECRET_NOT_CONFIGURED");
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });

  it("returns 401 when Authorization Bearer token is missing or mismatched", async () => {
    const { NextRequest } = await import("next/server.js");
    const { GET } = await import("../../app/api/cron/parent-emails/route.ts");
    const noAuth = await GET(
      new NextRequest("http://127.0.0.1:3000/api/cron/parent-emails"),
    );
    assert.equal(noAuth.status, 401);

    const wrongAuth = await GET(
      new NextRequest("http://127.0.0.1:3000/api/cron/parent-emails", {
        headers: { authorization: "Bearer wrong-secret-token" },
      }),
    );
    assert.equal(wrongAuth.status, 401);
  });

  it("succeeds (200) and forwards X-Cron-Secret on authorized GET", async () => {
    const { NextRequest } = await import("next/server.js");
    const { GET } = await import("../../app/api/cron/parent-emails/route.ts");
    mode = "ok";
    attempts = 0;
    const res = await GET(
      new NextRequest(
        "http://127.0.0.1:3000/api/cron/parent-emails?scope=reminders",
        {
          headers: {
            authorization: `Bearer ${process.env.CRON_SECRET}`,
          },
        },
      ),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(lastCronSecretHeader, process.env.CRON_SECRET);
    assert.equal(attempts, 1);
  });

  it("retries once on transient 502 on POST and does not retry non-retryable 500", async () => {
    const { NextRequest } = await import("next/server.js");
    const { POST, GET } =
      await import("../../app/api/cron/parent-emails/route.ts");

    mode = "fail-once";
    attempts = 0;
    const retryRes = await POST(
      new NextRequest(
        "http://127.0.0.1:3000/api/cron/parent-emails?scope=engagement",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.CRON_SECRET}`,
          },
        },
      ),
    );
    assert.equal(retryRes.status, 200);
    assert.equal(attempts, 2);

    mode = "fail-500";
    attempts = 0;
    const nonRetryRes = await GET(
      new NextRequest("http://127.0.0.1:3000/api/cron/parent-emails", {
        headers: {
          authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
      }),
    );
    assert.equal(nonRetryRes.status, 502);
    assert.equal(attempts, 1);
  });

  it("clamps invalid scope query param to 'all' and returns 503 when BACKEND_API_URL is unconfigured", async () => {
    const { NextRequest } = await import("next/server.js");
    const { GET } = await import("../../app/api/cron/parent-emails/route.ts");

    const prevUrl = process.env.BACKEND_API_URL;
    const prevPublicUrl = process.env.NEXT_PUBLIC_API_URL;
    mode = "ok";
    attempts = 0;
    lastScopeParam = null;
    const invalidScopeRes = await GET(
      new NextRequest(
        "http://127.0.0.1:3000/api/cron/parent-emails?scope=../../evil",
        {
          headers: {
            authorization: `Bearer ${process.env.CRON_SECRET}`,
          },
        },
      ),
    );
    assert.equal(invalidScopeRes.status, 200);
    assert.equal(lastScopeParam, "all");

    delete process.env.BACKEND_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    try {
      const missingBackendRes = await GET(
        new NextRequest("http://127.0.0.1:3000/api/cron/parent-emails", {
          headers: {
            authorization: `Bearer ${process.env.CRON_SECRET}`,
          },
        }),
      );
      assert.equal(missingBackendRes.status, 503);
      const body = await missingBackendRes.json();
      assert.equal(body.error, "BACKEND_API_URL_NOT_CONFIGURED");
    } finally {
      if (prevUrl === undefined) delete process.env.BACKEND_API_URL;
      else process.env.BACKEND_API_URL = prevUrl;
      if (prevPublicUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = prevPublicUrl;
    }
  });
});

// ---------------------------------------------------------------------------
// E4: Frontend API Client Scoped Cache, Bounded GET Retry & Media URL Contract
// ---------------------------------------------------------------------------
describe("E4 [harness]: media URL contract & read-cache prefix invalidation", () => {
  it("isStudioAuthenticatedMediaUrl distinguishes proxy studio/private URLs from direct Supabase CDN signed URLs", async () => {
    const { isStudioAuthenticatedMediaUrl } =
      await import("../../lib/api/book-assets-service.ts");
    assert.equal(
      isStudioAuthenticatedMediaUrl("/studio/assets/asset-1/media"),
      true,
    );
    assert.equal(
      isStudioAuthenticatedMediaUrl(
        "https://capstone1-ssd8.onrender.com/studio/assets/asset-1/media",
      ),
      true,
    );
    assert.equal(
      isStudioAuthenticatedMediaUrl("/books/my-books/b1/pages/p1/image"),
      true,
    );
    assert.equal(
      isStudioAuthenticatedMediaUrl(
        "https://sampleid.supabase.co/storage/v1/object/sign/readalong-book-pages/covers/b1.webp?token=signed",
      ),
      false,
    );
    assert.equal(isStudioAuthenticatedMediaUrl(null), false);
  });

  it("read-cache invalidateApiReadCacheByPrefix removes targeted prefix without wiping unrelated entries", async () => {
    const rc = await import("../../lib/api/read-cache.ts");
    rc.resetAllApiCachesForTests();
    rc.setApiReadCacheEnabled(true);
    rc.setCachedApiRead("/reading/sessions/s1", "tok-1", { ok: true }, 15_000);
    rc.setCachedApiRead("/profiles/me", "tok-1", { id: "u1" }, 15_000);

    rc.invalidateApiReadCacheByPrefix("/reading");

    assert.equal(
      rc.getCachedApiRead("/reading/sessions/s1", "tok-1"),
      undefined,
    );
    assert.deepEqual(rc.getCachedApiRead("/profiles/me", "tok-1"), {
      id: "u1",
    });
    rc.resetAllApiCachesForTests();
  });
});

describe("E4 [M3-target]: api-client scoped cache, bounded GET retry & service timeout migration", () => {
  it("api-client.ts scopes cache invalidation on /reading/* mutations and preserves /books/catalog & /profiles/me", async () => {
    const prevEnv = {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      api: process.env.NEXT_PUBLIC_API_URL,
    };
    const prevFetch = globalThis.fetch;

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sampleid.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
      "sb_publishable_test_key_1234567890";
    process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:18080";

    const rc = await import("../../lib/api/read-cache.ts");
    const { requestApi } = await import("../../lib/api/api-client.ts");
    const { z } = await import("zod");

    const fetchCounts = new Map();
    globalThis.__vireadContractMocks = {
      createBrowserSupabaseClient: () => ({
        auth: {
          onAuthStateChange: () => ({
            data: { subscription: { unsubscribe: () => {} } },
          }),
          initialize: async () => ({ error: null }),
          getSession: async () => ({
            data: {
              session: {
                access_token: "test-jwt-token",
                expires_at: Math.floor(Date.now() / 1000) + 3600,
                user: { id: "u1" },
              },
            },
            error: null,
          }),
        },
      }),
    };
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      const key = parsed.pathname;
      fetchCounts.set(key, (fetchCounts.get(key) ?? 0) + 1);
      return new Response(JSON.stringify({ ok: true, path: key }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      rc.resetAllApiCachesForTests();
      const schema = z.object({ ok: z.boolean(), path: z.string() });
      await requestApi("/books/catalog", schema);
      await requestApi("/profiles/me", schema);
      await requestApi("/reading/sessions/s1", schema);

      // Reading mutation must invalidate /reading/* without wiping /books/catalog or /profiles/me
      await requestApi("/reading/events", schema, undefined, {
        method: "POST",
        body: { type: "WORD_RETRY" },
      });

      await requestApi("/books/catalog", schema);
      await requestApi("/profiles/me", schema);
      await requestApi("/reading/sessions/s1", schema);

      assert.equal(
        fetchCounts.get("/books/catalog"),
        1,
        "Expected /books/catalog cache to survive /reading/events mutation",
      );
      assert.equal(
        fetchCounts.get("/profiles/me"),
        1,
        "Expected /profiles/me cache to survive /reading/events mutation",
      );
      assert.equal(
        fetchCounts.get("/reading/sessions/s1"),
        2,
        "Expected /reading/sessions/s1 cache to be invalidated by /reading/events mutation",
      );
    } finally {
      rc.resetAllApiCachesForTests();
      delete globalThis.__vireadContractMocks;
      globalThis.fetch = prevFetch;
      if (prevEnv.url === undefined)
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = prevEnv.url;
      if (prevEnv.key === undefined) {
        delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      } else {
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = prevEnv.key;
      }
      if (prevEnv.api === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = prevEnv.api;
    }
  });

  it("api-client.ts retries bounded idempotent GET on transient 503 and NEVER retries POST/PATCH/DELETE mutations", async () => {
    const prevEnv = {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      api: process.env.NEXT_PUBLIC_API_URL,
    };
    const prevFetch = globalThis.fetch;

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sampleid.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
      "sb_publishable_test_key_1234567890";
    process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:18080";

    const rc = await import("../../lib/api/read-cache.ts");
    const { requestApi } = await import("../../lib/api/api-client.ts");
    const { z } = await import("zod");

    let getAttempts = 0;
    const mutationAttempts = { POST: 0, PATCH: 0, DELETE: 0 };

    globalThis.__vireadContractMocks = {
      createBrowserSupabaseClient: () => ({
        auth: {
          onAuthStateChange: () => ({
            data: { subscription: { unsubscribe: () => {} } },
          }),
          initialize: async () => ({ error: null }),
          getSession: async () => ({
            data: {
              session: {
                access_token: "test-jwt-token",
                expires_at: Math.floor(Date.now() / 1000) + 3600,
                user: { id: "u1" },
              },
            },
            error: null,
          }),
        },
      }),
    };

    globalThis.fetch = async (url, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        getAttempts += 1;
        if (getAttempts === 1) {
          return new Response(JSON.stringify({ detail: "cold start" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      mutationAttempts[method] = (mutationAttempts[method] ?? 0) + 1;
      return new Response(JSON.stringify({ detail: "unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      rc.resetAllApiCachesForTests();
      const schema = z.object({ ok: z.boolean() });
      const getResult = await requestApi("/books/catalog", schema, undefined, {
        bypassCache: true,
      });
      assert.deepEqual(getResult, { ok: true });
      assert.equal(getAttempts, 2);

      for (const method of ["POST", "PATCH", "DELETE"]) {
        await assert.rejects(() =>
          requestApi("/reading/events", schema, undefined, {
            method,
            body: { x: 1 },
          }),
        );
        assert.equal(
          mutationAttempts[method],
          1,
          `${method} mutation must never auto-retry on 503`,
        );
      }
    } finally {
      rc.resetAllApiCachesForTests();
      delete globalThis.__vireadContractMocks;
      globalThis.fetch = prevFetch;
      if (prevEnv.url === undefined)
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = prevEnv.url;
      if (prevEnv.key === undefined) {
        delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      } else {
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = prevEnv.key;
      }
      if (prevEnv.api === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = prevEnv.api;
    }
  });

  it("api-client.ts never retries non-retryable 400/404/422 GETs, honors AbortSignal, and conservatively invalidates unknown mutation prefixes", async () => {
    const prevEnv = {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      api: process.env.NEXT_PUBLIC_API_URL,
    };
    const prevFetch = globalThis.fetch;

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sampleid.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
      "sb_publishable_test_key_1234567890";
    process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:18080";

    const rc = await import("../../lib/api/read-cache.ts");
    const { requestApi } = await import("../../lib/api/api-client.ts");
    const { z } = await import("zod");

    const attemptsByPath = new Map();
    globalThis.__vireadContractMocks = {
      createBrowserSupabaseClient: () => ({
        auth: {
          onAuthStateChange: () => ({
            data: { subscription: { unsubscribe: () => {} } },
          }),
          initialize: async () => ({ error: null }),
          getSession: async () => ({
            data: {
              session: {
                access_token: "test-jwt-token",
                expires_at: Math.floor(Date.now() / 1000) + 3600,
                user: { id: "u1" },
              },
            },
            error: null,
          }),
        },
      }),
    };

    globalThis.fetch = async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      attemptsByPath.set(pathname, (attemptsByPath.get(pathname) ?? 0) + 1);

      if (pathname === "/status/400") {
        return new Response(JSON.stringify({ detail: "bad request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/status/404") {
        return new Response(JSON.stringify({ detail: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/status/422") {
        return new Response(JSON.stringify({ detail: "unprocessable" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (pathname === "/slow-abort") {
        return await new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      rc.resetAllApiCachesForTests();
      const schema = z.object({ ok: z.boolean() });

      for (const status of [400, 404, 422]) {
        const pathKey = `/status/${status}`;
        await assert.rejects(() =>
          requestApi(pathKey, schema, undefined, { bypassCache: true }),
        );
        assert.equal(
          attemptsByPath.get(pathKey),
          1,
          `GET ${pathKey} must not retry`,
        );
      }

      const controller = new AbortController();
      const abortPromise = requestApi(
        "/slow-abort",
        schema,
        controller.signal,
        {
          bypassCache: true,
          timeoutMs: 5000,
        },
      );
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(() => abortPromise);
      assert.equal(attemptsByPath.get("/slow-abort"), 1);

      await requestApi("/books/catalog", schema);
      await requestApi("/unknown-domain/mutate", schema, undefined, {
        method: "POST",
        body: { x: 1 },
      });
      await requestApi("/books/catalog", schema);
      assert.equal(
        attemptsByPath.get("/books/catalog"),
        2,
        "Unknown mutation prefix must conservatively invalidate read cache",
      );
    } finally {
      rc.resetAllApiCachesForTests();
      delete globalThis.__vireadContractMocks;
      globalThis.fetch = prevFetch;
      if (prevEnv.url === undefined)
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = prevEnv.url;
      if (prevEnv.key === undefined) {
        delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      } else {
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = prevEnv.key;
      }
      if (prevEnv.api === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = prevEnv.api;
    }
  });

  it("child-service, profile-service, support-service, and adaptive-learning-service have zero bare fetch() calls and use requestApi() or bounded timeouts", () => {
    const services = [
      "lib/api/child-service.ts",
      "lib/api/profile-service.ts",
      "lib/api/support-service.ts",
      "lib/api/adaptive-learning-service.ts",
    ];
    for (const relPath of services) {
      const ast = parseTsAst(relPath);
      const imports = collectImports(ast);
      const calls = collectCallExpressions(ast);
      const bareFetchCalls = calls.filter(
        (c) =>
          c === "fetch" || c === "globalThis.fetch" || c === "window.fetch",
      );
      assert.deepEqual(
        bareFetchCalls,
        [],
        `${relPath} must not contain bare fetch() calls (found: ${bareFetchCalls.join(", ")})`,
      );
      const usesRequestApi =
        imports.includes("@/lib/api/api-client") &&
        calls.includes("requestApi");
      const usesBoundedTimeout =
        calls.some((c) => c.includes("AbortSignal.timeout")) ||
        calls.some((c) => c.includes("withRequestDeadline"));
      assert.ok(
        usesRequestApi || usesBoundedTimeout,
        `${relPath} must use requestApi() or AbortSignal.timeout()/withRequestDeadline()`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// E5: i18n Namespace Split, Code-Splitting & Waterfall Elimination
// ---------------------------------------------------------------------------
describe("E5 [harness]: i18n locale completeness across all 11 published locales", () => {
  it("all 11 published locales have valid admin.json and index.ts files", () => {
    for (const locale of PUBLISHED_LOCALES) {
      const adminJson = JSON.parse(
        readFrontendFile(`messages/${locale}/admin.json`),
      );
      assert.equal(typeof adminJson, "object");
      assert.ok(
        fs.existsSync(path.join(frontendRoot, `messages/${locale}/index.ts`)),
        `Missing messages/${locale}/index.ts`,
      );
    }
  });
});

describe("E5 [M4-target]: i18n admin split, RootLayout preconnect & code-splitting", () => {
  it("taskCenter keys are absent from admin.json and present in a root-loaded namespace across ALL 11 locales", () => {
    for (const locale of PUBLISHED_LOCALES) {
      const adminJson = JSON.parse(
        readFrontendFile(`messages/${locale}/admin.json`),
      );
      assert.equal(
        Object.hasOwn(adminJson, "taskCenter"),
        false,
        `messages/${locale}/admin.json must not contain taskCenter`,
      );

      const indexAst = parseTsAst(`messages/${locale}/index.ts`);
      const importedFiles = collectImports(indexAst).filter(
        (spec) => spec.startsWith("./") && spec.endsWith(".json"),
      );
      assert.equal(
        importedFiles.includes("./admin.json"),
        false,
        `messages/${locale}/index.ts must not eagerly import ./admin.json in root bundle`,
      );

      let foundTaskCenter = false;
      for (const relJson of importedFiles) {
        const parsed = JSON.parse(
          readFrontendFile(`messages/${locale}/${relJson.slice(2)}`),
        );
        if (
          Object.hasOwn(parsed, "taskCenter") &&
          typeof parsed.taskCenter?.elapsedSeconds === "string"
        ) {
          foundTaskCenter = true;
          break;
        }
      }
      assert.equal(
        foundTaskCenter,
        true,
        `Expected root-loaded namespace in messages/${locale}/index.ts to include taskCenter.elapsedSeconds`,
      );
    }
  });

  it("app/admin/layout.tsx loads the admin i18n namespace", () => {
    const ast = parseTsAst("app/admin/layout.tsx");
    const imports = collectImports(ast);
    const source = readFrontendFile("app/admin/layout.tsx");
    assert.ok(
      imports.some(
        (spec) => spec.includes("i18n") || spec.includes("messages"),
      ) && source.includes("admin"),
      "app/admin/layout.tsx must load and provide the admin i18n namespace",
    );
  });

  it("RootLayout includes preconnect hints and lazy-splits ViReadAssistantWidget", () => {
    const layoutSource = readFrontendFile("app/layout.tsx");
    const layoutAst = parseTsAst("app/layout.tsx");
    const layoutImports = collectImports(layoutAst);
    const hasInlinePreconnect =
      layoutSource.includes('rel="preconnect"') ||
      layoutSource.includes("rel='preconnect'");
    const usesPreconnectComponent =
      layoutImports.includes("@/components/common/preconnect-resources") &&
      readFrontendFile("components/common/preconnect-resources.tsx").includes(
        "preconnect(",
      );
    assert.ok(
      hasInlinePreconnect || usesPreconnectComponent,
      'app/layout.tsx must emit <link rel="preconnect"> or PreconnectResources',
    );

    const widgetAst = parseTsAst(
      "components/assistant/viread-assistant-widget.tsx",
    );
    const widgetImports = collectImports(widgetAst);
    const rootUsesDynamic = layoutImports.includes("next/dynamic");
    const widgetUsesDynamic = widgetImports.includes("next/dynamic");
    assert.ok(
      rootUsesDynamic || widgetUsesDynamic,
      "Expected ViReadAssistantWidget or its panel/page-guides to be code-split with next/dynamic",
    );
  });

  it("resolvePreconnectOrigins filters invalid/relative/non-http URLs and deduplicates valid origins", async () => {
    const { resolvePreconnectOrigins } =
      await import("../../lib/utils/origin.ts");
    const origins = resolvePreconnectOrigins([
      null,
      undefined,
      "",
      "   ",
      "/relative/api",
      "javascript:alert(1)",
      "ftp://files.example.com/a",
      "not a valid url",
      "https://sampleid.supabase.co/rest/v1",
      "https://sampleid.supabase.co/auth/v1/",
      "https://capstone1-ssd8.onrender.com/health",
    ]);
    assert.deepEqual(origins, [
      "https://sampleid.supabase.co",
      "https://capstone1-ssd8.onrender.com",
    ]);
  });

  it("reading-screen.tsx splits multiple non-initial modals/sub-panels via next/dynamic", () => {
    const readingAst = parseTsAst("components/reading/reading-screen.tsx");
    const readingImports = collectImports(readingAst);
    assert.ok(
      readingImports.includes("next/dynamic"),
      "components/reading/reading-screen.tsx must use next/dynamic for non-initial modals/sub-panels",
    );
    const dynamicCalls = collectCallNodes(readingAst).filter(
      (call) => call.expression.getText(readingAst) === "dynamic",
    );
    assert.ok(
      dynamicCalls.length >= 3,
      `Expected >= 3 dynamic() split panels in reading-screen.tsx, found ${dynamicCalls.length}`,
    );
  });
});

describe("E5 [M3-target]: client fetch waterfall elimination", () => {
  it("BookLibraryScreen does not gate bookService.list() behind childState.status", () => {
    const ast = parseTsAst("components/books/book-library-screen.tsx");
    const bookListCalls = collectCallNodes(ast).filter((call) =>
      isMethodCall(ast, call, "bookService", "list"),
    );
    assert.ok(
      bookListCalls.length >= 1,
      "Expected at least one bookService.list() call in BookLibraryScreen",
    );

    const hasChildStateReturn = (stmt) => {
      let foundReturn = false;
      walkAst(stmt, (n) => {
        if (ts.isReturnStatement(n)) foundReturn = true;
      });
      return foundReturn;
    };

    let gatedBookList = false;
    for (const callNode of bookListCalls) {
      let current = callNode;
      while (current && current.parent) {
        const parent = current.parent;
        if (
          ts.isIfStatement(parent) &&
          parent.expression.getText(ast).includes("childState")
        ) {
          gatedBookList = true;
        }
        if (
          ts.isConditionalExpression(parent) &&
          parent.condition.getText(ast).includes("childState")
        ) {
          gatedBookList = true;
        }
        if (ts.isBlock(parent)) {
          for (const stmt of parent.statements) {
            if (stmt.pos >= current.pos) break;
            if (
              ts.isIfStatement(stmt) &&
              stmt.expression.getText(ast).includes("childState") &&
              hasChildStateReturn(stmt.thenStatement)
            ) {
              gatedBookList = true;
            }
          }
        }
        if (
          ts.isCallExpression(parent) &&
          parent.expression.getText(ast) === "useEffect"
        ) {
          break;
        }
        current = parent;
      }
    }

    assert.equal(
      gatedBookList,
      false,
      "BookLibraryScreen must not gate bookService.list() behind childState.status",
    );
  });

  it("ProgressReportScreen parallelizes reportService.listPeriods() and reportService.get() inside Promise.all without sequential await", () => {
    const ast = parseTsAst("components/reports/progress-report-screen.tsx");

    const loadEffect = collectCallNodes(ast).find((call) => {
      if (call.expression.getText(ast) !== "useEffect") return false;
      const callback = call.arguments[0];
      if (!callback) return false;
      return collectCallNodes(ast, callback).some((inner) =>
        isMethodCall(ast, inner, "reportService", "get"),
      );
    });
    assert.ok(
      loadEffect,
      "Expected initial load useEffect calling reportService.get() in ProgressReportScreen",
    );
    const loadScope = loadEffect.arguments[0];

    let hasDirectAwaitOnListPeriods = false;
    walkAst(loadScope, (node) => {
      if (ts.isAwaitExpression(node)) {
        const expr = node.expression;
        if (
          ts.isCallExpression(expr) &&
          isMethodCall(ast, expr, "reportService", "listPeriods")
        ) {
          hasDirectAwaitOnListPeriods = true;
        }
      }
    });
    assert.equal(
      hasDirectAwaitOnListPeriods,
      false,
      "ProgressReportScreen load effect must not sequentially await reportService.listPeriods() outside Promise.all",
    );

    const resolveBlockVars = (node) => {
      const vars = new Map();
      let curr = node;
      while (curr) {
        if (ts.isBlock(curr)) {
          for (const stmt of curr.statements) {
            if (stmt.pos >= node.pos) break;
            if (ts.isVariableStatement(stmt)) {
              for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer) {
                  vars.set(decl.name.text, decl.initializer);
                }
              }
            }
          }
        }
        curr = curr.parent;
      }
      return vars;
    };

    const exprTargetsMethod = (
      exprNode,
      objName,
      propName,
      vars,
      visited = new Set(),
    ) => {
      let hasAwait = false;
      let hasCall = false;
      walkAst(exprNode, (inner) => {
        if (ts.isAwaitExpression(inner)) {
          hasAwait = true;
        }
        if (
          ts.isCallExpression(inner) &&
          isMethodCall(ast, inner, objName, propName)
        ) {
          hasCall = true;
        }
        if (
          ts.isIdentifier(inner) &&
          vars.has(inner.text) &&
          !visited.has(inner.text)
        ) {
          visited.add(inner.text);
          if (
            exprTargetsMethod(
              vars.get(inner.text),
              objName,
              propName,
              vars,
              visited,
            )
          ) {
            hasCall = true;
          }
        }
      });
      return hasCall && !hasAwait;
    };

    const parallelCalls = collectCallNodes(ast, loadScope).filter((call) => {
      const target = call.expression.getText(ast).replace(/\s+/g, "");
      return target === "Promise.all" || target === "Promise.allSettled";
    });

    const hasGenuineParallelPair = parallelCalls.some((call) => {
      const firstArg = call.arguments[0];
      if (!firstArg || !ts.isArrayLiteralExpression(firstArg)) return false;
      if (firstArg.elements.length < 2) return false;
      const vars = resolveBlockVars(call);
      let listPeriodsIdx = -1;
      let reportGetIdx = -1;
      firstArg.elements.forEach((elem, idx) => {
        if (exprTargetsMethod(elem, "reportService", "listPeriods", vars)) {
          listPeriodsIdx = idx;
        }
        if (exprTargetsMethod(elem, "reportService", "get", vars)) {
          reportGetIdx = idx;
        }
      });
      return (
        listPeriodsIdx !== -1 &&
        reportGetIdx !== -1 &&
        listPeriodsIdx !== reportGetIdx
      );
    });

    assert.ok(
      hasGenuineParallelPair,
      "ProgressReportScreen must pass both reportService.listPeriods() and reportService.get() into Promise.all([...]) / Promise.allSettled([...])",
    );
  });

  it("useValidatedSelectedChild returns early before childService.get() when freshCachedChild exists", () => {
    const ast = parseTsAst("hooks/use-validated-selected-child.ts");

    const useEffectWithChildGet = collectCallNodes(ast).find((call) => {
      if (call.expression.getText(ast) !== "useEffect") return false;
      const callback = call.arguments[0];
      if (!callback) return false;
      return collectCallNodes(ast, callback).some((inner) =>
        isMethodCall(ast, inner, "childService", "get"),
      );
    });

    assert.ok(
      useEffectWithChildGet,
      "Expected useEffect containing childService.get() in useValidatedSelectedChild",
    );

    const callback = useEffectWithChildGet.arguments[0];
    const getCalls = collectCallNodes(ast, callback).filter((inner) =>
      isMethodCall(ast, inner, "childService", "get"),
    );
    assert.ok(getCalls.length >= 1);
    const firstGetCall = getCalls[0];

    let validEarlyReturnBeforeGet = false;
    walkAst(callback, (node) => {
      if (!ts.isIfStatement(node)) return;
      const condText = node.expression.getText(ast);
      if (!/\bfreshCachedChild\b/.test(condText)) return;

      let thenHasReturn = false;
      let thenCallsChildGet = false;
      walkAst(node.thenStatement, (inner) => {
        if (ts.isReturnStatement(inner)) thenHasReturn = true;
        if (
          ts.isCallExpression(inner) &&
          isMethodCall(ast, inner, "childService", "get")
        ) {
          thenCallsChildGet = true;
        }
      });

      if (
        thenHasReturn &&
        !thenCallsChildGet &&
        node.end <= firstGetCall.getStart(ast)
      ) {
        validEarlyReturnBeforeGet = true;
      }
    });

    assert.ok(
      validEarlyReturnBeforeGet,
      "useValidatedSelectedChild useEffect must early-return before childService.get() when freshCachedChild is present without calling childService.get() inside that branch",
    );
  });
});
