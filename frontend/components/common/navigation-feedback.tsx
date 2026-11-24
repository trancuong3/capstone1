"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

function NavigationFeedbackObserver() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const [pendingRouteKey, setPendingRouteKey] = useState<string | null>(null);
  const routeKeyRef = useRef(routeKey);
  const pendingAnchorRef = useRef<HTMLAnchorElement | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    routeKeyRef.current = routeKey;
    if (pendingAnchorRef.current) {
      delete pendingAnchorRef.current.dataset.navPending;
      pendingAnchorRef.current = null;
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, [routeKey]);

  useEffect(() => {
    const clearPending = () => {
      setPendingRouteKey(null);
      if (pendingAnchorRef.current) {
        delete pendingAnchorRef.current.dataset.navPending;
        pendingAnchorRef.current = null;
      }
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      if (
        anchor.target === "_blank" ||
        anchor.hasAttribute("download") ||
        anchor.getAttribute("href")?.startsWith("#")
      ) {
        return;
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }

      if (nextUrl.origin !== window.location.origin) {
        return;
      }

      if (
        nextUrl.pathname === window.location.pathname &&
        nextUrl.search === window.location.search
      ) {
        return;
      }

      if (pendingAnchorRef.current && pendingAnchorRef.current !== anchor) {
        delete pendingAnchorRef.current.dataset.navPending;
      }
      anchor.dataset.navPending = "true";
      pendingAnchorRef.current = anchor;
      setPendingRouteKey(routeKeyRef.current);

      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(clearPending, 6_000);
    };

    document.addEventListener("click", handleClick, { capture: true });
    return () => {
      document.removeEventListener("click", handleClick, { capture: true });
      clearPending();
    };
  }, []);

  if (pendingRouteKey !== routeKey) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-1 overflow-hidden bg-sky/70"
    >
      <div className="viread-nav-progress-bar h-full w-1/3 rounded-full bg-primary" />
    </div>
  );
}

export function NavigationFeedbackBar() {
  return (
    <Suspense fallback={null}>
      <NavigationFeedbackObserver />
    </Suspense>
  );
}
