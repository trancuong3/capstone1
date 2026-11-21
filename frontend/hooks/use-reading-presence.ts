"use client";

import { useEffect, useRef, useState } from "react";

import type {
  PresenceCancelReason,
  ReadingPresenceService,
} from "@/lib/api/reading-presence-service";
import {
  createCameraPresenceSource,
  type PresenceSampleSource,
} from "@/lib/reading/presence-camera";
import { subscribePresenceOptIn } from "@/lib/reading/presence-opt-in";
import {
  PresenceMonitor,
  type PresenceContext,
  type PresenceEffect,
  type PresenceSample,
  type SessionPhase,
} from "@/lib/reading/presence-monitor";

export interface UseReadingPresenceOptions {
  readonly sessionId: string;
  readonly sessionPhase: SessionPhase;
  readonly service?: ReadingPresenceService;
  /** The monitor decided the reader is gone: pause at the current position. */
  readonly onPauseRequested: () => void;
  readonly onNotice: () => void;
  /** Injection points for tests. */
  readonly createSource?: () => PresenceSampleSource;
  readonly newEpisodeId?: () => string;
}

/**
 * Opt-in presence check. Does nothing (no camera, no network) unless the
 * parent turned the email reminder on AND the camera is already granted.
 */
export function useReadingPresence({
  sessionId,
  sessionPhase,
  service,
  onPauseRequested,
  onNotice,
  createSource,
  newEpisodeId,
}: UseReadingPresenceOptions): { optedIn: boolean; watching: boolean } {
  const [optedIn, setOptedIn] = useState(false);
  const [watching, setWatching] = useState(false);
  const optedInRef = useRef(false);
  const phaseRef = useRef<SessionPhase>(sessionPhase);
  const visibleRef = useRef(true);
  const cameraGrantedRef = useRef(false);
  const monitorRef = useRef<PresenceMonitor | null>(null);
  const alertsRef = useRef(new Map<string, Promise<string | null>>());
  const callbacksRef = useRef({ onPauseRequested, onNotice });

  useEffect(() => {
    callbacksRef.current = { onPauseRequested, onNotice };
  });

  function context(): PresenceContext {
    return {
      optedIn: optedInRef.current,
      sessionPhase: phaseRef.current,
      appVisible: visibleRef.current,
      cameraGranted: cameraGrantedRef.current,
    };
  }

  function run(effects: readonly PresenceEffect[]) {
    for (const effect of effects) {
      if (effect.type === "PAUSE_SESSION")
        callbacksRef.current.onPauseRequested();
      else if (effect.type === "SHOW_NOTICE") callbacksRef.current.onNotice();
      else if (effect.type === "ARM_ALERT") {
        if (!service) continue;
        // Failure to arm is silent: no alert means no email, never a false one.
        alertsRef.current.set(
          effect.episodeId,
          service
            .armAlert(sessionId, effect.episodeId)
            .then((alert) => alert.id)
            .catch(() => null),
        );
      } else {
        const pending = alertsRef.current.get(effect.episodeId);
        if (!pending || !service) continue;
        if (effect.type === "CONFIRM_ALERT") {
          void pending.then((id) =>
            id ? service.confirmAlert(id).catch(() => undefined) : undefined,
          );
        } else {
          const reason: PresenceCancelReason =
            effect.reason === "CAMERA_UNAVAILABLE"
              ? "APP_BACKGROUND"
              : effect.reason;
          alertsRef.current.delete(effect.episodeId);
          void pending.then((id) =>
            id
              ? service.cancelAlert(id, reason).catch(() => undefined)
              : undefined,
          );
        }
      }
    }
  }

  function feed(sample: PresenceSample | null) {
    const monitor = monitorRef.current;
    if (!monitor) return;
    run(monitor.update(context(), sample, performance.now()));
    setWatching(monitor.isWatching);
  }

  // Parent's server-side setting, plus instant updates from the settings dialog.
  useEffect(() => {
    if (!service) return;
    let active = true;
    void service
      .getSettings()
      .then((settings) => {
        if (!active) return;
        optedInRef.current = settings.emailEnabled;
        setOptedIn(settings.emailEnabled);
      })
      .catch(() => undefined);
    const unsubscribe = subscribePresenceOptIn((enabled) => {
      optedInRef.current = enabled;
      setOptedIn(enabled);
      if (!enabled) feed(null);
    });
    return () => {
      active = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  // The session phase changes the meaning of every sample.
  useEffect(() => {
    phaseRef.current = sessionPhase;
    feed(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPhase]);

  // Camera + monitor lifecycle.
  useEffect(() => {
    if (!optedIn || !service) return;
    const monitor = new PresenceMonitor(
      newEpisodeId ?? (() => crypto.randomUUID()),
    );
    monitorRef.current = monitor;
    const source = (createSource ?? (() => createCameraPresenceSource()))();
    let active = true;

    function onVisibility() {
      visibleRef.current = document.visibilityState !== "hidden";
      feed(null);
    }
    function onBackground() {
      visibleRef.current = false;
      feed(null);
    }
    visibleRef.current = document.visibilityState !== "hidden";
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("viread:android-background", onBackground);

    void source
      .start((sample) => {
        if (active) feed(sample);
      })
      .then((result) => {
        if (!active) return;
        cameraGrantedRef.current = result === "started";
        if (result !== "started") setWatching(false);
      });

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("viread:android-background", onBackground);
      source.stop();
      // Leaving the screen / switching off cancels anything still waiting.
      optedInRef.current = false;
      feed(null);
      optedInRef.current = optedIn;
      monitorRef.current = null;
      cameraGrantedRef.current = false;
      setWatching(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optedIn, service, sessionId]);

  return { optedIn, watching };
}
