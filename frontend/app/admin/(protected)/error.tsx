"use client";

import { useEffect } from "react";

import { RouteErrorFallback } from "@/components/common/route-fallback";

function readErrorDigest(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.trim().length > 0
  ) {
    return error.digest.trim();
  }
  return null;
}

export default function AdminProtectedErrorBoundary({
  error,
  retry,
  reset,
}: {
  readonly error: unknown;
  readonly retry?: () => void;
  readonly reset?: () => void;
}) {
  useEffect(() => {
    const digest = readErrorDigest(error);
    // Log diagnostic details safely without exposing raw error text in the UI.
    console.error("[ViReadErrorBoundary]", digest ? { error, digest } : error);
  }, [error]);

  const handleRetry = () => {
    if (typeof retry === "function") {
      retry();
      return;
    }
    if (typeof reset === "function") {
      reset();
      return;
    }
    window.location.reload();
  };

  return <RouteErrorFallback onRetry={handleRetry} />;
}
