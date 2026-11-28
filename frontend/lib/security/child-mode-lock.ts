/**
 * Per-user Child-Safe Mode Lock state (Wave 1 Feature #4).
 *
 * When a parent turns on Child-Safe Mode (`isChildModeLocked === true`), parent-only
 * management/settings routes and destructive actions (Sign Out, Child Management,
 * Private Book Studio, Settings) require entering the parent's 4-digit PIN.
 *
 * Defaults to `false` so existing unconfigured parent sessions are never blocked.
 */

const STORAGE_PREFIX = "viread:child-mode-lock:";
const CHANNEL_NAME = "viread:child-mode-lock-sync";

const listeners = new Set<() => void>();
let broadcastChannel: BroadcastChannel | null = null;

function ensureChannel(): BroadcastChannel | null {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return null;
  }
  if (!broadcastChannel) {
    try {
      broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
      broadcastChannel.onmessage = () => {
        listeners.forEach((fn) => fn());
      };
    } catch {
      broadcastChannel = null;
    }
  }
  return broadcastChannel;
}

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function isChildModeLockedForUser(
  userId: string | null | undefined,
): boolean {
  if (!userId || typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(storageKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function setChildModeLockedForUser(
  userId: string | null | undefined,
  locked: boolean,
): void {
  if (!userId || typeof window === "undefined") return;
  try {
    if (locked) {
      window.sessionStorage.setItem(storageKey(userId), "1");
    } else {
      window.sessionStorage.removeItem(storageKey(userId));
    }
  } catch {
    // Ignore storage quota errors in restricted WebViews.
  }
  listeners.forEach((fn) => fn());
  try {
    ensureChannel()?.postMessage({ userId, locked });
  } catch {
    // Ignore closed channel errors.
  }
}

export function clearChildModeLockForUser(
  userId: string | null | undefined,
): void {
  setChildModeLockedForUser(userId, false);
}

export function subscribeChildModeLock(listener: () => void): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Returns true when `pathname` is an adult/parent-management route that should be
 * protected by the 4-digit Parent PIN while Child-Safe Mode is active.
 */
export function isParentProtectedRoute(pathname: string): boolean {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (
    clean === "/reports/difficult-words" ||
    clean.startsWith("/reports/difficult-words/")
  ) {
    // Word practice stays accessible to children!
    return false;
  }
  const protectedPrefixes = [
    "/my-books",
    "/reading-management",
    "/settings",
    "/profile",
    "/children",
    "/reports",
    "/sessions",
    "/book-reports",
    "/studio",
    "/device-permissions",
  ];
  return protectedPrefixes.some(
    (prefix) => clean === prefix || clean.startsWith(`${prefix}/`),
  );
}
