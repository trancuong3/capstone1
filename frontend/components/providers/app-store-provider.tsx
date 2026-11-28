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
  SELECTED_CHILD_SIGNAL_KEY,
  SELECTED_CHILD_SYNC_CHANNEL,
  broadcastChildSelection,
  clearPersistedSelectedChild,
  getSelectedChildStorageKey,
  normalizeSelectedChildId,
  readSessionSelectedChildId,
  subscribeLocalSelectedChildChange,
  writeSessionSelectedChildId,
  type ChildSyncMessage,
} from "@/lib/cache/selected-child-storage";
import {
  hydrateTeacherVoiceFromChildProfile,
  resetTeacherVoiceForActorSwitch,
} from "@/lib/reading/session-voice-lock";
import type { ChildProfileDTO } from "@/types/child";

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

function stableSettingsKey(
  settings: Record<string, unknown> | null | undefined,
): string {
  if (!settings || typeof settings !== "object") return "{}";
  try {
    return JSON.stringify(settings);
  } catch {
    return "{}";
  }
}

export function areEquivalentChildProfiles(
  left: ChildProfileDTO | null | undefined,
  right: ChildProfileDTO | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    left.parent_id === right.parent_id &&
    left.alias === right.alias &&
    left.grade === right.grade &&
    (left.avatar_url ?? null) === (right.avatar_url ?? null) &&
    left.created_at === right.created_at &&
    stableSettingsKey(left.settings) === stableSettingsKey(right.settings)
  );
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
      resetTeacherVoiceForActorSwitch();
      if (previousUserId && previousUserId !== activeUserId) {
        broadcastChildSelection(previousUserId, null, syncChannelRef.current);
      }
    } else if (previousUserId && previousUserId !== activeUserId) {
      clearPersistedSelectedChild();
      resetTeacherVoiceForActorSwitch();
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

    const unsubscribeLocal = subscribeLocalSelectedChildChange((detail) => {
      if (detail.userId !== activeUserId) {
        return;
      }
      applySyncedChildId(normalizeSelectedChildId(detail.childId));
    });

    window.addEventListener("storage", handleStorage);
    return () => {
      unsubscribeLocal();
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

  useEffect(() => {
    if (effectiveSelection.child) {
      hydrateTeacherVoiceFromChildProfile(effectiveSelection.child);
    }
  }, [effectiveSelection.child]);

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
        const effectiveUserId =
          current.userId === null && activeUserId !== null
            ? activeUserId
            : current.userId;
        const effectiveChildId =
          current.userId === null && activeUserId !== null
            ? (current.childId ?? readSessionSelectedChildId(activeUserId))
            : current.childId;
        if (effectiveUserId !== activeUserId || effectiveChildId !== child.id) {
          return current;
        }
        if (
          current.userId === activeUserId &&
          current.childId === effectiveChildId &&
          areEquivalentChildProfiles(current.child, child)
        ) {
          return current;
        }
        return {
          userId: activeUserId,
          childId: effectiveChildId,
          child,
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
