import { activeLyricIndex } from "@/lib/karaoke/lyrics-timeline";
import type { KaraokeLine } from "@/types/karaoke";

export function LyricsDisplay({
  lines,
  currentMs,
  ended = false,
}: {
  lines: KaraokeLine[];
  currentMs: number;
  ended?: boolean;
}) {
  const active = activeLyricIndex(lines, currentMs);
  const next = lines.find((l) => l.start_ms !== null && l.start_ms > currentMs);
  return (
    <div
      className="rounded-control bg-sky p-6 text-center"
      aria-label="Lời bài hát"
    >
      {active >= 0 && !ended && (
        <p className="mb-3 text-sm font-bold text-primary-hover">
          Câu đang hát
        </p>
      )}
      <p
        className="break-words text-2xl font-extrabold text-primary-hover"
        data-testid="karaoke-active-line"
      >
        {ended
          ? "Đã hết bài hát · Bé có thể bấm Hát lại"
          : active >= 0
            ? lines[active].text
            : next
              ? "Đoạn nhạc · Chờ câu tiếp theo"
              : lines.length
                ? "Đoạn nhạc · Cùng nghe nhạc nhé"
                : "Chưa có câu hát tại vị trí này"}
      </p>
      {next && (
        <p className="mt-3 break-words text-muted">Tiếp theo: {next.text}</p>
      )}
    </div>
  );
}
