import type { ReactNode } from "react";
import { KaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";

export default function KaraokeLayout({ children }: { children: ReactNode }) {
  return <KaraokeServicesProvider>{children}</KaraokeServicesProvider>;
}
