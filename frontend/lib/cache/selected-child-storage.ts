const SELECTED_CHILD_STORAGE_PREFIX = "viread:selected-child:";
export const SELECTED_CHILD_LOCAL_EVENT = "viread:selected-child-local-change";
export const SELECTED_CHILD_SYNC_CHANNEL = "viread:selected-child-sync";
export const SELECTED_CHILD_SIGNAL_KEY = "viread:selected-child-signal";

export interface LocalSelectedChildChangeDetail {
  readonly userId: string;
  readonly childId: string | null;
}

export interface ChildSyncMessage {
  readonly userId: string;
  readonly childId: string | null;
  readonly nonce: string;
}

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

export function broadcastChildSelection(
  userId: string | null,
  childId: string | null,
  channel?: BroadcastChannel | null,
): void {
  if (!userId || typeof window === "undefined") return;
  const normalizedChildId = normalizeSelectedChildId(childId);
  const payload: ChildSyncMessage = {
    userId,
    childId: normalizedChildId,
    nonce: `${Date.now()}-${Math.random()}`,
  };
  if (channel) {
    try {
      channel.postMessage(payload);
    } catch {
      // Ignore closed/unsupported channel errors; storage signal handles fallback.
    }
  } else if (typeof BroadcastChannel !== "undefined") {
    try {
      const transient = new BroadcastChannel(SELECTED_CHILD_SYNC_CHANNEL);
      transient.postMessage(payload);
      transient.close();
    } catch {
      // Ignore unsupported BroadcastChannel environments.
    }
  }
  try {
    window.localStorage.setItem(
      SELECTED_CHILD_SIGNAL_KEY,
      JSON.stringify(payload),
    );
    window.localStorage.removeItem(SELECTED_CHILD_SIGNAL_KEY);
  } catch {
    // Ignore storage quota or private-mode restrictions; in-memory state stays authoritative.
  }
}

export function dispatchLocalSelectedChildChange(
  userId: string | null,
  childId: string | null,
): void {
  const normalizedChildId = normalizeSelectedChildId(childId);
  writeSessionSelectedChildId(userId, normalizedChildId);
  if (!userId || typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<LocalSelectedChildChangeDetail>(
        SELECTED_CHILD_LOCAL_EVENT,
        {
          detail: { userId, childId: normalizedChildId },
        },
      ),
    );
  } catch {
    // Ignore CustomEvent restrictions in non-standard environments.
  }
}

export function subscribeLocalSelectedChildChange(
  handler: (detail: LocalSelectedChildChangeDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<unknown>;
    const detail = customEvent.detail as
      Partial<LocalSelectedChildChangeDetail> | null | undefined;
    if (
      !detail ||
      typeof detail !== "object" ||
      typeof detail.userId !== "string"
    ) {
      return;
    }
    handler({
      userId: detail.userId,
      childId: normalizeSelectedChildId(detail.childId),
    });
  };
  window.addEventListener(SELECTED_CHILD_LOCAL_EVENT, listener);
  return () => {
    window.removeEventListener(SELECTED_CHILD_LOCAL_EVENT, listener);
  };
}
