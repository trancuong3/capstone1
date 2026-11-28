// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

describe("Next.js HTTP security headers", () => {
  const prevApiUrl = process.env.NEXT_PUBLIC_API_URL;
  const prevSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  afterEach(() => {
    if (prevApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = prevApiUrl;
    if (prevSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = prevSupabaseUrl;
    }
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("emits baseline security headers, static asset caching, HSTS in non-dev, and CSP compatible with Supabase Storage, WebAudio/AudioWorklet blobs, and OAuth", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.NEXT_PUBLIC_API_URL = "https://api.viread.example.org";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    vi.resetModules();

    const { default: nextConfig } = await import("@/next.config");
    const rules = (await nextConfig.headers?.()) ?? [];
    const bySource = new Map(
      rules.map((rule) => [
        rule.source,
        new Map(rule.headers.map((h) => [h.key, h.value])),
      ]),
    );

    expect(bySource.get("/wasm/:path*")?.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(bySource.get("/images/:path*")?.get("Cache-Control")).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
    expect(bySource.get("/audio/:path*")?.get("Cache-Control")).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
    expect(bySource.get("/workers/:path*")?.get("Cache-Control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );

    const map = bySource.get("/:path*");
    expect(map).toBeDefined();
    expect(map?.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map?.get("X-Frame-Options")).toBe("DENY");
    expect(map?.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(map?.get("Permissions-Policy")).toBe(
      "camera=(self), microphone=(self)",
    );
    expect(map?.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );

    const csp = map?.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    );
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("img-src 'self' https: blob: data:");
    expect(csp).toContain("media-src 'self' https: blob: data:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("https://api.viread.example.org");
    expect(csp).toContain("https://proj.supabase.co");
    expect(csp).toContain("https://*.supabase.co");
    expect(csp).toContain("https://huggingface.co");
    expect(csp).toContain("https://*.hf.co");
  });

  it("omits Strict-Transport-Security in development mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const { default: devConfig } = await import("@/next.config");
    const rules = (await devConfig.headers?.()) ?? [];
    const pageRule = rules.find((rule) => rule.source === "/:path*");
    expect(
      pageRule?.headers.find((h) => h.key === "Strict-Transport-Security"),
    ).toBeUndefined();
  });

  it.each([
    ["development", "http://127.0.0.1:8000", true],
    ["development", "http://localhost:8000", true],
    ["development", "http://localhost.evil.example:8000", false],
    ["production", "http://127.0.0.1:8000", false],
  ] as const)(
    "limits HTTP media origins in %s for %s",
    async (environment, origin, allowed) => {
      vi.stubEnv("NODE_ENV", environment);
      vi.stubEnv("NEXT_PUBLIC_API_URL", origin);
      vi.resetModules();
      const { default: config } = await import("@/next.config");
      const rules = (await config.headers?.()) ?? [];
      const pageRule = rules.find((rule) => rule.source === "/:path*");
      expect(pageRule).toBeDefined();
      const csp =
        pageRule?.headers.find((h) => h.key === "Content-Security-Policy")
          ?.value ?? "";
      expect(csp).not.toBe("");
      for (const directive of ["img-src", "media-src"]) {
        const sources = csp
          .split("; ")
          .find((part) => part.startsWith(`${directive} `))
          ?.split(" ");
        expect(sources?.includes(origin)).toBe(allowed);
        expect(sources).not.toContain("http:");
        expect(sources).not.toContain("http://127.0.0.1:*");
      }
    },
  );

  it("applies Playwright dev memory guardrails only for development auth-fixture runs", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PLAYWRIGHT_AUTH_FIXTURES", "1");
    vi.resetModules();
    const { default: playwrightDevConfig } = await import("@/next.config");
    expect(playwrightDevConfig.experimental).toMatchObject({
      devMemoryThresholdRestart: false,
      serverComponentsHmrCache: false,
      webpackMemoryOptimizations: true,
    });

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLAYWRIGHT_AUTH_FIXTURES", "1");
    vi.resetModules();
    const { default: prodConfig } = await import("@/next.config");
    expect(prodConfig.experimental).toBeUndefined();

    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PLAYWRIGHT_AUTH_FIXTURES", "");
    vi.resetModules();
    const { default: normalDevConfig } = await import("@/next.config");
    expect(normalDevConfig.experimental).toBeUndefined();
  });
});
