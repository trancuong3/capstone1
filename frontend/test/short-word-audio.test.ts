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

  it("plays a single crisp sample by default and repeats only when repeat is true", async () => {
    decodeFixture(Float32Array.of(0.1, -0.25, 0.15));
    const single = await prepareWordSampleAudio(new Blob(["speech"]));
    const singlePcm = new DataView(await single.arrayBuffer());
    expect((singlePcm.byteLength - 44) / 2).toBe(3);
    expect(singlePcm.getInt16(44 + 2, true) / 32767).toBeCloseTo(-0.84);

    const repeated = await prepareWordSampleAudio(new Blob(["speech"]), {
      repeat: true,
    });
    const pcm = new DataView(await repeated.arrayBuffer());
    const read = (frame: number) => pcm.getInt16(44 + 2 * frame, true);
    const second = 3 + Math.round(24_000 * 0.34);
    expect(read(1) / 32767).toBeCloseTo(-0.84);
    expect(read(30)).toBe(0);
    expect(read(second + 1)).toBe(read(1));
    expect(read(second + 2)).toBe(read(2));
  });

  it("trims excessive dead-air >300ms preserving 160ms lead & 200ms trail and avoids double-amplifying loud clips", async () => {
    const sr = 16_000;
    const total = Math.round(sr * 2.0); // 0.8s dead lead + 0.4s speech + 0.8s dead trail
    const samples = new Float32Array(total);
    for (let i = Math.round(sr * 0.8); i < Math.round(sr * 1.2); i++) {
      samples[i] = 0.01 * Math.sin((2 * Math.PI * 250 * i) / sr);
    }
    decodeFixture(samples);
    const trimmed = await prepareShortWordAudio(new Blob(["padded"]));
    expect(trimmed).not.toBeNull();
    const pcm = new DataView(await trimmed!.arrayBuffer());
    const frames = (pcm.byteLength - 44) / 2;
    expect(frames).toBeLessThan(Math.round(sr * 0.9));
    expect(frames).toBeGreaterThan(Math.round(sr * 0.7));

    // Clip already >= 0.065 RMS should not be double-amplified
    const loud = new Float32Array(Math.round(sr * 0.4));
    for (let i = 0; i < loud.length; i++) {
      loud[i] = 0.14 * Math.sin((2 * Math.PI * 250 * i) / sr);
    }
    decodeFixture(loud);
    const notDoubleAmp = await prepareShortWordAudio(new Blob(["loud"]));
    const loudPcm = new DataView(await notDoubleAmp!.arrayBuffer());
    let maxAbs = 0;
    for (let i = 0; i < (loudPcm.byteLength - 44) / 2; i++) {
      maxAbs = Math.max(
        maxAbs,
        Math.abs(loudPcm.getInt16(44 + 2 * i, true) / 32768),
      );
    }
    expect(maxAbs).toBeLessThan(0.2);
  });
});
