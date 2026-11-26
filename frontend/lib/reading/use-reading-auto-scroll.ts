"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface UseReadingAutoScrollOptions {
  /** The dedicated scrollable reading container (never window). */
  readonly containerRef: RefObject<HTMLElement | null>;
  /** Returns the currently active word element inside the container. */
  readonly getActiveElement: () => HTMLElement | null;
  /** Currently active word identifier (advances during reading / TTS). */
  readonly activeWordId: string | null | undefined;
  /** Stable page revision key; changes reset scrollTop to 0 and re-attach. */
  readonly pageKey: string;
  /** Disable auto-scroll (e.g. read-only preview). Defaults to true. */
  readonly enabled?: boolean;
}

export interface UseReadingAutoScrollResult {
  /** True when the user manually scrolled away from the active word. */
  readonly isDetached: boolean;
  /** Re-enable auto-follow and scroll the container back to the active word. */
  readonly resumeAutoFollow: () => void;
}

const BAND_TOP_RATIO = 0.16;
const BAND_BOTTOM_RATIO = 0.6;
const TARGET_TOP_RATIO = 0.26;
const REATTACH_TOP_RATIO = 0.2;
const REATTACH_BOTTOM_RATIO = 0.68;
const DETACH_TOP_RATIO = 0.12;
const DETACH_BOTTOM_RATIO = 0.85;
const PROGRAMMATIC_INSTANT_GUARD_MS = 160;
const PROGRAMMATIC_SMOOTH_GUARD_MS = 950;
const RECENT_USER_SCROLL_WINDOW_MS = 1500;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function isScrollableContainer(container: HTMLElement): boolean {
  return container.scrollHeight > container.clientHeight + 2;
}

function scrollContainerTo(
  container: HTMLElement,
  top: number,
  behavior: ScrollBehavior,
): void {
  if (typeof container.scrollTo === "function") {
    container.scrollTo({ top, behavior });
  } else {
    container.scrollTop = top;
  }
}

/**
 * Container-scoped reading auto-scroll that NEVER scrolls `window` and NEVER
 * hijacks manual user scrolling.
 *
 * Invariants:
 * - Only scrolls `containerRef.current` via `container.scrollTo(...)`.
 * - Scrolls only when `activeWordId` changes and exits `[16%, 78%]` of the
 *   container height, positioning it at ~30% from the top.
 * - Any user scroll (`wheel`, `touchstart`, `touchmove`, `pointerdown`,
 *   keyboard scroll keys, or an external scroll event outside our programmatic
 *   scroll window) detaches auto-follow when the active word leaves the
 *   comfortable band, preventing STT/TTS/transcript/button updates from yanking
 *   the viewport back.
 * - Changing `pageKey` resets `scrollTop = 0` (instant) and clears detachment.
 * - Honors `prefers-reduced-motion: reduce`.
 */
export function useReadingAutoScroll({
  containerRef,
  getActiveElement,
  activeWordId,
  pageKey,
  enabled = true,
}: UseReadingAutoScrollOptions): UseReadingAutoScrollResult {
  const [isDetached, setIsDetached] = useState(false);
  const isDetachedRef = useRef(false);
  const getActiveElementRef = useRef(getActiveElement);
  const prevPageKeyRef = useRef<string | null>(null);
  const prevActiveWordIdRef = useRef<string | null | undefined>(undefined);
  const programmaticStartRef = useRef(0);
  const programmaticUntilRef = useRef(0);
  const userInteractionAtRef = useRef(0);
  const lastObservedScrollTopRef = useRef(0);

  useEffect(() => {
    getActiveElementRef.current = getActiveElement;
  });

  const setDetachedState = useCallback((next: boolean) => {
    if (isDetachedRef.current !== next) {
      isDetachedRef.current = next;
      setIsDetached(next);
    }
  }, []);

  const scrollActiveWordIntoView = useCallback(
    (forceInstant = false) => {
      const container = containerRef.current;
      if (!container || !isScrollableContainer(container)) return;
      const active = getActiveElementRef.current();
      if (!active) return;

      const containerRect = container.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const viewHeight = container.clientHeight;
      if (viewHeight <= 0) return;

      const relTop = activeRect.top - containerRect.top;
      const relBottom = activeRect.bottom - containerRect.top;
      const bandTop = viewHeight * BAND_TOP_RATIO;
      const bandBottom = viewHeight * BAND_BOTTOM_RATIO;

      const fitsInBand =
        activeRect.height <= viewHeight * 0.62
          ? relTop >= bandTop && relBottom <= bandBottom
          : relTop >= 0 && relTop <= bandTop;

      if (fitsInBand) return;

      const desiredOffset =
        activeRect.height <= viewHeight * 0.62
          ? viewHeight * TARGET_TOP_RATIO
          : viewHeight * 0.12;
      const maxScrollTop = Math.max(0, container.scrollHeight - viewHeight);
      const nextTop = Math.max(
        0,
        Math.min(maxScrollTop, container.scrollTop + relTop - desiredOffset),
      );

      if (Math.abs(nextTop - container.scrollTop) < 2) return;

      const instant = forceInstant || prefersReducedMotion();
      const startedAt = nowMs();
      programmaticStartRef.current = startedAt;
      programmaticUntilRef.current =
        startedAt +
        (instant
          ? PROGRAMMATIC_INSTANT_GUARD_MS
          : PROGRAMMATIC_SMOOTH_GUARD_MS);
      scrollContainerTo(container, nextTop, instant ? "instant" : "smooth");
    },
    [containerRef],
  );

  const resumeAutoFollow = useCallback(() => {
    setDetachedState(false);
    scrollActiveWordIntoView(false);
  }, [scrollActiveWordIntoView, setDetachedState]);

  // Attach manual-scroll detection listeners to the reading container.
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const markUserIntent = () => {
      userInteractionAtRef.current = nowMs();
    };

    const handlePointerDown = (event: PointerEvent) => {
      // Clicking/tapping words inside `.reader-leaf` is NOT scrolling.
      // Only treat pointerdown on the scrollbar track (beyond clientWidth) as scroll intent.
      const rect = container.getBoundingClientRect();
      if (event.clientX > rect.left + container.clientWidth) {
        markUserIntent();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === " "
      ) {
        markUserIntent();
      }
    };

    const handleScroll = () => {
      if (!isScrollableContainer(container)) return;
      const prevScrollTop = lastObservedScrollTopRef.current;
      const currentScrollTop = container.scrollTop;
      lastObservedScrollTopRef.current = currentScrollTop;
      const scrollMoved = Math.abs(currentScrollTop - prevScrollTop) > 2;
      const now = nowMs();
      const hasRecentUserGesture =
        userInteractionAtRef.current > 0 &&
        now - userInteractionAtRef.current < RECENT_USER_SCROLL_WINDOW_MS;
      const interruptedSmoothScroll =
        hasRecentUserGesture &&
        userInteractionAtRef.current > programmaticStartRef.current;
      const outsideProgrammaticWindow = now > programmaticUntilRef.current;
      if (!interruptedSmoothScroll && !outsideProgrammaticWindow) {
        return;
      }

      const active = getActiveElementRef.current();
      if (!active) return;

      const viewHeight = container.clientHeight;
      if (viewHeight <= 0) return;

      const containerRect = container.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const relTop = activeRect.top - containerRect.top;
      const relBottom = activeRect.bottom - containerRect.top;

      if (isDetachedRef.current) {
        const backInCenterBand =
          relTop >= viewHeight * REATTACH_TOP_RATIO &&
          relBottom <= viewHeight * REATTACH_BOTTOM_RATIO;
        if (backInCenterBand) {
          setDetachedState(false);
        }
      } else if (
        hasRecentUserGesture ||
        (outsideProgrammaticWindow && scrollMoved)
      ) {
        const leftComfortBand =
          relTop < viewHeight * DETACH_TOP_RATIO ||
          relBottom > viewHeight * DETACH_BOTTOM_RATIO;
        if (leftComfortBand) {
          setDetachedState(true);
        }
      }
    };

    lastObservedScrollTopRef.current = container.scrollTop;
    container.addEventListener("wheel", markUserIntent, { passive: true });
    container.addEventListener("touchstart", markUserIntent, { passive: true });
    container.addEventListener("touchmove", markUserIntent, { passive: true });
    container.addEventListener("pointerdown", handlePointerDown, {
      passive: true,
    });
    container.addEventListener("keydown", handleKeyDown);
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("wheel", markUserIntent);
      container.removeEventListener("touchstart", markUserIntent);
      container.removeEventListener("touchmove", markUserIntent);
      container.removeEventListener("pointerdown", handlePointerDown);
      container.removeEventListener("keydown", handleKeyDown);
      container.removeEventListener("scroll", handleScroll);
    };
  }, [containerRef, enabled, pageKey, setDetachedState]);

  // Reset scroll to top on page change; follow activeWordId only when it
  // actually changes and auto-follow is not detached.
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    const isInitialMount = prevPageKeyRef.current === null;
    const pageChanged = !isInitialMount && prevPageKeyRef.current !== pageKey;
    prevPageKeyRef.current = pageKey;

    if (pageChanged) {
      setDetachedState(false);
      prevActiveWordIdRef.current = activeWordId;
      if (container) {
        const startedAt = nowMs();
        programmaticStartRef.current = startedAt;
        programmaticUntilRef.current = startedAt + 160;
        scrollContainerTo(container, 0, "instant");
      }
      if (activeWordId) {
        scrollActiveWordIntoView(true);
      }
      return;
    }

    if (isInitialMount) {
      prevActiveWordIdRef.current = activeWordId;
      // On initial mount, keep scrollTop = 0 unless an already-distant target
      // word (e.g. restored retry word) is outside the visible area.
      if (activeWordId) {
        scrollActiveWordIntoView(true);
      }
      return;
    }

    if (prevActiveWordIdRef.current === activeWordId) {
      return;
    }
    prevActiveWordIdRef.current = activeWordId;

    if (!activeWordId || isDetachedRef.current) {
      return;
    }

    scrollActiveWordIntoView(false);
  }, [
    activeWordId,
    containerRef,
    enabled,
    pageKey,
    scrollActiveWordIntoView,
    setDetachedState,
  ]);

  return { isDetached, resumeAutoFollow };
}
