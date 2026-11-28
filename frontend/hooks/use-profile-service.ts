"use client";

import { useContext } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import type { ProfileService } from "@/lib/api/profile-service";

export function useOptionalProfileService(): ProfileService | null {
  const services = useContext(AppServicesContext);
  return services?.profileService ?? null;
}

export function useProfileService(): ProfileService {
  const profileService = useOptionalProfileService();

  if (!profileService) {
    throw new Error(
      "useProfileService must be used inside AppServicesProvider.",
    );
  }

  return profileService;
}
