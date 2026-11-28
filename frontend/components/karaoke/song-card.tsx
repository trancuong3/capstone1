"use client";

import Image from "next/image";
import { Music2, Play } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/common/card";
import { ButtonLink } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import type { KaraokeSongCard } from "@/lib/api/karaoke-service";
import { formatKaraokeTime } from "@/lib/karaoke/lyrics-timeline";

export function SongCard({ song }: { song: KaraokeSongCard }) {
  const t = useTranslations("entertainment");
  const [coverFailed, setCoverFailed] = useState(false);
  const matchedWords = (song.matched_difficult_words ?? [])
    .map((word) => word.trim())
    .filter(Boolean);
  return (
    <Card className="song-cover h-full">
      {song.cover_url && !coverFailed ? (
        <Image
          src={song.cover_url}
          alt={t("karaoke.library.coverAlt", { title: song.title })}
          width={320}
          height={200}
          unoptimized
          onError={() => setCoverFailed(true)}
          className="h-40 w-full rounded-control object-cover"
        />
      ) : (
        <div className="grid h-40 place-items-center rounded-control bg-sky">
          <Music2 className="size-16 text-primary" aria-hidden />
        </div>
      )}
      <h2
        className="viread-learning-content break-words text-2xl font-extrabold"
        dir="ltr"
        lang="vi"
      >
        {song.title}
      </h2>
      {song.author && (
        <details className="min-w-0 text-sm text-muted">
          <summary className="min-h-11 cursor-pointer content-center">
            {t("karaoke.library.songInfo")}
          </summary>
          <p
            className="viread-learning-content mt-2 break-words"
            dir="ltr"
            lang="vi"
          >
            {song.author}
          </p>
        </details>
      )}
      <p className="text-sm text-muted">
        {t("karaoke.library.gradeRange", {
          min: song.min_grade,
          max: song.max_grade,
        })}{" "}
        · {formatKaraokeTime(song.duration_ms)}
      </p>
      {matchedWords.length > 0 && (
        <div
          data-testid="karaoke-song-difficult-words"
          className="flex flex-wrap items-center gap-1.5 rounded-control border border-amber-300 bg-amber-50/90 px-3 py-2"
        >
          <span className="text-xs font-extrabold text-amber-900">
            {t("karaoke.library.reviewDifficultWordsLabel")}
          </span>
          <div
            className="viread-learning-content flex flex-wrap gap-1.5"
            dir="ltr"
            lang="vi"
          >
            {matchedWords.map((word) => (
              <span
                key={word}
                className="rounded-full border border-amber-300 bg-white px-2.5 py-0.5 text-xs font-bold text-amber-900"
              >
                {word}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="mt-auto grid gap-2">
        <ButtonLink
          className="min-h-12 break-words"
          style={{ height: "auto" }}
          href={`/karaoke/${song.song_id}?version=${song.version_id}&autoplay=1&scored=1`}
        >
          <Play aria-hidden className="size-4 shrink-0" />
          {t("karaoke.library.singNowAction")}
        </ButtonLink>
        <ButtonLink
          variant="secondary"
          className="min-h-12 break-words"
          style={{ height: "auto" }}
          href={`/karaoke/${song.song_id}?version=${song.version_id}`}
        >
          {t("karaoke.library.singSongAction", { title: song.title })}
        </ButtonLink>
      </div>
    </Card>
  );
}
