"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { AdminStoreContext } from "@/components/providers/admin-store-provider";
import type { AdminAuthService } from "@/lib/api/admin-auth-service";
import type { AdminBookService } from "@/lib/api/admin-book-service";
import type { AdminPageService } from "@/lib/api/admin-page-service";
import type { AuditService } from "@/lib/api/audit-service";
import type { HealthService } from "@/lib/api/health-service";
import type { OcrReviewService } from "@/lib/api/ocr-review-service";
import type { RevisionService } from "@/lib/api/revision-service";
import { createMockAdminAuthService } from "@/lib/mock/mock-admin-auth-service";
import { createMockAdminBookService } from "@/lib/mock/mock-admin-book-service";
import { createMockAdminPageService } from "@/lib/mock/mock-admin-page-service";
import { createMockAuditService } from "@/lib/mock/mock-audit-service";
import { createMockHealthService } from "@/lib/mock/mock-health-service";
import { createMockOcrReviewService } from "@/lib/mock/mock-ocr-review-service";
import { createMockRevisionService } from "@/lib/mock/mock-revision-service";
import type { AdminMockScenario } from "@/types/admin";

export interface AdminServices {
  auth: AdminAuthService;
  books: AdminBookService;
  pages: AdminPageService;
  ocr: OcrReviewService;
  revisions: RevisionService;
  audit: AuditService;
  health: HealthService;
}

export const AdminServicesContext = createContext<AdminServices | null>(null);

export function AdminServicesProvider({
  children,
  scenario = "default",
}: {
  children: ReactNode;
  scenario?: AdminMockScenario;
}) {
  const store = useContext(AdminStoreContext);
  if (!store)
    throw new Error("AdminServicesProvider requires AdminStoreProvider");
  const services = useMemo<AdminServices>(
    () => ({
      auth: createMockAdminAuthService(scenario),
      books: createMockAdminBookService(store, scenario),
      pages: createMockAdminPageService(store, scenario),
      ocr: createMockOcrReviewService(store, scenario),
      revisions: createMockRevisionService(store, scenario),
      audit: createMockAuditService(store, scenario),
      health: createMockHealthService(scenario),
    }),
    [scenario, store],
  );
  return (
    <AdminServicesContext.Provider value={services}>
      {children}
    </AdminServicesContext.Provider>
  );
}
