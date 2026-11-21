import { describe, expect, it } from "vitest";
import { SingingSignalClassifier } from "@/lib/karaoke/microphone-signal";

function frame(amplitude: number) {
  return Float32Array.from(
    { length: 1024 },
    (_, i) => amplitude * Math.sin(i / 4),
  );
}

describe("singing signal evidence", () => {
  it("calibrates quiet input, detects voice and keeps soft or disconnected input uncertain", () => {
    const signal = new SingingSignalClassifier();
    expect(signal.sample(frame(0.0002), 0)).toBe("uncertain");
    for (let t = 50; t < 400; t += 50) signal.sample(frame(0.0002), t);
    expect(signal.sample(frame(0.0002), 400)).toBe("quiet");
    expect(signal.sample(frame(0.04), 450)).toBe("voice");
    expect(signal.sample(frame(0.0002), 500)).toBe("uncertain");
    expect(signal.sample(frame(0.002), 1000)).toBe("uncertain");
    expect(signal.sample(frame(0), 1050)).toBe("uncertain");
  });

  it("never learns clipped audio or opening singing as silence", () => {
    const signal = new SingingSignalClassifier();
    for (let t = 0; t < 1000; t += 50) {
      expect(signal.sample(frame(0.1), t)).not.toBe("quiet");
    }
    expect(signal.sample(new Float32Array(1024).fill(1), 1100)).toBe(
      "uncertain",
    );
    expect(signal.sample(new Float32Array([NaN]), 1150)).toBe("uncertain");
  });
});
