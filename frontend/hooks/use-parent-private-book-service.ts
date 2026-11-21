"use client";

import { useContext } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import {
  createParentPrivateBookService,
  type ParentPrivateBookService,
} from "@/lib/api/parent-private-book-service";

const fallbackService = createParentPrivateBookService();

export function useParentPrivateBookService(): ParentPrivateBookService {
  const context = useContext(AppServicesContext);
  return context?.parentPrivateBookService ?? fallbackService;
}
