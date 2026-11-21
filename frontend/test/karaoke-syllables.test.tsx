import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LyricTimingEditor } from "@/components/admin/karaoke/lyric-timing-editor";
import {
  SyllableTimingEditor,
  type TimingControls,
} from "@/components/admin/karaoke/syllable-timing-editor";
import { SyllableLyrics } from "@/components/karaoke/syllable-lyrics";
import { LiveSingingAttempt } from "@/lib/karaoke/live-singing-score";
import {
  canonicalLyricText,
  copySyllableTiming,
  markSyllable,
  splitSyllables,
  syllableIssues,
  syllableProgress,
  upgradeLyrics,
} from "@/lib/karaoke/syllable-timing";
import { importLyrics } from "@/lib/karaoke/lyrics-import";
import {
  lyricsSchema,
  type KaraokeLine,
  type KaraokeLyrics,
} from "@/types/karaoke";
import { songDetail, syllableLyrics } from "@/test/karaoke-fixtures";

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  // jsdom has no layout/scroll implementation; browser tests check actual focus.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => vi.restoreAllMocks());

describe("syllable data and timeline", () => {
  it("roundtrips v2 JSON and preserves v1 without inventing times", () => {
    const data = syllableLyrics();
    expect(importLyrics(JSON.stringify(data), "json", 20000).lyrics).toEqual(
      data,
    );
    const v1 = songDetail().draft!.lyrics;
    expect(importLyrics(JSON.stringify(v1), "json", 20000).lyrics).toEqual(v1);
    const upgraded = upgradeLyrics(v1);
    expect(upgraded.format_version).toBe(2);
    expect(upgraded.lines[0].syllables?.map((s) => s.text)).toEqual([
      "Em",
      "vui",
      "đến",
      "trường",
    ]);
    expect(
      upgraded.lines[0].syllables?.every(
        (s) => s.start_ms === null && s.end_ms === null,
      ),
    ).toBe(true);
    expect(v1.lines[0].syllables).toBeUndefined();
  });
  it("imports nested JSON above the old 256 KiB cap and rejects oversized JSON", () => {
    const data: KaraokeLyrics = {
      format_version: 2,
      lines: Array.from({ length: 150 }, () => ({
        id: crypto.randomUUID(),
        text: Array.from({ length: 20 }, () => "Bé").join(" "),
        start_ms: null,
        end_ms: null,
        syllables: splitSyllables(
          Array.from({ length: 20 }, () => "Bé").join(" "),
        ),
      })),
    };
    const encoded = JSON.stringify(data);
    expect(new TextEncoder().encode(encoded).length).toBeGreaterThan(
      256 * 1024,
    );
    expect(importLyrics(encoded, "json", null).lyrics).toEqual(data);
    expect(() =>
      importLyrics("x".repeat(2 * 1024 * 1024 + 1), "json", null),
    ).toThrow(/2 MiB/);
  });
  it("keeps NFC, punctuation and grouped units while enforcing format/IDs", () => {
    expect(
      splitSyllables("Be\u0301  hát,\u00a0vui!").map((s) => s.text),
    ).toEqual(["Bé", "hát,", "vui!"]);
    expect(canonicalLyricText(" Bé  hát, vui! ")).toBe("Bé hát, vui!");
    for (const data of [
      { ...syllableLyrics(), format_version: 1 },
      { ...songDetail().draft!.lyrics, format_version: 2 },
      { ...syllableLyrics(), format_version: "2" },
    ])
      expect(lyricsSchema.safeParse(data).success).toBe(false);
    const data = syllableLyrics();
    data.lines[0].syllables![0].id = data.lines[0].id;
    expect(lyricsSchema.safeParse(data).success).toBe(false);
  });
  it("allows gaps and long notes, identifies exact nested errors", () => {
    const line = syllableLyrics().lines[0];
    expect(syllableIssues([line], 4000)).toEqual([]);
    const units = line.syllables!;
    expect(syllableProgress(units[0], 1000)).toBe(0);
    expect(syllableProgress(units[0], 1250)).toBe(0.5);
    expect(syllableProgress(units[0], 1600)).toBe(1);
    expect(syllableProgress(units[1], 1600)).toBe(0);
    expect(syllableProgress(units[2], 3300)).toBe(0.5);
    const changed = {
      ...line,
      syllables: units.map((s, i) => (i === 1 ? { ...s, start_ms: 1400 } : s)),
    };
    expect(syllableIssues([changed], 4000)).toContainEqual(
      expect.objectContaining({
        syllableId: units[1].id,
        message: expect.stringContaining("chồng lấn"),
      }),
    );
    expect(
      syllableIssues([{ ...line, text: "Khác lời" }], 4000)[0].message,
    ).toContain("khớp");
    expect(
      syllableIssues([{ ...line, end_ms: 3900 }], 4000).at(-1)?.message,
    ).toContain("vượt");
  });
  it("marks without mutating and copies shifted repeat timing with new IDs", () => {
    const line = syllableLyrics().lines[0];
    const cleared = {
      ...line,
      syllables: line.syllables!.map((s) => ({
        ...s,
        start_ms: null,
        end_ms: null,
      })),
    };
    const first = markSyllable(cleared, 0, "start_ms", 1000, true);
    const second = markSyllable(first, 1, "start_ms", 1800, true);
    expect(second.syllables![0].end_ms).toBe(1800);
    expect(first.syllables![0].end_ms).toBeNull();
    const target = {
      ...line,
      id: crypto.randomUUID(),
      start_ms: 6000,
      end_ms: 9000,
    };
    const copy = copySyllableTiming(line, target)!;
    expect(copy.syllables![0].start_ms).toBe(6000);
    expect(copy.syllables![2].end_ms).toBe(9000);
    expect(copy.syllables![0].id).not.toBe(line.syllables![0].id);
    expect(syllableIssues([copy], 9000)).toEqual([]);
  });
  it("renders per-unit fill, gap, sustained note, rewind and plain text", () => {
    const line = syllableLyrics().lines[0];
    const { container, rerender } = render(
      <SyllableLyrics line={line} currentMs={1250} />,
    );
    expect(container.querySelector("[data-state=active]")).toHaveStyle({
      "--karaoke-fill": "50%",
    });
    rerender(<SyllableLyrics line={line} currentMs={1600} />);
    expect(container.querySelector("[data-state=active]")).toBeNull();
    rerender(<SyllableLyrics line={line} currentMs={3300} />);
    expect(container.querySelector("[data-state=active]")).toHaveStyle({
      "--karaoke-fill": "50%",
    });
    rerender(<SyllableLyrics line={line} currentMs={1000} />);
    expect(container.querySelectorAll("[data-state=past]")).toHaveLength(0);
    rerender(
      <SyllableLyrics
        line={{
          ...line,
          syllables: [{ ...line.syllables![0], text: "<b>bé</b>" }],
        }}
        currentMs={1250}
      />,
    );
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("scored lyric occurrence rendering", () => {
  it("keeps compound number occurrence IDs identical to scoring", () => {
    const song = syllableLyrics();
    song.lines[0].text = "1.2 hát vui";
    song.lines[0].syllables![0].text = "1.2";
    const attempt = new LiveSingingAttempt(song);
    attempt.accept("1.2 hát vui", 1000, 4000);
    const { container } = render(
      <SyllableLyrics
        line={song.lines[0]}
        currentMs={4000}
        evidence={attempt.result().lineScores[0]}
      />,
    );
    const marked = container.querySelectorAll("[data-heard]");
    expect(marked).toHaveLength(3);
    expect(marked[0]).toHaveTextContent("1.2 (đã nghe khớp)");
  });
});

describe("admin syllable timing", () => {
  let time = 1000;
  const changed = vi.fn();
  function Harness({
    initial = syllableLyrics().lines[0],
  }: {
    initial?: KaraokeLine;
  }) {
    const [line, setLine] = useState(initial);
    const player: TimingControls = {
      ready: true,
      getCurrentMs: () => time,
      play: vi.fn(async () => {}),
      pause: vi.fn(),
    };
    return (
      <SyllableTimingEditor
        line={line}
        lineNumber={1}
        lines={[line]}
        duration={20000}
        disabled={false}
        player={player}
        onChange={(next) => {
          changed(next);
          setLine(next);
        }}
      />
    );
  }
  beforeEach(() => {
    time = 1000;
    changed.mockClear();
  });
  it("captures next units, explicit ends, undo selection and nudges", () => {
    const line = syllableLyrics().lines[0];
    render(
      <Harness
        initial={{
          ...line,
          syllables: line.syllables!.map((s) => ({
            ...s,
            start_ms: null,
            end_ms: null,
          })),
        }}
      />,
    );
    const region = screen.getByRole("region", { name: "Căn tiếng dòng 1" });
    fireEvent.keyDown(region, { code: "Space" });
    expect(screen.getByLabelText("Nội dung tiếng đang chọn")).toHaveValue(
      "hát,",
    );
    time = 1800;
    fireEvent.click(
      screen.getByRole("button", { name: "Đánh dấu tiếng tiếp theo" }),
    );
    expect(changed.mock.lastCall![0].syllables[0].end_ms).toBe(1800);
    fireEvent.click(screen.getByRole("button", { name: "Hoàn tác căn tiếng" }));
    expect(screen.getByLabelText("Nội dung tiếng đang chọn")).toHaveValue(
      "hát,",
    );
    expect(changed.mock.lastCall![0].syllables[1].start_ms).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Đánh dấu tiếng tiếp theo" }),
    );
    time = 2600;
    fireEvent.click(
      screen.getByRole("button", { name: "Đánh dấu tiếng tiếp theo" }),
    );
    time = 4000;
    fireEvent.keyDown(region, { key: "e" });
    expect(changed.mock.lastCall![0].syllables[2].end_ms).toBe(4000);
    fireEvent.click(
      screen.getByRole("button", { name: "Bắt đầu tiếng +50 ms" }),
    );
    expect(changed.mock.lastCall![0].syllables[2].start_ms).toBe(2650);
  });
  it("never intercepts typing shortcuts and resets a changed unit timing", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Nội dung tiếng đang chọn");
    fireEvent.keyDown(input, { code: "Space" });
    fireEvent.keyDown(input, { key: "e" });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Bé mới" } });
    expect(changed.mock.lastCall![0].syllables[0]).toMatchObject({
      text: "Bé mới",
      start_ms: null,
      end_ms: null,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Tách cụm thành tiếng" }),
    );
    expect(
      changed.mock.lastCall![0].syllables.map((s: { text: string }) => s.text),
    ).toEqual(["Bé", "mới", "hát,", "vui!"]);
  });
  it("does not report a line valid when syllables exist but line boundaries are missing", () => {
    render(
      <Harness initial={{ ...syllableLyrics().lines[0], start_ms: null }} />,
    );
    expect(
      screen.getByText("3/3 tiếng đã căn · Cần kiểm tra", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Cần căn đủ mốc đầu/cuối câu.", { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Nghe câu từ đầu" }),
    ).toBeDisabled();
  });
  it("routes errors to another page and clears timings after line text changes", () => {
    const initial: KaraokeLyrics = {
      format_version: 2,
      lines: Array.from({ length: 30 }, (_, i) => ({
        ...syllableLyrics().lines[0],
        id: crypto.randomUUID(),
        text: `Câu ${i}`,
        syllables: [],
      })),
    };
    function Editor() {
      const [value, setValue] = useState(initial);
      return (
        <LyricTimingEditor
          lyrics={value}
          duration={20000}
          disabled={false}
          onChange={(next) => {
            changed(next);
            setValue(next);
          }}
          focusTarget={{ lineId: initial.lines[29].id, request: 1 }}
        />
      );
    }
    render(<Editor />);
    expect(screen.getByLabelText("Lời dòng 30")).toHaveValue("Câu 29");
    expect(
      screen.getByRole("region", { name: "Căn tiếng dòng 30" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Lời dòng 30"), {
      target: { value: "Bé vui" },
    });
    expect(
      changed.mock.lastCall![0].lines[29].syllables.map(
        (s: { text: string }) => s.text,
      ),
    ).toEqual(["Bé", "vui"]);
    expect(
      within(
        screen.getByRole("region", { name: "Căn tiếng dòng 30" }),
      ).getByText(/0\/2 tiếng/),
    ).toBeInTheDocument();
  });
});
