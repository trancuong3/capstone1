import { z } from "zod";
import {
  fingerprintSchema,
  processingReviewSchema,
  processingSummarySchema,
} from "@/types/karaoke-processing-shared";

export const karaokeMetadataSchema = z.object({
  title: z.string().max(200),
  author: z.string().max(200),
  min_grade: z.number().int().min(1).max(5),
  max_grade: z.number().int().min(1).max(5),
  source_note: z.string().max(1000),
  usage_note: z.string().max(1000),
});
const milliseconds = z.number().int().min(0).max(300000);
const lyricUnitSchema = z
  .object({
    id: z.guid(),
    text: z
      .string()
      .transform((s) => s.normalize("NFC").trim())
      .refine((s) => !!s && Array.from(s).length <= 300 && !/\p{Cc}/u.test(s)),
    start_ms: milliseconds.nullable(),
    end_ms: milliseconds.nullable(),
  })
  .strict();
export const syllableSchema = lyricUnitSchema;
export const lyricLineSchema = lyricUnitSchema.extend({
  syllables: z.array(syllableSchema).max(150).optional(),
});
export const lyricsSchema = z
  .object({
    format_version: z.union([z.literal(1), z.literal(2)]),
    lines: z.array(lyricLineSchema).max(300),
  })
  .superRefine(({ lines, format_version }, ctx) => {
    if (new Set(lines.map((line) => line.id)).size !== lines.length)
      ctx.addIssue({ code: "custom", message: "ID dòng lời bị trùng." });
    if (lines.reduce((n, line) => n + Array.from(line.text).length, 0) > 50000)
      ctx.addIssue({ code: "custom", message: "Lời vượt quá 50.000 ký tự." });
    const ids = new Set(lines.map((line) => line.id));
    let count = 0;
    let syllableCharacters = 0;
    for (const line of lines) {
      if (
        (format_version === 1 && line.syllables !== undefined) ||
        (format_version === 2 && line.syllables === undefined)
      )
        ctx.addIssue({
          code: "custom",
          message: "Danh sách tiếng không khớp định dạng lời.",
        });
      for (const syllable of line.syllables ?? []) {
        if (ids.has(syllable.id))
          ctx.addIssue({ code: "custom", message: "ID tiếng bị trùng." });
        ids.add(syllable.id);
        count++;
        syllableCharacters += Array.from(syllable.text).length;
      }
    }
    if (count > 10000)
      ctx.addIssue({ code: "custom", message: "Lời vượt quá 10.000 tiếng." });
    if (syllableCharacters > 50000)
      ctx.addIssue({
        code: "custom",
        message: "Nội dung tiếng vượt quá 50.000 ký tự.",
      });
  });
const date = z.iso.datetime({ offset: true });
const status = z.enum(["DRAFT", "PUBLISHED", "HIDDEN"]);
export const karaokeVersionSchema = karaokeMetadataSchema.extend({
  id: z.guid(),
  version_no: z.number().int().positive(),
  state: z.enum(["DRAFT", "PUBLISHED", "SUPERSEDED"]),
  has_audio: z.boolean(),
  has_cover: z.boolean(),
  duration_ms: milliseconds.nullable(),
  audio_size_bytes: z.number().int().nonnegative().nullable(),
  audio_sha256: fingerprintSchema.nullable().optional(),
  has_reference_audio: z.boolean().optional(),
  reference_audio_sha256: fingerprintSchema.nullable().optional(),
  lyrics: lyricsSchema,
  created_at: date,
  updated_at: date,
  published_at: date.nullable(),
});
export const adminKaraokeDetailSchema = z.object({
  processing_summary: processingSummarySchema.nullable().optional(),
  processing_review: processingReviewSchema.optional(),
  song_id: z.guid(),
  status,
  revision: z.number().int().positive(),
  draft: karaokeVersionSchema.nullable(),
  published: karaokeVersionSchema.nullable(),
  created_at: date,
  updated_at: date,
});
export const adminKaraokeListSchema = z.object({
  items: z.array(
    z.object({
      song_id: z.guid(),
      status,
      revision: z.number().int().positive(),
      title: z.string(),
      author: z.string(),
      min_grade: z.number().int(),
      max_grade: z.number().int(),
      duration_ms: milliseconds.nullable(),
      draft_version_id: z.guid().nullable(),
      published_version_id: z.guid().nullable(),
      processing_summary: processingSummarySchema.nullable().optional(),
      has_audio: z.boolean(),
      has_cover: z.boolean(),
      created_at: date,
      updated_at: date,
    }),
  ),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
const mediaUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Địa chỉ media không hợp lệ.");
export const karaokePreviewSchema = z.object({
  song_id: z.guid(),
  version_id: z.guid(),
  revision: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  duration_ms: milliseconds,
  audio_url: mediaUrl,
  audio_url_expires_at: date,
  cover_url: mediaUrl.nullable(),
  lyrics: lyricsSchema,
});
export const songCardSchema = karaokePreviewSchema
  .pick({
    song_id: true,
    version_id: true,
    title: true,
    author: true,
    duration_ms: true,
    cover_url: true,
  })
  .extend({
    min_grade: z.number().int().min(1).max(5),
    max_grade: z.number().int().min(1).max(5),
    matched_difficult_words: z.array(z.string()).optional(),
  });
export const karaokeValidationSchema = z.object({
  valid: z.boolean(),
  revision: z.number().int().positive(),
  draft_version_id: z.guid(),
  issues: z.array(
    z.object({
      code: z.enum([
        "TITLE_REQUIRED",
        "SOURCE_REQUIRED",
        "USAGE_REQUIRED",
        "AUDIO_REQUIRED",
        "LYRICS_REQUIRED",
        "TIMING_REQUIRED",
        "TIMING_INVALID",
        "TIMING_OVERLAP",
        "TIMING_OUT_OF_RANGE",
        "TIMING_AUDIO_MISMATCH",
        "MEDIA_UNAVAILABLE",
        "CONTENT_INVALID",
        "SYLLABLES_REQUIRED",
        "SYLLABLE_TEXT_MISMATCH",
        "PROCESSING_IN_PROGRESS",
        "PROCESSING_REVIEW_REQUIRED",
      ]),
      field: z.string(),
      line_id: z.guid().nullable(),
      syllable_id: z.guid().nullable().optional(),
    }),
  ),
});
export type KaraokeMetadata = z.infer<typeof karaokeMetadataSchema>;
export type KaraokeSongCreate = KaraokeMetadata & {
  creation_request_id?: string;
};
export type KaraokeLyrics = z.infer<typeof lyricsSchema>;
export type KaraokeLine = KaraokeLyrics["lines"][number];
export type KaraokeSyllable = z.infer<typeof syllableSchema>;
export type AdminKaraokeDetail = z.infer<typeof adminKaraokeDetailSchema>;
export type AdminKaraokeList = z.infer<typeof adminKaraokeListSchema>;
export type KaraokePreview = z.infer<typeof karaokePreviewSchema>;
export type SongCard = z.infer<typeof songCardSchema>;
export type KaraokeSongCard = SongCard;
export type KaraokeValidation = z.infer<typeof karaokeValidationSchema>;
export type KaraokeDraftWrite = KaraokeMetadata & {
  expected_revision: number;
  draft_version_id: string;
  lyrics: KaraokeLyrics;
};
export const emptyKaraokeMetadata: KaraokeMetadata = {
  title: "",
  author: "",
  min_grade: 1,
  max_grade: 5,
  source_note: "",
  usage_note: "",
};
