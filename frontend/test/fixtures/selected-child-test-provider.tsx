"use client";

import type { ReactNode } from "react";

import { AppStoreProvider } from "@/components/providers/app-store-provider";

export function WithSelectedChild({
  childId,
  children,
}: {
  childId: string;
  children: ReactNode;
}) {
  return (
    <AppStoreProvider initialChildId={childId}>{children}</AppStoreProvider>
  );
}
