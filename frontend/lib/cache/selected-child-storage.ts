const SELECTED_CHILD_STORAGE_PREFIX = "viread:selected-child:";

export function getSelectedChildStorageKey(
  userId: string | null,
): string | null {
  return userId ? `${SELECTED_CHILD_STORAGE_PREFIX}${userId}` : null;
}

export function normalizeSelectedChildId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function readSessionSelectedChildId(
  userId: string | null,
): string | null {
  const key = getSelectedChildStorageKey(userId);
  if (!key || typeof window === "undefined") return null;
  try {
    return normalizeSelectedChildId(window.sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

export function writeSessionSelectedChildId(
  userId: string | null,
  childId: string | null,
): void {
  const key = getSelectedChildStorageKey(userId);
  if (!key || typeof window === "undefined") return;
  try {
    if (childId) {
      window.sessionStorage.setItem(key, childId);
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore storage quota or private-mode restrictions; in-memory state stays authoritative.
  }
}

export function clearPersistedSelectedChild(
  exceptUserId?: string | null,
): void {
  if (typeof window === "undefined") return;
  const keepKey = exceptUserId
    ? getSelectedChildStorageKey(exceptUserId)
    : null;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (
        key &&
        key.startsWith(SELECTED_CHILD_STORAGE_PREFIX) &&
        key !== keepKey
      ) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore storage errors in restricted environments.
  }
}
