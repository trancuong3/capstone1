"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeechRecorder {
  readonly isRecording: boolean;
  readonly isSpeaking: boolean;
  readonly audioLevel: number;
  start(): Promise<void>;
  stop(): Promise<Blob | null>;
  cancel(): void;
  getStream(): MediaStream | null;
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
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const resolveStopRef = useRef<((recording: Blob | null) => void) | null>(
    null,
  );
  const rejectStopRef = useRef<((reason: Error) => void) | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const cleanupAudioNodes = useCallback(() => {
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
      void audioContextRef.current?.close();
    } catch {
      // Safe ignore
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    streamRef.current = null;
    setIsSpeaking(false);
    setAudioLevel(0);
  }, []);

  const finish = useCallback(
    (recording: Blob | null, error?: Error) => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      chunksRef.current = [];
      if (recorder) stopTracks(recorder.stream);
      cleanupAudioNodes();
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
    },
    [cleanupAudioNodes],
  );

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
    streamRef.current = stream;

    try {
      // Set up Web Audio Analyser for 0ms latency voice activity detection
      if (
        typeof window !== "undefined" &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window.AudioContext || (window as any).webkitAudioContext)
      ) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const AudioCtx =
            window.AudioContext || (window as any).webkitAudioContext;
          const ctx = new AudioCtx();
          audioContextRef.current = ctx;
          if (ctx.state === "suspended") {
            void ctx.resume();
          }
          const source = ctx.createMediaStreamSource(stream);
          sourceRef.current = source;
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.5;
          source.connect(analyser);
          analyserRef.current = analyser;

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          let speakingFrames = 0;
          let silentFrames = 0;

          const checkAudio = () => {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const avg = sum / dataArray.length;
            const normalized = Math.min(100, Math.round((avg / 128) * 100));
            setAudioLevel(normalized);

            // VAD: avg > 10 corresponds to audible human speech in room
            if (avg > 10) {
              speakingFrames++;
              silentFrames = 0;
              if (speakingFrames >= 2) {
                setIsSpeaking(true);
              }
            } else {
              silentFrames++;
              if (silentFrames >= 6) {
                speakingFrames = 0;
                setIsSpeaking(false);
              }
            }
            animFrameRef.current = requestAnimationFrame(checkAudio);
          };
          animFrameRef.current = requestAnimationFrame(checkAudio);
        } catch {
          // AudioContext gracefully skipped if disabled by browser policy
        }
      }

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
      cleanupAudioNodes();
      throw error;
    }
  }, [cancel, cleanupAudioNodes, finish]);

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

  const getStream = useCallback(() => streamRef.current, []);

  return { isRecording, isSpeaking, audioLevel, start, stop, cancel, getStream };
}
