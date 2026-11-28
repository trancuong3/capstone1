"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchOcrWorkerHealth,
  type OcrWorkerHealthSnapshot,
} from "@/lib/api/page-match-service";

export type OcrWorkerAvailabilityState =
  "checking" | "ready" | "unavailable" | "unreachable";

export interface UseOcrWorkerStatusOptions {
  readonly enabled?: boolean;
  readonly pollIntervalMs?: number;
  readonly onRecovered?: () => void;
}

export interface UseOcrWorkerStatusResult {
  readonly status: OcrWorkerAvailabilityState;
  readonly isReady: boolean;
  readonly isUnavailable: boolean;
  readonly isChecking: boolean;
  readonly justRecovered: boolean;
  readonly queueDepth: number;
  readonly mode: string | null;
  readonly probeDegraded: boolean;
  readonly recheckNow: () => Promise<OcrWorkerAvailabilityState>;
  readonly dismissRecoveredNotice: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 12_000;
const HEALTH_PROBE_TIMEOUT_MS = 12_000;

export function useOcrWorkerStatus(
  options: UseOcrWorkerStatusOptions = {},
): UseOcrWorkerStatusResult {
  const enabled = options.enabled ?? true;
  const rawPollInterval = options.pollIntervalMs;
  const pollIntervalMs =
    typeof rawPollInterval === "number" &&
    Number.isFinite(rawPollInterval) &&
    rawPollInterval > 0
      ? Math.max(50, Math.floor(rawPollInterval))
      : DEFAULT_POLL_INTERVAL_MS;

  const [status, setStatus] = useState<OcrWorkerAvailabilityState>("checking");
  const [manualRechecking, setManualRechecking] = useState(false);
  const [justRecovered, setJustRecovered] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const [mode, setMode] = useState<string | null>(null);
  const [probeDegraded, setProbeDegraded] = useState(false);

  const onRecoveredRef = useRef(options.onRecovered);
  useEffect(() => {
    onRecoveredRef.current = options.onRecovered;
  }, [options.onRecovered]);

  const wasOfflineRef = useRef(false);
  const mountedRef = useRef(true);
  const activeControllerRef = useRef<AbortController | null>(null);
  const probeIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      probeIdRef.current += 1;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
    };
  }, []);

  const applySnapshot = useCallback((snapshot: OcrWorkerHealthSnapshot) => {
    setStatus(snapshot.status);
    setQueueDepth(snapshot.queueDepth);
    setMode(snapshot.mode);
    setProbeDegraded(snapshot.probeDegraded);

    if (snapshot.status === "ready") {
      if (wasOfflineRef.current) {
        wasOfflineRef.current = false;
        setJustRecovered(true);
        onRecoveredRef.current?.();
      } else {
        wasOfflineRef.current = false;
      }
    } else {
      wasOfflineRef.current = true;
      setJustRecovered(false);
    }
  }, []);

  const runProbe =
    useCallback(async (): Promise<OcrWorkerAvailabilityState> => {
      activeControllerRef.current?.abort();
      const controller = new AbortController();
      activeControllerRef.current = controller;
      const probeId = ++probeIdRef.current;

      const timeoutId = globalThis.setTimeout(() => {
        controller.abort();
      }, HEALTH_PROBE_TIMEOUT_MS);

      try {
        const snapshot = await fetchOcrWorkerHealth(controller.signal);
        if (!mountedRef.current || probeId !== probeIdRef.current) {
          return snapshot.status;
        }
        applySnapshot(snapshot);
        return snapshot.status;
      } finally {
        globalThis.clearTimeout(timeoutId);
        if (activeControllerRef.current === controller) {
          activeControllerRef.current = null;
        }
      }
    }, [applySnapshot]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void runProbe();
  }, [enabled, runProbe]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (status !== "unavailable" && status !== "unreachable") {
      return;
    }

    let timerId: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const clearTimer = () => {
      if (timerId !== null) {
        globalThis.clearTimeout(timerId);
        timerId = null;
      }
    };

    const scheduleNext = () => {
      clearTimer();
      if (disposed) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      timerId = globalThis.setTimeout(() => {
        if (disposed) return;
        void runProbe().then((nextStatus) => {
          if (
            !disposed &&
            (nextStatus === "unavailable" || nextStatus === "unreachable")
          ) {
            scheduleNext();
          }
        });
      }, pollIntervalMs);
    };

    const onVisibilityChange = () => {
      if (disposed) return;
      if (document.visibilityState === "hidden") {
        clearTimer();
      } else {
        clearTimer();
        void runProbe().then((nextStatus) => {
          if (
            !disposed &&
            (nextStatus === "unavailable" || nextStatus === "unreachable")
          ) {
            scheduleNext();
          }
        });
      }
    };

    scheduleNext();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      disposed = true;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [enabled, pollIntervalMs, runProbe, status]);

  const recheckNow =
    useCallback(async (): Promise<OcrWorkerAvailabilityState> => {
      setManualRechecking(true);
      try {
        return await runProbe();
      } finally {
        if (mountedRef.current) {
          setManualRechecking(false);
        }
      }
    }, [runProbe]);

  const dismissRecoveredNotice = useCallback(() => {
    setJustRecovered(false);
  }, []);

  const isReady = status === "ready";
  const isUnavailable = status === "unavailable" || status === "unreachable";
  const isChecking = (enabled && status === "checking") || manualRechecking;

  return {
    status,
    isReady,
    isUnavailable,
    isChecking,
    justRecovered,
    queueDepth,
    mode,
    probeDegraded,
    recheckNow,
    dismissRecoveredNotice,
  };
}
