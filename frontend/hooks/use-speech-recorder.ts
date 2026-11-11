"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioQualityMonitor,
  type AudioQualitySnapshot,
} from "@/lib/reading/audio-quality";

export interface SpeechRecorder {
  readonly isRecording: boolean;
  readonly isSpeaking: boolean;
  readonly audioLevel: number;
  prepare(): Promise<void>;
  start(options?: { retainStream?: boolean }): Promise<void>;
  stop(): Promise<Blob | null>;
  cancel(options?: { retainStream?: boolean }): void;
  getStream(): MediaStream | null;
  getIsSpeaking(): boolean;
  getQuality?(): AudioQualitySnapshot;
  getSettings?(): MediaTrackSettings | null;
}

const preferredMimeTypes = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

const MAX_RECORDING_BYTES = 20 * 1024 * 1024;
const MAX_RECORDING_MS = 5 * 60 * 1000;

function microphoneConstraints(): MediaStreamConstraints {
  const supported = navigator.mediaDevices.getSupportedConstraints?.();
  if (!supported) return { audio: true };
  const audio: MediaTrackConstraints = {};
  for (const key of [
    "echoCancellation",
    "noiseSuppression",
    "autoGainControl",
  ] as const) {
    if (supported[key]) audio[key] = true;
  }
  return { audio: Object.keys(audio).length ? audio : true };
}

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

export function useSpeechRecorder(
  onCaptureError?: (error: Error) => void,
): SpeechRecorder {
  const onCaptureErrorRef = useRef(onCaptureError);
  useEffect(() => {
    onCaptureErrorRef.current = onCaptureError;
  }, [onCaptureError]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const streamGenerationRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const isRecordingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const retainStreamOnStopRef = useRef(false);
  const qualityRef = useRef(new AudioQualityMonitor());
  const captureErrorRef = useRef<Error | null>(null);
  const noAudioRef = useRef(false);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef<MediaTrackSettings | null>(null);
  const prepareRef = useRef<Promise<void> | null>(null);
  const startRef = useRef<Promise<void> | null>(null);
  const limitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detachTracksRef = useRef<(() => void) | null>(null);

  const resolveStopRef = useRef<((recording: Blob | null) => void) | null>(
    null,
  );

  const rejectStopRef = useRef<((reason: Error) => void) | null>(null);
  const pendingStopRef = useRef<Promise<Blob | null> | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const cleanupAudioNodes = useCallback((retainStream: boolean) => {
    isRecordingRef.current = false;

    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    try {
      sourceRef.current?.disconnect();
    } catch {
      // Safe ignore
    }

    sourceRef.current = null;

    try {
      void audioContextRef.current?.close().catch(() => undefined);
    } catch {
      // Safe ignore
    }

    audioContextRef.current = null;
    analyserRef.current = null;
    if (!retainStream) streamRef.current = null;

    isSpeakingRef.current = false;
    setIsSpeaking(false);
    setAudioLevel(0);
  }, []);

  const finish = useCallback(
    (recording: Blob | null, error?: Error, retainStream = false) => {
      const recorder = recorderRef.current;

      recorderRef.current = null;
      if (limitTimerRef.current !== null) clearTimeout(limitTimerRef.current);
      limitTimerRef.current = null;
      if (stopTimerRef.current !== null) clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
      detachTracksRef.current?.();
      detachTracksRef.current = null;
      if (error) captureErrorRef.current = error;

      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            /* Release tracks even on recorder failure. */
          }
        }
      }

      if (!retainStream) {
        const streams = new Set(
          [recorder?.stream, streamRef.current].filter(
            (stream): stream is MediaStream => Boolean(stream),
          ),
        );
        for (const stream of streams) stopTracks(stream);
      }

      chunksRef.current = [];

      cleanupAudioNodes(retainStream);
      retainStreamOnStopRef.current = retainStream;
      setIsRecording(false);

      const resolve = resolveStopRef.current;
      const reject = rejectStopRef.current;

      resolveStopRef.current = null;
      rejectStopRef.current = null;
      pendingStopRef.current = null;

      if (error) {
        reject?.(error);
        onCaptureErrorRef.current?.(error);
      } else {
        resolve?.(recording);
      }
    },
    [cleanupAudioNodes],
  );

  const cancel = useCallback(
    (options?: { retainStream?: boolean }) => {
      // Invalidate getUserMedia/start work that is still awaiting permission.
      // Otherwise it could start recording after playback has already begun.
      streamGenerationRef.current += 1;
      prepareRef.current = null;
      startRef.current = null;
      const recorder = recorderRef.current;

      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;

        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // Releasing the microphone must not depend on recorder state.
          }
        }
      }

      finish(null, undefined, options?.retainStream === true);
    },
    [finish],
  );

  const prepare = useCallback(async () => {
    if (
      streamRef.current
        ?.getTracks()
        .some((track) => track.readyState === "live")
    ) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is not supported in this browser.");
    }

    if (prepareRef.current) return prepareRef.current;
    const generation = streamGenerationRef.current;
    const pending = (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          microphoneConstraints(),
        );
      } catch (error) {
        if (
          generation !== streamGenerationRef.current ||
          !(error instanceof DOMException) ||
          error.name !== "OverconstrainedError"
        )
          throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (generation !== streamGenerationRef.current) {
        stopTracks(stream);
        throw new DOMException("Microphone start was cancelled.", "AbortError");
      }
      streamRef.current = stream;
      settingsRef.current = stream.getTracks()[0]?.getSettings?.() ?? null;
    })();
    prepareRef.current = pending;
    try {
      await pending;
    } finally {
      if (prepareRef.current === pending) prepareRef.current = null;
    }
  }, []);

  const begin = useCallback(
    async (options?: { retainStream?: boolean }) => {
      const retainStream = options?.retainStream === true;
      const requestedGeneration = streamGenerationRef.current;
      // Join a permission preflight instead of opening a second microphone request.
      if (prepareRef.current) await prepareRef.current;
      if (requestedGeneration !== streamGenerationRef.current) {
        throw new DOMException("Microphone start was cancelled.", "AbortError");
      }
      cancel({ retainStream: Boolean(streamRef.current) });
      const generation = streamGenerationRef.current;

      if (typeof MediaRecorder === "undefined") {
        throw new Error(
          "Microphone recording is not supported in this browser.",
        );
      }

      chunksRef.current = [];
      captureErrorRef.current = null;
      noAudioRef.current = false;
      qualityRef.current = new AudioQualityMonitor();

      try {
        await prepare();
        if (generation !== streamGenerationRef.current) {
          const error = new Error("Microphone start was cancelled.");
          error.name = "AbortError";
          throw error;
        }
        const stream = streamRef.current;
        if (!stream) throw new Error("Microphone is unavailable.");
        retainStreamOnStopRef.current = retainStream;
        isRecordingRef.current = true;

        const mimeType = preferredMimeTypes.find((candidate) =>
          MediaRecorder.isTypeSupported?.(candidate),
        );

        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);

        recorderRef.current = recorder;
        let bytes = 0;
        const failCapture = (message: string) => {
          if (recorderRef.current !== recorder) return;
          finish(null, new Error(message));
        };
        recorder.ondataavailable = (event) => {
          if (recorderRef.current !== recorder) return;
          bytes += event.data.size;
          if (bytes > MAX_RECORDING_BYTES) {
            failCapture(
              "Recording size limit reached. Please record a shorter passage.",
            );
          } else if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.onerror = () => failCapture("Microphone recording failed.");
        const ended = () =>
          failCapture("Microphone disconnected. Please record again.");
        const tracks = stream.getTracks();
        for (const track of tracks) track.addEventListener?.("ended", ended);
        detachTracksRef.current = () => {
          for (const track of tracks)
            track.removeEventListener?.("ended", ended);
        };
        limitTimerRef.current = setTimeout(() => {
          failCapture(
            "Recording duration limit reached. Please record a shorter passage.",
          );
        }, MAX_RECORDING_MS);
        recorder.start(250);

        // Audio analyser chỉ dùng để hiển thị trạng thái giọng nói.
        interface WindowWithAudio {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        }

        const winAudio =
          typeof window !== "undefined"
            ? (window as unknown as WindowWithAudio)
            : null;

        const AudioCtx = winAudio?.AudioContext || winAudio?.webkitAudioContext;

        if (AudioCtx) {
          try {
            const ctx = new AudioCtx();
            audioContextRef.current = ctx;

            if (ctx.state === "suspended") {
              void ctx.resume().catch(() => undefined);
            }

            const source = ctx.createMediaStreamSource(stream);
            sourceRef.current = source;

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.5;

            source.connect(analyser);
            analyserRef.current = analyser;

            const dataArray = new Float32Array(analyser.fftSize);
            const checkAudio = () => {
              if (recorderRef.current !== recorder || !isRecordingRef.current)
                return;
              if (ctx.state === "running") {
                analyser.getFloatTimeDomainData(dataArray);
                const quality = qualityRef.current.addFrame(
                  dataArray,
                  performance.now(),
                );
                setAudioLevel(Math.min(100, Math.round(quality.rms * 500)));
                if (isSpeakingRef.current !== quality.isSpeaking) {
                  isSpeakingRef.current = quality.isSpeaking;
                  setIsSpeaking(quality.isSpeaking);
                }
              }
              animFrameRef.current = requestAnimationFrame(checkAudio);
            };

            animFrameRef.current = requestAnimationFrame(checkAudio);
          } catch {
            // AudioContext có thể không được trình duyệt hỗ trợ.
          }
        }

        setIsRecording(true);
      } catch (error) {
        if (generation !== streamGenerationRef.current) throw error;
        finish(null);
        throw error;
      }
    },
    [cancel, finish, prepare],
  );

  const start = useCallback(
    (options?: { retainStream?: boolean }): Promise<void> => {
      if (startRef.current) return startRef.current;
      if (pendingStopRef.current)
        return Promise.reject(new Error("Microphone is still stopping."));
      if (isRecordingRef.current) return Promise.resolve();
      const pending = begin(options);
      startRef.current = pending;
      void pending
        .finally(() => {
          if (startRef.current === pending) startRef.current = null;
        })
        .catch(() => undefined);
      return pending;
    },
    [begin],
  );

  const stop = useCallback((): Promise<Blob | null> => {
    // A stop also cancels a start that is still waiting for microphone access.
    streamGenerationRef.current += 1;
    if (pendingStopRef.current) return pendingStopRef.current;
    if (captureErrorRef.current) return Promise.reject(captureErrorRef.current);
    const recorder = recorderRef.current;

    if (!recorder || recorder.state === "inactive") {
      const finalBlob = chunksRef.current.length
        ? new Blob(chunksRef.current, {
            type:
              recorder?.mimeType || chunksRef.current[0]?.type || "audio/webm",
          })
        : null;

      noAudioRef.current = !finalBlob?.size;
      finish(finalBlob, undefined, retainStreamOnStopRef.current);

      return Promise.resolve(finalBlob);
    }

    const pending = new Promise<Blob | null>((resolve, reject) => {
      resolveStopRef.current = resolve;
      rejectStopRef.current = reject;
    });
    pendingStopRef.current = pending;

    stopTimerRef.current = setTimeout(() => {
      if (recorderRef.current === recorder)
        finish(null, new Error("Microphone stop timed out."));
    }, 3000);
    recorder.onstop = () => {
      if (recorderRef.current !== recorder) return;
      const finalBlob = chunksRef.current.length
        ? new Blob(chunksRef.current, {
            type:
              recorder.mimeType || chunksRef.current[0]?.type || "audio/webm",
          })
        : null;

      noAudioRef.current = !finalBlob?.size;
      finish(finalBlob, undefined, retainStreamOnStopRef.current);
    };

    try {
      recorder.stop();
    } catch (error) {
      finish(
        null,
        error instanceof Error
          ? error
          : new Error("Microphone recording failed."),
        retainStreamOnStopRef.current,
      );
    }
    return pending;
  }, [finish]);

  useEffect(() => cancel, [cancel]);

  const getStream = useCallback(() => streamRef.current, []);
  const getIsSpeaking = useCallback(() => isSpeakingRef.current, []);

  return {
    isRecording,
    isSpeaking,
    audioLevel,
    prepare,
    start,
    stop,
    cancel,
    getStream,
    getIsSpeaking,
    getQuality: () =>
      captureErrorRef.current
        ? { ...qualityRef.current.getSnapshot(), status: "INVALID_AUDIO" }
        : noAudioRef.current
          ? { ...qualityRef.current.getSnapshot(), status: "NO_AUDIO" }
          : qualityRef.current.getSnapshot(),
    getSettings: () => settingsRef.current,
  };
}
