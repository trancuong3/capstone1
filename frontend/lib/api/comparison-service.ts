import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import type { WordTimestamp } from "@/lib/api/speech-service";

const comparisonSchema = z.object({
  session_id: z.string(),
  page_id: z.string(),
  page_revision_id: z.string(),
  distance: z.number(),

  alignment: z.array(
    z.object({
      book_word: z.string().nullable(),
      spoken_word: z.string().nullable(),
      book_index: z.number().nullable(),
      spoken_index: z.number().nullable(),
      status: z.enum([
        "MATCH",
        "DELETE",
        "INSERT",
        "SUBSTITUTE",
      ]),
    }),
  ),

  summary: z.object({
    missing_words: z.array(z.string()),
    extra_words: z.array(z.string()),
    substitutions: z.array(
      z.object({
        book_word: z.string(),
        spoken_word: z.string(),
      }),
    ),
    repeated_count: z.number(),
    repeated_words: z.array(z.string()),
    hesitations: z.array(z.unknown()),
    hesitation_seconds: z.number().nonnegative().nullable(),
  }),
});

export type ComparisonResult = z.infer<
  typeof comparisonSchema
>;

export async function compareTranscript(
  sessionId: string,
  transcript: string,
  words?: readonly WordTimestamp[] | null,
): Promise<ComparisonResult> {
  return requestApi(
    `/reading/sessions/${sessionId}/compare`,
    comparisonSchema,
    undefined,
    {
      method: "POST",
      body: {
        transcript,
        ...(words?.length ? { words } : {}),
      },
    },
  );
}
