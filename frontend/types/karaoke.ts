import { z } from "zod";

export const karaokeMetadataSchema = z.object({
  title: z.string().max(200),
  author: z.string().max(200),
  min_grade: z.number().int().min(1).max(5),
  max_grade: z.number().int().min(1).max(5),
  source_note: z.string().max(1000),
  usage_note: z.string().max(1000),
});
const milliseconds = z.number().int().min(0).max(300000);
export const lyricLineSchema = z
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
export const lyricsSchema = z
  .object({
    format_version: z.literal(1),
    lines: z.array(lyricLineSchema).max(300),
  })
  .superRefine(({ lines }, ctx) => {
    if (new Set(lines.map((line) => line.id)).size !== lines.length)
      ctx.addIssue({ code: "custom", message: "ID dòng lời bị trùng." });
    if (lines.reduce((n, line) => n + Array.from(line.text).length, 0) > 50000)
      ctx.addIssue({ code: "custom", message: "Lời vượt quá 50.000 ký tự." });
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
  lyrics: lyricsSchema,
  created_at: date,
  updated_at: date,
  published_at: date.nullable(),
});
export const adminKaraokeDetailSchema = z.object({
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
      ]),
      field: z.string(),
      line_id: z.guid().nullable(),
    }),
  ),
});
export type KaraokeMetadata = z.infer<typeof karaokeMetadataSchema>;
export type KaraokeLyrics = z.infer<typeof lyricsSchema>;
export type KaraokeLine = KaraokeLyrics["lines"][number];
export type AdminKaraokeDetail = z.infer<typeof adminKaraokeDetailSchema>;
export type AdminKaraokeList = z.infer<typeof adminKaraokeListSchema>;
export type KaraokePreview = z.infer<typeof karaokePreviewSchema>;
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
