"use client";

import { createContext, useMemo, type ReactNode } from "react";
import type { AdminAuthService } from "@/lib/api/admin-auth-service";
import type { AdminBookService } from "@/lib/api/admin-book-service";
import type { AdminPageService } from "@/lib/api/admin-page-service";
import type { AuditService } from "@/lib/api/audit-service";
import type { HealthService } from "@/lib/api/health-service";
import type { OcrReviewService } from "@/lib/api/ocr-review-service";
import type { RevisionService } from "@/lib/api/revision-service";
import { createAdminBookService } from "@/lib/api/admin-book-service";
import { createAdminPageService } from "@/lib/api/admin-page-service";
import { createAuditService } from "@/lib/api/audit-service";
import { createHealthService } from "@/lib/api/health-service";
import { createOcrReviewService } from "@/lib/api/ocr-review-service";
import { createRevisionService } from "@/lib/api/revision-service";
import { createSupabaseAdminAuthService } from "@/lib/supabase/admin-auth-service";
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
}: {
  /** @deprecated Kept for the existing Auth page; never selects a mock service. */
  authMode?: "mock" | "supabase";
  children: ReactNode;
  /** @deprecated Kept for Auth compatibility; ignored by all real data adapters. */
  scenario?: AdminMockScenario;
}) {
  const services = useMemo<AdminServices>(
    () => ({
      auth: createSupabaseAdminAuthService(),
      books: createAdminBookService(),
      pages: createAdminPageService(),
      ocr: createOcrReviewService(),
      revisions: createRevisionService(),
      audit: createAuditService(),
      health: createHealthService(),
    }),
    [],
  );
  return (
    <AdminServicesContext.Provider value={services}>
      {children}
    </AdminServicesContext.Provider>
  );
}
