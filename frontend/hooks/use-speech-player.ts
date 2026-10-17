"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createSpeechService } from "@/lib/api/speech-service";

export interface SpeechPlayer {
  readonly isPlaying: boolean;
  play(text: string): Promise<void>;
  stop(): void;
}

/** Plays server-generated speech and always releases its temporary object URL. */
export function useSpeechPlayer(): SpeechPlayer {
  const speechService = useMemo(() => createSpeechService(), []);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const pendingRef = useRef<AbortController | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const stop = useCallback(() => {
    pendingRef.current?.abort();
    pendingRef.current = null;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
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
    async (text: string) => {
      stop();
      const controller = new AbortController();
      pendingRef.current = controller;
      try {
        const source = await speechService.synthesize(text, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || pendingRef.current !== controller)
          return;
        const objectUrl = URL.createObjectURL(source);
        objectUrlRef.current = objectUrl;
        const audio = new Audio(objectUrl);
        audioRef.current = audio;
        audio.onended = stop;
        audio.onerror = stop;
        setIsPlaying(true);

        await audio.play();
      } catch (error) {
        if (controller.signal.aborted) return;
        if (pendingRef.current === controller) stop();
        throw error;
      }
    },
    [speechService, stop],
  );

  return { isPlaying, play, stop };
}
