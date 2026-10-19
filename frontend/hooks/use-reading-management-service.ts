"use client";

import { useContext } from "react";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import type { ReadingManagementService } from "@/lib/api/reading-management-service";

export function useReadingManagementService(): ReadingManagementService {
  const services = useContext(AppServicesContext);
  if (!services)
    throw new Error(
      "useReadingManagementService must be used inside AppServicesProvider.",
    );
  return services.readingManagementService;
}
