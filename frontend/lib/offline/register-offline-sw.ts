"use client";

/**
 * Safe registration helper for `/sw.js` (CSP-compliant same-origin Service Worker).
 */

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null =
  null;

export function canRegisterOfflineServiceWorker(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) {
    return false;
  }
  const protocol = window.location?.protocol;
  const hostname = window.location?.hostname;
  return (
    protocol === "https:" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1"
  );
}

export function registerOfflineServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!canRegisterOfflineServiceWorker()) {
    return Promise.resolve(null);
  }
  if (swRegistrationPromise) {
    return swRegistrationPromise;
  }
  swRegistrationPromise = navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .catch(() => null);
  return swRegistrationPromise;
}

export function resetOfflineSwRegistrationForTests(): void {
  swRegistrationPromise = null;
}
