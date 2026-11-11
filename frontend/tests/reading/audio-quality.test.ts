import { describe, expect, it } from "vitest";
import {
  AudioQualityMonitor,
  hasUnusableAudio,
} from "@/lib/reading/audio-quality";

function frame(level: number) {
  return Float32Array.from({ length: 128 }, (_, i) => (i % 2 ? level : -level));
}
function feed(
  monitor: AudioQualityMonitor,
  level: number,
  start: number,
  end: number,
) {
  for (let t = start; t <= end; t += 20) monitor.addFrame(frame(level), t);
  return monitor.getSnapshot();
}

describe("audio quality and adaptive activity", () => {
  it("remains unknown without an analyzer", () => {
    const snapshot = new AudioQualityMonitor().getSnapshot();
    expect(snapshot.status).toBe("UNKNOWN");
    expect(hasUnusableAudio(snapshot)).toBe(false);
  });
  it("distinguishes silence from missing audio", () => {
    const q = feed(new AudioQualityMonitor(), 0, 0, 2000);
    expect(q.status).toBe("SILENCE");
    expect(q.speechDurationMs).toBe(0);
    expect(hasUnusableAudio(q)).toBe(true);
  });
  it("does not turn low volume into a child error", () => {
    const m = new AudioQualityMonitor();
    feed(m, 0.0001, 0, 400);
    expect(feed(m, 0.005, 420, 1200).status).toBe("LOW_VOLUME");
  });
  it("detects activity above a measured floor and holds through brief pauses", () => {
    const m = new AudioQualityMonitor();
    feed(m, 0.001, 0, 400);
    expect(feed(m, 0.1, 420, 1000).status).toBe("SPEECH_DETECTED");
    expect(feed(m, 0.001, 1020, 1100).isSpeaking).toBe(true);
    expect(feed(m, 0.001, 1120, 1600).isSpeaking).toBe(false);
    expect(m.getSnapshot().speechDurationMs).toBeGreaterThan(100);
  });
  it("does not label constant loud fan noise as speech", () => {
    const q = feed(new AudioQualityMonitor(), 0.15, 0, 2000);
    expect(q.status).toBe("BACKGROUND_NOISE");
    expect(q.isSpeaking).toBe(false);
  });
  it("rejects a sudden loud impulse as evidence of speech", () => {
    const m = new AudioQualityMonitor();
    feed(m, 0.001, 0, 400);
    m.addFrame(frame(0.8), 420);
    expect(feed(m, 0.001, 440, 1000).speechDurationMs).toBe(0);
  });
  it("flags sustained clipping and invalid samples", () => {
    expect(feed(new AudioQualityMonitor(), 1, 0, 1000).status).toBe(
      "INVALID_AUDIO",
    );
    const m = new AudioQualityMonitor();
    expect(m.addFrame(frame(Number.NaN), 0).status).toBe("INVALID_AUDIO");
  });
  it("marks very short recordings without inferring pronunciation", () => {
    expect(feed(new AudioQualityMonitor(), 0.1, 0, 100).status).toBe(
      "AUDIO_TOO_SHORT",
    );
  });
  it("does not oscillate for single frames near the threshold", () => {
    const m = new AudioQualityMonitor();
    feed(m, 0.001, 0, 400);
    for (let t = 420; t <= 1200; t += 20)
      m.addFrame(frame(t % 40 ? 0.004 : 0.001), t);
    expect(m.getSnapshot().isSpeaking).toBe(false);
  });
});
