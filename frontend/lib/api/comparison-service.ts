import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import type { WordTimestamp } from "@/lib/api/speech-service";

const alignmentSchema = z.object({
  book_word: z.string().nullable(),
  spoken_word: z.string().nullable(),
  book_index: z.number().nullable(),
  spoken_index: z.number().nullable(),
  status: z.enum(["MATCH", "DELETE", "INSERT", "SUBSTITUTE"]),
});

const summarySchema = z.object({
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
});

const comparisonSchema = z.object({
  session_id: z.string(),
  page_id: z.string(),
  page_revision_id: z.string(),
  distance: z.number(),
  alignment: z.array(alignmentSchema),
  summary: summarySchema,
});

const readingPageWordSchema = z.object({
  word_id: z.string(),
  word_index: z.number(),
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  line_index: z.number().optional(),
});

const readingPageSchema = z.object({
  page_id: z.string(),
  page_revision_id: z.string(),
  page_number: z.number(),
  confidence: z.number().nullable(),
  width: z.number(),
  height: z.number(),
  image_url: z.string().nullable().optional(),
  text: z.string().optional(),
  words: z.array(readingPageWordSchema),
  paragraph_start_line_indices: z.array(z.number()).optional(),
  indented_line_indices: z.array(z.number()).optional(),
});

export type ReadingPage = z.infer<typeof readingPageSchema>;

export type ComparisonResult = z.infer<typeof comparisonSchema>;

export interface ComparisonPageReference {
  readonly page_id: string;
  readonly page_revision_id: string;
}

export async function compareTranscript(
  sessionId: string,
  transcript: string,
  words?: readonly WordTimestamp[] | null,
  page?: ComparisonPageReference,
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
        ...(page
          ? {
              page_id: page.page_id,
              page_revision_id: page.page_revision_id,
            }
          : {}),
      },
    },
  );
}

// Schema báo cáo đã lưu
const savedReportSchema = comparisonSchema.omit({ session_id: true }).extend({
  report_id: z.string(),
  created_at: z.string(),
  transcript: z.string(),
});

const sessionReportsSchema = z.object({
  session_id: z.string(),
  total: z.number(),
  reports: z.array(savedReportSchema),
});

export type SavedReadingReport = z.infer<typeof savedReportSchema>;

export type SessionReports = z.infer<typeof sessionReportsSchema>;

// Lấy tất cả báo cáo của một session
export async function getSessionReports(
  sessionId: string,
): Promise<SessionReports> {
  return requestApi(
    `/reading/sessions/${sessionId}/reports`,
    sessionReportsSchema,
  );
}

// Lấy nội dung trang sách theo đúng revision đã đọc
export async function getReadingPage(
  pageId: string,
  sessionId: string,
  revisionId: string,
): Promise<ReadingPage> {
  return requestApi(
    `/reading/pages/${pageId}?session_id=${sessionId}&revision_id=${revisionId}`,
    readingPageSchema,
  );
}

export async function deleteReadingReport(reportId: string): Promise<void> {
  await requestApi(`/reading/reports/${reportId}`, z.unknown(), undefined, {
    method: "DELETE",
  });
}
