"use client";

import Image from "next/image";
import { Music2 } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/common/card";
import { ButtonLink } from "@/components/common/button";
import type { KaraokeSongCard } from "@/lib/api/karaoke-service";
import { formatKaraokeTime } from "@/lib/karaoke/lyrics-timeline";

export function SongCard({ song }: { song: KaraokeSongCard }) {
  const [coverFailed, setCoverFailed] = useState(false);
  return (
    <Card className="song-cover h-full gap-3 p-4 md:gap-4 md:p-6">
      {song.cover_url && !coverFailed ? (
        <Image
          src={song.cover_url}
          alt={`Ảnh bìa ${song.title}`}
          width={320}
          height={200}
          unoptimized
          onError={() => setCoverFailed(true)}
          className="h-28 w-full rounded-control object-cover md:h-40"
        />
      ) : (
        <div className="grid h-28 place-items-center rounded-control bg-sky md:h-40">
          <Music2 className="size-12 text-primary md:size-16" aria-hidden />
        </div>
      )}
      <h2 className="break-words text-lg font-extrabold md:text-2xl">
        {song.title}
      </h2>
      {song.author && (
        <details className="min-w-0 text-sm text-muted">
          <summary className="min-h-11 cursor-pointer content-center">
            Thông tin bài hát
          </summary>
          <p className="mt-2 break-words">{song.author}</p>
        </details>
      )}
      <p className="text-sm text-muted">
        Lớp {song.min_grade}–{song.max_grade} ·{" "}
        {formatKaraokeTime(song.duration_ms)}
      </p>
      <ButtonLink
        className="mt-auto min-h-12 break-words"
        style={{ height: "auto" }}
        href={`/karaoke/${song.song_id}?version=${song.version_id}`}
      >
        Hát bài {song.title}
      </ButtonLink>
    </Card>
  );
}
