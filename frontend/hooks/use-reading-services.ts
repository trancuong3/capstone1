"use client";

import { useContext } from "react";

import {
  AppServicesContext,
  type AppServices,
} from "@/components/providers/app-services-provider";

export type ReadingServices = Pick<
  AppServices,
  | "bookService"
  | "childService"
  | "comprehensionService"
  | "devicePermissionService"
  | "pageMatchService"
  | "readingService"
  | "readingSocketAdapter"
  | "tutorService"
>;

export function useReadingServices(): ReadingServices {
  const services = useContext(AppServicesContext);

  if (!services) {
    throw new Error(
      "useReadingServices must be used inside AppServicesProvider.",
    );
  }

  return services;
}
