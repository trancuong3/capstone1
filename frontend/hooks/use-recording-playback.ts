"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useRecordingPlayback() {
  const activeRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(
    null,
  );
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const release = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    active.audio.onended = null;
    active.audio.onerror = null;
    active.audio.pause();
    URL.revokeObjectURL(active.url);
  }, []);

  useEffect(() => release, [release]);

  const stop = useCallback(() => {
    release();
    setPlaying(false);
    setError(null);
  }, [release]);

  async function toggle(recording: Blob) {
    if (activeRef.current) {
      stop();
      return;
    }
    setError(null);
    if (typeof URL.createObjectURL !== "function") {
      setError("Trình duyệt này chưa phát được bản ghi.");
      return;
    }
    const url = URL.createObjectURL(recording);
    const audio = new Audio(url);
    activeRef.current = { audio, url };
    const failed = () => {
      if (activeRef.current?.audio !== audio) return;
      stop();
      setError("Chưa phát được bản ghi. Bé có thể thu lại nhé.");
    };
    audio.onended = stop;
    audio.onerror = failed;
    setPlaying(true);
    try {
      await audio.play();
    } catch {
      failed();
    }
  }

  return { playing, error, stop, toggle };
}
