"use client";

import { useState, type ReactNode } from "react";
import Image from "next/image";
import { Music2 } from "lucide-react";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";
import {
  useKaraokePlayer,
  type KaraokePlayerController,
} from "@/hooks/use-karaoke-player";
import { KaraokeControls } from "@/components/karaoke/karaoke-controls";
import { LyricsDisplay } from "@/components/karaoke/lyrics-display";
import type { KaraokeLyrics, KaraokePreview } from "@/types/karaoke";
import { KaraokeStage } from "@/components/karaoke/karaoke-stage";

type AudioSource = Omit<KaraokePreview, "revision"> & { revision?: number };

export function KaraokePlayer(props: {
  source: AudioSource;
  label?: string;
  lyrics?: KaraokeLyrics;
  onPlayed?: () => void;
  children?: (player: KaraokePlayerController) => ReactNode;
  presentation?: "preview" | "child";
  childAlias?: string;
  onReload?: () => void;
  autoPlay?: boolean;
  autoScored?: boolean;
}) {
  // Remount resets pending play promises, clocks and errors even when a signed URL is renewed.
  return (
    <PlayerSession
      key={`${props.source.version_id}:${props.source.revision}:${props.source.audio_url}`}
      {...props}
    />
  );
}
function PlayerSession({
  source,
  lyrics = source.lyrics,
  children,
  onPlayed,
  label,
  presentation = "preview",
  childAlias,
  onReload,
  autoPlay = false,
  autoScored = false,
}: {
  source: AudioSource;
  label?: string;
  lyrics?: KaraokeLyrics;
  onPlayed?: () => void;
  children?: (player: KaraokePlayerController) => ReactNode;
  presentation?: "preview" | "child";
  childAlias?: string;
  onReload?: () => void;
  autoPlay?: boolean;
  autoScored?: boolean;
}) {
  const t = useTranslations("entertainment");
  const resolvedLabel = label ?? t("karaoke.playerScreen.previewLabel");
  const resolvedAlias =
    childAlias ?? t("karaoke.playerScreen.defaultChildAlias");
  const [coverFailed, setCoverFailed] = useState(false);
  const player = useKaraokePlayer(
    source.audio_url,
    source.duration_ms,
    source.audio_url_expires_at,
    onPlayed,
  );
  if (presentation === "child")
    return (
      <KaraokeStage
        source={{ ...source, lyrics }}
        player={player}
        childAlias={resolvedAlias}
        label={resolvedLabel}
        onReload={onReload}
        autoPlay={autoPlay}
        autoScored={autoScored}
      />
    );
  return (
    <section aria-label={resolvedLabel} className="grid gap-5">
      {source.cover_url && !coverFailed ? (
        <Image
          src={source.cover_url}
          alt={t("karaoke.library.coverAlt", { title: source.title })}
          width={200}
          height={200}
          unoptimized
          onError={() => setCoverFailed(true)}
          className="size-32 rounded-control object-cover"
        />
      ) : (
        <div
          className="grid size-24 place-items-center rounded-control bg-sky"
          aria-label={t("karaoke.playerScreen.noCoverAria")}
        >
          <Music2 aria-hidden className="size-10 text-primary" />
        </div>
      )}
      <LyricsDisplay
        currentMs={player.currentMs}
        lines={lyrics.lines}
        ended={player.currentMs >= source.duration_ms && !player.playing}
      />
      {player.error && (
        <StatusMessage tone="error">{player.error}</StatusMessage>
      )}
      <KaraokeControls durationMs={source.duration_ms} player={player} />
      {children?.(player)}
    </section>
  );
}
