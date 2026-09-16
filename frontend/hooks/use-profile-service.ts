"use client";

import { useContext } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import type { ProfileService } from "@/lib/api/profile-service";

export function useProfileService(): ProfileService {
  const services = useContext(AppServicesContext);

  if (!services) {
    throw new Error(
      "useProfileService must be used inside AppServicesProvider.",
    );
  }

  return services.profileService;
}
