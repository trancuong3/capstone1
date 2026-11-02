"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createSpeechService } from "@/lib/api/speech-service";

export interface SpeechPlayOptions {
  onPlay?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onError?: () => void;
  onStopped?: () => void;
}

export interface SpeechPlayer {
  readonly isPlaying: boolean;
  play(text: string, options?: SpeechPlayOptions): Promise<void>;
  stop(): void;
}

export function useSpeechPlayer(): SpeechPlayer {
  const speechService = useMemo(() => createSpeechService(), []);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const synthesisAbortRef = useRef<AbortController | null>(null);
  const playGenerationRef = useRef(0);
  const activeOptionsRef = useRef<SpeechPlayOptions | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const stop = useCallback(() => {
    playGenerationRef.current += 1;
    synthesisAbortRef.current?.abort();
    synthesisAbortRef.current = null;
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    const options = activeOptionsRef.current;
    activeOptionsRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.ontimeupdate = null;
      audio.onloadedmetadata = null;
      audio.pause();
      audio.src = "";
    }

    const objectUrl = objectUrlRef.current;
    objectUrlRef.current = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setIsPlaying(false);
    options?.onStopped?.();
  }, []);

  useEffect(() => stop, [stop]);

  const play = useCallback(
    async (text: string, options?: SpeechPlayOptions) => {
      stop();
      const generation = playGenerationRef.current;
      const controller = new AbortController();
      synthesisAbortRef.current = controller;
      activeOptionsRef.current = options ?? null;

      let source: Blob;
      try {
        source = await speechService.synthesize(text, {
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || generation !== playGenerationRef.current) {
          return;
        }
        synthesisAbortRef.current = null;
        activeOptionsRef.current = null;
        throw error;
      }

      if (controller.signal.aborted || generation !== playGenerationRef.current) {
        return;
      }
      synthesisAbortRef.current = null;

      const objectUrl = URL.createObjectURL(source);
      const audio = new Audio(objectUrl);
      objectUrlRef.current = objectUrl;
      audioRef.current = audio;
      const isCurrentPlayback = () =>
        generation === playGenerationRef.current && audioRef.current === audio;

      const handleEnded = () => {
        if (!isCurrentPlayback()) return;
        if (animFrameRef.current !== null) {
          cancelAnimationFrame(animFrameRef.current);
          animFrameRef.current = null;
        }
        activeOptionsRef.current = null;
        options?.onEnded?.();
        stop();
      };
      audio.onended = handleEnded;
      audio.onerror = () => {
        if (!isCurrentPlayback()) return;
        activeOptionsRef.current = null;
        options?.onError?.();
        stop();
      };

      const startProgressLoop = () => {
        const update = () => {
          if (!isCurrentPlayback() || audio.paused || audio.ended) return;
          const current = audio.currentTime;
          const duration = audio.duration;
          if (duration && !isNaN(duration) && duration > 0) {
            options?.onTimeUpdate?.(current, duration);
          }
          animFrameRef.current = requestAnimationFrame(update);
        };
        animFrameRef.current = requestAnimationFrame(update);
      };

      audio.onloadedmetadata = () => {
        if (!isCurrentPlayback()) return;
        const duration = audio.duration;
        if (duration && !isNaN(duration) && duration > 0) {
          options?.onPlay?.(duration);
        }
      };
      audio.ontimeupdate = () => {
        if (!isCurrentPlayback()) return;
        const duration = audio.duration;
        if (duration && !isNaN(duration) && duration > 0) {
          options?.onTimeUpdate?.(audio.currentTime, duration);
        }
      };

      setIsPlaying(true);
      try {
        await audio.play();
        if (!isCurrentPlayback()) return;
        const duration = audio.duration;
        if (duration && !isNaN(duration) && duration > 0) {
          options?.onPlay?.(duration);
        }
        if (options?.onTimeUpdate) startProgressLoop();
      } catch (error) {
        if (!isCurrentPlayback()) return;
        activeOptionsRef.current = null;
        stop();
        options?.onError?.();
        throw error;
      }
    },
    [speechService, stop],
  );

  return { isPlaying, play, stop };
}
