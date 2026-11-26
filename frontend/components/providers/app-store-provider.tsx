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
import {
  clearPersistedSelectedChild,
  getSelectedChildStorageKey,
  normalizeSelectedChildId,
  readSessionSelectedChildId,
  writeSessionSelectedChildId,
} from "@/lib/cache/selected-child-storage";
import type { ChildProfileDTO } from "@/types/child";

const SELECTED_CHILD_SYNC_CHANNEL = "viread:selected-child-sync";
const SELECTED_CHILD_SIGNAL_KEY = "viread:selected-child-signal";

interface ChildSyncMessage {
  userId: string;
  childId: string | null;
  nonce: string;
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

export function AppStoreProvider({
  children,
  initialChildId = null,
}: AppStoreProviderProps) {
  const authRuntime = useAuthRuntime();
  const activeUserId = authRuntime.session?.user?.id ?? null;
  const previousUserIdRef = useRef<string | null>(activeUserId);
  const syncChannelRef = useRef<BroadcastChannel | null>(null);

  const [selection, setSelection] = useState<SelectionState>(() => ({
    userId: activeUserId,
    childId:
      normalizeSelectedChildId(initialChildId) ??
      readSessionSelectedChildId(activeUserId),
    child: null,
  }));

  useEffect(() => {
    const previousUserId = previousUserIdRef.current;
    previousUserIdRef.current = activeUserId;

    if (authRuntime.lastEvent === "SIGNED_OUT") {
      clearPersistedSelectedChild();
      if (previousUserId && previousUserId !== activeUserId) {
        broadcastChildSelection(previousUserId, null, syncChannelRef.current);
      }
    } else if (previousUserId && previousUserId !== activeUserId) {
      clearPersistedSelectedChild();
      broadcastChildSelection(previousUserId, null, syncChannelRef.current);
    } else if (activeUserId) {
      clearPersistedSelectedChild(activeUserId);
    }

    if (previousUserId !== activeUserId) {
      setSelection((current) => {
        if (
          previousUserId === null &&
          activeUserId !== null &&
          (current.userId === null || current.userId === activeUserId)
        ) {
          return {
            userId: activeUserId,
            childId:
              current.childId ?? readSessionSelectedChildId(activeUserId),
            child: current.child,
          };
        }
        return { userId: activeUserId, childId: null, child: null };
      });
    }
  }, [activeUserId, authRuntime.lastEvent]);

  useEffect(() => {
    const storageKey = getSelectedChildStorageKey(activeUserId);
    if (!activeUserId || typeof window === "undefined") return;

    function applySyncedChildId(nextChildId: string | null) {
      writeSessionSelectedChildId(activeUserId, nextChildId);
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
          applySyncedChildId(normalizeSelectedChildId(data.childId));
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
          applySyncedChildId(normalizeSelectedChildId(parsed.childId));
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
        applySyncedChildId(normalizeSelectedChildId(event.newValue));
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
    if (selection.userId === activeUserId) {
      return { childId: selection.childId, child: selection.child };
    }
    if (selection.userId === null && activeUserId !== null) {
      return {
        childId: selection.childId ?? readSessionSelectedChildId(activeUserId),
        child: selection.child,
      };
    }
    return { childId: null, child: null };
  }, [activeUserId, selection.child, selection.childId, selection.userId]);

  const previousCacheSelectionRef = useRef({
    userId: activeUserId,
    childId: effectiveSelection.childId,
  });

  useLayoutEffect(() => {
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
      const normalized = normalizeSelectedChildId(childId);
      if (!normalized) return;
      writeSessionSelectedChildId(activeUserId, normalized);
      broadcastChildSelection(activeUserId, normalized, syncChannelRef.current);
      setSelection((current) =>
        current.userId === activeUserId && current.childId === normalized
          ? current
          : { userId: activeUserId, childId: normalized, child: null },
      );
    },
    [activeUserId],
  );

  const clearSelectedChild = useCallback(() => {
    writeSessionSelectedChildId(activeUserId, null);
    broadcastChildSelection(activeUserId, null, syncChannelRef.current);
    setSelection({ userId: activeUserId, childId: null, child: null });
  }, [activeUserId]);

  const setValidatedSelectedChild = useCallback(
    (child: ChildProfileDTO) => {
      setSelection((current) => {
        if (current.userId !== activeUserId || current.childId !== child.id) {
          return current;
        }
        return { userId: activeUserId, childId: current.childId, child };
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
    }),
    [
      clearSelectedChild,
      effectiveSelection.child,
      effectiveSelection.childId,
      selectChild,
      setValidatedSelectedChild,
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
