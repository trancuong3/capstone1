"use client";

import { Button } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import type { KaraokePlayerController } from "@/hooks/use-karaoke-player";
import { formatKaraokeTime } from "@/lib/karaoke/lyrics-timeline";

export function KaraokeControls({
  player,
  durationMs,
}: {
  player: KaraokePlayerController;
  durationMs: number;
}) {
  const t = useTranslations("entertainment");

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-3">
        <Button
          className="sm:w-auto"
          disabled={!player.ready}
          onClick={() => (player.playing ? player.pause() : void player.play())}
        >
          {player.playing
            ? t("karaoke.controls.pause")
            : player.currentMs >= durationMs
              ? t("karaoke.controls.replay")
              : t("karaoke.controls.play")}
        </Button>
        <Button
          className="sm:w-auto"
          variant="secondary"
          disabled={!player.ready}
          onClick={() => {
            player.pause();
            player.seek(0);
          }}
        >
          {t("karaoke.controls.restart")}
        </Button>
        <span className="self-center tabular-nums">
          {formatKaraokeTime(player.currentMs)} /{" "}
          {formatKaraokeTime(durationMs)}
        </span>
      </div>
      <label className="grid gap-2 font-bold">
        {t("karaoke.controls.positionLabel")}
        <input
          aria-label={t("karaoke.controls.positionLabel")}
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
      <label className="grid gap-2 font-bold sm:max-w-xs">
        {t("karaoke.controls.volumeLabel")}
        <input
          aria-label={t("karaoke.controls.volumeLabel")}
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
          ? t("karaoke.controls.loadingAudio")
          : !player.ready && !player.error
            ? t("karaoke.controls.readingAudioMeta")
            : t("karaoke.controls.noRecordHint")}
      </p>
    </div>
  );
}
