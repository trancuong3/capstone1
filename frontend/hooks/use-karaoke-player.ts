"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { translateRuntime } from "@/lib/i18n/runtime";

const ALLOWED_RATES = [0.75, 0.85, 1] as const;
// Throttle React tree state updates during continuous 60fps rAF playback (~15 Hz)
// while ref-based clock subscribers still run at full 60fps for smooth lyric fill.
const REACT_CLOCK_COMMIT_INTERVAL_MS = 65;

export type ClockListener = (ms: number) => void;

/** One audio element and one clock: never advance lyrics using elapsed wall time. */
export function useKaraokePlayer(
  url: string,
  durationMs: number,
  expiresAt: string,
  onPlayed?: () => void,
) {
  const notifyStarted = useEffectEvent(() => onPlayed?.());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const segmentEnd = useRef<number | null>(null);
  const segmentLoop = useRef<number | null>(null);
  const operation = useRef(0);
  const clockListeners = useRef(new Set<ClockListener>());
  const lastCommittedMs = useRef(0);
  const lastCommitWall = useRef(0);
  const invalidate = useCallback(() => {
    operation.current++;
  }, []);
  const blocked = useRef(false);
  const playPending = useRef(false);
  const volumeRef = useRef(0.6);
  const rateRef = useRef(1);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [segmentFinished, setSegmentFinished] = useState(false);
  const [loopPass, setLoopPass] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [volume, setVolumeState] = useState(0.6);
  const [rate, setRateState] = useState(1);
  const [keyShift, setKeyShiftState] = useState(0);

  const emitClock = useCallback((ms: number) => {
    for (const listener of clockListeners.current) {
      listener(ms);
    }
  }, []);

  const subscribeClock = useCallback((listener: ClockListener) => {
    clockListeners.current.add(listener);
    return () => {
      clockListeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    blocked.current = false;
    playPending.current = false;
    segmentEnd.current = null;
    segmentLoop.current = null;
    const audio = new Audio();
    audio.preload = "metadata";
    audio.volume = volumeRef.current;
    audio.playbackRate = rateRef.current;
    audio.preservesPitch = true;
    audioRef.current = audio;
    lastCommittedMs.current = 0;
    lastCommitWall.current = 0;
    let disposed = false;
    let frame = 0;
    function sync(forceReactCommit = true) {
      if (disposed) return;
      const time = Math.round(audio.currentTime * 1000);
      let loopedOrStopped = false;
      if (segmentEnd.current !== null && time >= segmentEnd.current) {
        loopedOrStopped = true;
        if (segmentLoop.current !== null) {
          audio.currentTime = segmentLoop.current / 1000;
          setLoopPass((previous) => previous + 1);
        } else {
          segmentEnd.current = null;
          setSegmentFinished(true);
          audio.pause();
        }
      }
      const clamped = Math.min(
        durationMs,
        Math.max(0, Math.round(audio.currentTime * 1000)),
      );
      emitClock(clamped);

      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const shouldCommit =
        forceReactCommit ||
        loopedOrStopped ||
        clamped === 0 ||
        clamped >= durationMs ||
        Math.abs(clamped - lastCommittedMs.current) >=
          REACT_CLOCK_COMMIT_INTERVAL_MS ||
        now - lastCommitWall.current >= REACT_CLOCK_COMMIT_INTERVAL_MS;

      if (shouldCommit && clamped !== lastCommittedMs.current) {
        lastCommittedMs.current = clamped;
        lastCommitWall.current = now;
        setCurrentMs(clamped);
      } else if (forceReactCommit && clamped === lastCommittedMs.current) {
        setCurrentMs(clamped);
      }
    }
    function syncForced() {
      sync(true);
    }
    function tick() {
      sync(false);
      if (!disposed && !audio.paused && !audio.ended)
        frame = requestAnimationFrame(tick);
    }
    function onPlaying() {
      setPlaying(true);
      setWaiting(false);
      notifyStarted();
      cancelAnimationFrame(frame);
      sync(true);
      if (!disposed && !audio.paused && !audio.ended)
        frame = requestAnimationFrame(tick);
    }
    function onPause() {
      invalidate();
      // Browsers may dispatch pause before ended at the natural end of the file.
      // Publish both together so the microphone can drain the last sung words.
      if (audio.ended && segmentLoop.current === null) setEnded(true);
      setPlaying(false);
      setWaiting(false);
      cancelAnimationFrame(frame);
      sync(true);
    }
    function onWaiting() {
      setWaiting(true);
      sync(true);
    }
    function onEnded() {
      const start = segmentLoop.current;
      if (start === null || blocked.current) {
        setEnded(true);
        onPause();
        return;
      }
      audio.currentTime = start / 1000;
      setLoopPass((previous) => previous + 1);
      const ticket = operation.current;
      void audio
        .play()
        .then(() => {
          if (disposed || ticket !== operation.current) audio.pause();
        })
        .catch(() => {
          if (!disposed && ticket === operation.current) {
            onPause();
            setError(
              translateRuntime("entertainment.karaokeRuntime.loopPlayFailed"),
            );
          }
        });
    }
    function onLoaded() {
      if (Number.isNaN(audio.duration)) return;
      // Encoding/container precision is tolerated; a different track is not stretched.
      if (
        !Number.isFinite(audio.duration) ||
        Math.abs(audio.duration * 1000 - durationMs) >
          Math.max(1000, durationMs * 0.02)
      ) {
        blocked.current = true;
        setReady(false);
        audio.pause();
        setError(
          translateRuntime("entertainment.karaokeRuntime.durationMismatch"),
        );
        return;
      }
      setReady(true);
    }
    function onError() {
      blocked.current = true;
      setReady(false);
      audio.pause();
      setPlaying(false);
      setWaiting(false);
      setError(
        translateRuntime("entertainment.karaokeRuntime.audioLoadOrExpired"),
      );
    }
    const listeners: [string, () => void][] = [
      ["loadedmetadata", onLoaded],
      ["durationchange", onLoaded],
      ["playing", onPlaying],
      ["pause", onPause],
      ["ended", onEnded],
      ["waiting", onWaiting],
      ["timeupdate", syncForced],
      ["seeking", syncForced],
      ["seeked", syncForced],
      ["error", onError],
    ];
    listeners.forEach(([event, listener]) =>
      audio.addEventListener(event, listener),
    );
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") audio.pause();
    };
    const onAndroidBackground = () => audio.pause();
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("viread:android-background", onAndroidBackground);
    audio.src = url;
    audio.load();
    return () => {
      disposed = true;
      blocked.current = false;
      playPending.current = false;
      segmentEnd.current = null;
      segmentLoop.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener(
        "viread:android-background",
        onAndroidBackground,
      );
      invalidate();
      cancelAnimationFrame(frame);
      listeners.forEach(([event, listener]) =>
        audio.removeEventListener(event, listener),
      );
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
      setCurrentMs(0);
      setPlaying(false);
      setEnded(false);
      setSegmentFinished(false);
      setLoopPass(0);
      setWaiting(false);
      setReady(false);
      setError("");
    };
  }, [url, durationMs, invalidate, emitClock]);

  const pause = useCallback(() => {
    operation.current++;
    segmentEnd.current = null;
    segmentLoop.current = null;
    audioRef.current?.pause();
    setPlaying(false);
    setWaiting(false);
  }, []);
  const seek = useCallback(
    (ms: number) => {
      if (!Number.isFinite(ms) || !audioRef.current) return;
      segmentEnd.current = null;
      segmentLoop.current = null;
      setEnded(false);
      setSegmentFinished(false);
      const clamped = Math.max(0, Math.min(durationMs, ms));
      audioRef.current.currentTime = clamped / 1000;
      const rounded = Math.round(audioRef.current.currentTime * 1000);
      lastCommittedMs.current = rounded;
      emitClock(rounded);
      setCurrentMs(rounded);
    },
    [durationMs, emitClock],
  );
  const play = useCallback(
    async (
      start?: number,
      end?: number,
      repeat = false,
      repeatFrom = start,
    ) => {
      const audio = audioRef.current;
      if (!audio || !ready || blocked.current || playPending.current) return;
      if (Date.parse(expiresAt) <= Date.now()) {
        pause();
        setError(
          translateRuntime("entertainment.karaokeRuntime.audioLinkExpired"),
        );
        return;
      }
      if (start !== undefined) seek(start);
      else if (audio.ended || audio.currentTime * 1000 >= durationMs) seek(0);
      segmentEnd.current = end ?? null;
      segmentLoop.current =
        repeat &&
        repeatFrom !== undefined &&
        end !== undefined &&
        end > repeatFrom
          ? repeatFrom
          : null;
      const ticket = ++operation.current;
      setEnded(false);
      setSegmentFinished(false);
      playPending.current = true;
      setError("");
      try {
        await audio.play();
        if (audioRef.current !== audio || operation.current !== ticket)
          audio.pause();
      } catch {
        if (audioRef.current === audio && operation.current === ticket) {
          setPlaying(false);
          setWaiting(false);
          setError(
            translateRuntime(
              "entertainment.karaokeRuntime.audioBrowserPlayBlocked",
            ),
          );
        }
      } finally {
        playPending.current = false;
      }
    },
    [durationMs, expiresAt, pause, ready, seek],
  );
  const setVolume = useCallback((value: number) => {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(1, value));
    volumeRef.current = next;
    if (audioRef.current) audioRef.current.volume = next;
    setVolumeState(next);
  }, []);
  const setMuted = useCallback((value: boolean) => {
    if (audioRef.current) audioRef.current.muted = value;
  }, []);
  const setRate = useCallback((value: number) => {
    if (!(ALLOWED_RATES as readonly number[]).includes(value)) return;
    rateRef.current = value;
    if (audioRef.current) {
      audioRef.current.playbackRate = value;
      audioRef.current.preservesPitch = true;
    }
    setRateState(value);
  }, []);
  const setKeyShift = useCallback((semitones: number) => {
    if (!Number.isFinite(semitones)) return;
    const clamped = Math.max(-3, Math.min(3, Math.round(semitones)));
    setKeyShiftState(clamped);
  }, []);
  const getCurrentMs = useCallback(() => {
    const value = Math.round((audioRef.current?.currentTime ?? 0) * 1000);
    return Number.isFinite(value)
      ? Math.max(0, Math.min(durationMs, value))
      : 0;
  }, [durationMs]);
  return {
    currentMs,
    playing,
    ended,
    segmentFinished,
    loopPass,
    waiting,
    ready,
    error,
    volume,
    rate,
    keyShift,
    play,
    pause,
    seek,
    setVolume,
    setMuted,
    setRate,
    setKeyShift,
    getCurrentMs,
    subscribeClock,
  };
}
export type KaraokePlayerController = ReturnType<typeof useKaraokePlayer>;
