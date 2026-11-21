import { describe, expect, it } from "vitest";
import { LiveSingingAttempt } from "@/lib/karaoke/live-singing-score";
import type { KaraokeLyrics } from "@/types/karaoke";

function song(text = "bé hát vui"): KaraokeLyrics {
  return {
    format_version: 2,
    lines: [
      {
        id: "line",
        text,
        start_ms: 1000,
        end_ms: 4000,
        syllables: text.split(" ").map((text, i) => ({
          id: `s${i}`,
          text,
          start_ms: 1000 + i * 1000,
          end_ms: 2000 + i * 1000,
        })),
      },
    ],
  };
}

const states = (a: LiveSingingAttempt) =>
  a.result().lineScores[0].words.map((w) => w.state);

describe("karaoke v2 evidence contract", () => {
  it("does not reopen an unresolved past word just because playback continues after capture closes", () => {
    const a = new LiveSingingAttempt(song());
    a.observePlayback(1000, 1500);
    a.observePlayback(1500, 2100);
    a.flushPlayedOmissions(2100);
    a.observePlayback(2100, 2200);
    expect(a.result().lineScores[0].words[0]).toMatchObject({
      state: "unknown",
      phase: "settled",
    });
  });
  it("does not turn playback exposure or a missing final into omissions", () => {
    const a = new LiveSingingAttempt(song());
    for (let ms = 1000; ms < 4500; ms += 100) a.observePlayback(ms, ms + 100);
    a.flushPlayedOmissions(4500);
    expect(states(a)).toEqual(["unknown", "unknown", "unknown"]);
    expect(a.result()).toMatchObject({
      kind: "insufficient",
      evaluatedWords: 0,
      overallAccuracy: null,
    });
  });

  it("uses the same unambiguous alignment for interim and final repeated words", () => {
    const lyrics = song("bé bé vui");
    // One phrase timing cannot distinguish either occurrence of bé.
    lyrics.lines[0].syllables = [];
    const a = new LiveSingingAttempt(lyrics);
    const preview = a.preview("bé vui", 1000, 4000);
    a.accept("bé vui", 1000, 4000);
    expect([...preview.entries()]).toEqual(
      a
        .result()
        .lineScores[0].words.filter((w) => w.state !== "unknown")
        .map((w) => [w.id, w.state]),
    );
    expect(states(a)).toEqual(["unknown", "unknown", "matched"]);
  });

  it("does not preview a lyric that has not started", () => {
    const a = new LiveSingingAttempt(song());
    expect([...a.preview("bé hát vui", 1000, 1500).keys()]).toEqual(["s0/0"]);
    expect(a.result().evaluatedWords).toBe(0);
  });

  it("keeps unanchored missing edges unknown while proving interior omissions", () => {
    const a = new LiveSingingAttempt(song());
    a.accept("bé vui", 1000, 4000);
    expect(states(a)).toEqual(["matched", "omitted", "matched"]);
    const b = new LiveSingingAttempt(song());
    b.accept("hát vui", 2000, 4000);
    expect(states(b)).toEqual(["unknown", "matched", "matched"]);
  });

  it("accepts a late final after the played word without ever awarding future words", () => {
    const a = new LiveSingingAttempt(song());
    for (let ms = 1000; ms < 2500; ms += 100) a.observePlayback(ms, ms + 100);
    a.accept("bé", 2100, 2400, 1000);
    expect(states(a)).toEqual(["matched", "unknown", "unknown"]);
  });

  it("requires healthy quiet coverage and a drained recognition window to prove silence", () => {
    const a = new LiveSingingAttempt(song());
    for (let ms = 850; ms < 2300; ms += 50)
      a.observeAudio(ms, ms + 50, "quiet");
    a.observePlayback(2300, 2400);
    expect(states(a)[0]).toBe("unknown");
    a.settleThrough(2400);
    expect(states(a)).toEqual(["omitted", "unknown", "unknown"]);
  });

  it.each(["voice", "uncertain"] as const)(
    "does not call an unrecognized %s interval an omission",
    (activity) => {
      const a = new LiveSingingAttempt(song());
      for (let ms = 850; ms < 2300; ms += 50) {
        a.observeAudio(
          ms,
          ms + 50,
          ms >= 1300 && ms < 1450 ? activity : "quiet",
        );
      }
      a.settleThrough(2400);
      expect(states(a)[0]).toBe("unknown");
    },
  );

  it("does not fabricate quiet coverage by replaying duplicate samples or after a capture gap", () => {
    const a = new LiveSingingAttempt(song());
    for (let i = 0; i < 100; i++) a.observeAudio(1000, 1050, "quiet");
    a.settleThrough(5000);
    expect(a.result().evaluatedWords).toBe(0);
    const b = new LiveSingingAttempt(song());
    b.observeAudio(850, 2300, "quiet");
    b.settleThrough(5000);
    expect(b.result().evaluatedWords).toBe(0);
  });

  it("revises an open capture with fuller evidence, rejects duplicate revisions and locks on close", () => {
    const a = new LiveSingingAttempt(song());
    a.beginCapture("first");
    a.acceptCapture("first", 1, "bé nói vui", 1000, 4000, 1000);
    expect(states(a)).toEqual(["matched", "different", "matched"]);
    a.acceptCapture("first", 2, "bé hát vui", 1000, 4000, 1000);
    expect(states(a)).toEqual(["matched", "matched", "matched"]);
    expect(a.acceptCapture("first", 1, "bé nói vui", 1000, 4000, 1000)).toBe(
      false,
    );
    a.closeCapture();
    expect(a.acceptCapture("first", 3, "bé nói vui", 1000, 4000, 1000)).toBe(
      false,
    );
    expect(states(a)).toEqual(["matched", "matched", "matched"]);
  });

  it("does not lose prior evidence when an invalid or stale capture tries to revise it", () => {
    const a = new LiveSingingAttempt(song());
    a.beginCapture("one");
    a.acceptCapture("one", 1, "bé", 1000, 2000, 1000);
    a.beginCapture("two");
    a.acceptCapture("one", 2, "mèo", 1000, 2000, 1000);
    a.acceptCapture("two", 1, "hát vui", NaN, 4000, 2000);
    expect(states(a)).toEqual(["matched", "unknown", "unknown"]);
    a.acceptCapture("two", 2, "hát vui", 2000, 4000, 2000);
    expect(states(a)).toEqual(["matched", "matched", "matched"]);
  });

  it("recognizes the unambiguous digit formatting emitted by ASR for a counting song", () => {
    const a = new LiveSingingAttempt(song("một hai ba"));
    a.accept("1 2 3", 1000, 4000);
    expect(states(a)).toEqual(["matched", "matched", "matched"]);
  });

  it("does not split merged numbers or decimals into the expected counting lyrics", () => {
    for (const text of ["12", "1.2", "1,2", "-1 +2"]) {
      const a = new LiveSingingAttempt(song("một hai ba"));
      a.accept(text, 1000, 4000);
      expect(a.result().matchedWords).toBe(0);
    }
  });
});
