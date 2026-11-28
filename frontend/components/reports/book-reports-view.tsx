"use client";

import { ParentBookReportsScreen } from "@/components/books/parent-book-reports-screen";
import { useIsMobileViewport } from "@/components/dashboard/use-is-mobile-viewport";
import { MobileBookReportsScreen } from "@/components/reports/mobile-book-reports-screen";

export function BookReportsView() {
  const isMobile = useIsMobileViewport();
  return isMobile ? <MobileBookReportsScreen /> : <ParentBookReportsScreen />;
}
