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

interface ActivePlayback {
  readonly audio: HTMLAudioElement;
  readonly objectUrl: string;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

function playbackError(message: string): Error {
  return new Error(message);
}

function playbackStoppedError(): Error {
  const error = new Error("Audio playback was stopped.");
  error.name = "AbortError";
  return error;
}

/** Plays server-generated speech and resolves only after the audio has ended. */
export function useSpeechPlayer(): SpeechPlayer {
  const speechService = useMemo(() => createSpeechService(), []);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const activePlaybackRef = useRef<ActivePlayback | null>(null);
  const playGenerationRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const stop = useCallback(() => {
    playGenerationRef.current += 1;
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    const playback = activePlaybackRef.current;
    activePlaybackRef.current = null;
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
    if (mountedRef.current) setIsPlaying(false);
    if (playback && !playback.settled) {
      playback.settled = true;
      playback.reject(playbackStoppedError());
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  const play = useCallback(
    async (text: string, options?: SpeechPlayOptions) => {
      if (!mountedRef.current) {
        throw playbackError("Audio player is not ready.");
      }

      stop();
      const generation = playGenerationRef.current;
      const source = await speechService.synthesize(text);
      if (!mountedRef.current || generation !== playGenerationRef.current) {
        throw playbackStoppedError();
      }

      const objectUrl = URL.createObjectURL(source);
      let audio: HTMLAudioElement;
      try {
        audio = new Audio(objectUrl);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
      objectUrlRef.current = objectUrl;
      audioRef.current = audio;
      setIsPlaying(true);

      await new Promise<void>((resolve, reject) => {
        const playback: ActivePlayback = {
          audio,
          objectUrl,
          reject,
          settled: false,
        };
        activePlaybackRef.current = playback;

        const finish = (error?: Error) => {
          if (playback.settled) return;
          playback.settled = true;
          if (activePlaybackRef.current === playback) {
            activePlaybackRef.current = null;
            audioRef.current = null;
            objectUrlRef.current = null;
          }
          audio.onended = null;
          audio.onerror = null;
          audio.ontimeupdate = null;
          audio.onloadedmetadata = null;
          if (animFrameRef.current !== null) {
            cancelAnimationFrame(animFrameRef.current);
            animFrameRef.current = null;
          }
          audio.pause();
          audio.src = "";
          URL.revokeObjectURL(objectUrl);
          if (mountedRef.current) setIsPlaying(false);
          if (error) reject(error);
          else resolve();
        };

        audio.onended = () => {
          try {
            options?.onEnded?.();
          } finally {
            finish();
          }
        };
        audio.onerror = () =>
          finish(
            playbackError("Không thể phát âm thanh. Bé thử nghe lại nhé."),
          );

        const updateProgress = () => {
          if (
            activePlaybackRef.current !== playback ||
            audio.paused ||
            audio.ended
          ) {
            return;
          }
          const duration = audio.duration;
          if (duration && Number.isFinite(duration) && duration > 0) {
            options?.onTimeUpdate?.(audio.currentTime, duration);
            animFrameRef.current = requestAnimationFrame(updateProgress);
          }
        };

        audio.onloadedmetadata = () => {
          const duration = audio.duration;
          if (duration && Number.isFinite(duration) && duration > 0) {
            options?.onPlay?.(duration);
          }
        };
        audio.ontimeupdate = () => {
          const duration = audio.duration;
          if (duration && Number.isFinite(duration) && duration > 0) {
            options?.onTimeUpdate?.(audio.currentTime, duration);
          }
        };

        void audio
          .play()
          .then(() => {
            if (activePlaybackRef.current !== playback) return;
            const duration = audio.duration;
            if (duration && Number.isFinite(duration) && duration > 0) {
              options?.onPlay?.(duration);
            }
            if (options?.onTimeUpdate) {
              animFrameRef.current = requestAnimationFrame(updateProgress);
            }
          })
          .catch((error: unknown) => {
            finish(
              error instanceof Error
                ? error
                : playbackError(
                    "Không thể phát âm thanh. Bé thử nghe lại nhé.",
                  ),
            );
          });
      });
    },
    [speechService, stop],
  );

  return { isPlaying, play, stop };
}
