"use client";

import Image from "next/image";
import { Music2 } from "lucide-react";
import { useState } from "react";
import { Card } from "@/components/common/card";
import { ButtonLink } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import type { KaraokeSongCard } from "@/lib/api/karaoke-service";
import { formatKaraokeTime } from "@/lib/karaoke/lyrics-timeline";

const SONG_PHONICS_BADGES: Readonly<Record<string, string>> = {
  "bắc kim thang": "Vần ang / an & thanh hỏi",
  "tập tầm vông": "Âm đầu t / kh & vần ông",
  "chi chi chành chành": "Âm đầu ch / tr & nhịp phách",
  "cò lả đồng dao": "Âm đầu l / n & ngân câu mượt",
  "rồng rắn lên mây": "Âm đầu r / l & thanh hỏi",
  "khúc ca đánh vần vui": "Phân biệt l/n · s/x · tr/ch",
  "vườn xuân lung linh": "Từ láy & thanh hỏi / ngã",
  "ngôi sao nhỏ": "Quãng Đô–La thiếu nhi",
};

export function SongCard({
  song,
  launchQuery = "",
}: {
  song: KaraokeSongCard;
  launchQuery?: string;
}) {
  const t = useTranslations("entertainment");
  const [coverFailed, setCoverFailed] = useState(false);
  const phonicsBadge =
    SONG_PHONICS_BADGES[song.title.normalize("NFC").trim().toLowerCase()] ??
    null;
  const extraQuery = launchQuery ? `&${launchQuery}` : "";
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
      {phonicsBadge && (
        <span
          className="viread-learning-content inline-flex w-fit items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-extrabold text-amber-950"
          dir="ltr"
          lang="vi"
        >
          🎵 {phonicsBadge}
        </span>
      )}
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
      <ButtonLink
        className="mt-auto min-h-12 break-words"
        style={{ height: "auto" }}
        href={`/karaoke/${song.song_id}?version=${song.version_id}${extraQuery}`}
      >
        {t("karaoke.library.singSongAction", { title: song.title })}
      </ButtonLink>
    </Card>
  );
}
