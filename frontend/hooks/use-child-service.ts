"use client";

import { useContext } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import type { ChildService } from "@/lib/api/child-service";

export function useChildService(): ChildService {
  const services = useContext(AppServicesContext);

  if (!services) {
    throw new Error("useChildService must be used inside AppServicesProvider.");
  }

  return services.childService;
}
