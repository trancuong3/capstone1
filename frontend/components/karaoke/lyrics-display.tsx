"use client";

import { useTranslations } from "@/hooks/use-i18n";
import { activeLyricIndex } from "@/lib/karaoke/lyrics-timeline";
import type { KaraokeLine } from "@/types/karaoke";
import { SyllableLyrics } from "@/components/karaoke/syllable-lyrics";

export function LyricsDisplay({
  lines,
  currentMs,
  ended = false,
}: {
  lines: KaraokeLine[];
  currentMs: number;
  ended?: boolean;
}) {
  const t = useTranslations("entertainment");
  const active = activeLyricIndex(lines, currentMs);
  const next = lines.find((l) => l.start_ms !== null && l.start_ms > currentMs);
  return (
    <div
      className="rounded-control bg-sky p-6 text-center"
      aria-label={t("karaoke.lyrics.regionAria")}
    >
      {active >= 0 && !ended && (
        <p className="mb-3 text-sm font-bold text-primary-hover">
          {t("karaoke.lyrics.activeLineLabel")}
        </p>
      )}
      <p
        className="break-words text-2xl font-extrabold text-primary-hover"
        data-testid="karaoke-active-line"
      >
        {ended ? (
          t("karaoke.lyrics.ended")
        ) : active >= 0 ? (
          lines[active].syllables?.length ? (
            <SyllableLyrics line={lines[active]} currentMs={currentMs} />
          ) : (
            <span className="viread-learning-content" dir="ltr" lang="vi">
              {lines[active].text}
            </span>
          )
        ) : next ? (
          t("karaoke.lyrics.instrumentalWaitNext")
        ) : lines.length ? (
          t("karaoke.lyrics.instrumentalEnjoy")
        ) : (
          t("karaoke.lyrics.emptyPosition")
        )}
      </p>
      {next && (
        <p className="mt-3 break-words text-muted">
          {t("karaoke.lyrics.nextPrefix")}
          <span className="viread-learning-content" dir="ltr" lang="vi">
            {next.text}
          </span>
        </p>
      )}
    </div>
  );
}
