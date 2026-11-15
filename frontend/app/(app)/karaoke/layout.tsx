import type { ReactNode } from "react";
import { ParentKaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";

export default function KaraokeLayout({ children }: { children: ReactNode }) {
  return (
    <ParentKaraokeServicesProvider>{children}</ParentKaraokeServicesProvider>
  );
}
