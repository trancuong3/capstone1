import type { SingingActivity } from "./live-singing-score";

/** Deliberately conservative acoustic evidence, not speaker identification.
 * Uncalibrated low volume and digital zero remain uncertain. No transcript is
 * accepted or rejected based solely on this energy heuristic. */
export class SingingSignalClassifier {
  private started: number | null = null;
  private noise = 0.0002;
  private lastVoice = -Infinity;
  private voiceLevel = 0;

  sample(samples: Float32Array, nowMs: number): SingingActivity {
    if (!samples.length || !Number.isFinite(nowMs)) return "uncertain";
    this.started ??= nowMs;
    let energy = 0;
    let peak = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample) || Math.abs(sample) >= 0.99)
        return "uncertain";
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(energy / samples.length);
    // Noise suppression can output exact zero when a working microphone falls
    // silent. Require prior audible input on this same live, unmuted track.
    if (rms < 0.00001)
      return this.voiceLevel > 0 && nowMs - this.lastVoice >= 300
        ? "quiet"
        : "uncertain";
    if (rms >= Math.max(0.003, this.noise * 3)) {
      this.lastVoice = nowMs;
      this.voiceLevel = Math.max(this.voiceLevel, Math.min(rms, 0.03));
      return "voice";
    }
    if (rms <= 0.0008) this.noise += (rms - this.noise) * 0.05;
    if (nowMs - this.started < 300 || nowMs - this.lastVoice < 300)
      return "uncertain";
    const quietLimit = Math.max(
      Math.min(0.0008, this.noise * 1.8),
      Math.min(0.002, this.voiceLevel * 0.08),
    );
    return rms <= quietLimit && peak < 0.005 ? "quiet" : "uncertain";
  }
}

export type SignalObserver = (
  fromMs: number,
  toMs: number,
  activity: SingingActivity,
) => void;

/** Observes only the already-authorized track used by the recognizer.
 * Does not request another device or record/upload audio. */
export function monitorSingingTrack(
  stream: MediaStream,
  clock: () => number,
  observe: SignalObserver,
  classifier = new SingingSignalClassifier(),
  sharedContext?: AudioContext,
): () => void {
  const ownsContext = !sharedContext || sharedContext.state === "closed";
  if (ownsContext && typeof AudioContext === "undefined") return () => {};
  let context: AudioContext | undefined = ownsContext
    ? undefined
    : sharedContext;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let readyToSample = false;
  let sampleNow = (_forceFlush = false) => {
    void _forceFlush;
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    if (readyToSample) {
      try {
        sampleNow(true);
      } catch {
        /* Best-effort trailing sample flush during teardown. */
      }
    }
    source?.disconnect();
    analyser?.disconnect();
    if (ownsContext && context && context.state !== "closed")
      void context.close().catch(() => {});
  };
  try {
    context ??= new AudioContext();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let previousMedia = clock();
    let previousWall = performance.now();
    sampleNow = (forceFlush = false) => {
      if (closed && !forceFlush) return;
      const now = performance.now();
      const media = clock();
      const from = previousMedia;
      const wallDelta = now - previousWall;
      previousMedia = media;
      previousWall = now;
      if (media <= from || media - from > 350 || wallDelta > 450) return;
      const track = stream.getAudioTracks()[0];
      let activity: SingingActivity = "uncertain";
      if (
        context?.state === "running" &&
        track?.readyState === "live" &&
        track.enabled &&
        !track.muted
      ) {
        analyser!.getFloatTimeDomainData(samples);
        activity = classifier.sample(samples, now);
      }
      observe(from, media, activity);
    };
    if (context.state !== "running") {
      void context.resume().catch(() => {});
    }
    readyToSample = true;
    timer = setInterval(() => sampleNow(false), 50);
    return stop;
  } catch {
    stop();
    return () => {};
  }
}
