import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";

const comparisonSchema = z.object({
  session_id: z.string(),
  page_id: z.string(),
  page_revision_id: z.string(),
  distance: z.number(),

  alignment: z.array(
    z.object({
      book_word: z.string(),
      spoken_word: z.string().nullable(),
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
  }),
});

export type ComparisonResult = z.infer<
  typeof comparisonSchema
>;

export async function compareTranscript(
  sessionId: string,
  transcript: string,
): Promise<ComparisonResult> {
  return requestApi(
    `/reading/sessions/${sessionId}/compare`,
    comparisonSchema,
    undefined,
    {
      method: "POST",
      body: {
        transcript,
      },
    },
  );
}