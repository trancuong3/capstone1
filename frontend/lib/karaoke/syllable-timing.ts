import type {
  KaraokeLine,
  KaraokeLyrics,
  KaraokeSyllable,
} from "@/types/karaoke";

export function canonicalLyricText(value: string) {
  return value
    .normalize("NFC")
    .replace(/\p{White_Space}+/gu, " ")
    .replace(/^ +| +$/g, "");
}

export function splitSyllables(text: string): KaraokeSyllable[] {
  const normalized = canonicalLyricText(text);
  return normalized
    ? normalized.split(" ").map((text) => ({
        id: crypto.randomUUID(),
        text,
        start_ms: null,
        end_ms: null,
      }))
    : [];
}

export function upgradeLyrics(lyrics: KaraokeLyrics): KaraokeLyrics {
  return {
    format_version: 2,
    lines: lyrics.lines.map((line) => ({
      ...line,
      syllables: line.syllables ?? splitSyllables(line.text),
    })),
  };
}

export type SyllableIssue = {
  lineId: string;
  syllableId?: string;
  message: string;
};

export function syllableIssues(
  lines: KaraokeLine[],
  duration: number | null,
): SyllableIssue[] {
  const issues: SyllableIssue[] = [];
  for (const line of lines) {
    const add = (message: string, syllableId?: string) =>
      issues.push({ lineId: line.id, syllableId, message });
    if (line.start_ms === null || line.end_ms === null)
      add("Cần căn đủ mốc đầu/cuối câu.");
    else if (
      !Number.isInteger(line.start_ms) ||
      !Number.isInteger(line.end_ms) ||
      line.start_ms < 0 ||
      line.start_ms >= line.end_ms ||
      (duration !== null && line.end_ms > duration)
    )
      add("Mốc câu chưa hợp lệ hoặc vượt thời lượng nhạc.");
    if (!line.syllables?.length) {
      add("Chưa tách tiếng cho câu.");
      continue;
    }
    if (
      canonicalLyricText(line.syllables.map((s) => s.text).join(" ")) !==
      canonicalLyricText(line.text)
    )
      add("Nội dung tiếng chưa khớp lời câu.");
    let end = line.start_ms ?? 0;
    for (const syllable of line.syllables) {
      const a = syllable.start_ms,
        b = syllable.end_ms;
      if (a === null || b === null) {
        add("Tiếng chưa đủ mốc đầu/cuối.", syllable.id);
        continue;
      }
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a >= b)
        add("Mốc đầu/cuối tiếng chưa hợp lệ.", syllable.id);
      if (a < end) add("Tiếng chồng lấn hoặc sai thứ tự.", syllable.id);
      if (
        (line.start_ms !== null && a < line.start_ms) ||
        (line.end_ms !== null && b > line.end_ms) ||
        (duration !== null && b > duration)
      )
        add("Tiếng vượt khoảng câu hoặc thời lượng nhạc.", syllable.id);
      end = b;
    }
  }
  return issues;
}

export function syllableProgress(unit: KaraokeSyllable, timeMs: number) {
  if (
    unit.start_ms === null ||
    unit.end_ms === null ||
    unit.end_ms <= unit.start_ms
  )
    return 0;
  return Math.max(
    0,
    Math.min(1, (timeMs - unit.start_ms) / (unit.end_ms - unit.start_ms)),
  );
}

/** Return a new line; callers keep one undo snapshot per user action. */
export function markSyllable(
  line: KaraokeLine,
  index: number,
  edge: "start_ms" | "end_ms",
  at: number,
  closePrevious = false,
): KaraokeLine {
  const syllables = line.syllables?.map((s) => ({ ...s }));
  if (!syllables?.[index]) return line;
  syllables[index][edge] = Math.round(at);
  if (
    closePrevious &&
    index > 0 &&
    edge === "start_ms" &&
    syllables[index - 1].end_ms === null
  )
    syllables[index - 1].end_ms = Math.round(at);
  return { ...line, syllables };
}

export function copySyllableTiming(
  source: KaraokeLine,
  target: KaraokeLine,
): KaraokeLine | null {
  if (
    source.start_ms === null ||
    target.start_ms === null ||
    !source.syllables?.length ||
    canonicalLyricText(source.text) !== canonicalLyricText(target.text)
  )
    return null;
  const offset = target.start_ms - source.start_ms;
  return {
    ...target,
    syllables: source.syllables.map((s) => ({
      ...s,
      id: crypto.randomUUID(),
      start_ms: s.start_ms === null ? null : s.start_ms + offset,
      end_ms: s.end_ms === null ? null : s.end_ms + offset,
    })),
  };
}
