"use client";

import { useContext } from "react";
import { AdminServicesContext } from "@/components/providers/admin-services-provider";

export function useAdminServices() {
  const services = useContext(AdminServicesContext);
  if (!services)
    throw new Error("useAdminServices requires AdminServicesProvider");
  return services;
}
