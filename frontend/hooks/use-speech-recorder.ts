"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeechRecorder {
  readonly isRecording: boolean;
  readonly isSpeaking: boolean;
  readonly audioLevel: number;
  start(
    onUtterance?: (
      blob: Blob,
      segmentStartedAtMs?: number,
      audioSegmentId?: string,
    ) => void,
  ): Promise<void>;
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

/** Captures browser microphone with live utterance segmentation for continuous STT. */
export function useSpeechRecorder(): SpeechRecorder {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const allChunksRef = useRef<Blob[]>([]);
  const onUtteranceRef = useRef<
    | ((
        blob: Blob,
        segmentStartedAtMs?: number,
        audioSegmentId?: string,
      ) => void)
    | null
  >(null);
  const captureStartedAtMsRef = useRef<number | null>(null);
  const recorderSegmentStartedAtMsRef = useRef<number | null>(null);
  const recorderSegmentIdRef = useRef<string | null>(null);
  const segmentSequenceRef = useRef(0);
  const isRotatingRef = useRef(false);
  const isRecordingRef = useRef(false);
  const hasSpeechInCurrentRecorderRef = useRef(false);
  const captureGenerationRef = useRef(0);

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
    isRecordingRef.current = false;
    isRotatingRef.current = false;
    onUtteranceRef.current = null;
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
      captureGenerationRef.current += 1;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      chunksRef.current = [];
      allChunksRef.current = [];
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
    captureGenerationRef.current += 1;
    const recorder = recorderRef.current;
    if (!recorder) {
      cleanupAudioNodes();
      setIsRecording(false);
      return;
    }
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    if (recorder.state !== "inactive") recorder.stop();
    finish(null);
  }, [cleanupAudioNodes, finish]);

  const start = useCallback(
    async (
      onUtterance?: (
        blob: Blob,
        segmentStartedAtMs?: number,
        audioSegmentId?: string,
      ) => void,
    ) => {
      cancel();
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        throw new Error(
          "Microphone recording is not supported in this browser.",
        );
      }

      onUtteranceRef.current = onUtterance ?? null;
      chunksRef.current = [];
      allChunksRef.current = [];
      isRecordingRef.current = true;
      hasSpeechInCurrentRecorderRef.current = false;
      const captureGeneration = captureGenerationRef.current;
      captureStartedAtMsRef.current = Date.now();
      recorderSegmentStartedAtMsRef.current = null;
      recorderSegmentIdRef.current = null;
      segmentSequenceRef.current = 0;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        cleanupAudioNodes();
        setIsRecording(false);
        throw error;
      }
      if (
        captureGeneration !== captureGenerationRef.current ||
        !isRecordingRef.current
      ) {
        stopTracks(stream);
        throw new Error("Microphone capture was cancelled.");
      }
      streamRef.current = stream;

      const mimeType = preferredMimeTypes.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );

      const createRecorder = () => {
        if (!streamRef.current || !streamRef.current.active) return null;
        const rec = mimeType
          ? new MediaRecorder(streamRef.current, { mimeType })
          : new MediaRecorder(streamRef.current);
        // Each MediaRecorder owns its own chunk array. A final dataavailable
        // event from the previous recorder must never leak into the next segment.
        const recorderChunks: Blob[] = [];
        chunksRef.current = recorderChunks;
        rec.ondataavailable = (event) => {
          if (event.data.size) {
            recorderChunks.push(event.data);
            allChunksRef.current.push(event.data);
          }
        };
        rec.onerror = () => {};
        recorderSegmentStartedAtMsRef.current = Date.now();
        recorderSegmentIdRef.current = `${captureGeneration}:${++segmentSequenceRef.current}`;
        rec.start(150);
        return rec;
      };

      try {
        // Set up Web Audio Analyser for 0ms latency voice activity detection & utterance segmentation
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
            const waveform = new Uint8Array(analyser.fftSize);
            let speakingFrames = 0;
            let silentFrames = 0;
            let hasSpokenInUtterance = false;
            let noiseFloor = 0.008;

            const checkAudio = () => {
              if (!analyserRef.current || !isRecordingRef.current) return;
              analyserRef.current.getByteFrequencyData(dataArray);
              let sum = 0;
              for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
              }
              const avg = sum / dataArray.length;
              analyserRef.current.getByteTimeDomainData(waveform);
              let squaredAmplitude = 0;
              for (let i = 0; i < waveform.length; i++) {
                const centered = (waveform[i] - 128) / 128;
                squaredAmplitude += centered * centered;
              }
              const rms = Math.sqrt(squaredAmplitude / waveform.length);
              const speechThreshold = Math.max(0.025, noiseFloor * 2.5);
              const hasVoiceEnergy = rms >= speechThreshold && avg >= 3;
              const normalized = Math.min(100, Math.round((avg / 128) * 100));
              setAudioLevel(normalized);

              // A short adaptive RMS gate rejects silence and steady low-level
              // environmental noise before an audio segment reaches STT.
              if (hasVoiceEnergy) {
                speakingFrames++;
                hasSpokenInUtterance = true;
                hasSpeechInCurrentRecorderRef.current = true;
                silentFrames = 0;
                if (speakingFrames >= 2) {
                  setIsSpeaking(true);
                }
              } else {
                noiseFloor = noiseFloor * 0.98 + rms * 0.02;
                silentFrames++;
                if (silentFrames >= 5) {
                  speakingFrames = 0;
                  setIsSpeaking(false);
                }
              }

              // Cut only after roughly 500 ms of silence. Short pauses between
              // Vietnamese syllables should not split a spoken phrase into tiny
              // low-context segments.
              if (
                onUtteranceRef.current &&
                hasSpokenInUtterance &&
                silentFrames >= 30 &&
                !isRotatingRef.current
              ) {
                hasSpokenInUtterance = false;
                hasSpeechInCurrentRecorderRef.current = false;
                silentFrames = 0;
                speakingFrames = 0;

                // Scribe word offsets are relative to this MediaRecorder
                // segment's start, not to the later VAD threshold crossing.
                const segmentStartedAtMs =
                  recorderSegmentStartedAtMsRef.current ??
                  captureStartedAtMsRef.current ??
                  Date.now();
                const audioSegmentId = recorderSegmentIdRef.current;
                const activeRecorder = recorderRef.current;
                if (activeRecorder && activeRecorder.state === "recording") {
                  isRotatingRef.current = true;
                  const currentUtteranceChunks = chunksRef.current;
                  chunksRef.current = [];

                  activeRecorder.onstop = () => {
                    isRotatingRef.current = false;
                    const contentType = activeRecorder.mimeType || "audio/webm";
                    if (currentUtteranceChunks.length) {
                      const blob = new Blob(currentUtteranceChunks, {
                        type: contentType,
                      });
                      if (blob.size > 800) {
                        onUtteranceRef.current?.(
                          blob,
                          segmentStartedAtMs,
                          audioSegmentId ?? undefined,
                        );
                      }
                    }
                  };

                  try {
                    activeRecorder.stop();
                    recorderRef.current = createRecorder();
                  } catch {
                    isRotatingRef.current = false;
                  }
                }
              }

              animFrameRef.current = requestAnimationFrame(checkAudio);
            };
            animFrameRef.current = requestAnimationFrame(checkAudio);
          } catch {
            // AudioContext gracefully skipped if disabled by browser policy
          }
        }

        const initialRecorder = createRecorder();
        if (!initialRecorder) {
          throw new Error("Microphone recorder could not be initialized.");
        }
        recorderRef.current = initialRecorder;
        setIsRecording(true);

        // Wait for the first MediaRecorder timeslice before reporting that
        // capture is ready. Audio gathered during this warm-up is retained as
        // pre-roll, protecting the first phoneme after the UI starts listening.
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            clearTimeout(warmupTimeout);
            resolve();
          };
          const warmupTimeout = setTimeout(settle, 400);
          initialRecorder.addEventListener("dataavailable", settle, {
            once: true,
          });
        });

        if (
          captureGeneration !== captureGenerationRef.current ||
          !isRecordingRef.current
        ) {
          throw new Error("Microphone capture was cancelled.");
        }
      } catch (error) {
        stopTracks(stream);
        cleanupAudioNodes();
        throw error;
      }
    },
    [cancel, cleanupAudioNodes],
  );

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      cleanupAudioNodes();
      setIsRecording(false);
      const finalBlob = allChunksRef.current.length
        ? new Blob(allChunksRef.current, { type: "audio/webm" })
        : null;
      return Promise.resolve(finalBlob);
    }

    return new Promise<Blob | null>((resolve, reject) => {
      resolveStopRef.current = resolve;
      rejectStopRef.current = reject;
      const finalSegmentChunks = chunksRef.current;
      const finalSegmentStartedAtMs =
        recorderSegmentStartedAtMsRef.current ??
        captureStartedAtMsRef.current ??
        Date.now();
      const finalAudioSegmentId = recorderSegmentIdRef.current;
      const finalHasSpeech = hasSpeechInCurrentRecorderRef.current;
      recorder.onstop = () => {
        const contentType = recorder.mimeType || "audio/webm";
        const finalSegment = finalSegmentChunks.length
          ? new Blob(finalSegmentChunks, { type: contentType })
          : null;
        // Emit the unsegmented tail exactly once. Previously this tail was
        // returned as a whole-session Blob and the caller could either lose it
        // or re-transcribe all already-processed audio.
        if (finalHasSpeech && finalSegment && finalSegment.size > 800) {
          onUtteranceRef.current?.(
            finalSegment,
            finalSegmentStartedAtMs,
            finalAudioSegmentId ?? undefined,
          );
        }
        const fullRecording = allChunksRef.current.length
          ? new Blob(allChunksRef.current, { type: contentType })
          : null;
        finish(fullRecording);
      };
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
  }, [cleanupAudioNodes, finish]);

  useEffect(() => cancel, [cancel]);

  const getStream = useCallback(() => streamRef.current, []);

  return {
    isRecording,
    isSpeaking,
    audioLevel,
    start,
    stop,
    cancel,
    getStream,
  };
}
