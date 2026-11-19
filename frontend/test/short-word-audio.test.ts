import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareShortWordAudio,
  prepareWordSampleAudio,
} from "@/lib/reading/short-word-audio";

afterEach(() => vi.unstubAllGlobals());

describe("short-word audio", () => {
  function decodeFixture(samples: Float32Array) {
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        async decodeAudioData() {
          return {
            numberOfChannels: 1,
            getChannelData: () => samples,
          };
        }
      },
    );
  }

  it("keeps quiet speech audible when a brief click peaks above it", async () => {
    const samples = new Float32Array(8000);
    samples[100] = 0.6;
    for (let i = 1000; i < 4200; i++) {
      samples[i] = 0.009 * Math.sin((2 * Math.PI * 240 * i) / 16_000);
    }
    decodeFixture(samples);
    const audio = await prepareShortWordAudio(
      new Blob(["webm"], { type: "audio/webm" }),
    );
    expect(audio?.type).toBe("audio/wav");
    const pcm = new DataView(await audio!.arrayBuffer());
    const frames = Array.from(
      { length: (pcm.byteLength - 44) / 2 },
      (_, i) => pcm.getInt16(44 + 2 * i, true) / 32768,
    );
    expect(frames.length).toBeGreaterThan(samples.length);
    expect(
      frames.filter((sample) => Math.abs(sample) > 0.035).length,
    ).toBeGreaterThan(500);
    expect(Math.max(...frames.map(Math.abs))).toBeLessThan(0.95);
  });

  it("does not turn a silent recording into speech", async () => {
    decodeFixture(new Float32Array(8000));
    await expect(
      prepareShortWordAudio(new Blob(["silent"])),
    ).resolves.toBeNull();
  });

  it("plays the same sample twice at a clear level with silence between", async () => {
    decodeFixture(Float32Array.of(0.1, -0.25, 0.15));
    const sample = await prepareWordSampleAudio(new Blob(["speech"]));
    const pcm = new DataView(await sample.arrayBuffer());
    const read = (frame: number) => pcm.getInt16(44 + 2 * frame, true);
    const second = 3 + Math.round(24_000 * 0.34);
    expect(read(1) / 32767).toBeCloseTo(-0.84);
    expect(read(30)).toBe(0);
    expect(read(second + 1)).toBe(read(1));
    expect(read(second + 2)).toBe(read(2));
  });
});
