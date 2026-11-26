"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { clearApiReadCache } from "@/lib/api/read-cache";
import type { ChildProfileDTO } from "@/types/child";

const SELECTED_CHILD_STORAGE_PREFIX = "viread:selected-child:";
const SELECTED_CHILD_SYNC_CHANNEL = "viread:selected-child-sync";
const SELECTED_CHILD_SIGNAL_KEY = "viread:selected-child-signal";

interface ChildSyncMessage {
  userId: string;
  childId: string | null;
  nonce: string;
}

function getUserStorageKey(userId: string | null): string | null {
  return userId ? `${SELECTED_CHILD_STORAGE_PREFIX}${userId}` : null;
}

function normalizeChildId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readPersistedChildId(userId: string | null): string | null {
  const storageKey = getUserStorageKey(userId);
  if (!storageKey || typeof window === "undefined") return null;
  try {
    return normalizeChildId(window.localStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

function writePersistedChildId(
  userId: string | null,
  childId: string | null,
): void {
  const storageKey = getUserStorageKey(userId);
  if (!storageKey || typeof window === "undefined") return;
  try {
    if (childId) {
      window.localStorage.setItem(storageKey, childId);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Ignore storage quota or private-mode restrictions; in-memory state stays authoritative.
  }
}

function purgePersistedChildId(userId: string | null): void {
  writePersistedChildId(userId, null);
}

function purgeAllPersistedChildIds(): void {
  if (typeof window === "undefined") return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(SELECTED_CHILD_STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore restricted storage environments.
  }
}

function broadcastChildSelection(
  userId: string | null,
  childId: string | null,
  channel?: BroadcastChannel | null,
) {
  if (!userId || typeof window === "undefined") return;
  const payload: ChildSyncMessage = {
    userId,
    childId,
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

export interface AppStore {
  selectedChildId: string | null;
  validatedSelectedChild: ChildProfileDTO | null;
  selectChild(childId: string): void;
  clearSelectedChild(): void;
  setValidatedSelectedChild(child: ChildProfileDTO): void;
  syncAvailableChildren(children: readonly ChildProfileDTO[]): void;
}

export const AppStoreContext = createContext<AppStore | null>(null);

interface AppStoreProviderProps {
  children: ReactNode;
  initialChildId?: string | null;
}

interface SelectionState {
  userId: string | null;
  childId: string | null;
  child: ChildProfileDTO | null;
}

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function AppStoreProvider({
  children,
  initialChildId = null,
}: AppStoreProviderProps) {
  const authRuntime = useAuthRuntime();
  const activeUserId =
    authRuntime.lastEvent === "SIGNED_OUT"
      ? null
      : (authRuntime.session?.user?.id ?? authRuntime.initialUserId ?? null);
  const previousUserIdRef = useRef<string | null>(activeUserId);
  const hydratedStorageUserRef = useRef<string | null>(null);
  const syncChannelRef = useRef<BroadcastChannel | null>(null);

  const [selection, setSelection] = useState<SelectionState>(() => ({
    userId: activeUserId,
    childId: normalizeChildId(initialChildId),
    child: null,
  }));

  useIsomorphicLayoutEffect(() => {
    const previousUserId = previousUserIdRef.current;
    previousUserIdRef.current = activeUserId;

    if (authRuntime.lastEvent === "SIGNED_OUT") {
      purgeAllPersistedChildIds();
      if (previousUserId) {
        broadcastChildSelection(previousUserId, null, syncChannelRef.current);
      }
      hydratedStorageUserRef.current = null;
      setSelection({ userId: null, childId: null, child: null });
      return;
    }

    if (previousUserId !== activeUserId) {
      if (previousUserId) {
        purgePersistedChildId(previousUserId);
        if (activeUserId === null) {
          broadcastChildSelection(previousUserId, null, syncChannelRef.current);
        }
      }
      hydratedStorageUserRef.current = activeUserId;

      setSelection((current) => {
        if (
          previousUserId === null &&
          activeUserId !== null &&
          (current.userId === null || current.userId === activeUserId)
        ) {
          if (current.childId) {
            writePersistedChildId(activeUserId, current.childId);
            return {
              userId: activeUserId,
              childId: current.childId,
              child: current.child,
            };
          }
          const persisted = readPersistedChildId(activeUserId);
          return {
            userId: activeUserId,
            childId: persisted,
            child: null,
          };
        }
        const persisted = activeUserId
          ? readPersistedChildId(activeUserId)
          : null;
        return { userId: activeUserId, childId: persisted, child: null };
      });
      return;
    }

    if (activeUserId && hydratedStorageUserRef.current !== activeUserId) {
      hydratedStorageUserRef.current = activeUserId;
      setSelection((current) => {
        if (current.childId) {
          writePersistedChildId(activeUserId, current.childId);
          return current.userId === activeUserId
            ? current
            : {
                userId: activeUserId,
                childId: current.childId,
                child: current.child,
              };
        }
        const persisted = readPersistedChildId(activeUserId);
        if (!persisted) return current;
        return { userId: activeUserId, childId: persisted, child: null };
      });
    }
  }, [activeUserId, authRuntime.lastEvent]);

  useEffect(() => {
    const storageKey = getUserStorageKey(activeUserId);
    if (!activeUserId || typeof window === "undefined") return;

    function applySyncedChildId(nextChildId: string | null) {
      setSelection((current) => {
        if (
          current.userId === activeUserId &&
          current.childId === nextChildId
        ) {
          return current;
        }
        return {
          userId: activeUserId,
          childId: nextChildId,
          child:
            current.userId === activeUserId && current.child?.id === nextChildId
              ? current.child
              : null,
        };
      });
    }

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel(SELECTED_CHILD_SYNC_CHANNEL);
        syncChannelRef.current = channel;
        channel.onmessage = (event: MessageEvent<unknown>) => {
          const data = event.data as Partial<ChildSyncMessage> | null;
          if (
            !data ||
            typeof data !== "object" ||
            data.userId !== activeUserId
          ) {
            return;
          }
          applySyncedChildId(normalizeChildId(data.childId));
        };
      } catch {
        channel = null;
      }
    }

    function handleStorage(event: StorageEvent) {
      if (event.storageArea && event.storageArea !== window.localStorage) {
        return;
      }
      if (event.key === SELECTED_CHILD_SIGNAL_KEY) {
        if (!event.newValue) return;
        try {
          const parsed = JSON.parse(
            event.newValue,
          ) as Partial<ChildSyncMessage> | null;
          if (
            !parsed ||
            typeof parsed !== "object" ||
            parsed.userId !== activeUserId
          ) {
            return;
          }
          applySyncedChildId(normalizeChildId(parsed.childId));
        } catch {
          // Ignore malformed signal payloads.
        }
        return;
      }
      if (event.key === null) {
        applySyncedChildId(null);
        return;
      }
      if (storageKey && event.key === storageKey) {
        applySyncedChildId(normalizeChildId(event.newValue));
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      if (channel) {
        channel.onmessage = null;
        channel.close();
        if (syncChannelRef.current === channel) {
          syncChannelRef.current = null;
        }
      }
    };
  }, [activeUserId]);

  const effectiveSelection = useMemo<{
    childId: string | null;
    child: ChildProfileDTO | null;
  }>(() => {
    if (
      selection.userId === activeUserId ||
      (selection.userId === null && activeUserId !== null)
    ) {
      return { childId: selection.childId, child: selection.child };
    }
    return { childId: null, child: null };
  }, [activeUserId, selection.child, selection.childId, selection.userId]);

  const effectiveChildIdRef = useRef<string | null>(effectiveSelection.childId);
  useIsomorphicLayoutEffect(() => {
    effectiveChildIdRef.current = effectiveSelection.childId;
  }, [effectiveSelection.childId]);

  const previousCacheSelectionRef = useRef({
    userId: activeUserId,
    childId: effectiveSelection.childId,
  });

  useIsomorphicLayoutEffect(() => {
    const previous = previousCacheSelectionRef.current;
    previousCacheSelectionRef.current = {
      userId: activeUserId,
      childId: effectiveSelection.childId,
    };

    // AppServicesProvider already clears the cache when the actor changes.
    // Do not abort in-flight reads on mount or initial auth hydration.
    // Invalidate only on an actual child change for the same actor, before
    // descendant passive effects begin loading the newly selected child.
    if (
      previous.userId === activeUserId &&
      previous.childId !== effectiveSelection.childId
    ) {
      clearApiReadCache();
    }
  }, [activeUserId, effectiveSelection.childId]);

  const selectChild = useCallback(
    (childId: string) => {
      const normalized = normalizeChildId(childId);
      if (!normalized) return;
      const changed = effectiveChildIdRef.current !== normalized;
      effectiveChildIdRef.current = normalized;
      writePersistedChildId(activeUserId, normalized);
      if (changed) {
        broadcastChildSelection(
          activeUserId,
          normalized,
          syncChannelRef.current,
        );
      }
      setSelection((current) =>
        current.userId === activeUserId && current.childId === normalized
          ? current
          : {
              userId: activeUserId,
              childId: normalized,
              child:
                current.userId === activeUserId &&
                current.child?.id === normalized
                  ? current.child
                  : null,
            },
      );
    },
    [activeUserId],
  );

  const clearSelectedChild = useCallback(() => {
    effectiveChildIdRef.current = null;
    purgePersistedChildId(activeUserId);
    broadcastChildSelection(activeUserId, null, syncChannelRef.current);
    setSelection({ userId: activeUserId, childId: null, child: null });
  }, [activeUserId]);

  const setValidatedSelectedChild = useCallback(
    (child: ChildProfileDTO) => {
      setSelection((current) => {
        const sameActor =
          current.userId === activeUserId ||
          (current.userId === null && activeUserId !== null);
        if (!sameActor || current.childId !== child.id) {
          return current;
        }
        return { userId: activeUserId, childId: current.childId, child };
      });
    },
    [activeUserId],
  );

  const syncAvailableChildren = useCallback(
    (availableChildren: readonly ChildProfileDTO[]) => {
      if (availableChildren.length === 0) return;

      const currentChildId = effectiveChildIdRef.current;
      if (!currentChildId && availableChildren.length === 1) {
        const onlyChild = availableChildren[0];
        effectiveChildIdRef.current = onlyChild.id;
        writePersistedChildId(activeUserId, onlyChild.id);
        broadcastChildSelection(
          activeUserId,
          onlyChild.id,
          syncChannelRef.current,
        );
        setSelection({
          userId: activeUserId,
          childId: onlyChild.id,
          child: onlyChild,
        });
        return;
      }

      if (!currentChildId) return;
      const matched = availableChildren.find(
        (candidate) => candidate.id === currentChildId,
      );
      if (!matched) return;

      setSelection((current) => {
        const sameActor =
          current.userId === activeUserId ||
          (current.userId === null && activeUserId !== null);
        if (!sameActor || current.childId !== matched.id) {
          return current;
        }
        if (
          current.userId === activeUserId &&
          current.child?.id === matched.id &&
          current.child.alias === matched.alias &&
          current.child.grade === matched.grade &&
          current.child.avatar_url === matched.avatar_url
        ) {
          return current;
        }
        return {
          userId: activeUserId,
          childId: matched.id,
          child: matched,
        };
      });
    },
    [activeUserId],
  );

  const value = useMemo<AppStore>(
    () => ({
      selectedChildId: effectiveSelection.childId,
      validatedSelectedChild: effectiveSelection.child,
      selectChild,
      clearSelectedChild,
      setValidatedSelectedChild,
      syncAvailableChildren,
    }),
    [
      clearSelectedChild,
      effectiveSelection.child,
      effectiveSelection.childId,
      selectChild,
      setValidatedSelectedChild,
      syncAvailableChildren,
    ],
  );

  return (
    <AppStoreContext.Provider value={value}>
      {children}
    </AppStoreContext.Provider>
  );
}

export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  if (!store) {
    throw new Error("useAppStore must be used inside AppStoreProvider.");
  }
  return store;
}
