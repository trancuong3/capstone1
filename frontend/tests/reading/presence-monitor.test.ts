import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESENCE_CONFIG,
  PresenceMonitor,
  observe,
  type PresenceContext,
  type PresenceEffect,
  type PresenceSample,
} from "@/lib/reading/presence-monitor";
import { analyzeFrame, classifyFrame } from "@/lib/reading/presence-frame";

const READING: PresenceContext = {
  optedIn: true,
  sessionPhase: "reading",
  appVisible: true,
  cameraGranted: true,
};
const PRESENT = { faceCount: 1, quality: "ok", motion: 0.2 } as const;
const ABSENT = { faceCount: 0, quality: "ok", motion: 0 } as const;

function harness(context: PresenceContext = READING) {
  let ids = 0;
  const monitor = new PresenceMonitor(() => `episode-${(ids += 1)}`);
  let now = 0;
  let current = context;
  const effects: PresenceEffect[] = [];
  return {
    monitor,
    effects,
    set(patch: Partial<PresenceContext>) {
      current = { ...current, ...patch };
    },
    /** Feed one sample per second for `seconds`. */
    run(sample: Omit<PresenceSample, "at">, seconds: number) {
      for (let i = 0; i < seconds; i += 1) {
        now += 1000;
        effects.push(...monitor.update(current, { ...sample, at: now }, now));
      }
    },
    tick(sample: Omit<PresenceSample, "at"> | null = null) {
      now += 1000;
      effects.push(
        ...monitor.update(current, sample ? { ...sample, at: now } : null, now),
      );
    },
    types() {
      return effects.map((effect) => effect.type);
    },
    count(type: PresenceEffect["type"]) {
      return effects.filter((effect) => effect.type === type).length;
    },
  };
}

describe("observation: what counts as absent", () => {
  it("is absent only with a good frame, no face and a still scene", () => {
    expect(observe({ at: 0, ...ABSENT })).toBe("absent");
    expect(observe({ at: 0, ...PRESENT })).toBe("present");
  });

  it.each([
    ["bending over the book / turning the head", { faceCount: 0, quality: "ok", motion: 0.3 }],
    ["dark room", { faceCount: 0, quality: "dark", motion: 0 }],
    ["covered camera", { faceCount: 0, quality: "covered", motion: 0 }],
    ["no face detector on this device", { faceCount: null, quality: "unsupported", motion: 0 }],
    ["camera error", { faceCount: null, quality: "error", motion: 0 }],
  ] as const)("is uncertain for %s", (_name, sample) => {
    expect(observe({ at: 0, ...sample })).toBe("uncertain");
  });
});

describe("when the reader leaves (G11, G12)", () => {
  it("does nothing until presence was first established", () => {
    const h = harness();
    h.run(ABSENT, 600);
    expect(h.effects).toEqual([]);
    h.run(PRESENT, 2); // not yet 3 s of continuous presence
    h.run(ABSENT, 600);
    expect(h.effects).toEqual([]);
  });

  it("pauses, shows a calm notice and arms exactly one alert after 45 s of continuous absence", () => {
    const h = harness();
    h.run(PRESENT, 5);
    h.run(ABSENT, 45); // first absent frame starts the clock: 45 s not yet elapsed
    expect(h.effects).toEqual([]);
    h.run(ABSENT, 1);
    expect(h.types()).toEqual(["PAUSE_SESSION", "SHOW_NOTICE", "ARM_ALERT"]);
    h.run(ABSENT, 300);
    expect(h.count("ARM_ALERT")).toBe(1);
  });

  it("heartbeats while the reader is positively absent so the server can still send", () => {
    const h = harness();
    h.run(PRESENT, 5);
    h.run(ABSENT, 46);
    h.set({ sessionPhase: "paused-by-presence" });
    h.run(ABSENT, 40);
    expect(h.count("CONFIRM_ALERT")).toBe(4);
  });

  it("stops vouching when the scene becomes unclear (covered camera), so no email follows", () => {
    const h = harness();
    h.run(PRESENT, 5);
    h.run(ABSENT, 46);
    h.set({ sessionPhase: "paused-by-presence" });
    h.run({ faceCount: 0, quality: "covered", motion: 0 }, 60);
    expect(h.count("CONFIRM_ALERT")).toBe(0);
  });

  it("restarts the absence clock on any unclear frame", () => {
    const h = harness();
    h.run(PRESENT, 5);
    h.run(ABSENT, 40);
    h.run({ faceCount: 0, quality: "ok", motion: 0.4 }, 1);
    h.run(ABSENT, 40);
    expect(h.effects).toEqual([]);
    h.run(ABSENT, 6);
    expect(h.count("ARM_ALERT")).toBe(1);
  });

  it.each([
    ["bending over the book", { faceCount: 0, quality: "ok", motion: 0.3 }],
    ["dark room", { faceCount: 0, quality: "dark", motion: 0 }],
    ["covered camera", { faceCount: 0, quality: "covered", motion: 0 }],
    ["unsupported device", { faceCount: null, quality: "unsupported", motion: 0 }],
    ["camera error", { faceCount: null, quality: "error", motion: 0 }],
  ] as const)("never alerts for %s, however long", (_name, sample) => {
    const h = harness();
    h.run(PRESENT, 5);
    h.run(sample, 1200);
    expect(h.effects).toEqual([]);
  });

  it("never evaluates without the parent's opt-in", () => {
    const h = harness({ ...READING, optedIn: false });
    h.run(PRESENT, 5);
    h.run(ABSENT, 600);
    expect(h.effects).toEqual([]);
  });

  it("does not evaluate while the session is paused by the child or parent", () => {
    const h = harness({ ...READING, sessionPhase: "paused-other" });
    h.run(PRESENT, 5);
    h.run(ABSENT, 600);
    expect(h.effects).toEqual([]);
  });

  it("does not evaluate when the camera is not granted or the app is in the background", () => {
    for (const patch of [{ cameraGranted: false }, { appVisible: false }] as const) {
      const h = harness({ ...READING, ...patch });
      h.run(PRESENT, 5);
      h.run(ABSENT, 600);
      expect(h.effects).toEqual([]);
    }
  });

  it("after backgrounding the app, new presence evidence is required", () => {
    const h = harness();
    h.run(PRESENT, 5);
    h.set({ appVisible: false });
    h.run(ABSENT, 3);
    h.set({ appVisible: true });
    h.run(ABSENT, 600);
    expect(h.effects).toEqual([]);
  });
});

describe("cancelling a pending alert", () => {
  function armed() {
    const h = harness();
    h.run(PRESENT, 5);
    h.run(ABSENT, 46);
    h.set({ sessionPhase: "paused-by-presence" });
    h.effects.length = 0;
    return h;
  }

  it("cancels when the reader is back for 2 s, and does not reopen anything by itself", () => {
    const h = armed();
    h.run(PRESENT, 2); // 1 s apart: not yet 2 s of continuous presence
    expect(h.effects).toEqual([]);
    h.run(PRESENT, 1);
    expect(h.effects).toEqual([
      { type: "CANCEL_ALERT", episodeId: "episode-1", reason: "RETURNED" },
    ]);
    expect(h.types()).not.toContain("PAUSE_SESSION");
    expect(h.monitor.hasPendingAlert).toBe(false);
  });

  it("a one-frame flicker of presence does not cancel", () => {
    const h = armed();
    h.run(PRESENT, 1);
    h.run(ABSENT, 1);
    h.run(PRESENT, 1);
    h.run(ABSENT, 20);
    expect(h.count("CANCEL_ALERT")).toBe(0);
  });

  it.each([
    ["the parent opts out", { optedIn: false }, "OPT_OUT"],
    ["the session ends", { sessionPhase: "ended" }, "SESSION_ENDED"],
    ["the app goes to the background", { appVisible: false }, "APP_BACKGROUND"],
    ["the camera is lost", { cameraGranted: false }, "CAMERA_UNAVAILABLE"],
    ["a parent pauses the session", { sessionPhase: "paused-other" }, "PAUSED_BY_PARENT"],
  ] as const)("cancels when %s", (_name, patch, reason) => {
    const h = armed();
    h.set(patch);
    h.run(ABSENT, 1);
    expect(h.effects).toEqual([
      { type: "CANCEL_ALERT", episodeId: "episode-1", reason },
    ]);
    h.run(ABSENT, 600);
    expect(h.count("ARM_ALERT")).toBe(0); // nothing re-armed after the cancel
  });

  it("a later, separate absence gets a new episode id", () => {
    const h = armed();
    h.run(PRESENT, 3);
    h.set({ sessionPhase: "reading" });
    h.run(PRESENT, 5);
    h.run(ABSENT, 46);
    const armedEpisodes = h.effects.filter((e) => e.type === "ARM_ALERT");
    expect(armedEpisodes).toEqual([{ type: "ARM_ALERT", episodeId: "episode-2" }]);
  });
});

describe("frame analysis (on-device, no image leaves the function)", () => {
  const size = 16 * 12;
  const rgba = (fill: (index: number) => number) => {
    const data = new Uint8ClampedArray(size * 4);
    for (let i = 0; i < size; i += 1) {
      const value = fill(i);
      data[i * 4] = value;
      data[i * 4 + 1] = value;
      data[i * 4 + 2] = value;
      data[i * 4 + 3] = 255;
    }
    return data;
  };
  const noisy = (base: number, seed: number) =>
    rgba((i) => base + ((i * 37 + seed * 11) % 90) - 45);

  it("measures brightness, contrast and motion", () => {
    const first = analyzeFrame(noisy(128, 1), null);
    expect(first.meanLuma).toBeGreaterThan(100);
    expect(first.lumaStd).toBeGreaterThan(10);
    expect(first.motion).toBe(0);
    const same = analyzeFrame(noisy(128, 1), first.luma);
    expect(same.motion).toBe(0);
    const moved = analyzeFrame(noisy(128, 7), first.luma);
    expect(moved.motion).toBeGreaterThan(DEFAULT_PRESENCE_CONFIG.motionThreshold);
  });

  it("classifies dark and covered frames as unusable and never as absence", () => {
    const dark = analyzeFrame(rgba(() => 5), null);
    const covered = analyzeFrame(rgba(() => 120), null);
    const good = analyzeFrame(noisy(128, 3), null);
    expect(classifyFrame(dark, 0).quality).toBe("dark");
    expect(classifyFrame(covered, 0).quality).toBe("covered");
    expect(classifyFrame(good, 0).quality).toBe("ok");
    expect(classifyFrame(good, null).quality).toBe("unsupported");
    expect(classifyFrame(good, 2).faceCount).toBe(2);
  });
});
