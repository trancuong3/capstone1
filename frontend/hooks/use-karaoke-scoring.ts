"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KaraokeLyrics } from "@/types/karaoke";
import { BrowserTranscriptCollector } from "@/lib/reading/browser-transcript-collector";
import {
  scoreFromFullTranscript,
  type SingingScore,
} from "@/lib/karaoke/singing-score";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KaraokeScoringState {
  /** Whether scoring mode is enabled by the user. */
  enabled: boolean;
  /** Whether the browser is currently listening. */
  listening: boolean;
  /** Whether the browser supports speech recognition. */
  supported: boolean;
  /** Partial transcript text accumulated so far. */
  partialTranscript: string;
  /** Final score after song ends (null while singing). */
  score: SingingScore | null;
  /** Error message if recognition failed. */
  error: string | null;
}

export interface KaraokeScoringController extends KaraokeScoringState {
  /** Toggle scoring mode on/off. */
  toggle(): void;
  /** Start listening (called when playback starts). */
  startListening(): void;
  /** Stop listening and compute score (called when playback ends). */
  stopAndScore(): void;
  /** Reset to initial state (called when restarting song). */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Browser SpeechRecognition detection
// ---------------------------------------------------------------------------

type SpeechRecognitionLike = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function getSpeechRecognition(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ??
    w.webkitSpeechRecognition ??
    null) as SpeechRecognitionLike | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook for karaoke singing scoring using the Browser Web Speech API.
 *
 * Uses the same `BrowserTranscriptCollector` infrastructure as the reading
 * feature.  Runs entirely in-browser — zero cost, no backend calls.
 *
 * Usage:
 * 1. User toggles scoring on with `toggle()`
 * 2. When playback starts, call `startListening()`
 * 3. When playback ends, call `stopAndScore()` → `score` becomes available
 * 4. On song restart, call `reset()`
 */
export function useKaraokeScoring(
  lyrics: KaraokeLyrics | null,
): KaraokeScoringController {
  const [enabled, setEnabled] = useState(false);
  const [listening, setListening] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [score, setScore] = useState<SingingScore | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<InstanceType<SpeechRecognitionLike> | null>(
    null,
  );
  const collectorRef = useRef(new BrowserTranscriptCollector());
  const lyricsRef = useRef(lyrics);
  const enabledRef = useRef(enabled);
  const listeningRef = useRef(false);

  useEffect(() => {
    lyricsRef.current = lyrics;
  }, [lyrics]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const supported = typeof window !== "undefined" && !!getSpeechRecognition();

  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Ignore errors when aborting.
      }
      recognitionRef.current = null;
    }
    listeningRef.current = false;
    setListening(false);
  }, []);

  const startListening = useCallback(() => {
    if (!enabledRef.current || !lyricsRef.current) return;

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setError("Trình duyệt không hỗ trợ nhận diện giọng nói.");
      return;
    }

    // Clean up any existing recognition.
    stopRecognition();
    collectorRef.current.reset();
    setPartialTranscript("");
    setScore(null);
    setError(null);

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "vi-VN";
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: unknown) => {
      const e = event as {
        resultIndex: number;
        results: ArrayLike<{
          readonly isFinal: boolean;
          readonly 0?: { readonly transcript?: string };
        }>;
      };
      collectorRef.current.addResults(e);
      setPartialTranscript(collectorRef.current.getTranscript());
    };

    recognition.onerror = (event: { error?: string }) => {
      // "no-speech" and "aborted" are not real errors — they happen
      // when the user is quiet or when we stop intentionally.
      if (event.error === "no-speech" || event.error === "aborted") return;
      console.warn("[KARAOKE SCORING] Recognition error:", event.error);
      setError(`Lỗi nhận diện: ${event.error ?? "unknown"}`);
    };

    recognition.onend = () => {
      // Restart if we're still supposed to be listening.
      // Browser Speech API can stop after silence or internal timeouts.
      if (listeningRef.current && enabledRef.current) {
        collectorRef.current.completeRecognitionCycle();
        try {
          const restartRecognition = new SpeechRecognition();
          restartRecognition.continuous = true;
          restartRecognition.interimResults = false;
          restartRecognition.lang = "vi-VN";
          restartRecognition.maxAlternatives = 1;
          restartRecognition.onresult = recognition.onresult;
          restartRecognition.onerror = recognition.onerror;
          restartRecognition.onend = recognition.onend;
          recognitionRef.current = restartRecognition;
          restartRecognition.start();
        } catch {
          // Final end — scoring will use whatever we collected.
          listeningRef.current = false;
          setListening(false);
        }
      }
    };

    recognitionRef.current = recognition;
    listeningRef.current = true;
    setListening(true);

    try {
      recognition.start();
    } catch (err) {
      console.warn("[KARAOKE SCORING] Failed to start recognition:", err);
      setError("Không thể bắt đầu nhận diện giọng nói.");
      listeningRef.current = false;
      setListening(false);
    }
  }, [stopRecognition]);

  const stopAndScore = useCallback(() => {
    stopRecognition();
    collectorRef.current.completeRecognitionCycle();
    const transcript = collectorRef.current.getTranscript();
    setPartialTranscript(transcript);

    if (lyricsRef.current && transcript) {
      const result = scoreFromFullTranscript(lyricsRef.current, transcript);
      setScore(result);
    } else if (lyricsRef.current) {
      // No transcript collected — score as 0.
      setScore(scoreFromFullTranscript(lyricsRef.current, ""));
    }
  }, [stopRecognition]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      if (prev) {
        // Turning off — stop any active recognition.
        stopRecognition();
        collectorRef.current.reset();
        setPartialTranscript("");
        setScore(null);
        setError(null);
      }
      return !prev;
    });
  }, [stopRecognition]);

  const reset = useCallback(() => {
    stopRecognition();
    collectorRef.current.reset();
    setPartialTranscript("");
    setScore(null);
    setError(null);
  }, [stopRecognition]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopRecognition();
    };
  }, [stopRecognition]);

  return {
    enabled,
    listening,
    supported,
    partialTranscript,
    score,
    error,
    toggle,
    startListening,
    stopAndScore,
    reset,
  };
}
