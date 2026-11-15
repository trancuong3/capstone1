import {
  lyricsSchema,
  type KaraokeLyrics,
  type KaraokeLine,
} from "@/types/karaoke";

export const MAX_LYRICS_BYTES = 256 * 1024;
const clean = (s: string) =>
  s
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC");
const line = (text: string, start_ms: number | null = null): KaraokeLine => ({
  id: crypto.randomUUID(),
  text: text.trim(),
  start_ms,
  end_ms: null,
});

/** No HTML parsing, guessed TXT timings, or per-word LRC interpolation. */
export function importLyrics(
  input: string,
  format: "txt" | "lrc" | "json",
  duration: number | null,
): { lyrics: KaraokeLyrics; suggestedEnds: boolean } {
  if (new TextEncoder().encode(input).byteLength > MAX_LYRICS_BYTES)
    throw new Error("File lời không được quá 256 KiB.");
  const text = clean(input);
  let lines: KaraokeLine[];
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("JSON không hợp lệ.");
    }
    const result = lyricsSchema.strict().safeParse(parsed);
    if (!result.success)
      throw new Error(
        "JSON cần format_version: 1 và danh sách lines hợp lệ, ID UUID không trùng, thời gian nguyên hoặc null.",
      );
    lines = result.data.lines.map((item) => ({
      ...item,
      text: clean(item.text).trim(),
    }));
  } else if (format === "txt") {
    lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => line(s));
  } else {
    const entries = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    let offset = 0;
    for (const entry of entries) {
      const match = /^\[offset:([+-]?\d+)\]$/i.exec(entry);
      if (match) offset = Number(match[1]);
    }
    lines = [];
    for (const entry of entries) {
      if (
        /^\[(ar|al|ti|au|by|re|ve|length):[^\]]*\]$/i.test(entry) ||
        /^\[offset:[+-]?\d+\]$/i.test(entry)
      )
        continue;
      if (/<\d+:\d+/.test(entry))
        throw new Error("Chưa hỗ trợ LRC căn thời gian từng từ.");
      const stamps = [
        ...entry.matchAll(/\[(\d{1,3}):([0-5]\d)(?:\.(\d{2,3}))?\]/g),
      ];
      const lyric = entry
        .replace(/^(?:\[\d{1,3}:[0-5]\d(?:\.\d{2,3})?\])+/, "")
        .trim();
      if (
        !stamps.length ||
        !lyric ||
        lyric.includes("[") ||
        lyric.includes("]")
      )
        throw new Error("LRC cần [phút:giây.xx] rồi đến lời trên mỗi dòng.");
      for (const stamp of stamps) {
        const ms =
          Number(stamp[1]) * 60000 +
          Number(stamp[2]) * 1000 +
          Number((stamp[3] ?? "0").padEnd(3, "0")) +
          offset;
        if (!Number.isSafeInteger(ms) || ms < 0 || ms > 300000)
          throw new Error("Mốc LRC sau offset phải nằm trong 0–300.000 ms.");
        lines.push(line(lyric, ms));
      }
    }
    lines.sort((a, b) => a.start_ms! - b.start_ms!);
    if (new Set(lines.map((l) => l.start_ms)).size !== lines.length)
      throw new Error("LRC có mốc bắt đầu trùng; hãy sửa trước khi nhập.");
    lines = lines.map((item, i) => ({
      ...item,
      end_ms: lines[i + 1]?.start_ms ?? duration,
    }));
  }
  if (lines.some((l) => /\p{Cc}/u.test(l.text)))
    throw new Error("Lời chứa ký tự điều khiển không hợp lệ.");
  const result = lyricsSchema.safeParse({ format_version: 1, lines });
  if (!result.success || !lines.length)
    throw new Error(
      "Cần 1–300 dòng, tối đa 300 ký tự mỗi dòng và 50.000 ký tự tổng cộng.",
    );
  return { lyrics: result.data, suggestedEnds: format === "lrc" };
}
