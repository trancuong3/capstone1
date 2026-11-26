import { pathToFileURL } from "node:url";

/**
 * Fail closed before building a public Next.js deployment.
 * This is a configuration preflight, NOT a proof of real HTTPS availability,
 * Supabase login, CORS, or backend health.
 */
function required(name, env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(name + ": required for the hosting build");
  return value;
}

export function publicHttpsOrigin(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(name + ": expected an HTTPS origin");
  }

  const hostname = parsed.hostname.toLowerCase();
  const reserved =
    hostname === "localhost" ||
    hostname === "example.com" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".invalid") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".example") ||
    hostname.endsWith(".example.com") ||
    hostname.startsWith("example.") ||
    /^\d+(?:\.\d+){3}$/.test(hostname) ||
    hostname.includes(":");

  if (
    parsed.protocol !== "https:" ||
    !hostname.includes(".") ||
    reserved ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      name +
        ": must be a public HTTPS origin without a path, query, credentials, or nonstandard port",
    );
  }

  return parsed.origin;
}

export function checkPublishableKey(key) {
  // Never reveal any part of the supplied key in errors or logs.
  if (/^sb_publishable_[A-Za-z0-9_-]{12,}$/.test(key)) return;

  // Legacy public anon JWT keys can be used by existing Supabase projects.
  // Verify the declared role rather than accepting any JWT (e.g. service_role).
  try {
    const parts = key.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) {
      throw new Error("not a JWT");
    }
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (payload?.role === "anon") return;
  } catch {
    // Do not report the key or decoder details.
  }

  throw new Error(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: expected a Supabase publishable or legacy anon key, never a secret/service_role key",
  );
}

export function checkSsrSigningKey(key) {
  // Never reveal any part of the supplied signing key in errors or logs.
  const trimmed = typeof key === "string" ? key.trim() : "";
  const isPlaceholder =
    /^(?:your-|change[-_]?me|placeholder|example|replace[-_]?me|<)/i.test(
      trimmed,
    );
  const isSingleRepeatedChar =
    trimmed.length > 0 && new Set(trimmed).size === 1;

  if (trimmed.length < 32 || isPlaceholder || isSingleRepeatedChar) {
    throw new Error(
      "VIREAD_SSR_AUTH_SIGNING_KEY: must be a non-placeholder server-only signing secret of at least 32 characters",
    );
  }
}

export function verifyHostingEnvironment(env = process.env) {
  const publicNames = Object.keys(env).filter(
    (name) => name.startsWith("NEXT_PUBLIC_") && env[name],
  );
  if (
    publicNames.some((name) =>
      /(?:SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|ACCESS_TOKEN|ROOT_KEY|SIGNING_KEY)/i.test(
        name,
      ),
    )
  ) {
    throw new Error(
      "Hosting environment contains a forbidden browser-public secret variable name",
    );
  }
  if (/^(?:1|true|yes|on)$/i.test(env.PLAYWRIGHT_AUTH_FIXTURES?.trim() ?? "")) {
    throw new Error(
      "PLAYWRIGHT_AUTH_FIXTURES must not be enabled in hosted deployments",
    );
  }

  const supabaseUrl = publicHttpsOrigin(
    "NEXT_PUBLIC_SUPABASE_URL",
    required("NEXT_PUBLIC_SUPABASE_URL", env),
  );
  checkPublishableKey(required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", env));
  checkSsrSigningKey(required("VIREAD_SSR_AUTH_SIGNING_KEY", env));

  const apiUrl = publicHttpsOrigin(
    "NEXT_PUBLIC_API_URL",
    required("NEXT_PUBLIC_API_URL", env),
  );
  const apiHost = new URL(apiUrl).hostname;
  if (
    apiUrl === supabaseUrl ||
    apiHost.endsWith(".github.io") ||
    apiHost.endsWith(".vercel.app")
  ) {
    throw new Error(
      "NEXT_PUBLIC_API_URL must point to the actual HTTPS FastAPI service, not Supabase or a frontend/static site",
    );
  }

  // Return only nonsecret origins; never serialize a key to CI output.
  return { supabaseUrl, apiUrl };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    verifyHostingEnvironment();
    console.log(
      "ViRead hosting preflight passed (public HTTPS origins and safe key type).",
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid hosting environment",
    );
    process.exitCode = 1;
  }
}
