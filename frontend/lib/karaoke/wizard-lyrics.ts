import { importLyrics } from "@/lib/karaoke/lyrics-import";
import {
  canonicalLyricText,
  upgradeLyrics,
} from "@/lib/karaoke/syllable-timing";
import type { KaraokeLyrics } from "@/types/karaoke";

/** A proposal only: the caller must get explicit consent before applying it. */
export function suggestRepeatedLyrics(text: string): {
  text: string;
  markedLines: number;
  error: string | null;
} | null {
  let markedLines = 0;
  const expanded = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => {
      // Only a suffix on the same line is unambiguous. A standalone x2 may
      // mean an entire chorus, so leave it for the admin to expand manually.
      const match =
        /^(.*?)\s+(?:[x×]\s*([2-9])|\([x×]\s*([2-9])\)|\[[x×]\s*([2-9])\])\s*$/iu.exec(
          line,
        );
      if (!match || !match[1].trim()) return [line];
      markedLines++;
      return Array<string>(Number(match[2] ?? match[3] ?? match[4])).fill(
        match[1].trimEnd(),
      );
    });
  if (!markedLines) return null;
  const lines = expanded.map(canonicalLyricText).filter(Boolean);
  const tooLong =
    lines.length > 300 ||
    expanded.join("\n").length > 50000 ||
    lines.some((line) => line.length > 300 || line.split(" ").length > 150) ||
    lines.reduce((total, line) => total + line.split(" ").length, 0) > 10000;
  return {
    text: expanded.join("\n"),
    markedLines,
    error: tooLong
      ? "Mở rộng sẽ vượt giới hạn lời. Hãy chia bớt câu hoặc giảm số lần lặp."
      : null,
  };
}

/** Ordered LCS keeps IDs/timing of unchanged lines, including repeated choruses. */
export function prepareWizardLyrics(
  text: string,
  previous: KaraokeLyrics,
  duration: number | null,
): KaraokeLyrics {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(canonicalLyricText)
    .filter(Boolean)
    .join("\n");
  if (!normalized) return { format_version: 2, lines: [] };
  const imported = upgradeLyrics(
    importLyrics(normalized, "txt", duration).lyrics,
  );
  const old = upgradeLyrics(previous).lines;
  const next = imported.lines;
  const lengths = Array.from(
    { length: old.length + 1 },
    () => new Uint16Array(next.length + 1),
  );
  for (let i = old.length - 1; i >= 0; i--)
    for (let j = next.length - 1; j >= 0; j--)
      lengths[i][j] =
        canonicalLyricText(old[i].text) === next[j].text
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  let i = 0,
    j = 0;
  while (i < old.length && j < next.length) {
    if (canonicalLyricText(old[i].text) === next[j].text) {
      next[j] = { ...old[i], text: next[j].text };
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  return imported;
}
