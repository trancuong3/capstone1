<<<<<<< HEAD
// Kadepham
import { z } from "zod";
import { requestApi } from "@/lib/api/api-client";
=======
import { requestApi } from "@/lib/api/api-client";
import { readingPageDtoSchema } from "@/lib/api/reading-service";
>>>>>>> 2804956a8eba6d933f7f15e1123fe90733a81328
import type { ReadingPageDTO } from "@/types/reading";

export interface PageMatchService {
  retryCurrentPage(sessionId: string): Promise<ReadingPageDTO>;
  selectPage(
    sessionId: string,
    selectedPageId: string,
  ): Promise<ReadingPageDTO>;
}

<<<<<<< HEAD
const readingPageWordSchema = z.object({
  word_id: z.string(),
  word_index: z.number().int().min(0),
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

const readingPageSchema = z.object({
  page_id: z.string(),
  page_revision_id: z.string(),
  page_number: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  words: z.array(readingPageWordSchema),
});

export const cameraPageMatchSchema = z.object({
  framing_valid: z.boolean(),
  matched: z.boolean(),
  status_code: z.enum([
    "INVALID_IMAGE",
    "TOO_DARK",
    "TOO_BLURRY",
    "OUT_OF_FRAME",
    "FRAME_OK",
    "MATCHED",
    "LOW_CONFIDENCE",
  ]),
  message: z.string(),
  confidence: z.number().min(0).max(1),
  matched_page: readingPageSchema.nullable(),
});

export type CameraPageMatchDTO = z.infer<typeof cameraPageMatchSchema>;

/**
 * Gửi frame ảnh chụp từ camera lên ViRead Vision Backend để kiểm tra khung
 * và nhận diện trang sách thuộc cuốn `bookId`.
 */
export async function scanCameraFrameForBook(
  bookId: string,
  imageBlob: Blob,
  signal?: AbortSignal,
): Promise<CameraPageMatchDTO> {
  const formData = new FormData();
  formData.append("file", imageBlob, "camera-frame.jpg");

  return requestApi(
    `/reading/books/${encodeURIComponent(bookId)}/match-page`,
    cameraPageMatchSchema,
    signal,
    {
      method: "POST",
      body: formData,
    },
  );
}
=======
export function createPageMatchService(): PageMatchService {
  return {
    async retryCurrentPage(sessionId: string): Promise<ReadingPageDTO> {
      return requestApi(
        `/reading/sessions/${encodeURIComponent(sessionId)}/page`,
        readingPageDtoSchema,
      );
    },

    async selectPage(
      sessionId: string,
      selectedPageId: string,
    ): Promise<ReadingPageDTO> {
      const query = new URLSearchParams({ session_id: sessionId });
      return requestApi(
        `/reading/pages/${encodeURIComponent(selectedPageId)}?${query.toString()}`,
        readingPageDtoSchema,
      );
    },
  };
}
>>>>>>> 2804956a8eba6d933f7f15e1123fe90733a81328
