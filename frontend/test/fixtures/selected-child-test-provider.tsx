"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  AppStoreContext,
  type AppStore,
} from "@/components/providers/app-store-provider";
import type { ChildProfileDTO } from "@/types/child";

interface Selection {
  childId: string;
  child: ChildProfileDTO | null;
}

function SelectedChildStore({
  childId,
  children,
}: {
  childId: string;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<Selection>(() => ({
    childId,
    child: null,
  }));

  const selectChild = useCallback((nextChildId: string) => {
    if (!nextChildId) return;
    setSelection((current) =>
      current.childId === nextChildId
        ? current
        : { childId: nextChildId, child: null },
    );
  }, []);

  const clearSelectedChild = useCallback(() => {
    setSelection({ childId: "", child: null });
  }, []);

  const setValidatedSelectedChild = useCallback((child: ChildProfileDTO) => {
    setSelection((current) =>
      current.childId === child.id ? { ...current, child } : current,
    );
  }, []);

  const value = useMemo<AppStore>(
    () => ({
      selectedChildId: selection.childId || null,
      validatedSelectedChild: selection.child,
      selectChild,
      clearSelectedChild,
      setValidatedSelectedChild,
    }),
    [
      clearSelectedChild,
      selectChild,
      selection.child,
      selection.childId,
      setValidatedSelectedChild,
    ],
  );

  return (
    <AppStoreContext.Provider value={value}>
      {children}
    </AppStoreContext.Provider>
  );
}

export function WithSelectedChild({
  childId,
  children,
}: {
  childId: string;
  children: ReactNode;
}) {
  return (
    <SelectedChildStore childId={childId}>{children}</SelectedChildStore>
  );
}
