"use client";

import { useContext } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import type { SentenceShooterService } from "@/lib/api/sentence-shooter-service";

export function useSentenceShooterService(): SentenceShooterService {
  const services = useContext(AppServicesContext);
  if (!services?.sentenceShooterService) {
    throw new Error(
      "useSentenceShooterService must be used inside AppServicesProvider.",
    );
  }
  return services.sentenceShooterService;
}
