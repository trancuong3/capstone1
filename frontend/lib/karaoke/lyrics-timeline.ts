import type { KaraokeLine } from "@/types/karaoke";

/** Half-open intervals. Gaps and the exact final end never highlight a line. */
export function activeLyricIndex(lines: KaraokeLine[], timeMs: number) {
  return lines.findIndex(
    (line) =>
      line.start_ms !== null &&
      line.end_ms !== null &&
      line.start_ms <= timeMs &&
      timeMs < line.end_ms,
  );
}
export function timingIssues(lines: KaraokeLine[], duration: number | null) {
  const issues: string[] = [];
  let previousEnd = 0;
  lines.forEach((line, i) => {
    const prefix = `Dòng ${i + 1}`;
    if (line.start_ms === null || line.end_ms === null) {
      issues.push(`${prefix}: chưa đủ mốc thời gian.`);
      return;
    }
    if (
      !Number.isInteger(line.start_ms) ||
      !Number.isInteger(line.end_ms) ||
      line.start_ms < 0 ||
      line.start_ms >= line.end_ms
    )
      issues.push(`${prefix}: cần 0 ≤ bắt đầu < kết thúc.`);
    if (line.start_ms < previousEnd)
      issues.push(`${prefix}: thời gian chồng lấn hoặc sai thứ tự.`);
    if (duration !== null && line.end_ms > duration)
      issues.push(`${prefix}: vượt thời lượng nhạc.`);
    previousEnd = line.end_ms;
  });
  return issues;
}
export function formatKaraokeTime(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function formatLyricTimestamp(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return "Chưa đặt";
  const value = Math.max(0, Math.floor(ms));
  return `${String(Math.floor(value / 60000)).padStart(2, "0")}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")}.${String(value % 1000).padStart(3, "0")}`;
}
