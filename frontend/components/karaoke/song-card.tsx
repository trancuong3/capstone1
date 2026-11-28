"use client";

import Image from "next/image";
import { Music2, Play } from "lucide-react";
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

interface SongCoverPalette {
  readonly bg: string;
  readonly mid: string;
  readonly accent: string;
  readonly celestial: string;
}

const DEFAULT_COVER_PALETTE: SongCoverPalette = {
  bg: "#E0F2FE",
  mid: "#38BDF8",
  accent: "#0284C7",
  celestial: "#FBBF24",
};

const SONG_COVER_PALETTES: Readonly<Record<string, SongCoverPalette>> = {
  "bắc kim thang": {
    bg: "#FEF3C7",
    mid: "#FBBF24",
    accent: "#D97706",
    celestial: "#F59E0B",
  },
  "tập tầm vông": {
    bg: "#E0F2FE",
    mid: "#38BDF8",
    accent: "#0284C7",
    celestial: "#FDE047",
  },
  "chi chi chành chành": {
    bg: "#FCE7F3",
    mid: "#F472B6",
    accent: "#DB2777",
    celestial: "#FBBF24",
  },
  "cò lả đồng dao": {
    bg: "#DCFCE7",
    mid: "#4ADE80",
    accent: "#16A34A",
    celestial: "#FDE047",
  },
  "rồng rắn lên mây": {
    bg: "#EDE9FE",
    mid: "#A78BFA",
    accent: "#7C3AED",
    celestial: "#FBBF24",
  },
  "khúc ca đánh vần vui": {
    bg: "#FEE2E2",
    mid: "#FB7185",
    accent: "#E11D48",
    celestial: "#FDE047",
  },
  "vườn xuân lung linh": {
    bg: "#CCFBF1",
    mid: "#2DD4BF",
    accent: "#0D9488",
    celestial: "#FDE047",
  },
  "ngôi sao nhỏ": {
    bg: "#E0E7FF",
    mid: "#818CF8",
    accent: "#4F46E5",
    celestial: "#FBBF24",
  },
};

function SongCoverIllustration({
  palette,
}: {
  readonly palette: SongCoverPalette;
}) {
  return (
    <div
      aria-hidden="true"
      className="relative grid h-40 w-full place-items-center overflow-hidden rounded-control"
      data-testid="song-card-cover-illustration"
      style={{ backgroundColor: palette.bg }}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 320 160"
      >
        <circle
          cx="252"
          cy="36"
          r="24"
          fill={palette.celestial}
          opacity="0.92"
        />
        <circle cx="52" cy="30" r="5" fill={palette.celestial} opacity="0.85" />
        <circle
          cx="88"
          cy="20"
          r="3.5"
          fill={palette.celestial}
          opacity="0.75"
        />
        <ellipse cx="92" cy="148" rx="148" ry="52" fill={palette.mid} />
        <ellipse cx="242" cy="154" rx="140" ry="48" fill={palette.accent} />
      </svg>
      <div
        className="relative z-10 grid size-16 place-items-center rounded-full bg-white shadow-sm"
        style={{ border: `4px solid ${palette.accent}`, color: palette.accent }}
      >
        <Music2 aria-hidden="true" className="size-8" />
      </div>
    </div>
  );
}

export function SongCard({
  song,
  launchQuery = "",
}: {
  song: KaraokeSongCard;
  launchQuery?: string;
}) {
  const t = useTranslations("entertainment");
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
  const matchedWords = (song.matched_difficult_words ?? [])
    .map((word) => word.trim())
    .filter(Boolean);
  const normalizedTitle = song.title.normalize("NFC").trim().toLowerCase();
  const phonicsBadge = SONG_PHONICS_BADGES[normalizedTitle] ?? null;
  const palette = SONG_COVER_PALETTES[normalizedTitle] ?? DEFAULT_COVER_PALETTE;
  const showCoverImage = Boolean(
    song.cover_url && failedCoverUrl !== song.cover_url,
  );
  const extraQuery = launchQuery ? `&${launchQuery}` : "";
  return (
    <Card className="song-cover h-full">
      {showCoverImage ? (
        <Image
          src={song.cover_url!}
          alt={t("karaoke.library.coverAlt", { title: song.title })}
          width={320}
          height={200}
          unoptimized
          onError={() => setFailedCoverUrl(song.cover_url)}
          className="h-40 w-full rounded-control object-cover"
        />
      ) : (
        <SongCoverIllustration palette={palette} />
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
          href={`/karaoke/${song.song_id}?version=${song.version_id}&autoplay=1&scored=1${extraQuery}`}
        >
          <Play aria-hidden className="size-4 shrink-0" />
          {t("karaoke.library.singNowAction")}
        </ButtonLink>
        <ButtonLink
          variant="secondary"
          className="min-h-12 break-words"
          style={{ height: "auto" }}
          href={`/karaoke/${song.song_id}?version=${song.version_id}${extraQuery}`}
        >
          {t("karaoke.library.singSongAction", { title: song.title })}
        </ButtonLink>
      </div>
    </Card>
  );
}
