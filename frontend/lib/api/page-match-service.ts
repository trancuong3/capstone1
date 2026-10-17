import { z } from "zod";
import { requestApi } from "@/lib/api/api-client";
import { readingPageDtoSchema } from "@/lib/api/reading-service";
import type { ReadingPageDTO } from "@/types/reading";

export interface PageMatchService {
  retryCurrentPage(sessionId: string): Promise<ReadingPageDTO>;
  selectPage(
    sessionId: string,
    selectedPageId: string,
  ): Promise<ReadingPageDTO>;
}

export const cameraPageMatchSchema = z.object({
  framing_valid: z.boolean(),
  matched: z.boolean(),
  book_id: z.string().optional().nullable(), // Hỗ trợ book_id trả về khi quét tổng quát
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
  matched_page: readingPageDtoSchema.nullable(),
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

export async function scanCameraFrameGlobal(
  imageBlob: Blob,
  signal?: AbortSignal,
): Promise<CameraPageMatchDTO> {
  const formData = new FormData();
  formData.append("file", imageBlob, "camera-frame.jpg");

  return requestApi("/reading/match-page", cameraPageMatchSchema, signal, {
    method: "POST",
    body: formData,
  });
}

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
