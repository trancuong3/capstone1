import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

function resolveTurbopackRoot(): string | undefined {
  if (process.env.TURBOPACK_ROOT) {
    return process.env.TURBOPACK_ROOT;
  }
  const projectDir = path.resolve(process.cwd());
  const nodeModulesPath = path.join(projectDir, "node_modules");
  try {
    const realNodeModules = fs.realpathSync(nodeModulesPath);
    const relative = path.relative(projectDir, realNodeModules);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return undefined;
    }
    const projectParts = projectDir.split(path.sep);
    const targetParts = realNodeModules.split(path.sep);
    const shared: string[] = [];
    for (
      let i = 0;
      i < Math.min(projectParts.length, targetParts.length);
      i += 1
    ) {
      if (projectParts[i].toLowerCase() !== targetParts[i].toLowerCase()) break;
      shared.push(projectParts[i]);
    }
    if (shared.length === 0) return undefined;
    const ancestor = shared.join(path.sep) || path.sep;
    return ancestor.endsWith(":") ? `${ancestor}${path.sep}` : ancestor;
  } catch {
    return undefined;
  }
}

function extractOrigin(rawUrl: string | undefined): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function buildContentSecurityPolicy(): string {
  const isDev = process.env.NODE_ENV === "development";
  const supabaseOrigin = extractOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const apiOrigin = extractOrigin(process.env.NEXT_PUBLIC_API_URL);
  const isLocalApi =
    !apiOrigin ||
    apiOrigin.startsWith("http://127.0.0.1") ||
    apiOrigin.startsWith("http://localhost");

  const connectSources = new Set<string>([
    "'self'",
    "blob:",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    "https://huggingface.co",
    "https://*.hf.co",
  ]);
  if (supabaseOrigin) {
    connectSources.add(supabaseOrigin);
    connectSources.add(supabaseOrigin.replace(/^http/, "ws"));
  }
  if (apiOrigin) {
    connectSources.add(apiOrigin);
    connectSources.add(apiOrigin.replace(/^http/, "ws"));
  }
  if (isDev || isLocalApi) {
    connectSources.add("http://127.0.0.1:*");
    connectSources.add("http://localhost:*");
    connectSources.add("ws://127.0.0.1:*");
    connectSources.add("ws://localhost:*");
  }

  // Local development serves page images and audio from the configured loopback API.
  // Never allow arbitrary HTTP origins or relax the production media policy.
  const localMediaOrigin =
    isDev &&
    apiOrigin &&
    /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(apiOrigin)
      ? ` ${apiOrigin}`
      : "";

  const formActionSources = new Set<string>([
    "'self'",
    "https://*.supabase.co",
  ]);
  if (supabaseOrigin) {
    formActionSources.add(supabaseOrigin);
  }

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' https: blob: data:${localMediaOrigin}`,
    `media-src 'self' https: blob: data:${localMediaOrigin}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src ${Array.from(connectSources).join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${Array.from(formActionSources).join(" ")}`,
    "frame-ancestors 'none'",
  ];

  return directives.join("; ");
}

const turbopackRoot = resolveTurbopackRoot();

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  poweredByHeader: false,
  ...(turbopackRoot ? { turbopack: { root: turbopackRoot } } : {}),
  async headers() {
    return [
      {
        source: "/wasm/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self)",
          },
          {
            key: "Content-Security-Policy",
            value: buildContentSecurityPolicy(),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
