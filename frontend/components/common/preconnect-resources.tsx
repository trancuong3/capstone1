"use client";

import { preconnect, prefetchDNS } from "react-dom";

export interface PreconnectResourcesProps {
  readonly origins: readonly string[];
}

export function PreconnectResources({ origins }: PreconnectResourcesProps) {
  for (const origin of origins) {
    preconnect(origin, { crossOrigin: "anonymous" });
    prefetchDNS(origin);
  }
  return null;
}
