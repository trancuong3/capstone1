import type { ReactNode } from "react";

import { requireAppRole } from "@/lib/auth/server-authorization";

export default async function SessionReportLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  await requireAppRole("parent");
  return children;
}
