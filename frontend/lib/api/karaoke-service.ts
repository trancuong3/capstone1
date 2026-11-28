import { z } from "zod";
import { apiQuery, requestApi } from "@/lib/api/api-client";
import { isServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";
import { syllableIssues } from "@/lib/karaoke/syllable-timing";
import {
  karaokePreviewSchema,
  lyricLineSchema,
  lyricsSchema,
  songCardSchema,
  type SongCard,
} from "@/types/karaoke";

const list = z.object({
  items: z.array(songCardSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
const playback = karaokePreviewSchema
  .omit({ revision: true })
  .extend({
    lyrics: lyricsSchema.safeExtend({
      lines: z
        .array(
          lyricLineSchema.extend({
            start_ms: z.number().int().nonnegative(),
            end_ms: z.number().int().positive(),
          }),
        )
        .min(1)
        .max(300),
    }),
  })
  .refine(
    (value) =>
      value.lyrics.lines.every(
        (line, i, lines) =>
          line.start_ms < line.end_ms &&
          line.end_ms <= value.duration_ms &&
          (i === 0 || line.start_ms >= lines[i - 1].end_ms),
      ) &&
      (value.lyrics.format_version === 1 ||
        syllableIssues(value.lyrics.lines, value.duration_ms).length === 0),
  );

/** Read-only karaoke adapter; selected child is validated before calling it. */
export function createKaraokeService() {
  return {
    list(
      childId: string,
      query: { search?: string; offset?: number } = {},
      signal?: AbortSignal,
    ) {
      z.guid().parse(childId);
      return requestApi(
        `/karaoke/songs${apiQuery({ child_id: childId, ...query, limit: 12 })}`,
        list,
        signal,
      );
    },
    playback(
      songId: string,
      childId: string,
      expectedVersionId?: string,
      signal?: AbortSignal,
    ) {
      z.guid().parse(songId);
      z.guid().parse(childId);
      if (expectedVersionId) z.guid().parse(expectedVersionId);
      return requestApi(
        `/karaoke/songs/${songId}/playback${apiQuery({ child_id: childId, expected_version_id: expectedVersionId })}`,
        playback.refine(
          (value) =>
            value.song_id === songId &&
            (!expectedVersionId || value.version_id === expectedVersionId),
        ),
        signal,
      );
    },
  };
}
export type KaraokeService = ReturnType<typeof createKaraokeService>;
export type KaraokePlayback = z.infer<typeof playback>;
export type KaraokeSongCard = SongCard;
export type { SongCard };
export type KaraokeCatalog = z.infer<typeof list>;

export function karaokeParentErrorMessage(error: unknown) {
  if (isServiceError(error)) {
    switch (error.status) {
      case 401:
        return translateRuntime("errors.clientRuntime.sessionExpiredParent");
      case 403:
        return translateRuntime("errors.clientRuntime.karaokeParent403");
      case 404:
        return translateRuntime("errors.clientRuntime.karaokeParent404");
      case 409:
        return translateRuntime("errors.clientRuntime.karaokeParent409");
      case 503:
        return translateRuntime("errors.clientRuntime.karaokeParent503");
    }
  }
  return translateRuntime("errors.clientRuntime.karaokeParentFallback");
}
