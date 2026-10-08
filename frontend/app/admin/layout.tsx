import type { ReactNode } from "react";
import { AdminServicesProvider } from "@/components/providers/admin-services-provider";

export default function Layout({ children }: { children: ReactNode }) {
  return <AdminServicesProvider>{children}</AdminServicesProvider>;
}
