"use client";

import { useContext } from "react";

import {
  AppServicesContext,
  type AppServices,
} from "@/components/providers/app-services-provider";

export type ReportServices = Pick<
  AppServices,
  | "bookService"
  | "childService"
  | "difficultWordService"
  | "reportService"
  | "sessionService"
>;

export function useReportServices(): ReportServices {
  const services = useContext(AppServicesContext);

  if (!services) {
    throw new Error(
      "useReportServices must be used inside AppServicesProvider.",
    );
  }

  return services;
}
