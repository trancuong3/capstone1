"use client";

import { useContext } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import type { PictureDescriptionService } from "@/lib/api/picture-description-service";

export function usePictureDescriptionService(): PictureDescriptionService {
  const services = useContext(AppServicesContext);
  if (!services?.pictureDescriptionService) {
    throw new Error(
      "usePictureDescriptionService must be used inside AppServicesProvider.",
    );
  }
  return services.pictureDescriptionService;
}
