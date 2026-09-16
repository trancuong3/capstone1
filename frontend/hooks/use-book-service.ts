"use client";

import { useContext } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import type { BookService } from "@/lib/api/book-service";

export function useBookService(): BookService {
  const services = useContext(AppServicesContext);

  if (!services) {
    throw new Error("useBookService must be used inside AppServicesProvider.");
  }

  return services.bookService;
}
