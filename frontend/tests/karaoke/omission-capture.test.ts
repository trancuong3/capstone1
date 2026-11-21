import { describe, expect, it } from "vitest";
import { LiveSingingAttempt } from "@/lib/karaoke/live-singing-score";
import { CaptureWindows } from "@/lib/karaoke/recognition-capture";
import type { KaraokeLyrics } from "@/types/karaoke";

const lyrics: KaraokeLyrics = {
  format_version: 1,
  lines: ["bé", "hát", "vui"].map((text, i) => ({
    id: `line-${i}`,
    text,
    start_ms: 1000 + i * 1500,
    end_ms: 1800 + i * 1500,
  })),
};

function capture() {
  let time = 0;
  const attempt = new LiveSingingAttempt(lyrics);
  const windows = new CaptureWindows(() => time, true);
  windows.started();
  attempt.beginCapture(windows.captureId);
  const results: {
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  }[] = [];
  return {
    attempt,
    quiet(from: number, to: number) {
      for (let ms = from; ms < to; ms += 50)
        attempt.observeAudio(ms, Math.min(ms + 50, to), "quiet");
    },
    sing(from: number, to: number, text: string, confidence = 0.99) {
      time = from;
      windows.speechStart();
      time = to;
      windows.speechEnd();
      results.push({ isFinal: true, 0: { transcript: text, confidence } });
      windows.consume({ resultIndex: results.length - 1, results }, attempt);
    },
    finish() {
      attempt.settleThrough(5000);
      return attempt.result().lineScores.map((line) => line.words[0].state);
    },
  };
}

describe("omissions during real recognition captures", () => {
  it.each([0.99, 0.1])(
    "does not let later speech erase an earlier quiet line (confidence %s)",
    (confidence) => {
      const c = capture();
      c.quiet(850, 2100);
      c.sing(2500, 3300, "hát", confidence);
      expect(c.finish()[0]).toBe("omitted");
    },
  );

  it("retains a skipped line between two separate utterance groups", () => {
    const c = capture();
    c.sing(1000, 1800, "bé");
    c.quiet(2350, 3600);
    c.sing(4000, 4800, "vui");
    expect(c.finish()).toEqual(["matched", "omitted", "matched"]);
  });

  it("settles a fully monitored line when capture stops exactly at its end", () => {
    const c = capture();
    c.quiet(1000, 1800);
    c.attempt.settleThrough(1800);
    expect(c.attempt.result().lineScores[0].words[0].state).toBe("omitted");
  });

  it("keeps speech within the quiet candidate unassessed even when ASR rejects it", () => {
    const c = capture();
    c.quiet(850, 2100);
    c.sing(1000, 1800, "không rõ", 0.1);
    expect(c.finish()[0]).toBe("unknown");
  });

  it("never carries quiet evidence across an actual microphone restart", () => {
    const c = capture();
    c.quiet(850, 2100);
    c.attempt.closeCapture();
    c.attempt.beginCapture("after-pause");
    expect(c.finish()[0]).toBe("unknown");
  });
});
