const LEGACY_LAST_SCAN_JOB_KEY = "viread:book-scanner:last-job-id";
const SCOPED_SCAN_JOB_PREFIX = "viread:book-scanner:last-job-id:";

function scopedKey(userId: string | null | undefined): string | null {
  const trimmed = userId?.trim();
  if (!trimmed) return null;
  return `${SCOPED_SCAN_JOB_PREFIX}${trimmed}`;
}

export function readStoredScanJobId(
  userId: string | null | undefined,
): string | null {
  if (typeof window === "undefined") return null;
  try {
    // Always purge unscoped legacy key so another parent in the same tab cannot inherit it.
    window.sessionStorage.removeItem(LEGACY_LAST_SCAN_JOB_KEY);
    const key = scopedKey(userId);
    if (!key) return null;
    const raw = window.sessionStorage.getItem(key);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function writeStoredScanJobId(
  userId: string | null | undefined,
  jobId: string | null,
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(LEGACY_LAST_SCAN_JOB_KEY);
    const key = scopedKey(userId);
    if (!key) return;
    if (jobId && jobId.trim()) {
      window.sessionStorage.setItem(key, jobId.trim());
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore restricted storage contexts.
  }
}

export function clearStoredScanJobIds(preserveUserId?: string | null): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(LEGACY_LAST_SCAN_JOB_KEY);
    const keepKey = scopedKey(preserveUserId);
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key && key.startsWith(SCOPED_SCAN_JOB_PREFIX) && key !== keepKey) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore restricted storage contexts.
  }
}
