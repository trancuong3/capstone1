import { Button } from "@/components/common/button";
import type { KaraokePlayerController } from "@/hooks/use-karaoke-player";
import { formatKaraokeTime } from "@/lib/karaoke/lyrics-timeline";

export function KaraokeControls({
  player,
  durationMs,
}: {
  player: KaraokePlayerController;
  durationMs: number;
}) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-3">
        <Button
          className="w-full min-[640px]:w-auto"
          disabled={!player.ready}
          onClick={() => (player.playing ? player.pause() : void player.play())}
        >
          {player.playing
            ? "Tạm dừng"
            : player.currentMs >= durationMs
              ? "Hát lại"
              : "Phát"}
        </Button>
        <Button
          className="w-full min-[640px]:w-auto"
          variant="secondary"
          disabled={!player.ready}
          onClick={() => {
            player.pause();
            player.seek(0);
          }}
        >
          Về đầu
        </Button>
        <span className="self-center tabular-nums">
          {formatKaraokeTime(player.currentMs)} /{" "}
          {formatKaraokeTime(durationMs)}
        </span>
      </div>
      <label className="grid gap-2 font-bold">
        Vị trí phát
        <input
          aria-label="Vị trí phát"
          type="range"
          min={0}
          max={durationMs}
          step={1}
          value={player.currentMs}
          disabled={!player.ready}
          onChange={(e) => player.seek(Number(e.target.value))}
          className="min-h-11 w-full accent-primary"
        />
      </label>
      <label className="grid gap-2 font-bold min-[640px]:max-w-xs">
        Âm lượng
        <input
          aria-label="Âm lượng"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={player.volume}
          onChange={(e) => player.setVolume(Number(e.target.value))}
          className="min-h-11 w-full accent-primary"
        />
      </label>
      <p role="status" className="text-sm text-muted">
        {player.waiting
          ? "Đang tải nhạc…"
          : !player.ready && !player.error
            ? "Đang đọc thông tin âm thanh…"
            : "Âm thanh chỉ phát khi bạn bấm nút. Không thu âm."}
      </p>
    </div>
  );
}
