"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
}

const preferredMimeTypes = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

export function useSpeechRecorder(): SpeechRecorder {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isRecordingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const retainStreamOnStopRef = useRef(false);

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
      void audioContextRef.current?.close();
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

      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
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

      if (error) {
        reject?.(error);
      } else {
        resolve?.(recording);
      }
    },
    [cleanupAudioNodes],
  );

  const cancel = useCallback(
    (options?: { retainStream?: boolean }) => {
      const recorder = recorderRef.current;

      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;

        if (recorder.state !== "inactive") {
          recorder.stop();
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

    streamRef.current = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
  }, []);

  const start = useCallback(
    async (options?: { retainStream?: boolean }) => {
      const retainStream = options?.retainStream === true;
      cancel({ retainStream: Boolean(streamRef.current) });

      if (typeof MediaRecorder === "undefined") {
        throw new Error(
          "Microphone recording is not supported in this browser.",
        );
      }

      chunksRef.current = [];

      try {
        await prepare();
        const stream = streamRef.current;
        if (!stream) throw new Error("Microphone is unavailable.");
        retainStreamOnStopRef.current = retainStream;
        isRecordingRef.current = true;

        const mimeType = preferredMimeTypes.find((candidate) =>
          MediaRecorder.isTypeSupported(candidate),
        );

        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunksRef.current.push(event.data);
          }
        };

        recorder.onerror = () => {
          finish(null, new Error("Microphone recording failed."), retainStream);
        };

        // Chỉ sử dụng MỘT MediaRecorder cho toàn bộ phiên ghi âm.
        recorder.start(250);
        recorderRef.current = recorder;

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
              if (!analyserRef.current || !isRecordingRef.current) {
                return;
              }

              analyserRef.current.getByteFrequencyData(dataArray);

              let sum = 0;

              for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
              }

              const avg = sum / dataArray.length;
              const normalized = Math.min(100, Math.round((avg / 128) * 100));

              setAudioLevel(normalized);

              if (avg > 10) {
                speakingFrames++;
                silentFrames = 0;

                if (speakingFrames >= 2 && !isSpeakingRef.current) {
                  isSpeakingRef.current = true;
                  setIsSpeaking(true);
                }
              } else {
                silentFrames++;

                if (silentFrames >= 5) {
                  speakingFrames = 0;
                  if (isSpeakingRef.current) {
                    isSpeakingRef.current = false;
                    setIsSpeaking(false);
                  }
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
        finish(null, undefined, retainStream);
        throw error;
      }
    },
    [cancel, finish, prepare],
  );

  const stop = useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state === "inactive") {
      const finalBlob = chunksRef.current.length
        ? new Blob(chunksRef.current, {
            type:
              recorder?.mimeType || chunksRef.current[0]?.type || "audio/webm",
          })
        : null;

      finish(finalBlob, undefined, retainStreamOnStopRef.current);

      return Promise.resolve(finalBlob);
    }

    return new Promise<Blob | null>((resolve, reject) => {
      resolveStopRef.current = resolve;
      rejectStopRef.current = reject;

      recorder.onstop = () => {
        const finalBlob = chunksRef.current.length
          ? new Blob(chunksRef.current, {
              type:
                recorder.mimeType || chunksRef.current[0]?.type || "audio/webm",
            })
          : null;

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
    });
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
  };
}
