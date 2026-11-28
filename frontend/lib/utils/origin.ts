/**
 * Normalizes, validates (`http:` / `https:` only), and deduplicates origin URLs
 * for `<link rel="preconnect">` and `<link rel="dns-prefetch">` resource hints.
 * Never throws on missing, relative, or malformed environment variables.
 */
export function resolvePreconnectOrigins(
  rawUrls: readonly (string | null | undefined)[],
): readonly string[] {
  const seen = new Set<string>();
  const origins: string[] = [];

  for (const raw of rawUrls) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        continue;
      }
      if (!parsed.origin || parsed.origin === "null") {
        continue;
      }
      if (!seen.has(parsed.origin)) {
        seen.add(parsed.origin);
        origins.push(parsed.origin);
      }
    } catch {
      // Ignore relative paths or malformed URLs.
    }
  }

  return origins;
}
