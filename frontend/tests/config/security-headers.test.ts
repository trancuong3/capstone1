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

  it("emits baseline security headers and CSP compatible with Supabase Storage, WebAudio/AudioWorklet blobs, and OAuth", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.viread.example.org";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    vi.resetModules();

    const { default: nextConfig } = await import("@/next.config");
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe("/:path*");

    const map = new Map(rules[0]?.headers.map((h) => [h.key, h.value]));
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("X-Frame-Options")).toBe("DENY");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(map.get("Permissions-Policy")).toBe(
      "camera=(self), microphone=(self)",
    );

    const csp = map.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("img-src 'self' https: blob: data:");
    expect(csp).toContain("media-src 'self' https: blob: data:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("https://api.viread.example.org");
    expect(csp).toContain("https://proj.supabase.co");
    expect(csp).toContain("https://*.supabase.co");
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
      const csp =
        rules[0]?.headers.find((h) => h.key === "Content-Security-Policy")
          ?.value ?? "";
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
});
