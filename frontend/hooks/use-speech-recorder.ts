"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeechRecorder {
  readonly isRecording: boolean;
  start(): Promise<void>;
  stop(): Promise<Blob | null>;
  cancel(): void;
}

const preferredMimeTypes = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

/** Captures one browser microphone segment without retaining it after upload. */
export function useSpeechRecorder(): SpeechRecorder {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const resolveStopRef = useRef<((recording: Blob | null) => void) | null>(
    null,
  );
  const rejectStopRef = useRef<((reason: Error) => void) | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  const finish = useCallback((recording: Blob | null, error?: Error) => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    chunksRef.current = [];
    if (recorder) stopTracks(recorder.stream);
    setIsRecording(false);

    const resolve = resolveStopRef.current;
    const reject = rejectStopRef.current;
    resolveStopRef.current = null;
    rejectStopRef.current = null;
    if (error) {
      reject?.(error);
    } else {
      resolve?.(recording);
    }
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    if (recorder.state !== "inactive") recorder.stop();
    finish(null);
  }, [finish]);

  const start = useCallback(async () => {
    cancel();
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      throw new Error("Microphone recording is not supported in this browser.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const mimeType = preferredMimeTypes.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () =>
        finish(null, new Error("Microphone recording failed."));
      recorder.onstop = () => {
        const contentType = recorder.mimeType || "audio/webm";
        const chunks = chunksRef.current;
        finish(chunks.length ? new Blob(chunks, { type: contentType }) : null);
      };
      recorder.start(250);
      setIsRecording(true);
    } catch (error) {
      stopTracks(stream);
      throw error;
    }
  }, [cancel, finish]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive")
      return Promise.resolve(null);

    return new Promise<Blob | null>((resolve, reject) => {
      resolveStopRef.current = resolve;
      rejectStopRef.current = reject;
      try {
        recorder.stop();
      } catch (error) {
        finish(
          null,
          error instanceof Error
            ? error
            : new Error("Microphone recording failed."),
        );
      }
    });
  }, [finish]);

  useEffect(() => cancel, [cancel]);

  return { isRecording, start, stop, cancel };
}
