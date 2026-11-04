"use client";

import { useEffect, type ReactNode } from "react";

import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";

function StoreSeeder({ childId }: { childId: string }) {
  const { selectChild } = useAppStore();
  useEffect(() => {
    selectChild(childId);
  }, [childId, selectChild]);
  return null;
}

export function WithSelectedChild({
  childId,
  children,
}: {
  childId: string;
  children: ReactNode;
}) {
  return (
    <AppStoreProvider>
      <StoreSeeder childId={childId} />
      {children}
    </AppStoreProvider>
  );
}
