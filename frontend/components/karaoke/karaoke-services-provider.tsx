"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import {
  createAdminKaraokeService,
  type AdminKaraokeService,
} from "@/lib/api/admin-karaoke-service";
import {
  createKaraokeService,
  type KaraokeService,
} from "@/lib/api/karaoke-service";

const Context = createContext<AdminKaraokeService | null>(null);
export function KaraokeServicesProvider({
  children,
  service,
}: {
  children: ReactNode;
  service?: AdminKaraokeService;
}) {
  const [value] = useState(() => service ?? createAdminKaraokeService());
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useAdminKaraoke() {
  const value = useContext(Context);
  if (!value) throw new Error("KaraokeServicesProvider is required");
  return value;
}

const ParentContext = createContext<KaraokeService | null>(null);
export function ParentKaraokeServicesProvider({
  children,
  service,
}: {
  children: ReactNode;
  service?: KaraokeService;
}) {
  const [value] = useState(() => service ?? createKaraokeService());
  return (
    <ParentContext.Provider value={value}>{children}</ParentContext.Provider>
  );
}
export function useKaraokeService() {
  const value = useContext(ParentContext);
  if (!value) throw new Error("ParentKaraokeServicesProvider is required");
  return value;
}
