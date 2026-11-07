"use client";

import { useContext } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import type { BookContentReportService } from "@/lib/api/book-content-report-service";

export function useBookContentReportService(): BookContentReportService {
  const services = useContext(AppServicesContext);
  if (!services) {
    throw new Error(
      "useBookContentReportService must be used inside AppServicesProvider.",
    );
  }
  return services.bookContentReportService;
}
