"use client";

import { useEffect } from "react";

import { RouteErrorFallback } from "@/components/common/route-fallback";

export default function AppErrorPage({
  error,
  reset,
  retry,
}: {
  readonly error: unknown;
  readonly reset?: () => void;
  readonly retry?: () => void;
}) {
  useEffect(() => {
    // Log diagnostic details safely without exposing raw error text in the UI.
    console.error(error);
  }, [error]);

  return <RouteErrorFallback onRetry={() => (retry ?? reset)?.()} />;
}
