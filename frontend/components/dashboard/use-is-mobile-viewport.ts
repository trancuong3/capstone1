"use client";

import { useSyncExternalStore } from "react";

const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

function subscribe(onStoreChange: () => void): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => undefined;
  }

  const mediaQueryList = window.matchMedia(MOBILE_MEDIA_QUERY);
  if (typeof mediaQueryList.addEventListener === "function") {
    mediaQueryList.addEventListener("change", onStoreChange);
    return () => mediaQueryList.removeEventListener("change", onStoreChange);
  }

  mediaQueryList.addListener(onStoreChange);
  return () => mediaQueryList.removeListener(onStoreChange);
}

function getSnapshot(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }

  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobileViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
