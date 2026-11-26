"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { translateRuntime } from "@/lib/i18n/runtime";

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
  const invalidate = useCallback(() => {
    operation.current++;
  }, []);
  const blocked = useRef(false);
  const playPending = useRef(false);
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

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.volume = 0.6;
    audioRef.current = audio;
    let disposed = false;
    let frame = 0;
    function sync() {
      if (disposed) return;
      const time = Math.round(audio.currentTime * 1000);
      if (segmentEnd.current !== null && time >= segmentEnd.current) {
        if (segmentLoop.current !== null) {
          audio.currentTime = segmentLoop.current / 1000;
          setLoopPass((previous) => previous + 1);
        } else {
          segmentEnd.current = null;
          setSegmentFinished(true);
          audio.pause();
        }
      }
      setCurrentMs(
        Math.min(durationMs, Math.max(0, Math.round(audio.currentTime * 1000))),
      );
    }
    function tick() {
      sync();
      if (!disposed && !audio.paused && !audio.ended)
        frame = requestAnimationFrame(tick);
    }
    function onPlaying() {
      setPlaying(true);
      setWaiting(false);
      notifyStarted();
      cancelAnimationFrame(frame);
      tick();
    }
    function onPause() {
      invalidate();
      // Browsers may dispatch pause before ended at the natural end of the file.
      // Publish both together so the microphone can drain the last sung words.
      if (audio.ended && segmentLoop.current === null) setEnded(true);
      setPlaying(false);
      setWaiting(false);
      cancelAnimationFrame(frame);
      sync();
    }
    function onWaiting() {
      setWaiting(true);
      sync();
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
      ["timeupdate", sync],
      ["seeking", sync],
      ["seeked", sync],
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
    };
  }, [url, durationMs, invalidate]);

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
      audioRef.current.currentTime =
        Math.max(0, Math.min(durationMs, ms)) / 1000;
      setCurrentMs(Math.round(audioRef.current.currentTime * 1000));
    },
    [durationMs],
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
    if (audioRef.current) audioRef.current.volume = next;
    setVolumeState(next);
  }, []);
  const setMuted = useCallback((value: boolean) => {
    if (audioRef.current) audioRef.current.muted = value;
  }, []);
  const setRate = useCallback((value: number) => {
    if (![0.75, 1].includes(value)) return;
    if (audioRef.current) {
      audioRef.current.playbackRate = value;
      audioRef.current.preservesPitch = true;
    }
    setRateState(value);
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
    play,
    pause,
    seek,
    setVolume,
    setMuted,
    setRate,
    getCurrentMs,
  };
}
export type KaraokePlayerController = ReturnType<typeof useKaraokePlayer>;
