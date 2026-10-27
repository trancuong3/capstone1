"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createSpeechService } from "@/lib/api/speech-service";

export interface SpeechPlayOptions {
  onPlay?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
}

export interface SpeechPlayer {
  readonly isPlaying: boolean;
  play(text: string, options?: SpeechPlayOptions): Promise<void>;
  stop(): void;
}

/** Plays server-generated speech with high-precision time tracking and releases its temporary object URL. */
export function useSpeechPlayer(): SpeechPlayer {
  const speechService = useMemo(() => createSpeechService(), []);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const stop = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
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
  }, []);

  useEffect(() => stop, [stop]);

  const play = useCallback(
    async (text: string, options?: SpeechPlayOptions) => {
      stop();
      const source = await speechService.synthesize(text);
      const objectUrl = URL.createObjectURL(source);
      const audio = new Audio(objectUrl);
      objectUrlRef.current = objectUrl;
      audioRef.current = audio;

      const handleEnded = () => {
        if (animFrameRef.current !== null) {
          cancelAnimationFrame(animFrameRef.current);
          animFrameRef.current = null;
        }
        options?.onEnded?.();
        stop();
      };

      audio.onended = handleEnded;
      audio.onerror = handleEnded;

      const startProgressLoop = () => {
        const update = () => {
          const currentAudio = audioRef.current;
          if (!currentAudio || currentAudio.paused || currentAudio.ended) {
            return;
          }
          const cur = currentAudio.currentTime;
          const dur = currentAudio.duration;
          if (dur && !isNaN(dur) && dur > 0) {
            options?.onTimeUpdate?.(cur, dur);
          }
          animFrameRef.current = requestAnimationFrame(update);
        };
        animFrameRef.current = requestAnimationFrame(update);
      };

      audio.onloadedmetadata = () => {
        const dur = audio.duration;
        if (dur && !isNaN(dur) && dur > 0) {
          options?.onPlay?.(dur);
        }
      };

      audio.ontimeupdate = () => {
        const cur = audio.currentTime;
        const dur = audio.duration;
        if (dur && !isNaN(dur) && dur > 0) {
          options?.onTimeUpdate?.(cur, dur);
        }
      };

      setIsPlaying(true);

      try {
        await audio.play();
        const dur = audio.duration;
        if (dur && !isNaN(dur) && dur > 0) {
          options?.onPlay?.(dur);
        }
        if (options?.onTimeUpdate) {
          startProgressLoop();
        }
      } catch (error) {
        stop();
        throw error;
      }
    },
    [speechService, stop],
  );

  return { isPlaying, play, stop };
}
